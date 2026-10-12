"""公共工具函数——消除各模块间的重复代码。"""
from __future__ import annotations

import json
from pathlib import Path


def fmt_ts(sec: float, force_hour: bool = False) -> str:
    """秒数 → 时间戳字符串 mm:ss 或 hh:mm:ss。"""
    sec = int(max(0, sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h or force_hour else f"{m:02d}:{s:02d}"


def ts_to_seconds(ts: str) -> float:
    """时间戳字符串 → 秒。支持 m:ss / h:mm:ss / mm:ss。"""
    parts = [float(p) for p in str(ts).split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, s = parts[-3:]
    return h * 3600 + m * 60 + s


def load_json(path: Path) -> dict | list | None:
    """读取 JSON 文件,不存在或格式错误返回 None。"""
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def save_json(path: Path, data) -> None:
    """原子写入 JSON:先写临时文件再 rename,避免写到一半崩溃导致文件损坏。"""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)
