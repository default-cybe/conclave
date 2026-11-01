//! The daemon's recent log, for the hub's logs export (the logTail RPC of
//! protocol 3, packages/core/src/logs/ring.ts). The status lines of this run
//! stay in a ring in memory, and the end of ~/.conclave/logs/daemon.log comes
//! along when the service writes one (Windows and macOS). Everything goes
//! through the secrets filter before it leaves the device.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Lines kept in memory.
pub const RING_LINES: usize = 1000;
const MAX_LINE: usize = 1000;
/// Bytes read from the end of daemon.log.
const FILE_TAIL_BYTES: u64 = 256 * 1024;

struct Ring {
    lines: VecDeque<String>,
    started_at: u64,
}

fn ring() -> &'static Mutex<Ring> {
    static RING: OnceLock<Mutex<Ring>> = OnceLock::new();
    RING.get_or_init(|| {
        let started_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Mutex::new(Ring {
            lines: VecDeque::new(),
            started_at,
        })
    })
}

fn cut(s: &str) -> String {
    if s.chars().count() <= MAX_LINE {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_LINE).collect();
    out.push_str("...");
    out
}

/// Keep one line of this run.
pub fn push(line: &str) {
    let clean = line.trim_end();
    if clean.is_empty() {
        return;
    }
    let mut r = ring().lock().unwrap_or_else(|e| e.into_inner());
    r.lines.push_back(cut(clean));
    while r.lines.len() > RING_LINES {
        r.lines.pop_front();
    }
}

/// The last n lines of this run, oldest first.
pub fn tail(n: usize) -> Vec<String> {
    let r = ring().lock().unwrap_or_else(|e| e.into_inner());
    let skip = r.lines.len().saturating_sub(n);
    r.lines.iter().skip(skip).cloned().collect()
}

/// The last lines of a text file, read from its end.
pub fn file_tail(path: &Path, n: usize) -> Option<Vec<String>> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let len = size.min(FILE_TAIL_BYTES);
    f.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    if size > len && !lines.is_empty() {
        lines.remove(0);
    }
    let kept: Vec<String> = lines
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .map(String::from)
        .collect();
    let skip = kept.len().saturating_sub(n);
    Some(kept.into_iter().skip(skip).collect())
}

/// What the logTail RPC answers (DaemonLogTail in packages/core/src/client/logs.ts).
pub fn log_tail(lines: usize, file: Option<&Path>) -> Value {
    let n = lines.clamp(1, RING_LINES);
    let clean = |l: &String| cut(&crate::import::secrets::redact(l));
    let mine: Vec<String> = tail(n).iter().map(clean).collect();
    let started_at = ring().lock().unwrap_or_else(|e| e.into_inner()).started_at;
    let mut out = json!({ "impl": "rust", "version": crate::info::VERSION, "startedAt": started_at, "lines": mine });
    if let Some(found) = file.and_then(|p| file_tail(p, n)).filter(|v| !v.is_empty()) {
        out["file"] = json!(found.iter().map(clean).collect::<Vec<_>>());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_last_lines_and_filters_secrets() {
        for i in 0..(RING_LINES + 5) {
            push(&format!("line {i}"));
        }
        push("a key went by sk-ant-api03-PLANTEDfakeKEY0123456789abcdefABCDEF");
        let t = tail(3);
        assert_eq!(t.len(), 3);
        assert_eq!(t[0], format!("line {}", RING_LINES + 3));
        let v = log_tail(2, None);
        assert_eq!(v["impl"], "rust");
        let lines = v["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 2);
        assert!(!lines[1].as_str().unwrap().contains("PLANTED"));
        assert!(v.get("file").is_none());
    }

    #[test]
    fn reads_the_end_of_a_file() {
        let dir = std::env::temp_dir().join(format!("conclave-logring-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("daemon.log");
        let body: String = (0..50).map(|i| format!("old {i}\n")).collect();
        std::fs::write(&p, body).unwrap();
        assert_eq!(
            file_tail(&p, 2).unwrap(),
            vec!["old 48".to_string(), "old 49".to_string()]
        );
        assert!(file_tail(&dir.join("missing"), 2).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
