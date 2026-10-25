## [0.4.29] - 2026-10-25

### Changed

- Paused sessions, tasks and workflow runs do not hold up an automatic update.

### Added

- Pause and Resume for background work. Pause lets the tool call in progress finish (one still running after 30 seconds is cut and marked interrupted), then stops before the next model call. The session shows `paused` and stays paused across hub restarts. Resume goes on with the same turn, with no new message. Messages sent meanwhile queue. `POST /api/sessions/:id/pause` and `/resume`.
- Pause and Resume sit next to Stop on each background task (web Details panel, Android task sheet), in the session menu and on the workflow card. Paused rows say "paused" with a pause icon.
- Pausing a workflow run now also pauses its running agents, not only new ones. A run paused when the hub stops stays paused and runs again from its journal on Resume.
- TaskList, TaskWait and TaskResult report a paused task. TaskWait returns on it, so a parent does not wait for work that waits for you.