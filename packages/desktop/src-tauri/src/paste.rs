//! What the clipboard holds when the hub page's paste event came empty.
//!
//! WKWebView (macOS) often hands the page a paste with no files for a
//! screenshot, a picture copied in Preview or Photos, or a file copied in
//! Finder. The page then asks here (main.rs paste_files, web
//! lib/pasteFiles.ts). WebKitGTK (Linux) does the same for a screenshot, so
//! Linux reads the GTK clipboard. WebView2 (Windows) usually puts the picture
//! or the copied files in the paste event, but not a picture an app put on
//! the clipboard only as the registered "PNG" format (Chromium
//! clipboard_win.cc lists image/png for CF_DIB only), so Windows reads the
//! Win32 clipboard: copied files (CF_HDROP), else "PNG", else the DIB as a BMP.

use std::path::PathBuf;

#[derive(Default)]
pub struct Pasted {
    /// Files copied in Finder or Explorer; the page reads them with read_dropped.
    pub paths: Vec<PathBuf>,
    /// A picture's bytes and type: image/png, or image/tiff or image/bmp the page turns into a PNG.
    pub image: Option<(Vec<u8>, &'static str)>,
}

#[cfg(target_os = "macos")]
pub fn read() -> Pasted {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
    use objc2_foundation::NSURL;

    let board = NSPasteboard::generalPasteboard();
    let file_url = unsafe { NSPasteboardTypeFileURL };
    let paths: Vec<PathBuf> = board
        .pasteboardItems()
        .map(|items| items.to_vec())
        .unwrap_or_default()
        .iter()
        .filter_map(|item| item.stringForType(file_url))
        .filter_map(|s| NSURL::URLWithString(&s))
        // Finder copies file reference URLs (file:///.file/id=...): resolve them to a path
        .filter_map(|url| url.filePathURL())
        .filter_map(|url| url.path())
        .map(|p| PathBuf::from(p.to_string()))
        .collect();
    if !paths.is_empty() {
        return Pasted { paths, image: None };
    }
    let types = unsafe { [(NSPasteboardTypePNG, "image/png"), (NSPasteboardTypeTIFF, "image/tiff")] };
    let image = types.into_iter().find_map(|(t, mime)| board.dataForType(t).map(|d| (d.to_vec(), mime)));
    Pasted { paths, image }
}

/// WebKitGTK hands the page a screenshot paste with no file (Spectacle, GNOME
/// Screenshot, grim | wl-copy), so the GTK clipboard is read: copied files as
/// file:// URIs, else the picture, saved as PNG.
#[cfg(target_os = "linux")]
pub fn read() -> Pasted {
    // GTK panics off its main thread; sync commands run there, so this only guards
    if !gtk::is_initialized_main_thread() {
        return Pasted::default();
    }
    let board = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    let paths: Vec<PathBuf> = board
        .wait_for_uris()
        .iter()
        .filter_map(|u| tauri::Url::parse(u).ok()?.to_file_path().ok())
        .collect();
    if !paths.is_empty() {
        return Pasted { paths, image: None };
    }
    let image = board.wait_for_image().and_then(|p| p.save_to_bufferv("png", &[]).ok()).map(|b| (b, "image/png"));
    Pasted { paths, image }
}

#[cfg(windows)]
pub fn read() -> Pasted {
    use windows::core::w;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW};
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    const CF_DIB: u32 = 8;
    const CF_HDROP: u32 = 15;

    /// Closes the clipboard however read returns.
    struct Open;
    impl Drop for Open {
        fn drop(&mut self) {
            let _ = unsafe { CloseClipboard() };
        }
    }

    /// A format's bytes, copied out while the clipboard is open.
    fn bytes(format: u32) -> Option<Vec<u8>> {
        let handle = unsafe { GetClipboardData(format) }.ok()?;
        let mem = HGLOBAL(handle.0);
        let ptr = unsafe { GlobalLock(mem) } as *const u8;
        if ptr.is_null() {
            return None;
        }
        let out = unsafe { std::slice::from_raw_parts(ptr, GlobalSize(mem)) }.to_vec();
        let _ = unsafe { GlobalUnlock(mem) };
        Some(out)
    }

    if unsafe { OpenClipboard(None) }.is_err() {
        return Pasted::default();
    }
    let _open = Open;
    let paths = bytes(CF_HDROP).map(|b| drop_paths(&b)).unwrap_or_default();
    if !paths.is_empty() {
        return Pasted { paths, image: None };
    }
    let png = unsafe { RegisterClipboardFormatW(w!("PNG")) };
    let image = (png != 0)
        .then(|| bytes(png))
        .flatten()
        .map(|b| (b, "image/png"))
        .or_else(|| bytes(CF_DIB).and_then(|d| dib_to_bmp(&d)).map(|b| (b, "image/bmp")));
    Pasted { paths, image }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn read() -> Pasted {
    Pasted::default()
}

/// The paths in a CF_HDROP block: a DROPFILES header (where the list starts
/// at 0, fWide at 16), then names that each end in NUL, then an empty name.
// shortcut: a non-wide list is read as UTF-8, not the ANSI code page; Explorer always sets fWide
#[cfg_attr(not(windows), allow(dead_code))]
fn drop_paths(b: &[u8]) -> Vec<PathBuf> {
    let u32_at = |i: usize| b.get(i..i + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]));
    let (Some(start), Some(wide)) = (u32_at(0), u32_at(16)) else { return Vec::new() };
    let list = b.get(start as usize..).unwrap_or_default();
    let names: Vec<String> = if wide != 0 {
        let units: Vec<u16> = list.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        units.split(|&u| u == 0).take_while(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
    } else {
        list.split(|&c| c == 0).take_while(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
    };
    names.into_iter().map(PathBuf::from).collect()
}

/// A CF_DIB (BITMAPINFOHEADER or a later one, color masks or table, pixels)
/// as a .bmp file: the 14-byte file header in front, which says where the
/// pixels start. None for a block too short or a header no DIB has.
#[cfg_attr(not(windows), allow(dead_code))]
fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    let u32_at = |i: usize| dib.get(i..i + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as u64);
    let header = u32_at(0)?;
    if !(40..=124).contains(&header) || (dib.len() as u64) < header {
        return None;
    }
    let bits = u16::from_le_bytes([dib[14], dib[15]]);
    let compression = u32_at(16)?;
    let used = u32_at(32)?;
    // a plain 40-byte header keeps its masks after it: 3 for BI_BITFIELDS, 4 for BI_ALPHABITFIELDS
    let masks = match (header, compression) {
        (40, 3) => 12,
        (40, 6) => 16,
        _ => 0,
    };
    let colors = if used > 0 { used } else if (1..=8).contains(&bits) { 1 << bits } else { 0 };
    let offset = 14 + header + masks + colors * 4;
    let total = 14 + dib.len() as u64;
    if offset > total {
        return None;
    }
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&u32::try_from(total).ok()?.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(offset as u32).to_le_bytes());
    out.extend_from_slice(dib);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(size: u32, bits: u16, compression: u32, used: u32) -> Vec<u8> {
        let mut h = vec![0u8; size as usize];
        h[0..4].copy_from_slice(&size.to_le_bytes());
        h[14..16].copy_from_slice(&bits.to_le_bytes());
        h[16..20].copy_from_slice(&compression.to_le_bytes());
        h[32..36].copy_from_slice(&used.to_le_bytes());
        h
    }

    fn off_bits(bmp: &[u8]) -> u32 {
        u32::from_le_bytes([bmp[10], bmp[11], bmp[12], bmp[13]])
    }

    #[test]
    fn a_32_bit_screenshot_dib_with_masks() {
        // what Windows makes of a Snipping Tool picture: 40-byte header, BI_BITFIELDS, 3 masks, pixels
        let mut dib = header(40, 32, 3, 0);
        dib.extend_from_slice(&[0; 12 + 16]);
        let bmp = dib_to_bmp(&dib).unwrap();
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(u32::from_le_bytes([bmp[2], bmp[3], bmp[4], bmp[5]]) as usize, 14 + dib.len());
        assert_eq!(off_bits(&bmp), 14 + 40 + 12);
        assert_eq!(&bmp[14..], &dib[..]);
    }

    #[test]
    fn color_tables_and_v5_headers() {
        let mut eight = header(40, 8, 0, 0);
        eight.extend_from_slice(&[0; 256 * 4 + 4]);
        assert_eq!(off_bits(&dib_to_bmp(&eight).unwrap()), 14 + 40 + 1024);
        let mut used = header(40, 8, 0, 16);
        used.extend_from_slice(&[0; 16 * 4 + 4]);
        assert_eq!(off_bits(&dib_to_bmp(&used).unwrap()), 14 + 40 + 64);
        let mut v5 = header(124, 32, 3, 0);
        v5.extend_from_slice(&[0; 16]);
        assert_eq!(off_bits(&dib_to_bmp(&v5).unwrap()), 14 + 124);
    }

    #[test]
    fn not_a_dib() {
        assert!(dib_to_bmp(&[]).is_none());
        assert!(dib_to_bmp(&header(12, 24, 0, 0)).is_none());
        // a color table that runs past the block
        assert!(dib_to_bmp(&header(40, 8, 0, 0)).is_none());
        assert!(dib_to_bmp(&header(40, 8, 0, u32::MAX)).is_none());
    }

    #[test]
    fn explorer_copied_files() {
        let mut b = vec![0u8; 20];
        b[0..4].copy_from_slice(&20u32.to_le_bytes());
        b[16..20].copy_from_slice(&1u32.to_le_bytes());
        for name in ["C:\\Users\\me\\shot.png", "D:\\a b\\résumé.pdf"] {
            b.extend(name.encode_utf16().chain([0]).flat_map(u16::to_le_bytes));
        }
        b.extend_from_slice(&[0, 0]);
        assert_eq!(drop_paths(&b), vec![PathBuf::from("C:\\Users\\me\\shot.png"), PathBuf::from("D:\\a b\\résumé.pdf")]);
        let mut ansi = vec![0u8; 20];
        ansi[0..4].copy_from_slice(&20u32.to_le_bytes());
        ansi.extend_from_slice(b"C:\\x.txt\0\0");
        assert_eq!(drop_paths(&ansi), vec![PathBuf::from("C:\\x.txt")]);
        assert!(drop_paths(&[0; 4]).is_empty());
    }
}
