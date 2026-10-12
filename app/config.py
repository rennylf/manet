"""全局配置:路径与可通过环境变量覆盖的选项。"""
import os
from pathlib import Path

# 修复:某些环境在 NO_PROXY 里写了 "[::1]"(带方括号的 IPv6),
# httpx 解析时会抛 "InvalidURL: Invalid port: ':1]'",这里启动时清洗掉。
for _var in ("NO_PROXY", "no_proxy"):
    _v = os.environ.get(_var)
    if _v and "[" in _v:
        os.environ[_var] = ",".join(
            p.strip().strip("[]") if p.strip().startswith("[") else p
            for p in _v.split(",")
        )

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"      # 原始上传文件(用于回放)
AUDIO_DIR = DATA_DIR / "audio"         # ffmpeg 抽取的 16k wav
RESULT_DIR = DATA_DIR / "results"      # 转写/分析 JSON

for d in (UPLOAD_DIR, AUDIO_DIR, RESULT_DIR):
    d.mkdir(parents=True, exist_ok=True)

# ---- 转写 ----
# MLX 模型仓库(HuggingFace)。turbo 版在 M 系列芯片上约 10x 实时速度
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
# None = 自动检测语言;"zh"/"en"/"ja"... 可强制指定
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None
# 转写引擎:whisper(多语种) / paraformer(中文+标点+说话人分离) / sensevoice(快+原生标点)
ASR_ENGINE = os.environ.get("ASR_ENGINE", "whisper")

# ---- LLM(任意 OpenAI 兼容端点,默认指向本机 Ollama)----
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://localhost:11434/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "ollama")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen2.5:7b-instruct")
# 单次送入 LLM 的转写文本上限(字符),超出则 map-reduce 分段总结
LLM_MAX_CHARS = int(os.environ.get("LLM_MAX_CHARS", "24000"))
# 转写完成后若 LLM 可用,自动做标点恢复(Whisper 对带背景音的中文常丢标点)
POLISH_ENABLED = os.environ.get("POLISH_ENABLED", "1") == "1"
# LLM 分块并发数(本地模型内部会串行化生成,API 端点按并发提交)
LLM_PARALLEL = int(os.environ.get("LLM_PARALLEL", "4"))

# ---- 翻译引擎:local(进程内 mlx-lm)/ api(走统一端点)----
TRANSLATE_MODE = os.environ.get("TRANSLATE_MODE", "local")
# 本地翻译模型(HF 仓库 id,下载到项目 models/llm/)
LOCAL_MODEL_REPO = os.environ.get("LOCAL_MODEL_REPO",
                                  "mlx-community/Qwen2.5-3B-Instruct-4bit")

# ---- AI 随笔:生成提示词(设置页可自定义,{transcript} 为转写稿占位符)----
ESSAY_PROMPT_DEFAULT = """你是文笔凝练、逻辑清晰的随笔作家。请把下面这段音频/视频的转写稿改写为一篇主旨明确、内容精炼的随笔文章。
要求:
1. 先抓住全文主旨,围绕核心观点与关键事实组织文章,删去口语冗余、重复、语气词和无意义碎片;
2. 内容忠于原文:不编造、不夸大、不添加原文没有的观点或数据;
3. 语言凝练流畅,结构清晰,可适当分段(必要时用简洁的小标题);
4. 篇幅控制在原文的 1/5 ~ 1/3;
5. 使用与转写稿相同的语言;
6. 第一行输出随笔标题,用 Markdown 一级标题格式(# 标题),正文从第二行开始;
7. 除标题外直接输出文章正文,不要任何"以下是改写后的文章"之类的说明或前缀。

转写稿:
{transcript}"""
ESSAY_PROMPT = os.environ.get("ESSAY_PROMPT", "") or ESSAY_PROMPT_DEFAULT

def snapshot() -> dict:
    """返回当前配置的不可变快照——长任务启动时调用,避免中途切设置影响运行中的任务。"""
    return {
        "LLM_BASE_URL": LLM_BASE_URL, "LLM_API_KEY": LLM_API_KEY, "LLM_MODEL": LLM_MODEL,
        "LLM_MAX_CHARS": LLM_MAX_CHARS, "LLM_PARALLEL": LLM_PARALLEL,
        "TRANSLATE_MODE": TRANSLATE_MODE, "POLISH_ENABLED": POLISH_ENABLED,
        "ASR_ENGINE": ASR_ENGINE, "WHISPER_MODEL": WHISPER_MODEL,
    }


MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "2048"))
ALLOWED_EXT = {
    ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".amr",
    ".mp4", ".mov", ".mkv", ".avi", ".webm", ".flv", ".wmv", ".ts",
}
