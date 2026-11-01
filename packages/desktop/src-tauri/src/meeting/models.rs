//! The speech model on disk: `<app data>/models/parakeet-tdt-0.6b-v2-int8/`
//! (MEETING-MODE.md 8). Downloaded once from Hugging Face at a pinned
//! revision, each file checked against its SHA-256 before it is moved in place.
//! `verified.json` records each checked file's size, SHA-256 and mtime: a file
//! that still matches its record is used as it is, with no hashing and no
//! download at meeting start. A right-sized file without a matching record is
//! hashed once (not downloaded again). An interrupted download resumes from its
//! `.part` file with a Range request instead of starting at 0.
//!
// The file list and sizes are adapted from
// zackriya-solutions/meetily@a2cb62e:frontend/src-tauri/src/parakeet_engine/parakeet_engine.rs:107-136
// (PARAKEET_V2_ARTIFACTS). Original licence: MIT. Copyright (c) 2024 Zackriya Solutions.
// The MIT permission notice is in src/meeting/vad.rs. Changed: SHA-256 per file,
// Hugging Face instead of Meetily's server, std + ureq instead of tokio + reqwest.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const MODEL_NAME: &str = "parakeet-tdt-0.6b-v2-int8";
const BASE: &str = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/0bbb45a3365852604aef28b538a8f066f4ccaa85";

pub struct Artifact {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// Sizes and hashes from the Hugging Face tree at that revision (LFS oids are SHA-256).
pub const ARTIFACTS: &[Artifact] = &[
    Artifact { name: "encoder-model.int8.onnx", bytes: 652_184_014, sha256: "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155" },
    Artifact { name: "decoder_joint-model.int8.onnx", bytes: 8_998_286, sha256: "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3" },
    Artifact { name: "nemo128.onnx", bytes: 139_764, sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f" },
    Artifact { name: "vocab.txt", bytes: 9_384, sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d" },
];

pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("models").join(MODEL_NAME)
}

pub const MARKER: &str = "verified.json";
/// Tries per file; each try after the first resumes where the last one stopped.
const TRIES: u32 = 3;

/// One checked file as `verified.json` records it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    /// Matches its record: used as it is.
    Ready,
    /// The right size but no matching record: hash it once.
    Verify,
    /// Missing or the wrong size.
    Download,
}

fn read_marks(dir: &Path) -> Vec<Mark> {
    fs::read(dir.join(MARKER)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// The record the file on disk would have, if it has the artifact's size.
fn current(dir: &Path, a: &Artifact) -> Option<Mark> {
    let meta = fs::metadata(dir.join(a.name)).ok()?;
    let mtime_ms = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    (meta.len() == a.bytes).then(|| Mark { name: a.name.into(), bytes: a.bytes, sha256: a.sha256.into(), mtime_ms })
}

pub fn need(dir: &Path, a: &Artifact, marks: &[Mark]) -> Need {
    match current(dir, a) {
        None => Need::Download,
        Some(m) if marks.contains(&m) => Need::Ready,
        Some(_) => Need::Verify,
    }
}

/// Every file is there and matches its record: nothing to hash or download.
pub fn ready(dir: &Path) -> bool {
    let marks = read_marks(dir);
    ARTIFACTS.iter().all(|a| need(dir, a, &marks) == Need::Ready)
}

/// Hash what has no record and download what is missing; `progress` gets 0..1 over the downloads.
pub fn ensure(dir: &Path, progress: impl FnMut(f32)) -> Result<(), String> {
    ensure_from(dir, ARTIFACTS, BASE, progress)
}

/// One download at a time: two starts must never write the same `.part` file.
static BUSY: Mutex<()> = Mutex::new(());

pub fn ensure_from(dir: &Path, artifacts: &[Artifact], base: &str, mut progress: impl FnMut(f32)) -> Result<(), String> {
    let _one = BUSY.lock().unwrap_or_else(|p| p.into_inner());
    let marks = read_marks(dir);
    let needs: Vec<Need> = artifacts.iter().map(|a| need(dir, a, &marks)).collect();
    if needs.iter().all(|n| *n == Need::Ready) {
        return Ok(());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut todo = Vec::new();
    for (a, n) in artifacts.iter().zip(needs) {
        if n == Need::Verify {
            let started = Instant::now();
            let file = fs::File::open(dir.join(a.name)).map_err(|e| e.to_string())?;
            let got = copy_hashing(file, &mut std::io::sink(), |_| {})?;
            if check(a, &got).is_ok() {
                log::info!("meeting: speech model file {} verified in {} ms", a.name, started.elapsed().as_millis());
                continue;
            }
            log::warn!("meeting: speech model file {} failed its checksum; downloading it again", a.name);
            let _ = fs::remove_file(dir.join(a.name));
            todo.push(a);
        } else if n == Need::Download {
            todo.push(a);
        }
    }
    let total: u64 = todo.iter().map(|a| a.bytes).sum::<u64>().max(1);
    let mut done = 0u64;
    if !todo.is_empty() {
        let agent = ureq::AgentBuilder::new()
            .resolver(crate::hub::Ipv4First)
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(30))
            .build();
        for a in todo {
            let started = Instant::now();
            let mut last = String::new();
            let mut ok = false;
            for _ in 0..TRIES {
                match download(&agent, base, dir, a, |n| progress((done + n) as f32 / total as f32)) {
                    Ok(()) => {
                        ok = true;
                        break;
                    }
                    Err(e) => {
                        log::warn!("meeting: speech model download of {}: {e}", a.name);
                        last = e;
                    }
                }
            }
            if !ok {
                return Err(last);
            }
            log::info!("meeting: speech model file {} downloaded in {} s", a.name, started.elapsed().as_secs());
            done += a.bytes;
        }
    }
    let marks: Vec<Mark> = artifacts.iter().filter_map(|a| current(dir, a)).collect();
    let tmp = dir.join(format!("{MARKER}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(&marks).unwrap_or_default()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(MARKER)).map_err(|e| e.to_string())?;
    progress(1.0);
    Ok(())
}

/// One file into `<name>.part`, resumed with a Range request when a part is there,
/// checked, then moved to its name. A part that cannot be resumed is started again.
fn download(agent: &ureq::Agent, base: &str, dir: &Path, a: &Artifact, mut progress: impl FnMut(u64)) -> Result<(), String> {
    let part = dir.join(format!("{}.part", a.name));
    let mut have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have >= a.bytes {
        let _ = fs::remove_file(&part);
        have = 0;
    }
    let mut req = agent.get(&format!("{base}/{}", a.name));
    if have > 0 {
        req = req.set("Range", &format!("bytes={have}-"));
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(416, _)) => {
            let _ = fs::remove_file(&part);
            return Err("speech model download: the partial file could not be resumed".into());
        }
        Err(e) => return Err(format!("speech model download: {e}")),
    };
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let resumed = have > 0 && resp.status() == 206;
    let mut file = if resumed {
        log::info!("meeting: resuming {} at {have} bytes", a.name);
        let old = fs::File::open(&part).map_err(|e| e.to_string())?;
        feed(&mut ctx, old.take(have), &mut std::io::sink(), 0, |_| {})?;
        fs::OpenOptions::new().append(true).open(&part).map_err(|e| e.to_string())?
    } else {
        have = 0;
        fs::File::create(&part).map_err(|e| e.to_string())?
    };
    let bytes = feed(&mut ctx, resp.into_reader(), &mut file, have, &mut progress)?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    let got = Got { bytes, sha256: hex(ctx.finish().as_ref()) };
    if let Err(e) = check(a, &got) {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, dir.join(a.name)).map_err(|e| e.to_string())
}

pub struct Got {
    pub bytes: u64,
    pub sha256: String,
}

pub fn check(a: &Artifact, got: &Got) -> Result<(), String> {
    if got.bytes != a.bytes || got.sha256 != a.sha256 {
        return Err(format!("speech model file {} did not match its checksum", a.name));
    }
    Ok(())
}

/// Copy while hashing; `on_bytes` at most once per MiB.
pub fn copy_hashing(from: impl Read, to: &mut impl Write, on_bytes: impl FnMut(u64)) -> Result<Got, String> {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let bytes = feed(&mut ctx, from, to, 0, on_bytes)?;
    Ok(Got { bytes, sha256: hex(ctx.finish().as_ref()) })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hash and copy `from` into `to`; byte counts (and `on_bytes`) start at `start`.
fn feed(ctx: &mut ring::digest::Context, mut from: impl Read, to: &mut impl Write, start: u64, mut on_bytes: impl FnMut(u64)) -> Result<u64, String> {
    let mut buf = vec![0u8; 256 * 1024];
    let mut bytes = start;
    let mut reported = start;
    loop {
        let n = from.read(&mut buf).map_err(|e| format!("speech model download: {e}"))?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
        to.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        bytes += n as u64;
        if bytes - reported >= 1 << 20 {
            reported = bytes;
            on_bytes(bytes);
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_while_copying_and_checks() {
        let mut out = Vec::new();
        let got = copy_hashing(&b"abc"[..], &mut out, |_| {}).unwrap();
        assert_eq!(out, b"abc");
        assert_eq!(got.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let a = Artifact { name: "x", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
        assert!(check(&a, &got).is_ok());
        let wrong = Artifact { sha256: "00", ..a };
        assert!(check(&wrong, &got).is_err());
    }

    #[test]
    fn absent_and_wrong_size_files_download_and_unrecorded_ones_verify() {
        let dir = std::env::temp_dir().join(format!("conclave-models-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vocab.txt"), vec![0u8; 9_384]).unwrap();
        fs::write(dir.join("nemo128.onnx"), b"short").unwrap();
        let needs: Vec<_> = ARTIFACTS.iter().map(|a| need(&dir, a, &[])).collect();
        assert_eq!(needs, [Need::Download, Need::Download, Need::Download, Need::Verify]);
        assert!(!ready(&dir));
        fs::remove_dir_all(&dir).unwrap();
    }

    const HELLO: Artifact =
        Artifact { name: "t.bin", bytes: 11, sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9" };

    /// Serves `body` for any GET, honouring `Range: bytes=N-` with a 206; records each Range asked for.
    fn server(body: &'static [u8]) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let rec = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut from = 0usize;
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        from = v.trim().trim_end_matches('-').parse().unwrap();
                        rec.lock().unwrap().push(v.trim().to_string());
                    }
                    line.clear();
                }
                let (code, rest) = if from > 0 { (206, &body[from..]) } else { (200, body) };
                let _ = write!(stream, "HTTP/1.1 {code} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", rest.len());
                let _ = stream.write_all(rest);
            }
        });
        (base, seen)
    }

    #[test]
    fn a_part_file_resumes_and_a_recorded_file_is_never_touched_again() {
        let dir = std::env::temp_dir().join(format!("conclave-models-resume-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("t.bin.part"), b"hello ").unwrap();
        let (base, seen) = server(b"hello world");
        ensure_from(&dir, &[HELLO], &base, |_| {}).unwrap();
        assert_eq!(fs::read(dir.join("t.bin")).unwrap(), b"hello world");
        assert_eq!(*seen.lock().unwrap(), ["6-"]);
        assert!(!dir.join("t.bin.part").exists());
        let marks = read_marks(&dir);
        assert_eq!(need(&dir, &HELLO, &marks), Need::Ready);

        // recorded: no network at all (this address refuses connections)
        let before = fs::metadata(dir.join("t.bin")).unwrap().modified().unwrap();
        ensure_from(&dir, &[HELLO], "http://127.0.0.1:1", |_| {}).unwrap();
        // no record (an older app): hashed once, not downloaded, and recorded again
        fs::remove_file(dir.join(MARKER)).unwrap();
        ensure_from(&dir, &[HELLO], "http://127.0.0.1:1", |_| {}).unwrap();
        assert_eq!(fs::metadata(dir.join("t.bin")).unwrap().modified().unwrap(), before);
        assert_eq!(need(&dir, &HELLO, &read_marks(&dir)), Need::Ready);
        assert_eq!(seen.lock().unwrap().len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
