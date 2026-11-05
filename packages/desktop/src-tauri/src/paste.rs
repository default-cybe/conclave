//! What the clipboard holds when the hub page's paste event came empty.
//!
//! WKWebView (macOS) often hands the page a paste with no files for a
//! screenshot, a picture copied in Preview or Photos, or a file copied in
//! Finder. The page then asks here (main.rs paste_files, web
//! lib/pasteFiles.ts). Other systems answer empty: their webviews put the
//! picture in the paste event.

use std::path::PathBuf;

#[derive(Default)]
pub struct Pasted {
    /// Files copied in Finder; the page reads them with read_dropped.
    pub paths: Vec<PathBuf>,
    /// A picture's bytes and type: image/png, or image/tiff the page turns into a PNG.
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

#[cfg(not(target_os = "macos"))]
pub fn read() -> Pasted {
    Pasted::default()
}
