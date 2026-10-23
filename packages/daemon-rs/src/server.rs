//! MachineServer from machine/daemon.ts: serves the hub's RPCs on this
//! machine, one instance per connection. spawn is handled in line so that
//! proc.stdin frames right behind the request find the process.

use crate::errors::WireError;
use crate::js::{as_str, decode_base64_lenient};
use crate::procs::{self, ProcHandle, ProcSink, Sig, StdinCmd};
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, watch};

/// Frames to the hub, in order. Bounded, so a process that prints fast waits for the socket.
pub type Out = mpsc::Sender<String>;

pub async fn send(out: &Out, v: Value) {
    let _ = out.send(v.to_string()).await;
}

#[derive(Default)]
struct State {
    procs: HashMap<i64, ProcHandle>,
    execs: HashMap<String, watch::Sender<bool>>,
    closed: bool,
}

#[derive(Clone)]
pub struct MachineServer {
    out: Out,
    state: Arc<Mutex<State>>,
}

fn id_key(id: &Value) -> String {
    id.to_string()
}

fn result_msg(id: &Value, r: Result<Value, WireError>) -> Value {
    match r {
        Ok(v) => json!({ "type": "result", "id": id, "result": v }),
        Err(e) => json!({ "type": "result", "id": id, "error": e.to_json() }),
    }
}

fn str_param(p: &Value, k: &str) -> Result<String, WireError> {
    match p.get(k) {
        Some(Value::String(s)) => Ok(s.clone()),
        other => Err(WireError::coded(
            format!("The \"{k}\" argument must be of type string. Received {}", other.map(|v| v.to_string()).unwrap_or_else(|| "undefined".into())),
            "ERR_INVALID_ARG_TYPE",
        )),
    }
}

fn opt_str(p: Option<&Value>, k: &str) -> Option<String> {
    as_str(p.and_then(|o| o.get(k))).map(str::to_string)
}

fn num_param(p: Option<&Value>, k: &str) -> Option<f64> {
    p.and_then(|o| o.get(k)).and_then(Value::as_f64)
}

fn bool_param(p: Option<&Value>, k: &str) -> Option<bool> {
    p.and_then(|o| o.get(k)).and_then(Value::as_bool)
}

/// Run sync work on the blocking pool. A panic there fails this request only.
async fn blocking<F>(f: F) -> Result<Value, WireError>
where
    F: FnOnce() -> Result<Value, WireError> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(WireError::new(format!("internal error: {e}"))),
    }
}

struct Sink {
    out: Out,
    handle: i64,
    state: Arc<Mutex<State>>,
}

impl ProcSink for Sink {
    fn output(&self, stream: &'static str, data: String) -> BoxFuture<'static, ()> {
        let out = self.out.clone();
        let msg = json!({ "type": stream, "pid": self.handle, "data": data });
        async move { send(&out, msg).await }.boxed()
    }
    fn exit(&self, code: Option<i32>) -> BoxFuture<'static, ()> {
        let out = self.out.clone();
        let handle = self.handle;
        let state = self.state.clone();
        async move {
            let closed = {
                let mut s = state.lock().unwrap();
                s.procs.remove(&handle);
                s.closed
            };
            if !closed {
                send(&out, json!({ "type": "proc.exit", "pid": handle, "code": code })).await;
            }
        }
        .boxed()
    }
}

impl MachineServer {
    pub fn new(out: Out) -> Self {
        MachineServer { out, state: Arc::new(Mutex::new(State::default())) }
    }

    fn closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    /// One parsed hub message (not welcome, addresses, error or pong).
    pub async fn handle(&self, msg: Value) {
        if self.closed() {
            return;
        }
        match as_str(msg.get("type")) {
            Some("rpc") => self.rpc(msg).await,
            Some("proc.stdin") => {
                let Some(pid) = msg.get("pid").and_then(Value::as_i64) else { return };
                let s = self.state.lock().unwrap();
                let Some(p) = s.procs.get(&pid) else { return };
                if let Some(d) = as_str(msg.get("data")).filter(|d| !d.is_empty()) {
                    let _ = p.stdin.send(StdinCmd::Data(decode_base64_lenient(d)));
                }
                if msg.get("end").and_then(Value::as_bool).unwrap_or(false) {
                    let _ = p.stdin.send(StdinCmd::End);
                }
            }
            Some("proc.kill") => {
                let Some(pid) = msg.get("pid").and_then(Value::as_i64) else { return };
                let s = self.state.lock().unwrap();
                if let Some(p) = s.procs.get(&pid) {
                    let _ = p.kill.send(Sig::parse(as_str(msg.get("signal"))));
                }
            }
            Some("exec.abort") => {
                let Some(id) = msg.get("id") else { return };
                if let Some(tx) = self.state.lock().unwrap().execs.get(&id_key(id)) {
                    let _ = tx.send(true);
                }
            }
            Some("ping") => {
                let ts = msg.get("ts").cloned().unwrap_or(Value::Null);
                send(&self.out, json!({ "type": "pong", "ts": ts })).await;
            }
            _ => {}
        }
    }

    fn reply<F>(&self, id: Value, fut: F)
    where
        F: std::future::Future<Output = Result<Value, WireError>> + Send + 'static,
    {
        let out = self.out.clone();
        let state = self.state.clone();
        tokio::spawn(async move {
            let r = fut.await;
            if state.lock().unwrap().closed {
                return;
            }
            send(&out, result_msg(&id, r)).await;
        });
    }

    async fn rpc(&self, msg: Value) {
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let method = as_str(msg.get("method")).unwrap_or("").to_string();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        match method.as_str() {
            "info" => self.reply(id, async { Ok(crate::info::info().await) }),
            "stat" => self.reply(id, async move {
                let path = str_param(&params, "path")?;
                blocking(move || crate::fsops::stat_json(&path)).await
            }),
            "readFile" => self.reply(id, async move {
                let path = str_param(&params, "path")?;
                blocking(move || {
                    crate::private::check(&path)?;
                    crate::fsops::read_file(&path)
                })
                .await
            }),
            "readText" => self.reply(id, async move {
                let path = str_param(&params, "path")?;
                blocking(move || {
                    crate::private::check(&path)?;
                    crate::fsops::read_text(&path)
                })
                .await
            }),
            "readRange" => self.reply(id, async move {
                let path = str_param(&params, "path")?;
                let offset = num_param(Some(&params), "offset").unwrap_or(0.0);
                let length = num_param(Some(&params), "length").unwrap_or(f64::NAN);
                blocking(move || {
                    crate::private::check(&path)?;
                    crate::fsops::read_range(&path, offset, length)
                })
                .await
            }),
            "writeFile" => self.reply(id, async move {
                let path = str_param(&params, "path")?;
                let data: Vec<u8> = match params.get("base64") {
                    Some(Value::String(b)) => decode_base64_lenient(b),
                    _ => opt_str(Some(&params), "text").unwrap_or_default().into_bytes(),
                };
                blocking(move || {
                    crate::private::check(&path)?;
                    crate::fsops::write_file(&path, &data).map(|_| Value::Null)
                })
                .await
            }),
            "readdir" => self.reply(id, async move {
                let path = str_param(&params, "path")?;
                blocking(move || {
                    crate::private::check(&path)?;
                    crate::fsops::readdir(&path)
                })
                .await
            }),
            "mkdir" => self.reply(id, async move {
                let path = str_param(&params, "path")?;
                blocking(move || {
                    crate::private::check(&path)?;
                    crate::fsops::mkdir_p(&path).map(|_| Value::Null)
                })
                .await
            }),
            "remove" => self.reply(id, async move {
                let path = str_param(&params, "path")?;
                let rec = bool_param(Some(&params), "recursive").unwrap_or(false);
                blocking(move || {
                    crate::private::check_remove(&path, rec)?;
                    crate::fsops::remove(&path, rec).map(|_| Value::Null)
                })
                .await
            }),
            "rename" => self.reply(id, async move {
                let from = str_param(&params, "from")?;
                let to = str_param(&params, "to")?;
                blocking(move || {
                    crate::private::check(&from)?;
                    crate::private::check(&to)?;
                    crate::fsops::rename(&from, &to).map(|_| Value::Null)
                })
                .await
            }),
            "resolve" => self.reply(id, async move {
                let path = str_param(&params, "path")?;
                let cwd = opt_str(Some(&params), "cwd").unwrap_or_default();
                Ok(Value::String(crate::paths::resolve(&path, &cwd)))
            }),
            "glob" => self.reply(id, async move {
                let pattern = str_param(&params, "pattern")?;
                let o = params.get("opts");
                let opts = crate::search::GlobOpts {
                    cwd: opt_str(o, "cwd").unwrap_or_default(),
                    limit: num_param(o, "limit").map(|n| n.max(0.0) as usize),
                    include_ignored: bool_param(o, "includeIgnored").unwrap_or(false),
                    dot: bool_param(o, "dot"),
                };
                crate::search::glob(&pattern, opts).await
            }),
            "grep" => self.reply(id, async move {
                let o = params.get("opts");
                let opts = crate::search::GrepOpts {
                    pattern: opt_str(o, "pattern").unwrap_or_default(),
                    path: opt_str(o, "path").unwrap_or_default(),
                    glob: opt_str(o, "glob"),
                    file_type: opt_str(o, "type"),
                    case_insensitive: bool_param(o, "caseInsensitive").unwrap_or(false),
                    multiline: bool_param(o, "multiline").unwrap_or(false),
                    mode: opt_str(o, "outputMode").unwrap_or_else(|| "content".into()),
                    before: num_param(o, "before").map(|n| n.max(0.0) as usize).unwrap_or(0),
                    after: num_param(o, "after").map(|n| n.max(0.0) as usize).unwrap_or(0),
                    line_numbers: bool_param(o, "lineNumbers") != Some(false),
                    limit: num_param(o, "limit").filter(|n| *n > 0.0).map(|n| n as usize),
                    offset: num_param(o, "offset").map(|n| n.max(0.0) as usize).unwrap_or(0),
                };
                crate::search::grep(opts).await
            }),
            "exec" => {
                let command = opt_str(Some(&params), "command").unwrap_or_default();
                let o = params.get("opts");
                let opts = procs::ExecOpts {
                    cwd: opt_str(o, "cwd").unwrap_or_default(),
                    env: o.and_then(|x| x.get("env")).and_then(Value::as_object).cloned(),
                    timeout_ms: num_param(o, "timeoutMs"),
                    stdin: opt_str(o, "stdin"),
                    max_output: num_param(o, "maxOutputBytes").filter(|n| *n > 0.0).map(|n| n as usize),
                };
                let stream = bool_param(o, "stream").unwrap_or(false);
                let (tx, rx) = watch::channel(false);
                let key = id_key(&id);
                self.state.lock().unwrap().execs.insert(key.clone(), tx);
                let on_output: Option<procs::OnOutput> = if stream {
                    let out = self.out.clone();
                    let id2 = id.clone();
                    Some(Arc::new(move |data: String, which: &'static str| {
                        let out = out.clone();
                        let msg = json!({ "type": "exec.output", "id": id2, "stream": which, "data": data });
                        async move { send(&out, msg).await }.boxed()
                    }))
                } else {
                    None
                };
                let state = self.state.clone();
                self.reply(id, async move {
                    let r = procs::exec(command, opts, rx, on_output).await;
                    state.lock().unwrap().execs.remove(&key);
                    Ok(r)
                });
            }
            "spawn" => self.spawn(id, params).await,
            "syncthingFolders" => self.reply(id, async { blocking(|| Ok(crate::syncthing::folders_json(&crate::paths::home_dir()))).await }),
            "syncthingStatus" => self.reply(id, async move {
                let folder = opt_str(Some(&params), "folderId").unwrap_or_default();
                crate::syncthing::status(&folder, &crate::paths::home_dir()).await
            }),
            "importScan" => self.reply(id, async move { blocking(move || crate::import::scan(&params)).await }),
            // protocol 3: this daemon's recent log for the hub's logs export, secrets filtered here
            "logTail" => self.reply(id, async move {
                let n = num_param(Some(&params), "lines").filter(|v| v.is_finite() && *v >= 1.0).unwrap_or(500.0) as usize;
                blocking(move || Ok(crate::logring::log_tail(n, Some(&crate::config::logs_dir().join("daemon.log"))))).await
            }),
            "importRead" => self.reply(id, async move { blocking(move || crate::import::read(&params)).await }),
            // protocol 4: replace this binary with the hub's version (update.rs)
            "selfUpdate" => self.reply(id, async move { crate::update::self_update(params).await }),
            other => {
                let msg = json!({ "type": "result", "id": id, "error": { "message": format!("unknown method {other}") } });
                send(&self.out, msg).await;
            }
        }
    }

    async fn spawn(&self, id: Value, params: Value) {
        let handle = params.get("handle").and_then(Value::as_i64).unwrap_or(0);
        let command = opt_str(Some(&params), "command").unwrap_or_default();
        let args: Vec<String> = match params.get("args") {
            Some(Value::Array(a)) => a.iter().map(|x| crate::js::js_string(Some(x))).collect(),
            _ => vec![],
        };
        let o = params.get("opts");
        let cwd = opt_str(o, "cwd").unwrap_or_default();
        let env: Option<Map<String, Value>> = o.and_then(|x| x.get("env")).and_then(Value::as_object).cloned();
        let sink = Arc::new(Sink { out: self.out.clone(), handle, state: self.state.clone() });
        // the result goes out before any output: spawn replies first, then the pumps start sending
        match procs::spawn(&command, &args, &cwd, env.as_ref(), sink) {
            Ok((h, pid)) => {
                self.state.lock().unwrap().procs.insert(handle, h);
                let result = match pid {
                    Some(p) => json!({ "pid": p }),
                    None => json!({}),
                };
                send(&self.out, json!({ "type": "result", "id": id, "result": result })).await;
            }
            Err(e) => send(&self.out, result_msg(&id, Err(e))).await,
        }
    }

    /// Kill processes and abort execs started by this connection.
    pub fn close(&self) {
        let mut s = self.state.lock().unwrap();
        if s.closed {
            return;
        }
        s.closed = true;
        for tx in s.execs.values() {
            let _ = tx.send(true);
        }
        s.execs.clear();
        for p in s.procs.values() {
            let _ = p.kill.send(Sig::Term);
        }
        s.procs.clear();
    }
}
