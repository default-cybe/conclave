//! The connection loop from runDaemon (machine/daemon.ts): dial the hub,
//! say hello with MachineInfo, serve RPCs, ping every 20 seconds, and
//! reconnect forever with jittered backoff over every address of the hub.

use crate::server::MachineServer;
use futures_util::{SinkExt, StreamExt};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, protocol::CloseFrame, Message};

/// 3 adds logTail (the daemon's recent log for the hub's logs export). 4 adds
/// selfUpdate (the daemon replaces itself with the hub's version, update.rs).
/// 5 adds importAppend (Conclave's turns written into a Claude Code chat, import/writeback.rs).
pub const PROTOCOL_VERSION: u64 = 5;
pub const HEARTBEAT: Duration = Duration::from_millis(20_000);
const MAX_BACKOFF_MS: f64 = 30_000.0;
/// TCP, TLS and the upgrade together; then the next address is tried.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(src).unwrap())
}

/// http(s)://host[/prefix] -> ws(s)://host[/prefix]/api/daemon
pub fn daemon_url(hub: &str) -> String {
    let base = hub.trim_end_matches('/');
    let base = if base.len() >= 4 && base[..4].eq_ignore_ascii_case("http") { format!("ws{}", &base[4..]) } else { base.to_string() };
    if base.ends_with("/api/daemon") {
        base
    } else {
        format!("{base}/api/daemon")
    }
}

/// http(s) hub addresses without trailing slashes, duplicates or junk (at most 8).
pub fn hub_urls(list: &[Value]) -> Vec<String> {
    static OK: OnceLock<Regex> = OnceLock::new();
    let ok = re(&OK, r"(?i)^(https?|wss?)://[^\s/]+");
    let mut out: Vec<String> = Vec::new();
    for v in list {
        let Some(s) = v.as_str() else { continue };
        let u = crate::js::trim(s).trim_end_matches('/').to_string();
        if !ok.is_match(&u) || out.contains(&u) {
            continue;
        }
        out.push(u);
        if out.len() >= 8 {
            break;
        }
    }
    out
}

/// https://<words>.trycloudflare.com: never comes back once the hub drops it.
pub fn is_quick_tunnel_url(url: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^(https?|wss?)://[a-z0-9-]+\.trycloudflare\.com(:[0-9]+)?(/|$)").is_match(url)
}

/// localhost, 127.x and [::1]: the hub on this same machine.
pub fn is_loopback_url(url: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^(https?|wss?)://(localhost|127\.[0-9]+\.[0-9]+\.[0-9]+|\[::1\])(:[0-9]+)?(/|$)").is_match(url)
}

pub type OnAddresses = Box<dyn Fn(&[String]) + Send + Sync>;
pub type OnStatus = Box<dyn Fn(&Status) + Send + Sync>;

pub struct Options {
    pub hub: String,
    pub fallbacks: Vec<String>,
    pub device_id: String,
    pub token: String,
    pub name: Option<String>,
    /// The hub sent its addresses (best first).
    pub on_addresses: OnAddresses,
    pub on_status: OnStatus,
    /// Ping this often; three without a word from the hub end the connection.
    pub heartbeat: Duration,
}

#[derive(Debug, Clone)]
pub struct Status {
    pub state: &'static str,
    pub url: Option<String>,
    pub detail: Option<String>,
    pub retry_in_ms: Option<u64>,
}

/// Jitter: a small xorshift seeded from the clock.
fn random01() -> f64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEED: AtomicU64 = AtomicU64::new(0);
    let mut x = SEED.load(Ordering::Relaxed);
    if x == 0 {
        x = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1) | 1;
    }
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    SEED.store(x, Ordering::Relaxed);
    (x >> 11) as f64 / (1u64 << 53) as f64
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

enum Ended {
    /// Closed with this reason and close code.
    Closed(String, Option<u16>),
    /// The hub told us to move to another address.
    Moving,
    Stopped,
}

/// Connect and serve until `stop` turns true. Never gives up on its own.
pub async fn run(opts: Options, mut stop: watch::Receiver<bool>) {
    let mut all = vec![Value::String(opts.hub.clone())];
    all.extend(opts.fallbacks.iter().cloned().map(Value::String));
    let mut urls = hub_urls(&all);
    if urls.is_empty() {
        urls.push(opts.hub.clone());
    }
    let mut current = 0usize;
    let mut attempt: u32 = 0;
    loop {
        if *stop.borrow() {
            return;
        }
        let hub = urls.get(current).cloned().unwrap_or_else(|| opts.hub.clone());
        (opts.on_status)(&Status { state: "connecting", url: Some(hub.clone()), detail: None, retry_in_ms: None });
        let ended = once(&opts, &hub, &mut urls, &mut current, &mut attempt, &mut stop).await;
        match ended {
            Ended::Stopped => return,
            Ended::Moving => {
                // the hub announced a new address: go there now, not after a backoff
                attempt = 0;
                (opts.on_status)(&Status { state: "offline", url: urls.get(current).cloned(), detail: Some("moving to a new hub address".into()), retry_in_ms: Some(0) });
                continue;
            }
            Ended::Closed(reason, code) => {
                // 4000: another daemon with the same device id took over; do not fight it
                if code == Some(4000) {
                    attempt = attempt.max(16);
                }
                if urls.len() > 1 {
                    current = (current + 1) % urls.len();
                }
                let base = MAX_BACKOFF_MS.min(1000.0 * 2f64.powi(attempt.min(30) as i32));
                let delay = (base / 2.0 + random01() * (base / 2.0)).round() as u64;
                attempt += 1;
                (opts.on_status)(&Status { state: "offline", url: urls.get(current).cloned(), detail: Some(reason), retry_in_ms: Some(delay) });
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                    _ = wait_stop(&mut stop) => return,
                }
            }
        }
    }
}

async fn wait_stop(stop: &mut watch::Receiver<bool>) {
    loop {
        if *stop.borrow() {
            return;
        }
        if stop.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

fn close_text(code: Option<u16>, reason: &str) -> String {
    if !reason.is_empty() {
        return reason.to_string();
    }
    format!("closed ({})", code.map(|c| c.to_string()).unwrap_or_else(|| "1006".into()))
}

fn http_error_text(e: &tungstenite::Error) -> String {
    match e {
        tungstenite::Error::Http(resp) => {
            let body = resp.body().as_ref().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
            let said = serde_json::from_str::<Value>(&body).ok().and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string));
            match said {
                Some(s) => format!("hub answered {}: {s}", resp.status().as_u16()),
                None => format!("hub answered {}", resp.status().as_u16()),
            }
        }
        other => format!("connection error: {other}"),
    }
}

/// One connection, from dial to close.
async fn once(opts: &Options, hub: &str, urls: &mut Vec<String>, current: &mut usize, attempt: &mut u32, stop: &mut watch::Receiver<bool>) -> Ended {
    let ws_url = format!("{}?deviceId={}", daemon_url(hub), crate::js::encode_uri_component(&opts.device_id));
    let dial = async {
        let u = crate::net::parse_url(&ws_url).map_err(|e| e.to_string())?;
        let mut req = ws_url.as_str().into_client_request().map_err(|e| e.to_string())?;
        let h = req.headers_mut();
        // the token travels in a header, never in the URL
        h.insert("authorization", format!("Bearer {}", opts.token).parse().map_err(|_| "bad token".to_string())?);
        h.insert("x-conclave-device", opts.device_id.parse().map_err(|_| "bad device id".to_string())?);
        h.insert("user-agent", format!("conclave-daemon/{}", crate::info::VERSION).parse().unwrap());
        let stream = crate::net::connect(&u).await.map_err(|e| format!("connection error: {e}"))?;
        let mut cfg = tungstenite::protocol::WebSocketConfig::default();
        cfg.max_message_size = Some(1 << 30);
        cfg.max_frame_size = Some(1 << 30);
        tokio_tungstenite::client_async_with_config(req, stream, Some(cfg)).await.map(|(ws, _)| ws).map_err(|e| http_error_text(&e))
    };
    let ws = tokio::select! {
        r = tokio::time::timeout(CONNECT_TIMEOUT, dial) => match r {
            Ok(Ok(ws)) => ws,
            Ok(Err(e)) => return Ended::Closed(e, None),
            Err(_) => return Ended::Closed("connection timed out".into(), None),
        },
        _ = wait_stop(stop) => return Ended::Stopped,
    };
    let (mut sink, mut source) = ws.split();

    let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
    let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel::<(u16, String)>();
    let mut writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                c = ctl_rx.recv() => {
                    let (code, reason) = c.unwrap_or((1000, String::new()));
                    let _ = sink.send(Message::Close(Some(CloseFrame { code: code.into(), reason: reason.into() }))).await;
                    let _ = sink.close().await;
                    return;
                }
                m = out_rx.recv() => match m {
                    Some(text) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            return;
                        }
                    }
                    None => return,
                },
            }
        }
    });

    let server = MachineServer::new(out_tx.clone());
    let info = crate::info::info().await;
    let mut hello = json!({ "type": "hello", "version": PROTOCOL_VERSION, "deviceId": opts.device_id, "info": info });
    if let Some(n) = &opts.name {
        hello["name"] = json!(n);
    }
    crate::server::send(&out_tx, hello).await;

    let mut last_heard = Instant::now();
    let mut beat = tokio::time::interval_at(tokio::time::Instant::now() + opts.heartbeat, opts.heartbeat);
    let mut reason = String::new();
    let mut close_code: Option<u16> = None;
    let mut moving = false;
    let mut stopped = false;
    loop {
        tokio::select! {
            frame = source.next() => {
                let Some(frame) = frame else { break };
                let msg = match frame {
                    Ok(m) => m,
                    Err(e) => {
                        if reason.is_empty() {
                            reason = format!("connection error: {e}");
                        }
                        break;
                    }
                };
                last_heard = Instant::now();
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                    Message::Close(f) => {
                        if let Some(f) = f {
                            close_code = Some(f.code.into());
                            if reason.is_empty() {
                                reason = close_text(close_code, &f.reason);
                            }
                        }
                        continue;
                    }
                    _ => continue,
                };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                let Some(ty) = v.get("type").and_then(Value::as_str).map(str::to_string) else { continue };
                match ty.as_str() {
                    "welcome" => {
                        *attempt = 0;
                        (opts.on_status)(&Status { state: "online", url: Some(hub.to_string()), detail: None, retry_in_ms: None });
                    }
                    "addresses" => {
                        let list = v.get("urls").and_then(Value::as_array).cloned().unwrap_or_default();
                        let next = hub_urls(&list);
                        if next.is_empty() {
                            continue;
                        }
                        (opts.on_addresses)(&next);
                        // keep the address in use while it is listed (or is this machine); move when the hub drops it
                        let listed = next.iter().any(|u| u == hub);
                        if listed || is_loopback_url(hub) {
                            *urls = if listed { next } else { std::iter::once(hub.to_string()).chain(next).collect() };
                            *current = urls.iter().position(|u| u == hub).unwrap_or(0);
                            continue;
                        }
                        // a quick tunnel address the hub dropped is gone for good; any other may come back, so keep it last
                        *urls = if is_quick_tunnel_url(hub) { next } else { next.into_iter().chain(std::iter::once(hub.to_string())).collect() };
                        *current = 0;
                        moving = true;
                        reason = "moving to a new hub address".into();
                        let _ = ctl_tx.send((1000, "moving to a new hub address".into()));
                    }
                    "error" => {
                        reason = v.get("message").and_then(Value::as_str).unwrap_or("").to_string();
                    }
                    "pong" => {}
                    _ => server.handle(v).await,
                }
            }
            _ = beat.tick() => {
                if last_heard.elapsed() > opts.heartbeat * 3 {
                    reason = "heartbeat timeout".into();
                    let _ = ctl_tx.send((4008, "heartbeat timeout".into()));
                    // a dead path never answers the close frame either
                    break;
                }
                // never wait here: a queue full behind a stuck socket would stop this check
                let _ = out_tx.try_send(json!({ "type": "ping", "ts": now_ms() as u64 }).to_string());
            }
            _ = wait_stop(stop), if !stopped => {
                stopped = true;
                server.close();
                let _ = ctl_tx.send((1000, "daemon stopped".into()));
                // give the close frame a moment, then go
                let _ = tokio::time::timeout(Duration::from_millis(500), async { while source.next().await.is_some() {} }).await;
                break;
            }
        }
    }
    server.close();
    drop(out_tx);
    let _ = ctl_tx.send((1000, String::new()));
    // a writer stuck on a dead socket keeps it open
    if tokio::time::timeout(Duration::from_secs(2), &mut writer).await.is_err() {
        writer.abort();
    }
    if stopped {
        return Ended::Stopped;
    }
    if moving {
        return Ended::Moving;
    }
    Ended::Closed(if reason.is_empty() { close_text(close_code, "") } else { reason }, close_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_match_daemon_ts() {
        assert_eq!(daemon_url("https://hub.example.com/"), "wss://hub.example.com/api/daemon");
        assert_eq!(daemon_url("http://127.0.0.1:7717"), "ws://127.0.0.1:7717/api/daemon");
        assert_eq!(daemon_url("ws://h/x/api/daemon"), "ws://h/x/api/daemon");
        let list = hub_urls(&[json!(" https://a/ "), json!("https://a"), json!("ftp://x"), json!(3), json!("http://b:1")]);
        assert_eq!(list, vec!["https://a", "http://b:1"]);
        assert!(is_quick_tunnel_url("https://big-cat-words.trycloudflare.com"));
        assert!(!is_quick_tunnel_url("https://hub.example.com"));
        assert!(is_loopback_url("http://127.0.0.1:8230"));
        assert!(is_loopback_url("http://[::1]:1/"));
        assert!(!is_loopback_url("http://192.168.1.2:7717"));
    }

    #[test]
    fn a_hub_that_stops_reading_is_left_after_three_heartbeats() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let dir = std::env::temp_dir().join(format!("conclave-rsd-quiet-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let big = dir.join("big.bin");
            std::fs::write(&big, vec![7u8; 2 << 20]).unwrap();
            // a small receive buffer, so the replies below fill the socket on any system
            let socket = tokio::net::TcpSocket::new_v4().unwrap();
            socket.set_recv_buffer_size(4096).unwrap();
            socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
            let l = socket.listen(8).unwrap();
            let hub = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
            // a hub that never reads (frozen, or a proxy whose backend died) and asks for more than the socket holds
            let path = big.to_string_lossy().into_owned();
            tokio::spawn(async move {
                let (s, _) = l.accept().await.unwrap();
                let (mut sink, _source) = tokio_tungstenite::accept_async(s).await.unwrap().split();
                let rpc = |id: u32, method: &str, p: &str| Message::Text(json!({ "type": "rpc", "id": id, "method": method, "params": { "path": p } }).to_string().into());
                for id in 0..4 {
                    sink.send(rpc(id, "readFile", &path)).await.unwrap();
                }
                // still talking while those replies block the socket
                for _ in 0..20 {
                    sink.send(Message::Text(json!({ "type": "pong" }).to_string().into())).await.unwrap();
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                // then a hundred small replies fill the daemon's queue, and the hub goes quiet
                for id in 4..104 {
                    sink.send(rpc(id, "resolve", "x")).await.unwrap();
                }
                std::future::pending::<()>().await
            });
            let opts = Options {
                hub: hub.clone(),
                fallbacks: vec![],
                device_id: "dev_test".into(),
                token: "t".into(),
                name: None,
                on_addresses: Box::new(|_| {}),
                on_status: Box::new(|_| {}),
                // long enough for a debug build to encode the big replies on its one thread
                heartbeat: Duration::from_millis(400),
            };
            let (mut urls, mut current, mut attempt) = (vec![hub.clone()], 0, 0);
            let (_stop_tx, mut stop) = watch::channel(false);
            let ended = tokio::time::timeout(Duration::from_secs(20), once(&opts, &hub, &mut urls, &mut current, &mut attempt, &mut stop)).await;
            let _ = std::fs::remove_dir_all(&dir);
            assert!(matches!(ended, Ok(Ended::Closed(ref r, None)) if r == "heartbeat timeout"));
        });
    }
}
