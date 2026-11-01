//! Share detection (MEETING-MODE.md 7.4): the `meeting-share` thread looks at
//! the visible top-level windows every 250 ms, and when a screen share,
//! recording or screenshot looks under way, the overlay hides at once. It comes
//! back 1 s after the signal is gone.
//!
//! Every row of `SIGNALS` is UNVERIFIED until checked on a real machine (the
//! owner's checklist, docs/design/MEETING-SHARE-CHECKLIST.md). Matching is
//! case-insensitive substring matching on the process image name and on the
//! window class or title.

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
}

pub struct Signal {
    pub os: Os,
    /// Process image name (Windows) or window owner name (macOS), lower case.
    pub process: &'static str,
    /// A lower-case piece of the window class or title; "" matches any window of the process.
    pub class_or_title: &'static str,
    pub meaning: &'static str,
}

const fn s(os: Os, process: &'static str, class_or_title: &'static str, meaning: &'static str) -> Signal {
    Signal { os, process, class_or_title, meaning }
}

pub const SIGNALS: &[Signal] = &[
    // Zoom: the floating share toolbar and the "You are screen sharing" bar, the share picker
    s(Os::Windows, "zoom.exe", "zpfloattoolbarwnd", "Zoom share toolbar"),
    s(Os::Windows, "zoom.exe", "zpcontentviewwndclass", "Zoom sharing"),
    s(Os::Windows, "zoom.exe", "you are screen sharing", "Zoom sharing"),
    s(Os::Windows, "zoom.exe", "select a window or an application", "Zoom share picker"),
    s(Os::Mac, "zoom.us", "you are screen sharing", "Zoom sharing"),
    s(Os::Mac, "zoom.us", "zoom share toolbar", "Zoom share toolbar"),
    s(Os::Mac, "zoom.us", "select a window or an application", "Zoom share picker"),
    // Teams (new): the presenting / sharing control bar
    s(Os::Windows, "ms-teams.exe", "sharing control bar", "Teams sharing"),
    s(Os::Windows, "ms-teams.exe", "you're presenting", "Teams presenting"),
    s(Os::Mac, "microsoft teams", "sharing control bar", "Teams sharing"),
    s(Os::Mac, "microsoft teams", "you're presenting", "Teams presenting"),
    // Chrome / Edge getDisplayMedia (Meet and any site): "<site> is sharing your screen."
    s(Os::Windows, "chrome.exe", "is sharing your screen", "browser screen share"),
    s(Os::Windows, "chrome.exe", "is sharing a window", "browser window share"),
    s(Os::Windows, "msedge.exe", "is sharing your screen", "browser screen share"),
    s(Os::Mac, "google chrome", "is sharing your screen", "browser screen share"),
    s(Os::Mac, "microsoft edge", "is sharing your screen", "browser screen share"),
    // Discord's own screen share overlay
    s(Os::Windows, "discord.exe", "screen share", "Discord sharing"),
    s(Os::Mac, "discord", "screen share", "Discord sharing"),
    // OBS recording or streaming
    s(Os::Windows, "obs64.exe", "rec", "OBS recording"),
    s(Os::Windows, "obs64.exe", "live", "OBS streaming"),
    s(Os::Mac, "obs", "rec", "OBS recording"),
    s(Os::Mac, "obs", "live", "OBS streaming"),
    // screenshots about to be taken
    s(Os::Windows, "screenclippinghost.exe", "", "Snipping Tool"),
    s(Os::Mac, "screencaptureui", "", "macOS screenshot"),
];

/// One visible top-level window of another process.
#[derive(Debug, Clone, Default)]
pub struct Win {
    pub process: String,
    pub class: String,
    pub title: String,
}

/// The first signal any window matches.
pub fn matches(os: Os, windows: &[Win]) -> Option<&'static Signal> {
    windows.iter().find_map(|w| {
        let process = w.process.to_lowercase();
        let process = process.rsplit(['\\', '/']).next().unwrap_or(&process);
        let class = w.class.to_lowercase();
        let title = w.title.to_lowercase();
        SIGNALS.iter().find(|sig| {
            sig.os == os
                && process == sig.process
                && (sig.class_or_title.is_empty() || class.contains(sig.class_or_title) || title_has(&title, sig.class_or_title))
        })
    })
}

/// Short patterns ("rec", "live") match a whole word of the title only, so "Recent" is not OBS recording.
fn title_has(title: &str, pat: &str) -> bool {
    if pat.len() > 4 {
        return title.contains(pat);
    }
    title.split(|c: char| !c.is_alphanumeric()).any(|w| w == pat)
}

pub const POLL: Duration = Duration::from_millis(250);
pub const RESTORE_AFTER: Duration = Duration::from_secs(1);

/// Hide at once on a signal, restore 1 s after it is gone.
#[derive(Default)]
pub struct Debounce {
    hidden: bool,
    clear_since: Option<Instant>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Act {
    Hide,
    Restore,
    None,
}

impl Debounce {
    pub fn step(&mut self, sharing: bool, now: Instant) -> Act {
        if sharing {
            self.clear_since = None;
            if !self.hidden {
                self.hidden = true;
                return Act::Hide;
            }
            return Act::None;
        }
        if !self.hidden {
            return Act::None;
        }
        let since = *self.clear_since.get_or_insert(now);
        if now.duration_since(since) >= RESTORE_AFTER {
            self.hidden = false;
            self.clear_since = None;
            return Act::Restore;
        }
        Act::None
    }
}

#[cfg(target_os = "windows")]
pub const THIS_OS: Option<Os> = Some(Os::Windows);
#[cfg(target_os = "macos")]
pub const THIS_OS: Option<Os> = Some(Os::Mac);
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const THIS_OS: Option<Os> = None;

/// The visible top-level windows of other processes.
#[cfg(target_os = "windows")]
pub fn windows() -> Vec<Win> {
    super::exclude_win::visible_windows()
}

#[cfg(target_os = "macos")]
pub fn windows() -> Vec<Win> {
    super::exclude_mac::visible_windows()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn windows() -> Vec<Win> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(process: &str, class: &str, title: &str) -> Win {
        Win { process: process.into(), class: class.into(), title: title.into() }
    }

    #[test]
    fn recorded_window_lists_match() {
        let zoom = [w("C:\\Program Files\\Zoom\\bin\\Zoom.exe", "ZPFloatToolbarWnd", "")];
        assert_eq!(matches(Os::Windows, &zoom).unwrap().meaning, "Zoom share toolbar");
        let meet = [w("chrome.exe", "Chrome_WidgetWin_1", "meet.google.com is sharing your screen.")];
        assert!(matches(Os::Windows, &meet).is_some());
        let snip = [w("ScreenClippingHost.exe", "", "Screen clipping")];
        assert!(matches(Os::Windows, &snip).is_some());
        let mac = [w("screencaptureui", "", "")];
        assert!(matches(Os::Mac, &mac).is_some());
        assert!(matches(Os::Windows, &mac).is_none(), "rows are per OS");
    }

    #[test]
    fn ordinary_windows_do_not_match() {
        let calm = [
            w("chrome.exe", "Chrome_WidgetWin_1", "Inbox - Gmail"),
            w("Zoom.exe", "ZPPTMainFrmWndClassEx", "Zoom Meeting"),
            w("obs64.exe", "Qt", "OBS 30.1 - Profile: Untitled - Scenes: Recent"),
            w("notepad.exe", "Notepad", "you are screen sharing.txt"),
        ];
        assert!(matches(Os::Windows, &calm).is_none(), "{:?}", matches(Os::Windows, &calm).map(|s| s.meaning));
        let obs_rec = [w("obs64.exe", "Qt", "OBS 30.1 - REC 00:01:02")];
        assert!(matches(Os::Windows, &obs_rec).is_some());
    }

    #[test]
    fn hides_at_once_and_restores_after_a_second() {
        let t = Instant::now();
        let mut d = Debounce::default();
        assert_eq!(d.step(false, t), Act::None);
        assert_eq!(d.step(true, t), Act::Hide);
        assert_eq!(d.step(true, t + POLL), Act::None);
        assert_eq!(d.step(false, t + POLL * 2), Act::None);
        assert_eq!(d.step(true, t + POLL * 3), Act::None, "a flicker keeps it hidden");
        assert_eq!(d.step(false, t + POLL * 4), Act::None);
        assert_eq!(d.step(false, t + POLL * 4 + RESTORE_AFTER), Act::Restore);
        assert_eq!(d.step(false, t + POLL * 9), Act::None);
    }
}
