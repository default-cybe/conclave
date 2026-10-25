## [0.4.29] - 2026-10-25

### Changed

- Updates install by themselves when nothing is running. "Install updates automatically" is now on unless you turned it off (a saved `updates.auto: false` stays off), and `updates.window` picks when: `idle` (default) looks for a release every hour and installs once nothing ran on two checks in a row (10 minutes apart); `night` keeps 03:00 to 05:00, now also waiting for nothing to run.
- "Nothing running" means no session running or waiting for an approval or an answer, no background task, no queued message waiting to be sent, no workflow run running or queued and no routine run going. A session parked for a usage limit does not count: its resume job is stored and survives the restart.
- Device daemons update in the same window, each only when no session or task works on that device, before the hub restarts.
- Update now refuses while work runs (409, "2 sessions running: ..."). Settings > About then offers Update anyway and Update when idle, a one-shot that installs that version once nothing runs, also with automatic updates off.
- Android app updates: the app looks for an update at every start and, when it comes back, once an hour (was once a day). After you allow Conclave to install apps, the installer opens by itself, and a download checked earlier asks "Install now" at the next start. Skip this version and Don't show at startup work as before.

### Added

- Run in a worktree: a Code session in any git folder, on any device, can get its own worktree on a new `conclave/` branch from the folder's current branch, so several agents work on one repository without clashing. The session's header shows the branch, commits ahead and uncommitted files, with Merge into the base (refused while either checkout has uncommitted changes or the merge conflicts; squash optional), Open pull request when the origin is on GitHub and GitHub is connected, Discard (asks first) and Clean up after the merge. In the web "+" menu and phone options, and on Android. Workflow worktrees now use the same code to make and merge worktrees.