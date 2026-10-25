/**
 * Which rows of a long chat are mounted (chat/window.ts, used by
 * ChatMessages as MessageList uses it). A chat opens with its latest rows,
 * a #message link mounts a few around its row and the tail stays mounted
 * while a reply streams, and older rows mount a chunk at a time.
 *
 *   bun test packages/web/test/conversation-window.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { buildUnits, rowIndexOf } from '../src/features/conversation/units';
import { WINDOW, grow, idleDirection, mountedRange, openSpan } from '../src/features/chat/window';
import { longSession } from '../src/mock/long';

/** The 300 turn mock: 2,400 messages, 600 rows (a prompt and a reply each). */
const long = longSession(300, 1_000_000_000_000);
const rows = buildUnits(long.messages);

describe('the rows of a long chat', () => {
  test('a prompt and a reply a turn', () => {
    expect(rows.length).toBe(600);
    expect(rows[0].kind).toBe('user');
    expect(rows[1].kind).toBe('reply');
  });

  test('a link finds the row that shows the message', () => {
    const user = long.messages.find((m) => m.id === rows[6].key)!;
    expect(rowIndexOf(rows, long.messages, user.id)).toBe(6);
    // every assistant message of a turn is its reply's row
    const reply = rows[7];
    if (reply.kind === 'reply') for (const m of reply.messages) expect(rowIndexOf(rows, long.messages, m.id)).toBe(7);
    // a tool result has no row of its own: the reply that ran the tool
    const tool = long.messages.find((m) => m.content.some((b) => b.type === 'tool_result'))!;
    const at = rowIndexOf(rows, long.messages, tool.id);
    expect(at).toBeGreaterThan(0);
    const holder = rows[at];
    expect(holder.kind === 'reply' && holder.messages.some((m) => m.id === tool.id)).toBe(true);
    expect(rowIndexOf(rows, long.messages, 'm_nope')).toBe(-1);
  });
});

describe('opening and streaming', () => {
  test('a chat opens with its latest rows only, and what streams joins them', () => {
    const span = openSpan(600, -1);
    expect(span).toEqual({ start: 600 - WINDOW.first, end: null });
    expect(mountedRange(span, 600)).toEqual([594, 600]);
    // a reply that streams while it is open mounts: the tail is never left out
    expect(mountedRange(span, 602)).toEqual([594, 602]);
  });

  test('a link to an early message mounts its row and a few around it', () => {
    const t = rowIndexOf(rows, long.messages, 'm_long_81');
    expect(t).toBeGreaterThanOrEqual(0);
    const span = openSpan(600, t);
    const [from, to] = mountedRange(span, 600);
    expect(from).toBeLessThanOrEqual(t);
    expect(to).toBeGreaterThan(t);
    // the linked row stays mounted while older rows grow in above it
    let s = span;
    while (s.start > 0) {
      s = grow(s, 'up', 600);
      const [f, e] = mountedRange(s, 600);
      expect(f <= t && t < e).toBe(true);
    }
    expect(s.start).toBe(0);
    // after a link the newest rows mount too, until everything is there
    expect(idleDirection(span, 600)).toBe('down');
    expect(grow(span, 'down', 600, 600).end).toBe(null);
    // a chat that opened at the end fills upward in idle time
    expect(idleDirection(openSpan(600, -1), 600)).toBe('up');
  });
});
