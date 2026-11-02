/**
 * Meeting mode wire types (docs/design/MEETING-MODE.md 3), as the web app
 * sees them: the hub's own file (core/src/meeting/wire.ts, pure, no imports)
 * plus the message events the overlay reads.
 * The scheduled-meeting types of 11.6 (Meeting, PrepView, MeetingFolder...)
 * come from the hub's file too.
 */
import type { MeetingAnswer as HubMeetingAnswer, MeetingEvent as HubMeetingEvent, MeetingModelOption, SttChoice } from '@conclave/core/meeting/wire';

export type * from '@conclave/core/meeting/wire';

/**
 * The hub's answer plus the step times a hub with speech-end timing sends,
 * all on the hub clock: speechEndAt (the trigger's speech ended, desktop
 * clock converted), finalAt (its final transcript), paintedAt (the overlay
 * showed its first words, POST .../paint). Older hubs leave them out.
 */
export interface MeetingAnswer extends HubMeetingAnswer {
  speechEndAt?: number;
  finalAt?: number;
  paintedAt?: number;
}

/** POST /api/meetings/:id/answers/:answerId/paint, desktop clock: sentAt lets the hub convert paintedAt as it does segment times. */
export interface AnswerPaint {
  paintedAt: number;
  sentAt: number;
}

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
export type SttProvider = SttChoice;

/** GET /api/meetings/models: one model the answers can come from, for the picker. */
export type AnswerModelChoice = MeetingModelOption;

/** 3.2 and 11.6: the meeting events on /api/ws, plus the existing message events the overlay reads. */
export type MeetingEvent =
  | HubMeetingEvent
  | { type: 'message.delta'; sessionId: string; messageId: string; index: number; kind: 'text' | 'thinking' | 'tool_input'; text: string }
  | { type: 'message.created' | 'message.updated'; message: { id: string; sessionId: string; content: { type: string; text?: string }[] } };
