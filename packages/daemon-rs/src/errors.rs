//! Errors as the hub sees them: `{ message, code }` with Node style codes and
//! messages ("ENOENT: no such file or directory, open '/x'"), so tools that
//! branch on `code` or show `message` behave the same with either daemon.

use serde_json::{json, Value};
use std::io;

#[derive(Debug, Clone)]
pub struct WireError {
    pub message: String,
    pub code: Option<String>,
}

impl WireError {
    pub fn new(message: impl Into<String>) -> Self {
        WireError { message: message.into(), code: None }
    }

    pub fn coded(message: impl Into<String>, code: &str) -> Self {
        WireError { message: message.into(), code: Some(code.into()) }
    }

    pub fn to_json(&self) -> Value {
        match &self.code {
            Some(c) => json!({ "message": self.message, "code": c }),
            None => json!({ "message": self.message }),
        }
    }
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Res<T> = Result<T, WireError>;

/// libuv's name and text for an errno.
pub fn uv_error(code: &str) -> &'static str {
    match code {
        "E2BIG" => "argument list too long",
        "EACCES" => "permission denied",
        "EADDRINUSE" => "address already in use",
        "EAGAIN" => "resource temporarily unavailable",
        "EBADF" => "bad file descriptor",
        "EBUSY" => "resource busy or locked",
        "ECANCELED" => "operation canceled",
        "ECONNREFUSED" => "connection refused",
        "ECONNRESET" => "connection reset by peer",
        "EEXIST" => "file already exists",
        "EFAULT" => "bad address in system call argument",
        "EFBIG" => "file too large",
        "EINTR" => "interrupted system call",
        "EINVAL" => "invalid argument",
        "EIO" => "i/o error",
        "EISDIR" => "illegal operation on a directory",
        "ELOOP" => "too many symbolic links encountered",
        "EMFILE" => "too many open files",
        "EMLINK" => "too many links",
        "ENAMETOOLONG" => "name too long",
        "ENFILE" => "file table overflow",
        "ENODEV" => "no such device",
        "ENOENT" => "no such file or directory",
        "ENOMEM" => "not enough memory",
        "ENOSPC" => "no space left on device",
        "ENOSYS" => "function not implemented",
        "ENOTDIR" => "not a directory",
        "ENOTEMPTY" => "directory not empty",
        "ENOTSUP" => "operation not supported on socket",
        "ENXIO" => "no such device or address",
        "EPERM" => "operation not permitted",
        "EPIPE" => "broken pipe",
        "EROFS" => "read-only file system",
        "ESPIPE" => "invalid seek",
        "ESRCH" => "no such process",
        "ETIMEDOUT" => "connection timed out",
        "ETXTBSY" => "text file is busy",
        "EXDEV" => "cross-device link not permitted",
        "EOVERFLOW" => "value too large for defined data type",
        "EDQUOT" => "disk quota exceeded",
        _ => "unknown error",
    }
}

/// The errno name of an io error, as Node reports it.
pub fn errno_code(e: &io::Error) -> &'static str {
    if let Some(n) = e.raw_os_error() {
        if let Some(c) = os_code(n) {
            return c;
        }
    }
    use io::ErrorKind::*;
    match e.kind() {
        NotFound => "ENOENT",
        PermissionDenied => "EACCES",
        AlreadyExists => "EEXIST",
        InvalidInput => "EINVAL",
        BrokenPipe => "EPIPE",
        TimedOut => "ETIMEDOUT",
        ConnectionRefused => "ECONNREFUSED",
        ConnectionReset => "ECONNRESET",
        Interrupted => "EINTR",
        OutOfMemory => "ENOMEM",
        Unsupported => "ENOSYS",
        _ => "EIO",
    }
}

#[cfg(unix)]
fn os_code(n: i32) -> Option<&'static str> {
    let c = match n {
        libc::E2BIG => "E2BIG",
        libc::EACCES => "EACCES",
        libc::EADDRINUSE => "EADDRINUSE",
        libc::EAGAIN => "EAGAIN",
        libc::EBADF => "EBADF",
        libc::EBUSY => "EBUSY",
        libc::ECANCELED => "ECANCELED",
        libc::ECONNREFUSED => "ECONNREFUSED",
        libc::ECONNRESET => "ECONNRESET",
        libc::EEXIST => "EEXIST",
        libc::EFAULT => "EFAULT",
        libc::EFBIG => "EFBIG",
        libc::EINTR => "EINTR",
        libc::EINVAL => "EINVAL",
        libc::EIO => "EIO",
        libc::EISDIR => "EISDIR",
        libc::ELOOP => "ELOOP",
        libc::EMFILE => "EMFILE",
        libc::EMLINK => "EMLINK",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENFILE => "ENFILE",
        libc::ENODEV => "ENODEV",
        libc::ENOENT => "ENOENT",
        libc::ENOMEM => "ENOMEM",
        libc::ENOSPC => "ENOSPC",
        libc::ENOSYS => "ENOSYS",
        libc::ENOTDIR => "ENOTDIR",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ENOTSUP => "ENOTSUP",
        libc::ENXIO => "ENXIO",
        libc::EPERM => "EPERM",
        libc::EPIPE => "EPIPE",
        libc::EROFS => "EROFS",
        libc::ESPIPE => "ESPIPE",
        libc::ESRCH => "ESRCH",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::ETXTBSY => "ETXTBSY",
        libc::EXDEV => "EXDEV",
        libc::EOVERFLOW => "EOVERFLOW",
        libc::EDQUOT => "EDQUOT",
        _ => return None,
    };
    Some(c)
}

/// Windows system errors as libuv translates them.
#[cfg(windows)]
fn os_code(n: i32) -> Option<&'static str> {
    let c = match n {
        2 | 3 | 15 | 21 | 53 | 67 | 123 | 161 | 1231 => "ENOENT", // file, path, drive, not ready, net path, name, bad pathname
        5 => "EPERM",                                             // ERROR_ACCESS_DENIED
        998 => "EACCES",                                          // ERROR_NOACCESS
        32 | 33 | 170 => "EBUSY",                                 // sharing / lock violation, busy
        80 | 183 => "EEXIST",
        145 => "ENOTEMPTY",
        267 => "ENOTDIR", // ERROR_DIRECTORY
        17 => "EXDEV",
        112 | 39 => "ENOSPC",
        206 | 111 => "ENAMETOOLONG",
        87 => "EINVAL",
        8 | 14 => "ENOMEM",
        4 => "EMFILE",
        19 => "EROFS",
        109 | 232 => "EPIPE",
        1921 => "ELOOP",
        1260 => "EPERM",
        _ => return None,
    };
    Some(c)
}

/// `CODE: text, syscall 'path'` as Node words it.
pub fn fs_error(e: &io::Error, syscall: &str, path: Option<&str>) -> WireError {
    let code = errno_code(e);
    let msg = match path {
        Some(p) => format!("{code}: {}, {syscall} '{p}'", uv_error(code)),
        None => format!("{code}: {}, {syscall}", uv_error(code)),
    };
    WireError::coded(msg, code)
}

/// A rename error names both paths.
pub fn rename_error(e: &io::Error, from: &str, to: &str) -> WireError {
    let code = errno_code(e);
    WireError::coded(format!("{code}: {}, rename '{from}' -> '{to}'", uv_error(code)), code)
}

pub fn is_not_found(e: &io::Error) -> bool {
    matches!(errno_code(e), "ENOENT" | "ENOTDIR")
}

/// An error made from a code (no io::Error at hand).
pub fn code_error(code: &str, syscall: &str, path: &str) -> WireError {
    WireError::coded(format!("{code}: {}, {syscall} '{path}'", uv_error(code)), code)
}
