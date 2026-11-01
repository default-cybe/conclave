"""Runs due tasks. A handler is picked by payload["kind"] (default "default")."""

from typing import Callable, Dict, Optional

from . import backoff
from .clock import Clock
from .models import Task
from .store import Store

Handler = Callable[[Task], None]


class Worker:
    def __init__(self, store: Store, handlers: Dict[str, Handler], clock: Optional[Clock] = None):
        self.store = store
        self.handlers = handlers
        self.clock = clock or store.clock

    def run_task(self, task: Task) -> bool:
        if not self.store.claim(task.id):
            return False
        n = task.attempts + 1
        started = self.clock.now_ms()
        kind = task.payload.get("kind", "default")
        handler = self.handlers.get(kind)
        try:
            if handler is None:
                raise LookupError(f"no handler for kind {kind!r}")
            handler(task)
            ok, error = True, None
        except Exception as e:  # a failing handler must not stop the worker
            ok, error = False, f"{type(e).__name__}: {e}"
        finished = self.clock.now_ms()
        self.store.record_attempt(task.id, n, started, finished, ok, error)
        if ok:
            self.store.finish(task.id, "done", n)
        elif n >= task.max_attempts:
            self.store.finish(task.id, "failed", n, error)
        else:
            retry_at = finished + backoff.delay(n) * 1000
            self.store.reschedule(task.id, n, int(retry_at), error)
        return True

    def run_once(self, limit: int = 10) -> int:
        """Run the tasks that are due now. Returns how many ran."""
        ran = 0
        for task in self.store.due(self.clock.now_ms(), limit):
            if self.run_task(task):
                ran += 1
        return ran
