"""轻量任务队列:单工作线程串行执行(转写是 CPU/GPU 密集,避免并发争抢)。

任务记录持久化到 data/tasks.json,重启服务后历史仍可见。
"""
import json
import logging
import os
import queue
import signal
import subprocess
import threading
import time
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path

from . import config
from . import llm as llm_mod
from . import transcribe as tr

# ---- 任务日志(data/logs/tasks.log,轮转 2MB×3)----
LOG_DIR = config.DATA_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
log = logging.getLogger("tingwu")
if not log.handlers:
    _h = RotatingFileHandler(LOG_DIR / "tasks.log", maxBytes=2 * 1024 * 1024,
                             backupCount=3, encoding="utf-8")
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)

_TASKS_FILE = config.DATA_DIR / "tasks.json"
_FOLDERS_FILE = config.DATA_DIR / "folders.json"
EXPORT_DIR = config.DATA_DIR / "exports"
_lock = threading.Lock()
_tasks: dict[str, dict] = {}
_folders: list[dict] = []
_procs: dict[str, subprocess.Popen] = {}   # burn 子进程,供暂停/终止

# 双通道队列:heavy(转写/封装,吃 CPU-GPU)与 llm(标点/翻译/笔记,网络或本地小模型)
# 互不阻塞 —— 长转写不再堵死翻译和笔记
_HEAVY_KINDS = {"transcribe", "burn"}
_queues: dict[str, "queue.Queue[tuple[str, str]]"] = {
    "heavy": queue.Queue(),
    "llm": queue.Queue(),
}
_current: dict[str, dict] = {"heavy": {"task_id": None, "kind": None},
                             "llm": {"task_id": None, "kind": None}}


def _enqueue(task_id: str, kind: str):
    _queues["heavy" if kind in _HEAVY_KINDS else "llm"].put((task_id, kind))


def _is_running(task_id: str) -> bool:
    return any(c["task_id"] == task_id for c in _current.values())

_JOB_FIELD = {
    "transcribe": "status",
    "polish": "polish_status",
    "translate": "translation_status",
    "analyze": "analysis_status",
    "burn": "burn_status",
}


def _job_state(task_id: str) -> str:
    """LLM 分块循环与 burn 循环的协作检查点:run / pause / cancel。"""
    with _lock:
        t = _tasks.get(task_id) or {}
        if t.get("cancel_requested"):
            return "cancel"
        if t.get("paused"):
            return "pause"
    return "run"


def _finish_cancel(task_id: str, kind: str):
    with _lock:
        t = _tasks.get(task_id)
        if t is None:
            return
        t[_JOB_FIELD[kind]] = "cancelled"
        if kind == "transcribe":
            t["stage"] = "已终止"
        t["cancel_requested"] = False
        t["paused"] = False
        _persist(force=True)


def request_cancel(task_id: str):
    with _lock:
        t = _tasks.get(task_id)
        if t is None:
            raise KeyError(task_id)
        t["cancel_requested"] = True
        t["paused"] = False
        # 该任务当前没有正在执行的作业 → 排队中的作业立即置为已终止
        if not _is_running(task_id):
            if t.get("status") == "queued":
                t["status"] = "cancelled"
                t["stage"] = "已终止"
            for kind, field in _JOB_FIELD.items():
                if kind != "transcribe" and t.get(field) == "running":
                    t[field] = "cancelled"
            t["cancel_requested"] = False
        _persist(force=True)
    proc = _procs.get(task_id)
    if proc and proc.poll() is None:
        try:
            os.kill(proc.pid, signal.SIGCONT)  # 唤醒被暂停的子进程以便退出
        except OSError:
            pass


def set_paused(task_id: str, paused: bool):
    with _lock:
        t = _tasks.get(task_id)
        if t is None:
            raise KeyError(task_id)
        t["paused"] = bool(paused)
        _persist(force=True)

EXPORT_DIR.mkdir(parents=True, exist_ok=True)


# ================= 文件夹 =================
def _persist_folders():
    _FOLDERS_FILE.write_text(json.dumps(_folders, ensure_ascii=False, indent=1),
                             encoding="utf-8")


def list_folders() -> list[dict]:
    with _lock:
        return [dict(f) for f in sorted(_folders, key=lambda f: f["created_at"])]


def create_folder(name: str) -> dict:
    folder = {"id": uuid.uuid4().hex[:8], "name": name.strip()[:40],
              "created_at": time.time()}
    with _lock:
        _folders.append(folder)
        _persist_folders()
    return folder


def rename_folder(folder_id: str, name: str):
    with _lock:
        for f in _folders:
            if f["id"] == folder_id:
                f["name"] = name.strip()[:40]
                _persist_folders()
                return
    raise KeyError(folder_id)


def delete_folder(folder_id: str):
    with _lock:
        global _folders
        _folders = [f for f in _folders if f["id"] != folder_id]
        for t in _tasks.values():       # 夹内任务回到根目录
            if t.get("folder") == folder_id:
                t["folder"] = None
        _persist_folders()
        _persist(force=True)


def move_task(task_id: str, folder_id: str | None):
    with _lock:
        task = _tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)
        if folder_id is not None and not any(f["id"] == folder_id for f in _folders):
            raise KeyError(folder_id)
        task["folder"] = folder_id
        _persist(force=True)


def delete_task(task_id: str):
    with _lock:
        task = _tasks.pop(task_id, None)
        if task is None:
            raise KeyError(task_id)
        _persist(force=True)
    for p in [Path(task["media"]),
              config.RESULT_DIR / f"{task_id}.json",
              config.RESULT_DIR / f"{task_id}.raw.json",
              config.RESULT_DIR / f"{task_id}.analysis.json",
              config.RESULT_DIR / f"{task_id}.mindmap.json",
              config.RESULT_DIR / f"{task_id}.notes.txt",
              config.RESULT_DIR / f"{task_id}.translation.json",
              Path(task.get("burned_path") or "")]:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


def _load():
    global _tasks, _folders
    if _TASKS_FILE.exists():
        try:
            _tasks = json.loads(_TASKS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            _tasks = {}
    if _FOLDERS_FILE.exists():
        try:
            _folders = json.loads(_FOLDERS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            _folders = []


_persist_timer: threading.Timer | None = None


def _flush():
    """立即写盘——由 debounce 调用或进程退出时调用。"""
    tmp = _TASKS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_tasks, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(_TASKS_FILE)


def _persist(force: bool = False):
    """延迟写盘:高频更新(阶段文字)合并为 0.5s 刷一次,force=True 立即刷。"""
    global _persist_timer
    if force:
        if _persist_timer:
            _persist_timer.cancel()
            _persist_timer = None
        _flush()
        return
    if _persist_timer and _persist_timer.is_alive():
        return                          # 已有待刷任务,不重复计时
    _persist_timer = threading.Timer(0.5, _flush)
    _persist_timer.daemon = True
    _persist_timer.start()


def _update(task_id: str, **fields):
    with _lock:
        task = _tasks[task_id]
        task.update(fields)
        task["updated_at"] = time.time()
        _persist()


def create_task(filename: str, tmp_path: Path, language: str | None,
                hotwords: str | None, engine: str | None = None,
                auto_translate: bool = False) -> str:
    task_id = uuid.uuid4().hex[:12]
    ext = Path(filename).suffix.lower() or tmp_path.suffix.lower()
    saved_path = config.UPLOAD_DIR / f"{task_id}{ext}"
    tmp_path.replace(saved_path)
    with _lock:
        _tasks[task_id] = {
            "id": task_id,
            "filename": filename,
            "status": "queued",          # queued → transcribing → done / error
            "stage": "排队中",
            "language": language,
            "hotwords": hotwords,
            "media": str(saved_path),
            "created_at": time.time(),
            "updated_at": time.time(),
            "error": None,
            "duration": None,
            "analyzed": False,
            "analysis_status": None,    # None / running / done / error
            "analysis_error": None,
            "polish_status": None,      # None / running / done / error(AI 标点恢复)
            "polish_error": None,
            "folder": None,             # 所属文件夹 id
            "translation_status": None, # None / running / done / error
            "translation_error": None,
            "burn_status": None,        # 字幕烧录:None / running / done / error
            "burn_mode": None,          # orig / zh / both
            "burn_error": None,
            "burned_path": None,
            "paused": False,
            "cancel_requested": False,
            "engine": engine,            # 本次任务的转写引擎(None=跟随设置页)
            "auto_translate": bool(auto_translate),  # 转写完成后自动翻译
        }
        _persist(force=True)
    _enqueue(task_id, "transcribe")
    return task_id


def retranscribe(task_id: str, language: str | None, hotwords: str | None,
                 engine: str | None = None, auto_translate: bool = False):
    """用原媒体文件重新转写(可改引擎/语言/热词/自动翻译),旧结果与旧分析作废。"""
    with _lock:
        task = _tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)
        if task["status"] == "transcribing":
            raise ValueError("任务正在转写中")
        if not Path(task["media"]).exists():
            raise FileNotFoundError("原始媒体文件已不存在")
        old_burned = task.get("burned_path")
        task.update(
            status="queued", stage="排队中", error=None,
            language=language, hotwords=hotwords,
            analyzed=False, analysis_status=None, analysis_error=None,
            polish_status=None, polish_error=None,
            translation_status=None, translation_error=None,
            burn_status=None, burn_error=None, burned_path=None,
            paused=False, cancel_requested=False,
            engine=engine, auto_translate=bool(auto_translate),
        )
        _persist(force=True)
    # 清掉旧结果
    for name in (".json", ".analysis.json", ".mindmap.json", ".translation.json", ".essay.txt"):
        (config.RESULT_DIR / f"{task_id}{name}").unlink(missing_ok=True)
    if old_burned:
        Path(old_burned).unlink(missing_ok=True)
    _enqueue(task_id, "transcribe")


def request_polish(task_id: str):
    """对已完成的转写结果做 AI 标点恢复(不重新转写)。"""
    with _lock:
        task = _tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)
        if task["status"] != "done":
            raise ValueError("任务尚未完成转写")
        task["polish_status"] = "running"
        task["polish_error"] = None
        _persist(force=True)
    _enqueue(task_id, "polish")


def request_analysis(task_id: str):
    with _lock:
        task = _tasks.get(task_id)
        if not task or task["status"] != "done":
            raise KeyError(task_id)
        task["analysis_status"] = "running"
        task["analysis_error"] = None
        _persist(force=True)
    _enqueue(task_id, "analyze")


def get_task(task_id: str) -> dict | None:
    with _lock:
        task = dict(_tasks[task_id]) if task_id in _tasks else None
    if task:
        task["display_title"] = _display_title(task)
    return task


def list_tasks() -> list[dict]:
    with _lock:
        items = [dict(t) for t in _tasks.values()]
    for t in items:
        t["display_title"] = _display_title(t)
    items.sort(key=lambda t: t["created_at"], reverse=True)
    return items


def set_title(task_id: str, title: str):
    """用户自定义标题(优先级最高)。"""
    with _lock:
        task = _tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)
        task["custom_title"] = title.strip()[:120]
        _persist(force=True)


def save_notes(task_id: str, text: str):
    (config.RESULT_DIR / f"{task_id}.notes.txt").write_text(text, encoding="utf-8")


def load_notes(task_id: str) -> str:
    p = config.RESULT_DIR / f"{task_id}.notes.txt"
    return p.read_text(encoding="utf-8") if p.exists() else ""


def _display_title(task: dict) -> str:
    return (task.get("custom_title") or task.get("ai_title")
            or Path(task["filename"]).stem)


def mark_edited(task_id: str, sentences: list[dict]):
    """用户在前端修正了转写文本 → 覆盖结果文件,并作废对齐性派生数据。"""
    data = tr.load_result(task_id)
    if data is None:
        raise KeyError(task_id)
    data["sentences"] = sentences
    data["full_text"] = "".join(s["text"] for s in sentences)
    data["edited"] = True
    tr.save_result(task_id, data)
    # 翻译/笔记/脑图按句索引或原文对齐,编辑后会错位 → 作废(用户笔记保留)
    for name in (".translation.json", ".analysis.json", ".mindmap.json", ".essay.txt"):
        (config.RESULT_DIR / f"{task_id}{name}").unlink(missing_ok=True)
    with _lock:
        t = _tasks.get(task_id)
        if t is not None:
            t.update(analyzed=False, analysis_status=None,
                     translation_status=None, translation_error=None)
            _persist(force=True)
    log.info("task %s 文本已编辑,派生数据(翻译/笔记/脑图)已作废", task_id)


def _run_transcribe(task_id: str):
    task = get_task(task_id)
    cfg = config.snapshot()          # 快照——运行中改设置不影响本次转写
    src = Path(task["media"])
    wav = config.AUDIO_DIR / f"{task_id}.wav"
    try:
        _update(task_id, status="transcribing", stage="抽取音频")
        tr.extract_audio(src, wav)
        if _job_state(task_id) == "cancel":
            _finish_cancel(task_id, "transcribe")
            return
        duration = tr.probe_duration(src)
        engine = task.get("engine") or cfg["ASR_ENGINE"]
        if engine in ("paraformer", "sensevoice"):
            _update(task_id, stage=f"正在转写({ 'Paraformer' if engine == 'paraformer' else 'SenseVoice' })")
            result = tr.transcribe_funasr(wav, engine, hotwords=task["hotwords"],
                                          language=task["language"])
        else:
            _update(task_id, stage="正在转写(Whisper)")
            result = tr.transcribe(wav, language=task["language"],
                                   hotwords=task["hotwords"])
        # 原子转写调用无法中途打断:跑完发现已取消 → 丢弃结果
        if _job_state(task_id) == "cancel":
            _finish_cancel(task_id, "transcribe")
            return
        result["task_id"] = task_id
        result["filename"] = task["filename"]
        tr.save_result(task_id, result)
        # 备份原始(未合并)句子,供 AI 标点恢复反复使用
        (config.RESULT_DIR / f"{task_id}.raw.json").write_text(
            json.dumps(result["sentences"], ensure_ascii=False), encoding="utf-8")
        # 可选:LLM 可用时自动做标点恢复。
        # 关键:必须在标记 done 的同一时刻就置 polish_status=running,
        # 否则前端看到 done 会停止轮询、加载未润色文本且不再更新。
        # Paraformer/SenseVoice 自带标点,再做 LLM 标点恢复纯属重复耗时 → 仅 Whisper 触发
        auto_polish = engine == "whisper" and cfg["POLISH_ENABLED"] and llm_mod.llm_available()
        _update(task_id, status="done", duration=duration,
                stage="AI 标点恢复中" if auto_polish else "完成",
                polish_status="running" if auto_polish else None)
        if auto_polish:
            _do_polish(task_id)
        # 新建弹窗勾选了"自动翻译" → 转写(含润色)完成后自动排队翻译
        if task.get("auto_translate") and _job_state(task_id) != "cancel":
            _update(task_id, translation_status="running")
            _enqueue(task_id, "translate")
    except Exception as e:  # noqa: BLE001 — 任务失败要落盘给用户看
        _update(task_id, status="error", stage="失败", error=f"{type(e).__name__}: {e}")
    finally:
        if wav.exists():
            wav.unlink(missing_ok=True)


def _do_polish(task_id: str):
    """AI 标点恢复的实现(供转写后自动调用和 /polish 端点复用)。

    始终从「原始转写备份」做合并,保证可重复执行而不会越并越碎。
    润色后再跑一遍幻觉清洗。
    """
    def progress(done: int, total: int):
        _update(task_id, stage=f"AI 标点恢复 {done}/{total}")
    try:
        data = tr.load_result(task_id)
        if data is None:
            raise llm_mod.LLMError("找不到转写结果")
        # 原文备份:首次润色时存下未合并的句子,之后每次都从它出发
        raw_path = config.RESULT_DIR / f"{task_id}.raw.json"
        if raw_path.exists():
            raw_sentences = json.loads(raw_path.read_text(encoding="utf-8"))
        else:
            raw_sentences = data["sentences"]
            raw_path.write_text(json.dumps(raw_sentences, ensure_ascii=False),
                                encoding="utf-8")
        # 先清洗原始碎片(此时每条都短,幻觉能精准命中),再交给 LLM 合并
        cleaned = tr._clean_hallucinations(raw_sentences)
        polished, failed = llm_mod.punctuate(
            cleaned, progress=progress, check=lambda: _job_state(task_id))
        polished = tr._clean_hallucinations(polished)  # 合并后再兜底一次
        data["sentences"] = polished
        data["full_text"] = "".join(s["text"] for s in polished)
        data["polished"] = True
        data["polish_failed_chunks"] = failed
        tr.save_result(task_id, data)
        # 句子结构变了(合并),按句对齐的翻译作废
        (config.RESULT_DIR / f"{task_id}.translation.json").unlink(missing_ok=True)
        _update(task_id, polish_status="done", stage="完成",
                translation_status=None, translation_error=None)
    except llm_mod.JobCancelled:
        _finish_cancel(task_id, "polish")
    except Exception as e:  # noqa: BLE001
        _update(task_id, polish_status="error", polish_error=str(e),
                stage="完成(标点恢复失败)")


def _run_polish(task_id: str):
    _do_polish(task_id)


# ================= 翻译 =================
def request_translate(task_id: str):
    with _lock:
        task = _tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)
        if task["status"] != "done":
            raise ValueError("任务尚未完成转写")
        task["translation_status"] = "running"
        task["translation_error"] = None
        _persist(force=True)
    _enqueue(task_id, "translate")


def _run_translate(task_id: str):
    def progress(done: int, total: int):
        _update(task_id, stage=f"AI 翻译 {done}/{total}")
    try:
        data = tr.load_result(task_id)
        if data is None:
            raise llm_mod.LLMError("找不到转写结果")
        if (data.get("language") or "") == "zh":
            zh = [s["text"] for s in data["sentences"]]  # 源即中文,无需翻译
            failed = 0
        else:
            zh, failed = llm_mod.translate(
                data["sentences"], progress=progress,
                check=lambda: _job_state(task_id))
        (config.RESULT_DIR / f"{task_id}.translation.json").write_text(
            json.dumps(zh, ensure_ascii=False), encoding="utf-8")
        _update(task_id, translation_status="done", stage="完成",
                translation_failed=failed)
    except llm_mod.JobCancelled:
        _finish_cancel(task_id, "translate")
    except Exception as e:  # noqa: BLE001
        _update(task_id, translation_status="error",
                translation_error=str(e)[:300])


# ================= 字幕烧录 =================
VIDEO_BURN_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".wmv", ".ts"}


def request_burn(task_id: str, mode: str, container: str = "mp4"):
    """软字幕封装:字幕作为独立轨道混流进 MP4/MKV,播放时可开关。"""
    with _lock:
        task = _tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)
        if container not in ("mp4", "mkv"):
            raise ValueError("容器必须是 mp4 或 mkv")
        if task["status"] != "done":
            raise ValueError("任务尚未完成转写")
        if Path(task["media"]).suffix.lower() not in VIDEO_BURN_EXT:
            raise ValueError("仅视频文件支持封装字幕(音频可导出 SRT 字幕)")
        if mode in ("zh", "both"):
            if not (config.RESULT_DIR / f"{task_id}.translation.json").exists():
                raise ValueError("请先完成翻译,再封装中文字幕")
        task["burn_mode"] = mode
        task["burn_container"] = container
        task["burn_status"] = "running"
        task["burn_error"] = None
        _persist(force=True)
    _enqueue(task_id, "burn")


def _run_burn(task_id: str):
    """混流:视频/音频流拷贝(不重编码,秒级),字幕转 mov_text(MP4)或 srt(MKV)。"""
    import subprocess
    import tempfile
    task = get_task(task_id)
    try:
        data = tr.load_result(task_id)
        if data is None:
            raise RuntimeError("找不到转写结果")
        mode = task["burn_mode"] or "both"
        container = task.get("burn_container") or "mp4"
        zh = None
        if mode in ("zh", "both"):
            zh = json.loads((config.RESULT_DIR / f"{task_id}.translation.json")
                            .read_text(encoding="utf-8"))
        with tempfile.NamedTemporaryFile("w", suffix=".srt", delete=False,
                                         encoding="utf-8", dir="/tmp") as f:
            f.write(tr.build_srt(data["sentences"], zh, mode))
            srt = f.name
        out = EXPORT_DIR / f"{task_id}_subbed.{container}"
        label = {"orig": "原文", "zh": "中文", "both": "双语"}[mode]
        cmd = [tr.FFMPEG, "-y", "-i", task["media"], "-i", srt,
               "-map", "0:v:0", "-map", "0:a?", "-map", "1:0",
               "-c:v", "copy", "-c:a", "copy",
               "-c:s", "mov_text" if container == "mp4" else "srt",
               "-metadata:s:s:0", f"title={label}字幕",
               "-metadata:s:s:0", "language=chi",
               str(out)]
        def _ffmpeg(args: list) -> tuple[int, str, bool]:
            """带暂停/终止感知的 ffmpeg 执行。返回 (rc, stderr, cancelled)。"""
            proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, text=True)
            _procs[task_id] = proc
            stopped = False
            while proc.poll() is None:
                st = _job_state(task_id)
                if st == "cancel":
                    if stopped:
                        try:
                            os.kill(proc.pid, signal.SIGCONT)
                        except OSError:
                            pass
                    proc.kill()
                    break
                if st == "pause" and not stopped:
                    try:
                        os.kill(proc.pid, signal.SIGSTOP)
                        stopped = True
                    except OSError:
                        pass
                elif st != "pause" and stopped:
                    try:
                        os.kill(proc.pid, signal.SIGCONT)
                        stopped = False
                    except OSError:
                        pass
                time.sleep(0.5)
            _procs.pop(task_id, None)
            err = proc.stderr.read() if proc.stderr else ""
            return proc.returncode or 0, err, _job_state(task_id) == "cancel"

        rc, err, cancelled = _ffmpeg(cmd)
        if not cancelled and rc != 0 and container == "mp4":
            # 源音频编码可能不兼容 mp4(如 vorbis/opus)→ 音频转 aac 重试
            cmd[cmd.index("-c:a") + 1] = "aac"
            rc, err, cancelled = _ffmpeg(cmd)
        Path(srt).unlink(missing_ok=True)
        if cancelled:
            _finish_cancel(task_id, "burn")
            return
        if rc != 0:
            raise RuntimeError(
                err[-400:] or "ffmpeg 封装失败,试试 MKV 容器")
        _update(task_id, burn_status="done", stage="完成", burned_path=str(out))
    except Exception as e:  # noqa: BLE001
        _update(task_id, burn_status="error", burn_error=str(e)[:300])


def _run_analyze(task_id: str):
    try:
        data = tr.load_result(task_id)
        if data is None:
            raise llm_mod.LLMError("找不到转写结果")
        analysis = llm_mod.analyze(data["sentences"],
                                   check=lambda: _job_state(task_id))
        analysis_path = config.RESULT_DIR / f"{task_id}.analysis.json"
        analysis_path.write_text(
            json.dumps(analysis, ensure_ascii=False, indent=1), encoding="utf-8")
        _update(task_id, analyzed=True, analysis_status="done",
                ai_title=(analysis.get("title") or "").strip()[:120] or None)
    except llm_mod.JobCancelled:
        _finish_cancel(task_id, "analyze")
    except Exception as e:  # noqa: BLE001
        _update(task_id, analysis_status="error",
                analysis_error=str(e))


def _worker(channel: str):
    q = _queues[channel]
    while True:
        task_id, kind = q.get()
        t0 = time.time()
        try:
            with _lock:                      # 排队期间被终止 → 直接出队
                t = _tasks.get(task_id)
                dequeued_cancel = bool(t and t.get("cancel_requested"))
            if dequeued_cancel:
                _finish_cancel(task_id, kind)
                continue
            with _lock:
                _current[channel] = {"task_id": task_id, "kind": kind}
            log.info("[%s] 开始 %s task=%s", channel, kind, task_id)
            try:
                if kind == "transcribe":
                    _run_transcribe(task_id)
                elif kind == "analyze":
                    _run_analyze(task_id)
                elif kind == "polish":
                    _run_polish(task_id)
                elif kind == "translate":
                    _run_translate(task_id)
                elif kind == "burn":
                    _run_burn(task_id)
                log.info("[%s] 完成 %s task=%s 耗时 %.1fs",
                         channel, kind, task_id, time.time() - t0)
            except Exception:  # noqa: BLE001 — 作业异常不让 worker 退出
                log.exception("[%s] 异常 %s task=%s", channel, kind, task_id)
            finally:
                with _lock:
                    _current[channel] = {"task_id": None, "kind": None}
        finally:
            q.task_done()


def _recover():
    """服务重启后自愈:把中断的转写/润色任务重新入队,分析任务重置。"""
    requeue = []
    with _lock:
        for tid, t in _tasks.items():
            # 各项独立检查:一个任务可能同时有多个中断的后续步骤
            if t["status"] in ("queued", "transcribing") and Path(t["media"]).exists():
                t.update(status="queued", stage="排队中")
                requeue.append((tid, "transcribe"))
            if t.get("polish_status") == "running":
                if (config.RESULT_DIR / f"{tid}.raw.json").exists():
                    requeue.append((tid, "polish"))
                else:
                    t["polish_status"] = None
            if t.get("translation_status") == "running" and t["status"] == "done":
                requeue.append((tid, "translate"))
            if t.get("burn_status") == "running" and t["status"] == "done" \
                    and Path(t["media"]).exists():
                requeue.append((tid, "burn"))
            if t.get("analysis_status") == "running":
                t["analysis_status"] = None
        _persist(force=True)
    for item in requeue:
        _enqueue(*item)


_load()
threading.Thread(target=_worker, args=("heavy",), daemon=True).start()
threading.Thread(target=_worker, args=("llm",), daemon=True).start()
_recover()
