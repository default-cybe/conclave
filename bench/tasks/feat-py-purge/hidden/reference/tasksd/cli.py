"""Command line: python3 -m tasksd <command>."""

import argparse
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import List, Optional

from .api import make_server
from .clock import Clock
from .store import Store
from .worker import Worker

DAY_S = 86400
DURATION_UNITS = {"m": 60, "h": 3600, "d": DAY_S}


def parse_duration(text: str) -> int:
    """'30m', '12h', '7d' or a bare number of days, in seconds."""
    m = re.fullmatch(r"(\d+)([mhd]?)", text.strip())
    if not m:
        raise argparse.ArgumentTypeError(f"bad duration: {text!r} (use 30m, 12h, 7d or a number of days)")
    return int(m.group(1)) * DURATION_UNITS[m.group(2) or "d"]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="tasksd", description="A small job queue with a JSON HTTP API.")
    p.add_argument("--db", default=os.environ.get("TASKSD_DB", "tasksd.db"), help="SQLite file (default tasksd.db, or $TASKSD_DB)")
    sub = p.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the HTTP API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8040)

    add = sub.add_parser("add", help="queue a task")
    add.add_argument("title")
    add.add_argument("--max-attempts", type=int, default=3)

    ls = sub.add_parser("list", help="list tasks, oldest first")
    ls.add_argument("--limit", type=int, default=50)

    work = sub.add_parser("work", help="run due tasks with the echo handler")
    work.add_argument("--once", action="store_true", help="run one round and exit")

    purge = sub.add_parser("purge", help="delete old tasks")
    purge.add_argument(
        "--older-than", type=parse_duration, required=True, metavar="AGE", help="delete tasks older than AGE: 30m, 12h, 7d, or a number of days"
    )
    purge.add_argument("--dry-run", action="store_true", help="only print what would be deleted")
    return p


def main(argv: Optional[List[str]] = None, *, store: Optional[Store] = None, clock: Optional[Clock] = None, out=None) -> int:
    out = out or sys.stdout
    args = build_parser().parse_args(argv)
    clock = clock or (store.clock if store else Clock())
    store = store or Store(args.db, clock)

    if args.command == "add":
        task = store.add(args.title, {}, args.max_attempts)
        print(task.id, file=out)
        return 0
    if args.command == "list":
        for t in store.list_tasks(args.limit):
            print(f"{t.id}\t{t.status}\t{t.attempts}/{t.max_attempts}\t{t.title}", file=out)
        return 0
    if args.command == "purge":
        cutoff = clock.now_s() - args.older_than
        if args.dry_run:
            old = store.older_than(cutoff)
            print(f"would delete {len(old)} tasks", file=out)
            for t in old:
                print(f"{t.id} {datetime.fromtimestamp(t.created_at, tz=timezone.utc).isoformat()}", file=out)
            return 0
        n = store.purge_older_than(cutoff)
        print(f"deleted {n} tasks", file=out)
        return 0
    if args.command == "work":
        worker = Worker(store, {"default": lambda t: print(f"ran {t.id} {t.title}", file=out)}, clock)
        while True:
            worker.run_once()
            if args.once:
                return 0
            time.sleep(0.5)
    if args.command == "serve":
        server = make_server(store, args.host, args.port, clock)
        print(f"tasksd listening on http://{args.host}:{server.server_address[1]}", file=out)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0
    return 2
