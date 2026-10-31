//! macOS capture exclusion, panel behaviour and the window list for share
//! detection (MEETING-MODE.md 7.3, 7.4). Our own code with the documented
//! AppKit and CoreGraphics calls; tauri-nspanel (MIT OR Apache-2.0) does the
//! NSPanel class swap. `sharingType = .none` is ignored by ScreenCaptureKit
//! captures on macOS 15+, so share detection stays on here.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSWindowCollectionBehavior, NSWindowSharingType, NSWindowStyleMask};
use objc2_core_graphics::{kCGNullWindowID, CGWindowListCopyWindowInfo, CGWindowListOption};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
use tauri::{Runtime, WebviewWindow};
use tauri_nspanel::{tauri_panel, Panel, WebviewWindowExt};

use super::share_watch::Win;
use super::wire::Exclusion;

tauri_panel! {
    panel!(MeetingPanel {
        config: {
            can_become_key_window: true,
            becomes_key_only_if_needed: true,
            is_floating_panel: true
        }
    })
}

/// Non-activating panel at floating level (4), on every Space and over full-screen apps,
/// out of Cmd-Tab and window cycling. Main thread only.
pub fn make_panel<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let panel = window.to_panel::<MeetingPanel<R>>().map_err(|e| e.to_string())?;
    let mask = panel.as_panel().styleMask() | NSWindowStyleMask::NonactivatingPanel;
    panel.set_style_mask(mask).map_err(|e| format!("{e:?}"))?;
    panel.set_level(4);
    panel.set_collection_behavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Transient
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    panel.set_hides_on_deactivate(false);
    Ok(())
}

/// `sharingType = .none` on every window of the app, set only where the
/// read-back differs (WindowServer can reset it on activation policy changes).
/// Main thread only; None off the main thread.
pub fn ensure_all() -> Option<Exclusion> {
    let mtm = MainThreadMarker::new()?;
    let app = NSApplication::sharedApplication(mtm);
    let mut ok = true;
    for w in app.windows().iter() {
        if w.sharingType() != NSWindowSharingType::None {
            w.setSharingType(NSWindowSharingType::None);
            ok &= w.sharingType() == NSWindowSharingType::None;
        }
    }
    Some(if ok { Exclusion::Excluded } else { Exclusion::Failed })
}

fn string(d: &NSDictionary<NSString, AnyObject>, key: &str) -> String {
    d.objectForKey(&NSString::from_str(key))
        .and_then(|v| v.downcast::<NSString>().ok())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

fn number(d: &NSDictionary<NSString, AnyObject>, key: &str) -> i64 {
    d.objectForKey(&NSString::from_str(key))
        .and_then(|v| v.downcast::<NSNumber>().ok())
        .map(|n| n.integerValue() as i64)
        .unwrap_or(-1)
}

/// On-screen windows of other processes. Window names need the Screen
/// Recording permission; without it only owner names come back.
pub fn visible_windows() -> Vec<Win> {
    let Some(list) = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly, kCGNullWindowID) else {
        return Vec::new();
    };
    // CFArray of CFDictionary is toll-free bridged to NSArray of NSDictionary
    let ptr = objc2_core_foundation::CFRetained::as_ptr(&list).as_ptr() as *mut NSArray<NSDictionary<NSString, AnyObject>>;
    let Some(list) = (unsafe { Retained::retain(ptr) }) else { return Vec::new() };
    let me = std::process::id() as i64;
    list.iter()
        .filter(|d| number(d, "kCGWindowOwnerPID") != me)
        .map(|d| Win { process: string(&d, "kCGWindowOwnerName"), class: String::new(), title: string(&d, "kCGWindowName") })
        .collect()
}
