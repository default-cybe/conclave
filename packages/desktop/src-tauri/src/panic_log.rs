//! panic.log: the release build aborts on a panic (Cargo.toml, panic = "abort")
//! and a GUI app's stderr goes nowhere, so the hook writes the message, the
//! thread and the source location to panic.log in the app's log folder first:
//! ~/Library/Logs/dev.conclave.desktop on macOS,
//! %LOCALAPPDATA%\dev.conclave.desktop\logs on Windows and
//! ~/.local/share/dev.conclave.desktop/logs on Linux (Tauri's app_log_dir).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE: &str = "panic.log";

/// Chains onto the default hook, which still prints to stderr.
pub fn install(dir: PathBuf, version: String) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("(no message)");
        let at = info.location().map(|l| l.to_string()).unwrap_or_else(|| "(unknown)".into());
        let thread = std::thread::current();
        let _ = append(&dir, &entry(&version, thread.name().unwrap_or("(unnamed)"), &at, msg));
        prev(info);
    }));
}

fn entry(version: &str, thread: &str, at: &str, msg: &str) -> String {
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("unix {t}, app {version}, thread {thread}, panicked at {at}: {msg}\n")
}

fn append(dir: &Path, line: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    OpenOptions::new().create(true).append(true).open(dir.join(FILE))?.write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_names_its_message_thread_and_place_in_the_log() {
        let dir = std::env::temp_dir().join(format!("conclave-panic-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        install(dir.clone(), "9.9.9".into());
        let r = std::thread::Builder::new().name("meeting-test".into()).spawn(|| panic!("ivar {:?} not found", "focusable")).unwrap().join();
        // back to the default hook, so other tests print as usual
        let _ = std::panic::take_hook();
        assert!(r.is_err());
        let log = fs::read_to_string(dir.join(FILE)).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert!(log.contains("app 9.9.9, thread meeting-test, panicked at src/panic_log.rs:"), "{log}");
        assert!(log.contains(": ivar \"focusable\" not found\n"), "{log}");
    }
}
