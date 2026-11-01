//! Cloud speech to text: AssemblyAI Universal-Streaming v3 or Deepgram nova-3,
//! one websocket per channel straight from this app to the provider, with a
//! short-lived credential the hub mints (`POST /api/meetings/:id/stt-token`; the
//! API key stays on the hub). Audio goes up as 16 kHz mono s16le in 50 ms frames;
//! the provider's partials and finals (its endpointing ends a turn) become the
//! same segments the local model makes. A dropped socket reconnects with a fresh
//! token after 0.5, 1, 2, 4, 8 s; three failures in a row without a word back, or
//! no key on the hub, hand the channel to the local model (the caller does that).
//! Logs say which provider and why it failed; never the token or the audio.

use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use tauri::Url;
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, WebSocket};

use super::stt::{clean, Seqs};
use super::wire::{now_ms, Channel, Segment};

/// 50 ms at 16 kHz: AssemblyAI takes 50 to 1000 ms per message, Deepgram any size.
pub const FRAME_SAMPLES: usize = 800;
/// Frames waiting between the capture worker and the socket (10 s): capture starts before the
/// first token is back (the hub waits up to 8 s on the provider), so the opening words wait here.
pub const FEED_FRAMES: usize = 200;
/// `run`'s error when the hub has no key: the caller falls back to local without a warning.
pub const NO_KEY: &str = "no speech to text key on the hub";
/// Connection failures in a row (no word back in between) before the channel falls back.
pub const MAX_FAILURES: u32 = 3;
const READ_POLL: Duration = Duration::from_millis(20);
const KEEPALIVE_EVERY: Duration = Duration::from_secs(5);
const CLOSE_WAIT: Duration = Duration::from_secs(2);
/// No frame for this long (paused, or the audio device stalled): the session ends, so no
/// provider session stays open and billed; the next frame opens a new one.
#[cfg(not(test))]
const IDLE_CLOSE: Duration = Duration::from_secs(15);
#[cfg(test)]
const IDLE_CLOSE: Duration = Duration::from_millis(300);

/// Why a session ended without an error.
#[derive(Debug, PartialEq, Eq)]
enum Ended {
    Stop,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Assemblyai,
    Deepgram,
}

impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Provider::Assemblyai => "assemblyai",
            Provider::Deepgram => "deepgram",
        }
    }
    fn close_msg(self) -> &'static str {
        match self {
            Provider::Assemblyai => r#"{"type":"Terminate"}"#,
            Provider::Deepgram => r#"{"type":"CloseStream"}"#,
        }
    }
    fn keepalive(self) -> Option<&'static str> {
        match self {
            Provider::Assemblyai => None,
            Provider::Deepgram => Some(r#"{"type":"KeepAlive"}"#),
        }
    }
}

/// The hub's answer to `POST /api/meetings/:id/stt-token`. No Debug: it holds the token.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttToken {
    pub provider: Provider,
    pub url: String,
    pub token: String,
    pub expires_at: i64,
}

pub enum TokenError {
    /// 409: no provider key on the hub (or meetings.stt is local).
    NoKey,
    Failed(String),
}

impl SttToken {
    /// Still good for 5 s more; `expiresAt` in unix ms (seconds are accepted too).
    pub fn fresh(&self, now: i64) -> bool {
        let exp = if self.expires_at < 100_000_000_000 { self.expires_at * 1000 } else { self.expires_at };
        exp > now + 5000
    }

    /// The socket URL, with the audio format (and AssemblyAI's token) added where the
    /// hub left them out, and the Authorization header Deepgram wants: Bearer for a
    /// JWT from /v1/auth/grant, Token for a temporary API key.
    pub fn request(&self) -> Result<(Url, Option<String>), String> {
        let mut url = Url::parse(&self.url).map_err(|e| format!("bad speech to text address: {e}"))?;
        if !matches!(url.scheme(), "wss" | "ws") {
            return Err("the speech to text address is not a websocket".into());
        }
        let have: Vec<String> = url.query_pairs().map(|(k, _)| k.into_owned()).collect();
        let mut add = |k: &str, v: &str| {
            if !have.iter().any(|h| h == k) {
                url.query_pairs_mut().append_pair(k, v);
            }
        };
        add("sample_rate", "16000");
        match self.provider {
            Provider::Assemblyai => {
                add("encoding", "pcm_s16le");
                add("token", &self.token);
                Ok((url, None))
            }
            Provider::Deepgram => {
                add("encoding", "linear16");
                add("channels", "1");
                let scheme = if self.token.matches('.').count() == 2 { "Bearer" } else { "Token" };
                Ok((url, Some(format!("{scheme} {}", self.token))))
            }
        }
    }
}

/// 16 kHz samples to s16le frames of exactly `FRAME_SAMPLES`.
#[derive(Default)]
pub struct Framer {
    buf: Vec<u8>,
}

impl Framer {
    pub fn push(&mut self, samples: &[f32], mut out: impl FnMut(Vec<u8>)) {
        for s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            self.buf.extend_from_slice(&v.to_le_bytes());
            if self.buf.len() == FRAME_SAMPLES * 2 {
                out(std::mem::replace(&mut self.buf, Vec::with_capacity(FRAME_SAMPLES * 2)));
            }
        }
    }
}

/// One view of a turn: times in ms from the start of this socket's audio.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub text: String,
    pub is_final: bool,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Provider messages to turns.
pub enum Mapper {
    /// `formatted`: format_turns=true, so the final is the formatted copy of the end of turn.
    Assembly { formatted: bool },
    /// Deepgram finalizes pieces (`is_final`) and ends the utterance (`speech_final`,
    /// `UtteranceEnd`): the pieces are joined into one turn.
    Deepgram { done: Vec<String>, start_ms: Option<u64>, end_ms: u64 },
}

fn ms(v: &Value) -> u64 {
    (v.as_f64().unwrap_or(0.0) * 1000.0).max(0.0) as u64
}

impl Mapper {
    pub fn new(p: Provider, url: &Url) -> Self {
        match p {
            Provider::Assemblyai => Mapper::Assembly { formatted: url.query_pairs().any(|(k, v)| k == "format_turns" && v == "true") },
            Provider::Deepgram => Mapper::Deepgram { done: Vec::new(), start_ms: None, end_ms: 0 },
        }
    }

    pub fn on_text(&mut self, text: &str) -> Result<Option<Turn>, String> {
        let v: Value = serde_json::from_str(text).map_err(|e| format!("unreadable message from the provider: {e}"))?;
        let kind = v["type"].as_str().unwrap_or("");
        if let Some(e) = v.get("error").and_then(Value::as_str) {
            return Err(format!("provider error: {e}"));
        }
        if kind == "Error" {
            let d = v["description"].as_str().or(v["message"].as_str()).unwrap_or("unknown");
            return Err(format!("provider error: {d}"));
        }
        match self {
            Mapper::Assembly { formatted } => {
                if kind != "Turn" {
                    return Ok(None);
                }
                let end_of_turn = v["end_of_turn"].as_bool().unwrap_or(false);
                let is_final = end_of_turn && (v["turn_is_formatted"].as_bool().unwrap_or(false) || !*formatted);
                let words = v["words"].as_array().cloned().unwrap_or_default();
                // a partial's transcript has only its finished words; the words list has the newest too
                let text = match v["transcript"].as_str().map(str::trim) {
                    Some(t) if is_final && !t.is_empty() => t.to_string(),
                    t => {
                        let w: Vec<&str> = words.iter().filter_map(|w| w["text"].as_str()).collect();
                        if w.is_empty() { t.unwrap_or("").to_string() } else { w.join(" ") }
                    }
                };
                if text.trim().is_empty() {
                    return Ok(None);
                }
                let start_ms = words.first().and_then(|w| w["start"].as_u64()).unwrap_or(0);
                let end_ms = words.last().and_then(|w| w["end"].as_u64()).unwrap_or(start_ms);
                Ok(Some(Turn { text, is_final, start_ms, end_ms }))
            }
            Mapper::Deepgram { done, start_ms, end_ms } => {
                match kind {
                    "UtteranceEnd" => return Ok(Self::take(done, start_ms, *end_ms)),
                    "Results" => {}
                    _ => return Ok(None),
                }
                let t = v["channel"]["alternatives"][0]["transcript"].as_str().unwrap_or("").trim().to_string();
                let (s, e) = (ms(&v["start"]), ms(&v["start"]) + ms(&v["duration"]));
                if v["is_final"].as_bool().unwrap_or(false) {
                    if !t.is_empty() {
                        done.push(t);
                        start_ms.get_or_insert(s);
                        *end_ms = e;
                    }
                    if v["speech_final"].as_bool().unwrap_or(false) {
                        return Ok(Self::take(done, start_ms, *end_ms));
                    }
                    if done.is_empty() {
                        return Ok(None);
                    }
                    return Ok(Some(Turn { text: done.join(" "), is_final: false, start_ms: start_ms.unwrap_or(s), end_ms: *end_ms }));
                }
                if t.is_empty() && done.is_empty() {
                    return Ok(None);
                }
                let text = done.iter().map(String::as_str).chain((!t.is_empty()).then_some(t.as_str())).collect::<Vec<_>>().join(" ");
                Ok(Some(Turn { text, is_final: false, start_ms: start_ms.unwrap_or(s), end_ms: e }))
            }
        }
    }

    fn take(done: &mut Vec<String>, start_ms: &mut Option<u64>, end_ms: u64) -> Option<Turn> {
        if done.is_empty() {
            return None;
        }
        let text = std::mem::take(done).join(" ");
        Some(Turn { text, is_final: true, start_ms: start_ms.take().unwrap_or(0), end_ms })
    }
}

/// A websocket's byte stream: TLS for wss, plain for ws (the tests' local server).
pub enum Stream {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Stream {
    fn tcp(&self) -> &TcpStream {
        match self {
            Stream::Plain(s) => s,
            Stream::Tls(s) => &s.sock,
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(s) => s.read(buf),
            Stream::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(s) => s.write(buf),
            Stream::Tls(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Stream::Plain(s) => s.flush(),
            Stream::Tls(s) => s.flush(),
        }
    }
}

fn tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    if let Some(c) = CONFIG.get() {
        return Ok(c.clone());
    }
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let c = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(CONFIG.get_or_init(|| Arc::new(c)).clone())
}

/// Opens the socket (IPv4 first, like the hub connection), then polls reads every 20 ms.
pub fn connect(url: &Url, auth: Option<&str>) -> Result<WebSocket<Stream>, String> {
    let host = url.host_str().ok_or("no host in the speech to text address")?.to_string();
    let port = url.port_or_known_default().ok_or("no port in the speech to text address")?;
    let addrs = crate::hub::ipv4_first((host.as_str(), port).to_socket_addrs().map_err(|e| format!("{host}: {e}"))?.collect());
    let mut last = format!("{host}: no address");
    let mut tcp = None;
    for a in addrs {
        match TcpStream::connect_timeout(&a, Duration::from_secs(5)) {
            Ok(s) => {
                tcp = Some(s);
                break;
            }
            Err(e) => last = format!("{host}: {e}"),
        }
    }
    let tcp = tcp.ok_or(last)?;
    let _ = tcp.set_nodelay(true);
    tcp.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let stream = if url.scheme() == "wss" {
        let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
        let conn = rustls::ClientConnection::new(tls_config()?, name).map_err(|e| e.to_string())?;
        Stream::Tls(Box::new(rustls::StreamOwned::new(conn, tcp)))
    } else {
        Stream::Plain(tcp)
    };
    let mut req = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    if let Some(a) = auth {
        let v = tungstenite::http::HeaderValue::from_str(a).map_err(|_| "bad credential from the hub")?;
        req.headers_mut().insert("Authorization", v);
    }
    let (ws, _) = tungstenite::client(req, stream).map_err(|e| format!("{host}: {e}"))?;
    ws.get_ref().tcp().set_read_timeout(Some(READ_POLL)).map_err(|e| e.to_string())?;
    Ok(ws)
}

/// Sends frames and reads turns until `stop` or `IDLE_CLOSE` with no frame (then the
/// provider's close message and up to 2 s for its last words) or until the socket fails.
fn session<S: Read + Write>(
    ws: &mut WebSocket<S>,
    p: Provider,
    mapper: &mut Mapper,
    mut first: Option<Vec<u8>>,
    rx: &Receiver<Vec<u8>>,
    stop: &AtomicBool,
    mut on: impl FnMut(Turn),
) -> Result<Ended, String> {
    let mut last_send = Instant::now();
    let mut last_frame = Instant::now();
    let mut closing: Option<Instant> = None;
    let mut why = Ended::Stop;
    let err = |e: tungstenite::Error| e.to_string();
    loop {
        match closing {
            None => {
                let mut ending = stop.load(Ordering::Relaxed);
                if let Some(f) = first.take() {
                    ws.send(Message::Binary(f.into())).map_err(err)?;
                    last_send = Instant::now();
                }
                loop {
                    match rx.try_recv() {
                        Ok(f) => {
                            ws.send(Message::Binary(f.into())).map_err(err)?;
                            last_send = Instant::now();
                            last_frame = last_send;
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            ending = true;
                            break;
                        }
                    }
                }
                if !ending && last_frame.elapsed() >= IDLE_CLOSE {
                    ending = true;
                    why = Ended::Idle;
                }
                if ending {
                    ws.send(Message::Text(p.close_msg().to_string().into())).map_err(err)?;
                    closing = Some(Instant::now());
                } else if let Some(k) = p.keepalive().filter(|_| last_send.elapsed() >= KEEPALIVE_EVERY) {
                    ws.send(Message::Text(k.to_string().into())).map_err(err)?;
                    last_send = Instant::now();
                }
            }
            Some(at) if at.elapsed() >= CLOSE_WAIT => {
                let _ = ws.close(None);
                return Ok(why);
            }
            Some(_) => {}
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                if let Some(turn) = mapper.on_text(t.as_str())? {
                    on(turn);
                }
            }
            Ok(Message::Close(f)) => {
                if closing.is_some() {
                    return Ok(why);
                }
                let why = f.map(|f| format!("{} {}", u16::from(f.code), f.reason.as_str())).unwrap_or_default();
                return Err(format!("closed by the provider: {why}"));
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            // closing anyway: a provider that drops the socket after our close message is done, not failed
            Err(_) if closing.is_some() => return Ok(why),
            Err(e) => return Err(err(e)),
        }
    }
}

/// Turns to segments, with the seq shared with the local model. The last partial of a
/// socket that drops becomes a final, so no turn is lost with the socket.
struct Out<'a, F: FnMut(Segment)> {
    channel: Channel,
    /// This socket's audio start: unix ms, and ms from the meeting's t0.
    started_at: i64,
    offset_ms: i64,
    seqs: &'a Mutex<Seqs>,
    out: F,
    pending: Option<Turn>,
    heard: bool,
}

impl<F: FnMut(Segment)> Out<'_, F> {
    fn turn(&mut self, t: Turn) {
        self.heard = true;
        let text = clean(&t.text);
        if text.is_empty() {
            return;
        }
        self.pending = (!t.is_final).then(|| t.clone());
        let seq = self.seqs.lock().unwrap().next(self.channel, t.is_final);
        let start_ms = (self.offset_ms + t.start_ms as i64).max(0) as u64;
        let now = now_ms();
        (self.out)(Segment {
            seq,
            channel: self.channel,
            start_ms,
            end_ms: ((self.offset_ms + t.end_ms as i64).max(0) as u64).max(start_ms),
            text,
            is_final: t.is_final,
            // audio time runs ahead of the clock when frames queued during a reconnect go up in a burst
            speech_end_at: Some((self.started_at + t.end_ms as i64).min(now)),
            final_at: Some(now),
        });
    }

    fn finish(&mut self) {
        if let Some(t) = self.pending.take() {
            self.turn(Turn { is_final: true, ..t });
        }
    }
}

/// The `meeting-cloud-me` / `meeting-cloud-them` loop. Connects only while there is
/// audio to send: a session with no frame for `IDLE_CLOSE` (paused, a stalled device)
/// ends, and the next frame opens a new one. A token that fails is retried like a
/// socket that fails. `opened` hears the provider of each new session. Returns Ok on
/// `stop`, or Err with the reason (`NO_KEY` when the hub has none) when the channel
/// must fall back to the local model.
#[allow(clippy::too_many_arguments)]
pub fn run(
    channel: Channel,
    mut first_token: Option<SttToken>,
    mut token: impl FnMut() -> Result<SttToken, TokenError>,
    rx: &Receiver<Vec<u8>>,
    stop: &AtomicBool,
    t0: i64,
    seqs: &Mutex<Seqs>,
    mut opened: impl FnMut(Provider),
    mut out: impl FnMut(Segment),
) -> Result<(), String> {
    let ch = match channel {
        Channel::Me => "me",
        Channel::Them => "them",
    };
    let mut failures = 0u32;
    // the frame that woke a try that failed: the next try sends it, so no audio is lost to a retry
    let mut held: Option<Vec<u8>> = None;
    while !stop.load(Ordering::Relaxed) {
        let frame = match held.take().map(Ok).unwrap_or_else(|| rx.recv_timeout(Duration::from_millis(200))) {
            Ok(f) => f,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        };
        let asked = Instant::now();
        let tok = match first_token.take().filter(|t| t.fresh(now_ms())).map(Ok).unwrap_or_else(&mut token) {
            Ok(t) => t,
            Err(TokenError::NoKey) => return Err(NO_KEY.into()),
            Err(TokenError::Failed(e)) => {
                log::warn!("meeting: {ch}: speech to text token: {e}");
                failures += 1;
                if failures >= MAX_FAILURES {
                    return Err(format!("no speech to text token: {e}"));
                }
                held = Some(frame);
                wait(stop, super::upload::backoff(failures - 1));
                continue;
            }
        };
        let p = tok.provider;
        let socket = tok.request().and_then(|(url, auth)| Ok((connect(&url, auth.as_deref())?, url)));
        let (mut ws, url) = match socket {
            Ok(v) => v,
            Err(e) => {
                log::warn!("meeting: {ch}: {} connect failed: {e}", p.name());
                failures += 1;
                if failures >= MAX_FAILURES {
                    return Err(format!("{} unreachable: {e}", p.name()));
                }
                held = Some(frame);
                wait(stop, super::upload::backoff(failures - 1));
                continue;
            }
        };
        log::info!(
            "meeting: {ch}: streaming to {} at {}{} (token and connect {} ms)",
            p.name(),
            url.host_str().unwrap_or(""),
            url.path(),
            asked.elapsed().as_millis()
        );
        opened(p);
        let started_at = now_ms();
        let mut o = Out { channel, started_at, offset_ms: started_at - t0, seqs, out: &mut out, pending: None, heard: false };
        let mut mapper = Mapper::new(p, &url);
        let r = session(&mut ws, p, &mut mapper, Some(frame), rx, stop, |t| o.turn(t));
        o.finish();
        match r {
            Ok(Ended::Stop) => return Ok(()),
            Ok(Ended::Idle) => {
                log::info!("meeting: {ch}: no audio for {} s, {} session closed until audio comes back", IDLE_CLOSE.as_secs(), p.name());
                failures = 0;
            }
            Err(e) => {
                log::warn!("meeting: {ch}: {} socket: {e}", p.name());
                if o.heard {
                    failures = 0;
                }
                failures += 1;
                if failures >= MAX_FAILURES {
                    return Err(format!("{}: {e}", p.name()));
                }
                wait(stop, super::upload::backoff(failures - 1));
            }
        }
    }
    Ok(())
}

fn wait(stop: &AtomicBool, total: Duration) {
    let until = Instant::now() + total;
    while !stop.load(Ordering::Relaxed) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::sync_channel;

    fn token(provider: Provider, url: &str, token: &str) -> SttToken {
        SttToken { provider, url: url.into(), token: token.into(), expires_at: now_ms() + 60_000 }
    }

    #[test]
    fn frames_are_50ms_of_little_endian_s16() {
        let mut f = Framer::default();
        let mut out = Vec::new();
        let mut samples = vec![0.5f32; 1000];
        samples[0] = -2.0;
        f.push(&samples, |b| out.push(b));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), FRAME_SAMPLES * 2);
        assert_eq!(i16::from_le_bytes([out[0][0], out[0][1]]), -32767);
        assert_eq!(i16::from_le_bytes([out[0][2], out[0][3]]), 16383);
        f.push(&vec![0.0; 600], |b| out.push(b));
        assert_eq!(out.len(), 2, "200 left over plus 600 make the next frame");
    }

    #[test]
    fn requests_add_what_the_hub_left_out() {
        let (u, auth) = token(Provider::Assemblyai, "wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true", "tmp1").request().unwrap();
        assert_eq!(u.query(), Some("sample_rate=16000&format_turns=true&encoding=pcm_s16le&token=tmp1"));
        assert!(auth.is_none());
        let (u, auth) = token(Provider::Deepgram, "wss://api.deepgram.com/v1/listen?model=nova-3", "a.b.c").request().unwrap();
        assert_eq!(u.query(), Some("model=nova-3&sample_rate=16000&encoding=linear16&channels=1"));
        assert_eq!(auth.as_deref(), Some("Bearer a.b.c"));
        let (_, auth) = token(Provider::Deepgram, "wss://api.deepgram.com/v1/listen", "key123").request().unwrap();
        assert_eq!(auth.as_deref(), Some("Token key123"));
        assert!(token(Provider::Deepgram, "https://x", "k").request().is_err());
    }

    #[test]
    fn tokens_expire_in_ms_or_seconds() {
        let now = 1_800_000_000_000;
        let t = |expires_at| SttToken { expires_at, ..token(Provider::Deepgram, "wss://x", "k") };
        assert!(t(now + 30_000).fresh(now));
        assert!(!t(now + 1_000).fresh(now));
        assert!(t(now / 1000 + 60).fresh(now));
    }

    #[test]
    fn assemblyai_partials_and_the_formatted_final() {
        let url = Url::parse("wss://x/v3/ws?format_turns=true").unwrap();
        let mut m = Mapper::new(Provider::Assemblyai, &url);
        assert_eq!(m.on_text(r#"{"type":"Begin","id":"s1","expires_at":1}"#).unwrap(), None);
        let partial = r#"{"type":"Turn","turn_order":0,"end_of_turn":false,"turn_is_formatted":false,"transcript":"where",
            "words":[{"text":"where","start":120,"end":400,"word_is_final":true},{"text":"are","start":410,"end":600,"word_is_final":false}]}"#;
        assert_eq!(m.on_text(partial).unwrap(), Some(Turn { text: "where are".into(), is_final: false, start_ms: 120, end_ms: 600 }));
        let raw_end = r#"{"type":"Turn","end_of_turn":true,"turn_is_formatted":false,"transcript":"where are we",
            "words":[{"text":"where","start":120,"end":400},{"text":"we","start":700,"end":900}]}"#;
        assert!(!m.on_text(raw_end).unwrap().unwrap().is_final, "the unformatted end of turn waits for its formatted copy");
        let fmt = r#"{"type":"Turn","end_of_turn":true,"turn_is_formatted":true,"transcript":"Where are we?",
            "words":[{"text":"Where","start":120,"end":400},{"text":"we?","start":700,"end":900}]}"#;
        assert_eq!(m.on_text(fmt).unwrap(), Some(Turn { text: "Where are we?".into(), is_final: true, start_ms: 120, end_ms: 900 }));
        // without format_turns the end of turn is the final
        let mut m = Mapper::new(Provider::Assemblyai, &Url::parse("wss://x/v3/ws").unwrap());
        assert!(m.on_text(raw_end).unwrap().unwrap().is_final);
        assert!(m.on_text(r#"{"error":"bad token"}"#).is_err());
    }

    #[test]
    fn deepgram_pieces_join_into_one_turn_until_speech_final() {
        let mut m = Mapper::new(Provider::Deepgram, &Url::parse("wss://x").unwrap());
        let r = |t: &str, start: f64, dur: f64, is_final: bool, speech_final: bool| {
            format!(r#"{{"type":"Results","start":{start},"duration":{dur},"is_final":{is_final},"speech_final":{speech_final},"channel":{{"alternatives":[{{"transcript":"{t}"}}]}}}}"#)
        };
        assert_eq!(m.on_text(&r("tell me", 1.0, 0.5, false, false)).unwrap(), Some(Turn { text: "tell me".into(), is_final: false, start_ms: 1000, end_ms: 1500 }));
        assert!(!m.on_text(&r("tell me about", 1.0, 0.8, true, false)).unwrap().unwrap().is_final);
        assert_eq!(m.on_text(&r("your", 1.8, 0.3, false, false)).unwrap().unwrap().text, "tell me about your");
        assert_eq!(
            m.on_text(&r("last project", 1.8, 0.7, true, true)).unwrap(),
            Some(Turn { text: "tell me about last project".into(), is_final: true, start_ms: 1000, end_ms: 2500 })
        );
        assert_eq!(m.on_text(&r("", 2.5, 1.0, true, true)).unwrap(), None);
        m.on_text(&r("and why", 4.0, 0.5, true, false)).unwrap();
        assert_eq!(m.on_text(r#"{"type":"UtteranceEnd","last_word_end":4.5}"#).unwrap().unwrap().text, "and why");
        assert_eq!(m.on_text(r#"{"type":"Metadata"}"#).unwrap(), None);
    }

    /// A local ws server that answers like Deepgram: the client streams frames, gets a
    /// final as a segment with the shared seq and the latency marks, and closes on stop.
    #[test]
    fn a_session_streams_frames_and_maps_the_reply_to_a_segment() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}/v1/listen", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap_or_else(|_| panic!("server handshake"));
            let mut frames = 0;
            while frames < 2 {
                if let Message::Binary(b) = ws.read().unwrap() {
                    assert_eq!(b.len(), FRAME_SAMPLES * 2);
                    frames += 1;
                }
            }
            let reply = r#"{"type":"Results","start":0.2,"duration":0.6,"is_final":true,"speech_final":true,"channel":{"alternatives":[{"transcript":"why Rust?"}]}}"#;
            ws.send(Message::Text(reply.to_string().into())).unwrap();
            loop {
                match ws.read() {
                    Ok(Message::Text(t)) if t.as_str().contains("CloseStream") => return true,
                    Ok(_) => {}
                    Err(_) => return false,
                }
            }
        });
        let (tx, rx) = sync_channel(FEED_FRAMES);
        tx.send(vec![0u8; FRAME_SAMPLES * 2]).unwrap();
        tx.send(vec![0u8; FRAME_SAMPLES * 2]).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let seqs = Mutex::new(Seqs::default());
        seqs.lock().unwrap().next(Channel::Them, true); // seq 0 went to the local model earlier
        let got = Arc::new(Mutex::new(Vec::new()));
        let t0 = now_ms() - 10_000;
        let client = {
            let (stop, got) = (stop.clone(), got.clone());
            std::thread::spawn(move || {
                let tok = token(Provider::Deepgram, &url, "k");
                run(Channel::Them, Some(tok), || Err(TokenError::NoKey), &rx, &stop, t0, &seqs, |_| {}, |s| got.lock().unwrap().push(s))
            })
        };
        let until = Instant::now() + Duration::from_secs(5);
        while got.lock().unwrap().is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        stop.store(true, Ordering::Relaxed);
        assert!(client.join().unwrap().is_ok());
        assert!(server.join().unwrap(), "the client sent CloseStream on stop");
        let got = got.lock().unwrap();
        assert_eq!(got.len(), 1);
        let s = &got[0];
        assert_eq!((s.seq, s.channel, s.text.as_str(), s.is_final), (1, Channel::Them, "why Rust?", true));
        assert!(s.start_ms >= 10_000 && s.end_ms == s.start_ms + 600, "{} {}", s.start_ms, s.end_ms);
        assert!(s.speech_end_at.unwrap() <= s.final_at.unwrap());
        drop(tx);
    }

    /// Paused or a stalled device: no frame for IDLE_CLOSE ends the provider session (no
    /// socket held open), and the next frame opens a new one on a fresh token.
    #[test]
    fn a_session_with_no_audio_closes_and_the_next_frame_reopens() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}/v1/listen", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut closes = 0;
            for _ in 0..2 {
                let (s, _) = listener.accept().unwrap();
                let mut ws = tungstenite::accept(s).unwrap_or_else(|_| panic!("server handshake"));
                loop {
                    match ws.read() {
                        Ok(Message::Text(t)) if t.as_str().contains("CloseStream") => {
                            closes += 1;
                            break;
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            }
            closes
        });
        let (tx, rx) = sync_channel(FEED_FRAMES);
        let stop = Arc::new(AtomicBool::new(false));
        let opened = Arc::new(Mutex::new(0));
        let client = {
            let (stop, opened) = (stop.clone(), opened.clone());
            std::thread::spawn(move || {
                let seqs = Mutex::new(Seqs::default());
                let mut asked = 0;
                let r = run(
                    Channel::Them,
                    None,
                    || {
                        asked += 1;
                        Ok(token(Provider::Deepgram, &url, "k"))
                    },
                    &rx,
                    &stop,
                    0,
                    &seqs,
                    |_| *opened.lock().unwrap() += 1,
                    |_| {},
                );
                (r, asked)
            })
        };
        tx.send(vec![0u8; FRAME_SAMPLES * 2]).unwrap();
        // past IDLE_CLOSE (300 ms in tests) plus the close wait: the first session ended
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(*opened.lock().unwrap(), 1);
        tx.send(vec![0u8; FRAME_SAMPLES * 2]).unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while *opened.lock().unwrap() < 2 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        stop.store(true, Ordering::Relaxed);
        let (r, asked) = client.join().unwrap();
        assert!(r.is_ok(), "an idle close is not a failure");
        assert_eq!(asked, 2, "one fresh token per session");
        assert_eq!(server.join().unwrap(), 2, "both sessions ended with CloseStream");
        drop(tx);
    }

    /// A token that fails at the start is retried, not a fallback for the whole meeting.
    #[test]
    fn a_token_that_fails_at_start_is_retried() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}/v1/listen", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap_or_else(|_| panic!("server handshake"));
            while let Ok(m) = ws.read() {
                if matches!(&m, Message::Text(t) if t.as_str().contains("CloseStream")) {
                    break;
                }
            }
        });
        let (tx, rx) = sync_channel(FEED_FRAMES);
        tx.send(vec![0u8; FRAME_SAMPLES * 2]).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let provider = Arc::new(Mutex::new(None));
        let client = {
            let (stop, provider) = (stop.clone(), provider.clone());
            std::thread::spawn(move || {
                let seqs = Mutex::new(Seqs::default());
                let mut asked = 0;
                run(
                    Channel::Me,
                    None,
                    || {
                        asked += 1;
                        if asked < MAX_FAILURES { Err(TokenError::Failed("502 timeout".into())) } else { Ok(token(Provider::Deepgram, &url, "k")) }
                    },
                    &rx,
                    &stop,
                    0,
                    &seqs,
                    |p| *provider.lock().unwrap() = Some(p),
                    |_| {},
                )
            })
        };
        let until = Instant::now() + Duration::from_secs(6);
        while provider.lock().unwrap().is_none() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        stop.store(true, Ordering::Relaxed);
        assert!(client.join().unwrap().is_ok());
        assert_eq!(*provider.lock().unwrap(), Some(Provider::Deepgram));
        server.join().unwrap();
        drop(tx);
    }

    #[test]
    fn no_key_falls_back_at_once_and_an_unreachable_provider_after_three_tries() {
        let stop = AtomicBool::new(false);
        let seqs = Mutex::new(Seqs::default());
        let (tx, rx) = sync_channel(FEED_FRAMES);
        for _ in 0..8 {
            tx.send(vec![0u8; 4]).unwrap();
        }
        let r = run(Channel::Me, None, || Err(TokenError::NoKey), &rx, &stop, 0, &seqs, |_| {}, |_| {});
        assert_eq!(r.unwrap_err(), NO_KEY);
        let mut asked = 0;
        let started = Instant::now();
        let r = run(
            Channel::Me,
            None,
            || {
                asked += 1;
                Ok(token(Provider::Deepgram, "ws://127.0.0.1:1/v1/listen", "k"))
            },
            &rx,
            &stop,
            0,
            &seqs,
            |_| {},
            |_| {},
        );
        assert!(r.is_err());
        assert_eq!(asked, MAX_FAILURES);
        // backoff 0.5 s then 1 s between the three tries
        assert!(started.elapsed() >= Duration::from_millis(1400), "{:?}", started.elapsed());
    }
}
