"""Opaque paging cursors for GET /tasks.

A cursor holds "<created_at>:<id>" of the last task on a page, base64 encoded.
Clients must treat it as an opaque string.
"""

import base64
import binascii
import re

_RAW = re.compile(r"^(\d+):(\d+)$")


def encode_cursor(created_at: int, task_id: int) -> str:
    raw = f"{int(created_at)}:{int(task_id)}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple:
    """Return (created_at, id). Raises ValueError for anything that is not a cursor."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        text = base64.urlsafe_b64decode(padded.encode()).decode("ascii")
    except (binascii.Error, ValueError, UnicodeDecodeError) as e:
        raise ValueError("bad cursor") from e
    m = _RAW.match(text)
    if not m:
        raise ValueError("bad cursor")
    return int(m.group(1)), int(m.group(2))
