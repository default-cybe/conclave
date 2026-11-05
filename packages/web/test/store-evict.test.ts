/**
 * A tab holds the transcripts on screen plus the 2 last left, not every chat
 * it opened; a session no view shows keeps a short live tail and no tool
 * results; a resync fetches only what came after the newest held message.
 *
 *   bun test packages/web/test/store-evict.test.ts
 */
import { afterAll, expect, test } from 'bun:test';
import type { Message } from '@conclave/core/types';
import { connectClient } from '../src/lib/api';
import { applyEvent, KEEP_RECENT, LIVE_TAIL, loadAll, loadOlder, retainTranscript, useHub } from '../src/store/store';

const msg = (sessionId: string, seq: number, extra: Partial<Message> = {}): Message => ({ id: `${sessionId}_m${seq}`, sessionId, seq, role: 'assistant', kind: 'normal', content: [{ type: 'text', text: `m${seq}` }], createdAt: seq, stopReason: 'end_turn', ...extra }) as Message;
/** Each session's transcript at the hub. */
const hub: Record<string, Message[]> = {};
const asked: string[] = [];
/** The block route fails while set. */
let blocksDown = false;
const realFetch = globalThis.fetch;
// the hub's paging as in core storage/repos.ts page(), and trim=1 cutting text over 1000 chars (stands in for 100 KB)
globalThis.fetch = (async (url: string | URL | Request) => {
  const u = new URL(String(url));
  const b = /\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/blocks\/(\d+)$/.exec(u.pathname);
  if (b) return blocksDown ? Response.json({ error: 'down' }, { status: 503 }) : Response.json(hub[b[1]]?.find((x) => x.id === b[2])?.content[Number(b[3])]);
  const m = /\/api\/sessions\/([^/]+)\/messages$/.exec(u.pathname);
  if (!m) return Response.json([]);
  asked.push(`${m[1]}${u.search}`);
  const q = u.searchParams;
  const after = Number(q.get('afterSeq') ?? 0);
  const before = Number(q.get('beforeSeq') ?? Infinity);
  let list = (hub[m[1]] ?? []).filter((x) => x.seq > after && x.seq < before);
  if (q.has('limit') && !q.has('afterSeq')) list = list.slice(-Number(q.get('limit')));
  if (q.get('trim') === 'true' || q.get('trim') === '1')
    list = list.map((x) => {
      const trimmed = x.content.flatMap((c, index) => (c.type === 'text' && c.text.length > 1000 ? [{ index, bytes: c.text.length }] : []));
      return trimmed.length ? { ...x, content: x.content.map((c) => (c.type === 'text' ? { ...c, text: c.text.slice(0, 1000) } : c)), meta: { trimmed } } : x;
    });
  return Response.json(list);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const tick = () => Bun.sleep(20);
const loaded = () => Object.keys(useHub.getState().messagesLoaded).sort();

test('only the chats on screen and the 2 last left stay loaded', async () => {
  await connectClient({ baseUrl: 'http://hub.test', token: 't' });
  for (const id of ['a', 'b', 'c', 'd', 'e']) hub[id] = Array.from({ length: 30 }, (_, i) => msg(id, i + 1));
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    const release = retainTranscript(id);
    await tick();
    release();
    await tick();
  }
  const keep = retainTranscript('a');
  await tick();
  expect(KEEP_RECENT).toBe(2);
  expect(loaded()).toEqual(['a', 'd', 'e']);
  // what went keeps its last messages for the sidebar and the live rate
  expect(useHub.getState().messages.b).toHaveLength(LIVE_TAIL);
  keep();
});

test('a session no view shows keeps a short tail and no tool results', async () => {
  const s = 'live';
  for (let i = 1; i <= 40; i++) applyEvent({ type: 'message.created', seq: 100 + i, ts: i, message: msg(s, i, { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} }] }) });
  applyEvent({ type: 'tool.started', seq: 200, ts: 1, sessionId: s, messageId: `${s}_m40`, toolUseId: 't40', name: 'Bash', input: {} });
  applyEvent({ type: 'tool.completed', seq: 201, ts: 2, sessionId: s, toolUseId: 't40', result: { type: 'tool_result', toolUseId: 't40', content: 'x'.repeat(1000) } });
  expect(useHub.getState().messages[s]).toHaveLength(LIVE_TAIL);
  expect(useHub.getState().tools.t40.status).toBe('ok');
  expect(useHub.getState().tools.t40.result).toBeUndefined();
});

test('a resync fetches only what came after the newest held message', async () => {
  const release = retainTranscript('a');
  await tick();
  hub.a.push(msg('a', 31), msg('a', 32));
  asked.length = 0;
  await loadAll({ transcripts: true });
  await tick();
  expect(asked.filter((x) => x.startsWith('a'))).toEqual(['a?afterSeq=29']);
  expect(useHub.getState().messages.a.map((m) => m.seq)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  // the hub's transcript changed under it (a rewind): the newest page comes again
  hub.a = hub.a.slice(0, 10);
  asked.length = 0;
  await loadAll({ transcripts: true });
  await tick();
  expect(asked.filter((x) => x.startsWith('a'))).toHaveLength(2);
  expect(asked.filter((x) => x.startsWith('a'))[1]).toStartWith('a?limit=200&trim=');
  expect(useHub.getState().messages.a).toHaveLength(10);
  release();
});

test('a long chat loads its newest 200, pages back to the first, and fills trimmed blocks in full', async () => {
  hub.p = Array.from({ length: 450 }, (_, i) => msg('p', i + 1));
  hub.p[449] = msg('p', 450, { content: [{ type: 'text', text: 'x'.repeat(5000) }] });
  blocksDown = true;
  const release = retainTranscript('p');
  await tick();
  const seqs = () => useHub.getState().messages.p.map((m) => m.seq);
  expect(seqs()).toEqual(Array.from({ length: 200 }, (_, i) => 251 + i));
  expect(useHub.getState().messagesOlder.p).toBe(true);
  // the block route failed: the cut block keeps its mark, never passing as whole
  const last = () => useHub.getState().messages.p.at(-1)!;
  expect(last().meta?.trimmed).toEqual([{ index: 0, bytes: 5000 }]);
  blocksDown = false;
  await loadOlder('p');
  await tick();
  expect(seqs()).toEqual(Array.from({ length: 400 }, (_, i) => 51 + i));
  expect(useHub.getState().messagesOlder.p).toBe(true);
  // the next fill laid the whole block in
  expect(last().content).toEqual(hub.p[449].content);
  expect(last().meta?.trimmed).toBeUndefined();
  await loadOlder('p');
  expect(seqs()).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
  expect(useHub.getState().messagesOlder.p).toBe(false);
  release();
});
