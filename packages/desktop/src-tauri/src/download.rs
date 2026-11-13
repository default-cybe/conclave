// Downloads the hub page asks for (web lib/saveFile.ts). WebKitGTK, the Linux
// webview, drops an <a download> of a blob: or data: URL and the app denies
// window.open of anything but http, https and mailto (main.rs new_window), so
// the page hands the bytes over and the app writes them: to Downloads, under a
// name that never replaces a file there, or to a folder of its own cache for
// "Open in the default app". Every OS takes the same path, so it behaves alike.

use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

/// The most the page may hand over at once, as decoded bytes (web lib/saveFile.ts
/// APP_SAVE_MAX): base64 over IPC is a third bigger and the webview holds it too.
pub const MAX_BYTES: usize = 100 * 1024 * 1024;

/// Kinds the app opens in their default app: documents and media, never a
/// program, script, shortcut or installer a hub page could have written.
const OPENABLE: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf", "mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a", "txt", "md", "csv",
    "json",
];

/// The file name a page asked for, safe to join to a folder: no folders, no
/// characters a file system refuses, no leading dot, no Windows device name,
/// at most 120 characters. Empty becomes "download".
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(|c: char| c == '/' || c == '\\').next().unwrap_or("");
    let mut out: String = base
        .chars()
        // bidi controls too: "invoice\u{202E}fdp.exe" would show as invoiceexe.pdf
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}') { '_' } else { c })
        .collect();
    out = out.trim().trim_start_matches('.').trim_end_matches(|c: char| c == '.' || c == ' ').to_string();
    if out.chars().count() > 120 {
        let (stem, ext) = split_ext(&out);
        let ext: String = ext.chars().take(16).collect();
        let keep = 120 - ext.chars().count();
        out = format!("{}{}", stem.chars().take(keep).collect::<String>(), ext);
    }
    let stem = split_ext(&out).0.to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        out = format!("_{out}");
    }
    if out.is_empty() {
        "download".into()
    } else {
        out
    }
}

/// "chart.png" into ("chart", ".png"); a name with no dot has no extension.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// The nth name tried for `name`: "chart.png", then "chart (1).png", "chart (2).png".
pub fn numbered(name: &str, n: u32) -> String {
    if n == 0 {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    format!("{stem} ({n}){ext}")
}

/// Writes `bytes` into `dir` under `name`, or the first numbered name that is
/// free. create_new, so a file that appears meanwhile is never replaced.
pub fn write_unique(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not make {}: {e}", dir.display()))?;
    let name = safe_name(name);
    for n in 0..10_000 {
        let path = dir.join(numbered(&name, n));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                f.write_all(bytes).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not save {}: {e}", path.display())),
        }
    }
    Err(format!("Could not find a free name for {name} in {}.", dir.display()))
}

/// True for a kind the app may hand to the default app.
pub fn openable(name: &str) -> bool {
    let ext = split_ext(name).1.trim_start_matches('.').to_ascii_lowercase();
    OPENABLE.contains(&ext.as_str())
}

/// The page's base64, decoded, under MAX_BYTES.
pub fn decode(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    if data.len() / 4 * 3 > MAX_BYTES + 3 {
        return Err(format!("The file is over {} MB.", MAX_BYTES / 1024 / 1024));
    }
    base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("The file did not arrive whole: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_never_leaves_its_folder_or_trips_the_file_system() {
        assert_eq!(safe_name("chart.png"), "chart.png");
        assert_eq!(safe_name("../../.bashrc"), "bashrc");
        assert_eq!(safe_name("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_name("a:b?c*.txt"), "a_b_c_.txt");
        assert_eq!(safe_name("  "), "download");
        assert_eq!(safe_name(".."), "download");
        assert_eq!(safe_name("con.txt"), "_con.txt");
        assert_eq!(safe_name("COM1"), "_COM1");
        assert_eq!(safe_name("compute.txt"), "compute.txt");
        assert_eq!(safe_name("invoice\u{202E}fdp.exe"), "invoice_fdp.exe");
        let long = format!("{}.png", "x".repeat(300));
        let cut = safe_name(&long);
        assert_eq!(cut.chars().count(), 120);
        assert!(cut.ends_with(".png"));
    }

    #[test]
    fn a_second_save_of_the_same_name_gets_a_number_and_replaces_nothing() {
        assert_eq!(numbered("chart.png", 0), "chart.png");
        assert_eq!(numbered("chart.png", 2), "chart (2).png");
        assert_eq!(numbered("README", 1), "README (1)");
        assert_eq!(numbered("archive.tar.gz", 1), "archive.tar (1).gz");
        let dir = std::env::temp_dir().join(format!("conclave-dl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = write_unique(&dir, "chart.png", b"one").unwrap();
        let b = write_unique(&dir, "chart.png", b"two").unwrap();
        let c = write_unique(&dir, "../chart.png", b"three").unwrap();
        assert_eq!(a, dir.join("chart.png"));
        assert_eq!(b, dir.join("chart (1).png"));
        assert_eq!(c, dir.join("chart (2).png"));
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        assert_eq!(std::fs::read(&b).unwrap(), b"two");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_documents_and_media_open_in_their_app() {
        assert!(openable("report.PDF"));
        assert!(openable("shot.png"));
        assert!(!openable("run.sh"));
        assert!(!openable("setup.exe"));
        assert!(!openable("app.desktop"));
        assert!(!openable("page.html"));
        assert!(!openable("noext"));
    }

    #[test]
    fn the_bytes_decode_and_junk_is_refused() {
        assert_eq!(decode("aGk=").unwrap(), b"hi");
        assert!(decode("not base64!").is_err());
    }

    #[test]
    fn over_the_cap_is_refused_before_decoding() {
        let over = "A".repeat((MAX_BYTES / 3 + 2) * 4);
        assert!(decode(&over).unwrap_err().contains("over 100 MB"));
    }
}
