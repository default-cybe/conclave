// Mic and system sound capture for meeting mode (docs/design/MEETING-MODE.md 4.5).
//
// The system-sound device choice is adapted from
// zackriya-solutions/meetily@a2cb62e:frontend/src-tauri/src/audio/devices/platform/linux.rs
// (the "monitor" source name heuristic) and .../platform/windows.rs:188-215
// (loopback on the output device with its own output config).
// Original licence: MIT. Copyright (c) 2024 Zackriya Solutions.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Not copied: Meetily's per-callback Vec conversion (it allocates on the audio
// thread) and its mixer. Here the callback converts, downmixes and pushes into
// a lock-free ring without allocating; one worker thread per channel owns the
// stream (cpal streams are not Send everywhere), drains the ring, and runs the VAD.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, Stream, StreamConfig};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use super::vad::{ContinuousVadProcessor, SpeechSegment};
use super::wire::Channel;

/// Seconds of audio the ring between the callback and the worker holds.
pub const RING_SECONDS: usize = 2;
/// The worker wakes this often to drain the ring.
const DRAIN_EVERY: Duration = Duration::from_millis(20);
/// A lost device is opened again this often.
const REOPEN_EVERY: Duration = Duration::from_secs(2);
/// Partial transcripts of "them": the first after 1.2 s of open speech, then every 1.0 s (4.3).
pub const PARTIAL_FIRST_MS: f64 = 1200.0;
pub const PARTIAL_EVERY: Duration = Duration::from_millis(1000);
/// No partial of open speech longer than this: a partial cannot be stopped once it runs, so a
/// long one would hold up the question's final; speculation needs only the first 2 s.
pub const PARTIAL_LAST_MS: f64 = 6000.0;
/// 30 s of exact zeros on the system channel means macOS denied the capture (6).
const SILENT_DENIED: Duration = Duration::from_secs(30);

/// A mono ring of `seconds` at `rate`.
pub fn ring(rate: u32, seconds: usize) -> (HeapProd<f32>, HeapCons<f32>) {
    HeapRb::<f32>::new(rate as usize * seconds).split()
}

/// The audio callback's whole job: convert, downmix to mono, push. No
/// allocation, no lock, no logging. When the worker stalls and the ring is
/// full, the newest frames are dropped and counted: an SPSC producer cannot
/// remove the oldest ones (the consumer owns them).
pub fn push_frames<T>(prod: &mut HeapProd<f32>, data: &[T], channels: usize, dropped: &AtomicU64)
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = channels.max(1);
    let frames = data.len() / channels;
    let mono = data
        .chunks_exact(channels)
        .map(|f| (f.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / channels as f32).clamp(-1.0, 1.0));
    let pushed = prod.push_iter(mono);
    if pushed < frames {
        dropped.fetch_add((frames - pushed) as u64, Ordering::Relaxed);
    }
}

/// What a channel worker reports, read by the status line (3.3).
#[derive(Default)]
pub struct ChannelShared {
    pub ok: AtomicBool,
    /// Level 0..1 as f32 bits.
    pub level: AtomicU32,
    pub dropped: AtomicU64,
    pub device: std::sync::Mutex<Option<String>>,
    pub error: std::sync::Mutex<Option<String>>,
}

impl ChannelShared {
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
    fn set(&self, ok: bool, device: Option<String>, error: Option<String>) {
        self.ok.store(ok, Ordering::Relaxed);
        *self.device.lock().unwrap() = device;
        *self.error.lock().unwrap() = error;
    }
}

/// What the worker hands to the speech-to-text queue.
pub enum Speech {
    Final(Channel, SpeechSegment),
    Partial(Channel, SpeechSegment),
}

/// Runs on a `meeting-mic` / `meeting-sys` thread until `stop` is set. Opens
/// the device, reopens it every 2 s when it fails, and sends speech through
/// `send` (which must never block). Paused: the stream is dropped, so the OS
/// mic indicator goes off too.
pub fn run_channel(
    channel: Channel,
    shared: Arc<ChannelShared>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    stt_idle: Arc<AtomicBool>,
    mut send: impl FnMut(Speech),
) {
    let redemption = match channel {
        Channel::Them => super::vad::REDEMPTION_THEM_MS,
        Channel::Me => super::vad::REDEMPTION_ME_MS,
    };
    let mut block = vec![0f32; 4800];
    while !stop.load(Ordering::Relaxed) {
        if paused.load(Ordering::Relaxed) {
            shared.ok.store(false, Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        let failed = Arc::new(AtomicBool::new(false));
        let opened = open(channel, &shared, &failed);
        let (stream, mut cons, rate, name) = match opened {
            Ok(v) => v,
            Err(e) => {
                shared.set(false, None, Some(e));
                sleep_unless(&stop, REOPEN_EVERY);
                continue;
            }
        };
        if let Err(e) = stream.play() {
            shared.set(false, Some(name), Some(e.to_string()));
            sleep_unless(&stop, REOPEN_EVERY);
            continue;
        }
        shared.set(true, Some(name.clone()), None);
        let mut vad = match ContinuousVadProcessor::new(rate, redemption) {
            Ok(v) => v,
            Err(e) => {
                shared.set(false, Some(name), Some(e));
                sleep_unless(&stop, REOPEN_EVERY);
                continue;
            }
        };
        let mut last_partial: Option<Instant> = None;
        let mut nonzero_at = Instant::now();
        let mut silence_reported = false;
        while !stop.load(Ordering::Relaxed) && !paused.load(Ordering::Relaxed) && !failed.load(Ordering::Relaxed) {
            std::thread::sleep(DRAIN_EVERY);
            let mut peak = 0f32;
            while cons.occupied_len() > 0 {
                let n = cons.pop_slice(&mut block);
                let data = &block[..n];
                for s in data {
                    peak = peak.max(s.abs());
                }
                if data.iter().any(|s| *s != 0.0) {
                    nonzero_at = Instant::now();
                }
                match vad.process_audio(data) {
                    Ok(segments) => {
                        for seg in segments {
                            last_partial = None;
                            send(Speech::Final(channel, seg));
                        }
                    }
                    Err(e) => shared.set(true, Some(name.clone()), Some(e)),
                }
            }
            shared.level.store(peak.min(1.0).to_bits(), Ordering::Relaxed);
            if channel == Channel::Them {
                let denied = nonzero_at.elapsed() >= SILENT_DENIED;
                if denied != silence_reported {
                    silence_reported = denied;
                    *shared.error.lock().unwrap() = denied.then(|| "no system sound".to_string());
                }
                if let Some(seg) = partial_due(&vad, last_partial, stt_idle.load(Ordering::Relaxed)) {
                    last_partial = Some(Instant::now());
                    send(Speech::Partial(channel, seg));
                }
            }
        }
        // the last open segment (at most 1 s of work, 1.4)
        if let Ok(segments) = vad.flush() {
            for seg in segments {
                send(Speech::Final(channel, seg));
            }
        }
        drop(stream);
        shared.level.store(0, Ordering::Relaxed);
        if failed.load(Ordering::Relaxed) && !stop.load(Ordering::Relaxed) {
            let what = match channel {
                Channel::Me => "no mic",
                Channel::Them => "no system sound",
            };
            shared.set(false, Some(name), Some(what.into()));
            sleep_unless(&stop, REOPEN_EVERY);
        }
    }
    shared.set(false, None, None);
    shared.level.store(0, Ordering::Relaxed);
}

/// A partial of the open speech is due after 1.2 s of it, then every 1.0 s,
/// and only while the speech model has nothing else to do.
fn partial_due(vad: &ContinuousVadProcessor, last: Option<Instant>, stt_idle: bool) -> Option<SpeechSegment> {
    if !stt_idle || last.is_some_and(|t| t.elapsed() < PARTIAL_EVERY) {
        return None;
    }
    let (samples, start_ms) = vad.open_speech()?;
    let len_ms = samples.len() as f64 * 1000.0 / super::vad::VAD_SAMPLE_RATE as f64;
    partial_len_ok(len_ms).then(|| SpeechSegment {
        samples: samples.to_vec(),
        start_timestamp_ms: start_ms,
        end_timestamp_ms: start_ms + len_ms,
    })
}

fn partial_len_ok(len_ms: f64) -> bool {
    (PARTIAL_FIRST_MS..=PARTIAL_LAST_MS).contains(&len_ms)
}

fn sleep_unless(stop: &AtomicBool, total: Duration) {
    let until = Instant::now() + total;
    while !stop.load(Ordering::Relaxed) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
}

type Opened = (Stream, HeapCons<f32>, u32, String);

fn open(channel: Channel, shared: &Arc<ChannelShared>, failed: &Arc<AtomicBool>) -> Result<Opened, String> {
    let host = cpal::default_host();
    let (device, supported) = match channel {
        Channel::Me => {
            let d = host.default_input_device().ok_or("no mic")?;
            let c = d.default_input_config().map_err(|e| e.to_string())?;
            (d, c)
        }
        Channel::Them => system_device(&host)?,
    };
    let name = device.description().map(|d| d.name().to_string()).unwrap_or_else(|_| "default".into());
    let format = supported.sample_format();
    let config: StreamConfig = supported.config();
    let rate = config.sample_rate;
    let (prod, cons) = ring(rate, RING_SECONDS);
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, config, prod, shared, failed),
        SampleFormat::F64 => build::<f64>(&device, config, prod, shared, failed),
        SampleFormat::I8 => build::<i8>(&device, config, prod, shared, failed),
        SampleFormat::I16 => build::<i16>(&device, config, prod, shared, failed),
        SampleFormat::I32 => build::<i32>(&device, config, prod, shared, failed),
        SampleFormat::U8 => build::<u8>(&device, config, prod, shared, failed),
        SampleFormat::U16 => build::<u16>(&device, config, prod, shared, failed),
        other => return Err(format!("unsupported sample format {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    Ok((stream, cons, rate, name))
}

fn build<T>(
    device: &cpal::Device,
    config: StreamConfig,
    mut prod: HeapProd<f32>,
    shared: &Arc<ChannelShared>,
    failed: &Arc<AtomicBool>,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let data_shared = shared.clone();
    let failed = failed.clone();
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _| push_frames(&mut prod, data, channels, &data_shared.dropped),
        move |e| {
            // an xrun is a glitch, not a lost device
            if e.kind() != cpal::ErrorKind::Xrun {
                failed.store(true, Ordering::Relaxed);
            }
        },
        None,
    )
}

/// The system sound: loopback on the default output device on Windows
/// (WASAPI) and macOS 14.6+ (Core Audio tap, cpal builds an input stream on
/// an output device that way), a PulseAudio/PipeWire "monitor" source on Linux.
#[cfg(not(target_os = "linux"))]
fn system_device(host: &cpal::Host) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let d = host.default_output_device().ok_or("no system sound")?;
    let c = d.default_output_config().map_err(|e| e.to_string())?;
    Ok((d, c))
}

#[cfg(target_os = "linux")]
fn system_device(host: &cpal::Host) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let devices = host.input_devices().map_err(|e| e.to_string())?;
    for d in devices {
        let name = d.description().map(|n| n.name().to_string()).unwrap_or_default();
        if is_monitor_source(&name) {
            if let Ok(c) = d.default_input_config() {
                return Ok((d, c));
            }
        }
    }
    Err("no system sound: no PulseAudio/PipeWire monitor source".into())
}

/// Meetily's heuristic: a monitor source of the sound server records what plays.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn is_monitor_source(name: &str) -> bool {
    name.to_ascii_lowercase().contains("monitor")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partials_only_between_1_2_and_6_seconds_of_open_speech() {
        assert!(!partial_len_ok(1000.0));
        assert!(partial_len_ok(1200.0) && partial_len_ok(6000.0));
        assert!(!partial_len_ok(6030.0) && !partial_len_ok(12_000.0));
    }

    #[test]
    fn a_full_ring_drops_and_counts_without_blocking() {
        // 5 s pushed into a 2 s ring at 1 kHz, with nobody reading
        let (mut prod, cons) = ring(1000, RING_SECONDS);
        let dropped = AtomicU64::new(0);
        let started = Instant::now();
        for _ in 0..50 {
            push_frames(&mut prod, &vec![0.5f32; 100], 1, &dropped);
        }
        assert!(started.elapsed() < Duration::from_millis(200));
        assert_eq!(cons.occupied_len(), 2000);
        assert_eq!(dropped.load(Ordering::Relaxed), 3000);
    }

    #[test]
    fn frames_are_downmixed_converted_and_clamped() {
        let (mut prod, mut cons) = ring(1000, 1);
        let dropped = AtomicU64::new(0);
        push_frames(&mut prod, &[i16::MAX, 0, i16::MIN, i16::MIN], 2, &dropped);
        push_frames(&mut prod, &[2.0f32, 2.0], 2, &dropped);
        let mut out = [0f32; 3];
        assert_eq!(cons.pop_slice(&mut out), 3);
        assert!((out[0] - 0.5).abs() < 0.01, "{out:?}");
        assert!((out[1] + 1.0).abs() < 0.01, "{out:?}");
        assert_eq!(out[2], 1.0);
    }

    #[test]
    fn monitor_sources_are_found_by_name() {
        assert!(is_monitor_source("Monitor of Built-in Audio Analog Stereo"));
        assert!(is_monitor_source("alsa_output.pci.analog-stereo.monitor"));
        assert!(!is_monitor_source("Built-in Microphone"));
    }
}
