//! Serde mirrors of the meeting wire contract (docs/design/MEETING-MODE.md
//! section 3, `packages/core/src/meeting/wire.ts`). Field names are camelCase
//! on both sides. Only the types the desktop app sends or reads are here.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Me,
    Them,
}

impl Channel {
    pub fn index(self) -> usize {
        match self {
            Channel::Me => 0,
            Channel::Them => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeetingStatus {
    Preparing,
    Ready,
    Live,
    Paused,
    Ending,
    Ended,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoAnswer {
    Questions,
    Off,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub account_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub device: String,
    pub cwd: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agenda: Option<String>,
    pub status: MeetingStatus,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes_path: Option<String>,
    pub auto_answer: AutoAnswer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// At most this many characters of text per segment (3.1).
pub const MAX_TEXT_CHARS: usize = 2000;
/// 1 to 32 segments per batch (3.1).
pub const MAX_BATCH: usize = 32;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub seq: u64,
    pub channel: Channel,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    #[serde(rename = "final")]
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentBatch {
    pub client_id: String,
    pub t0: i64,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastSeq {
    pub me: i64,
    pub them: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentAck {
    pub accepted: u64,
    pub last_seq: LastSeq,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnswerNowInput {
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Exclusion {
    Excluded,
    MonitorOnly,
    Unsupported,
    Failed,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelState {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SttState {
    Loading,
    Downloading,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    pub state: SttState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct QueueStatus {
    pub stt: u32,
    pub upload: u32,
    pub dropped: u32,
}

/// `meeting_status` and the `meeting://status` event (3.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMeetingStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    pub live: bool,
    pub paused: bool,
    pub click_through: bool,
    pub hidden_for_share: bool,
    pub exclusion: Exclusion,
    pub mic: ChannelState,
    pub system: ChannelState,
    pub stt: SttStatus,
    pub queue: QueueStatus,
}

/// `meeting://level`, each in 0..1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Levels {
    pub me: f32,
    pub them: f32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn round_trip<T: Serialize + for<'de> Deserialize<'de>>(v: Value) {
        let parsed: T = serde_json::from_value(v.clone()).expect("parses");
        assert_eq!(serde_json::to_value(&parsed).unwrap(), v);
    }

    #[test]
    fn segment_batch_matches_the_contract() {
        round_trip::<SegmentBatch>(json!({
            "clientId": "c1",
            "t0": 1761900000000i64,
            "segments": [
                { "seq": 0, "channel": "them", "startMs": 0, "endMs": 1200, "text": "Where are we on export?", "final": true },
                { "seq": 0, "channel": "me", "startMs": 300, "endMs": 900, "text": "Hm", "final": false }
            ]
        }));
        round_trip::<SegmentAck>(json!({ "accepted": 2, "lastSeq": { "me": 0, "them": -1 } }));
        round_trip::<AnswerNowInput>(json!({ "reason": "hotkey" }));
    }

    #[test]
    fn meeting_matches_the_contract() {
        round_trip::<Meeting>(json!({
            "id": "mtg_1", "accountId": "owner", "sessionId": "s1", "projectId": "p1",
            "device": "laptop", "cwd": "/w/p", "title": "Standup", "status": "live",
            "createdAt": 1, "startedAt": 2, "audioClientId": "c1", "autoAnswer": "questions"
        }));
        // fields this app does not know yet are ignored, not an error
        let m: Meeting = serde_json::from_value(json!({
            "id": "mtg_1", "accountId": "a", "sessionId": "s", "device": "d", "cwd": "/", "title": "t",
            "status": "paused", "createdAt": 1, "autoAnswer": "off", "segments": [], "answers": []
        }))
        .unwrap();
        assert_eq!(m.status, MeetingStatus::Paused);
    }

    #[test]
    fn desktop_status_matches_the_contract() {
        round_trip::<DesktopMeetingStatus>(json!({
            "meetingId": "mtg_1", "live": true, "paused": false, "clickThrough": false,
            "hiddenForShare": false, "exclusion": "monitor-only",
            "mic": { "ok": true, "device": "Built-in" }, "system": { "ok": false, "error": "no system sound" },
            "stt": { "state": "downloading", "progress": 0.5 },
            "queue": { "stt": 1, "upload": 0, "dropped": 3 }
        }));
        round_trip::<Levels>(json!({ "me": 0.5, "them": 0.25 }));
    }

    /// Track B's fixtures (packages/core/test/meeting/fixtures/), when they exist:
    /// every `segment-batch*.json` and `meeting*.json` parses and round-trips.
    #[test]
    fn shared_fixtures_round_trip() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core/test/meeting/fixtures");
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            // exact names: meeting-answer.json and meeting-notes.json are other types
            match name.as_str() {
                "segment-batch.json" => round_trip::<SegmentBatch>(v),
                "segment-ack.json" => round_trip::<SegmentAck>(v),
                // progress is f32, so 0.42 comes back as 0.41999998: compare parsed values
                "desktop-meeting-status.json" => {
                    let s: DesktopMeetingStatus = serde_json::from_value(v).expect("parses");
                    assert_eq!(serde_json::from_value::<DesktopMeetingStatus>(serde_json::to_value(&s).unwrap()).unwrap(), s);
                }
                "meeting.json" => round_trip::<Meeting>(v),
                "answer-now-input.json" => round_trip::<AnswerNowInput>(v),
                _ => {}
            }
        }
    }
}
