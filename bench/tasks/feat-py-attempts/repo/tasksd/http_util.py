"""JSON request and response helpers for http.server handlers.

Responses are UTF-8 JSON. Non-ASCII text is sent as raw UTF-8, not as \\u escapes.
"""

import json
from typing import Any, Dict, Optional

MAX_BODY = 1 << 20


class BadRequest(ValueError):
    pass


def json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def send_json(handler, status: int, obj: Any, headers: Optional[Dict[str, str]] = None) -> None:
    body = json_bytes(obj)
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    for name, value in (headers or {}).items():
        handler.send_header(name, value)
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)


def send_error_json(handler, status: int, message: str) -> None:
    send_json(handler, status, {"error": message})


def read_json(handler) -> Any:
    length = handler.headers.get("Content-Length")
    if length is None:
        raise BadRequest("Content-Length is required")
    try:
        n = int(length)
    except ValueError:
        raise BadRequest("bad Content-Length") from None
    if n < 0 or n > MAX_BODY:
        raise BadRequest("body too large")
    raw = handler.rfile.read(n)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BadRequest("body is not valid JSON") from None
