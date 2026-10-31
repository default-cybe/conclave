//! The speech model on disk: `<app data>/models/parakeet-tdt-0.6b-v2-int8/`
//! (MEETING-MODE.md 8). Downloaded once from Hugging Face at a pinned
//! revision, each file checked against its SHA-256 before it is moved in place.
//!
// The file list and sizes are adapted from
// zackriya-solutions/meetily@a2cb62e:frontend/src-tauri/src/parakeet_engine/parakeet_engine.rs:107-136
// (PARAKEET_V2_ARTIFACTS). Original licence: MIT. Copyright (c) 2024 Zackriya Solutions.
// The MIT permission notice is in src/meeting/vad.rs. Changed: SHA-256 per file,
// Hugging Face instead of Meetily's server, std + ureq instead of tokio + reqwest.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

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

/// The files still missing (or of the wrong size). A file only gets its
/// final name after its hash matched, so size is enough here.
pub fn missing(dir: &Path) -> Vec<&'static Artifact> {
    ARTIFACTS
        .iter()
        .filter(|a| fs::metadata(dir.join(a.name)).map(|m| m.len() != a.bytes).unwrap_or(true))
        .collect()
}

/// Download what is missing; `progress` gets 0..1 over all files.
pub fn ensure(dir: &Path, mut progress: impl FnMut(f32)) -> Result<(), String> {
    let todo = missing(dir);
    if todo.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let total: u64 = todo.iter().map(|a| a.bytes).sum();
    let mut done = 0u64;
    let agent = ureq::AgentBuilder::new()
        .resolver(crate::hub::Ipv4First)
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .build();
    for a in todo {
        let resp = agent.get(&format!("{BASE}/{}", a.name)).call().map_err(|e| format!("speech model download: {e}"))?;
        let part = dir.join(format!("{}.part", a.name));
        let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
        let got = copy_hashing(resp.into_reader(), &mut file, |n| progress((done + n) as f32 / total as f32))?;
        drop(file);
        if let Err(e) = check(a, &got) {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
        fs::rename(&part, dir.join(a.name)).map_err(|e| e.to_string())?;
        done += a.bytes;
    }
    progress(1.0);
    Ok(())
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
pub fn copy_hashing(mut from: impl Read, to: &mut impl Write, mut on_bytes: impl FnMut(u64)) -> Result<Got, String> {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 256 * 1024];
    let mut bytes = 0u64;
    let mut reported = 0u64;
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
    let sha256 = ctx.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect();
    Ok(Got { bytes, sha256 })
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
    fn missing_lists_absent_and_wrong_size_files() {
        let dir = std::env::temp_dir().join(format!("conclave-models-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("vocab.txt"), vec![0u8; 9_384]).unwrap();
        fs::write(dir.join("nemo128.onnx"), b"short").unwrap();
        let names: Vec<_> = missing(&dir).iter().map(|a| a.name).collect();
        assert_eq!(names, ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "nemo128.onnx"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
