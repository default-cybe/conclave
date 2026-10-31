/**
 * Which pieces of a transcript are mounted (MessageList). A long session
 * opened all at once styled and laid out every turn before the first paint
 * (about 10s for 300 turns). Now a session opens with its latest pieces,
 * enough for two screens, and paints at once; older pieces mount in chunks
 * as the reader scrolls up, and in idle time, until the whole transcript is
 * there and find in page covers all of it. A link to a message mounts a few
 * pieces around it, lands on it, then fills toward the end.
 *
 * Pure, so the rules are tested (test/transcript-window.test.ts).
 */
import type { Message } from '@conclave/core/types';
import type { Unit } from './MessageList';

export const WINDOW = {
  /**
   * Pieces mounted when a session opens, before filling to two screens.
   * Measured on the 300 turn mock (about 2,000px a turn): 4 pieces painted
   * 0.34s after the click, 12 0.52s, 24 0.69s, 48 1.07s, all of it 10s.
   * Short turns fill up to two screens from here.
   */
  first: 6,
  /** Pieces above a linked message. */
  before: 3,
  /** Pieces below a linked message. */
  after: 4,
  /** Pieces mounted per step, when the reader nears an edge and in idle time. */
  chunk: 8,
  /** Screens of content a session opens with (and around a linked message, one each way). */
  screens: 2,
  /** How close to the top or bottom of what is mounted, in screens, mounts the next chunk. */
  edge: 1.5,
};

export type WindowSize = typeof WINDOW;

/**
 * The mounted pieces: units[start, end). `end` null is through the last
 * piece, and pieces that arrive join it; a number leaves the newest pieces
 * out for now (after a link to an early message).
 */
export interface Span {
  start: number;
  end: number | null;
}

/** The message ids a piece shows. */
export function messageIds(u: Unit): string[] {
  switch (u.kind) {
    case 'turn':
      return u.messages.map((m) => m.id);
    case 'group':
      return [...u.members.map((m) => m.id), ...(u.verdict ? [u.verdict.id] : [])];
    default:
      return [u.message.id];
  }
}

/**
 * The piece that shows message `id`. A message without a piece of its own
 * (a tool result, a reminder) belongs to the piece before it in the
 * session's order. -1 when the session has no such message.
 */
export function unitIndexOf(units: readonly Unit[], messages: readonly Message[], id: string): number {
  const own = units.findIndex((u) => messageIds(u).includes(id));
  if (own >= 0) return own;
  const m = messages.find((x) => x.id === id);
  if (!m) return -1;
  const seqOf = new Map(messages.map((x) => [x.id, x.seq]));
  let best = -1;
  units.forEach((u, i) => {
    const first = Math.min(...messageIds(u).map((x) => seqOf.get(x) ?? Infinity));
    if (first <= m.seq) best = i;
  });
  return best;
}

/** What a session opens with: its latest pieces, or a few around the linked piece `target`. */
export function openSpan(count: number, target = -1, w: WindowSize = WINDOW): Span {
  if (target < 0 || target >= count - w.first) return { start: Math.max(0, count - w.first), end: null };
  const start = Math.max(0, target - w.before);
  const end = target + 1 + w.after;
  return { start, end: end >= count ? null : end };
}

/**
 * The pieces mounted now, as [from, to). A rewind that left fewer pieces
 * than the span starts at still mounts the latest `first` of them.
 */
export function mountedRange(span: Span, count: number, w: WindowSize = WINDOW): [number, number] {
  const to = span.end === null || span.end >= count ? count : span.end;
  const from = Math.max(0, Math.min(span.start, to - w.first));
  return [from, to];
}

/** A run of pieces rendered in one parent element: units[from, to). */
export interface Part {
  key: string;
  from: number;
  to: number;
}

/**
 * The parents the mounted pieces render in, top to bottom: one per chunk
 * above what the session opened with (`core`), that part, and one per chunk
 * below it. Putting an element into a parent restyles everything in that
 * parent (the app has rules like `.rows > * + *`), so every chunk gets a
 * parent of its own that is there, empty, before it mounts: mounting a chunk
 * restyles that chunk only, not every piece mounted so far. The last part
 * below takes what arrives after it. Before the session has opened
 * (`core` null) it is one part.
 */
export function partsOf(core: Span | null, from: number, to: number, count: number, chunk: number = WINDOW.chunk): Part[] {
  const cut = (key: string, a: number, b: number): Part => {
    const lo = Math.min(Math.max(a, from), to);
    return { key, from: lo, to: Math.max(lo, Math.min(b, to)) };
  };
  if (!core) return [{ key: 'mid', from, to }];
  const out: Part[] = [];
  for (let j = Math.ceil(core.start / chunk) - 1; j >= 0; j--) out.push(cut(`a${j}`, core.start - (j + 1) * chunk, core.start - j * chunk));
  out.push(cut('mid', core.start, core.end ?? Infinity));
  if (core.end !== null) {
    const k = Math.ceil((count - core.end) / chunk);
    for (let j = 0; j < k; j++) out.push(cut(`b${j}`, core.end + j * chunk, j === k - 1 ? Infinity : core.end + (j + 1) * chunk));
  }
  return out;
}

/** Every piece is mounted. */
export function isComplete(span: Span, count: number): boolean {
  return span.start <= 0 && (span.end === null || span.end >= count);
}

/** Mount `n` older pieces above. */
export function growUp(span: Span, n: number = WINDOW.chunk): Span {
  return span.start > 0 ? { ...span, start: Math.max(0, span.start - n) } : span;
}

/** Mount `n` newer pieces below; reaching the last piece joins the end. */
export function growDown(span: Span, count: number, n: number = WINDOW.chunk): Span {
  if (span.end === null) return span;
  const end = span.end + n;
  return { ...span, end: end >= count ? null : end };
}

export type Direction = 'up' | 'down';

/** Grow one step that way; the same span when there is nothing more to mount there. */
export function grow(span: Span, dir: Direction, count: number, n: number = WINDOW.chunk): Span {
  return dir === 'up' ? growUp(span, n) : growDown(span, count, n);
}

/** What idle time mounts next: toward the end first (the live line and what waits on you are there), then older pieces. */
export function idleDirection(span: Span, count: number): Direction | null {
  if (span.end !== null && span.end < count) return 'down';
  return span.start > 0 ? 'up' : null;
}

/** Where the reader is: the scroller's offsets, all in px. */
export interface Scroll {
  top: number;
  height: number;
  viewport: number;
}

/** Scrolled near the top or the bottom of what is mounted, with more to mount there. */
export function nearEdge(span: Span, count: number, s: Scroll, w: WindowSize = WINDOW): Direction | null {
  const margin = s.viewport * w.edge;
  if (span.start > 0 && s.top < margin) return 'up';
  if (span.end !== null && span.end < count && s.height - s.top - s.viewport < margin) return 'down';
  return null;
}

/**
 * After a scroll event: does the log keep following new content? Near the
 * bottom, unless the reader just moved up (`prev` is the offset at the last
 * scroll event). A trackpad moves a few px an event, so with the distance
 * alone each streamed chunk pulled the view back down before it got away.
 */
export function sticks(s: Scroll, prev: number, near = 120): boolean {
  const gap = s.height - s.top - s.viewport;
  if (gap <= 1) return true;
  return s.top >= prev - 0.5 && gap < near;
}

/**
 * While a session opens, before the first paint: grow until the latest
 * pieces fill two screens, or until a linked piece has a screen above and
 * below it to land in the middle.
 */
export function fillDirection(span: Span, count: number, m: { height: number; viewport: number; above?: number; below?: number }, w: WindowSize = WINDOW): Direction | null {
  if (m.above !== undefined && m.below !== undefined) {
    if (span.start > 0 && m.above < m.viewport) return 'up';
    if (span.end !== null && span.end < count && m.below < m.viewport) return 'down';
    return null;
  }
  return span.start > 0 && m.height < m.viewport * w.screens ? 'up' : null;
}
