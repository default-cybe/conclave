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
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
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

/// bash when available, else sh (cmd.exe on Windows).
pub fn shell() -> &'static str {
    static SHELL: OnceLock<String> = OnceLock::new();
    SHELL.get_or_init(|| match crate::env::which("bash") {
        Some(p) => p.to_string_lossy().into_owned(),
        None => {
            if cfg!(windows) {
                "cmd.exe".into()
            } else {
                "/bin/sh".into()
            }
        }
    })
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
    let mut cmd = tokio::process::Command::new(sh);
    if sh.to_ascii_lowercase().ends_with("cmd.exe") {
        #[cfg(windows)]
        {
            cmd.args(["/d", "/s", "/c"]);
            cmd.raw_arg(format!("\"{command}\""));
        }
    } else {
        cmd.arg("-c").arg(&command);
    }
    cmd.current_dir(&cwd).env_clear().envs(crate::env::tool_env(opts.env.as_ref()));
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
    let program = if has_sep {
        std::path::PathBuf::from(command)
    } else {
        let path_var = envs.iter().find(|(k, _)| if cfg!(windows) { k.to_string_lossy().eq_ignore_ascii_case("PATH") } else { k.as_os_str() == "PATH" }).map(|(_, v)| v.clone());
        match crate::env::which_in(command, path_var.as_ref()) {
            Some(p) => p,
            None => return Err(WireError::coded(format!("Executable not found in $PATH: \"{command}\""), "ENOENT")),
        }
    };
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(args).current_dir(&cwd).env_clear().envs(envs);
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
                    { if !exited { let _ = child.start_kill(); } }
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
    let (stdout, stderr) = tokio::join!(read(so, max_out), read(se, max_err));
    let st = child.wait().await.ok();
    killer.abort();
    Ok(Captured { stdout, stderr, code: st.and_then(|s| s.code()) })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn head_tail_counts_utf16() {
        let mut b = HeadTail::new(4);
        b.push("é😀xyzw");
        // head holds 2 units: "é" and not half of the emoji
        let s = b.finish();
        assert!(s.starts_with('é'), "{s}");
        assert!(s.ends_with("zw"), "{s}");
    }
}
