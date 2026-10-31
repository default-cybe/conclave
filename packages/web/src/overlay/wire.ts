/**
 * Meeting mode wire types (docs/design/MEETING-MODE.md 3), as the web app
 * sees them: the hub's own file (core/src/meeting/wire.ts, pure, no imports)
 * plus the message events the overlay reads and the consent note (8).
 */
import type { MeetingEvent as HubMeetingEvent } from '@conclave/core/meeting/wire';

export type * from '@conclave/core/meeting/wire';

/** 3.2: the meeting events on /api/ws, plus the existing message events the overlay reads. */
export type MeetingEvent =
  | HubMeetingEvent
  | { type: 'message.delta'; sessionId: string; messageId: string; index: number; kind: 'text' | 'thinking' | 'tool_input'; text: string }
  | { type: 'message.created' | 'message.updated'; message: { id: string; sessionId: string; content: { type: string; text?: string }[] } };

export const CONSENT_NOTE = 'Heads up: I use a private note-taker that transcribes this call on my computer. No audio is saved. Tell me if you would rather I turn it off.';
