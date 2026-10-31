//! The `meeting-up` thread: segments to the hub (MEETING-MODE.md 3.1, 3.5).
//!
//! A bounded outbox of 256 segments. Pushing never waits on the network.
//! When it is full the oldest partial goes first, then the oldest final.
//! Failed posts retry after 0.5, 1, 2, 4, 8 s, then every 8 s. A 409 means the
//! meeting is over on the hub (or another app listens): the meeting stops.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::Url;

use super::wire::{AnswerNowInput, Segment, SegmentBatch, MAX_BATCH};

pub const CAPACITY: usize = 256;
/// The hub refuses bodies over 64 KB; stay well under.
const MAX_BATCH_BYTES: usize = 48 * 1024;
pub const POST_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct Outbox {
    items: VecDeque<Segment>,
    pub dropped: u32,
}

impl Outbox {
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn push(&mut self, seg: Segment) {
        // a waiting partial of the same seq is out of date now, whether the new one is a partial or the final
        self.items.retain(|s| s.is_final || s.channel != seg.channel || s.seq != seg.seq);
        self.items.push_back(seg);
        while self.items.len() > CAPACITY {
            let i = self.items.iter().position(|s| !s.is_final).unwrap_or(0);
            self.items.remove(i);
            self.dropped += 1;
        }
    }

    /// The next batch: 1 to 32 segments, under 48 KB of JSON, taken off the front.
    pub fn take_batch(&mut self) -> Vec<Segment> {
        let mut out = Vec::new();
        let mut bytes = 0;
        while let Some(s) = self.items.front() {
            let size = s.text.len() * 2 + 120; // escaped text plus the fields, generously
            if out.len() == MAX_BATCH || (!out.is_empty() && bytes + size > MAX_BATCH_BYTES) {
                break;
            }
            bytes += size;
            out.push(self.items.pop_front().expect("front exists"));
        }
        out
    }

    /// A batch that failed goes back in front, unless something newer replaced it meanwhile.
    pub fn put_back(&mut self, batch: Vec<Segment>) {
        for seg in batch.into_iter().rev() {
            let replaced = !seg.is_final && self.items.iter().any(|s| s.channel == seg.channel && s.seq == seg.seq);
            if !replaced {
                self.items.push_front(seg);
            }
        }
        while self.items.len() > CAPACITY {
            let i = self.items.iter().position(|s| !s.is_final).unwrap_or(0);
            self.items.remove(i);
            self.dropped += 1;
        }
    }
}

/// 0.5, 1, 2, 4, 8 s, then 8 s for ever.
pub fn backoff(failures: u32) -> Duration {
    Duration::from_millis(500u64 << failures.min(4))
}

#[derive(Default)]
pub struct Shared {
    pub outbox: Mutex<Outbox>,
    pub wake: Condvar,
    pub len: AtomicU32,
    pub dropped: AtomicU32,
    pub answer_now: AtomicBool,
    /// The hub refused with 409: the meeting is over for this app.
    pub ended: AtomicBool,
    pub online: AtomicBool,
    /// Ended from the tray: after the last segments go out, end the meeting on the hub too.
    pub end_on_hub: AtomicBool,
}

impl Shared {
    pub fn push(&self, seg: Segment) {
        let mut o = self.outbox.lock().unwrap();
        o.push(seg);
        self.publish(&o);
        drop(o);
        self.wake.notify_one();
    }

    pub fn request_answer(&self) {
        self.answer_now.store(true, Ordering::Relaxed);
        self.wake.notify_one();
    }

    fn publish(&self, o: &Outbox) {
        self.len.store(o.len() as u32, Ordering::Relaxed);
        self.dropped.store(o.dropped, Ordering::Relaxed);
    }
}

pub enum Posted {
    Ok,
    /// 409: stop listening.
    Ended(String),
    /// 400 or 413: this batch can never be accepted; it is dropped.
    Refused(String),
    Retry(String),
}

pub struct Hub {
    pub base: Url,
    pub token: String,
    pub client_id: String,
    pub meeting_id: String,
    pub t0: i64,
    agent: ureq::Agent,
}

impl Hub {
    pub fn new(base: Url, token: String, client_id: String, meeting_id: String, t0: i64) -> Self {
        let agent = ureq::AgentBuilder::new()
            .resolver(crate::hub::Ipv4First)
            .timeout_connect(POST_TIMEOUT)
            .timeout(POST_TIMEOUT)
            .build();
        Hub { base, token, client_id, meeting_id, t0, agent }
    }

    fn url(&self, tail: &str) -> Result<Url, String> {
        self.base.join(&format!("api/meetings/{}/{tail}", self.meeting_id)).map_err(|e| e.to_string())
    }

    fn post(&self, tail: &str, body: serde_json::Value) -> Posted {
        let url = match self.url(tail) {
            Ok(u) => u,
            Err(e) => return Posted::Refused(e),
        };
        let res = self.agent.post(url.as_str()).set("Authorization", &format!("Bearer {}", self.token)).send_json(body);
        match res {
            Ok(_) => Posted::Ok,
            Err(ureq::Error::Status(409, r)) => Posted::Ended(r.into_string().unwrap_or_default()),
            Err(ureq::Error::Status(code @ (400 | 413), r)) => Posted::Refused(format!("{code} {}", r.into_string().unwrap_or_default())),
            Err(e) => Posted::Retry(e.to_string()),
        }
    }

    pub fn post_segments(&self, segments: &[Segment]) -> Posted {
        let batch = SegmentBatch { client_id: self.client_id.clone(), t0: self.t0, segments: segments.to_vec() };
        self.post("segments", serde_json::to_value(batch).unwrap_or_default())
    }

    /// `POST .../end` (3.1): the hub wraps up. A 409 means it already ends.
    pub fn end(&self) -> Posted {
        self.post("end", serde_json::json!({}))
    }

    pub fn answer_now(&self) -> Posted {
        let body = AnswerNowInput { reason: "hotkey".into(), question: None };
        self.post("answer", serde_json::to_value(body).unwrap_or_default())
    }
}

/// Runs until `stop`, or until the hub says the meeting ended (`shared.ended`).
/// Before it returns on `stop`, it tries once more to send what is left (the flushed last segment).
pub fn run(hub: &Hub, shared: &Shared, stop: &AtomicBool) {
    let mut failures = 0u32;
    let mut retry_at: Option<Instant> = None;
    loop {
        if shared.answer_now.swap(false, Ordering::Relaxed) {
            if let Posted::Ended(e) = hub.answer_now() {
                log::info!("meeting: answer now refused: {e}");
            }
        }
        let stopping = stop.load(Ordering::Relaxed);
        let waiting = retry_at.is_some_and(|t| Instant::now() < t) && !stopping;
        let batch = if waiting { Vec::new() } else { shared.outbox.lock().unwrap().take_batch() };
        if batch.is_empty() {
            if stopping {
                if shared.end_on_hub.load(Ordering::Relaxed) {
                    if let Posted::Retry(e) | Posted::Refused(e) = hub.end() {
                        log::info!("meeting: end on the hub failed: {e}");
                    }
                }
                return;
            }
            let o = shared.outbox.lock().unwrap();
            let wait = retry_at.map(|t| t.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_millis(500));
            let _ = shared.wake.wait_timeout(o, wait.max(Duration::from_millis(10))).unwrap();
            continue;
        }
        match hub.post_segments(&batch) {
            Posted::Ok => {
                failures = 0;
                retry_at = None;
                shared.online.store(true, Ordering::Relaxed);
                shared.publish(&shared.outbox.lock().unwrap());
            }
            Posted::Ended(e) => {
                log::info!("meeting: the hub ended the meeting: {e}");
                shared.ended.store(true, Ordering::Relaxed);
                return;
            }
            Posted::Refused(e) => log::warn!("meeting: the hub refused a batch: {e}"),
            Posted::Retry(e) => {
                shared.online.store(false, Ordering::Relaxed);
                let mut o = shared.outbox.lock().unwrap();
                o.put_back(batch);
                shared.publish(&o);
                drop(o);
                if stopping {
                    log::warn!("meeting: {e}; the last segments were not sent");
                    return;
                }
                retry_at = Some(Instant::now() + backoff(failures));
                failures += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::wire::Channel;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    fn seg(seq: u64, is_final: bool) -> Segment {
        Segment { seq, channel: Channel::Them, start_ms: 0, end_ms: 1, text: format!("s{seq}"), is_final }
    }

    #[test]
    fn backoff_steps() {
        let s: Vec<u64> = (0..7).map(|f| backoff(f).as_millis() as u64).collect();
        assert_eq!(s, [500, 1000, 2000, 4000, 8000, 8000, 8000]);
    }

    #[test]
    fn full_outbox_drops_partials_first_then_oldest_finals() {
        let mut o = Outbox::default();
        o.push(seg(0, false));
        for i in 1..=CAPACITY as u64 {
            o.push(Segment { channel: Channel::Me, ..seg(i, true) });
        }
        assert_eq!(o.len(), CAPACITY);
        assert!(o.items.iter().all(|s| s.is_final));
        o.push(Segment { channel: Channel::Me, ..seg(999, true) });
        assert_eq!(o.items.front().unwrap().seq, 2);
        assert_eq!(o.dropped, 2);
    }

    #[test]
    fn newer_partial_or_final_replaces_a_waiting_partial() {
        let mut o = Outbox::default();
        o.push(seg(3, false));
        o.push(seg(3, false));
        assert_eq!(o.len(), 1);
        o.push(seg(3, true));
        assert_eq!(o.len(), 1);
        assert!(o.items[0].is_final);
        // a failed batch with the old partial does not come back over the final
        o.put_back(vec![seg(3, false)]);
        assert_eq!(o.len(), 1);
    }

    #[test]
    fn batches_are_at_most_32_and_under_the_size_cap() {
        let mut o = Outbox::default();
        for i in 0..40 {
            o.push(seg(i, true));
        }
        assert_eq!(o.take_batch().len(), 32);
        assert_eq!(o.take_batch().len(), 8);
        for i in 0..32 {
            o.push(Segment { text: "x".repeat(2000), ..seg(i, true) });
        }
        let b = o.take_batch();
        assert!(b.len() < 32 && !b.is_empty());
    }

    /// A fake hub on a local port: answers each request with the next status in `codes`
    /// and records the bodies of the requests it answered with 200.
    fn fake_hub(codes: Vec<u16>) -> (Url, Arc<Mutex<Vec<serde_json::Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let rec = seen.clone();
        std::thread::spawn(move || {
            let mut codes = codes.into_iter();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut len = 0usize;
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    line.clear();
                }
                let mut body = vec![0u8; len];
                reader.read_exact(&mut body).unwrap();
                let code = codes.next().unwrap_or(200);
                if code == 200 {
                    rec.lock().unwrap().push(serde_json::from_slice(&body).unwrap());
                }
                let reply = r#"{"accepted":0,"lastSeq":{"me":-1,"them":-1}}"#;
                let _ = write!(stream, "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len());
            }
        });
        (base, seen)
    }

    fn hub(base: Url) -> Hub {
        Hub::new(base, "t".into(), "c1".into(), "mtg_1".into(), 0)
    }

    #[test]
    fn a_500_is_retried_and_replayed_without_duplicates() {
        let (base, seen) = fake_hub(vec![500, 200, 200]);
        let shared = Arc::new(Shared::default());
        let stop = Arc::new(AtomicBool::new(false));
        for i in 0..3 {
            shared.push(seg(i, true));
        }
        let worker = {
            let (shared, stop) = (shared.clone(), stop.clone());
            std::thread::spawn(move || run(&hub(base), &shared, &stop))
        };
        let until = Instant::now() + Duration::from_secs(5);
        while seen.lock().unwrap().is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        stop.store(true, Ordering::Relaxed);
        shared.wake.notify_one();
        worker.join().unwrap();
        let seen = seen.lock().unwrap();
        let seqs: Vec<u64> = seen.iter().flat_map(|b| b["segments"].as_array().unwrap().iter().map(|s| s["seq"].as_u64().unwrap())).collect();
        assert_eq!(seqs, [0, 1, 2]);
        assert_eq!(seen[0]["clientId"], "c1");
    }

    #[test]
    fn a_409_ends_the_meeting() {
        let (base, _) = fake_hub(vec![409]);
        let shared = Shared::default();
        shared.push(seg(0, true));
        run(&hub(base), &shared, &AtomicBool::new(false));
        assert!(shared.ended.load(Ordering::Relaxed));
    }

    #[test]
    fn a_hub_that_never_answers_never_blocks_the_producer() {
        // accepts connections, never replies
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        std::thread::spawn(move || {
            let _held: Vec<_> = listener.incoming().take(4).collect();
            std::thread::sleep(Duration::from_secs(30));
        });
        let shared = Arc::new(Shared::default());
        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let (shared, stop) = (shared.clone(), stop.clone());
            std::thread::spawn(move || run(&hub(base), &shared, &stop))
        };
        let started = Instant::now();
        for i in 0..1000 {
            shared.push(seg(i, true));
        }
        assert!(started.elapsed() < Duration::from_millis(500), "push waited on the network");
        assert!(shared.len.load(Ordering::Relaxed) as usize <= CAPACITY);
        stop.store(true, Ordering::Relaxed);
        shared.wake.notify_one();
        worker.join().unwrap();
    }
}
