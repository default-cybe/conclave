/**
 * Meeting mode wire types (docs/design/MEETING-MODE.md 3), as the web app
 * sees them: the hub's own file (core/src/meeting/wire.ts, pure, no imports)
 * plus the message events the overlay reads.
 * The scheduled-meeting types of 11.6 (Meeting, PrepView, MeetingFolder...)
 * come from the hub's file too.
 */
import type { MeetingEvent as HubMeetingEvent } from '@conclave/core/meeting/wire';

export type * from '@conclave/core/meeting/wire';

/** One of REMINDER_CHOICES. */
export type ReminderMin = 1440 | 60 | 15;

/** 11.3.2: event text is untrusted data, shown and never sent into a prompt. */
export interface MeetingCalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: number;
  end: number;
  location?: string;
}

export interface SteeringPreset {
  id: string;
  label: string;
  text: string;
}

/** GET /api/meetings?view= */
export type MeetingListView = 'upcoming' | 'now' | 'past' | 'all';

/** config meetings.stt: where speech becomes text. Keys are the hub secrets stt.assemblyai and stt.deepgram. */
export type SttProvider = 'local' | 'assemblyai' | 'deepgram';

/** GET /api/meetings/models: one model the answers can come from, for the picker. */
export interface AnswerModelChoice {
  ref: string;
  label: string;
  speed: 'fastest' | 'fast' | 'balanced' | 'best';
  note?: string;
}

/** A file attached to one meeting (POST /api/meetings/:id/files). */
export interface MeetingFile {
  id: string;
  name: string;
  size: number;
  mediaType?: string;
  addedAt?: number;
}

/** POST /api/meetings/stt-test: one short call to the provider on the saved key. */
export interface SttTestResult {
  ok: boolean;
  message: string;
  ms?: number;
}

/*
 * Fields the speed work adds to the hub's types (the hub and desktop tracks
 * add them to core/src/meeting/wire.ts); optional here, so either side can
 * land first.
 */
declare module '@conclave/core/meeting/wire' {
  interface Meeting {
    /** A model ref; null or missing: the hub default (models.tiers.fast, else the fastest usable). */
    answerModel?: string | null;
    files?: MeetingFile[];
  }
  interface MeetingAnswer {
    /** Hub time the question's speech ended (its segment's end). */
    speechEndAt?: number;
    doneAt?: number;
    /** The model ref that answered. */
    model?: string;
  }
  interface DesktopMeetingStatus {
    /** Which speech-to-text runs now, and why it fell back to local when it did. */
    sttProvider?: SttProvider;
    sttFallback?: string;
  }
  interface ScheduleFields {
    answerModel?: string | null;
  }
}

/** 3.2 and 11.6: the meeting events on /api/ws, plus the existing message events the overlay reads. */
export type MeetingEvent =
  | HubMeetingEvent
  | { type: 'message.delta'; sessionId: string; messageId: string; index: number; kind: 'text' | 'thinking' | 'tool_input'; text: string }
  | { type: 'message.created' | 'message.updated'; message: { id: string; sessionId: string; content: { type: string; text?: string }[] } };
