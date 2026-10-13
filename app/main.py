"""FastAPI 入口:上传、任务状态、转写稿读写、AI 分析、导出、媒体回放。"""
import json
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, settings as settings_mod, tasks, transcribe as tr
from .utils import fmt_ts, load_json

app = FastAPI(title="Manet", version="1.0.0",
              description="Manet — 本地声音转写与解读(quod manet, manet)")

STATIC_DIR = Path(__file__).parent / "static"


def _fmt_ts(sec: float, force_hour: bool = False) -> str:
    return fmt_ts(sec, force_hour)


@app.post("/api/upload")
async def upload(
    file: UploadFile = File(...),
    language: str = Form(""),
    hotwords: str = Form(""),
    engine: str = Form(""),
    auto_translate: bool = Form(False),
):
    name = Path(file.filename or "recording").name
    ext = Path(name).suffix.lower()
    if ext not in config.ALLOWED_EXT:
        raise HTTPException(400, f"不支持的格式 {ext},支持:{' '.join(sorted(config.ALLOWED_EXT))}")
    # 先落盘为临时文件,create_task 内部会用 task_id 重命名
    tmp = config.UPLOAD_DIR / f"tmp_{int(time.time()*1000)}{ext}"
    size = 0
    with open(tmp, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > config.MAX_UPLOAD_MB * 1024 * 1024:
                f.close()
                tmp.unlink(missing_ok=True)
                raise HTTPException(413, f"文件超过 {config.MAX_UPLOAD_MB}MB 上限")
            f.write(chunk)
    task_id = tasks.create_task(
        name, tmp, language.strip() or None, hotwords.strip() or None,
        engine=engine.strip() or None, auto_translate=auto_translate)
    return {"task_id": task_id}


@app.get("/api/tasks")
def api_list_tasks():
    return tasks.list_tasks()


@app.get("/api/tasks/{task_id}")
def api_get_task(task_id: str):
    task = tasks.get_task(task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    return task


class TranscriptEdit(BaseModel):
    sentences: list[dict]


@app.get("/api/tasks/{task_id}/transcript")
def api_get_transcript(task_id: str):
    data = tr.load_result(task_id)
    if data is None:
        raise HTTPException(404, "转写结果不存在(任务可能未完成)")
    return data


@app.put("/api/tasks/{task_id}/transcript")
def api_edit_transcript(task_id: str, body: TranscriptEdit):
    for s in body.sentences:
        if "text" not in s or "start" not in s or "end" not in s:
            raise HTTPException(400, "句子需包含 text/start/end 字段")
    try:
        tasks.mark_edited(task_id, body.sentences)
    except KeyError:
        raise HTTPException(404, "转写结果不存在")
    return {"ok": True}


class RetranscribeReq(BaseModel):
    language: str = ""
    hotwords: str = ""
    engine: str = ""
    auto_translate: bool = False


@app.post("/api/tasks/{task_id}/retranscribe")
def api_retranscribe(task_id: str, body: RetranscribeReq):
    try:
        tasks.retranscribe(task_id, body.language.strip() or None,
                           body.hotwords.strip() or None,
                           engine=body.engine.strip() or None,
                           auto_translate=body.auto_translate)
    except KeyError:
        raise HTTPException(404, "任务不存在")
    except FileNotFoundError as e:
        raise HTTPException(410, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


@app.post("/api/tasks/{task_id}/analyze")
def api_analyze(task_id: str):
    try:
        tasks.request_analysis(task_id)
    except KeyError:
        raise HTTPException(409, "任务尚未完成转写,无法分析")
    return {"ok": True}


@app.post("/api/tasks/{task_id}/polish")
def api_polish(task_id: str):
    """对已完成的转写稿做 AI 标点恢复(不重新转写)。"""
    try:
        tasks.request_polish(task_id)
    except KeyError:
        raise HTTPException(404, "任务不存在")
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


# ================= 翻译 / 字幕烧录 =================
def _load_translation(task_id: str) -> list[str] | None:
    return load_json(config.RESULT_DIR / f"{task_id}.translation.json")


@app.get("/api/tasks/{task_id}/translation")
def api_get_translation(task_id: str):
    zh = _load_translation(task_id)
    if zh is None:
        raise HTTPException(404, "尚无翻译")
    return {"zh": zh}


@app.post("/api/tasks/{task_id}/translate")
def api_translate(task_id: str):
    try:
        tasks.request_translate(task_id)
    except KeyError:
        raise HTTPException(404, "任务不存在")
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


class BurnReq(BaseModel):
    mode: str = "both"
    container: str = "mp4"


@app.post("/api/tasks/{task_id}/burn")
def api_burn(task_id: str, body: BurnReq):
    """软字幕封装:字幕轨混流进 MP4/MKV,播放时可开关(流拷贝,不重编码)。"""
    if body.mode not in ("orig", "zh", "both"):
        raise HTTPException(400, "mode 必须是 orig/zh/both")
    try:
        tasks.request_burn(task_id, body.mode, body.container)
    except KeyError:
        raise HTTPException(404, "任务不存在")
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


@app.get("/api/tasks/{task_id}/burned")
def api_burned(task_id: str):
    task = tasks.get_task(task_id)
    if not task or not task.get("burned_path") or not Path(task["burned_path"]).exists():
        raise HTTPException(404, "烧录视频不存在")
    return FileResponse(task["burned_path"], filename=Path(task["burned_path"]).name)


# ================= 文件夹 / 库管理 =================
class FolderReq(BaseModel):
    name: str


@app.get("/api/folders")
def api_list_folders():
    return tasks.list_folders()


@app.post("/api/folders")
def api_create_folder(body: FolderReq):
    if not body.name.strip():
        raise HTTPException(400, "文件夹名不能为空")
    return tasks.create_folder(body.name)


@app.patch("/api/folders/{folder_id}")
def api_rename_folder(folder_id: str, body: FolderReq):
    try:
        tasks.rename_folder(folder_id, body.name)
    except KeyError:
        raise HTTPException(404, "文件夹不存在")
    return {"ok": True}


@app.delete("/api/folders/{folder_id}")
def api_delete_folder(folder_id: str):
    tasks.delete_folder(folder_id)
    return {"ok": True}


class MoveReq(BaseModel):
    folder_id: str | None = None


@app.post("/api/tasks/{task_id}/move")
def api_move_task(task_id: str, body: MoveReq):
    try:
        tasks.move_task(task_id, body.folder_id)
    except KeyError:
        raise HTTPException(404, "任务或文件夹不存在")
    return {"ok": True}


@app.delete("/api/tasks/{task_id}")
def api_delete_task(task_id: str):
    try:
        tasks.delete_task(task_id)
    except KeyError:
        raise HTTPException(404, "任务不存在")
    return {"ok": True}


class PauseReq(BaseModel):
    paused: bool


@app.post("/api/tasks/{task_id}/pause")
def api_pause_task(task_id: str, body: PauseReq):
    """暂停/继续:分块任务在块间挂起;ffmpeg 封装用 SIGSTOP/SIGCONT 真暂停。"""
    try:
        tasks.set_paused(task_id, body.paused)
    except KeyError:
        raise HTTPException(404, "任务不存在")
    return {"ok": True}


@app.post("/api/tasks/{task_id}/cancel")
def api_cancel_task(task_id: str):
    """终止:排队任务直接出队;进行中任务协作式取消(转写跑完丢弃结果)。"""
    try:
        tasks.request_cancel(task_id)
    except KeyError:
        raise HTTPException(404, "任务不存在")
    return {"ok": True}


class TitleReq(BaseModel):
    title: str


@app.patch("/api/tasks/{task_id}")
def api_set_title(task_id: str, body: TitleReq):
    if not body.title.strip():
        raise HTTPException(400, "标题不能为空")
    try:
        tasks.set_title(task_id, body.title)
    except KeyError:
        raise HTTPException(404, "任务不存在")
    return {"ok": True}


class ChatReq(BaseModel):
    messages: list[dict]


@app.post("/api/tasks/{task_id}/chat")
def api_chat(task_id: str, body: ChatReq):
    """与这段录音对话:上下文 = 转写稿全文(+AI 摘要)。"""
    from . import llm as llm_mod
    data = tr.load_result(task_id)
    if data is None:
        raise HTTPException(404, "转写结果不存在")
    # 清洗历史:只留 user/assistant,最多 20 条,内容必须是字符串
    msgs = [
        {"role": m.get("role"), "content": str(m.get("content", ""))[:4000]}
        for m in body.messages[-20:]
        if m.get("role") in ("user", "assistant") and str(m.get("content", "")).strip()
    ]
    if not msgs or msgs[-1]["role"] != "user":
        raise HTTPException(400, "最后一条必须是用户消息")
    analysis = load_json(config.RESULT_DIR / f"{task_id}.analysis.json")
    try:
        reply = llm_mod.chat_with_transcript(data["sentences"], analysis, msgs)
    except llm_mod.LLMError as e:
        raise HTTPException(502, str(e))
    return {"reply": reply}


@app.get("/api/tasks/{task_id}/mindmap")
def api_get_mindmap(task_id: str):
    data = load_json(config.RESULT_DIR / f"{task_id}.mindmap.json")
    if data is None:
        raise HTTPException(404, "尚无思维导图")
    return data


@app.post("/api/tasks/{task_id}/mindmap")
def api_gen_mindmap(task_id: str, regen: bool = False):
    """生成思维导图(有缓存直接返回,regen=true 强制重新生成)。"""
    from . import llm as llm_mod
    cached = load_json(config.RESULT_DIR / f"{task_id}.mindmap.json")
    if cached is not None and not regen:
        return cached
    data = tr.load_result(task_id)
    if data is None:
        raise HTTPException(404, "转写结果不存在")
    try:
        tree = llm_mod.mindmap(data["sentences"])
    except llm_mod.LLMError as e:
        raise HTTPException(502, str(e))
    path.write_text(json.dumps(tree, ensure_ascii=False, indent=1), encoding="utf-8")
    return tree


@app.get("/api/tasks/{task_id}/essay")
def api_get_essay(task_id: str):
    p = config.RESULT_DIR / f"{task_id}.essay.txt"
    if not p.exists():
        raise HTTPException(404, "尚无随笔")
    return {"essay": p.read_text(encoding="utf-8")}


@app.post("/api/tasks/{task_id}/essay")
def api_gen_essay(task_id: str, regen: bool = False):
    """把转写稿改写为一篇主旨明确、内容精炼的随笔(有缓存直接返回,regen=true 强制重新生成)。"""
    from . import llm as llm_mod
    p = config.RESULT_DIR / f"{task_id}.essay.txt"
    if p.exists() and not regen:
        return {"essay": p.read_text(encoding="utf-8")}
    data = tr.load_result(task_id)
    if data is None:
        raise HTTPException(404, "转写结果不存在")
    try:
        text = llm_mod.essay(data["sentences"])
    except llm_mod.LLMError as e:
        raise HTTPException(502, str(e))
    p.write_text(text, encoding="utf-8")
    return {"essay": text}


def _essay_title_from_text(text: str, fallback: str) -> str:
    """从随笔正文提取标题:优先首行 Markdown 标题,否则取首句。"""
    import re
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if not lines:
        return fallback
    first = lines[0]
    m = re.match(r"^#{1,6}\s*(.+)$", first)
    title = m.group(1).strip() if m else (
        re.split(r"[。.!?!?;;]", first, maxsplit=1)[0].strip() or first)
    title = re.sub(r"[*_`]", "", title).strip()
    return title[:60] or fallback


@app.post("/api/tasks/{task_id}/export-essay")
def api_export_essay(task_id: str):
    """把已生成的随笔导出到 Obsidian:文件名用随笔标题,frontmatter 只含 author/pub_year/tags。"""
    import datetime
    p = config.RESULT_DIR / f"{task_id}.essay.txt"
    if not p.exists():
        raise HTTPException(409, "请先生成随笔")
    essay_text = p.read_text(encoding="utf-8").strip()
    if not essay_text:
        raise HTTPException(409, "随笔内容为空")

    settings = settings_mod.get(mask_key=False)
    vault = (settings.get("obsidian_path") or "").strip()
    if not vault:
        vault = str(Path.home() / "Documents" / "Obsidian")
    vault = Path(vault)
    if not vault.exists():
        raise HTTPException(409, f"目标文件夹不存在:{vault}")

    task = tasks.get_task(task_id)
    fallback = (task.get("display_title") if task else None) or task_id
    title = _essay_title_from_text(essay_text, fallback)
    created_at = datetime.datetime.fromtimestamp(task.get("created_at", 0)) if task else datetime.datetime.now()
    pub_year = created_at.strftime("%Y%m%d")

    content = "\n".join([
        "---",
        'author: ""',
        f"pub_year: {pub_year}",
        "tags: []",
        "---",
        "",
        essay_text,
    ])
    safe_title = "".join(c for c in title if c.isalnum() or c in " _-—，。、").strip()[:80] or task_id
    out_path = vault / f"{safe_title}.md"
    out_path.write_text(content, encoding="utf-8")
    return {"ok": True, "path": str(out_path)}


class NotesReq(BaseModel):
    text: str


@app.get("/api/tasks/{task_id}/notes")
def api_get_notes(task_id: str):
    return {"text": tasks.load_notes(task_id)}


@app.put("/api/tasks/{task_id}/notes")
def api_put_notes(task_id: str, body: NotesReq):
    if tasks.get_task(task_id) is None:
        raise HTTPException(404, "任务不存在")
    tasks.save_notes(task_id, body.text[:200_000])
    return {"ok": True}


class ChatLogReq(BaseModel):
    messages: list[dict]


@app.put("/api/tasks/{task_id}/chat-log")
def api_save_chat_log(task_id: str, body: ChatLogReq):
    """持久化问答记录(供 Obsidian 导出读取)。"""
    p = config.RESULT_DIR / f"{task_id}.chat.json"
    # 只保留 role + content 字段
    clean = [{"role": m.get("role", ""), "content": str(m.get("content", ""))[:4000]}
             for m in body.messages[-100:] if m.get("content")]
    p.write_text(json.dumps(clean, ensure_ascii=False), encoding="utf-8")
    return {"ok": True}


@app.get("/api/tasks/{task_id}/chat-log")
def api_load_chat_log(task_id: str):
    p = config.RESULT_DIR / f"{task_id}.chat.json"
    if not p.exists():
        return {"messages": []}
    return {"messages": json.loads(p.read_text(encoding="utf-8"))}


@app.post("/api/tasks/{task_id}/export-obsidian")
def api_export_obsidian(task_id: str):
    """导出到 Obsidian 知识库:Markdown + YAML frontmatter,写入用户设置的目标文件夹。"""
    import datetime
    settings = settings_mod.get(mask_key=False)
    vault = (settings.get("obsidian_path") or "").strip()
    if not vault:
        # 默认 ~/Documents/Obsidian
        vault = str(Path.home() / "Documents" / "Obsidian")
    vault = Path(vault)
    if not vault.exists():
        raise HTTPException(409, f"目标文件夹不存在:{vault}")

    sections_str = settings.get("obsidian_sections") or "transcript,notes,ai,chat"
    sections = {s.strip() for s in sections_str.split(",") if s.strip()}

    task = tasks.get_task(task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    data = tr.load_result(task_id)
    if data is None:
        raise HTTPException(404, "转写结果不存在")

    title = task.get("display_title") or task.get("filename", task_id)
    created_at = datetime.datetime.fromtimestamp(task.get("created_at", 0))
    year_tag = created_at.strftime("%Y%m%d")
    sentences = data.get("sentences", [])
    zh = _load_translation(task_id)
    analysis = load_json(config.RESULT_DIR / f"{task_id}.analysis.json")
    notes = tasks.load_notes(task_id)
    chat_log = ""
    chat_path = config.RESULT_DIR / f"{task_id}.chat.json"
    if chat_path.exists():
        try:
            msgs = json.loads(chat_path.read_text(encoding="utf-8"))
            chat_log = "\n".join(f"**{m.get('role','')}:** {m.get('content','')}" for m in msgs)
        except Exception:
            pass

    # 组装 YAML frontmatter
    front = [
        "---",
        f"title: \"{title}\"",
        f"date: {created_at.strftime('%Y-%m-%d')}",
        f"year: {year_tag}",
        "tags: []",
        "author: \"\"",
        f"source: manet",
        "---",
        "",
        f"# {title}",
        "",
    ]

    md_parts: list[str] = front

    if "ai" in sections and analysis:
        md_parts.append("## 📝 AI 笔记\n")
        if analysis.get("summary"):
            md_parts.append(f"### 摘要\n{analysis['summary']}\n")
        if analysis.get("chapters"):
            md_parts.append("### 章节速览\n")
            for c in analysis["chapters"]:
                t = c.get("time", "")
                title_c = c.get("title", "")
                detail = c.get("detail", "")
                md_parts.append(f"- **[{t}] {title_c}**" + (f" — {detail}" if detail else ""))
            md_parts.append("")
        if analysis.get("todos"):
            md_parts.append("### 待办事项\n")
            for t in analysis["todos"]:
                line = f"- [ ] {t.get('task','')}"
                if t.get("owner"):
                    line += f" (负责人:{t['owner']})"
                if t.get("due"):
                    line += f" (截止:{t['due']})"
                md_parts.append(line)
            md_parts.append("")
        if analysis.get("keywords"):
            md_parts.append(f"### 关键词\n{'、'.join(analysis['keywords'])}\n")

    if "transcript" in sections and sentences:
        md_parts.append("## 转写全文\n")
        for i, s in enumerate(sentences):
            ts = _fmt_ts(s.get("start", 0), True)
            txt = s["text"]
            z = (zh[i].strip() if zh and i < len(zh) and zh[i] else "") if zh else ""
            if zh and z:
                md_parts.append(f"**[{ts}]** {txt}\n> {z}\n")
            else:
                md_parts.append(f"**[{ts}]** {txt}\n")

    if "chat" in sections and chat_log:
        md_parts.append(f"## 问答记录\n{chat_log}\n")

    if "notes" in sections and notes:
        md_parts.append(f"## 我的笔记\n{notes}\n")

    content = "\n".join(md_parts)

    # 写入 Obsidian 目录
    safe_title = "".join(c for c in title if c.isalnum() or c in " _-—，。、").strip()[:80] or task_id
    out_path = vault / f"{safe_title}_{year_tag}.md"
    out_path.write_text(content, encoding="utf-8")

    return {"ok": True, "path": str(out_path), "sections": list(sections)}


@app.get("/api/tasks/{task_id}/analysis")
def api_get_analysis(task_id: str):
    data = load_json(config.RESULT_DIR / f"{task_id}.analysis.json")
    if data is None:
        raise HTTPException(404, "尚无分析结果")
    return data


@app.get("/api/tasks/{task_id}/export", response_class=PlainTextResponse)
def api_export(task_id: str, format: str = "md", lang: str = "orig"):
    """lang: orig 原文 / zh 中文 / both 双语。"""
    data = tr.load_result(task_id)
    if data is None:
        raise HTTPException(404, "转写结果不存在")
    zh = _load_translation(task_id)
    if lang != "orig" and not zh:
        raise HTTPException(409, "尚无翻译,请先在详情页生成翻译")
    analysis = load_json(config.RESULT_DIR / f"{task_id}.analysis.json")
    title = (analysis or {}).get("title") or Path(data.get("filename", task_id)).stem
    sentences = data["sentences"]

    def zh_of(i: int) -> str:
        return (zh[i].strip() if zh and i < len(zh) and zh[i] else "") or sentences[i]["text"]

    if format == "srt":
        body = tr.build_srt(sentences, zh, lang)
        return PlainTextResponse(body, headers={
            "Content-Disposition": f'attachment; filename="{task_id}_{lang}.srt"'})

    if format == "txt":
        lines = []
        for i, s in enumerate(sentences):
            if lang == "both":
                lines.append(f"[{_fmt_ts(s['start'], True)}] {s['text']} / {zh_of(i)}")
            elif lang == "zh":
                lines.append(f"[{_fmt_ts(s['start'], True)}] {zh_of(i)}")
            else:
                lines.append(f"[{_fmt_ts(s['start'], True)}] {s['text']}")
        return PlainTextResponse(f"{title}\n\n" + "\n".join(lines), headers={
            "Content-Disposition": f'attachment; filename="{task_id}_{lang}.txt"'})

    # markdown(默认):AI 分析 + 全文
    md = [f"# {title}\n"]
    if analysis:
        if analysis.get("summary"):
            md += ["## 摘要\n", analysis["summary"], ""]
        if analysis.get("chapters"):
            md += ["## 章节速览\n"]
            md += [f"- **[{c.get('time', '')}] {c.get('title', '')}** — {c.get('detail', '')}"
                   for c in analysis["chapters"]]
            md.append("")
        if analysis.get("todos"):
            md += ["## 待办事项\n"]
            md += [f"- [ ] {t.get('task', '')}"
                   + (f"(负责人:{t['owner']})" if t.get("owner") else "")
                   + (f"(截止:{t['due']})" if t.get("due") else "")
                   for t in analysis["todos"]]
            md.append("")
        if analysis.get("keywords"):
            md += ["## 关键词\n", "、".join(analysis["keywords"]), ""]
    md += ["## 转写全文\n"]
    for i, s in enumerate(sentences):
        if lang == "both":
            md += [f"**[{_fmt_ts(s['start'], True)}]** {s['text']}\n",
                   f"> {zh_of(i)}\n"]
        elif lang == "zh":
            md += [f"**[{_fmt_ts(s['start'], True)}]** {zh_of(i)}\n"]
        else:
            md += [f"**[{_fmt_ts(s['start'], True)}]** {s['text']}\n"]
    return PlainTextResponse("\n".join(md), headers={
        "Content-Disposition": f'attachment; filename="{task_id}_{lang}.md"'})


@app.get("/media/{task_id}")
def api_media(task_id: str):
    task = tasks.get_task(task_id)
    if task is None or not Path(task["media"]).exists():
        raise HTTPException(404, "媒体文件不存在")
    return FileResponse(task["media"])


# ================= API 设置 =================
class SettingsReq(BaseModel):
    # None = 不修改;"" = 清空(base/model 清空后跟随全局);Key 字段 "" = 保留原值
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str | None = None
    polish_enabled: bool | None = None
    asr_engine: str | None = None
    translate_mode: str | None = None
    local_model_repo: str | None = None
    obsidian_path: str | None = None
    obsidian_sections: str | None = None
    essay_prompt: str | None = None


@app.get("/api/settings/local-model")
def api_local_model_status():
    """本地翻译模型状态(是否已下载/下载进度)。"""
    from . import local_llm
    return local_llm.status()


@app.post("/api/settings/local-model/download")
def api_local_model_download():
    """后台下载本地翻译模型到项目 models/llm/。"""
    from . import local_llm
    return local_llm.download()


@app.get("/api/settings")
def api_get_settings(reveal: bool = False):
    """reveal=true 时回明文 Key(仅本机回环,供设置页密码框回显为黑点)。"""
    return settings_mod.get(mask_key=not reveal)


@app.put("/api/settings")
def api_put_settings(body: SettingsReq):
    return settings_mod.update(body.model_dump())


class SettingsTestReq(BaseModel):
    llm_base_url: str = ""
    llm_api_key: str = ""


@app.post("/api/settings/test")
def api_test_settings(body: SettingsTestReq):
    """连通性测试 + 拉取可用模型列表(供设置页下拉选择)。"""
    import httpx
    cur = settings_mod.get(mask_key=False)
    base = (body.llm_base_url or cur["llm_base_url"]).strip()
    key = body.llm_api_key.strip() or cur["llm_api_key"]
    if not base:
        return {"ok": False, "error": "Base URL 为空"}
    try:
        r = httpx.get(base.rstrip("/") + "/models",
                      headers={"Authorization": f"Bearer {key}"}, timeout=8)
        if r.status_code != 200:
            return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
        models = [m.get("id") for m in r.json().get("data", []) if m.get("id")]
        return {"ok": True, "models": models}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}


@app.middleware("http")
async def _no_cache_frontend(request, call_next):
    """开发期强制前端文件不缓存,避免改 CSS/JS 后浏览器仍用旧版。"""
    resp = await call_next(request)
    path = request.url.path
    if path.endswith((".html", ".css", ".js")) or path == "/":
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    return resp


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
