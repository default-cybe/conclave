# conclave-daemon: the contract between the desktop app and its daemon

The desktop app carries the device daemon as a Tauri sidecar named
`conclave-daemon`. It is the Rust daemon (`packages/daemon-rs`, see
`DAEMON-RUST.md`), built by `scripts/build-sidecar.ts`. The TypeScript CLI
compiled with `bun build --compile` (`packages/cli/src/daemon-main.ts`) stays
as a fallback: `build-sidecar.ts --impl ts`. Either one replaces the file and
nothing else, so each must do what this page says, byte for byte where JSON is
shown; the conformance suite checks both. The app side is
`packages/desktop/src-tauri/src/computer.rs`.

## The binary

| | |
| --- | --- |
| Name next to the app | `conclave-daemon` (`conclave-daemon.exe` on Windows) |
| Name in the source tree | `packages/desktop/src-tauri/binaries/conclave-daemon-<rust target triple>[.exe]` (Tauri `bundle.externalBin: ["binaries/conclave-daemon"]`) |
| Targets | `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc` (`aarch64-unknown-linux-gnu` builds too, the release does not ship it yet) |
| Windows | a GUI subsystem program: it opens no console window, also when the Run key starts it at sign in. Output still goes to the pipes the app gives it. |
| Where the app runs it from | a copy in the app's local data folder, `<app local data>/daemon/conclave-daemon[.exe]` (Linux `~/.local/share/dev.conclave.desktop/daemon/`, macOS `~/Library/Application Support/dev.conclave.desktop/daemon/`, Windows `%LOCALAPPDATA%\dev.conclave.desktop\daemon\`). The service runs this copy, never the one in the bundle. The app replaces it when the bundled file changes and then runs `install` again. The daemon must not assume any other location for itself: it uses its own path (argv0 resolved, or the OS's current-exe call) in the service it writes. |

## Subcommands the app calls

The app calls only these. Anything else the binary offers is its own business.

### `conclave-daemon --version`

Prints the version (`0.2.0`) and a newline. Exit 0.

### `conclave-daemon status --json`

Prints one line of JSON, exit 0 whenever it could look (also when nothing is
paired or installed):

```json
{"version":"0.2.0","paired":true,"hub":"https://hub.example.com","deviceId":"dev_0mvdhwamxdmjehx0j8z","name":"arch-desktop","installed":true,"running":true}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | string | this binary's version |
| `paired` | bool | a device pairing is saved here |
| `hub` | string or null | the hub address the pairing uses; null when not paired |
| `deviceId` | string or null | the device id on that hub; null when not paired |
| `name` | string or null | the device name it paired with; null when not paired |
| `installed` | bool | the user service is registered (unit file, plist, or Run key value) |
| `running` | bool or null | a daemon runs: the service manager says active, or the pid file names a live process. null when it cannot tell (no session bus for `systemctl --user`) |

All seven keys are always present. More keys may be added; the app ignores
keys it does not know.

### `conclave-daemon pair --hub <url> --app-token-stdin [--name <name>] --json`

Pairs this computer with the hub the app is signed in to, using the app's own
token, so the owner types no second code.

- stdin: the app's token on one line (`ccl_...` client token, or the owner
  token), then end of input. It is never on the command line, where other
  users of the computer could read it.
- `--hub`: the address the app uses, without a trailing slash.
- `--name`: the device name; default the computer's host name.
- Steps:
  1. `GET <hub>/api/devices` with `Authorization: Bearer <app token>`.
     401 means the hub refused the app token: exit 1.
  2. If a pairing is saved and its `deviceId` is in that list, keep it (the
     same device on the same hub). If its saved address differs from `--hub`,
     save `--hub` as its address. Print `kept: true`, exit 0.
  3. If a pairing is saved but not in the list (another hub, or removed on the
     Devices page), unpair it first as `uninstall` does (step 3 there), best
     effort.
  4. `POST <hub>/api/daemon/pairing` with the same bearer token. The reply is
     `{"code":"ABCD-EFGH","expiresAt":<ms>,"addresses":["..."]}`. A 404 means
     the hub is too old: exit 1 with that said.
  5. `POST <hub>/api/daemon/register` with
     `{"code":"ABCD-EFGH","name":"<name>","platform":"linux|darwin|win32"}`.
     The reply is `{"deviceId":"dev_...","token":"cdv_...","addresses":["..."]}`.
     Save it (see Files). A code from step 4 remembers the app: when that app
     already has a device on the hub, the hub gives the same device id with a
     new token.
- Prints one line of JSON, exit 0:

```json
{"paired":true,"hub":"https://hub.example.com","deviceId":"dev_0mvdhwamxdmjehx0j8z","name":"arch-desktop","kept":false}
```

`conclave-daemon pair --hub <url> --code <device code>` also exists (a code
from the Devices page, step 5 only). The app does not use it.

### `conclave-daemon install`

Writes the user service that runs `conclave-daemon run` at login, and starts
it now, or restarts it when it already runs (so a new binary or a changed unit
takes effect). Output is for people; the app looks only at the exit code.
Exit 0 when every step worked, 1 when one failed. Not paired: exit 1.

The service runs the binary at its own path with one argument, `run`
(Windows: `run --log <home>\logs\daemon.log`). Its PATH is the user's login
shell PATH (`$SHELL -l -i -c` printing `$PATH` between markers, 5 second
limit), then the PATH the binary was started with, then these folders when
they exist: `~/.local/bin ~/.bun/bin ~/.cargo/bin ~/.npm-global/bin
~/.volta/bin ~/go/bin`, and on macOS `/opt/homebrew/bin /opt/homebrew/sbin`,
then `/usr/local/bin /usr/bin /bin` and the sbin folders. This is how git,
claude and codex are found when the app was started from a menu with a short
PATH. On Windows the environment of the sign in is used as it is.
`CONCLAVE_HOME`, when set, is passed on.

| OS | What it writes | Start or restart |
| --- | --- | --- |
| Linux | `~/.config/systemd/user/conclave-daemon.service` with `ExecStart=<binary> run`, `Restart=always`, `RestartSec=5`, `Environment=PATH=...`, `WantedBy=default.target`. Values are quoted for systemd and `%` is written `%%`. | `systemctl --user daemon-reload`, `systemctl --user enable conclave-daemon`, `systemctl --user restart conclave-daemon` |
| macOS | `~/Library/LaunchAgents/dev.conclave.daemon.plist`, label `dev.conclave.daemon`, `ProgramArguments` `[<binary>, run]`, `EnvironmentVariables.PATH`, `RunAtLoad`, `KeepAlive`, stdout and stderr to `<home>/logs/daemon.log` | `launchctl bootout gui/<uid>/dev.conclave.daemon` (may fail), then `launchctl bootstrap gui/<uid> <plist>`, tried up to 5 times half a second apart |
| Windows | value `ConclaveDaemon` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`: `<binary> run --log <home>\logs\daemon.log`, each part quoted when it holds a space | stop the daemon the pid file names (only when that process is a conclave one), then start the same command detached and hidden |

`conclave-daemon install --dry-run` prints the file and the commands and
changes nothing.

### `conclave-daemon uninstall --json`

Stops the service and removes it, then unpairs: the hub removes the device and
the saved pairing goes. Exit 0 also when nothing was installed or paired.

1. Linux: `systemctl --user disable --now conclave-daemon` (may fail), remove
   the unit, `systemctl --user daemon-reload`, `systemctl --user reset-failed
   conclave-daemon` (both may fail). macOS: `launchctl bootout
   gui/<uid>/dev.conclave.daemon` (may fail), remove the plist. Windows:
   `reg delete` the Run value (may fail).
2. Stop the daemon the pid file names, on every OS (one started by hand, or by
   the Run key). Wait up to 2 seconds for it to go.
3. `POST <hub>/api/daemon/unpair` with `Authorization: Bearer <device token>`
   and `x-conclave-device: <device id>`, trying the saved address, then the
   saved `addresses` in order, 8 seconds each. 200 means removed. 401 with
   `{"error":"This device is not paired with this hub."}` means the hub did not
   know it any more, which counts as removed. Another 401 means a hub from
   before this route. Then delete the saved pairing, whatever the hub said.

Prints one line of JSON:

```json
{"removed":true,"unpaired":true,"removedOnHub":true,"name":"arch-desktop","deviceId":"dev_0mvdhwamxdmjehx0j8z","error":null}
```

| Field | Meaning |
| --- | --- |
| `removed` | a service was registered and is gone |
| `unpaired` | a pairing was saved and is gone |
| `removedOnHub` | the hub removed the device, or no longer knew it |
| `name`, `deviceId` | the pairing that went, or null |
| `error` | why the hub did not confirm, in words, or null |

`--keep-pairing` skips step 3 (not used by the app). `--dry-run` prints the
commands and changes nothing.

### `conclave-daemon run` (what the service runs)

The daemon itself: dials the hub over `GET <hub>/api/daemon` (WebSocket,
`Authorization: Bearer <device token>`, `x-conclave-device: <device id>`),
protocol in `packages/core/src/machine/protocol.ts`, and reconnects forever,
trying the saved addresses in turn. With no subcommand at all it does the
same. It writes the pid file on start and removes it on a clean stop.
`--log FILE` appends its status lines to FILE instead of stdout.

Its hello says how it updates (protocol 4, `docs/DESIGN.md` 37): a copy in a
folder with `bundled.stamp` (the app's stable copy) says `app`, and the hub
leaves it to the app; the app updates it by replacing the stable copy as
before. A standalone copy run by its service answers the `selfUpdate` RPC:
it replaces its own file (keeping `<file>.prev`), writes
`daemon-update.json` next to `device.json`, and exits so the service starts
the new one. `conclave-daemon rollback` puts `<file>.prev` back; the app does
not call it.

## Exit codes and errors

| Code | Meaning |
| --- | --- |
| 0 | done |
| 1 | failed. stderr has a line `Error: <one sentence a person can read>` |
| 2 | bad usage (unknown subcommand, missing `--hub`, no token on stdin). Same `Error: ` line |

The app shows the text after `Error: ` as it is, so it is a plain sentence
that says what went wrong and, where it can, what to do.

## Files

All under `CONCLAVE_HOME`, default `~/.conclave` (`%USERPROFILE%\.conclave`
on Windows). The `conclave daemon` CLI from the install script uses the same
files and the same service name, so a computer has one daemon either way.

| File | What |
| --- | --- |
| `device.json` (mode 0600) | `{"hub":"https://...","deviceId":"dev_...","token":"cdv_...","name":"arch-desktop","savedAt":<ms>,"addresses":["..."]}`. `addresses` is optional, best first; the daemon updates it when the hub sends new ones |
| `daemon.pid` | `{"pid":1234,"startedAt":<ms>,"version":"0.2.0"}` |
| `logs/daemon.log` | status lines (macOS and Windows; Linux uses the journal) |

The app keeps its own state in its config folder (`settings.json`, with
`"computer": true` when the switch is on) and the stamp of the bundled binary
next to the stable copy (`bundled.stamp`). The daemon never reads either.
