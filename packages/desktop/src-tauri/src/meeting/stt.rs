//! The speech-to-text queue and the `meeting-stt` thread (MEETING-MODE.md 3.5, 4.3, 4.5).
//!
//! Queue rules, per channel at most 4 waiting jobs: finals jump the queue,
//! a newer partial replaces a waiting one, overflow drops the oldest partial
//! first, then merges waiting "me" finals; a "them" final is never dropped.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::capture::Speech;
use super::parakeet::model::ParakeetModel;
use super::vad::SpeechSegment;
use super::wire::{Channel, Segment, MAX_TEXT_CHARS};

pub const PER_CHANNEL: usize = 4;
/// The model is dropped this long after the last meeting ended (4.5).
pub const UNLOAD_AFTER: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
pub struct Job {
    pub channel: Channel,
    pub is_final: bool,
    pub segment: SpeechSegment,
}

impl From<Speech> for Job {
    fn from(s: Speech) -> Self {
        match s {
            Speech::Final(channel, segment) => Job { channel, is_final: true, segment },
            Speech::Partial(channel, segment) => Job { channel, is_final: false, segment },
        }
    }
}

#[derive(Default)]
pub struct Queue {
    jobs: VecDeque<Job>,
    pub dropped: u32,
}

impl Queue {
    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    fn count(&self, ch: Channel) -> usize {
        self.jobs.iter().filter(|j| j.channel == ch).count()
    }

    pub fn push(&mut self, job: Job) {
        if !job.is_final {
            // only the newest view of the open speech matters
            self.jobs.retain(|j| j.is_final || j.channel != job.channel);
        }
        let ch = job.channel;
        self.jobs.push_back(job);
        while self.count(ch) > PER_CHANNEL {
            if let Some(i) = self.jobs.iter().position(|j| j.channel == ch && !j.is_final) {
                self.jobs.remove(i);
                self.dropped += 1;
            } else if ch == Channel::Me && self.merge_oldest_me() {
                continue;
            } else {
                // "them" finals are never dropped: the queue grows past 4
                break;
            }
        }
    }

    /// Two oldest waiting "me" finals become one job.
    fn merge_oldest_me(&mut self) -> bool {
        let mut idx = self.jobs.iter().enumerate().filter(|(_, j)| j.channel == Channel::Me && j.is_final).map(|(i, _)| i);
        let (Some(a), Some(b)) = (idx.next(), idx.next()) else { return false };
        let second = self.jobs.remove(b).expect("index from iter");
        let first = &mut self.jobs[a].segment;
        first.samples.extend_from_slice(&second.segment.samples);
        first.end_timestamp_ms = second.segment.end_timestamp_ms;
        true
    }

    /// Finals first, oldest first; then the waiting partial.
    pub fn pop(&mut self) -> Option<Job> {
        match self.jobs.iter().position(|j| j.is_final) {
            Some(i) => self.jobs.remove(i),
            None => self.jobs.pop_front(),
        }
    }
}

/// Numbers segments per channel: from 0, no gaps. A partial carries the seq
/// its final will have; an empty final takes no number.
#[derive(Default)]
pub struct Seqs([u64; 2]);

impl Seqs {
    pub fn segment(&mut self, job: &Job, text: &str) -> Option<Segment> {
        let text = clean(text);
        if text.is_empty() {
            return None;
        }
        let i = job.channel.index();
        let seq = self.0[i];
        if job.is_final {
            self.0[i] += 1;
        }
        Some(Segment {
            seq,
            channel: job.channel,
            start_ms: job.segment.start_timestamp_ms.max(0.0) as u64,
            end_ms: job.segment.end_timestamp_ms.max(0.0) as u64,
            text,
            is_final: job.is_final,
        })
    }
}

/// Trimmed, at most 2000 characters (3.1).
pub fn clean(text: &str) -> String {
    text.trim().chars().take(MAX_TEXT_CHARS).collect()
}

/// The queue shared by the capture workers and the STT thread.
#[derive(Default)]
pub struct Shared {
    pub queue: Mutex<Queue>,
    pub wake: Condvar,
    pub busy: AtomicBool,
    pub len: AtomicU32,
    pub dropped: AtomicU32,
    /// No job waiting and none running: a partial may be made.
    pub idle: Arc<AtomicBool>,
}

impl Shared {
    /// Never blocks for longer than the queue lock (held for a push or a pop).
    pub fn push(&self, job: Job) {
        let mut q = self.queue.lock().unwrap();
        q.push(job);
        self.publish(&q);
        drop(q);
        self.wake.notify_one();
    }

    fn publish(&self, q: &Queue) {
        self.len.store(q.len() as u32, Ordering::Relaxed);
        self.dropped.store(q.dropped, Ordering::Relaxed);
        self.idle.store(q.len() == 0 && !self.busy.load(Ordering::Relaxed), Ordering::Relaxed);
    }

    fn next(&self, stop: &AtomicBool) -> Option<Job> {
        let mut q = self.queue.lock().unwrap();
        loop {
            if let Some(job) = q.pop() {
                self.busy.store(true, Ordering::Relaxed);
                self.publish(&q);
                return Some(job);
            }
            if stop.load(Ordering::Relaxed) {
                return None;
            }
            q = self.wake.wait_timeout(q, Duration::from_millis(200)).unwrap().0;
        }
    }

    fn done(&self) {
        self.busy.store(false, Ordering::Relaxed);
        let q = self.queue.lock().unwrap();
        self.publish(&q);
    }
}

/// Something that turns 16 kHz mono samples into text (Parakeet, or a fake in tests).
pub trait Transcriber {
    fn transcribe(&mut self, samples: Vec<f32>) -> Result<String, String>;
}

impl Transcriber for ParakeetModel {
    fn transcribe(&mut self, samples: Vec<f32>) -> Result<String, String> {
        self.transcribe_samples(samples).map(|r| r.text).map_err(|e| e.to_string())
    }
}

/// `intra_op_threads = min(4, max(2, physical_cores / 2))` (4.5); logical cores halved stand in for physical ones.
pub fn intra_threads() -> usize {
    let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (logical / 2).clamp(2, 4)
}

/// The loaded model, kept between meetings and dropped 10 minutes after the last one.
static KEPT: Mutex<Option<(ParakeetModel, Instant)>> = Mutex::new(None);

pub fn load(dir: &PathBuf) -> Result<ParakeetModel, String> {
    if let Some((m, _)) = KEPT.lock().unwrap().take() {
        return Ok(m);
    }
    ParakeetModel::new(dir, true, intra_threads()).map_err(|e| format!("speech model: {e}"))
}

pub fn keep(model: ParakeetModel) {
    *KEPT.lock().unwrap() = Some((model, Instant::now()));
    let _ = std::thread::Builder::new().name("meeting-stt-unload".into()).spawn(|| {
        std::thread::sleep(UNLOAD_AFTER);
        let mut kept = KEPT.lock().unwrap();
        if kept.as_ref().is_some_and(|(_, at)| at.elapsed() >= UNLOAD_AFTER) {
            *kept = None;
        }
    });
}

/// The `meeting-stt` loop: one inference at a time, results to `out`, which must not block.
pub fn run<T: Transcriber>(model: &mut T, shared: &Shared, stop: &AtomicBool, mut out: impl FnMut(Segment)) {
    let mut seqs = Seqs::default();
    while let Some(job) = shared.next(stop) {
        let samples = job.segment.samples.clone();
        match model.transcribe(samples) {
            Ok(text) => {
                if let Some(seg) = seqs.segment(&job, &text) {
                    out(seg);
                }
            }
            Err(e) => log::warn!("meeting: speech to text failed: {e}"),
        }
        shared.done();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(channel: Channel, is_final: bool, start: f64) -> Job {
        Job {
            channel,
            is_final,
            segment: SpeechSegment { samples: vec![0.0; 160], start_timestamp_ms: start, end_timestamp_ms: start + 10.0 },
        }
    }

    #[test]
    fn finals_jump_the_queue_and_a_partial_replaces_the_waiting_one() {
        let mut q = Queue::default();
        q.push(job(Channel::Them, false, 0.0));
        q.push(job(Channel::Them, false, 1.0));
        q.push(job(Channel::Me, true, 2.0));
        assert_eq!(q.len(), 2);
        let first = q.pop().unwrap();
        assert!(first.is_final && first.channel == Channel::Me);
        let second = q.pop().unwrap();
        assert!(!second.is_final && second.segment.start_timestamp_ms == 1.0);
    }

    #[test]
    fn overflow_never_drops_a_them_final_and_merges_me_finals() {
        let mut q = Queue::default();
        for i in 0..10 {
            q.push(job(Channel::Them, true, i as f64 * 100.0));
            q.push(job(Channel::Me, true, i as f64 * 100.0));
        }
        assert_eq!(q.count(Channel::Them), 10);
        assert_eq!(q.count(Channel::Me), PER_CHANNEL);
        // merged "me" audio is kept, not dropped
        let me_samples: usize = q.jobs.iter().filter(|j| j.channel == Channel::Me).map(|j| j.segment.samples.len()).sum();
        assert_eq!(me_samples, 10 * 160);
        assert_eq!(q.dropped, 0);
    }

    #[test]
    fn overflow_drops_partials_first() {
        let mut q = Queue::default();
        q.push(job(Channel::Me, false, 0.0));
        for i in 0..4 {
            q.push(job(Channel::Me, true, i as f64));
        }
        assert_eq!(q.dropped, 1);
        assert!(q.jobs.iter().all(|j| j.is_final));
    }

    #[test]
    fn seqs_have_no_gaps_and_partials_share_the_next_one() {
        let mut s = Seqs::default();
        let p = s.segment(&job(Channel::Them, false, 0.0), " so where ").unwrap();
        assert_eq!((p.seq, p.text.as_str(), p.is_final), (0, "so where", false));
        assert!(s.segment(&job(Channel::Them, true, 0.0), "   ").is_none());
        assert_eq!(s.segment(&job(Channel::Them, true, 0.0), "So where are we?").unwrap().seq, 0);
        assert_eq!(s.segment(&job(Channel::Them, true, 0.0), "Next.").unwrap().seq, 1);
        assert_eq!(s.segment(&job(Channel::Me, true, 0.0), "Me.").unwrap().seq, 0);
        assert_eq!(clean(&"x".repeat(3000)).len(), MAX_TEXT_CHARS);
    }

    struct Slow(Duration);
    impl Transcriber for Slow {
        fn transcribe(&mut self, samples: Vec<f32>) -> Result<String, String> {
            std::thread::sleep(self.0);
            Ok(format!("{} samples", samples.len()))
        }
    }

    /// 9.1: a slow STT (here 200 ms a job, the design's 2 s scaled down);
    /// 10 segments arrive fast. Every "them" final comes out, pushing never waits on the model.
    #[test]
    fn a_slow_model_keeps_every_them_final() {
        let shared = Arc::new(Shared::default());
        let stop = Arc::new(AtomicBool::new(false));
        let out = Arc::new(Mutex::new(Vec::new()));
        let worker = {
            let (shared, stop, out) = (shared.clone(), stop.clone(), out.clone());
            std::thread::spawn(move || run(&mut Slow(Duration::from_millis(200)), &shared, &stop, |s| out.lock().unwrap().push(s)))
        };
        let started = Instant::now();
        for i in 0..10 {
            shared.push(job(Channel::Them, false, i as f64));
            shared.push(job(Channel::Them, true, i as f64));
        }
        assert!(started.elapsed() < Duration::from_millis(100), "push waited on the model");
        while shared.len.load(Ordering::Relaxed) > 0 || shared.busy.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(20));
        }
        stop.store(true, Ordering::Relaxed);
        worker.join().unwrap();
        let out = out.lock().unwrap();
        let finals: Vec<u64> = out.iter().filter(|s| s.is_final).map(|s| s.seq).collect();
        assert_eq!(finals, (0..10).collect::<Vec<_>>());
        assert!(shared.dropped.load(Ordering::Relaxed) > 0, "partials should have been dropped");
    }
}
