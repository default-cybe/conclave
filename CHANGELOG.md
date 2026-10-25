## [0.4.29] - 2026-10-25

### Changed

- Updates install by themselves when nothing is running. "Install updates automatically" is now on unless you turned it off (a saved `updates.auto: false` stays off), and `updates.window` picks when: `idle` (default) looks for a release every hour and installs once nothing ran on two checks in a row (10 minutes apart); `night` keeps 03:00 to 05:00, now also waiting for nothing to run.
- "Nothing running" means no session running or waiting for an approval or an answer, no background task, no queued message waiting to be sent, no workflow run running or queued and no routine run going. A session parked for a usage limit does not count: its resume job is stored and survives the restart.
- Device daemons update in the same window, each only when no session or task works on that device, before the hub restarts.
- Update now refuses while work runs (409, "2 sessions running: ..."). Settings > About then offers Update anyway and Update when idle, a one-shot that installs that version once nothing runs, also with automatic updates off.
- Android app updates: the app looks for an update at every start and, when it comes back, once an hour (was once a day). After you allow Conclave to install apps, the installer opens by itself, and a download checked earlier asks "Install now" at the next start. Skip this version and Don't show at startup work as before.

### Added

- `POST /api/import/merge-duplicates`: lists Claude Code chats imported into more than one session; `{"apply": true}` keeps the copy with the most messages, points the ledger at it and archives the rest. A dry run by default.

### Fixed

- Claude Code chats copied between machines (claudesync, Syncthing) no longer fail as "ambiguous: two imported sessions match this source". The fingerprint now holds the chat id, so a copy on another device joins its own session and a chat resumed under a new id is its own session. Rows an older import marked ambiguous are matched again.
- A chat that grew in Claude Code by more messages than Conclave added syncs in: the source's messages are appended and Conclave's own turns move to a child session "<title> (Conclave branch)". "Continued in Claude Code on ..." is made only when the Conclave side is longer.
- An imported Claude Code chat's folder is the path on the device that holds the file, taken from its project folder name when the file names another machine's path (`/home/default/CMU` on a Mac becomes `/Users/default/MadX/CMU`).
- Imported chats run on your default model when their tool's harness is off as an engine (the default), instead of refusing every turn with "Claude Code is off". The tool's session id is kept.
- A harness turn in a folder its device does not have asks which device has it, instead of failing with `posix_spawn ... ENOENT`.