"""The HTTP API. See README.md for the routes."""

import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import parse_qs, urlsplit

from . import backoff
from .clock import Clock
from .cursor import decode_cursor, encode_cursor
from .http_util import BadRequest, read_json, send_error_json, send_json
from .models import ValidationError, validate_new_task
from .store import Store

DEFAULT_LIMIT = 50
MAX_LIMIT = 200

TASK_PATH = re.compile(r"^/tasks/(\d+)$")
RETRY_PATH = re.compile(r"^/tasks/(\d+)/retry$")
ATTEMPTS_PATH = re.compile(r"^/tasks/(?P<id>\d+)/attempts/?$")


def parse_limit(value: Optional[str], default: int, maximum: int) -> int:
    if value is None:
        return default
    if not value.isdigit():
        raise BadRequest("limit must be a positive integer")
    n = int(value)
    if not 1 <= n <= maximum:
        raise BadRequest(f"limit must be from 1 to {maximum}")
    return n


def make_handler(store: Store, clock: Clock):
    class Handler(BaseHTTPRequestHandler):
        server_version = "tasksd"

        def log_message(self, format, *args):  # keep test output quiet
            pass

        def _route(self, method: str) -> None:
            url = urlsplit(self.path)
            query = {k: v[-1] for k, v in parse_qs(url.query).items()}
            try:
                if method == "GET" and url.path == "/health":
                    return send_json(self, 200, {"ok": True})
                if method == "GET" and url.path == "/tasks":
                    return self.list_tasks(query)
                if method == "POST" and url.path == "/tasks":
                    return self.create_task()
                m = TASK_PATH.match(url.path)
                if m and method == "GET":
                    return self.get_task(int(m.group(1)))
                if m and method == "DELETE":
                    return self.delete_task(int(m.group(1)))
                m = ATTEMPTS_PATH.match(url.path)
                if m and method == "GET":
                    return self.attempts(int(m.group("id")), query.get("limit"))
                m = RETRY_PATH.match(url.path)
                if m and method == "POST":
                    return self.retry_task(int(m.group(1)))
                return send_error_json(self, 404, "not found")
            except (BadRequest, ValidationError) as e:
                return send_error_json(self, 400, str(e))

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

        def do_DELETE(self):
            self._route("DELETE")

        def list_tasks(self, query: dict) -> None:
            limit = parse_limit(query.get("limit"), DEFAULT_LIMIT, MAX_LIMIT)
            after = None
            if query.get("cursor"):
                try:
                    after = decode_cursor(query["cursor"])
                except ValueError:
                    raise BadRequest("bad cursor") from None
            rows = store.list_tasks(limit + 1, after)
            page = rows[:limit]
            next_cursor = encode_cursor(page[-1].created_at, page[-1].id) if len(rows) > limit else None
            send_json(self, 200, {"tasks": [t.to_dict() for t in page], "next_cursor": next_cursor})

        def attempts(self, task_id: int, raw_limit) -> None:
            limit = 20
            if raw_limit is not None:
                try:
                    limit = int(raw_limit, 10)
                except ValueError:
                    raise BadRequest("limit must be a whole number") from None
                if limit < 1 or limit > 100:
                    raise BadRequest("limit must be from 1 to 100")
            if store.get(task_id) is None:
                return send_error_json(self, 404, "not found")
            rows = sorted(store.all_attempts(task_id), key=lambda a: (a.started_at_ms, a.n), reverse=True)[:limit]
            send_json(self, 200, {"task_id": task_id, "attempts": [
                {"n": a.n, "started_at": a.started_at_ms, "finished_at": a.finished_at_ms, "ok": bool(a.ok), "error": a.error} for a in rows
            ]})

        def create_task(self) -> None:
            title, payload, max_attempts = validate_new_task(read_json(self))
            task = store.add(title, payload, max_attempts)
            send_json(self, 201, task.to_dict(), {"Location": f"/tasks/{task.id}"})

        def get_task(self, task_id: int) -> None:
            task = store.get(task_id)
            if task is None:
                return send_error_json(self, 404, "not found")
            headers = {}
            if task.waiting_for_retry(clock.now_ms()):
                # the backoff of the last failed attempt, in whole seconds
                headers["Retry-After"] = str(int(backoff.delay(task.attempts)))
            send_json(self, 200, task.to_dict(), headers)

        def delete_task(self, task_id: int) -> None:
            if not store.delete(task_id):
                return send_error_json(self, 404, "not found")
            send_json(self, 200, {"deleted": task_id})

        def retry_task(self, task_id: int) -> None:
            task = store.get(task_id)
            if task is None:
                return send_error_json(self, 404, "not found")
            if task.status == "running":
                return send_error_json(self, 409, "task is running")
            send_json(self, 200, store.retry_now(task_id).to_dict())

    return Handler


def make_server(store: Store, host: str = "127.0.0.1", port: int = 0, clock: Optional[Clock] = None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(store, clock or store.clock))
    server.daemon_threads = True
    return server


def serve_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return t
