"""运行时可配置的 LLM 设置,持久化到 data/settings.json。

优先级:settings.json > 环境变量(start.sh)> 代码默认值。
修改后立即写回 config 模块属性,llm.py 每次调用时读取,无需重启。
"""
import json
import threading

from . import config

SETTINGS_FILE = config.DATA_DIR / "settings.json"
# 必须可重入:update() 持锁期间会调用 get()
_lock = threading.RLock()

_data = {
    "llm_base_url": config.LLM_BASE_URL,
    "llm_api_key": config.LLM_API_KEY,
    "llm_model": config.LLM_MODEL,
    "polish_enabled": config.POLISH_ENABLED,
    "asr_engine": config.ASR_ENGINE,     # whisper / paraformer / sensevoice
    "translate_mode": config.TRANSLATE_MODE,       # local(mlx-lm)/ api
    "local_model_repo": config.LOCAL_MODEL_REPO,   # 本地翻译模型 HF 仓库
    "obsidian_path": "",                           # Obsidian 知识库根目录(留空则用 ~/Obsidian)
    "obsidian_sections": "transcript,notes,ai,chat",  # 导出内容:逗号分隔
    "essay_prompt": "",                            # AI 随笔生成提示词(留空用默认)
}


def _apply():
    """把当前设置写回 config,让 llm.py / tasks.py 立即生效。"""
    config.LLM_BASE_URL = _data["llm_base_url"]
    config.LLM_API_KEY = _data["llm_api_key"]
    config.LLM_MODEL = _data["llm_model"]
    config.POLISH_ENABLED = bool(_data["polish_enabled"])
    config.ASR_ENGINE = _data["asr_engine"]
    config.TRANSLATE_MODE = _data["translate_mode"]
    config.LOCAL_MODEL_REPO = _data["local_model_repo"]
    config.ESSAY_PROMPT = _data["essay_prompt"].strip() or config.ESSAY_PROMPT_DEFAULT


def _load():
    if SETTINGS_FILE.exists():
        try:
            saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            for k in _data:
                if k in saved and saved[k] not in (None, ""):
                    _data[k] = saved[k]
        except json.JSONDecodeError:
            pass
    _apply()


def get(mask_key: bool = True) -> dict:
    with _lock:
        out = dict(_data)
        key = out.get("llm_api_key", "")
        out["has_key"] = bool(key)
        out["llm_api_key_masked"] = (
            key[:6] + "…" + key[-4:] if len(key) > 12 else ("****" if key else "")
        )
        if mask_key:
            out.pop("llm_api_key", None)
        return out


def update(patch: dict) -> dict:
    """空字符串 = 不修改该项;API Key 留空保留原值(避免掩码被存回去)。"""
    with _lock:
        for k in ("llm_base_url", "llm_model"):
            v = patch.get(k)
            if v is not None:          # "" = 清空(跟随全局);未传 = 不修改
                _data[k] = v.strip()
        eng = patch.get("asr_engine")
        if eng in ("whisper", "paraformer", "sensevoice"):
            _data["asr_engine"] = eng
        tm = patch.get("translate_mode")
        if tm in ("local", "api"):
            _data["translate_mode"] = tm
        repo = (patch.get("local_model_repo") or "").strip()
        if repo:
            _data["local_model_repo"] = repo
        obs_path = (patch.get("obsidian_path") or "").strip()
        if obs_path is not None:
            _data["obsidian_path"] = obs_path
        sections = patch.get("obsidian_sections")
        if sections is not None:
            _data["obsidian_sections"] = str(sections).strip() or "transcript,notes,ai,chat"
        if patch.get("polish_enabled") is not None:
            _data["polish_enabled"] = bool(patch["polish_enabled"])
        if "essay_prompt" in patch:
            _data["essay_prompt"] = (patch["essay_prompt"] or "").strip()
        for kk in ("llm_api_key",):
            v = patch.get(kk)
            if v and v.strip():
                _data[kk] = v.strip()
        if patch.get("clear_llm_api_key"):      # 显式清除已保存的 Key(留空=保留)
            _data["llm_api_key"] = ""
        SETTINGS_FILE.write_text(
            json.dumps(_data, ensure_ascii=False, indent=1), encoding="utf-8")
        _apply()
        return get()


_load()
