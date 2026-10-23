"""SQLite storage for tasks and their attempts."""

import json
import sqlite3
import threading
from typing import List, Optional

from .clock import Clock
from .models import Task

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    created_at INTEGER NOT NULL,
    next_run_at_ms INTEGER NOT NULL,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS tasks_by_created ON tasks (created_at, id);
CREATE INDEX IF NOT EXISTS tasks_by_due ON tasks (status, next_run_at_ms);
CREATE TABLE IF NOT EXISTS attempts (
    task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    PRIMARY KEY (task_id, n)
);
"""

COLUMNS = "id, title, payload, status, attempts, max_attempts, created_at, next_run_at_ms, last_error"


def _task(row) -> Task:
    return Task(
        id=row[0],
        title=row[1],
        payload=json.loads(row[2]),
        status=row[3],
        attempts=row[4],
        max_attempts=row[5],
        created_at=row[6],
        next_run_at_ms=row[7],
        last_error=row[8],
    )


class Store:
    def __init__(self, path: str = ":memory:", clock: Optional[Clock] = None):
        self.clock = clock or Clock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA foreign_keys = ON")
            self._db.executescript(SCHEMA)

    def close(self) -> None:
        self._db.close()

    def _query(self, sql: str, args=()) -> list:
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    def _write(self, sql: str, args=()) -> sqlite3.Cursor:
        with self._lock, self._db:
            return self._db.execute(sql, args)

    def add(self, title: str, payload: Optional[dict] = None, max_attempts: int = 3, created_at: Optional[int] = None) -> Task:
        created = self.clock.now_s() if created_at is None else int(created_at)
        cur = self._write(
            "INSERT INTO tasks (title, payload, max_attempts, created_at, next_run_at_ms) VALUES (?, ?, ?, ?, ?)",
            (title, json.dumps(payload or {}), max_attempts, created, self.clock.now_ms()),
        )
        return self.get(cur.lastrowid)

    def get(self, task_id: int) -> Optional[Task]:
        rows = self._query(f"SELECT {COLUMNS} FROM tasks WHERE id = ?", (task_id,))
        return _task(rows[0]) if rows else None

    def count(self) -> int:
        return self._query("SELECT COUNT(*) FROM tasks")[0][0]

    def list_tasks(self, limit: int, after_created_at: Optional[int] = None) -> List[Task]:
        """Tasks oldest first, starting at `after_created_at` when given."""
        if after_created_at is None:
            rows = self._query(f"SELECT {COLUMNS} FROM tasks ORDER BY created_at LIMIT ?", (limit,))
        else:
            rows = self._query(f"SELECT {COLUMNS} FROM tasks WHERE created_at >= ? ORDER BY created_at LIMIT ?", (after_created_at, limit))
        return [_task(r) for r in rows]

    def due(self, now_ms: int, limit: int = 10) -> List[Task]:
        rows = self._query(
            f"SELECT {COLUMNS} FROM tasks WHERE status = 'queued' AND next_run_at_ms <= ? ORDER BY next_run_at_ms, id LIMIT ?",
            (now_ms, limit),
        )
        return [_task(r) for r in rows]

    def claim(self, task_id: int) -> bool:
        cur = self._write("UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'queued'", (task_id,))
        return cur.rowcount == 1

    def finish(self, task_id: int, status: str, attempts: int, error: Optional[str] = None) -> None:
        self._write("UPDATE tasks SET status = ?, attempts = ?, last_error = ? WHERE id = ?", (status, attempts, error, task_id))

    def reschedule(self, task_id: int, attempts: int, next_run_at_ms: int, error: Optional[str]) -> None:
        self._write(
            "UPDATE tasks SET status = 'queued', attempts = ?, next_run_at_ms = ?, last_error = ? WHERE id = ?",
            (attempts, int(next_run_at_ms), error, task_id),
        )

    def retry_now(self, task_id: int) -> Optional[Task]:
        self._write("UPDATE tasks SET status = 'queued', next_run_at_ms = ? WHERE id = ?", (self.clock.now_ms(), task_id))
        return self.get(task_id)

    def record_attempt(self, task_id: int, n: int, started_at_ms: int, finished_at_ms: int, ok: bool, error: Optional[str] = None) -> None:
        self._write(
            "INSERT INTO attempts (task_id, n, started_at_ms, finished_at_ms, ok, error) VALUES (?, ?, ?, ?, ?, ?)",
            (task_id, n, int(started_at_ms), int(finished_at_ms), 1 if ok else 0, error),
        )

    def delete(self, task_id: int) -> bool:
        return self._write("DELETE FROM tasks WHERE id = ?", (task_id,)).rowcount == 1

    def older_than(self, cutoff_s: int) -> List[Task]:
        rows = self._query(f"SELECT {COLUMNS} FROM tasks WHERE created_at < ? ORDER BY created_at, id", (cutoff_s,))
        return [_task(r) for r in rows]

    def purge_older_than(self, cutoff_s: int) -> int:
        return self._write("DELETE FROM tasks WHERE created_at < ?", (cutoff_s,)).rowcount
