//! File RPCs with LocalMachine's semantics: stat follows links but reports a
//! dangling link as a symlink, writeFile and rename create parent folders,
//! remove refuses a folder unless recursive, errors read like Node's.

use crate::errors::{code_error, fs_error, is_not_found, rename_error, Res, WireError};
use crate::js::{encode_base64, num};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

/// Base64 of 32 MB stays under the hub's 64 MB message limit (MAX_READ_BYTES in machine/protocol.ts).
pub const READ_RANGE_MAX: u64 = 32 * 1024 * 1024;

pub fn mtime_ms(m: &fs::Metadata) -> f64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6
    }
    #[cfg(not(unix))]
    {
        match m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()) {
            Some(d) => d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6,
            None => 0.0,
        }
    }
}

pub struct Stat {
    pub kind: &'static str,
    pub size: u64,
    pub mtime_ms: f64,
}

impl Stat {
    pub fn to_json(&self) -> Value {
        json!({ "type": self.kind, "size": self.size, "mtimeMs": num(self.mtime_ms) })
    }
}

fn kind_of(ft: &fs::FileType) -> &'static str {
    if ft.is_dir() {
        "dir"
    } else if ft.is_file() {
        "file"
    } else if ft.is_symlink() {
        "symlink"
    } else {
        "other"
    }
}

/// LocalMachine.stat: null when missing; a dangling symlink still exists as a link.
pub fn stat(path: &str) -> Res<Option<Stat>> {
    match fs::metadata(path) {
        Ok(m) => {
            let ft = m.file_type();
            let kind = if ft.is_dir() {
                "dir"
            } else if ft.is_file() {
                "file"
            } else {
                "other"
            };
            Ok(Some(Stat { kind, size: m.len(), mtime_ms: mtime_ms(&m) }))
        }
        Err(e) => {
            if !is_not_found(&e) {
                return Err(fs_error(&e, "stat", Some(path)));
            }
            match fs::symlink_metadata(path) {
                Ok(l) if l.file_type().is_symlink() => Ok(Some(Stat { kind: "symlink", size: l.len(), mtime_ms: mtime_ms(&l) })),
                _ => Ok(None),
            }
        }
    }
}

pub fn stat_json(path: &str) -> Res<Value> {
    Ok(stat(path)?.map(|s| s.to_json()).unwrap_or(Value::Null))
}

fn eisdir_read() -> WireError {
    WireError::coded("EISDIR: illegal operation on a directory, read", "EISDIR")
}

/// Open for reading. A directory fails as Node's read does, on every system.
fn open_read(path: &str) -> Res<fs::File> {
    match fs::File::open(path) {
        Ok(f) => {
            if f.metadata().map(|m| m.is_dir()).unwrap_or(false) {
                return Err(eisdir_read());
            }
            Ok(f)
        }
        Err(e) => {
            if !is_not_found(&e) && fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false) {
                return Err(eisdir_read());
            }
            Err(fs_error(&e, "open", Some(path)))
        }
    }
}

fn read_err(e: io::Error) -> WireError {
    fs_error(&e, "read", None)
}

pub fn read_bytes(path: &str) -> Res<Vec<u8>> {
    let mut f = open_read(path)?;
    let mut buf = Vec::new();
    if let Ok(m) = f.metadata() {
        if m.is_file() {
            buf.reserve(m.len() as usize);
        }
    }
    f.read_to_end(&mut buf).map_err(read_err)?;
    Ok(buf)
}

pub fn read_file(path: &str) -> Res<Value> {
    Ok(Value::String(encode_base64(&read_bytes(path)?)))
}

/// fs.readFile(path, 'utf8'): bad bytes become U+FFFD, a BOM stays.
pub fn read_text_string(path: &str) -> Res<String> {
    let bytes = read_bytes(path)?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

pub fn read_text(path: &str) -> Res<Value> {
    Ok(Value::String(read_text_string(path)?))
}

/// Up to `length` bytes from `offset` (at most READ_RANGE_MAX).
pub fn read_range(path: &str, offset: f64, length: f64) -> Res<Value> {
    let mut f = open_read(path)?;
    let want = if length.is_nan() { 0.0 } else { length.clamp(0.0, READ_RANGE_MAX as f64) } as u64;
    let off = if offset.is_nan() { 0.0 } else { offset.max(0.0) } as u64;
    f.seek(SeekFrom::Start(off)).map_err(read_err)?;
    let mut buf = Vec::with_capacity(want.min(1 << 20) as usize);
    f.take(want).read_to_end(&mut buf).map_err(read_err)?;
    Ok(Value::String(encode_base64(&buf)))
}

/// fs.mkdir(path, { recursive: true }) with Node's errors (the requested path is named).
pub fn mkdir_p(path: &str) -> Res<()> {
    fn go(p: &Path, original: &str) -> Result<(), WireError> {
        match fs::create_dir(p) {
            Ok(()) => Ok(()),
            Err(e) => {
                let code = crate::errors::errno_code(&e);
                if code == "EEXIST" || (cfg!(windows) && e.kind() == io::ErrorKind::AlreadyExists) {
                    if fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false) {
                        return Ok(());
                    }
                    return Err(code_error("EEXIST", "mkdir", original));
                }
                if code == "ENOENT" {
                    if let Some(parent) = p.parent() {
                        if parent != p && !parent.as_os_str().is_empty() {
                            go(parent, original)?;
                            return match fs::create_dir(p) {
                                Ok(()) => Ok(()),
                                Err(e2) if crate::errors::errno_code(&e2) == "EEXIST" && fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false) => Ok(()),
                                Err(e2) => Err(fs_error(&e2, "mkdir", Some(original))),
                            };
                        }
                    }
                }
                Err(fs_error(&e, "mkdir", Some(original)))
            }
        }
    }
    if path.is_empty() {
        return Err(code_error("ENOENT", "mkdir", path));
    }
    go(Path::new(path), path)
}

fn dirname(path: &str) -> String {
    crate::paths::native::dirname(path)
}

/// Creates parent directories, then writes.
pub fn write_file(path: &str, data: &[u8]) -> Res<()> {
    mkdir_p(&dirname(path))?;
    fs::write(path, data).map_err(|e| fs_error(&e, "open", Some(path)))
}

pub fn readdir(path: &str) -> Res<Value> {
    let rd = fs::read_dir(path).map_err(|e| fs_error(&e, "scandir", Some(path)))?;
    let mut out: Vec<(String, &'static str)> = Vec::new();
    for ent in rd {
        let ent = ent.map_err(|e| fs_error(&e, "scandir", Some(path)))?;
        let name = ent.file_name().to_string_lossy().into_owned();
        let kind = ent.file_type().map(|t| kind_of(&t)).unwrap_or("other");
        out.push((name, kind));
    }
    // sizes are cheap to add for normal-sized directories
    let sizes = out.len() <= 2000;
    let list: Vec<Value> = out
        .into_iter()
        .map(|(name, kind)| {
            let mut o = serde_json::Map::new();
            if sizes && kind == "file" {
                if let Ok(m) = fs::symlink_metadata(Path::new(path).join(&name)) {
                    o.insert("name".into(), Value::String(name));
                    o.insert("type".into(), Value::String(kind.into()));
                    o.insert("size".into(), Value::from(m.len()));
                    return Value::Object(o);
                }
            }
            o.insert("name".into(), Value::String(name));
            o.insert("type".into(), Value::String(kind.into()));
            Value::Object(o)
        })
        .collect();
    Ok(Value::Array(list))
}

/// fs.rm(path, { recursive, force: false }).
pub fn remove(path: &str, recursive: bool) -> Res<()> {
    let m = fs::symlink_metadata(path).map_err(|e| fs_error(&e, "lstat", Some(path)))?;
    if m.is_dir() {
        if !recursive {
            return Err(WireError::coded(format!("Path is a directory: rm returned EISDIR (is a directory) {path}"), "ERR_FS_EISDIR"));
        }
        return fs::remove_dir_all(path).map_err(|e| fs_error(&e, "rm", Some(path)));
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        // a directory symlink on Windows is removed as a directory
        #[cfg(windows)]
        Err(_) if m.file_type().is_symlink() => fs::remove_dir(path).map_err(|e| fs_error(&e, "unlink", Some(path))),
        Err(e) => Err(fs_error(&e, "unlink", Some(path))),
    }
}

/// Creates the target's parent, then renames.
pub fn rename(from: &str, to: &str) -> Res<()> {
    mkdir_p(&dirname(to))?;
    fs::rename(from, to).map_err(|e| rename_error(&e, from, to))
}

pub fn is_dir(path: &str) -> bool {
    matches!(stat(path), Ok(Some(s)) if s.kind == "dir")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        let d = std::env::temp_dir().join(format!("conclave-rsd-fs-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn errors_read_like_node() {
        let d = tmp("errors");
        fs::write(format!("{d}/f.txt"), "hi").unwrap();
        fs::create_dir(format!("{d}/sub")).unwrap();
        let e = read_bytes(&format!("{d}/nope")).unwrap_err();
        assert_eq!(e.message, format!("ENOENT: no such file or directory, open '{d}/nope'"));
        assert_eq!(e.code.as_deref(), Some("ENOENT"));
        let e = read_bytes(&format!("{d}/sub")).unwrap_err();
        assert_eq!(e.message, "EISDIR: illegal operation on a directory, read");
        let e = mkdir_p(&format!("{d}/f.txt")).unwrap_err();
        assert_eq!(e.message, format!("EEXIST: file already exists, mkdir '{d}/f.txt'"));
        let e = mkdir_p(&format!("{d}/f.txt/a")).unwrap_err();
        assert_eq!(e.message, format!("ENOTDIR: not a directory, mkdir '{d}/f.txt/a'"));
        let e = write_file(&format!("{d}/f.txt/a"), b"x").unwrap_err();
        assert_eq!(e.message, format!("EEXIST: file already exists, mkdir '{d}/f.txt'"));
        let e = remove(&format!("{d}/sub"), false).unwrap_err();
        assert_eq!(e.code.as_deref(), Some("ERR_FS_EISDIR"));
        assert_eq!(e.message, format!("Path is a directory: rm returned EISDIR (is a directory) {d}/sub"));
        let e = rename(&format!("{d}/nope"), &format!("{d}/b")).unwrap_err();
        assert_eq!(e.message, format!("ENOENT: no such file or directory, rename '{d}/nope' -> '{d}/b'"));
        let e = readdir(&format!("{d}/f.txt")).unwrap_err();
        assert_eq!(e.message, format!("ENOTDIR: not a directory, scandir '{d}/f.txt'"));
        let e = read_range(&format!("{d}/sub"), 0.0, 10.0).unwrap_err();
        assert_eq!(e.message, "EISDIR: illegal operation on a directory, read");
        fs::remove_dir_all(&d).ok();
    }

    #[cfg(unix)]
    #[test]
    fn stat_reports_dangling_links() {
        let d = tmp("links");
        std::os::unix::fs::symlink("/nonexistent-target", format!("{d}/dangling")).unwrap();
        let s = stat(&format!("{d}/dangling")).unwrap().unwrap();
        assert_eq!(s.kind, "symlink");
        assert!(stat(&format!("{d}/missing")).unwrap().is_none());
        fs::write(format!("{d}/f"), "x").unwrap();
        assert!(stat(&format!("{d}/f/under")).unwrap().is_none());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn write_creates_parents_and_ranges_read() {
        let d = tmp("write");
        write_file(&format!("{d}/a/b/c.txt"), b"hello world").unwrap();
        assert_eq!(read_text_string(&format!("{d}/a/b/c.txt")).unwrap(), "hello world");
        let v = read_range(&format!("{d}/a/b/c.txt"), 6.0, 100.0).unwrap();
        assert_eq!(v, Value::String(encode_base64(b"world")));
        let v = read_range(&format!("{d}/a/b/c.txt"), 100.0, 5.0).unwrap();
        assert_eq!(v, Value::String(String::new()));
        rename(&format!("{d}/a/b/c.txt"), &format!("{d}/x/y.txt")).unwrap();
        assert!(stat(&format!("{d}/x/y.txt")).unwrap().is_some());
        remove(&format!("{d}/a"), true).unwrap();
        assert!(stat(&format!("{d}/a")).unwrap().is_none());
        fs::remove_dir_all(&d).ok();
    }
}
