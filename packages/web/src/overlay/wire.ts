/**
 * Meeting mode wire types (docs/design/MEETING-MODE.md 3), as the web app
 * sees them.
 *
 * shortcut: a copy of section 3 because packages/core/src/meeting/wire.ts
 * (Track B) has not landed on this branch; once it does, replace the
 * declarations below with `export type * from '@conclave/core/meeting/wire'`
 * and keep only DesktopMeetingStatus and MeetingEvent if core lacks them.
 * Types and the consent note (8) only.
 */

export type MeetingStatus = 'preparing' | 'ready' | 'live' | 'paused' | 'ending' | 'ended' | 'failed';
export type Channel = 'me' | 'them';

export interface Meeting {
  id: string;
  accountId: string;
  sessionId: string;
  projectId?: string;
  device: string;
  cwd: string;
  title: string;
  agenda?: string;
  status: MeetingStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  audioClientId?: string;
  briefMessageId?: string;
  notesPath?: string;
  autoAnswer: 'questions' | 'off';
  error?: string;
}

export interface CreateMeetingInput {
  sessionId?: string;
  projectId?: string;
  device?: string;
  cwd?: string;
  title?: string;
  agenda?: string;
}

export interface Segment {
  seq: number;
  channel: Channel;
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
}

export interface SegmentBatch {
  clientId: string;
  t0: number;
  segments: Segment[];
}

export interface SegmentAck {
  accepted: number;
  lastSeq: Record<Channel, number>;
}

export interface AnswerNowInput {
  reason: 'hotkey' | 'button';
  question?: string;
}

export interface MeetingAnswer {
  id: string;
  meetingId: string;
  messageId: string;
  trigger: 'question' | 'answer-now' | 'speculative';
  question: string;
  state: 'streaming' | 'done' | 'cancelled' | 'failed';
  createdAt: number;
  firstTokenAt?: number;
  error?: string;
}

export interface MeetingDetail extends Meeting {
  segments: Segment[];
  answers: MeetingAnswer[];
}

export interface MeetingNotes {
  summary: string;
  decisions: string[];
  actionItems: { who: 'me' | string; what: string; due?: string; taskId?: string }[];
  openQuestions: string[];
  markdown: string;
}

/** 3.3: what Rust reports to the overlay (meeting_status, meeting://status). */
export interface DesktopMeetingStatus {
  meetingId?: string;
  live: boolean;
  paused: boolean;
  clickThrough: boolean;
  hiddenForShare: boolean;
  exclusion: 'excluded' | 'monitor-only' | 'unsupported' | 'failed';
  mic: { ok: boolean; device?: string; error?: string };
  system: { ok: boolean; device?: string; error?: string };
  stt: { state: 'loading' | 'downloading' | 'ready' | 'failed'; progress?: number; error?: string };
  queue: { stt: number; upload: number; dropped: number };
}

/** 3.2: the meeting events on /api/ws, plus the existing message events the overlay reads. */
export type MeetingEvent =
  | { type: 'meeting.updated'; sessionId: string; meeting: Meeting }
  | { type: 'meeting.segment'; sessionId: string; meetingId: string; segment: Segment }
  | { type: 'meeting.answer'; sessionId: string; meetingId: string; answer: MeetingAnswer }
  | { type: 'meeting.notes'; sessionId: string; meetingId: string; notes: MeetingNotes }
  | { type: 'message.delta'; sessionId: string; messageId: string; index: number; kind: 'text' | 'thinking' | 'tool_input'; text: string }
  | { type: 'message.created' | 'message.updated'; message: { id: string; sessionId: string; content: { type: string; text?: string }[] } };

export const CONSENT_NOTE = 'Heads up: I use a private note-taker that transcribes this call on my computer. No audio is saved. Tell me if you would rather I turn it off.';
