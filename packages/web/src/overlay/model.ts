/**
 * What the overlay and the meeting page show of one meeting, built from the
 * detail (GET /api/meetings/:id), the session's messages and the events of
 * docs/design/MEETING-MODE.md 3.2. Plain mutable state: the overlay applies
 * a frame's events in one go and renders once (frame.ts).
 */
import type { Channel, Meeting, MeetingAnswer, MeetingDetail, MeetingEvent, MeetingNotes, Segment } from './wire';

/** Final lines kept in memory; the overlay shows 6, the meeting page loads its own. */
const KEEP_FINALS = 400;

export interface Line extends Segment {
  /** Arrival order, to merge the two channels. */
  at: number;
}

export interface MeetingView {
  meeting?: Meeting;
  finals: Line[];
  partials: Map<string, Line>;
  answers: MeetingAnswer[];
  /** Message text by id: the brief and each answer. */
  text: Record<string, string>;
  notes?: MeetingNotes;
  /** Bumped on every change, for useSyncExternalStore. */
  version: number;
  order: number;
}

export function emptyView(): MeetingView {
  return { finals: [], partials: new Map(), answers: [], text: {}, version: 0, order: 0 };
}

const key = (channel: Channel, seq: number) => `${channel}:${seq}`;

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

export function loadDetail(v: MeetingView, d: MeetingDetail, messages: { id: string; content: { type: string; text?: string }[] }[] = []): void {
  const { segments, answers, ...meeting } = d;
  v.meeting = meeting;
  v.finals = [];
  v.partials.clear();
  for (const s of segments) if (s.final) v.finals.push({ ...s, at: v.order++ });
  v.finals = v.finals.slice(-KEEP_FINALS);
  v.answers = [...answers].sort((a, b) => a.createdAt - b.createdAt);
  for (const m of messages) v.text[m.id] = textOf(m.content);
  v.version++;
}

function addSegment(v: MeetingView, s: Segment): void {
  const k = key(s.channel, s.seq);
  if (!s.final) {
    // a partial after its final is late: the final wins
    if (v.finals.some((f) => f.channel === s.channel && f.seq === s.seq)) return;
    const was = v.partials.get(k);
    v.partials.set(k, { ...s, at: was?.at ?? v.order++ });
    return;
  }
  // a final closes its partial and any older one of its channel
  for (const [pk, p] of v.partials) if (p.channel === s.channel && p.seq <= s.seq) v.partials.delete(pk);
  if (v.finals.some((f) => f.channel === s.channel && f.seq === s.seq)) return;
  v.finals.push({ ...s, at: v.order++ });
  if (v.finals.length > KEEP_FINALS) v.finals.splice(0, v.finals.length - KEEP_FINALS);
}

function addAnswer(v: MeetingView, a: MeetingAnswer): void {
  const i = v.answers.findIndex((x) => x.id === a.id);
  if (i >= 0) v.answers[i] = a;
  else {
    v.answers.push(a);
    v.answers.sort((x, y) => x.createdAt - y.createdAt);
  }
}

/** Apply one event. Returns true when it changed what is shown. Events of other meetings or sessions are ignored. */
export function applyEvent(v: MeetingView, e: MeetingEvent): boolean {
  const m = v.meeting;
  if (!m) return false;
  switch (e.type) {
    case 'meeting.updated':
      if (e.meeting.id !== m.id) return false;
      v.meeting = e.meeting;
      break;
    case 'meeting.segment':
      if (e.meetingId !== m.id) return false;
      addSegment(v, e.segment);
      break;
    case 'meeting.answer':
      if (e.meetingId !== m.id) return false;
      addAnswer(v, e.answer);
      break;
    case 'meeting.notes':
      if (e.meetingId !== m.id) return false;
      v.notes = e.notes;
      break;
    case 'message.delta':
      if (e.sessionId !== m.sessionId || e.kind !== 'text') return false;
      v.text[e.messageId] = (v.text[e.messageId] ?? '') + e.text;
      break;
    case 'message.created':
    case 'message.updated':
      if (e.message.sessionId !== m.sessionId) return false;
      v.text[e.message.id] = textOf(e.message.content);
      break;
    default:
      return false;
  }
  v.version++;
  return true;
}

/** The last n lines of both channels: finals, then the partials still open, in arrival order. */
export function lastLines(v: MeetingView, n = 6): Line[] {
  const open = [...v.partials.values()];
  return [...v.finals.slice(-n), ...open].sort((a, b) => a.at - b.at).slice(-n);
}

/** The answer on top, and the earlier ones newest first (at most `keep`). */
export function answerStack(v: MeetingView, keep = 5): { current?: MeetingAnswer; previous: MeetingAnswer[] } {
  const all = v.answers;
  const current = all[all.length - 1];
  return { current, previous: all.slice(0, -1).reverse().slice(0, keep) };
}

export interface ParsedAnswer {
  bullets: string[];
  source?: string;
  /** Text that did not fit the format, shown as it is. */
  rest: string;
}

/**
 * The live prompt's format (MEETING-MODE.md 5): "Say this:", 1 to 4 "- "
 * bullets, then "Source: ...". Works on a half streamed answer: a bullet
 * still being written shows as the last bullet.
 */
export function parseAnswer(text: string): ParsedAnswer {
  const bullets: string[] = [];
  const rest: string[] = [];
  let source: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /^say this:?$/i.test(line)) continue;
    const src = /^source:\s*(.*)$/i.exec(line);
    if (src) source = src[1];
    else if (/^[-*•]\s*/.test(line)) bullets.push(line.replace(/^[-*•]\s*/, ''));
    else if (bullets.length && source === undefined) bullets[bullets.length - 1] += ` ${line}`;
    else rest.push(line);
  }
  return { bullets, source, rest: rest.join(' ') };
}
