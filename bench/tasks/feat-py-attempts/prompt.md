Add `GET /tasks/{id}/attempts` to the HTTP API.

- Response: `{"task_id": <id>, "attempts": [{"n", "started_at", "finished_at", "ok", "error"}]}`, newest attempt first.
- `n` is the attempt number. `started_at` and `finished_at` are the stored times in milliseconds since the epoch. `ok` is true or false. `error` is the error text or null.
- `?limit=` caps how many attempts come back: default 20, at most 100. A limit that is not a whole number from 1 to 100 is a 400 with the usual error body.
- An unknown task id is a 404 with `{"error": "not found"}`.
- Document the route in the README.
- Add tests.
