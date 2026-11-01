# conclave-daemon in Rust

`packages/daemon-rs` is the device daemon as one native binary,
`conclave-daemon`. It does what the TypeScript daemon
(`packages/core/src/machine/daemon.ts` and `local.ts`, run by `conclave
daemon` or `packages/cli/src/daemon-main.ts`) does: it dials out to the hub
over one WebSocket and lets the hub use this computer's files, shells and
coding tools. It runs all the time on every PC and Mac, so it is built to be
small: about 5 MB on disk and about 7 MB of memory while it waits.

The hub needs no change to use it. The only hub change is display: the
Devices page shows which daemon a device runs when the daemon says so.

The desktop app carries this binary as its sidecar. The TypeScript daemon
stays in the tree, works as before, and can still be shipped (see Building).

## Command line

The interface is `docs/design/DAEMON-SIDECAR.md`, the contract with the
desktop app. This binary follows it exactly: the same subcommands, flags,
JSON keys in the same order, exit codes and `Error: ` lines. The conformance
suite runs the contract on both binaries and compares the output.

| Command | What it does |
| --- | --- |
| `conclave-daemon` or `conclave-daemon run [--hub URL] [--name NAME] [--log FILE]` | The daemon. Writes `daemon.pid`, removes it on a clean stop. `--log` appends the status lines to FILE instead of stdout. |
| `pair --hub URL --app-token-stdin [--name NAME] [--json]` | Pairs with the token of an app that is paired already, read from stdin. Keeps a pairing the hub still lists. |
| `pair --hub URL --code CODE [--name NAME] [--json]` | Pairs with a device code from the Devices page. `pair URL CODE` works too. |
| `install [--dry-run] [--hub URL]` | Writes the user service that runs `<this binary> run`, with the login shell's PATH, and starts or restarts it. `--dry-run` prints the unit or plist and the commands. |
| `uninstall [--json] [--keep-pairing] [--dry-run]` | Stops and removes the service, stops a daemon the pid file names, then unpairs. |
| `status [--json]` | One line of JSON: `version`, `paired`, `hub`, `deviceId`, `name`, `installed`, `running`. |
| `unpair [--json]` | Removes this computer from the hub and forgets the pairing; the service stays. Not part of the contract. |
| `--version`, `--help` | The version and the usage. |

Exit codes: 0 done, 1 failed, 2 bad usage. On 1 and 2, stderr has one line,
`Error: <sentence>`.

The version is the one in `packages/cli/package.json` at build time
(`build.rs`), so both daemons of one release report the same version. The
release sets it to the tag; `CONCLAVE_VERSION` overrides it.

## Files

The same as the TypeScript daemon, so a computer paired with one binary runs
the other with no new pairing (tested both ways):

- `$CONCLAVE_HOME`, default `~/.conclave` (`%USERPROFILE%\.conclave` on Windows).
- `device.json`: `hub`, `deviceId`, `token`, `name`, `savedAt`, `addresses`.
  Mode 0600. It is written to a temporary file and renamed, so a crash never
  leaves half a pairing. Keys this binary does not know are kept.
- `daemon.pid`: `{"pid":..,"startedAt":..,"version":".."}`.
- `logs/daemon.log`: status lines on macOS (launchd) and Windows (`--log`).

The service files are the ones `packages/cli/src/service.ts` writes:
`conclave-daemon.service` with `Restart=always`, `dev.conclave.daemon.plist`,
or the `ConclaveDaemon` Run key value. The conformance suite compares both
binaries' `install --dry-run` and `uninstall --dry-run` output, which match
but for the binary they name, and the unit tests check each system's text.
Either binary's `install` replaces the other's.

## How it maps to the TypeScript daemon

| Rust module | TypeScript source | What |
| --- | --- | --- |
| `conn.rs` | `machine/daemon.ts` runDaemon | dial, hello, heartbeat, backoff, addresses |
| `server.rs` | `machine/daemon.ts` MachineServer | RPC dispatch, proc.* and exec.* frames |
| `fsops.rs` | `machine/local.ts` | stat, readdir, readFile, readText, readRange, writeFile, mkdir, remove, rename |
| `paths.rs` | Node `path` (posix and win32), LocalMachine.resolve | resolve, home expansion |
| `procs.rs` | LocalMachine.exec and spawn | process groups, timeouts, head and tail output |
| `env.rs` | isHubSecretEnv, Bun.which | env scrubbing, PATH lookup |
| `search.rs` | LocalMachine.glob and grep | rg, or the built-in search |
| `info.rs` | LocalMachine.info | MachineInfo, CLI versions, capabilities |
| `syncthing.rs` | `machine/syncthing.ts` | config.xml, the local REST API |
| `import/` | `import/wire.ts`, `import/sources.ts`, `import/render.ts`, `importers/*`, `memory/secrets.ts` | importScan, importRead |
| `service.rs` | `packages/cli/src/service.ts` | unit, plist, Run key, login PATH, pid file |
| `cli.rs`, `config.rs` | `packages/cli/src/daemon-main.ts`, `commands/daemon.ts`, `files.ts` | the command line, device.json |
| `js.rs` | JavaScript itself | UTF-16 lengths, `trim`, `String()`, `JSON.stringify`, `Date.parse`, TextDecoder |

### Wire

- `GET <hub>/api/daemon?deviceId=<id>`, upgraded to a WebSocket, with
  `Authorization: Bearer <device token>` and `x-conclave-device: <id>`. The
  token is never in the URL or on a command line.
- `hello` with protocol version 2, the device id, the name and MachineInfo.
  The hub accepts versions 1 to 2, so nothing changes there. MachineInfo
  carries one more field, `daemon: { impl: "rust", version }`; the hub keeps
  it and shows it on the Devices page.
- Every RPC the TypeScript daemon serves: info, stat, readdir, readFile,
  readText, readRange, writeFile, mkdir, remove, rename, resolve, glob, grep,
  exec (with exec.output and exec.abort), spawn (with proc.stdin, proc.kill,
  proc.stdout, proc.stderr, proc.exit), syncthingFolders, syncthingStatus,
  importScan and importRead. An unknown method answers `unknown method <name>`.
- `ping` every 20 seconds, `pong` to the hub's pings, and a close with 4008
  after 60 seconds of silence.
- Reconnect forever: the delay is `min(30 s, 1 s * 2^attempt)`, half of it
  fixed and half random, reset by `welcome`. Each failure moves to the next
  saved address. A close with 4000 (another daemon took over) waits as after
  16 failures. `addresses` from the hub are saved to `device.json` and a
  dropped address makes it move at once, with the same rules for loopback and
  quick tunnel addresses.

### Errors

Errors carry Node's codes and texts, for example
`ENOENT: no such file or directory, open '/x'`, `EISDIR: illegal operation on a
directory, read`, `ERR_FS_EISDIR` for a folder removed without `recursive`,
and Bun's spawn texts (`Executable not found in $PATH: "x"`,
`EACCES: permission denied, posix_spawn '/x'`). Tools that branch on `code`
or show `message` behave the same with either daemon.

### Processes

- exec runs `bash -c` (or `sh`, or `cmd.exe /d /s /c` on Windows when there is
  no bash), as LocalMachine does. spawn runs the program itself with its
  arguments, with no shell.
- Each child starts its own session and process group (`setsid`), so a
  timeout, an abort or a kill reaches everything it started. A timeout or an
  abort sends SIGTERM to the group, then SIGKILL after 3 seconds. After the
  main process exits, exec reads the pipes for at most 500 ms more, so a
  background child cannot hold the result.
- exec keeps at most 8 MB per stream (or `maxOutputBytes`), counted in UTF-16
  units like the TypeScript buffer: the first half and the last half, with
  `[... N characters of output dropped ...]` between.
- spawn output goes out as it comes, base64, and `proc.exit` follows the last
  of it. The outgoing queue is bounded, so a process that prints faster than
  the network waits instead of filling memory.
- When the connection drops, its processes get SIGTERM and its execs are
  aborted. When the daemon stops, every process group it started gets SIGTERM,
  then SIGKILL.

### Safety

- Shells, hooks and tools never get the hub's secrets: the same 16 names as
  isHubSecretEnv, any other `CONCLAVE_` name with TOKEN, KEY, SECRET or
  PASSWORD in it, and `CONCLAVE_PASS_ENV` lets named ones through. Values a
  caller passes in `env` still go through.
- `install` captures the PATH the same way: the login shell's PATH, then the
  current one without an AppImage mount, then the usual tool folders that
  exist.
- The app token comes on stdin only. `device.json` is 0600.

### Search

With `rg` on PATH, glob and grep run it with exactly the arguments
LocalMachine uses, so the results are the same. Without it (or with
`CONCLAVE_DAEMON_SEARCH=builtin`) they run in the process with ripgrep's own
crates: `ignore` for the walk and the ignore files, `globset` for globs and
file types, `grep-regex`, `grep-searcher` and `grep-printer` for matching and
output. The output format is rg's: `path:line:text`, `path-line-text` for
context, `--` between groups, `path:count`, newest first for files, long lines
cut at 500 columns, binary files skipped or reported. The conformance suite
checks the built-in search against rg.

### Chat import

importScan and importRead run the readers on this disk and send compact rows,
as a version 2 TypeScript daemon does. The Claude Code, Codex and Gemini CLI
readers, the row summary, the fingerprint, the token estimate and the secret
redaction are ported line by line. JavaScript's own rules are kept where they
change a result: lengths in UTF-16 units, JavaScript whitespace, `Date.parse`
for ISO dates (local time without an offset), `JSON.stringify` number
formatting, object key order, and `\b`, `\d`, `\s` as JavaScript reads them in
the secret patterns. `.zst` rollouts are read with ruzstd. The suite compares
full converted sessions and scan rows from both daemons.

## Runtime and size

- tokio on one thread, with its blocking pool for file work, search and
  import. A connected daemon that waits has 1 or 2 threads.
- rustls with ring and Mozilla's roots (as Bun bundles them), plus PEM files
  in `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE`.
- The release profile has `lto`, `codegen-units = 1`, `strip` and
  `opt-level = "s"`. `panic` stays `unwind`: a bug that panics on one strange
  request (a transcript, say) then fails that request only, instead of
  killing the connection and every process the hub started.

Measured on Linux x64 (release build, connected to a hub, idle):

| | Rust | TypeScript (bun) |
| --- | --- | --- |
| Binary | 4.9 MB | 81 MB compiled with `bun build --compile` (the bun runtime is inside) |
| Memory while idle | 6.6 MB RSS (1.1 MB anonymous); 7.2 MB after some requests, 11 MB peak while it collects info | 40 MB RSS |
| Threads while idle | 1 | 9 |

## Building

```sh
cd packages/daemon-rs
cargo build --release            # target/release/conclave-daemon
cargo test                       # unit tests
# type-check other systems from Linux (ring's C needs their toolchain, so TLS is left out)
cargo check --no-default-features --target x86_64-pc-windows-msvc
```

`bun scripts/build-sidecar.ts [--target <triple>]` builds this binary into
`packages/desktop/src-tauri/binaries/conclave-daemon-<triple>` for the
desktop app. `--impl ts` (or `CONCLAVE_SIDECAR=ts`) builds the TypeScript
daemon instead. The release does the same for each bundle, and ships the
TypeScript one when the repository variable `CONCLAVE_SIDECAR` is `ts`. It
also uploads the binary alone for each system, as
`conclave-daemon-<target>[.exe]` with a `.sha256`: Linux x64 and arm64, macOS
arm64 and x64, Windows x64.

## Tests

- `cargo test`: path handling (Node's posix and win32 rules, home expansion),
  env scrubbing, the service files for each system, Node style errors, the
  JavaScript helpers, the readers, redaction and the token estimate.
- `packages/server/test/daemon-conformance.test.ts` with the cases in
  `packages/core/test/machine/conformance.ts`: the TypeScript daemon, the
  Rust daemon, and the Rust daemon with the built-in search run as their own
  processes with one fixture home, pair with a real hub like a user would, and
  every case runs on each through the hub. Results must match each other and
  each case's checks. It covers every RPC and its errors, encodings, links, a
  22 MB spawn stream, kills with each signal, the hub's pings, a hub restart,
  saved addresses, a pid file, the sidecar contract on both binaries, a
  pairing moving from one binary to the other, and https and wss with a
  private CA.
- `packages/server/test/daemon-rs-session.test.ts`: a hub session with a
  scripted model whose Bash, Write, Read, Edit, Glob and Grep run on a Rust
  daemon device.

Run them with a release build:

```sh
CONCLAVE_DAEMON_RS=packages/daemon-rs/target/release/conclave-daemon \
  bun test packages/server/test/daemon-conformance.test.ts packages/server/test/daemon-rs-session.test.ts
```

Without a Rust build the suite checks the TypeScript daemon alone. Without
`rg` on PATH the glob and grep cases are skipped.

## Differences from the TypeScript daemon

None of these change what the hub does. Each is either a case where Rust
cannot do what JavaScript does, or a small fix.

- A lone UTF-16 surrogate (half an emoji that a tool cut) in a transcript or
  output becomes U+FFFD. JavaScript keeps the half; a Rust string cannot. The
  length is the same.
- Cuts at a UTF-16 position (exec head and tail, an 80 character title, a
  clipped tool result) never split a surrogate pair. JavaScript may keep half
  of one.
- Dialing the hub gives up after 30 seconds and tries the next address. The
  TypeScript daemon waits for the system's TCP timeout.
- `pair` follows a redirect (301, 302, 307, 308) and keeps the POST. It does
  not use `HTTP_PROXY` or `HTTPS_PROXY`.
- Without `rg`, glob and grep use ripgrep's crates and give rg's results. The
  TypeScript daemon falls back to `Bun.Glob` and `grep -r`, whose output
  differs.
- Some texts differ: status lines name the reason a connection failed, `run`
  when not paired names `conclave-daemon pair`, and errors from a broken JSON
  checkpoint or a broken `.zst` file are worded by serde and ruzstd.
- The secret patterns use Unicode case folding with `(?i)`, so a few letters
  outside ASCII (the long s, the Kelvin sign) match their ASCII twins.
  JavaScript does not fold them.
- TLS is rustls, which refuses a server certificate that is itself a CA
  certificate (what `openssl req -x509` makes by default), even when it is
  trusted through `NODE_EXTRA_CA_CERTS`. Bun accepts it. A server certificate
  signed by that CA works with both (the suite tests this).
- A transcript line nested deeper than 128 levels is skipped as broken.
- On Windows, a date and time without an offset in a transcript is read as UTC
  (local time on Linux and macOS, as in JavaScript).
- On Windows the binary is a GUI program, as the contract asks, and every
  child it starts gets `CREATE_NO_WINDOW`, so no console window opens.
