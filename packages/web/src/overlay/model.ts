/**
 * What the overlay and the meeting page show of one meeting, built from the
 * detail (GET /api/meetings/:id), the session's messages and the events of
 * docs/design/MEETING-MODE.md 3.2. Plain mutable state: the overlay applies
 * a frame's events in one go and renders once (frame.ts).
 */
import type { Channel, Meeting, MeetingAnswer, MeetingDetail, MeetingEvent, MeetingFile, MeetingNotes, Segment } from './wire';

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
  /** From the detail only: meeting.updated carries a plain Meeting without them. */
  files: MeetingFile[];
  liveModel?: MeetingDetail['liveModel'];
  /** Message text by id: the brief and each answer. */
  text: Record<string, string>;
  notes?: MeetingNotes;
  /** Bumped on every change, for useSyncExternalStore. */
  version: number;
  order: number;
}

export function emptyView(): MeetingView {
  return { finals: [], partials: new Map(), answers: [], files: [], text: {}, version: 0, order: 0 };
}

const key = (channel: Channel, seq: number) => `${channel}:${seq}`;

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

export function loadDetail(v: MeetingView, d: MeetingDetail, messages: { id: string; content: { type: string; text?: string }[] }[] = []): void {
  const { segments, answers, files, liveModel, ...meeting } = d;
  v.meeting = meeting;
  v.files = files ?? [];
  v.liveModel = liveModel;
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

const BULLET = /^\s*[-*•+]\s+/;
/** A line that starts a markdown block, so it does not continue the bullet above it. */
const BLOCK = /^\s*(```|~~~|\||#|>|\d+[.)]\s)/;
/** A line still being written that may yet turn into "Say this:", "Source:", a bullet or a block: held back until it is clear. */
const UNDECIDED = (line: string) => (line.length > 0 && line.length < 9 && ['say this:', 'source:'].some((w) => w.startsWith(line.toLowerCase()))) || /^([-*•+]|`{1,2}|~{1,2}|\d+[.)]?)$/.test(line);

/**
 * The answer as two markdown texts: `say`, the "Say this" bullets (read
 * aloud, shown large), and `rest`, everything after them (details, code,
 * tables, charts), without the Source line. While it streams, each text only
 * grows (a later call returns a continuation of the earlier one), so the
 * renderer parses only the new slice.
 */
export function splitAnswer(text: string, done = false): { say: string; rest: string; source?: string } {
  const lines = text.split('\n');
  const tail = done ? undefined : lines.pop();
  const say: string[] = [];
  const rest: string[] = [];
  let source: string | undefined;
  let phase: 'head' | 'say' | 'rest' = 'head';
  let afterBullet = false;
  let fence = false;
  const take = (raw: string, partial: boolean) => {
    const line = raw.trim();
    // inside a code fence every line is code, "source: x" in YAML too
    if (fence) {
      if (!partial && /^(```|~~~)/.test(line)) fence = false;
      return void rest.push(raw);
    }
    if (!partial && /^(```|~~~)/.test(line)) fence = true;
    const src = /^source:\s*(.*)$/i.exec(line);
    if (src) return void (source = src[1]);
    if (partial && UNDECIDED(line)) return;
    if (phase !== 'rest') {
      if (!line || /^say this:?$/i.test(line)) return void (afterBullet = false);
      if (BULLET.test(raw)) {
        phase = 'say';
        afterBullet = true;
        return void say.push(`- ${raw.replace(BULLET, '')}`);
      }
      if (phase === 'say' && afterBullet && !BLOCK.test(raw)) return void (say[say.length - 1] += ` ${line}`);
      phase = 'rest';
    }
    rest.push(raw);
  };
  for (const l of lines) take(l, false);
  // an empty last line is only a newline so far: held back too, so rest never ends in a newline it may take back
  if (tail) take(tail, true);
  return { say: say.join('\n'), rest: rest.join('\n'), source };
}

/** Speech end (or the answer's start, for Answer now) to the first word on screen, or to the first token before the overlay reports a paint; in ms, undefined until a word came. */
export function answerLatency(a: Pick<MeetingAnswer, 'createdAt' | 'firstTokenAt' | 'segmentEndAt' | 'speechEndAt' | 'paintedAt'>): number | undefined {
  if (a.paintedAt !== undefined && a.speechEndAt !== undefined) return Math.max(0, a.paintedAt - a.speechEndAt);
  if (a.firstTokenAt === undefined) return undefined;
  return Math.max(0, a.firstTokenAt - (a.segmentEndAt ?? a.createdAt));
}

/** One answer's steps on the hub clock, ms after its speech ended (or after the ask for Answer now); a step the hub did not record is left out. */
export function stepTimes(a: MeetingAnswer): { step: string; ms: number }[] {
  const zero = a.speechEndAt ?? a.segmentEndAt ?? a.createdAt;
  const steps: [string, number | undefined][] = [
    ['final', a.finalAt],
    ['hub', a.receivedAt],
    ['request', a.requestAt],
    ['first token', a.firstTokenAt],
    ['painted', a.paintedAt],
  ];
  return steps.flatMap(([step, at]) => (at === undefined ? [] : [{ step, ms: Math.max(0, at - zero) }]));
}

/** Speech end to first paint over the answers that have both: p50 and p95 by nearest rank, and n. */
export function latencyStats(answers: MeetingAnswer[]): { p50: number; p95: number; n: number } | undefined {
  const ms = answers.flatMap((a) => (a.paintedAt !== undefined && a.speechEndAt !== undefined ? [Math.max(0, a.paintedAt - a.speechEndAt)] : [])).sort((x, y) => x - y);
  if (!ms.length) return undefined;
  const rank = (p: number) => ms[Math.max(0, Math.ceil(p * ms.length) - 1)]!;
  return { p50: rank(0.5), p95: rank(0.95), n: ms.length };
}

/** "0.8 s", "12 s". */
export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** The newest answer that has a first word: the overlay's latency readout. */
export function lastLatency(answers: MeetingAnswer[]): number | undefined {
  for (let i = answers.length - 1; i >= 0; i--) {
    const ms = answerLatency(answers[i]!);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

/**
 * Which answer the card shows (cheating-daddy's response index, see Live.tsx):
 * `pinned` is the id the owner stepped to, undefined for the newest.
 */
export function shownIndex(answers: { id: string }[], pinned?: string): number {
  const i = pinned ? answers.findIndex((a) => a.id === pinned) : -1;
  return i >= 0 ? i : answers.length - 1;
}

/** One step back (-1) or forward (+1), stopping at the ends; back at the newest it unpins. */
export function stepAnswer(answers: { id: string }[], pinned: string | undefined, dir: -1 | 1): string | undefined {
  const i = Math.min(answers.length - 1, Math.max(0, shownIndex(answers, pinned) + dir));
  return i >= answers.length - 1 ? undefined : answers[i]?.id;
}
