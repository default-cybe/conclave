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
import { applyEvent, KEEP_RECENT, LIVE_TAIL, loadAll, retainTranscript, useHub } from '../src/store/store';

const msg = (sessionId: string, seq: number, extra: Partial<Message> = {}): Message => ({ id: `${sessionId}_m${seq}`, sessionId, seq, role: 'assistant', kind: 'normal', content: [{ type: 'text', text: `m${seq}` }], createdAt: seq, stopReason: 'end_turn', ...extra }) as Message;
/** Each session's transcript at the hub. */
const hub: Record<string, Message[]> = {};
const asked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  const u = new URL(String(url));
  const m = /\/api\/sessions\/([^/]+)\/messages$/.exec(u.pathname);
  if (!m) return Response.json([]);
  asked.push(`${m[1]}${u.search}`);
  const after = Number(u.searchParams.get('afterSeq') ?? 0);
  return Response.json((hub[m[1]] ?? []).filter((x) => x.seq > after));
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
  // the hub's transcript changed under it (a rewind): the whole one comes again
  hub.a = hub.a.slice(0, 10);
  asked.length = 0;
  await loadAll({ transcripts: true });
  await tick();
  expect(asked.filter((x) => x.startsWith('a'))).toEqual(['a?afterSeq=31', 'a']);
  expect(useHub.getState().messages.a).toHaveLength(10);
  release();
});
