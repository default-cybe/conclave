//! The user's own PATH on Windows (HKCU\Environment\Path), for the terminal
//! command (terminal.rs): read it, write it, and tell running programs that
//! it changed. What goes into it is decided by the pure functions in
//! terminal.rs (win_path_with, win_path_without).

use windows_registry::{Key, Type, CURRENT_USER};

/// ERROR_FILE_NOT_FOUND as an HRESULT: the value is not there.
const NOT_FOUND: i32 = 0x8007_0002_u32 as i32;

fn environment() -> Result<Key, String> {
    CURRENT_USER.options().read().write().open("Environment").map_err(|e| e.message())
}

/// The user's PATH as stored (%VARS% not expanded), and whether it is a
/// REG_EXPAND_SZ. None stored: empty, and REG_EXPAND_SZ for a new one.
pub fn read() -> Result<(String, bool), String> {
    let env = environment()?;
    match env.get_type("Path") {
        Ok(ty) => Ok((env.get_string("Path").map_err(|e| e.message())?, ty != Type::String)),
        Err(e) if e.code().0 == NOT_FOUND => Ok((String::new(), true)),
        Err(e) => Err(e.message()),
    }
}

/// Store the user's PATH, keeping its type.
pub fn write(path: &str, expand: bool) -> Result<(), String> {
    let env = environment()?;
    let written = if expand { env.set_expand_string("Path", path) } else { env.set_string("Path", path) };
    written.map_err(|e| e.message())
}

/// WM_SETTINGCHANGE with "Environment" to every top-level window, as the
/// system's own Environment Variables dialog does: Explorer reads the PATH
/// again, so a terminal opened from it next has the new one.
pub fn broadcast() {
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(hwnd: isize, msg: u32, wparam: usize, lparam: isize, flags: u32, timeout: u32, result: *mut usize) -> isize;
    }
    const HWND_BROADCAST: isize = 0xffff;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;
    let what: Vec<u16> = "Environment".encode_utf16().chain(Some(0)).collect();
    let mut result = 0usize;
    // SAFETY: `what` is a NUL-terminated UTF-16 string that outlives the call, and `result` a valid slot.
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, what.as_ptr() as isize, SMTO_ABORTIFHUNG, 5000, &mut result);
    }
}
