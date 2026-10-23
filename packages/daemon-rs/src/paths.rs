//! Node's `path` module (posix and win32), ported line by line, plus
//! LocalMachine.resolve. Paths stay strings, as on the wire.

/// Shared by both flavors: collapse `.`, `..` and repeated separators.
fn normalize_string(path: &str, allow_above_root: bool, sep: char, is_sep: fn(u8) -> bool) -> String {
    let b = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: isize = 0;
    let mut code: u8 = 0;
    let n = b.len() as isize;
    let mut i: isize = 0;
    while i <= n {
        if i < n {
            code = b[i as usize];
        } else if is_sep(code) {
            break;
        } else {
            code = b'/';
        }
        if is_sep(code) {
            if last_slash == i - 1 || dots == 1 {
                // nothing
            } else if dots == 2 {
                let rb = res.as_bytes();
                if res.len() < 2 || last_segment_length != 2 || rb[rb.len() - 1] != b'.' || rb[rb.len() - 2] != b'.' {
                    if res.len() > 2 {
                        match res.rfind(sep) {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(idx) => {
                                res.truncate(idx);
                                last_segment_length = res.len() as isize - 1 - res.rfind(sep).map(|x| x as isize).unwrap_or(-1);
                            }
                        }
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if res.is_empty() {
                        res.push_str("..");
                    } else {
                        res.push(sep);
                        res.push_str("..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let seg = &path[(last_slash + 1) as usize..i as usize];
                if !res.is_empty() {
                    res.push(sep);
                }
                res.push_str(seg);
                last_segment_length = i - last_slash - 1;
            }
            last_slash = i;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

fn posix_sep(c: u8) -> bool {
    c == b'/'
}

fn win_sep(c: u8) -> bool {
    c == b'/' || c == b'\\'
}

fn cwd_string() -> String {
    std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "/".into())
}

#[cfg_attr(windows, allow(dead_code))]
pub mod posix {
    use super::*;

    pub fn is_absolute(p: &str) -> bool {
        p.starts_with('/')
    }

    pub fn normalize(path: &str) -> String {
        if path.is_empty() {
            return ".".into();
        }
        let abs = path.starts_with('/');
        let trailing = path.ends_with('/');
        let mut p = normalize_string(path, !abs, '/', posix_sep);
        if p.is_empty() {
            if abs {
                return "/".into();
            }
            return if trailing { "./".into() } else { ".".into() };
        }
        if trailing {
            p.push('/');
        }
        if abs {
            format!("/{p}")
        } else {
            p
        }
    }

    pub fn resolve(args: &[&str]) -> String {
        let mut resolved = String::new();
        let mut absolute = false;
        let cwd = cwd_string();
        let mut i = args.len() as isize - 1;
        while i >= -1 && !absolute {
            let path: &str = if i >= 0 { args[i as usize] } else { &cwd };
            i -= 1;
            if path.is_empty() {
                continue;
            }
            resolved = format!("{path}/{resolved}");
            absolute = path.starts_with('/');
        }
        let r = normalize_string(&resolved, !absolute, '/', posix_sep);
        if absolute {
            format!("/{r}")
        } else if r.is_empty() {
            ".".into()
        } else {
            r
        }
    }

    pub fn join(args: &[&str]) -> String {
        let parts: Vec<&str> = args.iter().copied().filter(|a| !a.is_empty()).collect();
        if parts.is_empty() {
            return ".".into();
        }
        normalize(&parts.join("/"))
    }

    pub fn dirname(path: &str) -> String {
        if path.is_empty() {
            return ".".into();
        }
        let b = path.as_bytes();
        let has_root = b[0] == b'/';
        let mut end: isize = -1;
        let mut matched_slash = true;
        let mut i = b.len() as isize - 1;
        while i >= 1 {
            if b[i as usize] == b'/' {
                if !matched_slash {
                    end = i;
                    break;
                }
            } else {
                matched_slash = false;
            }
            i -= 1;
        }
        if end == -1 {
            return if has_root { "/".into() } else { ".".into() };
        }
        if has_root && end == 1 {
            return "//".into();
        }
        path[..end as usize].into()
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub mod win32 {
    use super::*;

    fn is_device_root(c: u8) -> bool {
        c.is_ascii_alphabetic()
    }

    pub fn is_absolute(p: &str) -> bool {
        let b = p.as_bytes();
        if b.is_empty() {
            return false;
        }
        win_sep(b[0]) || (b.len() > 2 && is_device_root(b[0]) && b[1] == b':' && win_sep(b[2]))
    }

    /// (device, root end, absolute) of a path, as normalize and resolve find them.
    fn root(path: &str, for_normalize: bool) -> (Option<String>, usize, bool, Option<String>) {
        let b = path.as_bytes();
        let len = b.len();
        let mut root_end = 0;
        let mut device = None;
        let mut abs = false;
        if len == 0 {
            return (None, 0, false, None);
        }
        let code = b[0];
        if len == 1 {
            if win_sep(code) {
                return (None, 1, true, None);
            }
            return (None, 0, false, None);
        }
        if win_sep(code) {
            abs = true;
            if win_sep(b[1]) {
                let mut j = 2;
                let mut last = j;
                while j < len && !win_sep(b[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let first = &path[last..j];
                    last = j;
                    while j < len && win_sep(b[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !win_sep(b[j]) {
                            j += 1;
                        }
                        if j == len && for_normalize {
                            return (None, 0, true, Some(format!("\\\\{first}\\{}\\", &path[last..])));
                        }
                        if j == len || j != last {
                            device = Some(format!("\\\\{first}\\{}", &path[last..j]));
                            root_end = j;
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else if is_device_root(code) && b[1] == b':' {
            device = Some(path[..2].to_string());
            root_end = 2;
            if len > 2 && win_sep(b[2]) {
                abs = true;
                root_end = 3;
            }
        }
        (device, root_end, abs, None)
    }

    pub fn normalize(path: &str) -> String {
        let b = path.as_bytes();
        let len = b.len();
        if len == 0 {
            return ".".into();
        }
        if len == 1 {
            return if b[0] == b'/' { "\\".into() } else { path.into() };
        }
        let (device, root_end, abs, whole) = root(path, true);
        if let Some(w) = whole {
            return w;
        }
        let mut tail = if root_end < len { normalize_string(&path[root_end..], !abs, '\\', win_sep) } else { String::new() };
        if tail.is_empty() && !abs {
            tail = ".".into();
        }
        if !tail.is_empty() && win_sep(b[len - 1]) {
            tail.push('\\');
        }
        match device {
            None => {
                if abs {
                    format!("\\{tail}")
                } else {
                    tail
                }
            }
            Some(d) => {
                if abs {
                    format!("{d}\\{tail}")
                } else {
                    format!("{d}{tail}")
                }
            }
        }
    }

    pub fn resolve(args: &[&str]) -> String {
        let mut resolved_device = String::new();
        let mut resolved_tail = String::new();
        let mut resolved_abs = false;
        let cwd = cwd_string();
        let mut i = args.len() as isize - 1;
        while i >= -1 {
            let path: String = if i >= 0 {
                let p = args[i as usize];
                if p.is_empty() {
                    i -= 1;
                    continue;
                }
                p.to_string()
            } else if resolved_device.is_empty() {
                cwd.clone()
            } else {
                let p = cwd.clone();
                if p.len() >= 2 && p[..2].to_lowercase() != resolved_device.to_lowercase() && p.as_bytes().get(2) == Some(&b'\\') {
                    format!("{resolved_device}\\")
                } else {
                    p
                }
            };
            i -= 1;
            let (device, root_end, abs, _) = root(&path, false);
            if let Some(d) = &device {
                if !resolved_device.is_empty() {
                    if d.to_lowercase() != resolved_device.to_lowercase() {
                        continue;
                    }
                } else {
                    resolved_device = d.clone();
                }
            }
            if resolved_abs {
                if !resolved_device.is_empty() {
                    break;
                }
            } else {
                resolved_tail = format!("{}\\{resolved_tail}", &path[root_end..]);
                resolved_abs = abs;
                if abs && !resolved_device.is_empty() {
                    break;
                }
            }
        }
        let tail = normalize_string(&resolved_tail, !resolved_abs, '\\', win_sep);
        if resolved_abs {
            format!("{resolved_device}\\{tail}")
        } else {
            let s = format!("{resolved_device}{tail}");
            if s.is_empty() {
                ".".into()
            } else {
                s
            }
        }
    }

    pub fn join(args: &[&str]) -> String {
        let parts: Vec<&str> = args.iter().copied().filter(|a| !a.is_empty()).collect();
        if parts.is_empty() {
            return ".".into();
        }
        let first = parts[0].as_bytes();
        let mut joined = parts.join("\\");
        let mut needs_replace = true;
        let mut slash_count = 0;
        if win_sep(first[0]) {
            slash_count += 1;
            if first.len() > 1 && win_sep(first[1]) {
                slash_count += 1;
                if first.len() > 2 {
                    if win_sep(first[2]) {
                        slash_count += 1;
                    } else {
                        needs_replace = false;
                    }
                }
            }
        }
        if needs_replace {
            let jb = joined.as_bytes();
            while slash_count < jb.len() && win_sep(jb[slash_count]) {
                slash_count += 1;
            }
            if slash_count >= 2 {
                joined = format!("\\{}", &joined[slash_count..]);
            }
        }
        normalize(&joined)
    }

    pub fn dirname(path: &str) -> String {
        let b = path.as_bytes();
        let len = b.len();
        if len == 0 {
            return ".".into();
        }
        let (_, root_end, _, _) = root(path, false);
        let offset = root_end;
        if len == 1 {
            return if win_sep(b[0]) { path.into() } else { ".".into() };
        }
        let mut end: isize = -1;
        let mut matched_slash = true;
        let mut i = len as isize - 1;
        while i >= offset as isize {
            if win_sep(b[i as usize]) {
                if !matched_slash {
                    end = i;
                    break;
                }
            } else {
                matched_slash = false;
            }
            i -= 1;
        }
        if end == -1 {
            if root_end == 0 {
                return ".".into();
            }
            return path[..root_end].into();
        }
        path[..end as usize].into()
    }
}

#[cfg(windows)]
pub use win32 as native;
#[cfg(not(windows))]
pub use posix as native;

#[cfg(windows)]
pub const SEP: char = '\\';
#[cfg(not(windows))]
pub const SEP: char = '/';

/// os.homedir(): $HOME on Unix (falling back to the password database), USERPROFILE on Windows.
pub fn home_dir() -> String {
    #[cfg(windows)]
    {
        if let Ok(h) = std::env::var("USERPROFILE") {
            if !h.is_empty() {
                return h;
            }
        }
        let drive = std::env::var("HOMEDRIVE").unwrap_or_default();
        let path = std::env::var("HOMEPATH").unwrap_or_default();
        format!("{drive}{path}")
    }
    #[cfg(unix)]
    {
        if let Ok(h) = std::env::var("HOME") {
            if !h.is_empty() {
                return h;
            }
        }
        // SAFETY: getpwuid_r fills the passwd struct and buffer we own.
        unsafe {
            let mut pw: libc::passwd = std::mem::zeroed();
            let mut buf = vec![0 as libc::c_char; 4096];
            let mut out: *mut libc::passwd = std::ptr::null_mut();
            if libc::getpwuid_r(libc::getuid(), &mut pw, buf.as_mut_ptr(), buf.len(), &mut out) == 0 && !out.is_null() && !pw.pw_dir.is_null() {
                return std::ffi::CStr::from_ptr(pw.pw_dir).to_string_lossy().into_owned();
            }
        }
        "/".into()
    }
}

/// LocalMachine.resolve: "~" and "~/x" are the home directory, relative paths go against cwd.
pub fn resolve_with(path: &str, cwd: &str, home: &str, windows: bool) -> String {
    let join = |a: &str, b: &str| if windows { win32::join(&[a, b]) } else { posix::join(&[a, b]) };
    let expand = |p: &str| -> String {
        if p == "~" {
            home.to_string()
        } else if let Some(rest) = p.strip_prefix("~/") {
            join(home, rest)
        } else {
            p.to_string()
        }
    };
    let p = expand(crate::js::trim(path));
    let is_abs = if windows { win32::is_absolute(&p) } else { posix::is_absolute(&p) };
    if is_abs {
        return if windows { win32::normalize(&p) } else { posix::normalize(&p) };
    }
    let base = expand(if cwd.is_empty() { home } else { cwd });
    if windows {
        win32::resolve(&[&base, &p])
    } else {
        posix::resolve(&[&base, &p])
    }
}

pub fn resolve(path: &str, cwd: &str) -> String {
    resolve_with(path, cwd, &home_dir(), cfg!(windows))
}

/// importers/files.ts joinPath: join with "/" and squash repeated slashes.
pub fn join_slash(parts: &[&str]) -> String {
    let joined = parts.iter().copied().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("/");
    let mut out = String::with_capacity(joined.len());
    let mut prev_slash = false;
    for c in joined.chars() {
        if c == '/' {
            if !prev_slash {
                out.push(c);
            }
            prev_slash = true;
        } else {
            out.push(c);
            prev_slash = false;
        }
    }
    out
}

/// importers/files.ts baseName: the part after the last "/".
pub fn base_name(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_matches_node() {
        assert_eq!(posix::normalize("/a//b/../c/./d/"), "/a/c/d/");
        assert_eq!(posix::normalize("a/../../b"), "../b");
        assert_eq!(posix::normalize(""), ".");
        assert_eq!(posix::normalize("./"), "./");
        assert_eq!(posix::resolve(&["/a/b", "../c"]), "/a/c");
        assert_eq!(posix::resolve(&["/a/b/", "c/"]), "/a/b/c");
        assert_eq!(posix::resolve(&["/x", "/y", "z"]), "/y/z");
        assert_eq!(posix::join(&["/home/me", ".claude"]), "/home/me/.claude");
        assert_eq!(posix::dirname("/a/b/c"), "/a/b");
        assert_eq!(posix::dirname("/a"), "/");
        assert_eq!(posix::dirname("a"), ".");
        assert_eq!(posix::dirname("/a/b/"), "/a");
    }

    #[test]
    fn win32_matches_node() {
        assert_eq!(win32::normalize("C:\\a\\..\\b\\"), "C:\\b\\");
        assert_eq!(win32::normalize("C:/a/b"), "C:\\a\\b");
        assert_eq!(win32::normalize("\\\\server\\share"), "\\\\server\\share\\");
        assert_eq!(win32::resolve(&["C:\\Users\\me", "x\\y"]), "C:\\Users\\me\\x\\y");
        assert_eq!(win32::resolve(&["C:\\Users\\me", "D:\\z"]), "D:\\z");
        assert_eq!(win32::join(&["C:\\Users\\me", ".claude"]), "C:\\Users\\me\\.claude");
        assert!(win32::is_absolute("C:\\x"));
        assert!(!win32::is_absolute("C:x"));
        assert_eq!(win32::dirname("C:\\a\\b"), "C:\\a");
        assert_eq!(win32::dirname("C:\\a"), "C:\\");
    }

    #[test]
    fn home_expansion() {
        let r = |p: &str, c: &str| resolve_with(p, c, "/home/me", false);
        assert_eq!(r("~", "/"), "/home/me");
        assert_eq!(r("~/x/../y", "/"), "/home/me/y");
        assert_eq!(r("src", "~/proj"), "/home/me/proj/src");
        assert_eq!(r("src", ""), "/home/me/src");
        assert_eq!(r("  /a/b/  ", "/"), "/a/b/");
        assert_eq!(r("/a/../b", "/x"), "/b");
        assert_eq!(r("~user/x", "/tmp"), "/tmp/~user/x");
        let w = |p: &str, c: &str| resolve_with(p, c, "C:\\Users\\me", true);
        assert_eq!(w("~/x", "C:\\"), "C:\\Users\\me\\x");
        assert_eq!(w("src", "~/proj"), "C:\\Users\\me\\proj\\src");
    }

    #[test]
    fn slash_join() {
        assert_eq!(join_slash(&["/home/me/.claude", "projects"]), "/home/me/.claude/projects");
        assert_eq!(join_slash(&["/a/", "/b", "", "c"]), "/a/b/c");
        assert_eq!(base_name("/a/b.jsonl"), "b.jsonl");
    }
}
