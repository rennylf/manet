"""进程内本地 LLM(mlx-lm)——免 Ollama,Apple Silicon 原生加速。

模型权重存放在项目工作文件夹 models/llm/ 下;仅用于翻译
(标点/笔记/脑图/问答走 API,见 llm.py 的分发逻辑)。
"""
import threading
from pathlib import Path

from . import config

MODEL_DIR = config.BASE_DIR / "models" / "llm"

_lock = threading.Lock()
_dl_lock = threading.Lock()
_state = {
    "model": None,
    "tokenizer": None,
    "loaded_repo": None,
    "downloading": False,
    "downloaded_bytes": 0,
    "total_bytes": 0,
    "error": None,
}


_cached_size: int | None = None  # 避免每次请求都递归扫描 4GB 目录


def _model_size() -> int:
    global _cached_size
    if _cached_size is not None:
        return _cached_size
    if not MODEL_DIR.exists():
        return 0
    _cached_size = sum(f.stat().st_size for f in MODEL_DIR.rglob("*") if f.is_file())
    return _cached_size


def _invalidate_size_cache():
    global _cached_size
    _cached_size = None


def status() -> dict:
    size = _model_size()
    return {
        "repo": config.LOCAL_MODEL_REPO,
        "installed": size > 0,
        "size_mb": round(size / 1048576),
        "downloading": _state["downloading"],
        "downloaded_mb": round(_state["downloaded_bytes"] / 1048576),
        "total_mb": round(_state["total_bytes"] / 1048576),
        "error": _state["error"],
        "loaded": _state["model"] is not None,
    }


def download() -> dict:
    """后台下载本地模型到 models/llm(已在下载则直接返回状态)。"""
    with _dl_lock:
        if _state["downloading"]:
            return status()
        _state["downloading"] = True
        _state["error"] = None

    def _dl():
        try:
            from huggingface_hub import snapshot_download
            snapshot_download(
                repo_id=config.LOCAL_MODEL_REPO,
                local_dir=str(MODEL_DIR),
                max_workers=4,
            )
        except Exception as e:  # noqa: BLE001 — 落盘给前端展示
            _state["error"] = f"{type(e).__name__}: {str(e)[:200]}"
        finally:
            _state["downloading"] = False
            _invalidate_size_cache()

    threading.Thread(target=_dl, daemon=True).start()
    return status()


def _load_model():
    with _lock:
        if _state["model"] is not None and _state["loaded_repo"] == config.LOCAL_MODEL_REPO:
            return _state["model"], _state["tokenizer"]
        if not MODEL_DIR.exists() or not any(MODEL_DIR.glob("*.safetensors")):
            raise RuntimeError("本地翻译模型未下载,请到设置页下载")
        from mlx_lm import load
        model, tokenizer = load(str(MODEL_DIR))
        _state.update(model=model, tokenizer=tokenizer,
                      loaded_repo=config.LOCAL_MODEL_REPO)
        return model, tokenizer


_gen_lock = threading.Lock()


def generate_text(messages: list[dict], max_tokens: int = 2000) -> str:
    """对话式生成(用模型自带 chat template)。模型生成串行加锁,线程安全。"""
    with _gen_lock:
        return _generate(messages, max_tokens)


def _generate(messages: list[dict], max_tokens: int) -> str:
    model, tokenizer = _load_model()
    prompt = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True)
    from mlx_lm import generate
    out = generate(model, tokenizer, prompt=prompt, max_tokens=max_tokens,
                   verbose=False)
    return (out or "").strip()
