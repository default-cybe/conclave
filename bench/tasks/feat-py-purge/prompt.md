Add `--dry-run` to `tasksd purge --older-than <dur>`.

- `--older-than` accepts `30m` (minutes), `12h` (hours), `7d` (days), and a bare integer as days, which is today's form.
- With `--dry-run`, print `would delete <n> tasks`, then one line `<id> <created_at ISO>` per task, oldest first, and delete nothing. The time is `datetime.fromtimestamp(created_at, tz=timezone.utc).isoformat()`, for example `2026-02-20T00:00:00+00:00`.
- Without `--dry-run` it works as today and prints `deleted <n> tasks`.
- A bad duration exits with code 2 and a message on stderr.
- Update the help text and the README.
