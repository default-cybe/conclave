import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/storage/db';
import { MeetingStore, canMove } from '../../src/meeting/store';
import type { MeetingStatus, Segment } from '../../src/meeting/wire';

const ALL: MeetingStatus[] = ['preparing', 'ready', 'live', 'paused', 'ending', 'ended', 'failed'];
const ALLOWED = new Set([
  'preparing>ready',
  'preparing>ending',
  'preparing>failed',
  'ready>live',
  'ready>ending',
  'ready>failed',
  'live>paused',
  'live>ending',
  'live>failed',
  'paused>live',
  'paused>ending',
  'paused>failed',
  'ending>ended',
  'ending>failed',
  'failed>ending',
]);

function fresh() {
  const store = new MeetingStore(openDb(':memory:'));
  const m = store.create({ accountId: 'owner', sessionId: 'ses_1', device: 'local', cwd: '/p', title: 'T' });
  return { store, m };
}

const seg = (seq: number, text: string, final: boolean, channel: 'me' | 'them' = 'them'): Segment => ({ seq, channel, startMs: seq * 1000, endMs: seq * 1000 + 900, text, final });

describe('meeting store', () => {
  test('create reads back with defaults', () => {
    const { store, m } = fresh();
    expect(m.id.startsWith('mtg')).toBe(true);
    expect(m.status).toBe('preparing');
    expect(m.autoAnswer).toBe('questions');
    expect(store.get(m.id)).toEqual(m);
    expect(store.accountOf(m.id)).toBe('owner');
    expect(store.list('owner').map((x) => x.id)).toEqual([m.id]);
    expect(store.list('alice')).toEqual([]);
  });

  test('every status change, allowed and forbidden', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const ok = ALLOWED.has(`${from}>${to}`);
        expect(canMove(from, to)).toBe(ok);
        const { store, m } = fresh();
        store.update(m.id, { status: from });
        const moved = store.move(m.id, to);
        expect(moved?.status).toBe(ok ? to : undefined);
        expect(store.get(m.id)!.status).toBe(ok ? to : from);
      }
    }
  });

  test('running finds live and paused only', () => {
    const { store, m } = fresh();
    expect(store.running('owner')).toBeUndefined();
    store.update(m.id, { status: 'live' });
    expect(store.running('owner')?.id).toBe(m.id);
    store.update(m.id, { status: 'paused' });
    expect(store.running('owner')?.id).toBe(m.id);
    store.update(m.id, { status: 'ended' });
    expect(store.running('owner')).toBeUndefined();
  });

  test('a final seq is stored once; retries are ignored', () => {
    const { store, m } = fresh();
    expect(store.putSegment(m.id, 'owner', seg(0, 'hello there', true), 1000)).toBe(true);
    expect(store.putSegment(m.id, 'owner', seg(0, 'changed on retry', true), 1000)).toBe(false);
    expect(store.putSegment(m.id, 'owner', seg(0, 'a late partial', false), 1000)).toBe(false);
    expect(store.finals(m.id).map((s) => s.text)).toEqual(['hello there']);
  });

  test('a partial replaces the partial of its seq, a final replaces both', () => {
    const { store, m } = fresh();
    expect(store.putSegment(m.id, 'owner', seg(3, 'so where', false), 1000)).toBe(true);
    expect(store.putSegment(m.id, 'owner', seg(3, 'so where are we', false), 1000)).toBe(true);
    expect(store.finals(m.id)).toEqual([]);
    expect(store.lastSeq(m.id)).toEqual({ me: -1, them: -1 });
    expect(store.putSegment(m.id, 'owner', seg(3, 'so where are we on it?', true), 1000)).toBe(true);
    expect(store.finals(m.id).map((s) => s.text)).toEqual(['so where are we on it?']);
    expect(store.lastSeq(m.id)).toEqual({ me: -1, them: 3 });
  });

  test('channels keep their own seq', () => {
    const { store, m } = fresh();
    store.putSegment(m.id, 'owner', seg(0, 'them zero', true, 'them'), 2000);
    store.putSegment(m.id, 'owner', seg(0, 'me zero', true, 'me'), 1000);
    store.putSegment(m.id, 'owner', seg(1, 'me one', true, 'me'), 3000);
    expect(store.finals(m.id).map((s) => s.text)).toEqual(['me zero', 'them zero', 'me one']);
    expect(store.lastSeq(m.id)).toEqual({ me: 1, them: 0 });
    expect(store.finals(m.id, { before: 3000 }).map((s) => s.text)).toEqual(['me zero', 'them zero']);
    expect(store.finals(m.id, { limit: 1 }).map((s) => s.text)).toEqual(['me one']);
  });

  test('answers and delete', () => {
    const { store, m } = fresh();
    const a = store.addAnswer({ accountId: 'owner', meetingId: m.id, messageId: 'msg_1', trigger: 'speculative', question: 'q', state: 'streaming', createdAt: 5 });
    expect(store.updateAnswer(a.id, { trigger: 'question', firstTokenAt: 7 })).toMatchObject({ trigger: 'question', firstTokenAt: 7, state: 'streaming' });
    store.failStreaming(m.id, 'the hub restarted');
    expect(store.answer(a.id)).toMatchObject({ state: 'failed', error: 'the hub restarted' });
    store.putSegment(m.id, 'owner', seg(0, 'x', true), 1);
    store.delete(m.id);
    expect(store.get(m.id)).toBeUndefined();
    expect(store.answers(m.id)).toEqual([]);
    expect(store.finals(m.id)).toEqual([]);
  });

  test('previous notes come from the same project only', () => {
    const store = new MeetingStore(openDb(':memory:'));
    const a = store.create({ accountId: 'owner', sessionId: 's1', projectId: 'p1', device: 'local', cwd: '/a', title: 'A', now: 1 });
    const other = store.create({ accountId: 'owner', sessionId: 's2', projectId: 'p2', device: 'local', cwd: '/b', title: 'B', now: 2 });
    const mine = store.create({ accountId: 'alice', sessionId: 's3', projectId: 'p1', device: 'local', cwd: '/a', title: 'C', now: 3 });
    const notes = (summary: string) => ({ summary, decisions: [], actionItems: [], openQuestions: [], markdown: summary });
    store.setNotes(a.id, notes('first'));
    store.setNotes(other.id, notes('other project'));
    store.setNotes(mine.id, notes("alice's"));
    const now = store.create({ accountId: 'owner', sessionId: 's4', projectId: 'p1', device: 'local', cwd: '/a', title: 'D', now: 4 });
    expect(store.previousNotes(now)?.summary).toBe('first');
  });
});
