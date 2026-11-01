/**
 * Meeting mode wire types (docs/design/MEETING-MODE.md 3), as the web app
 * sees them: the hub's own file (core/src/meeting/wire.ts, pure, no imports)
 * plus the message events the overlay reads and the consent note (8).
 *
 * The scheduled-meeting fields of 11.6 are declared here too, until Track B's
 * wire.ts carries them. Local declarations win over the star re-export, and
 * they match 11.6 field for field, so the hub's types stay assignable.
 */
import type { Meeting as HubMeeting, MeetingDetail as HubMeetingDetail, MeetingEvent as HubMeetingEvent, MeetingPatch as HubMeetingPatch, CreateMeetingInput as HubCreateMeetingInput } from '@conclave/core/meeting/wire';

export type * from '@conclave/core/meeting/wire';

/** 11.5: 'scheduled' is new. */
export type MeetingStatus = 'scheduled' | 'preparing' | 'ready' | 'live' | 'paused' | 'ending' | 'ended' | 'failed';
export type PrepState = 'none' | 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type AnswerLength = 'short' | 'long';
export type ReminderMin = 1440 | 60 | 15;

/** 11.4.3 */
export interface PrepProgress {
  phase: 'inventory' | 'waiting-approval' | 'map' | 'merge' | 'reduce' | 'done';
  done: number;
  total: number;
  startedAt: number;
  leftOut?: number;
  /** median call time in ms, for "about 6 min left" */
  medianMs?: number;
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

/** The fields 11.6 adds to a meeting row. All optional: 0.4.51 rows have none. */
export interface ScheduleFields {
  scheduledAt?: number;
  durationMin?: number;
  tz?: string;
  steering?: string;
  steeringPreset?: string;
  answerLength?: AnswerLength;
  calendarEventId?: string;
  calendarId?: string;
  reminders?: ReminderMin[];
  autoPrep?: boolean;
  prepState?: PrepState;
  prepProgress?: PrepProgress;
  prepAt?: number;
  prepEditedAt?: number;
  prepError?: string;
  prepSources?: PrepSources;
}

export interface Meeting extends Omit<HubMeeting, 'status'>, ScheduleFields {
  status: MeetingStatus;
}
export interface MeetingDetail extends Omit<HubMeetingDetail, 'status'>, ScheduleFields {
  status: MeetingStatus;
}

type ScheduleInput = Pick<ScheduleFields, 'scheduledAt' | 'durationMin' | 'tz' | 'steering' | 'steeringPreset' | 'answerLength' | 'calendarEventId' | 'calendarId' | 'reminders' | 'autoPrep'>;
export interface CreateMeetingInput extends HubCreateMeetingInput, ScheduleInput {}
export interface MeetingPatch extends HubMeetingPatch, ScheduleInput {}

/** 11.3.1 */
export interface MeetingFolder {
  device: string;
  deviceName: string;
  online: boolean;
  cwd: string;
  projectId?: string;
  projectName?: string;
  chats: number;
  lastAt: number;
}

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

/** GET /api/meetings/:id/prep (11.6) */
export interface PrepView {
  state: PrepState;
  progress?: PrepProgress;
  draft?: string;
  edited?: string;
  at?: number;
  editedAt?: number;
  sources?: PrepSources;
  error?: string;
  /** the 500k approval pause (11.4.2): what continuing costs */
  estimate?: { tokens: number; chats: number; model: string; usd?: number };
  /** the ticked claude.ai and ChatGPT chats (prep_extra), so the ticks survive a reload */
  extra?: string[];
}

/** GET /api/meetings?view= */
export type MeetingListView = 'upcoming' | 'now' | 'past' | 'all';

/** 3.2 and 11.6: the meeting events on /api/ws, plus the existing message events the overlay reads. */
export type MeetingEvent =
  | HubMeetingEvent
  | { type: 'meeting.prep'; sessionId: string; meetingId: string; state: PrepState; progress?: PrepProgress }
  | { type: 'meeting.due'; sessionId: string; meetingId: string }
  | { type: 'message.delta'; sessionId: string; messageId: string; index: number; kind: 'text' | 'thinking' | 'tool_input'; text: string }
  | { type: 'message.created' | 'message.updated'; message: { id: string; sessionId: string; content: { type: string; text?: string }[] } };

export const CONSENT_NOTE = 'Heads up: I use a private note-taker that transcribes this call on my computer. No audio is saved. Tell me if you would rather I turn it off.';
