//! importAppend (protocol 5): Conclave's turns appended to a Claude Code chat
//! on this device, ported from packages/core/src/import/writeback.ts
//! (appendSession, busySession). The hub builds the rows; here the chat must
//! not be open in a Claude Code process, the file must be the one the hub
//! read, and the rows go in with one O_APPEND write and an fsync.

use crate::errors::{fs_error, Res, WireError};
use crate::js::{as_str, num};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

const TAIL_HASH_BYTES: u64 = 4096;

fn is_session_id(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5 && parts.iter().zip([8usize, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// writeback.ts CLAUDE_BIN: the native binary, or the npm package's cli.js under node.
fn is_claude_bin(a: &str) -> bool {
    let name = a.rsplit(|c: char| c == '/' || c == '\\').next().unwrap_or(a);
    let cli = a.replace('\\', "/");
    name == "claude" || name == "claude.exe" || cli.ends_with("claude-code/cli.js") || cli.ends_with("claude-code/cli.mjs")
}

/// A live Claude Code process with this chat open (writeback.ts busySession).
pub fn busy(path: &str, session_id: &str, cwd: Option<&str>) -> Option<String> {
    let me = std::process::id();
    // the file sits in <claude dir>/projects/<project>/; Claude Code lists its live chats in <claude dir>/sessions
    if let Some(claude) = Path::new(path).parent().and_then(Path::parent).and_then(Path::parent) {
        if let Ok(rd) = fs::read_dir(claude.join("sessions")) {
            for e in rd.flatten() {
                let Ok(text) = fs::read_to_string(e.path()) else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                if as_str(v.get("sessionId")) != Some(session_id) {
                    continue;
                }
                let Some(pid) = v.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()) else { continue };
                if pid != me && crate::service::pid_alive(Some(pid)) {
                    return Some(format!("sessions/{} pid {pid}", e.file_name().to_string_lossy()));
                }
            }
        }
    }
    // shortcut: no /proc on macOS or Windows, so only the sessions entry counts there; add a ps scan if a device shows the gap
    let Ok(rd) = fs::read_dir("/proc") else { return None };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) || name == me.to_string() {
            continue;
        }
        let Ok(raw) = fs::read(format!("/proc/{name}/cmdline")) else { continue };
        let argv: Vec<String> = raw.split(|b| *b == 0).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
        if !argv.iter().take(2).any(|a| is_claude_bin(a)) {
            continue;
        }
        if argv.iter().any(|a| a.contains(session_id)) {
            return Some(format!("pid {name} has the chat in its arguments"));
        }
        if let Some(c) = cwd {
            if fs::read_link(format!("/proc/{name}/cwd")).ok().as_deref() == Some(Path::new(c)) {
                return Some(format!("pid {name} runs in {c}"));
            }
        }
    }
    None
}

/// The importAppend RPC: busy, changed, partialTail, else one append and fsync.
pub fn append(params: &Value) -> Res<Value> {
    let path = as_str(params.get("path")).unwrap_or("");
    let sid = as_str(params.get("sessionId")).unwrap_or("");
    // first, as LocalMachine.importAppend checks it
    crate::private::check(path)?;
    // either separator: a Windows device reports backslash paths, as path.basename takes them in the TS daemon
    let file = path.rsplit(|c: char| c == '/' || c == '\\').next().unwrap_or(path);
    if !is_session_id(sid) || file != format!("{sid}.jsonl") {
        return Err(WireError::coded("importAppend needs a Claude Code session file named after its session id.", "EINVAL"));
    }
    let text = as_str(params.get("text"));
    let expect = params.get("expect");
    let size = expect.and_then(|e| e.get("size")).and_then(Value::as_f64);
    let tail = as_str(expect.and_then(|e| e.get("tail")));
    let (Some(text), Some(size), Some(tail)) = (text.filter(|t| t.ends_with('\n')), size, tail) else {
        return Err(WireError::coded("importAppend needs whole lines and the file the hub read.", "EINVAL"));
    };
    if let Some(b) = busy(path, sid, as_str(params.get("cwd"))) {
        return Ok(json!({ "ok": false, "reason": "busy", "detail": b }));
    }
    // read and append through one handle; no create, so a file that is gone stays gone
    let mut f = OpenOptions::new().read(true).append(true).open(path).map_err(|e| fs_error(&e, "open", Some(path)))?;
    let len = f.metadata().map_err(|e| fs_error(&e, "fstat", Some(path)))?.len();
    let n = len.min(TAIL_HASH_BYTES);
    let mut buf = vec![0u8; n as usize];
    f.seek(SeekFrom::Start(len - n)).and_then(|_| f.read_exact(&mut buf)).map_err(|e| fs_error(&e, "read", Some(path)))?;
    let hash: String = Sha256::digest(&buf).iter().map(|b| format!("{b:02x}")).collect();
    if len as f64 != size || hash != tail {
        return Ok(json!({ "ok": false, "reason": "changed" }));
    }
    if n > 0 && buf[n as usize - 1] != b'\n' {
        return Ok(json!({ "ok": false, "reason": "partialTail" }));
    }
    f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| fs_error(&e, "write", Some(path)))?;
    let md = f.metadata().map_err(|e| fs_error(&e, "fstat", Some(path)))?;
    Ok(json!({ "ok": true, "size": md.len(), "mtime": num(crate::fsops::mtime_ms(&md)) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "11111111-2222-4333-8444-555555555555";

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cv-wb-{}-{}", std::process::id(), crate::import::new_id("t")));
        fs::create_dir_all(d.join("projects").join("-p")).unwrap();
        d
    }

    fn hash(b: &[u8]) -> String {
        let s = &b[b.len().saturating_sub(4096)..];
        Sha256::digest(s).iter().map(|x| format!("{x:02x}")).collect()
    }

    #[cfg(unix)]
    #[test]
    fn appends_once_and_refuses_a_changed_busy_or_cut_file() {
        let d = tmp();
        let file = d.join("projects").join("-p").join(format!("{SID}.jsonl"));
        let path = file.to_string_lossy().into_owned();
        fs::write(&file, "{\"a\":1}\n").unwrap();
        let p = |size: usize, tail: &str| json!({ "path": path, "sessionId": SID, "text": "{\"b\":2}\n", "expect": { "size": size, "tail": tail } });
        let r = append(&p(8, &hash(b"{\"a\":1}\n"))).unwrap();
        assert_eq!((r["ok"].as_bool(), r["size"].as_u64()), (Some(true), Some(16)));
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":1}\n{\"b\":2}\n");
        // the hub read the file before that write
        assert_eq!(append(&p(8, &hash(b"{\"a\":1}\n"))).unwrap()["reason"], "changed");
        fs::write(&file, "{\"a\":1}\n{\"cut").unwrap();
        assert_eq!(append(&p(13, &hash(b"{\"a\":1}\n{\"cut"))).unwrap()["reason"], "partialTail");
        // a live process (the one that runs the tests) has the chat open
        fs::create_dir_all(d.join("sessions")).unwrap();
        let parent = std::os::unix::process::parent_id();
        fs::write(d.join("sessions").join("1.json"), json!({ "pid": parent, "sessionId": SID }).to_string()).unwrap();
        assert_eq!(append(&p(13, &hash(b"{\"a\":1}\n{\"cut"))).unwrap()["reason"], "busy");
        let bad = append(&json!({ "path": d.join("x.jsonl").to_string_lossy(), "sessionId": SID, "text": "x\n", "expect": { "size": 0, "tail": "" } })).unwrap_err();
        assert_eq!(bad.code.as_deref(), Some("EINVAL"));
        // a Windows path passes the name check (then is not found here)
        let win = append(&json!({ "path": format!("C:\\Users\\u\\.claude\\projects\\-p\\{SID}.jsonl"), "sessionId": SID, "text": "x\n", "expect": { "size": 0, "tail": "" } })).unwrap_err();
        assert_ne!(win.code.as_deref(), Some("EINVAL"));
        assert!(is_claude_bin("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js") && is_claude_bin("/home/u/.local/bin/claude") && !is_claude_bin("claude-tool"));
        fs::remove_dir_all(&d).unwrap();
    }
}
