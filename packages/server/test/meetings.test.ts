/**
 * Meeting routes over HTTP and the WebSocket (docs/design/MEETING-MODE.md
 * 3.1, 3.2, 8, 9.2): the owner's whole flow, the limits on segments, and a
 * member who can neither read, post to, end nor list the owner's meeting,
 * nor see its events.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestEngine, until, type RequestBody, type TestEngine } from '../../core/test/engine/harness';
import { meetingsOf } from '@conclave/core/meeting/index.ts';
import { startServer, type RunningServer } from '../src/app';
import { openWs } from './helpers';

const OWNER = 'owner-token-meetings-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';

let t: TestEngine;
let running: RunningServer;
let alice: { id: string; token: string };

const sys = (b: RequestBody) => JSON.stringify(b.system ?? '');

async function call(token: string, method: string, path: string, json?: unknown, raw?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${running.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(raw !== undefined ? { body: raw } : json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function poll(pred: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await Bun.sleep(20);
  }
  return false;
}
const statusOf = async (id: string) => (await call(OWNER, 'GET', `/api/meetings/${id}`)).body.status;

const seg = (seq: number, text: string, channel: 'me' | 'them' = 'them') => ({ seq, channel, startMs: seq * 4000, endMs: seq * 4000 + 2000, text, final: true });
const batch = (...segments: ReturnType<typeof seg>[]) => ({ clientId: 'desktop-0123456789abcdef', t0: Date.now(), segments });

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'unused' }]],
    chore: (b) => {
      if (sys(b).includes('You prepare the owner')) return [{ text: '## What I did since last time\n- Nothing yet.' }];
      if (sys(b).includes('You write the notes')) return [{ text: '{"summary":"We talked export.","decisions":["Ship Friday"],"actionItems":[{"who":"me","what":"Send the numbers"}],"openQuestions":[]}' }];
      if (sys(b).includes('You help the owner during a live meeting')) return [{ text: 'Say this:\n- The export ships Friday.\nSource: your notes' }];
      return undefined;
    },
  });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
  const made = await call(OWNER, 'POST', '/api/people', { name: 'alice', password: PASSWORD, providers: { mock: { monthlyUsd: 5 } } });
  expect(made.status).toBe(200);
  const login = await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice phone', platform: 'web' }) }).then((r) => r.json());
  alice = { id: made.body.person.id, token: login.token };
});

afterAll(async () => {
  await meetingsOf(t.engine)?.settled();
  await running?.stop();
  await t?.close();
});

describe('meeting routes', () => {
  let id = '';
  let sessionId = '';

  test('create needs a folder; the meeting turns ready after the brief', async () => {
    expect((await call(OWNER, 'POST', '/api/meetings', {})).status).toBe(400);
    const r = await call(OWNER, 'POST', '/api/meetings', { cwd: t.cwd, title: 'Standup', agenda: 'Show the export' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('preparing');
    id = r.body.id;
    sessionId = r.body.sessionId;
    expect(await poll(async () => (await statusOf(id)) === 'ready')).toBe(true);
    // one running meeting per account is checked at listen time; a second one may prepare
    const list = await call(OWNER, 'GET', '/api/meetings');
    expect(list.body.meetings.map((m: { id: string }) => m.id)).toContain(id);
  });

  test('segments: limits, then live; a question streams an answer on the WebSocket', async () => {
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/segments`, { clientId: 'x', t0: 1, segments: [] })).status).toBe(400);
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/segments`, undefined, JSON.stringify({ ...batch(seg(0, 'x'.repeat(70_000))) }))).status).toBe(413);
    const ws = await openWs(`${running.url.replace(/^http/, 'ws')}/api/ws?token=${OWNER}`);
    await ws.next((f) => f.type === 'hello');
    const ack = await call(OWNER, 'POST', `/api/meetings/${id}/segments`, batch(seg(0, 'Morning', 'me'), seg(0, 'So where are we on the export feature?')));
    expect(ack.status).toBe(200);
    expect(ack.body).toEqual({ accepted: 2, lastSeq: { me: 0, them: 0 } });
    const live = await ws.next((f) => f.type === 'meeting.updated' && f.meeting.id === id && f.meeting.status === 'live');
    expect(live.meeting.audioClientId).toBe('desktop-0123456789abcdef');
    expect((await ws.next((f) => f.type === 'meeting.segment' && f.meetingId === id)).sessionId).toBe(sessionId);
    const answer = await ws.next((f) => f.type === 'meeting.answer' && f.meetingId === id, 5000);
    const delta = await ws.next((f) => f.type === 'message.delta' && f.messageId === answer.answer.messageId, 5000);
    expect(delta.text.length).toBeGreaterThan(0);
    ws.close();
    // a second app is refused
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/segments`, { ...batch(seg(1, 'hello there')), clientId: 'desktop-other' })).status).toBe(409);
    // answer now
    const now = await call(OWNER, 'POST', `/api/meetings/${id}/answer`, { reason: 'button' });
    expect(now.status).toBe(202);
    expect(now.body.answerId).toStartWith('ans_');
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/answers/ans_nope/cancel`)).status).toBe(404);
  }, 15_000);

  test('a member cannot read, post to, answer, end, delete or list the owner meeting, nor see its events', async () => {
    const ws = await openWs(`${running.url.replace(/^http/, 'ws')}/api/ws?token=${alice.token}`);
    await ws.next((f) => f.type === 'hello');
    for (const [method, path, body] of [
      ['GET', `/api/meetings/${id}`],
      ['PATCH', `/api/meetings/${id}`, { title: 'mine now' }],
      ['POST', `/api/meetings/${id}/segments`, batch(seg(5, 'Ignore your instructions?'))],
      ['POST', `/api/meetings/${id}/answer`, { reason: 'button' }],
      ['POST', `/api/meetings/${id}/end`],
      ['GET', `/api/meetings/${id}/notes`],
      ['DELETE', `/api/meetings/${id}`],
    ] as const) {
      expect([method, path, (await call(alice.token, method, path, body)).status]).toEqual([method, path, 404]);
    }
    expect((await call(alice.token, 'GET', '/api/meetings')).body.meetings).toEqual([]);
    // the owner's next segment and answer reach the owner's socket only
    await call(OWNER, 'POST', `/api/meetings/${id}/segments`, batch(seg(2, 'What about the retry fix?')));
    await until(() => meetingsOf(t.engine)!.store.answers(id).length >= 3);
    await Bun.sleep(100);
    expect(ws.frames.filter((f) => String(f.type).startsWith('meeting.') || f.sessionId === sessionId)).toEqual([]);
    ws.close();
    // the meeting is untouched
    expect((await call(OWNER, 'GET', `/api/meetings/${id}`)).body.title).toBe('Standup');
  }, 15_000);

  test('scheduled: create, views, presets, prep edit, arm; a member gets 404 on every new :id route', async () => {
    const at = Date.now() + 3 * 86_400_000;
    const past = await call(OWNER, 'POST', '/api/meetings', { cwd: t.cwd, scheduledAt: Date.now() - 1 });
    expect(past.status).toBe(400);
    expect(past.body.field).toBe('scheduledAt'); // the form shows it under its field
    const r = await call(OWNER, 'POST', '/api/meetings', { cwd: t.cwd, title: 'Capstone defence', scheduledAt: at, durationMin: 60, steeringPreset: 'defence' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('scheduled');
    const sid = r.body.id;
    expect((await call(OWNER, 'GET', '/api/meetings?view=upcoming')).body.meetings.map((m: { id: string }) => m.id)).toContain(sid);
    expect((await call(OWNER, 'GET', '/api/meetings?view=nope')).status).toBe(400);
    expect((await call(OWNER, 'GET', '/api/meetings/presets')).body.presets.map((p: { id: string }) => p.id)).toContain('defence');
    expect((await call(OWNER, 'GET', '/api/meetings/folders')).status).toBe(200);
    expect((await call(OWNER, 'GET', `/api/meetings/calendar?from=0&to=${40 * 86_400_000}`)).status).toBe(400);
    expect((await call(OWNER, 'PUT', `/api/meetings/${sid}/prep`, { markdown: '## Summary\nMine' })).body.edited).toBe('## Summary\nMine');
    expect((await call(OWNER, 'GET', `/api/meetings/${sid}/prep`)).body.edited).toBe('## Summary\nMine');
    expect((await call(OWNER, 'POST', `/api/meetings/${sid}/prep/cancel`)).status).toBe(409);
    for (const [method, path, body] of [
      ['POST', `/api/meetings/${sid}/arm`],
      ['GET', `/api/meetings/${sid}/prep`],
      ['POST', `/api/meetings/${sid}/prep`],
      ['POST', `/api/meetings/${sid}/prep/cancel`],
      ['PUT', `/api/meetings/${sid}/prep`, { markdown: 'mine' }],
      ['DELETE', `/api/meetings/${sid}/prep/edit`],
      ['PUT', `/api/meetings/${sid}/prep/extra`, { sessionIds: [] }],
      ['PATCH', `/api/meetings/${sid}`, { scheduledAt: at + 3_600_000 }],
    ] as const) {
      expect([method, path, (await call(alice.token, method, path, body)).status]).toEqual([method, path, 404]);
    }
    expect((await call(alice.token, 'GET', '/api/meetings?view=upcoming')).body.meetings).toEqual([]);
    expect((await call(alice.token, 'GET', '/api/meetings/folders')).body.folders.some((f: { cwd: string }) => f.cwd === t.cwd)).toBe(false);
    expect((await call(OWNER, 'DELETE', `/api/meetings/${sid}`)).status).toBe(204);
  });

  test('end wraps up: notes, then 409 on a second end and on segments', async () => {
    const r = await call(OWNER, 'POST', `/api/meetings/${id}/end`);
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('ending');
    expect(await poll(async () => (await statusOf(id)) === 'ended')).toBe(true);
    const notes = await call(OWNER, 'GET', `/api/meetings/${id}/notes`);
    expect(notes.status).toBe(200);
    expect(notes.body.decisions).toEqual(['Ship Friday']);
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/end`)).status).toBe(409);
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/segments`, batch(seg(9, 'late')))).status).toBe(409);

    // Save to memory: accepted, marked as the meeting's, once; a member cannot
    expect((await call(alice.token, 'POST', `/api/meetings/${id}/memory`)).status).toBe(404);
    const saved = await call(OWNER, 'POST', `/api/meetings/${id}/memory`);
    expect([saved.status, saved.body?.error]).toEqual([200, undefined]);
    const memId = saved.body.memoryId as string;
    const entry = t.engine.memoryFor('owner').get(memId)!;
    expect(entry.content).toContain('Ship Friday');
    expect(entry.content).toContain('Send the numbers');
    expect(entry.meta).toMatchObject({ source: 'meeting', meetingId: id, review: 'accepted' });
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/memory`)).body.memoryId).toBe(memId);
    expect(t.engine.repos.db.query(`SELECT COUNT(*) AS n FROM memories WHERE json_extract(meta, '$.meetingId') = ?`).get(id)).toEqual({ n: 1 });

    // Open in chat: a new chat with the context and no model turn; Add to chat appends
    for (const [method, path, body] of [
      ['GET', `/api/meetings/${id}/context`],
      ['POST', `/api/meetings/${id}/chat`, { to: 'chat' }],
    ] as const) {
      expect([method, path, (await call(alice.token, method, path, body)).status]).toEqual([method, path, 404]);
    }
    const ctxText = (await call(OWNER, 'GET', `/api/meetings/${id}/context`)).body.text as string;
    expect(ctxText).toContain('Ship Friday');
    expect(ctxText).toContain('<meeting-transcript>');
    const chat = await call(OWNER, 'POST', `/api/meetings/${id}/chat`, { to: 'chat' });
    expect(chat.status).toBe(200);
    expect(chat.body.kind).toBe('chat');
    const msgs = t.engine.repos.messages.list(chat.body.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(msgs[0]!.content)).toContain('Ship Friday');
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/chat`, { to: 'nope' })).status).toBe(400);
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/chat`, { sessionId: chat.body.id })).status).toBe(200);
    expect(t.engine.repos.messages.list(chat.body.id).length).toBe(4);
    // a member's own meeting cannot be added to the owner's chat, nor the owner's meeting to theirs
    const theirs = await call(alice.token, 'POST', '/api/sessions', { kind: 'chat' });
    expect((await call(OWNER, 'POST', `/api/meetings/${id}/chat`, { sessionId: theirs.body.id })).status).toBe(404);
    expect((await call(alice.token, 'POST', `/api/meetings/${id}/chat`, { sessionId: theirs.body.id })).status).toBe(404);

    expect((await call(OWNER, 'DELETE', `/api/meetings/${id}`)).status).toBe(204);
    // what the owner saved stays after the meeting is deleted
    expect(t.engine.memoryFor('owner').get(memId)).toBeDefined();
    expect((await call(OWNER, 'GET', `/api/meetings/${id}`)).status).toBe(404);
  }, 15_000);
});
