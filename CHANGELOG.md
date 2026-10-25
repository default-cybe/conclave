## [0.4.29] - 2026-10-25

### Added

- Move to hub: the session menu's "Move to hub (copy folder)" (and `/move hub --copy`, and the Android session sheet) copies the session's whole project folder from its device to the hub's projects drive, byte for byte with node_modules, build output, `.env` and `.git`, then runs the session there. The folder on the device stays as it was. The copy streams with tar, shows bytes and files as it goes, can be cancelled, removes a partial copy, and refuses up front when the hub has no room.
- Move back to <device>: shows what changed on the hub since the copy (text diffs, size changes for binaries) and marks files that changed on the device too as conflicts. Copy back all, or without conflicts; nothing on the device is deleted unless "Also delete files removed on the hub" is ticked. Then the session runs on the device again.
- `projects.hubRoot` sets where copies go (Devices, the hub, Projects drive). Default `/srv/conclave-projects` when it is mounted and writable, else `~/conclave-projects`. docs/INSTALL.md shows how to bind-mount a big drive into the hub's LXC.