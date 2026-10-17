"""SQLite 元数据存储:任务 / 档案夹 / 执行记录。

大文本与媒体仍保留在 data/ 下的文件里;这里只存结构化状态。
单文件、事务写入,替代原先三份 JSON + 自定义落盘逻辑。
"""
import json
import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from . import config

log = logging.getLogger("tingwu")

_TABLES = ("tasks", "folders", "history")


@contextmanager
def _db():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(config.DB_FILE, timeout=10)
    try:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        yield c
        c.commit()
    finally:
        c.close()


def init():
    with _db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )


def _load(table: str) -> list[dict]:
    with _db() as c:
        rows = c.execute(f"SELECT data FROM {table}").fetchall()
    out = []
    for (raw,) in rows:
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _save(table: str, items: list[dict]):
    rows = [(str(x.get("id") or ""), json.dumps(x, ensure_ascii=False)) for x in items]
    with _db() as c:
        c.execute(f"DELETE FROM {table}")
        c.executemany(f"INSERT INTO {table}(id, data) VALUES(?, ?)", rows)


def load_tasks() -> dict[str, dict]:
    return {t["id"]: t for t in _load("tasks") if t.get("id")}


def save_tasks(tasks: dict[str, dict]):
    _save("tasks", list(tasks.values()))


def load_folders() -> list[dict]:
    return _load("folders")


def save_folders(folders: list[dict]):
    _save("folders", folders)


def load_history() -> list[dict]:
    return _load("history")


def save_history(items: list[dict]):
    _save("history", items)


def get_meta(key: str) -> str | None:
    with _db() as c:
        row = c.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def set_meta(key: str, value: str):
    with _db() as c:
        c.execute("INSERT INTO meta(key, value) VALUES(?, ?) "
                  "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def migrate_json_state(legacy: dict[str, Path]) -> bool:
    """首次启动:把旧 JSON 状态导入 SQLite,原文件移到 data/backup/json-v1/。"""
    init()
    with _db() as c:
        has_rows = any(
            c.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()
            for table in _TABLES
        )
    if has_rows:
        return False
    imported = False
    for table, path in legacy.items():
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            log.warning("读取旧状态失败 %s: %s", path.name, e)
            continue
        if table == "tasks":
            rows = list(data.values()) if isinstance(data, dict) else data
        elif table == "folders":
            rows = data if isinstance(data, list) else list(data.values())
        else:
            rows = data if isinstance(data, list) else []
        if rows:
            _save(table, rows)
            imported = True
    if imported:
        backup = config.DATA_DIR / "backup" / "json-v1"
        backup.mkdir(parents=True, exist_ok=True)
        for path in legacy.values():
            if path.exists():
                try:
                    path.replace(backup / path.name)
                except OSError:
                    log.warning("备份旧状态失败 %s", path.name)
    return imported
