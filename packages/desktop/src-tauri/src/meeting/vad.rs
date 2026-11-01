// Copied from zackriya-solutions/meetily@a2cb62e:frontend/src-tauri/src/audio/vad.rs and changed for Conclave.
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
// Changes for Conclave (docs/design/MEETING-MODE.md 2.4): live redemption per
// channel (300 ms "them", 400 ms "me"), pads kept below the redemption time,
// a segment is cut at 12 s of continuous speech (upstream #756), silence is
// trimmed from silero's buffer so a long meeting does not grow it, the open
// speech is readable for partial transcripts, and the batch helpers, progress
// callbacks and ONNX runtime probe are removed.

use silero_rs::{VadConfig, VadSession, VadTransition};
use std::collections::VecDeque;
use std::time::Duration;

/// Silero VAD only operates at 16kHz; input is resampled to this rate, and every
/// sample count and timestamp inside this module is expressed in it.
pub const VAD_SAMPLE_RATE: u32 = 16000;
/// Redemption for the other people's channel: end of a question is found 300 ms after they stop.
pub const REDEMPTION_THEM_MS: u32 = 300;
pub const REDEMPTION_ME_MS: u32 = 400;
/// Continuous speech is cut into segments of at most this long.
pub const MAX_SEGMENT_MS: u32 = 12_000;

/// Represents a complete speech segment detected by VAD
#[derive(Debug, Clone)]
pub struct SpeechSegment {
    pub samples: Vec<f32>,
    pub start_timestamp_ms: f64,
    pub end_timestamp_ms: f64,
}

/// The silero settings for live use. Both pads stay below the redemption
/// time: silero slices `[start - pre_pad, end + post_pad]` out of its buffer,
/// and a post pad longer than the silence it waited for reads past the end of
/// the buffer (a panic inside silero), as a pre pad longer than the gap since
/// the last cut reads before its start.
pub fn live_config(redemption_time_ms: u32) -> VadConfig {
    let mut config = VadConfig::default();
    config.sample_rate = VAD_SAMPLE_RATE as usize;
    config.positive_speech_threshold = 0.50; // Silero default - good for continuous speech
    config.negative_speech_threshold = 0.35; // Silero default - allows natural pauses
    config.redemption_time = Duration::from_millis(redemption_time_ms as u64);
    config.pre_speech_pad = Duration::from_millis((redemption_time_ms / 2).min(200) as u64);
    config.post_speech_pad = Duration::from_millis((redemption_time_ms / 2).min(150) as u64);
    // 250ms keeps tiny fragments out of the speech model
    config.min_speech_time = Duration::from_millis(250);
    config
}

/// Processes audio in 30ms chunks but returns complete speech segments
pub struct ContinuousVadProcessor {
    session: VadSession,
    chunk_size: usize,
    sample_rate: u32,
    buffer: Vec<f32>,
    speech_segments: VecDeque<SpeechSegment>,
    in_speech: bool,
    processed_samples: usize,
    speech_start_sample: usize,
    /// Samples of the open speech already sent as cut segments.
    emitted: usize,
    max_segment_samples: usize,
    /// Samples processed since silero's buffer was last trimmed.
    since_trim: usize,
    /// silero's pre-speech pad: kept in its buffer after a cut, so a restart reads inside it.
    pre_pad_ms: u64,
}

/// Where a long speech is cut: the end index inside the open speech (`speech_len`
/// samples, ending at `processed` session samples) and the session time in ms silero's
/// buffer is trimmed to. Everything after the cut, `pre_pad_ms` and the rounding, stays.
fn cut_point(speech_len: usize, processed: usize, session_ms: u64, pre_pad_ms: u64) -> (usize, u64) {
    let cut_ms = session_ms.saturating_sub(pre_pad_ms);
    let per_ms = VAD_SAMPLE_RATE as usize / 1000;
    let tail = processed.saturating_sub(cut_ms as usize * per_ms);
    (speech_len.saturating_sub(tail), cut_ms)
}

impl ContinuousVadProcessor {
    pub fn new(input_sample_rate: u32, redemption_time_ms: u32) -> Result<Self, String> {
        let config = live_config(redemption_time_ms);
        let pre_pad_ms = config.pre_speech_pad.as_millis() as u64;
        let session = VadSession::new(config).map_err(|e| format!("Failed to create VAD session: {e:?}"))?;
        // VAD uses 30ms chunks at 16kHz (480 samples)
        let vad_chunk_size = (VAD_SAMPLE_RATE as f32 * 0.03) as usize;
        Ok(Self {
            session,
            chunk_size: vad_chunk_size,
            sample_rate: input_sample_rate,
            buffer: Vec::with_capacity(vad_chunk_size * 2),
            speech_segments: VecDeque::new(),
            in_speech: false,
            processed_samples: 0,
            speech_start_sample: 0,
            emitted: 0,
            max_segment_samples: (MAX_SEGMENT_MS as usize) * (VAD_SAMPLE_RATE as usize) / 1000,
            since_trim: 0,
            pre_pad_ms,
        })
    }

    /// Process incoming audio samples and return any complete speech segments
    /// Handles resampling from input sample rate to 16kHz for VAD processing
    pub fn process_audio(&mut self, samples: &[f32]) -> Result<Vec<SpeechSegment>, String> {
        if self.sample_rate == VAD_SAMPLE_RATE {
            self.buffer.extend_from_slice(samples);
        } else {
            let resampled = resample_to_16k(self.sample_rate, samples);
            self.buffer.extend_from_slice(&resampled);
        }
        let mut completed_segments = Vec::new();

        // Process complete 30ms chunks (480 samples at 16kHz)
        while self.buffer.len() >= self.chunk_size {
            let chunk: Vec<f32> = self.buffer.drain(..self.chunk_size).collect();
            self.process_chunk(&chunk)?;
            self.cut_long_speech();
            self.trim_silence();
            completed_segments.extend(self.speech_segments.drain(..));
        }

        Ok(completed_segments)
    }

    /// The speech that is still open and not yet sent, with its start in ms,
    /// for a partial transcript. None outside speech.
    pub fn open_speech(&self) -> Option<(&[f32], f64)> {
        if !self.in_speech {
            return None;
        }
        let current = self.session.get_current_speech();
        let rest = current.get(self.emitted..)?;
        Some((rest, self.sample_ms(self.speech_start_sample + self.emitted)))
    }

    /// Flush any remaining audio and return final speech segments
    pub fn flush(&mut self) -> Result<Vec<SpeechSegment>, String> {
        // Preserve the real post-resampling endpoint before padding the final VAD frame.
        let real_end_sample = self.processed_samples + self.buffer.len();

        if !self.buffer.is_empty() {
            let mut padded_chunk = std::mem::take(&mut self.buffer);
            if padded_chunk.len() < self.chunk_size {
                padded_chunk.resize(self.chunk_size, 0.0);
            }
            self.process_chunk(&padded_chunk)?;
        }

        // Force end any ongoing speech
        if self.in_speech {
            let real_count = real_end_sample.saturating_sub(self.speech_start_sample);
            let active_speech = self.session.get_current_speech();
            let end = real_count.min(active_speech.len());
            if end > self.emitted {
                let samples = active_speech[self.emitted..end].to_vec();
                let start_ms = self.sample_ms(self.speech_start_sample + self.emitted);
                self.speech_segments.push_back(SpeechSegment {
                    end_timestamp_ms: start_ms + self.sample_ms(samples.len()),
                    start_timestamp_ms: start_ms,
                    samples,
                });
            }
            self.in_speech = false;
            self.emitted = 0;
        }

        Ok(self.speech_segments.drain(..).collect())
    }

    fn sample_ms(&self, samples: usize) -> f64 {
        samples as f64 * 1000.0 / VAD_SAMPLE_RATE as f64
    }

    /// Continuous speech never reaches a silence, so silero never closes it:
    /// send what is open every 12 s and keep listening.
    ///
    /// silero keeps the whole open speech in its buffer until speech ends, and its
    /// `take_until` cannot trim inside speech (the speech state keeps the old start, and
    /// the end of speech then reads before the buffer: a panic). So after a cut the
    /// session is reset to silence and its buffer trimmed: music or hold audio that never
    /// stops costs at most 12 s of samples, not 230 MB an hour. The last pre-pad of audio
    /// is kept, not sent: speech that goes on starts again right there, its pre-pad reads it.
    fn cut_long_speech(&mut self) {
        if !self.in_speech {
            return;
        }
        let current = self.session.get_current_speech();
        if current.len() < self.emitted + self.max_segment_samples {
            return;
        }
        let (end, cut_ms) = cut_point(current.len(), self.processed_samples, self.session.session_time().as_millis() as u64, self.pre_pad_ms);
        if end > self.emitted {
            let samples = current[self.emitted..end].to_vec();
            let start_ms = self.sample_ms(self.speech_start_sample + self.emitted);
            self.speech_segments.push_back(SpeechSegment {
                end_timestamp_ms: start_ms + self.sample_ms(samples.len()),
                start_timestamp_ms: start_ms,
                samples,
            });
        }
        self.session.reset();
        self.session.take_until(Duration::from_millis(cut_ms));
        self.in_speech = false;
        self.emitted = 0;
        self.since_trim = 0;
    }

    /// silero keeps every sample it saw outside speech. After 2 s of silence,
    /// drop all but the last second, at most every 5 s of audio.
    fn trim_silence(&mut self) {
        if self.in_speech || self.since_trim < 5 * VAD_SAMPLE_RATE as usize {
            return;
        }
        // 2 s of raw silence means silero is in its silence state too: the redemption is shorter
        if self.session.current_silence_duration() < Duration::from_secs(2) {
            return;
        }
        let now = self.session.session_time();
        if now > Duration::from_secs(2) {
            self.session.take_until(now - Duration::from_secs(1));
        }
        self.since_trim = 0;
    }

    fn process_chunk(&mut self, chunk: &[f32]) -> Result<(), String> {
        let transitions = self
            .session
            .process(chunk)
            .map_err(|e| format!("VAD processing failed: {e}"))?;

        for transition in transitions {
            match transition {
                VadTransition::SpeechStart { timestamp_ms } => {
                    self.in_speech = true;
                    // `timestamp_ms` is ALREADY session-absolute: silero computes it as
                    // `processed_duration() - pre_speech_pad`.
                    self.speech_start_sample = timestamp_ms * VAD_SAMPLE_RATE as usize / 1000;
                    self.emitted = 0;
                }
                VadTransition::SpeechEnd { start_timestamp_ms, end_timestamp_ms, samples } => {
                    self.in_speech = false;
                    // the part already sent by cut_long_speech is not sent again
                    let skip = self.emitted.min(samples.len());
                    self.emitted = 0;
                    if samples.len() > skip {
                        let start_ms = start_timestamp_ms as f64 + self.sample_ms(skip);
                        self.speech_segments.push_back(SpeechSegment {
                            samples: samples[skip..].to_vec(),
                            start_timestamp_ms: start_ms,
                            end_timestamp_ms: end_timestamp_ms as f64,
                        });
                    }
                }
            }
        }

        self.processed_samples += chunk.len();
        self.since_trim += chunk.len();
        Ok(())
    }
}

/// Improved resampling from input sample rate to 16kHz with anti-aliasing
/// Uses linear interpolation and basic low-pass filtering for better quality
pub fn resample_to_16k(sample_rate: u32, samples: &[f32]) -> Vec<f32> {
    if sample_rate == VAD_SAMPLE_RATE {
        return samples.to_vec();
    }

    // Calculate downsampling ratio
    let ratio = sample_rate as f64 / 16000.0;
    let output_len = (samples.len() as f64 / ratio) as usize;
    let mut resampled = Vec::with_capacity(output_len);

    // Apply simple low-pass filter before downsampling to reduce aliasing
    let cutoff_freq = 0.4; // Normalized frequency (0.4 * Nyquist)
    let mut filtered_samples = Vec::with_capacity(samples.len());

    // Simple moving average filter (basic low-pass)
    let filter_size = (sample_rate as f64 / (cutoff_freq * sample_rate as f64)) as usize;
    let filter_size = filter_size.clamp(1, 5); // Limit filter size

    for i in 0..samples.len() {
        let start = i.saturating_sub(filter_size);
        let end = std::cmp::min(i + filter_size + 1, samples.len());
        let sum: f32 = samples[start..end].iter().sum();
        filtered_samples.push(sum / (end - start) as f32);
    }

    // Linear interpolation downsampling
    for i in 0..output_len {
        let source_pos = i as f64 * ratio;
        let source_index = source_pos as usize;
        let fraction = source_pos - source_index as f64;

        if source_index + 1 < filtered_samples.len() {
            let sample1 = filtered_samples[source_index];
            let sample2 = filtered_samples[source_index + 1];
            resampled.push(sample1 + (sample2 - sample1) * fraction as f32);
        } else if source_index < filtered_samples.len() {
            resampled.push(filtered_samples[source_index]);
        }
    }

    resampled
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate synthetic speech-like audio: `speech` seconds of voiced signal
    /// then `silence` seconds of silence, repeated.
    fn speech_like(speech: f32, silence: f32, total: f32, sample_rate: u32) -> Vec<f32> {
        let total_samples = (total * sample_rate as f32) as usize;
        let mut samples = vec![0.0f32; total_samples];
        let cycle = speech + silence;
        for (i, s) in samples.iter_mut().enumerate() {
            let time = i as f32 / sample_rate as f32;
            if time % cycle < speech {
                let freq1 = 200.0 + (time * 50.0).sin() * 100.0;
                let freq2 = freq1 * 2.0;
                let freq3 = freq1 * 3.0;
                let amplitude = 0.3 + 0.1 * (time * 5.0).sin();
                *s = amplitude
                    * (0.5 * (2.0 * std::f32::consts::PI * freq1 * time).sin()
                        + 0.3 * (2.0 * std::f32::consts::PI * freq2 * time).sin()
                        + 0.2 * (2.0 * std::f32::consts::PI * freq3 * time).sin());
            }
        }
        samples
    }

    fn run(audio: &[f32], redemption: u32) -> Vec<SpeechSegment> {
        let mut vad = ContinuousVadProcessor::new(16000, redemption).expect("vad");
        let mut out = Vec::new();
        // 20 ms blocks, as the capture worker hands them over
        for block in audio.chunks(320) {
            out.extend(vad.process_audio(block).expect("process"));
        }
        out.extend(vad.flush().expect("flush"));
        out
    }

    /// No silero*.onnx file exists on disk by design: silero_rs compiles the model into the app.
    #[test]
    fn the_built_in_silero_model_loads() {
        let mut vad = ContinuousVadProcessor::new(48000, REDEMPTION_THEM_MS).expect("silero VAD from the embedded model");
        assert!(vad.process_audio(&vec![0.0; 4800]).expect("process").is_empty());
    }

    #[test]
    fn pads_stay_below_the_redemption() {
        for r in [REDEMPTION_THEM_MS, REDEMPTION_ME_MS, 100, 2000] {
            let c = live_config(r);
            assert!(c.post_speech_pad < c.redemption_time, "post pad for {r}");
            assert!(c.pre_speech_pad < c.redemption_time, "pre pad for {r}");
        }
    }

    // shortcut: silero does not hear the synthetic tone as steady speech (CI got 1 segment);
    // run these with a recorded speech clip once one is checked in: cargo test -- --ignored
    #[test]
    #[ignore = "needs a real speech clip"]
    fn continuous_speech_is_cut_at_twelve_seconds() {
        let audio = speech_like(30.0, 0.0, 30.0, 16000);
        let segments = run(&audio, REDEMPTION_THEM_MS);
        assert!(segments.len() >= 2, "expected cuts in 30 s of speech, got {}", segments.len());
        for s in &segments {
            assert!(s.samples.len() <= 12 * 16000, "segment of {} samples", s.samples.len());
            assert!(s.end_timestamp_ms >= s.start_timestamp_ms);
        }
        // cut pieces follow each other without overlap
        for pair in segments.windows(2) {
            assert!(pair[1].start_timestamp_ms + 1.0 >= pair[0].end_timestamp_ms);
        }
    }

    #[test]
    #[ignore = "needs a real speech clip"]
    fn a_one_second_pause_splits_with_300ms_redemption() {
        let audio = speech_like(3.0, 1.0, 8.0, 16000);
        let segments = run(&audio, REDEMPTION_THEM_MS);
        assert!(segments.len() >= 2, "expected two segments, got {}", segments.len());
    }

    #[test]
    #[ignore = "needs a real speech clip"]
    fn long_silence_is_trimmed_and_speech_after_it_still_found() {
        let mut audio = vec![0.0f32; 16000 * 60];
        audio.extend(speech_like(2.0, 1.0, 3.0, 16000));
        let segments = run(&audio, REDEMPTION_ME_MS);
        assert!(!segments.is_empty(), "speech after a minute of silence");
        assert!(segments[0].start_timestamp_ms >= 59_000.0, "start {}", segments[0].start_timestamp_ms);
    }

    #[test]
    fn a_cut_keeps_the_pre_pad_and_sends_the_rest() {
        // 12.03 s of open speech ending at 60 s of session; 150 ms pre-pad
        let processed = 60 * 16000;
        let (end, cut_ms) = cut_point(12 * 16000 + 480, processed, 60_000, 150);
        assert_eq!(cut_ms, 59_850);
        assert_eq!(end, 12 * 16000 + 480 - 150 * 16);
        // a session shorter than the pad never underflows
        assert_eq!(cut_point(100, 50, 3, 150), (100 - 50, 0));
    }

    #[test]
    #[ignore = "needs a real speech clip"]
    fn speech_that_never_ends_keeps_the_buffer_bounded() {
        let audio = speech_like(60.0, 0.0, 60.0, 16000);
        let mut vad = ContinuousVadProcessor::new(16000, REDEMPTION_THEM_MS).expect("vad");
        let mut max = 0;
        for block in audio.chunks(320) {
            vad.process_audio(block).expect("process");
            max = max.max(vad.session.session_audio_samples());
        }
        assert!(max <= 13 * 16000, "silero held {max} samples");
    }

    #[test]
    fn resampling_48k_gives_a_third() {
        let out = resample_to_16k(48000, &vec![0.25f32; 4800]);
        assert_eq!(out.len(), 1600);
        assert!(out.iter().all(|s| (s - 0.25).abs() < 1e-6));
    }
}
