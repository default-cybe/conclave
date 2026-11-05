/**
 * Incognito sessions across accounts (core session/incognito.ts,
 * docs/design/ACCOUNTS.md): the hub's owner never reads a member's incognito
 * session, and a member never reads the owner's. Not by its id (the session,
 * its messages, shells and export), not through search, the SessionSearch,
 * SessionRead and DayPlan tools, the Map, Today or the recap.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestEngine, toolResults, type Step, type TestEngine } from '../../core/test/engine/harness';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-incognito-accounts-0123456789';
const PASSWORD = 'correct horse battery staple';

const script: Step[] = [];
let t: TestEngine;
let running: RunningServer;
let alice: { id: string; token: string };
// each side's incognito chat, with a word only it holds
const secret = { owner: { id: '', word: 'quokkaowner' }, alice: { id: '', word: 'narwhalalice' } };

async function call(token: string, method: string, path: string, json?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${running.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* an export or an error page: kept as text */
  }
  return { status: res.status, body };
}

async function incognitoChat(token: string, word: string): Promise<string> {
  const r = await call(token, 'POST', '/api/sessions', { kind: 'chat', title: `Incognito ${word}`, incognito: true });
  expect(r.status).toBe(200);
  expect(r.body.incognito).toBe(true);
  t.engine.addMessage(r.body.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: `Tell me about the ${word} plan.` }] });
  t.engine.addMessage(r.body.id, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: `The ${word} plan is private.` }] });
  return r.body.id;
}

beforeAll(async () => {
  t = await startTestEngine({ script, extraProviders: { private: ['claude-sonnet-5-5'] } });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
  const made = await call(OWNER, 'POST', '/api/people', { name: 'alice', password: PASSWORD, providers: { mock: { monthlyUsd: 5 } } });
  expect(made.status).toBe(200);
  const login = await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice phone', platform: 'web' }) }).then((r) => r.json());
  alice = { id: made.body.person.id, token: login.token };
  secret.owner.id = await incognitoChat(OWNER, secret.owner.word);
  secret.alice.id = await incognitoChat(alice.token, secret.alice.word);
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

// [reader's token, whose session it reads]
const pairs = () =>
  [
    ['the owner', OWNER, secret.alice],
    ['a member', alice.token, secret.owner],
  ] as const;

describe('incognito sessions across accounts', () => {
  test("each side reads its own incognito session by id (the check below is not a blanket 404)", async () => {
    for (const [token, mine] of [[OWNER, secret.owner], [alice.token, secret.alice]] as const) {
      expect((await call(token, 'GET', `/api/sessions/${mine.id}`)).status).toBe(200);
      const msgs = await call(token, 'GET', `/api/sessions/${mine.id}/messages`);
      expect(msgs.status).toBe(200);
      expect(JSON.stringify(msgs.body)).toContain(mine.word);
      // its own export is refused too: the conversation is not kept
      expect((await call(token, 'GET', `/api/sessions/${mine.id}/export`)).status).toBe(409);
    }
  });

  test('by id: the session, its messages, a block, its shells and its export are unknown to the other account', async () => {
    for (const [, token, other] of pairs()) {
      for (const path of [`/api/sessions/${other.id}`, `/api/sessions/${other.id}/messages`, `/api/sessions/${other.id}/messages/x/blocks/0`, `/api/sessions/${other.id}/shells`, `/api/sessions/${other.id}/export`, `/api/sessions/${other.id}/export?format=json`]) {
        const r = await call(token, 'GET', path);
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toContain(other.word);
      }
    }
  });

  test('search, the Map, Today and the recap never name the other side, nor its own', async () => {
    for (const token of [OWNER, alice.token]) {
      for (const path of [`/api/search?q=${secret.owner.word}`, `/api/search?q=${secret.alice.word}`, '/api/sessions', '/api/map', '/api/assistant/today', '/api/reflect/report?range=week']) {
        const r = await call(token, 'GET', path);
        expect(r.status).toBe(200);
        const text = JSON.stringify(r.body);
        for (const s of [secret.owner, secret.alice]) {
          expect(text).not.toContain(s.word);
          expect(text).not.toContain(s.id);
        }
      }
    }
  });

  test('SessionSearch, SessionRead and DayPlan in a turn never reach the other account', async () => {
    for (const [, , other] of pairs()) {
      script.push(
        [{ tool: 'SessionSearch', input: { query: other.word } }],
        [{ tool: 'SessionRead', input: { session: other.id } }],
        [{ tool: 'DayPlan', input: {} }],
        [{ text: 'nothing there' }],
      );
    }
    for (const [who, , other] of pairs()) {
      const acct = who === 'the owner' ? undefined : alice.id;
      const s = await t.engine.createSession({ agent: 'assistant', title: `look ${who}` }, acct);
      await t.run(s.id, `find the ${other.word} plan`);
      const [search, read, day] = toolResults(t.engine, s.id);
      expect(search.name).toBe('SessionSearch');
      expect(search.isError).toBe(false);
      expect(search.content).not.toContain(other.id);
      expect(search.content).not.toContain(`${other.word} plan is`);
      expect(read.name).toBe('SessionRead');
      expect(read.isError).toBe(true);
      expect(read.content).not.toContain(`${other.word} plan is`);
      expect(day.name).toBe('DayPlan');
      expect(day.isError).toBe(false);
      expect(day.content).not.toContain(other.word);
      expect(day.content).not.toContain(other.id);
    }
    // two real turns: 4 s seen under full-suite load on the 2-core hub
  }, 20_000);
});
