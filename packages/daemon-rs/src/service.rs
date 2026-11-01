//! The daemon as a user service, as packages/cli/src/service.ts writes it: a
//! systemd user unit on Linux, a LaunchAgent on macOS, a Run key value on
//! Windows. The same names and file contents, so either daemon's `install`
//! replaces the other's. `plan()` is pure, so tests and --dry-run need no
//! real service.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

pub const UNIT_NAME: &str = "conclave-daemon";
pub const LAUNCHD_LABEL: &str = "dev.conclave.daemon";
pub const RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
pub const RUN_VALUE: &str = "ConclaveDaemon";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Systemd,
    Launchd,
    RunKey,
}

/// One command. `optional` failures are fine (stopping a service that is not loaded).
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub show: String,
    pub argv: Vec<String>,
    pub optional: bool,
    /// Try again this many times, half a second apart.
    pub retries: u32,
    /// Start in the background and do not wait (Windows has no service manager).
    pub detached: bool,
}

fn shell_word(s: &str) -> String {
    let plain = !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

pub fn step(argv: &[&str]) -> Step {
    let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    Step { show: argv.iter().map(|a| shell_word(a)).collect::<Vec<_>>().join(" "), argv, optional: false, retries: 0, detached: false }
}

fn optional(mut s: Step) -> Step {
    s.optional = true;
    s
}

pub struct Input<'a> {
    /// linux, darwin or win32
    pub os: &'a str,
    pub home: &'a str,
    /// The binary, then `run` and its flags.
    pub cmd: Vec<String>,
    pub path_env: String,
    pub conclave_home: Option<String>,
    pub log_file: String,
    pub uid: Option<u32>,
}

pub struct Plan {
    pub kind: Kind,
    pub file: Option<String>,
    pub content: Option<String>,
    pub register: Vec<Step>,
    pub start: Vec<Step>,
    pub stop: Vec<Step>,
    pub cleanup: Vec<Step>,
    pub probe: Option<Step>,
}

pub fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// One ExecStart word: % becomes %%, quoted when it holds spaces, quotes or backslashes.
pub fn systemd_quote(s: &str) -> String {
    let e = s.replace('%', "%%");
    if e.chars().any(|c| crate::js::is_js_ws(c) || c == '"' || c == '\'' || c == '\\') {
        format!("\"{}\"", e.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        e
    }
}

fn systemd_env(name: &str, value: &str) -> String {
    format!("Environment={}", systemd_quote(&format!("{name}={value}")))
}

/// One word of a Windows command line (CommandLineToArgvW rules).
pub fn windows_quote(s: &str) -> String {
    if !s.is_empty() && !s.chars().any(|c| crate::js::is_js_ws(c) || c == '"') {
        return s.to_string();
    }
    // backslashes before a quote double, the quote is escaped; trailing backslashes double
    let mut out = String::from("\"");
    let mut slashes = 0usize;
    for c in s.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            out.push_str(&"\\".repeat(slashes * 2));
            out.push_str("\\\"");
        } else {
            out.push_str(&"\\".repeat(slashes));
            out.push(c);
        }
        slashes = 0;
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

fn join(home: &str, parts: &[&str], os: &str) -> String {
    let mut all = vec![home];
    all.extend_from_slice(parts);
    if os == "win32" {
        crate::paths::win32::join(&all)
    } else {
        crate::paths::posix::join(&all)
    }
}

pub fn plan(input: &Input) -> Result<Plan, String> {
    let cmd = &input.cmd;
    match input.os {
        "linux" => {
            let file = join(input.home, &[".config", "systemd", "user", &format!("{UNIT_NAME}.service")], "linux");
            let mut lines = vec![
                "[Unit]".to_string(),
                "Description=Conclave device daemon".into(),
                "After=network-online.target".into(),
                "Wants=network-online.target".into(),
                String::new(),
                "[Service]".into(),
                format!("ExecStart={}", cmd.iter().map(|c| systemd_quote(c)).collect::<Vec<_>>().join(" ")),
                "Restart=always".into(),
                "RestartSec=5".into(),
                systemd_env("PATH", &input.path_env),
            ];
            if let Some(ch) = &input.conclave_home {
                lines.push(systemd_env("CONCLAVE_HOME", ch));
            }
            lines.extend([String::new(), "[Install]".into(), "WantedBy=default.target".into(), String::new()]);
            let ctl = |a: &[&str]| {
                let mut v = vec!["systemctl", "--user"];
                v.extend_from_slice(a);
                step(&v)
            };
            Ok(Plan {
                kind: Kind::Systemd,
                file: Some(file),
                content: Some(lines.join("\n")),
                register: vec![],
                start: vec![ctl(&["daemon-reload"]), ctl(&["enable", UNIT_NAME]), ctl(&["restart", UNIT_NAME])],
                stop: vec![optional(ctl(&["disable", "--now", UNIT_NAME]))],
                cleanup: vec![optional(ctl(&["daemon-reload"])), optional(ctl(&["reset-failed", UNIT_NAME]))],
                probe: Some(ctl(&["is-active", "--quiet", UNIT_NAME])),
            })
        }
        "darwin" => {
            let file = join(input.home, &["Library", "LaunchAgents", &format!("{LAUNCHD_LABEL}.plist")], "darwin");
            let mut env = vec![format!("    <key>PATH</key><string>{}</string>", xml_escape(&input.path_env))];
            if let Some(ch) = &input.conclave_home {
                env.push(format!("    <key>CONCLAVE_HOME</key><string>{}</string>", xml_escape(ch)));
            }
            let args = cmd.iter().map(|c| format!("    <string>{}</string>", xml_escape(c))).collect::<Vec<_>>().join("\n");
            let log = xml_escape(&input.log_file);
            let content = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
{env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
                env = env.join("\n")
            );
            let domain = format!("gui/{}", input.uid.unwrap_or(501));
            let target = format!("{domain}/{LAUNCHD_LABEL}");
            let bootout = optional(step(&["launchctl", "bootout", &target]));
            let mut bootstrap = step(&["launchctl", "bootstrap", &domain, &file]);
            bootstrap.retries = 4;
            Ok(Plan {
                kind: Kind::Launchd,
                file: Some(file),
                content: Some(content),
                register: vec![],
                // bootout first so a changed plist or binary is loaded again
                start: vec![bootout.clone(), bootstrap],
                stop: vec![bootout],
                cleanup: vec![],
                probe: Some(step(&["launchctl", "print", &target])),
            })
        }
        "win32" => {
            let value = cmd.iter().map(|c| windows_quote(c)).collect::<Vec<_>>().join(" ");
            Ok(Plan {
                kind: Kind::RunKey,
                file: None,
                content: Some(value.clone()),
                register: vec![step(&["reg", "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f"])],
                start: vec![Step { show: value, argv: cmd.clone(), optional: false, retries: 0, detached: true }],
                stop: vec![optional(step(&["reg", "delete", RUN_KEY, "/v", RUN_VALUE, "/f"]))],
                cleanup: vec![],
                probe: None,
            })
        }
        other => Err(format!("Automatic install is not supported on {other}. Run this at login: {}", cmd.join(" "))),
    }
}

// ---------------------------------------------------------------------------
// PATH: the user's own, so git, claude and codex are found
// ---------------------------------------------------------------------------

const MARK: &str = "__CONCLAVE_PATH__";

/// The PATH between the markers the login shell printed (rc files may print other lines).
pub fn parse_marked_path(output: &str) -> Option<String> {
    let start = output.find(MARK)? + MARK.len();
    let end = output[start..].find(MARK)? + start;
    let v = crate::js::trim(&output[start..end]);
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// PATH from the user's login shell, or None when it does not answer in 5 seconds.
pub fn login_shell_path(shell: Option<&str>) -> Option<String> {
    let sh = shell.filter(|s| !s.is_empty()).unwrap_or(if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" });
    let script = format!("printf '%s%s%s' '{MARK}' \"$PATH\" '{MARK}'");
    let mut child = Command::new(sh).args(["-l", "-i", "-c", &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let out = rx.recv_timeout(Duration::from_secs(5)).ok();
    let _ = child.kill();
    let _ = child.wait();
    out.and_then(|o| parse_marked_path(&o))
}

/// Folders where agent CLIs usually live, for when the login shell says nothing.
pub fn common_bin_dirs(home: &str, os: &str) -> Vec<String> {
    let mut out: Vec<String> = [".local/bin", ".bun/bin", ".cargo/bin", ".npm-global/bin", ".volta/bin", "go/bin"].iter().map(|d| crate::paths::posix::join(&[home, d])).collect();
    let system: &[&str] = if os == "darwin" {
        &["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    } else {
        &["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"]
    };
    out.extend(system.iter().map(|s| s.to_string()));
    out
}

/// Join PATH lists in order without duplicates; `extra` folders only when they exist.
pub fn merge_path(lists: &[Option<String>], extra: &[String], exists: &dyn Fn(&str) -> bool, sep: char) -> String {
    fn add(out: &mut Vec<String>, d: &str) {
        let dir = crate::js::trim(d);
        if !dir.is_empty() && !out.iter().any(|x| x == dir) {
            out.push(dir.to_string());
        }
    }
    let mut out: Vec<String> = Vec::new();
    for list in lists.iter().flatten() {
        for d in list.split(sep) {
            add(&mut out, d);
        }
    }
    for d in extra {
        if !out.contains(d) && exists(d) {
            add(&mut out, d);
        }
    }
    out.join(&sep.to_string())
}

/// An AppImage puts its own mount (gone once the app quits) on the PATH it passes down.
pub fn without_appimage(path: &str, app_dir: Option<&str>, sep: char) -> String {
    path.split(sep)
        .filter(|d| {
            let in_app = app_dir.filter(|a| !a.is_empty()).is_some_and(|a| d.starts_with(a));
            let mount = format!("{d}/").contains("/.mount_") && {
                let s = format!("{d}/");
                let i = s.find("/.mount_").unwrap();
                s[i + 8..].contains('/')
            };
            !in_app && !mount
        })
        .collect::<Vec<_>>()
        .join(&sep.to_string())
}

/// The daemon's PATH: the login shell's, then this one, then common folders that exist.
pub fn daemon_path(login: bool, os: &str, home: &str) -> String {
    let current = std::env::var("PATH").or_else(|_| std::env::var("Path")).unwrap_or_default();
    if os == "win32" {
        return current;
    }
    if !login {
        return if current.is_empty() { "/usr/local/bin:/usr/bin:/bin".into() } else { current };
    }
    let shell = std::env::var("SHELL").ok();
    let app_dir = std::env::var("APPDIR").ok();
    merge_path(&[login_shell_path(shell.as_deref()), Some(without_appimage(&current, app_dir.as_deref(), ':'))], &common_bin_dirs(home, os), &|d| Path::new(d).exists(), ':')
}

// ---------------------------------------------------------------------------
// Running the steps, and asking whether it runs
// ---------------------------------------------------------------------------

pub struct StepResult {
    pub ok: bool,
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub fn run_step(s: &Step, timeout: Duration) -> StepResult {
    let mut cmd = Command::new(&s.argv[0]);
    cmd.args(&s.argv[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return StepResult { ok: false, status: None, stdout: String::new(), stderr: e.to_string() },
    };
    let (mut so, mut se) = (child.stdout.take(), child.stderr.take());
    let t1 = std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        if let Some(o) = so.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let t2 = std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        if let Some(o) = se.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    let stdout = t1.join().unwrap_or_default();
    let stderr = t2.join().unwrap_or_default();
    StepResult { ok: status == Some(0), status, stdout, stderr }
}

/// Run each step; a failed step that is not optional stops with what it said.
pub fn run_steps(steps: &[Step], spawn_detached: &dyn Fn(&Step)) -> Result<(), String> {
    for s in steps {
        if s.detached {
            spawn_detached(s);
            continue;
        }
        let mut r = run_step(s, Duration::from_secs(20));
        let mut i = 0;
        while !r.ok && i < s.retries {
            std::thread::sleep(Duration::from_millis(500));
            r = run_step(s, Duration::from_secs(20));
            i += 1;
        }
        if !r.ok && !s.optional {
            let both = if r.stderr.trim().is_empty() { r.stdout.clone() } else { r.stderr.clone() };
            let lines: Vec<&str> = both.trim().split('\n').collect();
            let said = lines[lines.len().saturating_sub(3)..].join(" ");
            return Err(if !said.is_empty() {
                format!("`{}` failed: {said}", s.show)
            } else if let Some(c) = r.status {
                format!("`{}` failed (exit {c})", s.show)
            } else {
                format!("`{}` failed", s.show)
            });
        }
    }
    Ok(())
}

/// systemd and launchd: the file is there. Windows: the Run key value.
pub fn installed(plan: &Plan) -> bool {
    match &plan.file {
        Some(f) => Path::new(f).exists(),
        None => run_step(&step(&["reg", "query", RUN_KEY, "/v", RUN_VALUE]), Duration::from_secs(20)).ok,
    }
}

// ---------------------------------------------------------------------------
// The pid file
// ---------------------------------------------------------------------------

pub fn pid_file() -> PathBuf {
    crate::config::conclave_home().join("daemon.pid")
}

pub fn read_pid(file: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(file).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let n = v.get("pid")?.as_f64()?;
    if n > 0.0 && n.fract() == 0.0 {
        Some(n as u32)
    } else {
        None
    }
}

#[cfg(unix)]
pub fn pid_alive(pid: Option<u32>) -> bool {
    let Some(pid) = pid else { return false };
    // SAFETY: signal 0 only checks that the process exists.
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub fn pid_alive(pid: Option<u32>) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let Some(pid) = pid else { return false };
    // SAFETY: a handle we open and close here.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE as u32
    }
}

/// Only a conclave daemon may be stopped by its pid: a daemon that was killed leaves its pid file, and pids get reused.
fn is_conclave(pid: u32) -> bool {
    if cfg!(windows) {
        let r = run_step(&step(&["tasklist", "/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]), Duration::from_secs(20));
        return r.stdout.to_lowercase().contains("conclave");
    }
    command_line(pid).is_some_and(|c| {
        let c = c.to_lowercase();
        c.contains("conclave") && c.contains("daemon")
    })
}

/// A process's command line (processMatches in pids.ts): Linux reads /proc, macOS asks ps, elsewhere None.
fn command_line(pid: u32) -> Option<String> {
    if cfg!(target_os = "linux") {
        // /proc separates arguments with NUL bytes
        return std::fs::read(format!("/proc/{pid}/cmdline")).ok().map(|b| String::from_utf8_lossy(&b).replace('\0', " "));
    }
    if cfg!(target_os = "macos") {
        return Some(run_step(&step(&["ps", "-p", &pid.to_string(), "-o", "command="]), Duration::from_secs(2)).stdout);
    }
    None
}

/// Stop the daemon the pid file names. True when one was running.
pub fn stop_by_pid(file: &Path) -> bool {
    let Some(pid) = read_pid(file) else { return false };
    if pid == std::process::id() || !pid_alive(Some(pid)) || !is_conclave(pid) {
        return false;
    }
    #[cfg(unix)]
    // SAFETY: SIGTERM to the daemon the pid file names.
    unsafe {
        if libc::kill(pid as i32, libc::SIGTERM) != 0 {
            return false;
        }
    }
    #[cfg(windows)]
    crate::procs::kill_tree(pid, crate::procs::Sig::Term);
    for _ in 0..20 {
        if !pid_alive(Some(pid)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = std::fs::remove_file(file);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(os: &'static str, home: &'static str, cmd: &[&str]) -> Input<'static> {
        Input { os, home, cmd: cmd.iter().map(|s| s.to_string()).collect(), path_env: "/home/kai/.local/bin:/usr/bin:/bin".into(), conclave_home: None, log_file: "/home/kai/.conclave/logs/daemon.log".into(), uid: Some(501) }
    }

    #[test]
    fn linux_unit() {
        let p = plan(&input("linux", "/home/kai", &["/home/kai/.local/share/dev.conclave.desktop/daemon/conclave-daemon", "run"])).unwrap();
        assert_eq!(p.kind, Kind::Systemd);
        assert_eq!(p.file.as_deref(), Some("/home/kai/.config/systemd/user/conclave-daemon.service"));
        let c = p.content.unwrap();
        assert_eq!(
            c,
            "[Unit]\nDescription=Conclave device daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=/home/kai/.local/share/dev.conclave.desktop/daemon/conclave-daemon run\nRestart=always\nRestartSec=5\nEnvironment=PATH=/home/kai/.local/bin:/usr/bin:/bin\n\n[Install]\nWantedBy=default.target\n"
        );
        let shows: Vec<&str> = p.start.iter().map(|s| s.show.as_str()).collect();
        assert_eq!(shows, ["systemctl --user daemon-reload", "systemctl --user enable conclave-daemon", "systemctl --user restart conclave-daemon"]);
        assert_eq!(p.stop[0].show, "systemctl --user disable --now conclave-daemon");
        assert!(p.stop[0].optional);
        assert_eq!(p.probe.unwrap().show, "systemctl --user is-active --quiet conclave-daemon");
    }

    #[test]
    fn systemd_quoting() {
        let mut i = input("linux", "/home/kai", &["/home/kai/My Apps/conclave-daemon", "run"]);
        i.path_env = "/opt/my tools/bin:/usr/bin".into();
        i.conclave_home = Some("/data/100%".into());
        let c = plan(&i).unwrap().content.unwrap();
        assert!(c.contains("ExecStart=\"/home/kai/My Apps/conclave-daemon\" run\n"));
        assert!(c.contains("Environment=\"PATH=/opt/my tools/bin:/usr/bin\"\n"));
        assert!(c.contains("Environment=CONCLAVE_HOME=/data/100%%\n"));
        assert_eq!(systemd_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn macos_plist() {
        let p = plan(&input("darwin", "/Users/kai", &["/Users/kai/Library/Application Support/dev.conclave.desktop/daemon/conclave-daemon", "run"])).unwrap();
        assert_eq!(p.file.as_deref(), Some("/Users/kai/Library/LaunchAgents/dev.conclave.daemon.plist"));
        let c = p.content.unwrap();
        assert!(c.contains("<string>/Users/kai/Library/Application Support/dev.conclave.desktop/daemon/conclave-daemon</string>\n    <string>run</string>"));
        assert!(c.contains("<key>PATH</key><string>/home/kai/.local/bin:/usr/bin:/bin</string>"));
        assert!(c.contains("<key>KeepAlive</key><true/>"));
        let shows: Vec<&str> = p.start.iter().map(|s| s.show.as_str()).collect();
        assert_eq!(shows, ["launchctl bootout gui/501/dev.conclave.daemon", "launchctl bootstrap gui/501 /Users/kai/Library/LaunchAgents/dev.conclave.daemon.plist"]);
        assert!(p.start[0].optional && p.start[1].retries > 0);
        assert!(plan(&input("darwin", "/Users/kai", &["/a&b/<c>", "run"])).unwrap().content.unwrap().contains("<string>/a&amp;b/&lt;c&gt;</string>"));
    }

    #[test]
    fn windows_run_key() {
        let exe = "C:\\Users\\Kai\\AppData\\Local\\dev.conclave.desktop\\daemon\\conclave-daemon.exe";
        let p = plan(&input("win32", "C:\\Users\\Kai", &[exe, "run", "--log", "C:\\Users\\Kai\\.conclave\\logs\\daemon.log"])).unwrap();
        assert_eq!(p.kind, Kind::RunKey);
        assert!(p.file.is_none());
        assert_eq!(p.content.as_deref(), Some(format!("{exe} run --log C:\\Users\\Kai\\.conclave\\logs\\daemon.log").as_str()));
        assert_eq!(p.register[0].argv[..6], ["reg", "add", RUN_KEY, "/v", RUN_VALUE, "/t"]);
        assert!(p.start[0].detached);
        assert_eq!(windows_quote("C:\\Program Files\\Conclave\\conclave.exe"), "\"C:\\Program Files\\Conclave\\conclave.exe\"");
        assert_eq!(windows_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(windows_quote("C:\\dir with space\\"), "\"C:\\dir with space\\\\\"");
        assert_eq!(windows_quote(""), "\"\"");
    }

    #[test]
    fn other_systems_say_what_to_run() {
        let e = plan(&input("freebsd", "/home/kai", &["/x/conclave-daemon", "run"])).err().unwrap();
        assert_eq!(e, "Automatic install is not supported on freebsd. Run this at login: /x/conclave-daemon run");
    }

    #[test]
    fn path_handling() {
        assert_eq!(parse_marked_path("motd\n__CONCLAVE_PATH__/a:/b__CONCLAVE_PATH__\nbye").as_deref(), Some("/a:/b"));
        assert_eq!(parse_marked_path("nothing"), None);
        let merged = merge_path(&[Some("/a:/b".into()), Some("/b:/c:".into())], &["/d".into(), "/e".into()], &|d| d == "/d", ':');
        assert_eq!(merged, "/a:/b:/c:/d");
        assert_eq!(without_appimage("/tmp/.mount_ConclXYZ/usr/bin:/usr/bin", None, ':'), "/usr/bin");
        assert_eq!(without_appimage("/opt/app/bin:/usr/bin", Some("/opt/app"), ':'), "/usr/bin");
        assert_eq!(shell_word("a b"), "'a b'");
        assert_eq!(shell_word("it's"), "'it'\\''s'");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_pid_now_used_by_another_program_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("conclave-daemon-pid-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sleep = crate::env::which("sleep").unwrap();
        // sleep run from a folder named like the daemon: its command line says conclave and daemon
        let named = dir.join("sleep");
        std::os::unix::fs::symlink(&sleep, &named).unwrap();
        // started by a shell that exits at once, so it is not our child, as a real daemon is not
        let live = |bin: &Path| -> u32 {
            let out = Command::new("sh").args(["-c", "\"$0\" 30 >/dev/null 2>&1 & echo $!"]).arg(bin).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
        };
        let file = dir.join("daemon.pid");
        let other = live(&sleep);
        std::fs::write(&file, format!("{{\"pid\":{other}}}")).unwrap();
        assert!(!stop_by_pid(&file));
        assert!(pid_alive(Some(other)));
        let daemon = live(&named);
        std::fs::write(&file, format!("{{\"pid\":{daemon}}}")).unwrap();
        assert!(stop_by_pid(&file));
        assert!(!file.exists());
        // SAFETY: SIGKILL to the two sleeps this test started.
        unsafe {
            libc::kill(other as i32, libc::SIGKILL);
            libc::kill(daemon as i32, libc::SIGKILL);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
