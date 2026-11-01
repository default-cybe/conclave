# tasksd

A small job queue with a JSON HTTP API. Python 3 standard library only: `sqlite3` for storage and `http.server` for the API.

```
python3 -m tasksd add "send weekly report"
python3 -m tasksd serve --port 8040
python3 -m tasksd work
python3 -m unittest discover -s tests
```

## Tasks

A task has an id, a title, a JSON payload, a status (`queued`, `running`, `done`, `failed`), an attempt count and a limit (`max_attempts`, default 3). `created_at` is whole seconds since the epoch.

The worker runs tasks that are due. The handler is picked by `payload["kind"]` (default `"default"`). When a handler raises, the attempt is recorded and the task is retried later with exponential backoff: 2 s after the first failure, then 4 s, 8 s and so on, at most 300 s (`tasksd/backoff.py`, all values in seconds). After `max_attempts` failures the task is `failed`.

Every attempt is stored in the `attempts` table with its number `n`, start and end time in milliseconds, whether it worked, and the error text.

## HTTP API

All bodies are JSON. Responses use `Content-Type: application/json; charset=utf-8` and send non-ASCII text as raw UTF-8 (not `\u` escapes). Errors look like `{"error": "<message>"}`.

| Route | What it does |
|---|---|
| `GET /health` | `{"ok": true}` |
| `POST /tasks` | Body `{"title", "payload"?, "max_attempts"?}`. Returns 201 and the task. Unknown fields are a 400. |
| `GET /tasks?limit=&cursor=` | `{"tasks": [...], "next_cursor": "..." or null}`. Oldest first; tasks created in the same second are ordered by id. `limit` is 1 to 200, default 50. Pass `next_cursor` back as `cursor` for the next page. Every task appears exactly once across the pages. |
| `GET /tasks/{id}` | The task, or 404. While a failed task waits for its retry, the response has a `Retry-After` header: the backoff after its last attempt, in whole seconds. |
| `DELETE /tasks/{id}` | `{"deleted": id}`, or 404. |
| `POST /tasks/{id}/retry` | Makes the task due now. 409 while it runs. |

## Command line

- `tasksd add TITLE [--max-attempts N]`
- `tasksd list [--limit N]`
- `tasksd work [--once]`
- `tasksd serve [--host H] [--port P]`
- `tasksd purge --older-than DAYS`: deletes tasks created more than DAYS days ago and prints `deleted <n> tasks`.

`--db FILE` (or `$TASKSD_DB`) picks the SQLite file, default `tasksd.db`.

## Layout

- `tasksd/models.py` task records and input checks
- `tasksd/store.py` SQLite storage
- `tasksd/clock.py` time sources (`FakeClock` for tests)
- `tasksd/backoff.py` retry delays in seconds
- `tasksd/worker.py` runs due tasks
- `tasksd/http_util.py` JSON request and response helpers
- `tasksd/cursor.py` paging cursors
- `tasksd/api.py` HTTP routes
- `tasksd/cli.py` command line
- `tests/` unittest suite
