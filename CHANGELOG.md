## [0.4.29] - 2026-10-25

### Changed

- Updates install by themselves when nothing is running. "Install updates automatically" is now on unless you turned it off (a saved `updates.auto: false` stays off), and `updates.window` picks when: `idle` (default) looks for a release every hour and installs once nothing ran on two checks in a row (10 minutes apart); `night` keeps 03:00 to 05:00, now also waiting for nothing to run.
- "Nothing running" means no session running or waiting for an approval or an answer, no background task, no queued message waiting to be sent, no workflow run running or queued and no routine run going. A session parked for a usage limit does not count: its resume job is stored and survives the restart.
- Device daemons update in the same window, each only when no session or task works on that device, before the hub restarts.
- Update now refuses while work runs (409, "2 sessions running: ..."). Settings > About then offers Update anyway and Update when idle, a one-shot that installs that version once nothing runs, also with automatic updates off.
- Android app updates: the app looks for an update at every start and, when it comes back, once an hour (was once a day). After you allow Conclave to install apps, the installer opens by itself, and a download checked earlier asks "Install now" at the next start. Skip this version and Don't show at startup work as before.

### Added

- Setup step 4, "Make Conclave better": install recommended extension packs in one go (Starter on by default; Security and CTF, Homelab, Study, Google and Microsoft optional). One form asks for every key the chosen extensions need, then each one installs through the Discover routes with a row per extension. Extensions without a key or a program the hub lacks are skipped with the reason, and running setup again skips what is installed. Members never see setup.