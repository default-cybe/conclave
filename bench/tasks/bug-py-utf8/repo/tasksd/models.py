"""Task records and input validation."""

from dataclasses import dataclass, field
from typing import Any, Optional

STATUSES = ("queued", "running", "done", "failed")
NEW_TASK_FIELDS = ("title", "payload", "max_attempts")
MAX_TITLE = 200


class ValidationError(ValueError):
    """Bad input from a client. The message is shown to the client."""


@dataclass
class Task:
    id: int
    title: str
    payload: dict = field(default_factory=dict)
    status: str = "queued"
    attempts: int = 0
    max_attempts: int = 3
    created_at: int = 0  # unix seconds
    next_run_at_ms: int = 0
    last_error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "payload": self.payload,
            "status": self.status,
            "attempts": self.attempts,
            "max_attempts": self.max_attempts,
            "created_at": self.created_at,
            "next_run_at_ms": self.next_run_at_ms,
            "last_error": self.last_error,
        }

    def waiting_for_retry(self, now_ms: int) -> bool:
        return self.status == "queued" and self.attempts > 0 and self.next_run_at_ms > now_ms


@dataclass
class Attempt:
    task_id: int
    n: int
    started_at_ms: int
    finished_at_ms: int
    ok: bool
    error: Optional[str] = None


def validate_new_task(data: Any) -> tuple:
    """Check a POST /tasks body. Returns (title, payload, max_attempts)."""
    if not isinstance(data, dict):
        raise ValidationError("body must be a JSON object")
    for key in data:
        if key not in NEW_TASK_FIELDS:
            raise ValidationError(f"unknown field: {key}")
    title = data.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValidationError("title is required")
    if len(title) > MAX_TITLE:
        raise ValidationError(f"title is longer than {MAX_TITLE} characters")
    payload = data.get("payload", {})
    if not isinstance(payload, dict):
        raise ValidationError("payload must be an object")
    max_attempts = data.get("max_attempts", 3)
    if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or not 1 <= max_attempts <= 20:
        raise ValidationError("max_attempts must be an integer from 1 to 20")
    return title.strip(), payload, max_attempts
