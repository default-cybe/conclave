"""Opaque paging cursors for GET /tasks.

A cursor marks where the next page starts. Clients must treat it as an
opaque string.
"""

import base64
import binascii


def encode_cursor(created_at: int) -> str:
    return base64.urlsafe_b64encode(str(int(created_at)).encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> int:
    """Return created_at. Raises ValueError for anything that is not a cursor."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        text = base64.urlsafe_b64decode(padded.encode()).decode()
    except (binascii.Error, ValueError, UnicodeDecodeError) as e:
        raise ValueError("bad cursor") from e
    if not text.isdigit():
        raise ValueError("bad cursor")
    return int(text)
