/**
 * Which pieces of a long transcript are mounted (src/features/chat/window.ts,
 * used by MessageList). A session opens with its latest pieces, a link to a
 * message mounts a few around it, and the rest mount a chunk at a time as
 * the reader nears an edge and in idle time, until all of it is there. Each
 * chunk mounts into a part of its own that is there before it.
 *
 *   bun test packages/web/test/transcript-window.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { ContentBlock, Message, Session } from '@conclave/core/types';
import { buildUnits, type Unit } from '../src/features/chat/MessageList';
import { longSession } from '../src/mock/long';
import { WINDOW, fillDirection, grow, growDown, growUp, idleDirection, isComplete, mountedRange, nearEdge, openSpan, partsOf, unitIndexOf, type Span } from '../src/features/chat/window';

const W = { ...WINDOW, first: 6, before: 3, after: 4, chunk: 8 };

/** The 300 turn mock: 2,400 messages, 600 pieces (a prompt and a turn each). */
const long = longSession(300, 1_000_000_000_000);
const longUnits = buildUnits(long.messages, long.session);

function msg(seq: number, role: Message['role'], content: ContentBlock[], extra: Partial<Message> = {}): Message {
  return { id: `m${seq}`, sessionId: 's1', seq, role, kind: 'normal', content, createdAt: seq * 1000, model: role === 'assistant' ? 'anthropic/claude-sonnet-5-5' : undefined, ...extra };
}

/** Grow the way MessageList does once a session has opened: idle steps until every piece is mounted. */
function idleToEnd(span: Span, count: number): Span[] {
  const steps = [span];
  for (let dir = idleDirection(span, count); dir; dir = idleDirection(span, count)) {
    const next = grow(span, dir, count, W.chunk);
    expect(next).not.toBe(span);
    span = next;
    steps.push(span);
  }
  return steps;
}

describe('opening a session', () => {
  test('a long session mounts its latest pieces only, through the end', () => {
    expect(longUnits.length).toBe(600);
    const span = openSpan(longUnits.length, -1, W);
    expect(span).toEqual({ start: 594, end: null });
    expect(mountedRange(span, longUnits.length, W)).toEqual([594, 600]);
    expect(longUnits[mountedRange(span, 600, W)[1] - 1].key).toBe('m_long_2394');
  });

  test('a short session mounts all of it', () => {
    expect(openSpan(4, -1, W)).toEqual({ start: 0, end: null });
    expect(openSpan(0, -1, W)).toEqual({ start: 0, end: null });
    expect(isComplete(openSpan(4, -1, W), 4)).toBe(true);
  });

  test('it fills to two screens before the first paint, then stops', () => {
    const span = openSpan(600, -1, W);
    expect(fillDirection(span, 600, { height: 900, viewport: 600 }, W)).toBe('up');
    expect(fillDirection(span, 600, { height: 1300, viewport: 600 }, W)).toBe(null);
    // nothing older to mount: it stays short
    expect(fillDirection({ start: 0, end: null }, 4, { height: 300, viewport: 600 }, W)).toBe(null);
  });

  test('new pieces that arrive join the end', () => {
    const span = openSpan(600, -1, W);
    expect(mountedRange(span, 602, W)).toEqual([594, 602]);
  });

  test('a rewind that left fewer pieces still mounts the latest of them', () => {
    expect(mountedRange({ start: 594, end: null }, 100, W)).toEqual([94, 100]);
    expect(mountedRange({ start: 594, end: null }, 3, W)).toEqual([0, 3]);
  });
});

describe('a link to a message', () => {
  test('an early message mounts a few pieces around its own, not the end', () => {
    const t = unitIndexOf(longUnits, long.messages, 'm_long_81');
    expect(longUnits[t].key).toBe('m_long_81');
    const span = openSpan(600, t, W);
    expect(span).toEqual({ start: t - 3, end: t + 5 });
    const [from, to] = mountedRange(span, 600, W);
    expect(from).toBeLessThanOrEqual(t);
    expect(to).toBeGreaterThan(t);
    expect(to).toBeLessThan(600);
  });

  test('a message in the latest pieces opens at the end', () => {
    const t = unitIndexOf(longUnits, long.messages, 'm_long_2393');
    expect(openSpan(600, t, W)).toEqual({ start: 594, end: null });
  });

  test('a message near the end mounts through the end', () => {
    expect(openSpan(600, 593, { ...W, after: 8 })).toEqual({ start: 590, end: null });
    expect(openSpan(600, 590, W)).toEqual({ start: 587, end: 595 });
  });

  test('each message finds the piece that shows it', () => {
    // a turn holds every assistant message until the next prompt
    expect(longUnits[unitIndexOf(longUnits, long.messages, 'm_long_84')].key).toBe('m_long_82');
    expect(longUnits[unitIndexOf(longUnits, long.messages, 'm_long_88')].key).toBe('m_long_82');
    // a tool result has no piece of its own: the turn that ran the tool
    expect(longUnits[unitIndexOf(longUnits, long.messages, 'm_long_83')].key).toBe('m_long_82');
    expect(longUnits[unitIndexOf(longUnits, long.messages, 'm_long_87')].key).toBe('m_long_82');
    expect(unitIndexOf(longUnits, long.messages, 'm_nope')).toBe(-1);
  });

  test('jury members and the verdict find their group', () => {
    const session = { id: 's1', mode: 'jury' } as Session;
    const list = [
      msg(1, 'user', [{ type: 'text', text: 'Which database?' }]),
      msg(2, 'assistant', [{ type: 'text', text: 'Postgres' }], { kind: 'aside', group: 'g1' }),
      msg(3, 'assistant', [{ type: 'text', text: 'SQLite' }], { kind: 'aside', group: 'g1' }),
      msg(4, 'assistant', [{ type: 'text', text: 'Postgres, two to one' }], { group: 'g1' }),
      msg(5, 'user', [{ type: 'text', text: 'Thanks' }]),
    ];
    const units: Unit[] = buildUnits(list, session);
    expect(units.map((u) => u.key)).toEqual(['m1', 'g:g1', 'm5']);
    expect(unitIndexOf(units, list, 'm3')).toBe(1);
    expect(unitIndexOf(units, list, 'm4')).toBe(1);
    expect(unitIndexOf(units, list, 'm5')).toBe(2);
  });

  test('it fills until the linked piece has a screen above and below it', () => {
    const span = { start: 75, end: 86 };
    expect(fillDirection(span, 600, { height: 3000, viewport: 600, above: 200, below: 2000 }, W)).toBe('up');
    expect(fillDirection(span, 600, { height: 3000, viewport: 600, above: 900, below: 300 }, W)).toBe('down');
    expect(fillDirection(span, 600, { height: 3000, viewport: 600, above: 900, below: 900 }, W)).toBe(null);
    // at the start of the session there is nothing more above
    expect(fillDirection({ start: 0, end: 9 }, 600, { height: 3000, viewport: 600, above: 100, below: 900 }, W)).toBe(null);
  });

  test('idle time fills toward the end first, then upward, and then everything is mounted', () => {
    const t = unitIndexOf(longUnits, long.messages, 'm_long_81');
    const steps = idleToEnd(openSpan(600, t, W), 600);
    const last = steps[steps.length - 1];
    expect(last).toEqual({ start: 0, end: null });
    const joined = steps.findIndex((s) => s.end === null);
    // every step before joining the end grows down, every step after grows up
    expect(steps.slice(1, joined + 1).every((s, i) => s.start === steps[i].start)).toBe(true);
    expect(steps.slice(joined + 1).every((s, i) => s.end === null && s.start < steps[joined + i].start)).toBe(true);
    // the linked piece stays mounted all along
    for (const s of steps) {
      const [from, to] = mountedRange(s, 600, W);
      expect(from <= t && t < to).toBe(true);
    }
  });
});

describe('growing', () => {
  test('a chunk at a time, up to the first piece', () => {
    expect(growUp({ start: 20, end: null }, 8)).toEqual({ start: 12, end: null });
    expect(growUp({ start: 5, end: null }, 8)).toEqual({ start: 0, end: null });
    const top = { start: 0, end: null };
    // nothing more: the same span, so no update is made
    expect(growUp(top, 8)).toBe(top);
  });

  test('down a chunk at a time, joining the end at the last piece', () => {
    expect(growDown({ start: 10, end: 20 }, 100, 8)).toEqual({ start: 10, end: 28 });
    expect(growDown({ start: 10, end: 95 }, 100, 8)).toEqual({ start: 10, end: null });
    const end = { start: 10, end: null };
    expect(growDown(end, 100, 8)).toBe(end);
  });

  test('the whole 300 turn session mounts in 75 idle steps from its opening', () => {
    const steps = idleToEnd(openSpan(600, -1, W), 600);
    expect(steps.length - 1).toBe(Math.ceil(594 / 8));
    expect(isComplete(steps[steps.length - 1], 600)).toBe(true);
    expect(idleDirection(steps[steps.length - 1], 600)).toBe(null);
  });

  test('near the top of what is mounted mounts more above; near the bottom, below while the end is not mounted', () => {
    const viewport = 600;
    expect(nearEdge({ start: 100, end: null }, 600, { top: 500, height: 20000, viewport }, W)).toBe('up');
    expect(nearEdge({ start: 100, end: null }, 600, { top: 5000, height: 20000, viewport }, W)).toBe(null);
    expect(nearEdge({ start: 0, end: null }, 600, { top: 0, height: 20000, viewport }, W)).toBe(null);
    expect(nearEdge({ start: 0, end: 50 }, 600, { top: 19000, height: 20000, viewport }, W)).toBe('down');
    expect(nearEdge({ start: 0, end: null }, 600, { top: 19400, height: 20000, viewport }, W)).toBe(null);
  });
});

describe('parts', () => {
  /** Parts are in order, touch, and cover what is mounted. */
  function covers(parts: ReturnType<typeof partsOf>, from: number, to: number) {
    let at = from;
    for (const p of parts) {
      expect(p.from).toBe(at);
      expect(p.to).toBeGreaterThanOrEqual(p.from);
      at = p.to;
    }
    expect(at).toBe(to);
  }

  test('while a session opens it is one part', () => {
    expect(partsOf(null, 590, 600, 600, 8)).toEqual([{ key: 'mid', from: 590, to: 600 }]);
  });

  test('every chunk above has its part before it mounts, so mounting one puts nothing into another', () => {
    const core: Span = { start: 594, end: null };
    let span: Span = core;
    let before = partsOf(core, ...mountedRange(span, 600, W), 600, 8);
    expect(before.length).toBe(Math.ceil(594 / 8) + 1);
    expect(before.filter((p) => p.from < p.to).map((p) => p.key)).toEqual(['mid']);
    while (!isComplete(span, 600)) {
      span = grow(span, 'up', 600, 8);
      const [from, to] = mountedRange(span, 600, W);
      const after = partsOf(core, from, to, 600, 8);
      covers(after, from, to);
      // the same parts, in the same order: none is made or dropped as pieces mount
      expect(after.map((p) => p.key)).toEqual(before.map((p) => p.key));
      // one part filled, from empty; the rest hold what they held
      const size = (p: { from: number; to: number }) => p.to - p.from;
      const changed = after.filter((p, i) => size(p) !== size(before[i]));
      expect(changed.length).toBe(1);
      expect(size(before[after.indexOf(changed[0])])).toBe(0);
      before = after;
    }
  });

  test('after a link, chunks below get parts too, and a piece that arrives later never changes part', () => {
    const core: Span = { start: 7, end: 15 };
    const parts = partsOf(core, 7, 15, 40, 8);
    expect(parts.map((p) => p.key)).toEqual(['a0', 'mid', 'b0', 'b1', 'b2', 'b3']);
    covers(parts, 7, 15);
    let was = new Map<number, string>();
    for (let count = 40; count <= 60; count++) {
      const all = partsOf(core, 0, count, count, 8);
      covers(all, 0, count);
      const now = new Map<number, string>();
      for (const p of all) for (let i = p.from; i < p.to; i++) now.set(i, p.key);
      for (const [i, key] of was) expect(now.get(i)).toBe(key);
      was = now;
    }
    expect(was.get(59)).toBe('b5');
  });
});
