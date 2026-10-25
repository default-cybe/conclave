## [0.4.29] - 2026-10-25

### Added

- A notification when the hub updated itself, rolled back or failed, with the old and new version (Settings > Notifications, Updates).
- Desktop app: updates install by themselves (Settings > Install updates automatically, on by default). The app checks at start and every 15 minutes, and installs once two checks in a row find the window not in use and the hub on this computer with no session running or waiting for an approval. A hub elsewhere does not hold the update back.
- Desktop app: an update that cannot install for lack of permission (a macOS app the user cannot write, a Windows install for all users) shows one notification, "Conclave X is ready. Click to update.", and keeps the tray item. A version that failed is not tried again by itself until a newer one comes out.
- Usage fallback (Settings > Models > Usage fallback, `models.limitFallback: { enabled, models }`): an ordered list of models, separate from Refusal fallback. When a model is at its limit on every account, the next model after it on the list takes over, on the first ready plan or key of its own account order. A model not on the list starts from the top. Chores use the same list.
- Off or empty, a limit falls back on the Refusal fallback list as before. An agent with the refusal fallback off still gets no other model.
- Window starter for the Z.ai Coding Plan: one tiny request on the cheapest GLM (Flash, then Air) right after each 5 hour reset, sent on the zai provider with its key, inside the owner's starter hours. Its quota is read again around the reset.

### Changed

- Updates install by themselves when nothing is running. "Install updates automatically" is now on unless you turned it off (a saved `updates.auto: false` stays off), and `updates.window` picks when: `idle` (default) looks for a release every hour and installs once nothing ran on two checks in a row (10 minutes apart); `night` keeps 03:00 to 05:00, now also waiting for nothing to run.
- "Nothing running" means no session running or waiting for an approval or an answer, no background task, no queued message waiting to be sent, no workflow run running or queued and no routine run going. A session parked for a usage limit does not count: its resume job is stored and survives the restart.
- Device daemons update in the same window, each only when no session or task works on that device, before the hub restarts.
- Update now refuses while work runs (409, "2 sessions running: ..."). Settings > About then offers Update anyway and Update when idle, a one-shot that installs that version once nothing runs, also with automatic updates off.
- Android app updates: the app looks for an update at every start and, when it comes back, once an hour (was once a day). After you allow Conclave to install apps, the installer opens by itself, and a download checked earlier asks "Install now" at the next start. Skip this version and Don't show at startup work as before.

### Fixed

- A shared file card failed with "Could not get the file. unknown session ..." when its turn also asked a question or ran a long call: the hub stores a step's results only once every call in it is done, and the download looked only there. It now also finds the result in the running step, so Open and Save work as soon as the card shows, on Android and the web.