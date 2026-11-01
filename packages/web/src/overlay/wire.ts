/**
 * Meeting mode wire types (docs/design/MEETING-MODE.md 3), as the web app
 * sees them: the hub's own file (core/src/meeting/wire.ts, pure, no imports)
 * plus the message events the overlay reads and the consent note (8).
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

/** 3.2 and 11.6: the meeting events on /api/ws, plus the existing message events the overlay reads. */
export type MeetingEvent =
  | HubMeetingEvent
  | { type: 'message.delta'; sessionId: string; messageId: string; index: number; kind: 'text' | 'thinking' | 'tool_input'; text: string }
  | { type: 'message.created' | 'message.updated'; message: { id: string; sessionId: string; content: { type: string; text?: string }[] } };

export const CONSENT_NOTE = 'Heads up: I use a private note-taker that transcribes this call on my computer. No audio is saved. Tell me if you would rather I turn it off.';
