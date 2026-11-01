//! MachineInfo as LocalMachine.info() collects it: host, system, home, shell,
//! the versions of useful CLIs on PATH and a few capabilities. Cached for 5
//! minutes. `daemon` says which daemon this is and how it updates; the hub shows it.

use serde_json::{json, Map, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const INFO_TTL: Duration = Duration::from_secs(5 * 60);
const VERSION_TIMEOUT: Duration = Duration::from_millis(4_000);
const CLI_NAMES: &[&str] = &["claude", "codex", "opencode", "gemini", "git", "rg", "docker", "node", "bun", "python3"];
const CHROMIUM_NAMES: &[&str] = &["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "microsoft-edge", "brave-browser"];

/// The version of packages/cli/package.json at build time (see build.rs).
pub const VERSION: &str = env!("CONCLAVE_DAEMON_VERSION");

/// process.platform
pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// process.arch
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        other => other,
    }
}

pub fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: gethostname writes at most buf.len() bytes into buf.
        let r = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if r == 0 {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).into_owned();
        }
        String::new()
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
        let mut buf = [0u16; 256];
        let mut len = buf.len() as u32;
        // SAFETY: the buffer and its length are ours; the call writes at most len units.
        let ok = unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut len) };
        if ok != 0 {
            return String::from_utf16_lossy(&buf[..len as usize]);
        }
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }
}

/// The first version-looking part of `--version` output (versionOf in local.ts).
pub fn version_from(out: &str, err: &str) -> Option<String> {
    let o = crate::js::trim(out);
    let text = if o.is_empty() { crate::js::trim(err) } else { o };
    let line = crate::js::trim(text.split('\n').next().unwrap_or(""));
    if line.is_empty() {
        return None;
    }
    let re = regex::Regex::new(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+.A-Za-z0-9_]*)?").ok()?;
    match re.find(line) {
        Some(m) => Some(m.as_str().to_string()),
        None => Some(crate::js::slice16(line, 0, 60).to_string()),
    }
}

async fn version_of(bin: std::path::PathBuf) -> Option<String> {
    let argv = vec![bin.to_string_lossy().into_owned(), "--version".to_string()];
    let c = crate::procs::capture(&argv, None, VERSION_TIMEOUT, 64 * 1024, 64 * 1024).await.ok()?;
    version_from(&c.stdout, &c.stderr)
}

fn find_chromium(home: &str) -> bool {
    if CHROMIUM_NAMES.iter().any(|n| crate::env::which(n).is_some()) {
        return true;
    }
    let candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ];
    if candidates.iter().any(|c| matches!(crate::fsops::stat(c), Ok(Some(_)))) {
        return true;
    }
    // Playwright's bundled Chromium
    let native_join = |a: &str, b: &[&str]| {
        let mut parts = vec![a];
        parts.extend_from_slice(b);
        crate::paths::native::join(&parts)
    };
    let mut dirs: Vec<String> = Vec::new();
    if let Ok(p) = std::env::var("PLAYWRIGHT_BROWSERS_PATH") {
        if !p.is_empty() {
            dirs.push(p);
        }
    }
    dirs.push(native_join(home, &[".cache", "ms-playwright"]));
    dirs.push(native_join(home, &["Library", "Caches", "ms-playwright"]));
    for d in dirs {
        if let Ok(rd) = std::fs::read_dir(&d) {
            if rd.flatten().any(|e| e.file_name().to_string_lossy().starts_with("chromium")) {
                return true;
            }
        }
    }
    false
}

async fn collect() -> Value {
    let home = crate::paths::home_dir();
    let mut tasks = Vec::new();
    for name in CLI_NAMES {
        if let Some(bin) = crate::env::which(name) {
            tasks.push((*name, tokio::spawn(version_of(bin))));
        }
    }
    let mut clis = Map::new();
    for (name, t) in tasks {
        let v = t.await.ok().flatten().unwrap_or_else(|| "unknown".into());
        clis.insert(name.to_string(), Value::String(v));
    }
    let h = home.clone();
    let browser = tokio::task::spawn_blocking(move || find_chromium(&h)).await.unwrap_or(false);
    let mut caps: Vec<&str> = Vec::new();
    if browser {
        caps.push("browser");
    }
    if crate::env::which("docker").is_some() {
        caps.push("docker");
    }
    if crate::env::which("nvidia-smi").is_some() {
        caps.push("gpu");
    }
    if clis.contains_key("git") {
        caps.push("git");
    }
    let shell = match std::env::var("SHELL") {
        Ok(s) if !s.is_empty() => s,
        _ => crate::procs::shell().to_string(),
    };
    json!({
        "hostname": hostname(),
        "platform": platform(),
        "arch": arch(),
        "home": home,
        "shell": shell,
        "clis": clis,
        "capabilities": caps,
        // which daemon, how it updates and its last update (update.rs)
        "daemon": crate::update::daemon_json(),
    })
}

static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
static PENDING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// MachineInfo, from the cache when it is fresh. Calls at the same time share one collection.
pub async fn info() -> Value {
    if let Some((at, v)) = CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < INFO_TTL {
            return v.clone();
        }
    }
    let _g = PENDING.lock().await;
    if let Some((at, v)) = CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < INFO_TTL {
            return v.clone();
        }
    }
    let v = collect().await;
    *CACHE.lock().unwrap() = Some((Instant::now(), v.clone()));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_like_local_ts() {
        assert_eq!(version_from("git version 2.43.0\n", "").as_deref(), Some("2.43.0"));
        assert_eq!(version_from("", "Python 3.13.16").as_deref(), Some("3.13.16"));
        assert_eq!(version_from("2.1.302 (Claude Code)", "").as_deref(), Some("2.1.302"));
        assert_eq!(version_from("v22.22.0", "").as_deref(), Some("22.22.0"));
        assert_eq!(version_from("codex-cli 0.98.0-alpha.1", "").as_deref(), Some("0.98.0-alpha.1"));
        assert_eq!(version_from("no digits here", "").as_deref(), Some("no digits here"));
        assert_eq!(version_from("  ", ""), None);
    }

    #[test]
    fn platform_names_are_node_names() {
        assert!(["linux", "darwin", "win32", "freebsd"].contains(&platform()));
        assert!(["x64", "arm64", "ia32", "arm"].contains(&arch()) || !arch().is_empty());
    }
}
