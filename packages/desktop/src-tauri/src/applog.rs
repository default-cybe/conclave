//! app.log: what the app's `log::info!`/`warn!`/`error!` calls say, in the same
//! folder as panic.log (~/Library/Logs/dev.conclave.desktop on macOS, Tauri's
//! app_log_dir elsewhere). A GUI app's stderr goes nowhere, so without this the
//! meeting's STT, socket and upload errors were invisible. One line per record,
//! UTC time first. At 5 MB the file moves to app.log.1 (one old file kept).
//! This app's own records from info up; other crates' only from warn up.
//! Never log audio, transcript text or tokens here.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE: &str = "app.log";
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub struct FileLog {
    dir: PathBuf,
    max: u64,
    file: Mutex<Option<(File, u64)>>,
}

static LOGGER: OnceLock<FileLog> = OnceLock::new();

/// Once, at startup. A second call (or a logger set elsewhere) is ignored.
pub fn install(dir: PathBuf, version: &str) {
    let logger = LOGGER.get_or_init(|| FileLog::new(dir, MAX_BYTES));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    log::info!("app {version} started on {} {}", std::env::consts::OS, std::env::consts::ARCH);
}

impl FileLog {
    pub fn new(dir: PathBuf, max: u64) -> Self {
        FileLog { dir, max, file: Mutex::new(None) }
    }

    pub fn write_line(&self, line: &str) {
        let Ok(mut slot) = self.file.lock() else { return };
        if slot.as_ref().is_some_and(|(_, len)| *len >= self.max) {
            *slot = None;
            let _ = fs::rename(self.dir.join(FILE), self.dir.join(format!("{FILE}.1")));
        }
        if slot.is_none() {
            let _ = fs::create_dir_all(&self.dir);
            let Ok(f) = OpenOptions::new().create(true).append(true).open(self.dir.join(FILE)) else { return };
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            *slot = Some((f, len));
        }
        if let Some((f, len)) = slot.as_mut() {
            if f.write_all(line.as_bytes()).is_ok() {
                *len += line.len() as u64;
            }
        }
    }
}

fn wanted(level: log::Level, target: &str) -> bool {
    level <= log::Level::Warn || (level <= log::Level::Info && target.starts_with("conclave"))
}

impl log::Log for FileLog {
    fn enabled(&self, m: &log::Metadata) -> bool {
        wanted(m.level(), m.target())
    }

    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let target = r.target().strip_prefix("conclave_desktop::").unwrap_or(r.target());
        self.write_line(&format!("{} {:<5} {target}: {}\n", utc(ms), r.level(), r.args()));
    }

    fn flush(&self) {
        if let Ok(mut slot) = self.file.lock() {
            if let Some((f, _)) = slot.as_mut() {
                let _ = f.flush();
            }
        }
    }
}

/// Unix ms as `2026-11-01T09:30:00.123Z` (days to civil date: Howard Hinnant's algorithm).
pub fn utc(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let (h, min, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}.{milli:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_times_are_iso() {
        assert_eq!(utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(utc(1_793_525_400_123), "2026-11-01T09:30:00.123Z");
    }

    #[test]
    fn only_this_apps_info_and_everyones_warnings() {
        assert!(wanted(log::Level::Info, "conclave_desktop::meeting::cloud"));
        assert!(!wanted(log::Level::Debug, "conclave_desktop::meeting"));
        assert!(!wanted(log::Level::Info, "rustls::client"));
        assert!(wanted(log::Level::Warn, "tungstenite"));
    }

    #[test]
    fn the_file_rotates_at_its_cap_and_keeps_one_old_file() {
        let dir = std::env::temp_dir().join(format!("conclave-applog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let log = FileLog::new(dir.clone(), 100);
        for i in 0..30 {
            log.write_line(&format!("line {i:02}\n"));
        }
        let now = fs::read_to_string(dir.join(FILE)).unwrap();
        let old = fs::read_to_string(dir.join(format!("{FILE}.1"))).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert!(now.len() as u64 <= 100 && old.len() as u64 >= 100, "{} {}", now.len(), old.len());
        assert!(now.ends_with("line 29\n"));
    }
}
