"""Opaque paging cursors for GET /tasks.

A cursor marks the last task of a page by its sort key (created_at, id).
Clients must treat it as an opaque string.
"""

import base64
import binascii
import json


def encode_cursor(created_at: int, task_id: int) -> str:
    raw = json.dumps([int(created_at), int(task_id)], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple:
    """Return (created_at, id). Raises ValueError for anything that is not a cursor."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (binascii.Error, ValueError, UnicodeDecodeError) as e:
        raise ValueError("bad cursor") from e
    if not (isinstance(value, list) and len(value) == 2 and all(isinstance(v, int) for v in value)):
        raise ValueError("bad cursor")
    return value[0], value[1]
