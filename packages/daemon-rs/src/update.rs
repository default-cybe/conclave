//! The daemon updates itself (protocol 4, the selfUpdate RPC; docs/DESIGN.md,
//! Updates). The hub sends its own version and that release's manifest
//! (packages/core/src/update/manifest.ts). This picks the file for its own
//! target (conclave-daemon-<target>), downloads it, checks its size, SHA-256
//! and minisign signature with the key built into it
//! (packages/core/src/update/update-key.pub, the one file every updater
//! reads), writes it next to itself, asks it its version, then swaps it in
//! (the old binary stays as <name>.prev) and exits. Its service starts the new
//! binary: systemd (Restart=always) and launchd (KeepAlive); on Windows,
//! where the Run key starts it once, it starts the new one itself.
//!
//! The desktop app's copy (a folder with bundled.stamp) is left to the app.
//! The TypeScript daemon does the same (packages/cli/src/daemon-update.ts),
//! with the same first checks in the same order.

use crate::errors::WireError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// The update key file, built in. While its key line is the placeholder, nothing installs.
pub const KEY_FILE: &str = include_str!("../../core/src/update/update-key.pub");
/// The Rust target this binary was built for (build.rs), the key of its file in the manifest.
pub const TARGET: &str = env!("CONCLAVE_DAEMON_TARGET");

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);

// ---------------------------------------------------------------------------
// The key and signatures
// ---------------------------------------------------------------------------

/// The last line that is not empty or a # comment.
pub fn key_line(text: &str) -> &str {
    text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).last().unwrap_or("")
}

pub const NO_KEY: &str = "This build has no update key yet, so it installs no updates. Update by hand this time.";

/// A key file's text, or Tauri's base64 of one, as the text.
fn minisign_text(input: &str) -> String {
    let t = input.trim();
    if t.to_ascii_lowercase().contains("untrusted comment:") {
        return t.to_string();
    }
    use base64::Engine;
    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(t) {
        if let Ok(s) = String::from_utf8(bytes) {
            if s.trim_start().to_ascii_lowercase().starts_with("untrusted comment:") {
                return s.trim().to_string();
            }
        }
    }
    t.to_string()
}

/// The update key in `text` (an update-key.pub), or why there is none.
pub fn read_key(text: &str) -> Result<minisign_verify::PublicKey, String> {
    let line = key_line(text);
    if line.is_empty() || line.eq_ignore_ascii_case("placeholder") {
        return Err(NO_KEY.into());
    }
    let t = minisign_text(line);
    let parsed = if t.to_ascii_lowercase().contains("untrusted comment:") { minisign_verify::PublicKey::decode(&t) } else { minisign_verify::PublicKey::from_base64(&t) };
    parsed.map_err(|e| format!("This build's update key is broken ({e}). Update by hand this time."))
}

pub fn embedded_key() -> Result<minisign_verify::PublicKey, String> {
    read_key(KEY_FILE)
}

/// Check `sig` (a .sig file, or Tauri's base64 of one) over `data`. Prehashed signatures only, as the Tauri updater.
pub fn verify(data: &[u8], sig: &str, key: &minisign_verify::PublicKey) -> Result<String, String> {
    let text = minisign_text(sig);
    let s = minisign_verify::Signature::decode(&text).map_err(|_| "The signature is not a minisign signature.".to_string())?;
    key.verify(data, &s, false).map_err(|e| match e {
        minisign_verify::Error::UnexpectedKeyId => "The update was signed with another key than the one this build trusts.".to_string(),
        minisign_verify::Error::UnexpectedAlgorithm => "The signature is the legacy kind, which updates do not take. Sign with tauri signer.".to_string(),
        _ => "The update signature does not match the file. Nothing was installed.".to_string(),
    })?;
    Ok(s.trusted_comment().to_string())
}

// ---------------------------------------------------------------------------
// Versions (manifest.ts compareVersions)
// ---------------------------------------------------------------------------

struct Version {
    nums: [u64; 3],
    pre: Vec<String>,
}

fn parse_version(v: &str) -> Option<Version> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let v = v.split('+').next().unwrap_or("");
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.is_empty() || parts.len() > 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let mut nums = [0u64; 3];
    for (i, p) in parts.iter().enumerate() {
        nums[i] = p.parse().ok()?;
    }
    let pre = match pre {
        Some(p) if p.is_empty() || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') => return None,
        Some(p) => p.split('.').map(str::to_string).collect(),
        None => Vec::new(),
    };
    Some(Version { nums, pre })
}

pub fn is_version(v: &str) -> bool {
    parse_version(v).is_some()
}

/// Semver order; a string that is not a version sorts first.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (x, y) = match (parse_version(a), parse_version(b)) {
        (Some(x), Some(y)) => (x, y),
        (Some(_), None) => return Ordering::Greater,
        (None, Some(_)) => return Ordering::Less,
        (None, None) => return Ordering::Equal,
    };
    match x.nums.cmp(&y.nums) {
        Ordering::Equal => {}
        o => return o,
    }
    match (x.pre.is_empty(), y.pre.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    for i in 0..x.pre.len().max(y.pre.len()) {
        let (Some(p), Some(q)) = (x.pre.get(i), y.pre.get(i)) else {
            return if x.pre.len() < y.pre.len() { Ordering::Less } else { Ordering::Greater };
        };
        let (pn, qn) = (p.parse::<u64>().ok(), q.parse::<u64>().ok());
        let o = match (pn, qn) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => p.cmp(q),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    Ordering::Equal
}

/// `latest` is newer than `current`; a current that is not a version (a test build) never is behind.
pub fn is_newer(latest: &str, current: &str) -> bool {
    is_version(latest) && is_version(current) && compare_versions(latest, current) == Ordering::Greater
}

// ---------------------------------------------------------------------------
// How this copy updates
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Restart {
    /// Exit; systemd or launchd starts the new binary.
    Exit,
    /// Start the new binary, then exit (the Windows Run key starts it only at sign in).
    Respawn,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    /// It can update itself: the binary to replace and how it comes back.
    Own { exe: PathBuf, restart: Restart },
    /// The desktop app's copy.
    App(String),
    Manual(String),
}

impl Mode {
    pub fn word(&self) -> &'static str {
        match self {
            Mode::Own { .. } => "self",
            Mode::App(_) => "app",
            Mode::Manual(_) => "manual",
        }
    }
    pub fn why(&self) -> Option<&str> {
        match self {
            Mode::Own { .. } => None,
            Mode::App(w) | Mode::Manual(w) => Some(w),
        }
    }
}

/// The systemd unit of this process (/proc/self/cgroup), when it is a Conclave service.
fn conclave_unit(cgroup: &str) -> bool {
    cgroup.lines().any(|line| {
        let path = line.splitn(3, ':').nth(2).unwrap_or("");
        let unit = path.split('/').filter(|p| p.ends_with(".service")).last().unwrap_or("");
        !unit.is_empty() && !unit.starts_with("user@") && !unit.starts_with("run-") && unit.contains("conclave")
    })
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".conclave-write-test-{}", std::process::id()));
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// The desktop app keeps its copy in a folder with bundled.stamp (desktop computer.rs), or runs it from inside the bundle.
pub fn app_managed(dir: &Path) -> bool {
    let s = dir.to_string_lossy();
    dir.join("bundled.stamp").is_file() || s.ends_with(".app/Contents/MacOS") || s.contains("/.mount_")
}

/// How this copy updates, from where it is and what started it.
pub fn detect() -> Mode {
    let exe = match std::env::current_exe().and_then(std::fs::canonicalize) {
        Ok(p) => p,
        Err(e) => return Mode::Manual(format!("Cannot find this daemon's binary: {e}")),
    };
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    if app_managed(&dir) {
        return Mode::App("The desktop app updates this daemon with itself.".into());
    }
    let restart = if cfg!(windows) {
        Some(Restart::Respawn)
    } else if cfg!(target_os = "linux") && std::env::var_os("INVOCATION_ID").is_some() && std::fs::read_to_string("/proc/self/cgroup").is_ok_and(|c| conclave_unit(&c)) {
        Some(Restart::Exit)
    } else if cfg!(target_os = "macos") && std::env::var("XPC_SERVICE_NAME").ok().as_deref() == Some("dev.conclave.daemon") {
        Some(Restart::Exit)
    } else {
        None
    };
    let Some(restart) = restart else {
        return Mode::Manual("This daemon is not run by its service, so it cannot restart itself. Run conclave-daemon install, then update from the hub.".into());
    };
    if !writable(&dir) {
        return Mode::Manual(format!("The daemon cannot write {}.", dir.display()));
    }
    Mode::Own { exe, restart }
}

pub fn mode() -> &'static Mode {
    static MODE: OnceLock<Mode> = OnceLock::new();
    MODE.get_or_init(detect)
}

// ---------------------------------------------------------------------------
// The mark: an update in flight, then how it went (daemon-update.ts, the same file)
// ---------------------------------------------------------------------------

pub fn mark_file() -> PathBuf {
    crate::config::conclave_home().join("daemon-update.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// On start: a pending update is done when this binary is the version it was for. Returns lastUpdate for the hello.
pub fn settle_mark(file: &Path, version: &str) -> Option<Value> {
    let m: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    let from = m.get("from").and_then(Value::as_str).unwrap_or("").to_string();
    let to = m.get("to").and_then(Value::as_str)?.to_string();
    if m.get("pending").and_then(Value::as_bool) == Some(true) {
        let ok = to == version;
        let mut done = json!({ "from": from, "to": to, "at": now_ms(), "ok": ok });
        if !ok {
            done["message"] = json!(format!("The service started {version}, not {to}."));
        }
        let _ = std::fs::write(file, done.to_string() + "\n");
        return Some(done);
    }
    let mut out = json!({ "from": from, "to": to, "ok": m.get("ok").and_then(Value::as_bool).unwrap_or(false), "at": m.get("at").and_then(Value::as_u64).unwrap_or(0) });
    if let Some(msg) = m.get("message").and_then(Value::as_str) {
        out["message"] = json!(msg);
    }
    Some(out)
}

/// What the hello says about this daemon: impl, version, how it updates, its last update.
pub fn daemon_json() -> Value {
    static LAST: OnceLock<Option<Value>> = OnceLock::new();
    let last = LAST.get_or_init(|| settle_mark(&mark_file(), crate::info::VERSION));
    let m = mode();
    let mut v = json!({ "impl": "rust", "version": crate::info::VERSION, "update": m.word() });
    if let Some(w) = m.why() {
        v["updateWhy"] = json!(w);
    }
    if let Some(l) = last {
        v["lastUpdate"] = l.clone();
    }
    v
}

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------

pub fn prev_path(exe: &Path) -> PathBuf {
    let mut s = exe.as_os_str().to_owned();
    s.push(".prev");
    PathBuf::from(s)
}

/// Put `new` in place of `exe`; the old binary becomes <exe>.prev. A running
/// binary can be renamed on every system (Windows too), so this works while it runs.
pub fn swap(exe: &Path, new: &Path) -> std::io::Result<()> {
    let prev = prev_path(exe);
    let _ = std::fs::remove_file(&prev);
    std::fs::rename(exe, &prev)?;
    if let Err(e) = std::fs::rename(new, exe) {
        let _ = std::fs::rename(&prev, exe);
        return Err(e);
    }
    Ok(())
}

/// Put <exe>.prev back (`conclave-daemon rollback`); the one that failed stays as <exe>.failed. False when there is none.
pub fn roll_back(exe: &Path) -> bool {
    let prev = prev_path(exe);
    if !prev.is_file() {
        return false;
    }
    let mut failed = exe.as_os_str().to_owned();
    failed.push(".failed");
    let _ = std::fs::remove_file(&failed);
    let _ = std::fs::rename(exe, &failed);
    std::fs::rename(&prev, exe).is_ok()
}

async fn probe(bin: &Path) -> Option<String> {
    let argv = vec![bin.to_string_lossy().into_owned(), "--version".to_string()];
    let c = crate::procs::capture(&argv, None, Duration::from_secs(20), 64 * 1024, 64 * 1024).await.ok()?;
    if c.code != Some(0) {
        return None;
    }
    let line = c.stdout.lines().next().unwrap_or("").trim().to_string();
    let re = regex::Regex::new(r"v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)").ok()?;
    re.captures(&line).and_then(|m| m.get(1)).map(|m| m.as_str().to_string())
}

// ---------------------------------------------------------------------------
// The RPC
// ---------------------------------------------------------------------------

fn refuse(message: impl Into<String>, code: &str) -> WireError {
    WireError::coded(message, code)
}

/// What self_update works with; tests pass their own.
pub struct Ctx {
    pub current: String,
    pub target: String,
    pub mode: Mode,
    pub key: Result<minisign_verify::PublicKey, String>,
    pub mark: PathBuf,
}

impl Ctx {
    pub fn real() -> Ctx {
        Ctx { current: crate::info::VERSION.to_string(), target: TARGET.to_string(), mode: mode().clone(), key: embedded_key(), mark: mark_file() }
    }
}

pub fn daemon_file(target: &str) -> String {
    if target.contains("windows") {
        format!("conclave-daemon-{target}.exe")
    } else {
        format!("conclave-daemon-{target}")
    }
}

/// The selfUpdate RPC: download, check, swap. Returns { from, to, restarting }; the restart is the caller's.
pub async fn self_update_with(ctx: &Ctx, params: &Value) -> Result<Value, WireError> {
    // the same first checks, in the same order, as the TypeScript daemon (the conformance test asks)
    let version = params.get("version").and_then(Value::as_str).map(|v| v.trim_start_matches('v').to_string()).unwrap_or_default();
    if !is_version(&version) {
        return Err(refuse("selfUpdate needs a version.", "EINVAL"));
    }
    if !is_newer(&version, &ctx.current) {
        return Err(refuse(format!("Conclave {version} is not newer than this daemon ({}).", ctx.current), "EUPTODATE"));
    }
    let manifest = params.get("manifest").cloned().unwrap_or(Value::Null);
    if manifest.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err(refuse("The update manifest is not one this daemon reads. Update it by hand once.", "EINVAL"));
    }
    let mv = manifest.get("version").and_then(Value::as_str).unwrap_or("").trim_start_matches('v').to_string();
    if mv != version {
        return Err(refuse(format!("The update manifest is for {mv}, not {version}."), "EINVAL"));
    }
    let Mode::Own { exe, .. } = &ctx.mode else {
        let code = if matches!(ctx.mode, Mode::App(_)) { "EAPP" } else { "EMANUAL" };
        return Err(refuse(ctx.mode.why().unwrap_or("This daemon cannot update itself."), code));
    };
    let key = ctx.key.as_ref().map_err(|why| refuse(why.clone(), "ENOKEY"))?;
    if manifest.get("signed").and_then(Value::as_bool) != Some(true) {
        return Err(refuse("This release is unsigned, so it is not installed. Update by hand, or wait for a signed release.", "EUNSIGNED"));
    }
    let Some(a) = manifest.get("daemon").and_then(|d| d.get(&ctx.target)) else {
        return Err(refuse(format!("Release {version} has no daemon for {}.", ctx.target), "ENOENT"));
    };
    let file = a.get("file").and_then(Value::as_str).unwrap_or("");
    let url = a.get("url").and_then(Value::as_str).unwrap_or("");
    let sha = a.get("sha256").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let size = a.get("size").and_then(Value::as_u64).unwrap_or(0) as usize;
    let sig = a.get("signature").and_then(Value::as_str).unwrap_or("");
    if file != daemon_file(&ctx.target) || sha.len() != 64 || size == 0 {
        return Err(refuse(format!("The update manifest's entry for {} is broken.", ctx.target), "EINVAL"));
    }
    let local = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
    if !url.starts_with("https://") && !local {
        return Err(refuse("The update address is not https. Nothing was downloaded.", "EINVAL"));
    }
    if sig.is_empty() {
        return Err(refuse("This release is unsigned, so it is not installed. Update by hand, or wait for a signed release.", "EUNSIGNED"));
    }

    let res = crate::net::request_limited("GET", url, &[], None, DOWNLOAD_TIMEOUT, size + 64 * 1024)
        .await
        .map_err(|e| refuse(format!("Could not download {file} ({e})."), "EUPDATE"))?;
    if res.status != 200 {
        return Err(refuse(format!("The release server answered {} for {file}.", res.status), "EUPDATE"));
    }
    let data = res.body;
    if data.len() != size {
        return Err(refuse(format!("{file} has {} bytes, the release says {size}. Nothing was installed.", data.len()), "EUPDATE"));
    }
    let got: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
    if got != sha {
        return Err(refuse(format!("{file} does not match the SHA-256 of the release. Nothing was installed."), "EUPDATE"));
    }
    verify(&data, sig, key).map_err(|e| refuse(e, "EUPDATE"))?;

    // next to the binary, so the swap is a rename on one disk
    let mut new_os = exe.as_os_str().to_owned();
    new_os.push(".new");
    let new = PathBuf::from(new_os);
    std::fs::write(&new, &data).map_err(|e| refuse(format!("Cannot write {}: {e}", new.display()), "EUPDATE"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755));
    }
    let said = probe(&new).await;
    let fail = |m: String| {
        let _ = std::fs::remove_file(&new);
        refuse(m, "EUPDATE")
    };
    match said {
        None => return Err(fail(format!("The downloaded daemon {version} does not start on this computer. Nothing was changed."))),
        Some(v) if compare_versions(&v, &version) != Ordering::Equal => return Err(fail(format!("The downloaded program says it is {v}, not {version}. Nothing was installed."))),
        _ => {}
    }
    swap(exe, &new).map_err(|e| fail(format!("Could not put the update in place ({e}). The old version stays.")))?;
    let mark = json!({ "from": ctx.current, "to": version, "at": now_ms(), "pending": true });
    let _ = std::fs::write(&ctx.mark, mark.to_string() + "\n");
    Ok(json!({ "from": ctx.current, "to": version, "restarting": true }))
}

/// The RPC as the server calls it: on success the daemon restarts a moment after the answer went out.
pub async fn self_update(params: Value) -> Result<Value, WireError> {
    let ctx = Ctx::real();
    let r = self_update_with(&ctx, &params).await?;
    if let Mode::Own { exe, restart } = ctx.mode {
        crate::logring::push(&format!("update: {} -> {} in place, restarting", ctx.current, r["to"].as_str().unwrap_or("")));
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            crate::procs::kill_all(crate::procs::Sig::Term);
            if restart == Restart::Respawn {
                respawn(&exe);
            }
            std::process::exit(0);
        });
    }
    Ok(r)
}

/// Start the new binary with this one's arguments, in the background (Windows).
fn respawn(exe: &Path) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut cmd = std::process::Command::new(exe);
    cmd.args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let _ = cmd.spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// From `tauri signer generate` and `tauri signer sign` over "conclave release bytes"; the private key was thrown away.
    const TAURI_PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM0NkJEQjQ3MEM2Q0MxQUQKUldTdHdXd01SOXRyTkZwNE84WHF0Rmk0UUMrWHZxK3FiOGdzYnZwQ3pIWkM1dVYySTVITmhJckMK";
    const TAURI_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTdHdXd01SOXRyTkg1dmVUZFRUMk4zVWlyODE4Z3NLVWVOa2UzMWVWblRqRmVzbFBWNmZidm5EM2k0NE9jOTBTbHBZSlVGeGlCRmRpZFNNMjNYWkNVRGpJMzNVSzNHMndjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNTk0ODY5CWZpbGU6ZGF0YS5iaW4KS0hrUm01bHIrRGFUeElwdklONEp1MDdWOURJWnpQeGJJMjBHTFNlbXJsV1l1RWZFY25iUGZVR2UzaGxOejNXVHlPUGU0RXJuTWJkMTF2ZDVjUktrQUE9PQo=";
    /// Another throwaway key, and its signature of a two line shell script that says 99.0.0 (the fake new daemon).
    const SCRIPT_PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDA0MDMwMjAxNUE1QTVBNUEKUldSYVdscGFBUUlEQk1ROUtPNTZMQ3E3dTY0SEVxS1VUODdYdXgwUGdRanlzWVBYQzFMNkZlMjUK";
    const SCRIPT_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSYVdscGFBUUlEQkZXY1N4eTZZMzV5YllXb0E1SHhRWWE5OWd0VXo3RXMrQzNFMmcxcEFnckFXS0cxTzdxa0dxcUlEK1pvOTFhaVhxZzMxdjNmZHNYOFhycmxkTW1jYlFRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzAwMDAwMDAwCWZpbGU6Y29uY2xhdmUtZGFlbW9uCm13ZlAyR3RLQXkzQThuelJ2WndaazZMTXZDLy9qdUxCTzZLVDBubGxMREtkZXhXN3E4bHNxemtUNEF3MXd3SVhhT3A5UlBPQTBQREQrQUo3c2sxVERBPT0K";
    const SCRIPT: &str = "#!/bin/sh\necho 99.0.0\n";
    const SCRIPT_SHA: &str = "213d53bd2501e3716c519856ac8f4ab4f912e1e4bf8f1afa506dc6dfbeaef2f8";

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("conclave-rsd-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_tauri_signature_checks_out_and_a_changed_file_does_not() {
        let key = read_key(TAURI_PUB).unwrap();
        assert_eq!(verify(b"conclave release bytes", TAURI_SIG, &key).unwrap(), "timestamp:1792594869\tfile:data.bin");
        assert!(verify(b"conclave release bytez", TAURI_SIG, &key).unwrap_err().contains("does not match"));
        // the bare key line is the same key
        let bare = minisign_text(TAURI_PUB).lines().nth(1).unwrap().to_string();
        assert!(verify(b"conclave release bytes", TAURI_SIG, &read_key(&bare).unwrap()).is_ok());
        // a signature from another key
        assert!(verify(SCRIPT.as_bytes(), SCRIPT_SIG, &key).unwrap_err().contains("another key"));
    }

    #[test]
    fn the_key_file_is_its_last_line_and_the_placeholder_is_no_key() {
        assert_eq!(key_line("# a\n# b\nRWQabc\n\n"), "RWQabc");
        assert_eq!(read_key("# comment\nPLACEHOLDER\n").unwrap_err(), NO_KEY);
        assert!(read_key("not a key").is_err());
        let committed = key_line(KEY_FILE);
        assert_eq!(embedded_key().is_ok(), !committed.eq_ignore_ascii_case("placeholder"));
    }

    #[test]
    fn versions_sort_like_manifest_ts() {
        assert_eq!(compare_versions("0.10.0", "0.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc.2"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0-rc.10", "1.0.0-rc.2"), Ordering::Greater);
        assert_eq!(compare_versions("v0.4.1", "0.4.1"), Ordering::Equal);
        assert!(is_newer("0.5.0", "0.4.1"));
        assert!(!is_newer("0.4.1", "0.4.1"));
        assert!(!is_newer("9.9.9", "test-123"));
        assert!(is_version("0.0.0-test"));
    }

    #[test]
    fn swap_keeps_the_old_binary_and_roll_back_puts_it_back() {
        let d = tmp("swap");
        let exe = d.join("conclave-daemon");
        let new = d.join("conclave-daemon.new");
        std::fs::write(&exe, "old").unwrap();
        std::fs::write(&new, "new").unwrap();
        swap(&exe, &new).unwrap();
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(prev_path(&exe)).unwrap(), "old");
        assert!(!new.exists());
        assert!(roll_back(&exe));
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "old");
        assert!(!roll_back(&exe));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_mark_says_how_the_last_update_went() {
        let d = tmp("mark");
        let f = d.join("daemon-update.json");
        std::fs::write(&f, r#"{"from":"0.4.1","to":"0.5.0","at":1,"pending":true}"#).unwrap();
        let v = settle_mark(&f, "0.5.0").unwrap();
        assert_eq!((v["ok"].as_bool(), v["to"].as_str()), (Some(true), Some("0.5.0")));
        // settled: read again it stays ok, and is no longer pending
        assert_eq!(settle_mark(&f, "0.5.0").unwrap()["ok"], json!(true));
        std::fs::write(&f, r#"{"from":"0.4.1","to":"0.5.0","at":1,"pending":true}"#).unwrap();
        let bad = settle_mark(&f, "0.4.1").unwrap();
        assert_eq!(bad["ok"], json!(false));
        assert!(bad["message"].as_str().unwrap().contains("not 0.5.0"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn cgroups_and_the_desktop_app_copy() {
        assert!(conclave_unit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/conclave-daemon.service\n"));
        assert!(!conclave_unit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome.scope\n"));
        assert!(!conclave_unit("0::/system.slice/tmux.service\n"));
        let d = tmp("app");
        assert!(!app_managed(&d));
        std::fs::write(d.join("bundled.stamp"), "0.5.0 1 2").unwrap();
        assert!(app_managed(&d));
        let _ = std::fs::remove_dir_all(&d);
    }

    fn manifest(url: &str, target: &str, signature: &str) -> Value {
        json!({
            "schema": 1, "version": "99.0.0", "signed": true, "hub": {}, "desktop": {},
            "daemon": { target: { "file": daemon_file(target), "url": url, "sha256": SCRIPT_SHA, "size": SCRIPT.len(), "signature": signature } }
        })
    }

    fn ctx(dir: &Path, mode: Mode, key: &str) -> Ctx {
        Ctx { current: "0.4.1".into(), target: "x86_64-unknown-linux-gnu".into(), mode, key: read_key(key), mark: dir.join("daemon-update.json") }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[test]
    fn the_first_checks_and_the_desktop_app_copy_refuse_before_any_download() {
        let d = tmp("refuse");
        let m = manifest("https://example.com/x", "x86_64-unknown-linux-gnu", SCRIPT_SIG);
        rt().block_on(async {
            let own = ctx(&d, Mode::Own { exe: d.join("conclave-daemon"), restart: Restart::Exit }, SCRIPT_PUB);
            let e = self_update_with(&own, &json!({ "version": "nope", "manifest": m })).await.unwrap_err();
            assert_eq!((e.message.as_str(), e.code.as_deref()), ("selfUpdate needs a version.", Some("EINVAL")));
            let e = self_update_with(&own, &json!({ "version": "0.4.1", "manifest": m })).await.unwrap_err();
            assert_eq!((e.message.as_str(), e.code.as_deref()), ("Conclave 0.4.1 is not newer than this daemon (0.4.1).", Some("EUPTODATE")));
            let app = ctx(&d, Mode::App("The desktop app updates this daemon with itself.".into()), SCRIPT_PUB);
            assert_eq!(self_update_with(&app, &json!({ "version": "99.0.0", "manifest": m })).await.unwrap_err().code.as_deref(), Some("EAPP"));
            let nokey = ctx(&d, Mode::Own { exe: d.join("conclave-daemon"), restart: Restart::Exit }, "PLACEHOLDER");
            assert_eq!(self_update_with(&nokey, &json!({ "version": "99.0.0", "manifest": m })).await.unwrap_err().code.as_deref(), Some("ENOKEY"));
            let mut unsigned = m.clone();
            unsigned["signed"] = json!(false);
            assert_eq!(self_update_with(&own, &json!({ "version": "99.0.0", "manifest": unsigned })).await.unwrap_err().code.as_deref(), Some("EUNSIGNED"));
        });
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Serve `body` to every request on a local port, `n` times.
    async fn serve(body: &'static [u8], n: usize) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}/conclave-daemon", l.local_addr().unwrap().port());
        tokio::spawn(async move {
            for _ in 0..n {
                let (mut s, _) = l.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
                let _ = s.write_all(head.as_bytes()).await;
                let _ = s.write_all(body).await;
                let _ = s.shutdown().await;
            }
        });
        url
    }

    #[cfg(unix)]
    #[test]
    fn download_check_and_replace_then_the_old_binary_stays() {
        let d = tmp("replace");
        let exe = d.join("conclave-daemon");
        std::fs::write(&exe, "#!/bin/sh\necho 0.4.1\n").unwrap();
        rt().block_on(async {
            let url = serve(SCRIPT.as_bytes(), 1).await;
            let c = ctx(&d, Mode::Own { exe: exe.clone(), restart: Restart::Exit }, SCRIPT_PUB);
            let r = self_update_with(&c, &json!({ "version": "99.0.0", "manifest": manifest(&url, "x86_64-unknown-linux-gnu", SCRIPT_SIG) })).await.unwrap();
            assert_eq!(r, json!({ "from": "0.4.1", "to": "99.0.0", "restarting": true }));
        });
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), SCRIPT);
        assert!(std::fs::read_to_string(prev_path(&exe)).unwrap().contains("0.4.1"));
        let mark: Value = serde_json::from_str(&std::fs::read_to_string(d.join("daemon-update.json")).unwrap()).unwrap();
        assert_eq!((mark["to"].as_str(), mark["pending"].as_bool()), (Some("99.0.0"), Some(true)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_wrong_signature_or_hash_changes_nothing() {
        let d = tmp("wrong");
        let exe = d.join("conclave-daemon");
        std::fs::write(&exe, "#!/bin/sh\necho 0.4.1\n").unwrap();
        rt().block_on(async {
            // signed by the Tauri test key, which this context does not trust
            let url = serve(SCRIPT.as_bytes(), 1).await;
            let c = ctx(&d, Mode::Own { exe: exe.clone(), restart: Restart::Exit }, TAURI_PUB);
            let e = self_update_with(&c, &json!({ "version": "99.0.0", "manifest": manifest(&url, "x86_64-unknown-linux-gnu", SCRIPT_SIG) })).await.unwrap_err();
            assert!(e.message.contains("another key"), "{}", e.message);
            // a file that is not the one the release names
            let url = serve(b"#!/bin/sh\necho 66.6.6\n", 1).await;
            let c = ctx(&d, Mode::Own { exe: exe.clone(), restart: Restart::Exit }, SCRIPT_PUB);
            let e = self_update_with(&c, &json!({ "version": "99.0.0", "manifest": manifest(&url, "x86_64-unknown-linux-gnu", SCRIPT_SIG) })).await.unwrap_err();
            assert!(e.message.contains("SHA-256"), "{}", e.message);
        });
        assert!(std::fs::read_to_string(&exe).unwrap().contains("0.4.1"));
        assert!(!prev_path(&exe).exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
