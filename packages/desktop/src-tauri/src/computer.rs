//! "Let the hub use this computer": the daemon that ships inside the app.
//!
//! The bundle carries a `conclave-daemon` binary next to the app's own (Tauri
//! externalBin, built by scripts/build-sidecar.ts). The service must not point
//! into the bundle: an AppImage mounts at a new path on every start, and an
//! update replaces the bundle. So the app keeps a stable copy in its data
//! folder, replaces it when the bundled one changes (an app update), and then
//! runs `install` again so the service restarts on the new copy.
//!
//! Everything about the service itself (the systemd unit, the LaunchAgent, the
//! Windows Run key, pairing and unpairing) is the binary's own job. The app
//! calls only the subcommands in docs/design/DAEMON-SIDECAR.md, so a daemon
//! rewritten in another language is a drop-in replacement:
//!
//!   conclave-daemon pair --hub URL --app-token-stdin --json
//!   conclave-daemon install
//!   conclave-daemon uninstall --json
//!   conclave-daemon status --json
//!   conclave-daemon --version

use serde::Deserialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant, UNIX_EPOCH},
};

/// The binary's name next to the app and in the stable folder.
pub const BIN: &str = if cfg!(windows) { "conclave-daemon.exe" } else { "conclave-daemon" };

/// The one line the switch shows everywhere.
pub const ALLOWS: &str = "The hub can read and change your files here and run commands and coding tools as you.";

/// The copy Tauri put next to the app's own executable.
pub fn bundled() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.parent().map(|d| d.join(BIN)).ok_or("The app has no folder.")?;
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("This build of the app has no daemon ({} is missing).", path.display()))
    }
}

/// The stable copy the service runs, and the stamp of the bundled file it came from.
pub struct Stable {
    pub dir: PathBuf,
    pub bin: PathBuf,
    stamp: PathBuf,
}

impl Stable {
    pub fn new(dir: PathBuf) -> Self {
        Stable { bin: dir.join(BIN), stamp: dir.join("bundled.stamp"), dir }
    }

    pub fn exists(&self) -> bool {
        self.bin.is_file()
    }
}

/// What identifies a bundled binary: the app version, its size and its time.
/// An update changes at least one of them, also in dev builds.
pub fn stamp_of(version: &str, file: &Path) -> Result<String, String> {
    let meta = fs::metadata(file).map_err(|e| format!("Cannot read {}: {e}", file.display()))?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    Ok(format!("{version} {} {mtime}", meta.len()))
}

/// Copy the bundled binary over the stable one when it changed. Returns true
/// when it was replaced, so the caller restarts the service.
pub fn sync(stable: &Stable, bundled: &Path, version: &str) -> Result<bool, String> {
    let stamp = stamp_of(version, bundled)?;
    let old = stable.dir.join(format!("{BIN}.old"));
    // a Windows copy that was running during the last update
    let _ = fs::remove_file(&old);
    if stable.exists() && fs::read_to_string(&stable.stamp).ok().as_deref() == Some(stamp.as_str()) {
        return Ok(false);
    }
    let fail = |e: std::io::Error| format!("Cannot copy the daemon to {}: {e}", stable.dir.display());
    fs::create_dir_all(&stable.dir).map_err(fail)?;
    let next = stable.dir.join(format!("{BIN}.new"));
    fs::copy(bundled, &next).map_err(fail)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&next, fs::Permissions::from_mode(0o755)).map_err(fail)?;
    }
    #[cfg(target_os = "macos")]
    {
        // a copy of a downloaded app keeps the download flag; launchd would refuse it
        let _ = Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(&next).output();
    }
    // Windows cannot replace a running exe, but it can rename it out of the way.
    // On Linux and macOS the rename swaps the file under a running daemon, which
    // keeps its old copy until the restart.
    if cfg!(windows) && stable.exists() {
        fs::rename(&stable.bin, &old).map_err(fail)?;
    }
    fs::rename(&next, &stable.bin).map_err(fail)?;
    fs::write(&stable.stamp, stamp).map_err(fail)?;
    Ok(true)
}

/// What a command printed, and whether it exited 0.
#[derive(Debug)]
pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    /// The error in the daemon's own words: its `Error: ` line, else the last line it printed.
    pub fn error(&self, what: &str) -> String {
        let lines = || self.stderr.lines().chain(self.stdout.lines()).map(str::trim).filter(|l| !l.is_empty());
        let line = lines().find(|l| l.starts_with("Error: ")).or_else(|| lines().next_back()).unwrap_or("");
        let line = line.strip_prefix("Error: ").unwrap_or(line);
        if line.is_empty() {
            format!("{what} failed.")
        } else {
            format!("{what} failed: {line}")
        }
    }
}

fn reader(mut from: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = from.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    rx
}

/// Run `bin args...` without a console window, with a time limit. `input` goes
/// to stdin (the app token: never on the command line, where other users of
/// this computer could read it).
pub fn run(bin: &Path, args: &[&str], input: Option<&str>, timeout: Duration) -> Result<Output, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Cannot start {}: {e}", bin.display()))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(text.as_bytes()).and_then(|_| stdin.write_all(b"\n"));
        // dropped here, so the daemon sees the end of its input
    }
    let out = reader(child.stdout.take().ok_or("no stdout")?);
    let err = reader(child.stderr.take().ok_or("no stderr")?);
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("`conclave-daemon {}` did not finish in {} seconds.", args.join(" "), timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    // A daemon it started in the background may hold the pipes open (Windows),
    // so do not wait long for the end of the output.
    let grace = Duration::from_secs(2);
    Ok(Output {
        ok: status.success(),
        stdout: out.recv_timeout(grace).unwrap_or_default(),
        stderr: err.recv_timeout(grace).unwrap_or_default(),
    })
}

/// The last line that is a JSON object (the daemon prints one with --json).
fn json_line(stdout: &str) -> &str {
    stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("")
}

/// `conclave-daemon status --json`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub paired: bool,
    /// The hub it is paired with.
    #[serde(default)]
    pub hub: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub installed: bool,
    /// None when the daemon cannot tell (no systemctl).
    #[serde(default)]
    pub running: Option<bool>,
}

pub fn parse_status(stdout: &str) -> Result<LocalStatus, String> {
    serde_json::from_str(json_line(stdout)).map_err(|e| format!("Unexpected reply from the daemon: {e}"))
}

pub fn status(bin: &Path) -> Result<LocalStatus, String> {
    let out = run(bin, &["status", "--json"], None, Duration::from_secs(15))?;
    if !out.ok {
        return Err(out.error("Checking the daemon"));
    }
    parse_status(&out.stdout)
}

/// `conclave-daemon pair --hub URL --app-token-stdin --json`: pair with the
/// app's own token (no second code). Kept when it is already a device of that hub.
pub fn pair(bin: &Path, hub_url: &str, app_token: &str) -> Result<(), String> {
    let out = run(bin, &["pair", "--hub", hub_url, "--app-token-stdin", "--json"], Some(app_token), Duration::from_secs(45))?;
    if out.ok {
        Ok(())
    } else {
        Err(out.error("Pairing this computer"))
    }
}

/// `conclave-daemon install`: the user service, with the login PATH, started (or restarted) now.
pub fn install(bin: &Path) -> Result<(), String> {
    let out = run(bin, &["install"], None, Duration::from_secs(60))?;
    if out.ok {
        Ok(())
    } else {
        Err(out.error("Starting the daemon"))
    }
}

/// `conclave-daemon uninstall --json`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Uninstalled {
    /// It was paired and the pairing here is gone.
    #[serde(default)]
    pub unpaired: bool,
    /// The hub removed the device (or no longer knew it).
    #[serde(default)]
    pub removed_on_hub: bool,
    #[serde(default)]
    pub name: Option<String>,
}

pub fn parse_uninstalled(stdout: &str) -> Uninstalled {
    serde_json::from_str(json_line(stdout)).unwrap_or_default()
}

pub fn uninstall(bin: &Path) -> Result<Uninstalled, String> {
    let out = run(bin, &["uninstall", "--json"], None, Duration::from_secs(60))?;
    if out.ok {
        Ok(parse_uninstalled(&out.stdout))
    } else {
        Err(out.error("Removing the service"))
    }
}

/// What turning it off did, in one or two sentences.
pub fn off_words(u: &Uninstalled) -> String {
    let name = u.name.as_deref().unwrap_or("this computer");
    match (u.unpaired, u.removed_on_hub) {
        (false, _) => "Off. The hub cannot use this computer. The service is removed.".into(),
        (true, true) => format!("Off. The service is removed and {name} is gone from the hub's Devices page."),
        (true, false) => format!("Off. The service is removed. The hub did not answer, so remove {name} on its Devices page."),
    }
}

/// How the hub sees this computer's device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    Online,
    Offline,
    /// Not on the hub's Devices page (removed there).
    Missing,
}

/// The state as one line, from the switch, the local service and the hub
/// (None when the hub did not answer).
pub fn words(enabled: bool, local: Option<&LocalStatus>, seen: Option<Seen>) -> String {
    if !enabled {
        return "Off. The hub cannot use this computer.".into();
    }
    let Some(local) = local else {
        return "On, but the daemon is missing. Turn it off and on again.".into();
    };
    let name = local.name.as_deref().unwrap_or("this computer");
    if !local.paired {
        return "On, but this computer is not paired. Turn it off and on again.".into();
    }
    if !local.installed {
        return "On, but the service is not installed. Turn it off and on again.".into();
    }
    match (seen, local.running) {
        (Some(Seen::Online), _) => format!("On. The hub sees this computer as {name}."),
        (Some(Seen::Missing), _) => format!("On, but {name} is no longer on the hub's Devices page. Turn it off and on again."),
        (_, Some(false)) => "On, but the service is not running. Turn it off and on again.".into(),
        (Some(Seen::Offline), _) => format!("On, but the hub does not see {name} yet."),
        (None, _) => "On. The hub did not answer, so it cannot say whether it sees this computer.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conclave-desktop-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_the_bundled_binary_once_per_build() {
        let dir = tmp("sync");
        let bundled = dir.join("bundled-daemon");
        fs::write(&bundled, b"one").unwrap();
        let stable = Stable::new(dir.join("daemon"));
        assert!(stable.bin.ends_with(BIN));
        assert!(sync(&stable, &bundled, "0.2.0").unwrap());
        assert_eq!(fs::read(&stable.bin).unwrap(), b"one");
        // same build: nothing to do
        assert!(!sync(&stable, &bundled, "0.2.0").unwrap());
        // an update: a new version (or size, or time) replaces it
        fs::write(&bundled, b"two!").unwrap();
        assert!(sync(&stable, &bundled, "0.3.0").unwrap());
        assert_eq!(fs::read(&stable.bin).unwrap(), b"two!");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&stable.bin).unwrap().permissions().mode() & 0o777, 0o755);
        }
        // a deleted copy comes back even with the same stamp
        fs::remove_file(&stable.bin).unwrap();
        assert!(sync(&stable, &bundled, "0.3.0").unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_the_status_json_of_the_contract() {
        let s = parse_status(r#"{"version":"0.2.0","paired":true,"hub":"http://box:7717","deviceId":"dev_1","name":"arch","installed":true,"running":null}"#).unwrap();
        assert!(s.paired && s.installed);
        assert_eq!(s.hub.as_deref(), Some("http://box:7717"));
        assert_eq!(s.device_id.as_deref(), Some("dev_1"));
        assert_eq!(s.running, None);
        let none = parse_status("some log line\n{\"version\":\"0.2.0\",\"paired\":false,\"hub\":null,\"deviceId\":null,\"name\":null,\"installed\":false,\"running\":false}").unwrap();
        assert!(!none.paired && none.device_id.is_none() && none.running == Some(false));
        assert!(parse_status("Error: nope").is_err());
    }

    #[test]
    fn says_what_turning_it_off_did() {
        let u = parse_uninstalled(r#"{"removed":true,"unpaired":true,"removedOnHub":true,"name":"arch","deviceId":"dev_1","error":null}"#);
        assert_eq!(off_words(&u), "Off. The service is removed and arch is gone from the hub's Devices page.");
        let u = parse_uninstalled(r#"{"removed":true,"unpaired":true,"removedOnHub":false,"name":"arch","deviceId":"dev_1","error":"Cannot reach"}"#);
        assert!(off_words(&u).contains("remove arch on its Devices page"));
        assert!(off_words(&parse_uninstalled(r#"{"removed":false,"unpaired":false,"removedOnHub":false,"name":null,"deviceId":null,"error":null}"#)).starts_with("Off."));
        assert!(off_words(&parse_uninstalled("garbage")).starts_with("Off."));
    }

    #[test]
    fn puts_the_state_in_one_line() {
        let mut local = LocalStatus { paired: true, name: Some("arch".into()), installed: true, running: Some(true), ..Default::default() };
        assert_eq!(words(true, Some(&local), Some(Seen::Online)), "On. The hub sees this computer as arch.");
        assert_eq!(words(true, Some(&local), Some(Seen::Offline)), "On, but the hub does not see arch yet.");
        assert!(words(true, Some(&local), Some(Seen::Missing)).contains("no longer on the hub's Devices page"));
        assert!(words(true, Some(&local), None).contains("did not answer"));
        local.running = Some(false);
        assert!(words(true, Some(&local), Some(Seen::Offline)).contains("not running"));
        local.installed = false;
        assert!(words(true, Some(&local), None).contains("not installed"));
        assert!(words(false, Some(&local), Some(Seen::Online)).starts_with("Off."));
        assert!(words(true, None, None).contains("missing"));
    }

    #[test]
    fn errors_use_the_daemons_own_words() {
        let out = Output { ok: false, stdout: String::new(), stderr: "\nError: Hub error 400: That pairing code is wrong or has expired.\n".into() };
        assert_eq!(out.error("Pairing"), "Pairing failed: Hub error 400: That pairing code is wrong or has expired.");
        let silent = Output { ok: false, stdout: String::new(), stderr: String::new() };
        assert_eq!(silent.error("Pairing"), "Pairing failed.");
    }

    #[cfg(unix)]
    #[test]
    fn runs_with_stdin_and_a_time_limit() {
        let ok = run(Path::new("/bin/sh"), &["-c", "read t; echo got $t; echo oops >&2"], Some("secret"), Duration::from_secs(5)).unwrap();
        assert!(ok.ok);
        assert_eq!(ok.stdout.trim(), "got secret");
        assert_eq!(ok.stderr.trim(), "oops");
        let slow = run(Path::new("/bin/sh"), &["-c", "sleep 5"], None, Duration::from_millis(200));
        assert!(slow.unwrap_err().contains("did not finish"));
    }
}
