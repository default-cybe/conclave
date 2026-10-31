//! Windows capture exclusion and overlay window styles (MEETING-MODE.md 7.2).
//!
//! Our own code; the call sequence (display affinity, tool-window and
//! no-activate styles, zero-alpha show) is the documented Win32 one that
//! Pluely, Natively and the Electron clones also use. No code copied.

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, COLORREF, HWND, LPARAM};
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumThreadWindows, EnumWindows, GetClassNameW, GetWindowDisplayAffinity, GetWindowLongPtrW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, SetLayeredWindowAttributes, SetWindowDisplayAffinity, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, GWL_EXSTYLE, LWA_ALPHA, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR, WS_EX_APPWINDOW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use super::share_watch::Win;
use super::wire::Exclusion;

/// An HWND as a plain number, so it can cross threads.
pub type Raw = isize;

fn hwnd(raw: Raw) -> HWND {
    HWND(raw as *mut core::ffi::c_void)
}

fn affinity(h: HWND) -> Option<u32> {
    let mut v = 0u32;
    unsafe { GetWindowDisplayAffinity(h, &mut v) }.ok().map(|_| v)
}

/// Read the affinity; set WDA_EXCLUDEFROMCAPTURE only when it differs (no
/// DWM churn), read it back. Falls back to WDA_MONITOR before Windows 10 2004.
pub fn ensure(raw: Raw) -> Exclusion {
    let h = hwnd(raw);
    match affinity(h) {
        Some(v) if v == WDA_EXCLUDEFROMCAPTURE.0 => return Exclusion::Excluded,
        _ => {}
    }
    if unsafe { SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE) }.is_ok() && affinity(h) == Some(WDA_EXCLUDEFROMCAPTURE.0) {
        return Exclusion::Excluded;
    }
    if affinity(h) == Some(WDA_MONITOR.0) {
        return Exclusion::MonitorOnly;
    }
    if unsafe { SetWindowDisplayAffinity(h, WDA_MONITOR) }.is_ok() && affinity(h) == Some(WDA_MONITOR.0) {
        return Exclusion::MonitorOnly;
    }
    Exclusion::Failed
}

/// No taskbar button, no Alt-Tab entry; with `noactivate`, never activated by a
/// click (off only for the setup screen's text fields, 7.6).
pub fn tool_window(raw: Raw, noactivate: bool) {
    let h = hwnd(raw);
    unsafe {
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        let mut want = (ex | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
        want = if noactivate { want | WS_EX_NOACTIVATE.0 } else { want & !WS_EX_NOACTIVATE.0 };
        if want != ex {
            SetWindowLongPtrW(h, GWL_EXSTYLE, want as isize);
            let _ = SetWindowPos(h, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        }
    }
}

/// Show without activating. The window is composed at alpha 0 until the
/// exclusion is confirmed and DWM has composed a frame with it, so it never
/// appears in a capture for even one frame.
pub fn show(raw: Raw) -> Exclusion {
    let h = hwnd(raw);
    unsafe {
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        let had_layered = ex & WS_EX_LAYERED.0 != 0;
        if !had_layered {
            SetWindowLongPtrW(h, GWL_EXSTYLE, (ex | WS_EX_LAYERED.0) as isize);
        }
        let _ = SetLayeredWindowAttributes(h, COLORREF(0), 0, LWA_ALPHA);
        let state = ensure(raw);
        let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        let _ = DwmFlush();
        let state = match state {
            Exclusion::Excluded => ensure(raw),
            other => other,
        };
        let _ = SetLayeredWindowAttributes(h, COLORREF(0), 255, LWA_ALPHA);
        if !had_layered {
            let now = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
            SetWindowLongPtrW(h, GWL_EXSTYLE, (now & !WS_EX_LAYERED.0) as isize);
        }
        state
    }
}

/// Hide in one call (the panic key).
pub fn hide(raw: Raw) {
    unsafe {
        let _ = ShowWindow(hwnd(raw), SW_HIDE);
    }
}

unsafe extern "system" fn collect(h: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<Raw>);
    out.push(h.0 as Raw);
    BOOL(1)
}

/// Every visible top-level window of the overlay's UI thread (the main
/// window, quick ask, menus and tooltips Tauri makes) gets the exclusion
/// while a meeting runs. Only where the read-back differs.
pub fn sweep(overlay: Raw) {
    let mut wins: Vec<Raw> = Vec::new();
    unsafe {
        let thread = GetWindowThreadProcessId(hwnd(overlay), None);
        if thread == 0 {
            return;
        }
        let _ = EnumThreadWindows(thread, Some(collect), LPARAM(&mut wins as *mut _ as isize));
    }
    for w in wins {
        if unsafe { IsWindowVisible(hwnd(w)) }.as_bool() {
            ensure(w);
        }
    }
}

fn text(buf: &[u16], n: i32) -> String {
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

thread_local! {
    static NAMES: std::cell::RefCell<std::collections::HashMap<u32, String>> = Default::default();
}

fn process_name(pid: u32) -> String {
    if let Some(n) = NAMES.with(|m| m.borrow().get(&pid).cloned()) {
        return n;
    }
    let name = unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => {
                let mut buf = [0u16; 512];
                let mut len = buf.len() as u32;
                let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
                let _ = CloseHandle(handle);
                if ok { String::from_utf16_lossy(&buf[..len as usize]) } else { String::new() }
            }
            Err(_) => String::new(),
        }
    };
    NAMES.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() > 512 {
            m.clear();
        }
        m.insert(pid, name.clone());
    });
    name
}

/// Visible top-level windows of other processes, for share detection.
pub fn visible_windows() -> Vec<Win> {
    let mut all: Vec<Raw> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut _ as isize));
    }
    let me = unsafe { GetCurrentProcessId() };
    let mut out = Vec::new();
    for raw in all {
        let h = hwnd(raw);
        if !unsafe { IsWindowVisible(h) }.as_bool() {
            continue;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        if pid == me {
            continue;
        }
        let mut class = [0u16; 256];
        let mut title = [0u16; 256];
        let (nc, nt) = unsafe { (GetClassNameW(h, &mut class), GetWindowTextW(h, &mut title)) };
        out.push(Win { process: process_name(pid), class: text(&class, nc), title: text(&title, nt) });
    }
    out
}
