/**
 * Meeting mode wire contract (docs/design/MEETING-MODE.md 3). Shared by the
 * hub (core + server), the web overlay (Track C, imports this file) and the
 * desktop app (Track A, mirrors it in src/meeting/wire.rs). The JSON fixtures
 * in packages/core/test/meeting/fixtures/ pin the shapes for all three.
 *
 * Times are epoch milliseconds (hub clock for hub fields, desktop clock for
 * t0); durations in milliseconds. Pure: no imports, safe for the overlay bundle.
 */

export type MeetingStatus = 'scheduled' | 'preparing' | 'ready' | 'live' | 'paused' | 'ending' | 'ended' | 'failed';
export type PrepState = 'none' | 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type AnswerLength = 'short' | 'long';
export type Channel = 'me' | 'them';

export interface Meeting {
  id: string; // "mtg_<time><random>"
  accountId: string;
  sessionId: string; // the kind:'meeting' session
  projectId?: string;
  device: string; // where the project folder is
  cwd: string;
  title: string;
  agenda?: string;
  status: MeetingStatus;
  createdAt: number;
  startedAt?: number; // first 'live'
  endedAt?: number;
  audioClientId?: string; // the desktop app that listens; set by the first segments call
  briefMessageId?: string;
  notesPath?: string; // set after wrap-up
  autoAnswer: 'questions' | 'off';
  error?: string;
  // ----- scheduled meetings (11.6); the hub always sends answerLength, reminders, autoPrep and prepState -----
  scheduledAt?: number;
  durationMin?: number; // 15 to 480
  tz?: string; // IANA zone at scheduling time
  steering?: string; // at most STEERING_MAX
  steeringPreset?: string; // a STEERING_PRESETS id, or 'custom'
  answerLength?: AnswerLength;
  calendarEventId?: string;
  calendarId?: string;
  reminders?: number[]; // minutes before the start; a subset of REMINDER_CHOICES
  autoPrep?: boolean;
  prepState?: PrepState;
  prepProgress?: PrepProgress;
  prepAt?: number;
  prepEditedAt?: number;
  prepError?: string;
  /** The memory saved with "Save to memory" (POST /api/meetings/:id/memory). */
  memoryId?: string;
}

/**
 * POST /api/meetings/:id/chat: the meeting's context in a chat. No sessionId
 * starts a new one: a Chat-mode chat, or with to 'code' a session in the
 * meeting's device and folder. A sessionId adds it to that chat.
 */
export interface MeetingChatInput {
  to?: 'chat' | 'code';
  sessionId?: string;
}

/** Scheduling and steering fields shared by create and patch. */
export interface ScheduleFields {
  scheduledAt?: number;
  /** null clears it (JSON drops undefined) */
  durationMin?: number | null;
  tz?: string;
  /** '' clears it */
  steering?: string;
  steeringPreset?: string;
  answerLength?: AnswerLength;
  /** null unlinks the event */
  calendarEventId?: string | null;
  calendarId?: string | null;
  reminders?: number[];
  autoPrep?: boolean;
}

export interface CreateMeetingInput extends ScheduleFields {
  sessionId?: string; // take device + cwd + projectId from this session
  projectId?: string;
  device?: string;
  cwd?: string;
  title?: string; // default: "Meeting <project> <HH:MM>"
  agenda?: string; // at most 4000 chars
}

export interface Segment {
  seq: number; // per meeting and channel, from 0, no gaps on the desktop side
  channel: Channel;
  startMs: number; // from t0 of this audio stream
  endMs: number;
  text: string; // at most 2000 chars
  final: boolean; // false: a partial, replaced by a later one with the same seq
}

export interface SegmentBatch {
  clientId: string; // the desktop app's paired client id
  t0: number; // desktop clock at stream start, for display only
  segments: Segment[]; // 1 to 32
}

/** lastSeq: the highest final seq stored per channel, -1 when none yet. */
export interface SegmentAck {
  accepted: number;
  lastSeq: Record<Channel, number>;
}

export interface AnswerNowInput {
  reason: 'hotkey' | 'button';
  question?: string;
}

export interface MeetingAnswer {
  id: string; // "ans_..."
  meetingId: string;
  messageId: string; // assistant message in the meeting session; text streams as message.delta
  trigger: 'question' | 'answer-now' | 'speculative';
  question: string; // the "them" text it answers, or "" for answer-now without one
  state: 'streaming' | 'done' | 'cancelled' | 'failed';
  createdAt: number;
  firstTokenAt?: number;
  error?: string;
}

export interface MeetingDetail extends Meeting {
  segments: Segment[]; // final ones, oldest first, at most 2000 (page with ?before=)
  answers: MeetingAnswer[];
}

export interface MeetingNotes {
  summary: string;
  decisions: string[];
  actionItems: { who: 'me' | string; what: string; due?: string; taskId?: string }[];
  openQuestions: string[];
  markdown: string; // what was written to notesPath
}

export interface MeetingPatch extends ScheduleFields {
  title?: string;
  agenda?: string;
  autoAnswer?: Meeting['autoAnswer'];
  status?: 'live' | 'paused';
}

/** Desktop IPC (3.3): what Rust reports to the overlay. */
export interface DesktopMeetingStatus {
  meetingId?: string;
  live: boolean;
  paused: boolean;
  clickThrough: boolean;
  hiddenForShare: boolean; // 7.4 hid it
  exclusion: 'excluded' | 'monitor-only' | 'unsupported' | 'failed'; // what the OS confirmed (7.2/7.3)
  mic: { ok: boolean; device?: string; error?: string };
  system: { ok: boolean; device?: string; error?: string };
  stt: { state: 'loading' | 'downloading' | 'ready' | 'failed'; progress?: number; error?: string };
  queue: { stt: number; upload: number; dropped: number };
}

/** WebSocket events (3.2), part of the engine event union in types.ts. */
export type MeetingEvent =
  | { type: 'meeting.updated'; sessionId: string; meeting: Meeting }
  | { type: 'meeting.prep'; sessionId: string; meetingId: string; state: PrepState; progress?: PrepProgress }
  | { type: 'meeting.due'; sessionId: string; meetingId: string }
  | { type: 'meeting.segment'; sessionId: string; meetingId: string; segment: Segment }
  | { type: 'meeting.answer'; sessionId: string; meetingId: string; answer: MeetingAnswer }
  | { type: 'meeting.notes'; sessionId: string; meetingId: string; notes: MeetingNotes };

// ----- limits (3.1) -----
export const AGENDA_MAX = 4000;
export const SEGMENT_TEXT_MAX = 2000;
export const BATCH_SEGMENTS_MAX = 32;
export const BATCH_BODY_MAX = 64 * 1024;
export const BATCHES_PER_SECOND_MAX = 20;
export const TITLE_MAX = 200;
export const STEERING_MAX = 4000;
export const PREP_MAX = 60_000;
export const PREP_EXTRA_MAX = 200;
export const REMINDER_CHOICES = [1440, 60, 15] as const;
export const DEFAULT_REMINDERS = [1440, 15];

/** A device and folder pair the account has worked in (11.3.1). */
export interface MeetingFolder {
  device: string;
  deviceName: string;
  online: boolean;
  cwd: string;
  projectId?: string;
  projectName?: string;
  chats: number; // sessions on this folder or below it
  lastAt: number; // newest session updatedAt
}

/** The prep job's progress (11.4.3). */
export interface PrepProgress {
  phase: 'inventory' | 'waiting-approval' | 'map' | 'merge' | 'reduce' | 'done';
  done: number;
  total: number;
  startedAt: number;
  leftOut: number;
  /** Median model call time so far, for "about 6 min left". */
  medianMs?: number;
  /** phase waiting-approval: what the run would read; usd is left out when the price is unknown. */
  estimate?: { tokens: number; sessions: number; model: string; usd?: number };
}

export interface PrepSources {
  sessions: number;
  chunks: number;
  workflows: number;
  commits: number;
  files: number;
  tokensIn: number;
  tokensOut: number;
  leftOut: string[];
}

/** GET /api/meetings/:id/prep. */
export interface PrepView {
  state: PrepState;
  progress?: PrepProgress;
  draft?: string;
  edited?: string;
  at?: number;
  editedAt?: number;
  sources?: PrepSources;
  error?: string;
  /** Set while the job waits for the owner's OK (over 500k tokens). */
  estimate?: { tokens: number; sessions: number; model: string; usd?: number };
  extra?: string[];
}

/** Steering presets (11.3.3): the web and Android show the same text. */
export const STEERING_PRESETS: ReadonlyArray<{ id: string; label: string; text: string }> = [
  {
    id: 'defence',
    label: 'Defence / viva',
    text: `Panel members are examiners testing whether I did and understand the work.
- Lead with the claim, then the evidence that backs it: the number, the experiment, the file or commit.
- Confident, not defensive. Admit a limitation in one sentence, then say what I did about it or would do next.
- Never overstate a result. If a result is preliminary, say "preliminary".
- Stress: methodology, why I chose it over alternatives, and how I validated it.
- Avoid: jargon the panel did not use first, apologising, and "I think" before facts.`,
  },
  {
    id: 'status',
    label: 'Status update',
    text: `- What changed since last time, what is blocked, what I need from them. In that order.
- Numbers and dates over adjectives. Name owners of blocked items when the context has them.
- Avoid: implementation detail unless asked.`,
  },
  {
    id: 'interview',
    label: 'Interview',
    text: `- Answer with a short situation, what I did, and the result with a number when there is one.
- Tie answers to the role when the purpose names it. Keep each answer under 30 seconds spoken.
- Avoid: talking down former teams, and claims the context cannot back.`,
  },
  {
    id: 'demo',
    label: 'Demo',
    text: `- Say what the audience is looking at, then why it matters to them.
- If something breaks, give a one-line recovery and move to the next step of the presenting order.
- Avoid: reading code aloud; point to the file instead.`,
  },
];

/** Why a SegmentBatch is malformed or over the limits, or undefined when it is fine. */
export function segmentBatchProblem(v: unknown): string | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'body must be an object';
  const b = v as Record<string, unknown>;
  if (typeof b.clientId !== 'string' || !b.clientId || b.clientId.length > 200) return 'clientId is required';
  if (typeof b.t0 !== 'number' || !Number.isFinite(b.t0)) return 't0 must be a number';
  if (!Array.isArray(b.segments) || b.segments.length < 1 || b.segments.length > BATCH_SEGMENTS_MAX) return `segments must hold 1 to ${BATCH_SEGMENTS_MAX} items`;
  for (let i = 0; i < b.segments.length; i++) {
    const s = b.segments[i] as Record<string, unknown> | null;
    const at = `segments[${i}]`;
    if (!s || typeof s !== 'object') return `${at} must be an object`;
    if (!Number.isSafeInteger(s.seq) || (s.seq as number) < 0) return `${at}.seq must be a whole number from 0`;
    if (s.channel !== 'me' && s.channel !== 'them') return `${at}.channel must be me or them`;
    if (typeof s.startMs !== 'number' || typeof s.endMs !== 'number' || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.startMs < 0 || s.endMs < s.startMs) return `${at}: startMs and endMs must be numbers with startMs <= endMs`;
    if (typeof s.text !== 'string') return `${at}.text must be a string`;
    if (s.text.length > SEGMENT_TEXT_MAX) return `${at}.text is over ${SEGMENT_TEXT_MAX} characters`;
    if (typeof s.final !== 'boolean') return `${at}.final must be true or false`;
  }
  return undefined;
}
