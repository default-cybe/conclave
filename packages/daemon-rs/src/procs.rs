//! exec (a shell command to completion) and spawn (a long-lived process),
//! as LocalMachine runs them: each child leads its own session and process
//! group, so a timeout or kill takes down everything it started.

use crate::errors::{errno_code, uv_error, WireError};
use crate::js::{encode_base64, len16, Utf8Stream};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

pub const KILL_GRACE: Duration = Duration::from_millis(3_000);
/// How long to keep draining pipes after the main process exits (children may hold them open).
pub const DRAIN_GRACE: Duration = Duration::from_millis(500);
pub const DEFAULT_MAX_OUTPUT: usize = 8 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sig {
    Term,
    Kill,
    Int,
}

impl Sig {
    pub fn parse(s: Option<&str>) -> Sig {
        match s {
            Some("SIGKILL") => Sig::Kill,
            Some("SIGINT") => Sig::Int,
            _ => Sig::Term,
        }
    }
}

// ---------------------------------------------------------------------------
// Process groups this daemon started and that may still run.
// ---------------------------------------------------------------------------

fn live() -> &'static Mutex<BTreeSet<u32>> {
    static LIVE: OnceLock<Mutex<BTreeSet<u32>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn track(pid: Option<u32>) {
    if let Some(p) = pid {
        live().lock().unwrap().insert(p);
    }
}

fn untrack(pid: Option<u32>) {
    if let Some(p) = pid {
        live().lock().unwrap().remove(&p);
    }
}

/// Kill every process group this daemon started that is still running.
pub fn kill_all(sig: Sig) {
    let pids: Vec<u32> = live().lock().unwrap().iter().copied().collect();
    for p in pids {
        kill_tree(p, sig);
    }
}

#[cfg(unix)]
pub fn kill_tree(pid: u32, sig: Sig) {
    let s = match sig {
        Sig::Term => libc::SIGTERM,
        Sig::Kill => libc::SIGKILL,
        Sig::Int => libc::SIGINT,
    };
    // SAFETY: kill(2) with a pid we started; a stale pid only fails with ESRCH.
    unsafe {
        if libc::kill(-(pid as i32), s) == 0 {
            return;
        }
        libc::kill(pid as i32, s);
    }
}

#[cfg(windows)]
pub fn kill_tree(pid: u32, _sig: Sig) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // no process groups on Windows: taskkill /T ends the shell and everything it started
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let tree = std::process::Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if matches!(tree, Ok(s) if s.success()) {
        return;
    }
    // SAFETY: plain Win32 calls on a process handle we open and close here.
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

// ---------------------------------------------------------------------------
// Output kept for exec: the first and last part of a long stream.
// ---------------------------------------------------------------------------

/// HeadTailBuffer from local.ts. Sizes count UTF-16 units, like the TypeScript one.
pub struct HeadTail {
    head: String,
    head_len: usize,
    head_full: bool,
    tail: String,
    tail_len: usize,
    dropped: usize,
    head_max: usize,
    tail_max: usize,
}

impl HeadTail {
    pub fn new(max: usize) -> Self {
        let head_max = max / 2;
        HeadTail { head: String::new(), head_len: 0, head_full: false, tail: String::new(), tail_len: 0, dropped: 0, head_max, tail_max: max - head_max }
    }

    pub fn push(&mut self, s: &str) {
        let mut s = s;
        if !self.head_full && self.head_len < self.head_max {
            let take = self.head_max - self.head_len;
            let cut = crate::js::byte_at16(s, take);
            let part = &s[..cut];
            self.head.push_str(part);
            self.head_len += len16(part);
            s = &s[cut..];
            if s.is_empty() {
                return;
            }
        }
        self.head_full = true;
        self.tail.push_str(s);
        self.tail_len += len16(s);
        if self.tail_len > self.tail_max * 2 {
            self.trim_tail(self.tail_len - self.tail_max);
        }
    }

    fn trim_tail(&mut self, cut_units: usize) {
        let mut at = crate::js::byte_at16(&self.tail, cut_units);
        let mut units = len16(&self.tail[..at]);
        if units < cut_units {
            // the cut fell inside a surrogate pair: drop the whole character
            let c = self.tail[at..].chars().next().map(char::len_utf8).unwrap_or(0);
            at += c;
            units = len16(&self.tail[..at]);
        }
        self.dropped += units;
        self.tail_len -= units;
        self.tail.drain(..at);
    }

    pub fn finish(mut self) -> String {
        if self.tail_len > self.tail_max {
            let n = self.tail_len - self.tail_max;
            self.trim_tail(n);
        }
        if self.dropped == 0 {
            return self.head + &self.tail;
        }
        format!("{}\n[... {} characters of output dropped ...]\n{}", self.head, self.dropped, self.tail)
    }
}

// ---------------------------------------------------------------------------
// Shell and commands
// ---------------------------------------------------------------------------

/// bash when available, else sh. On Windows: Git Bash (never the WSL launcher), else cmd.exe.
pub fn shell() -> &'static str {
    static SHELL: OnceLock<String> = OnceLock::new();
    SHELL.get_or_init(|| {
        if cfg!(windows) {
            let path = std::env::var_os("PATH").map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
            return windows_bash(&path, &env, &|p: &str| std::path::Path::new(p).is_file()).unwrap_or_else(|| "cmd.exe".into());
        }
        match crate::env::which("bash") {
            Some(p) => p.to_string_lossy().into_owned(),
            None => "/bin/sh".into(),
        }
    })
}

/// cmd.exe (also as ComSpec's full path), which takes /d /s /c instead of -c.
fn is_cmd(sh: &str) -> bool {
    let l = sh.to_ascii_lowercase();
    let base = l.rsplit(|c: char| c == '\\' || c == '/').next().unwrap_or("");
    base == "cmd.exe" || base == "cmd"
}

/// The WSL launcher (WindowsApps or System32 bash.exe) runs Linux, where D:\ paths and Windows tools do not exist.
fn is_wsl_launcher(p: &str) -> bool {
    let l = p.to_ascii_lowercase().replace('/', "\\");
    ["\\windowsapps\\", "\\system32\\", "\\sysnative\\"].into_iter().any(|d| l.contains(d))
}

/// Git for Windows' install folder from the folder its git.exe is in (`<Git>\cmd`, `<Git>\bin`, `<Git>\mingw64\bin`).
fn git_root(dir: &str) -> Option<&str> {
    let lower = dir.to_ascii_lowercase();
    ["\\mingw64\\bin", "\\mingw32\\bin", "\\clangarm64\\bin", "\\cmd", "\\bin"].into_iter().find(|s| lower.ends_with(*s)).map(|s| &dir[..dir.len() - s.len()])
}

/// Git Bash for a Windows PATH (`;`-separated): next to git.exe on PATH, then the standard
/// install folders, then any other bash.exe on PATH that is not the WSL launcher.
/// Strings, not Path, so the tests run the same on every OS.
pub fn windows_bash(path_var: &str, env: &dyn Fn(&str) -> Option<String>, is_file: &dyn Fn(&str) -> bool) -> Option<String> {
    let dirs: Vec<&str> = path_var.split(';').map(|d| d.trim().trim_matches('"').trim_end_matches(['\\', '/'])).filter(|d| !d.is_empty()).collect();
    let mut cands: Vec<String> = Vec::new();
    for d in &dirs {
        if is_file(&format!("{d}\\git.exe")) {
            if let Some(root) = git_root(d) {
                cands.push(format!("{root}\\bin\\bash.exe"));
            }
        }
    }
    for (var, sub) in [("ProgramFiles", "Git"), ("ProgramW6432", "Git"), ("LOCALAPPDATA", "Programs\\Git"), ("ProgramFiles(x86)", "Git")] {
        if let Some(base) = env(var) {
            cands.push(format!("{}\\{sub}\\bin\\bash.exe", base.trim_end_matches(['\\', '/'])));
        }
    }
    cands.extend(dirs.iter().map(|d| format!("{d}\\bash.exe")));
    cands.into_iter().find(|c| !is_wsl_launcher(c) && is_file(c))
}

/// `sh` running `command`, for exec and spawn's background shells. cmd.exe gets /d /v:off /s /c and
/// the command in one pair of outer quotes that /s strips, so its own quotes reach cmd verbatim.
fn shell_command(sh: &str, command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(sh);
    if is_cmd(sh) {
        #[cfg(windows)]
        {
            cmd.args(["/d", "/v:off", "/s", "/c"]);
            cmd.raw_arg(format!("\"{command}\""));
        }
    } else {
        cmd.arg("-c").arg(command);
    }
    cmd
}

/// cmd.exe looks in the current folder before PATH, so a repo's git.bat would run under an allow rule for git; bash never does.
fn no_cwd_lookup(cmd: &mut tokio::process::Command, sh: &str) {
    if is_cmd(sh) {
        cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
    }
}

fn configure(cmd: &mut tokio::process::Command, own_group: bool) {
    #[cfg(unix)]
    if own_group {
        // SAFETY: setsid is async-signal-safe and only touches the child.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(if own_group { CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP } else { CREATE_NO_WINDOW });
    }
    let _ = own_group;
    cmd.kill_on_drop(false);
}

/// Bun's spawn error text: "EACCES: permission denied, posix_spawn 'cmd'".
fn spawn_error(e: &std::io::Error, argv0: &str) -> WireError {
    let code = errno_code(e);
    WireError::coded(format!("{code}: {}, posix_spawn '{argv0}'", uv_error(code)), code)
}

/// What an exec RPC carries.
pub struct ExecOpts {
    pub cwd: String,
    pub env: Option<Map<String, Value>>,
    pub timeout_ms: Option<f64>,
    pub stdin: Option<String>,
    pub max_output: Option<usize>,
}

/// exec.output events go here when the hub asked for live output.
pub type OnOutput = Arc<dyn Fn(String, &'static str) -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>;

/// Resolves when `rx` turns true; never when its sender is gone.
async fn wait_true(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

fn result(exit: Option<i32>, stdout: String, stderr: String, timed_out: bool, aborted: bool, started: Instant) -> Value {
    json!({
        "exitCode": exit,
        "stdout": stdout,
        "stderr": stderr,
        "timedOut": timed_out,
        "aborted": aborted,
        "durationMs": started.elapsed().as_millis() as u64,
    })
}

/// LocalMachine.exec.
pub async fn exec(command: String, opts: ExecOpts, mut abort: watch::Receiver<bool>, on_output: Option<OnOutput>) -> Value {
    let started = Instant::now();
    let home = crate::paths::home_dir();
    let cwd = crate::paths::resolve_with(if opts.cwd.is_empty() { "." } else { &opts.cwd }, &home, &home, cfg!(windows));
    let fail = |msg: String| result(Some(1), String::new(), msg, false, false, started);
    let cwd_ok = {
        let c = cwd.clone();
        tokio::task::spawn_blocking(move || crate::fsops::is_dir(&c)).await.unwrap_or(false)
    };
    if !cwd_ok {
        return fail(format!("Working directory does not exist: {cwd}"));
    }
    if crate::private::command_touches(&command) || crate::private::dirs().iter().any(|d| crate::private::under(&cwd, d)) {
        return fail(crate::private::REFUSAL.into());
    }
    if *abort.borrow() {
        return result(None, String::new(), "Aborted before start".into(), false, true, started);
    }

    let sh = shell();
    let mut cmd = shell_command(sh, &command);
    cmd.current_dir(&cwd).env_clear().envs(crate::env::tool_env(opts.env.as_ref()));
    no_cwd_lookup(&mut cmd, sh);
    cmd.stdin(if opts.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    configure(&mut cmd, true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("Failed to start shell: {}", spawn_error(&e, sh).message)),
    };
    let pid = child.id();
    track(pid);

    if let (Some(text), Some(mut sin)) = (opts.stdin.clone(), child.stdin.take()) {
        tokio::spawn(async move {
            let _ = sin.write_all(text.as_bytes()).await;
            let _ = sin.shutdown().await;
        });
    }

    let max = opts.max_output.unwrap_or(DEFAULT_MAX_OUTPUT);
    let out_buf = Arc::new(Mutex::new(HeadTail::new(max)));
    let err_buf = Arc::new(Mutex::new(HeadTail::new(max)));
    let pump = |reader: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>, buf: Arc<Mutex<HeadTail>>, which: &'static str, cb: Option<OnOutput>| {
        tokio::spawn(async move {
            let Some(mut r) = reader else { return };
            let mut dec = Utf8Stream::default();
            let mut chunk = vec![0u8; READ_CHUNK];
            loop {
                match r.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let s = dec.push(&chunk[..n]);
                        if s.is_empty() {
                            continue;
                        }
                        buf.lock().unwrap().push(&s);
                        if let Some(cb) = &cb {
                            cb(s, which).await;
                        }
                    }
                }
            }
            let rest = dec.finish();
            if !rest.is_empty() {
                buf.lock().unwrap().push(&rest);
            }
        })
    };
    let so = child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let se = child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let p1 = pump(so, out_buf.clone(), "stdout", on_output.clone());
    let p2 = pump(se, err_buf.clone(), "stderr", on_output);

    let mut timed_out = false;
    let mut aborted = false;
    let deadline = opts.timeout_ms.filter(|t| *t > 0.0 && t.is_finite()).map(|t| tokio::time::Instant::now() + Duration::from_millis(t as u64));
    let mut kill_at: Option<tokio::time::Instant> = None;
    let status = loop {
        let until = if timed_out { None } else { deadline };
        let kill = kill_at;
        let watching = !aborted;
        let abort_rx = &mut abort;
        let timeout_fut = async move {
            match until {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending().await,
            }
        };
        let kill_fut = async move {
            match kill {
                Some(k) => tokio::time::sleep_until(k).await,
                None => std::future::pending().await,
            }
        };
        let abort_fut = async move {
            if watching {
                wait_true(abort_rx).await
            } else {
                std::future::pending::<()>().await
            }
        };
        tokio::select! {
            st = child.wait() => break st.ok(),
            _ = timeout_fut => {
                timed_out = true;
                if let Some(p) = pid { kill_tree(p, Sig::Term); }
                kill_at.get_or_insert(tokio::time::Instant::now() + KILL_GRACE);
            }
            _ = abort_fut => {
                aborted = true;
                if let Some(p) = pid { kill_tree(p, Sig::Term); }
                kill_at.get_or_insert(tokio::time::Instant::now() + KILL_GRACE);
            }
            _ = kill_fut => {
                if let Some(p) = pid { kill_tree(p, Sig::Kill); }
                kill_at = None;
            }
        }
    };
    // background children can keep the pipes open forever; drain briefly then stop
    let (a1, a2) = (p1.abort_handle(), p2.abort_handle());
    let drained = tokio::time::timeout(DRAIN_GRACE, async {
        let _ = p1.await;
        let _ = p2.await;
    })
    .await
    .is_ok();
    if !drained {
        a1.abort();
        a2.abort();
    }
    if timed_out || aborted {
        // make sure stragglers in the group die too
        if let Some(p) = pid {
            kill_tree(p, Sig::Kill);
        }
    }
    untrack(pid);
    let exit = status.and_then(|s| s.code());
    let take = |b: Arc<Mutex<HeadTail>>| {
        let mut g = b.lock().unwrap();
        std::mem::replace(&mut *g, HeadTail::new(0)).finish()
    };
    result(exit, take(out_buf), take(err_buf), timed_out, aborted, started)
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

pub enum StdinCmd {
    Data(Vec<u8>),
    End,
}

/// The parts of a running process the connection keeps.
pub struct ProcHandle {
    pub stdin: mpsc::UnboundedSender<StdinCmd>,
    pub kill: mpsc::UnboundedSender<Sig>,
}

/// Where proc.* events go: (type, data) for output, then the exit code.
pub trait ProcSink: Send + Sync + 'static {
    fn output(&self, stream: &'static str, data: String) -> futures_util::future::BoxFuture<'static, ()>;
    fn exit(&self, code: Option<i32>) -> futures_util::future::BoxFuture<'static, ()>;
}

/// LocalMachine.spawn: no shell, stdin/stdout/stderr piped, own process group.
/// Returns the handle and the OS pid; output and exit go to `sink`.
pub fn spawn(command: &str, args: &[String], cwd: &str, env: Option<&Map<String, Value>>, sink: Arc<dyn ProcSink>) -> Result<(ProcHandle, Option<u32>), WireError> {
    let home = crate::paths::home_dir();
    let cwd = crate::paths::resolve_with(if cwd.is_empty() { "." } else { cwd }, &home, &home, cfg!(windows));
    let envs = crate::env::tool_env(env);
    let has_sep = command.contains('/') || (cfg!(windows) && command.contains('\\'));
    // a background shell asks for bash -c (tools/shells.ts): on Windows that is this daemon's shell, which may be off PATH or cmd.exe
    let via_shell = cfg!(windows) && (command == "bash" || command == "sh") && args.len() == 2 && args[0] == "-c";
    let program = if via_shell {
        std::path::PathBuf::from(shell())
    } else if has_sep {
        std::path::PathBuf::from(command)
    } else {
        let path_var = envs.iter().find(|(k, _)| if cfg!(windows) { k.to_string_lossy().eq_ignore_ascii_case("PATH") } else { k.as_os_str() == "PATH" }).map(|(_, v)| v.clone());
        match crate::env::which_in(command, path_var.as_ref()) {
            Some(p) => p,
            None => return Err(WireError::coded(format!("Executable not found in $PATH: \"{command}\""), "ENOENT")),
        }
    };
    let mut cmd = if via_shell {
        shell_command(shell(), &args[1])
    } else {
        let mut c = tokio::process::Command::new(&program);
        c.args(args);
        c
    };
    cmd.current_dir(&cwd).env_clear().envs(envs);
    if via_shell {
        no_cwd_lookup(&mut cmd, shell());
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    configure(&mut cmd, true);
    let mut child = cmd.spawn().map_err(|e| spawn_error(&e, command))?;
    let pid = child.id();
    track(pid);

    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<StdinCmd>();
    let mut sin = child.stdin.take();
    tokio::spawn(async move {
        while let Some(cmd) = stdin_rx.recv().await {
            match cmd {
                StdinCmd::Data(d) => {
                    // a process that went away drops what it is sent
                    if let Some(s) = sin.as_mut() {
                        if s.write_all(&d).await.is_ok() {
                            let _ = s.flush().await;
                        }
                    }
                }
                StdinCmd::End => {
                    if let Some(mut s) = sin.take() {
                        let _ = s.shutdown().await;
                    }
                }
            }
        }
    });

    let pump = |reader: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>, which: &'static str, sink: Arc<dyn ProcSink>| {
        tokio::spawn(async move {
            let Some(mut r) = reader else { return };
            let mut chunk = vec![0u8; READ_CHUNK];
            loop {
                match r.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => sink.output(which, encode_base64(&chunk[..n])).await,
                }
            }
        })
    };
    let so = child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let se = child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let p1 = pump(so, "proc.stdout", sink.clone());
    let p2 = pump(se, "proc.stderr", sink.clone());

    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<Sig>();
    tokio::spawn(async move {
        let mut code: Option<i32> = None;
        let mut exited = false;
        let pumps = async {
            let _ = p1.await;
            let _ = p2.await;
        };
        tokio::pin!(pumps);
        let mut pumps_done = false;
        loop {
            tokio::select! {
                st = child.wait(), if !exited => {
                    exited = true;
                    code = st.ok().and_then(|s| s.code());
                    untrack(pid);
                }
                _ = &mut pumps, if !pumps_done => { pumps_done = true; }
                Some(sig) = kill_rx.recv() => {
                    #[cfg(windows)]
                    {
                        if !exited {
                            match pid {
                                Some(p) => kill_tree(p, sig),
                                None => { let _ = child.start_kill(); }
                            }
                        }
                    }
                    #[cfg(unix)]
                    { if let Some(p) = pid { kill_tree(p, sig); } }
                    let _ = sig;
                }
            }
            if exited && pumps_done {
                break;
            }
        }
        // all output goes out before proc.exit so the hub never drops a tail
        sink.exit(code).await;
    });
    Ok((ProcHandle { stdin: stdin_tx, kill: kill_tx }, pid))
}

// ---------------------------------------------------------------------------
// connect (protocol 6): a TCP stream to a loopback port, as machine/connect.ts
// ---------------------------------------------------------------------------

/// The port connect takes: a whole number from 1024 to 65535, else the TypeScript daemon's EACCES.
pub fn check_port(v: Option<&Value>) -> Result<u16, WireError> {
    match v.and_then(Value::as_u64) {
        Some(p) if (1024..=65535).contains(&p) && v.and_then(Value::as_f64).map_or(false, |f| f.fract() == 0.0) => Ok(p as u16),
        _ => {
            let shown = v.map(|x| x.to_string()).unwrap_or_else(|| "undefined".into());
            Err(WireError::coded(format!("Port {shown} is not allowed: only loopback ports 1024 to 65535."), "EACCES"))
        }
    }
}

/// Open 127.0.0.1:port, then ::1:port when IPv4 refuses. Bytes from the port go
/// to the sink as proc.stdout; a failed connect is one proc.stderr line and exit null;
/// a close from either side (or kill) is exit 0. Nothing happens until the
/// returned sender fires: the caller records the handle and sends the result
/// first, so a fast refusal's proc.exit never comes before them.
pub fn connect(port: u16, sink: Arc<dyn ProcSink>) -> (ProcHandle, tokio::sync::oneshot::Sender<()>) {
    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<StdinCmd>();
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<Sig>();
    let (go_tx, go_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        if go_rx.await.is_err() {
            return;
        }
        let stream = match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => tokio::net::TcpStream::connect(("::1", port)).await.map_err(|e| ("::1", e)),
            Err(e) => Err(("127.0.0.1", e)),
        };
        let stream = match stream {
            Ok(s) => s,
            Err((host, e)) => {
                sink.output("proc.stderr", encode_base64(format!("connect {host}:{port}: {}\n", errno_code(&e)).as_bytes())).await;
                sink.exit(None).await;
                return;
            }
        };
        let (mut rd, mut wr) = stream.into_split();
        let writer = tokio::spawn(async move {
            while let Some(cmd) = stdin_rx.recv().await {
                match cmd {
                    StdinCmd::Data(d) => {
                        if wr.write_all(&d).await.is_err() {
                            break;
                        }
                    }
                    StdinCmd::End => {
                        let _ = wr.shutdown().await;
                    }
                }
            }
        });
        let mut chunk = vec![0u8; READ_CHUNK];
        loop {
            tokio::select! {
                r = rd.read(&mut chunk) => match r {
                    Ok(0) | Err(_) => break,
                    Ok(n) => sink.output("proc.stdout", encode_base64(&chunk[..n])).await,
                },
                Some(_) = kill_rx.recv() => break,
            }
        }
        writer.abort();
        sink.exit(Some(0)).await;
    });
    (ProcHandle { stdin: stdin_tx, kill: kill_tx }, go_tx)
}

// ---------------------------------------------------------------------------
// A short command for info (CLI versions) and search (rg).
// ---------------------------------------------------------------------------

pub struct Captured {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

/// Run argv to completion with the daemon's own environment, killing it after
/// `timeout`. Output past the caps is not read (readAllText's maxBytes).
pub async fn capture(argv: &[String], cwd: Option<&str>, timeout: Duration, max_out: usize, max_err: usize) -> std::io::Result<Captured> {
    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    configure(&mut cmd, false);
    let mut child = cmd.spawn()?;
    let read = |r: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>, cap: usize| async move {
        let Some(mut r) = r else { return String::new() };
        let mut dec = Utf8Stream::default();
        let mut out = String::new();
        let mut total = 0usize;
        let mut chunk = vec![0u8; READ_CHUNK];
        loop {
            match r.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    total += n;
                    if total > cap {
                        return out;
                    }
                    out.push_str(&dec.push(&chunk[..n]));
                }
            }
        }
        out.push_str(&dec.finish());
        out
    };
    let so = child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let se = child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let pid = child.id();
    // past the timeout the process is killed; what it wrote so far still counts
    let killer = tokio::spawn(async move {
        tokio::time::sleep(timeout).await;
        if let Some(p) = pid {
            #[cfg(unix)]
            // SAFETY: kill(2) on the child we started.
            unsafe {
                libc::kill(p as i32, libc::SIGKILL);
            }
            #[cfg(windows)]
            kill_tree(p, Sig::Kill);
        }
    });
    // a grandchild holding the pipes (a .cmd shim's node, a backgrounded job) outlives the kill above: stop reading then too.
    // shortcut: its output so far is dropped in that case, keep partial reads if a caller ever needs them
    let reads = async { tokio::join!(read(so, max_out), read(se, max_err)) };
    let (stdout, stderr) = tokio::time::timeout(timeout + DRAIN_GRACE, reads).await.unwrap_or_default();
    let st = child.wait().await.ok();
    killer.abort();
    Ok(Captured { stdout, stderr, code: st.and_then(|s| s.code()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(path: &str, files: &[&str]) -> Option<String> {
        let env = |k: &str| match k {
            "ProgramFiles" => Some(r"C:\Program Files".to_string()),
            "LOCALAPPDATA" => Some(r"C:\Users\n\AppData\Local".to_string()),
            _ => None,
        };
        let is_file = |p: &str| files.iter().any(|f| f.eq_ignore_ascii_case(p));
        windows_bash(path, &env, &is_file)
    }

    const WSL: &str = r"C:\Users\n\AppData\Local\Microsoft\WindowsApps\bash.exe";

    #[test]
    fn windows_bash_follows_git_on_path_before_wsl() {
        let path = r"C:\Users\n\AppData\Local\Microsoft\WindowsApps;C:\Windows\System32;D:\Tools\Git\cmd";
        let files = [WSL, r"C:\Windows\System32\bash.exe", r"D:\Tools\Git\cmd\git.exe", r"D:\Tools\Git\bin\bash.exe"];
        assert_eq!(pick(path, &files).as_deref(), Some(r"D:\Tools\Git\bin\bash.exe"));
        // git.exe from <Git>\mingw64\bin, with a trailing slash and quotes
        let files = [WSL, r"E:\Git\mingw64\bin\git.exe", r"E:\Git\bin\bash.exe"];
        assert_eq!(pick(r#""E:\Git\mingw64\bin\";C:\Users\n\AppData\Local\Microsoft\WindowsApps"#, &files).as_deref(), Some(r"E:\Git\bin\bash.exe"));
    }

    #[test]
    fn windows_bash_tries_standard_folders() {
        let path = r"C:\Users\n\AppData\Local\Microsoft\WindowsApps";
        assert_eq!(pick(path, &[WSL, r"C:\Program Files\Git\bin\bash.exe"]).as_deref(), Some(r"C:\Program Files\Git\bin\bash.exe"));
        assert_eq!(pick(path, &[WSL, r"C:\Users\n\AppData\Local\Programs\Git\bin\bash.exe"]).as_deref(), Some(r"C:\Users\n\AppData\Local\Programs\Git\bin\bash.exe"));
    }

    #[test]
    fn windows_bash_never_picks_the_wsl_launcher() {
        let path = r"C:\Users\n\AppData\Local\Microsoft\WindowsApps;C:\WINDOWS\system32";
        assert_eq!(pick(path, &[WSL, r"C:\WINDOWS\system32\bash.exe"]), None);
        assert_eq!(pick("", &[]), None);
        // another bash on PATH (MSYS2) is fine
        assert_eq!(pick(r"C:\msys64\usr\bin;C:\WINDOWS\system32", &[r"C:\msys64\usr\bin\bash.exe"]).as_deref(), Some(r"C:\msys64\usr\bin\bash.exe"));
    }

    #[test]
    fn head_tail_keeps_both_ends() {
        let mut b = HeadTail::new(50);
        for _ in 0..100 {
            b.push("abcdefghij");
        }
        let s = b.finish();
        assert_eq!(s, "abcdefghijabcdefghijabcde\n[... 950 characters of output dropped ...]\nfghijabcdefghijabcdefghij");
        let mut b = HeadTail::new(50);
        b.push("short");
        assert_eq!(b.finish(), "short");
    }

    #[test]
    fn is_cmd_matches_cmd_exe_only() {
        assert!(is_cmd("cmd.exe"));
        assert!(is_cmd("C:\\WINDOWS\\system32\\CMD.EXE"));
        assert!(is_cmd("cmd"));
        assert!(!is_cmd("C:\\Program Files\\Git\\bin\\bash.exe"));
        assert!(!is_cmd("/usr/bin/bash"));
        assert!(!is_cmd("C:\\tools\\notcmd.exe"));
    }

    #[test]
    fn head_tail_counts_utf16() {
        let mut b = HeadTail::new(4);
        b.push("é😀xyzw");
        // head holds 2 units: "é" and not half of the emoji
        let s = b.finish();
        assert!(s.starts_with('é'), "{s}");
        assert!(s.ends_with("zw"), "{s}");
    }

    #[cfg(unix)]
    #[test]
    fn capture_ends_at_its_timeout_when_a_grandchild_keeps_the_pipes() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            // `--version` of a shim that leaves a child behind on stdout: info() waited for it before the hello
            let argv: Vec<String> = ["/bin/sh", "-c", "(sleep 15) & echo 1.2.3"].iter().map(|s| s.to_string()).collect();
            let started = Instant::now();
            let c = capture(&argv, None, Duration::from_millis(300), 1024, 1024).await.unwrap();
            assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
            let _ = c;
        });
    }

    // Real cmd.exe and taskkill on Windows CI: cargo test windows_cmd
    #[cfg(windows)]
    mod win {
        use super::*;
        use futures_util::future::BoxFuture;

        fn rt() -> tokio::runtime::Runtime {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
        }

        fn comspec() -> String {
            let c = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
            assert!(is_cmd(&c), "ComSpec is not cmd: {c}");
            c
        }

        /// shell_command with the real ComSpec: (exit code, stdout with \n line ends, stderr).
        fn run_cmd(command: &str) -> (Option<i32>, String, String) {
            rt().block_on(async {
                let mut cmd = shell_command(&comspec(), command);
                cmd.env("CV_WIN_CMD_VAR", "hello there").stdin(Stdio::null());
                let out = cmd.output().await.unwrap();
                (out.status.code(), String::from_utf8_lossy(&out.stdout).replace("\r\n", "\n"), String::from_utf8_lossy(&out.stderr).into_owned())
            })
        }

        fn temp_dir(name: &str) -> std::path::PathBuf {
            let d = std::env::temp_dir().join(format!("cv win cmd {name} {}", std::process::id()));
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        #[test]
        fn windows_cmd_runs_a_quoted_program_path_with_spaces_and_quoted_args() {
            let dir = temp_dir("path");
            let bat = dir.join("say it.cmd");
            std::fs::write(&bat, "@echo [%~1] [%2]\r\n").unwrap();
            // first and last character are both quotes: without /s and the outer pair cmd would strip them
            let (code, out, err) = run_cmd(&format!("\"{}\" \"x y\" \"z\"", bat.display()));
            let _ = std::fs::remove_dir_all(&dir);
            assert_eq!((code, out.trim_end()), (Some(0), "[x y] [\"z\"]"), "stderr: {err}");
        }

        #[test]
        fn windows_cmd_keeps_inner_quotes() {
            let (code, out, err) = run_cmd("echo 'c'& echo \"a b\"");
            assert_eq!((code, out.as_str()), (Some(0), "'c'\n\"a b\"\n"), "stderr: {err}");
        }

        #[test]
        fn windows_cmd_expands_percent_vars_and_not_bang_vars() {
            // /v:off: !NAME! stays literal
            let (code, out, err) = run_cmd("echo %CV_WIN_CMD_VAR%^|!CV_WIN_CMD_VAR!");
            assert_eq!((code, out.trim_end()), (Some(0), "hello there|!CV_WIN_CMD_VAR!"), "stderr: {err}");
        }

        #[test]
        fn windows_cmd_returns_the_exit_status() {
            assert_eq!(run_cmd("exit 5").0, Some(5));
            assert_eq!(run_cmd("echo x>nul& exit 42").0, Some(42));
            assert_eq!(run_cmd("ver>nul").0, Some(0));
        }

        #[test]
        fn windows_cmd_kill_tree_ends_the_shell_and_its_child() {
            rt().block_on(async {
                let mut cmd = shell_command(&comspec(), "ping -n 30 127.0.0.1 && echo after");
                cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
                configure(&mut cmd, true);
                let mut child = cmd.spawn().unwrap();
                let mut out = child.stdout.take().unwrap();
                tokio::time::sleep(Duration::from_millis(500)).await;
                kill_tree(child.id().unwrap(), Sig::Term);
                let mut buf = Vec::new();
                // ping holds the pipe too: EOF only comes once the whole tree is gone
                tokio::time::timeout(Duration::from_secs(10), out.read_to_end(&mut buf)).await.expect("pipe still open, ping outlived kill_tree").unwrap();
                assert!(!child.wait().await.unwrap().success());
                assert!(!String::from_utf8_lossy(&buf).contains("after"));
            });
        }

        fn cwd() -> String {
            std::env::temp_dir().to_string_lossy().into_owned()
        }

        fn exec_opts(timeout_ms: Option<f64>) -> ExecOpts {
            ExecOpts { cwd: cwd(), env: None, timeout_ms, stdin: None, max_output: None }
        }

        // exec and spawn run shell(): Git Bash on CI, cmd.exe without it. These commands mean the same in both.
        #[test]
        fn windows_cmd_exec_returns_output_and_exit_status() {
            rt().block_on(async {
                let (_abort, rx) = watch::channel(false);
                let r = exec("echo hi&& exit 3".into(), exec_opts(None), rx, None).await;
                assert_eq!(r["exitCode"].as_i64(), Some(3), "{r}");
                assert_eq!(r["stdout"].as_str().map(str::trim_end), Some("hi"), "{r}");
            });
        }

        #[test]
        fn windows_cmd_exec_times_out_and_kills_the_tree() {
            rt().block_on(async {
                let (_abort, rx) = watch::channel(false);
                let started = Instant::now();
                let r = exec("ping -n 30 127.0.0.1 && echo after".into(), exec_opts(Some(500.0)), rx, None).await;
                assert_eq!(r["timedOut"], json!(true), "{r}");
                assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
                assert!(!r["stdout"].as_str().unwrap().contains("after"), "{r}");
            });
        }

        struct Collect {
            out: Mutex<Vec<u8>>,
            exit: Mutex<Option<tokio::sync::oneshot::Sender<Option<i32>>>>,
        }

        impl ProcSink for Collect {
            fn output(&self, stream: &'static str, data: String) -> BoxFuture<'static, ()> {
                if stream == "proc.stdout" {
                    self.out.lock().unwrap().extend(crate::js::decode_base64_lenient(&data));
                }
                Box::pin(async {})
            }
            fn exit(&self, code: Option<i32>) -> BoxFuture<'static, ()> {
                if let Some(tx) = self.exit.lock().unwrap().take() {
                    let _ = tx.send(code);
                }
                Box::pin(async {})
            }
        }

        fn collect() -> (Arc<Collect>, tokio::sync::oneshot::Receiver<Option<i32>>) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            (Arc::new(Collect { out: Mutex::new(Vec::new()), exit: Mutex::new(Some(tx)) }), rx)
        }

        fn bash_c(command: &str) -> Vec<String> {
            vec!["-c".into(), command.into()]
        }

        #[test]
        fn windows_cmd_spawn_background_shell_returns_output_and_exit_status() {
            rt().block_on(async {
                let (sink, exit) = collect();
                let _h = spawn("bash", &bash_c("echo hi&& exit 3"), &cwd(), None, sink.clone()).unwrap();
                let code = tokio::time::timeout(Duration::from_secs(20), exit).await.expect("no proc.exit").unwrap();
                assert_eq!(code, Some(3));
                assert_eq!(String::from_utf8_lossy(&sink.out.lock().unwrap()).trim_end(), "hi");
            });
        }

        #[test]
        fn windows_cmd_spawn_kill_ends_the_tree() {
            rt().block_on(async {
                let (sink, exit) = collect();
                let (h, _) = spawn("bash", &bash_c("ping -n 30 127.0.0.1 && echo after"), &cwd(), None, sink.clone()).unwrap();
                tokio::time::sleep(Duration::from_millis(500)).await;
                h.kill.send(Sig::Term).unwrap();
                // proc.exit waits for both pipes, so a surviving ping would hold it back
                let code = tokio::time::timeout(Duration::from_secs(10), exit).await.expect("no proc.exit, the tree outlived kill").unwrap();
                assert_ne!(code, Some(0));
                assert!(!String::from_utf8_lossy(&sink.out.lock().unwrap()).contains("after"));
            });
        }
    }
}
