"""音频抽取 + 本地转写(macOS: mlx-whisper;Windows 等: faster-whisper)。"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import config

_IS_APPLE = sys.platform == "darwin"


def _find_fftool(name: str) -> str:
    exe = shutil.which(name)
    if exe:
        return exe
    if os.name == "nt":                      # Windows 常见安装位置兜底
        for c in (rf"C:\ffmpeg\bin\{name}.exe",
                  rf"C:\Program Files\ffmpeg\bin\{name}.exe"):
            if os.path.exists(c):
                return c
    return f"/opt/homebrew/bin/{name}"


_FFMPEG = _find_fftool("ffmpeg")
_FFPROBE = _find_fftool("ffprobe")
FFMPEG = _FFMPEG


def probe_duration(path: Path) -> float:
    """用 ffprobe 读取媒体时长(秒)。"""
    out = subprocess.run(
        [_FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def extract_audio(src: Path, dst: Path) -> Path:
    """任意音视频 → 16kHz 单声道 wav(Whisper 的标准输入)。"""
    subprocess.run(
        [_FFMPEG, "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", str(dst)],
        capture_output=True, check=True,
    )
    return dst


# 句子边界:中英文标点 + 换行
_SENT_END = re.compile(r"[。!?!?;;\n]")


def _split_sentences(segments: list[dict]) -> list[dict]:
    """把 whisper 的 segment 按句末标点进一步切成句子,便于逐句点读。
    保留每句的起止时间(按字符比例在 segment 内插值)。"""
    sentences = []
    for seg in segments:
        text = seg["text"].strip()
        if not text:
            continue
        start, end = float(seg["start"]), float(seg["end"])
        dur = max(end - start, 1e-6)
        pieces, buf, buf_len = [], "", 0
        for ch in text:
            buf += ch
            buf_len += 1
            if _SENT_END.match(ch) and buf.strip():
                pieces.append(buf.strip())
                buf, buf_len = "", 0
        if buf.strip():
            pieces.append(buf.strip())
        # 按长度比例分配时间
        total_chars = sum(len(p) for p in pieces) or 1
        t = start
        for p in pieces:
            span = dur * len(p) / total_chars
            sentences.append({
                "start": round(t, 3),
                "end": round(min(t + span, end), 3),
                "text": p,
            })
            t += span
    return sentences


def _clip_samples(wav_path: Path, fracs: tuple[float, ...]) -> list[Path]:
    """按比例切出 30 秒片段,返回临时文件列表(用完由调用方清理)。"""
    duration = probe_duration(wav_path)
    tmp_clips = []
    for frac in fracs:
        t0 = duration * frac
        if t0 + 30 > duration:
            continue
        clip = wav_path.with_suffix(f".lang{int(t0)}.wav")
        subprocess.run(
            [_FFMPEG, "-y", "-ss", str(t0), "-t", "30", "-i", str(wav_path),
             "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(clip)],
            capture_output=True, check=True,
        )
        tmp_clips.append(clip)
    return tmp_clips


def _detect_language_fast(wav_path: Path) -> str | None:
    """只跑 encoder 的语言判别(不解码文本),比完整 transcribe 快一个量级。

    mlx_whisper 的 transcribe 在 language=None 时会做一次完整解码;
    多点投票若各解码一遍 30 秒音频,短文件的开销占比很大。这里直接
    调 model.detect_language(),几个片段合计仅毫秒级推理。
    """
    import importlib
    import mlx.core as mx
    import mlx_whisper.audio as wa

    trx = importlib.import_module("mlx_whisper.transcribe")  # 顶层被 re-export 覆盖
    model = trx.ModelHolder.get_model(config.WHISPER_MODEL, mx.float16)
    if not model.is_multilingual:
        return None

    duration = probe_duration(wav_path)
    fracs = (0.05, 0.30, 0.60) if duration >= 20 else (0.0,)
    votes: dict[str, int] = {}
    tmp_clips = _clip_samples(wav_path, fracs)
    try:
        for clip in tmp_clips:
            mel = wa.log_mel_spectrogram(str(clip), n_mels=model.dims.n_mels,
                                         padding=wa.N_SAMPLES)
            mel_seg = wa.pad_or_trim(mel, wa.N_FRAMES, axis=-2).astype(mx.float16)
            _, probs = model.detect_language(mel_seg)
            if probs:
                lang = max(probs, key=probs.get)
                votes[lang] = votes.get(lang, 0) + 1
    finally:
        for c in tmp_clips:
            c.unlink(missing_ok=True)
    return max(votes, key=votes.get) if votes else None


def _detect_language_vote(wav_path: Path) -> str | None:
    """兜底:完整 transcribe 各片段后按返回的 language 投票(内部 API 变动时用)。"""
    import mlx_whisper

    duration = probe_duration(wav_path)
    fracs = (0.05, 0.30, 0.60) if duration >= 20 else (0.0,)
    votes: dict[str, int] = {}
    tmp_clips = _clip_samples(wav_path, fracs)
    try:
        for clip in tmp_clips:
            r = mlx_whisper.transcribe(str(clip), path_or_hf_repo=config.WHISPER_MODEL,
                                       verbose=False)
            lang = r.get("language")
            if lang:
                votes[lang] = votes.get(lang, 0) + 1
    finally:
        for c in tmp_clips:
            c.unlink(missing_ok=True)
    return max(votes, key=votes.get) if votes else None


def detect_language(wav_path: Path) -> str | None:
    """多点采样语言检测:在音频 5% / 30% / 60% 处各取 30 秒片段投票。

    Whisper 内置检测只用开头 30 秒,发布会/播客开头常是音乐或片头,
    极易误判。多点投票能显著提升鲁棒性。
    """
    if not _IS_APPLE:
        try:
            return _detect_language_fw(wav_path)
        except Exception:  # noqa: BLE001
            return None
    try:
        return _detect_language_fast(wav_path)
    except Exception:  # noqa: BLE001 — mlx-whisper 升级导致内部 API 变化时兜底
        return _detect_language_vote(wav_path)


# ================= faster-whisper 后端(非 macOS 平台) =================
_FW_CACHE: dict = {}


def _get_fw():
    """懒加载并缓存 faster-whisper(CTranslate2)模型;首次运行自动下载到 HF_HOME。"""
    if "model" not in _FW_CACHE:
        from faster_whisper import WhisperModel
        _FW_CACHE["model"] = WhisperModel(
            config.WHISPER_CT2, device="auto", compute_type="auto")
    return _FW_CACHE["model"]


def _fw_detect_once(model, clip: str) -> str | None:
    res = model.detect_language(clip) if hasattr(model, "detect_language") else None
    if res is None:                          # 旧版无此方法:借 transcribe 的 info
        _, info = model.transcribe(clip, beam_size=1)
        return getattr(info, "language", None)
    if isinstance(res, tuple) and isinstance(res[0], str):
        return res[0]                        # (lang, prob)
    if isinstance(res, list) and res:
        return max(res, key=lambda x: x[1])[0]   # [(lang, prob), ...]
    return None


def _detect_language_fw(wav_path: Path) -> str | None:
    model = _get_fw()
    duration = probe_duration(wav_path)
    fracs = (0.05, 0.30, 0.60) if duration >= 20 else (0.0,)
    votes: dict[str, int] = {}
    tmp_clips = _clip_samples(wav_path, fracs)
    try:
        for clip in tmp_clips:
            lang = _fw_detect_once(model, str(clip))
            if lang:
                votes[lang] = votes.get(lang, 0) + 1
    finally:
        for c in tmp_clips:
            c.unlink(missing_ok=True)
    return max(votes, key=votes.get) if votes else None


def _transcribe_fw(wav_path: Path, language: str | None,
                   hotwords: str | None) -> dict:
    model = _get_fw()
    lang = language or config.WHISPER_LANGUAGE or _detect_language_fw(wav_path)
    prompt = None
    if hotwords and hotwords.strip():
        prompt = "以下是可能出现的专有名词:" + "、".join(
            w.strip() for w in re.split(r"[,,;;\n\s]+", hotwords.strip()) if w.strip()) + "。"
    segments, info = model.transcribe(
        str(wav_path), language=lang, initial_prompt=prompt,
        condition_on_previous_text=False, beam_size=5)
    segs = [{"start": float(s.start), "end": float(s.end), "text": s.text}
            for s in segments]
    sentences = _strip_prompt_echo(
        _clean_hallucinations(_split_sentences(segs)), hotwords)
    return {
        "language": lang or getattr(info, "language", None),
        "duration": max((s["end"] for s in sentences), default=0.0),
        "full_text": "".join(s["text"] for s in sentences),
        "sentences": sentences,
        "engine": "whisper-ct2",
    }


# Whisper 在音乐/静音段的经典幻觉输出(归一化后匹配,全部丢弃)
_HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching", "thanks for watching!",
    "thank you very much", "q&a", "the end.", "the end", "i'm sorry.",
    "what the hell?", "excuse me", "good night", "see you next time",
    "subscribe to my channel", "please subscribe", "字幕由volcengine提供",
    "字幕 Volunteers of Volcengine", "请不吝点赞 订阅 打赏", "明镜与点点",
    "明鏡與點點", "关注我的频道", "下期再见", "bye", "bye.",
}


# 幻觉特征词(只对短句生效,避免误伤正常内容)
_HALLU_RE = re.compile(
    r"字幕志愿者|字幕[:：]?\s*由|volcengine|transcribed by|作曲|作词|编曲"
    r"|明镜|优优独播|yoyo television|television series"
    r"|请不吝点赞|点赞订阅|订阅我的频道|关注我的频道|订阅打赏"
    r"|谢谢观看|感谢观看|谢谢收看|欢迎收看订阅|下期再见|http\S+",
    re.I,
)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _clean_hallucinations(sentences: list[dict]) -> list[dict]:
    """过滤幻觉:连续重复句去重;已知幻觉黑名单;特征词短句;整场高频短句。"""
    from collections import Counter
    counts = Counter(_norm(s["text"]) for s in sentences)
    out, prev = [], None
    for s in sentences:
        n = _norm(s["text"])
        if not n:
            continue
        if n == prev:                        # 连续重复 → 只保留第一句
            continue
        if n in _HALLUCINATIONS:             # 已知幻觉(精确匹配)
            continue
        if len(n) <= 40 and _HALLU_RE.search(n):  # 特征词短句
            continue
        if counts[n] >= 6 and len(n) <= 24:  # 整场高频短句 → 幻觉
            continue
        out.append(s)
        prev = n
    return out


def _strip_prompt_echo(sentences: list[dict], hotwords: str | None) -> list[dict]:
    """去掉热词泄漏:开头安静/音乐段 Whisper 常把 initial_prompt 的热词
    原样"念"进转写结果。若开头句子的字符全部来自热词表,则删除。"""
    if not hotwords or not hotwords.strip():
        return sentences
    def chars(t: str) -> set:
        return set(re.sub(r"[^0-9a-z一-鿿]", "", t.lower()))
    hw_chars = chars(re.sub(r"[,,;;\n\s]+", "", hotwords))
    out = list(sentences)
    while out:
        c = chars(out[0]["text"])
        if c and c <= hw_chars:   # 字符集是热词子集 → 泄漏句
            out.pop(0)
        else:
            break
    return out


def transcribe(wav_path: Path, language: str | None = None,
               hotwords: str | None = None) -> dict:
    """执行本地转写,返回结构化结果。

    language 为空时走多点采样检测;hotwords 通过 initial_prompt 注入
    (Whisper 官方推荐的术语引导方式)。
    macOS 走 mlx-whisper;其他平台(Windows 等)走 faster-whisper。
    """
    if not _IS_APPLE:
        return _transcribe_fw(wav_path, language, hotwords)
    import mlx_whisper  # 延迟导入:首次导入会触发模型加载

    lang = language or config.WHISPER_LANGUAGE or detect_language(wav_path)

    prompt = None
    if hotwords and hotwords.strip():
        prompt = "以下是可能出现的专有名词:" + "、".join(
            w.strip() for w in re.split(r"[,,;;\n\s]+", hotwords.strip()) if w.strip()
        ) + "。"

    result = mlx_whisper.transcribe(
        str(wav_path),
        path_or_hf_repo=config.WHISPER_MODEL,
        language=lang,
        initial_prompt=prompt,
        verbose=False,
        condition_on_previous_text=False,  # 防止长音频幻觉滚雪球
    )

    sentences = _strip_prompt_echo(
        _clean_hallucinations(_split_sentences(result["segments"])), hotwords)
    return {
        "language": lang or result.get("language"),
        "duration": float(result["segments"][-1]["end"]) if result["segments"] else 0.0,
        "full_text": "".join(s["text"] for s in sentences),
        "sentences": sentences,
    }


def _srt_ts(t: float) -> str:
    ms = int(round(t * 1000))
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_srt(sentences: list[dict], zh_texts: list[str] | None = None,
              mode: str = "orig") -> str:
    """生成 SRT 字幕。mode: orig 原文 / zh 中文 / both 双语(双行)。"""
    out = []
    for i, s in enumerate(sentences):
        zh = zh_texts[i].strip() if zh_texts and i < len(zh_texts) and zh_texts[i] else ""
        if mode == "zh" and zh:
            lines = [zh]
        elif mode == "both" and zh:
            lines = [s["text"], zh]
        else:
            lines = [s["text"]]
        out.append(f"{i + 1}\n{_srt_ts(s['start'])} --> {_srt_ts(s['end'])}\n"
                   + "\n".join(lines))
    return "\n\n".join(out) + "\n"


# ================= FunASR 引擎(paraformer / sensevoice) =================
_FA_CACHE: dict = {}
_TAG_RE = re.compile(r"<\|[^|>]*\|>")
_LANG_TAG_RE = re.compile(r"<\|([a-z]{2,3})\|>")


def _get_funasr(engine: str):
    """懒加载并缓存 FunASR 模型(首次调用从 ModelScope 下载)。"""
    if engine not in _FA_CACHE:
        from funasr import AutoModel
        if engine == "paraformer":
            # 中文 SOTA 级:VAD 切句 + ct-punc 原生标点 + cam++ 说话人分离
            _FA_CACHE[engine] = AutoModel(
                model="paraformer-zh", vad_model="fsmn-vad",
                punc_model="ct-punc", spk_model="cam++")
        elif engine == "sensevoice":
            # 极快、多语种;VAD 切段由 _run_sensevoice 单独做
            _FA_CACHE[engine] = AutoModel(model="iic/SenseVoiceSmall")
        else:
            raise ValueError(f"未知 FunASR 引擎: {engine}")
    return _FA_CACHE[engine]


def _read_pcm16(path: Path):
    import wave
    import numpy as np
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return sr, pcm


def _vad_segments(wav_path: Path) -> list[list[int]]:
    """fsmn-vad 切语音段,返回 [[start_ms, end_ms], ...]。"""
    if "vad" not in _FA_CACHE:
        from funasr import AutoModel
        _FA_CACHE["vad"] = AutoModel(model="fsmn-vad", disable_update=True)
    res = _FA_CACHE["vad"].generate(input=str(wav_path), disable_update=True)
    return (res[0] or {}).get("value") or []


def _run_sensevoice(wav_path: Path,
                    language: str | None = None) -> tuple[list[dict], str | None]:
    """SenseVoice 裸模型无时间戳:先用 VAD 切段,再逐段识别,段内按标点插值切句。

    language 为空时按片段自动判定(静音/音乐多时易漂移,如日语判成中文);
    显式指定(zh/en/ja/ko/yue)则强制按该语种解码,准确率明显更稳。
    """
    import numpy as np
    model = _get_funasr("sensevoice")
    segs = _vad_segments(wav_path)
    if not segs:
        segs = [[0, int(probe_duration(wav_path) * 1000)]]
    sr, pcm = _read_pcm16(wav_path)
    pcm = pcm.astype(np.float32) / 32768.0       # 必须归一化:funasr 数组输入按浮点波形处理
    pairs = []
    for a, b in segs:
        arr = pcm[int(sr * a / 1000):int(sr * b / 1000)]
        if len(arr) > 1600:                      # 忽略 <0.1s 的碎段
            pairs.append(([a, b], arr))
    if not pairs:
        return [], None
    lang = language if language in ("zh", "en", "ja", "ko", "yue") else "auto"
    res = model.generate(input=[arr for _, arr in pairs], batch_size_s=300,
                         language=lang, use_itn=True)
    seg_dicts, language = [], None
    for (a, b), item in zip([p[0] for p in pairs], res or []):
        raw = item.get("text", "") or ""
        if language is None:
            m = _LANG_TAG_RE.search(raw)
            if m:
                language = m.group(1)
        text = _TAG_RE.sub("", raw).strip()
        if text:
            seg_dicts.append({"start": a / 1000, "end": b / 1000, "text": text})
    return _split_sentences(seg_dicts), language


def transcribe_funasr(wav_path: Path, engine: str,
                      hotwords: str | None = None,
                      language: str | None = None) -> dict:
    if engine == "sensevoice":
        sentences, language = _run_sensevoice(wav_path, language)
        return {
            "language": language,
            "duration": max((s["end"] for s in sentences), default=0.0),
            "full_text": "".join(s["text"] for s in sentences),
            "sentences": sentences,
            "engine": engine,
        }

    model = _get_funasr(engine)
    kwargs = {"input": str(wav_path), "batch_size_s": 300}
    if engine == "paraformer" and hotwords and hotwords.strip():
        # paraformer 原生热词:空格分隔,可带权重 "词 20"
        kwargs["hotword"] = " ".join(
            w.strip() for w in re.split(r"[,,;;\n\s]+", hotwords.strip()) if w.strip())
    res = model.generate(**kwargs)

    sentences: list[dict] = []
    language = None
    for item in res or []:
        raw = item.get("text", "") or ""
        if language is None:
            m = _LANG_TAG_RE.search(raw)      # sensevoice 的 <|zh|> 语种标签
            if m:
                language = m.group(1)
        infos = item.get("sentence_info")
        if infos:                              # 带 VAD 时的逐句结果(含说话人)
            for si in infos:
                text = _TAG_RE.sub("", si.get("text", "") or "").strip()
                if not text:
                    continue
                spk = si.get("spk", si.get("spk_id"))
                sent = {
                    "start": round(float(si.get("start", 0)) / 1000, 3),
                    "end": round(float(si.get("end", 0)) / 1000, 3),
                    "text": text,
                }
                if spk is not None:
                    sent["speaker"] = int(spk)
                sentences.append(sent)
            continue
        # 兜底:整条结果 + 词级时间戳列表 → 按标点切句插值
        text = _TAG_RE.sub("", raw).strip()
        if not text:
            continue
        ts = item.get("timestamp") or []
        seg = {"start": (ts[0][0] / 1000 if ts else 0.0),
               "end": (ts[-1][1] / 1000 if ts else 0.0), "text": text}
        sentences.extend(_split_sentences([seg]))

    if language is None:
        language = "zh" if engine == "paraformer" else None
    return {
        "language": language,
        "duration": max((s["end"] for s in sentences), default=0.0),
        "full_text": "".join(s["text"] for s in sentences),
        "sentences": sentences,
        "engine": engine,
    }


def save_result(task_id: str, data: dict) -> Path:
    path = config.RESULT_DIR / f"{task_id}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def load_result(task_id: str) -> dict | None:
    path = config.RESULT_DIR / f"{task_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
