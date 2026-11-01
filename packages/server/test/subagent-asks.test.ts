/**
 * Approvals and questions from subagents show in the chat the owner is in
 * (docs/design/CHAT-AND-MOTION.md 1.4). A real engine and server with the
 * owner and a member, alice:
 *
 * - the pending lists and the socket carry rootSessionId and from;
 * - the parent's view answers a child's request by its id, and "for this
 *   session" goes to the session that asked;
 * - who may answer stays with the session that asked: alice cannot answer
 *   the owner's subagent, and the owner's lists never show alice's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '@conclave/core/engine/index.ts';
import type { ApprovalResponse, Session } from '@conclave/core/types.ts';
import { startServer, type RunningServer } from '../src/app';
import { openWs } from './helpers';

const OWNER = 'owner-token-asks-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';

let root: string;
let engine: Engine;
let running: RunningServer;
let base: string;
let alice: { token: string; accountId: string };
const aborts: AbortController[] = [];

async function call(token: string, method: string, path: string, json?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

/** A subagent session under `parent`, as engine/subagent.ts makes one. */
function subagentOf(parent: Session, id: string, agent: string, title: string): Session {
  const now = Date.now();
  const sub: Session = { ...parent, id, title, agent, parentId: parent.id, tags: ['subagent'], meta: { subagent: true }, status: 'idle', createdAt: now, updatedAt: now };
  engine.repos.sessions.insert(sub);
  return sub;
}

beforeAll(async () => {
  process.env.CONCLAVE_CATALOG_OFFLINE ??= '1';
  root = mkdtempSync(join(tmpdir(), 'conclave-subagent-asks-'));
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  engine = await createEngine({
    home: join(root, 'home'),
    noBackground: true,
    version: 'test',
    overrides: {
      defaultModel: 'mock/claude-sonnet-5-5',
      smallModel: 'mock/claude-sonnet-5-5',
      providers: { mock: { type: 'anthropic', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', models: ['claude-sonnet-5-5'] } },
      permissions: { mode: 'default', allow: [], deny: [], ask: [], additionalDirectories: [] },
      memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
    } as never,
  });
  engine.config.update({ server: { ...engine.config.get().server, token: OWNER } });
  running = startServer(engine, { host: '127.0.0.1', port: 0 });
  base = running.url;
  const made = await call(OWNER, 'POST', '/api/people', { name: 'alice', password: PASSWORD, providers: { mock: { monthlyUsd: 5 } } });
  expect(made.status).toBeLessThan(300);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice laptop', platform: 'web' }) }).then((r) => r.json() as Promise<any>);
  alice = { token: login.token, accountId: made.body.person.id };
}, 60_000);

afterAll(async () => {
  for (const a of aborts) a.abort();
  await running?.stop();
  await engine?.shutdown();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("a subagent's approval", () => {
  test('the socket and the pending list carry rootSessionId and from; the parent answers it by id; "for this session" stays with the subagent', async () => {
    const ws = await openWs(`${base.replace(/^http/, 'ws')}/api/ws?token=${OWNER}`);
    await ws.next((f) => f.type === 'hello');
    const top = (await call(OWNER, 'POST', '/api/sessions', { title: 'Find my Lisbon mail' })).body as Session;
    const email = subagentOf(top, 'ses_email_owner', 'email', 'Find the booking mail');
    const ac = new AbortController();
    aborts.push(ac);
    const answer = engine.requestApproval(email.id, { toolUseId: 'tu_mail', tool: 'MailRead', input: { id: 'm1' }, summary: 'Read mail m1' }, ac.signal);

    const frame = await ws.next((f) => f.type === 'approval.requested', 5000);
    const want = { sessionId: email.id, rootSessionId: top.id, from: { sessionId: email.id, agent: 'email', label: 'Find the booking mail', chain: [email.id] } };
    expect(frame.approval).toMatchObject(want);
    const listed = (await call(OWNER, 'GET', '/api/approvals')).body as any[];
    expect(listed.find((a) => a.id === frame.approval.id)).toMatchObject(want);

    // the chat's card answers with the request's id; the subagent's own turn gets the answer
    const res = await call(OWNER, 'POST', `/api/approvals/${frame.approval.id}`, { decision: 'allow', scope: 'session' });
    expect(res.status).toBe(200);
    expect(await answer).toEqual({ decision: 'allow', scope: 'session' } satisfies ApprovalResponse);
    const resolved = await ws.next((f) => f.type === 'approval.resolved', 5000);
    expect(resolved).toMatchObject({ id: frame.approval.id, sessionId: email.id });
    expect((await call(OWNER, 'GET', '/api/approvals')).body.some((a: any) => a.id === frame.approval.id)).toBe(false);
    ws.close();
  }, 30_000);

  test('a question from a subagent two levels down names the top session and is answered from it', async () => {
    const top = (await call(OWNER, 'POST', '/api/sessions', { title: 'Plan the trip' })).body as Session;
    const mid = subagentOf(top, 'ses_mid_owner', 'general-purpose', 'Plan it');
    const leaf = subagentOf(mid, 'ses_leaf_owner', 'email', 'Read the thread');
    const ac = new AbortController();
    aborts.push(ac);
    const answer = engine.askUser(leaf.id, [{ question: 'Which inbox?', options: [{ label: 'Work' }, { label: 'Home' }] }], ac.signal);
    const q = ((await call(OWNER, 'GET', '/api/questions')).body as any[]).find((x) => x.sessionId === leaf.id);
    expect(q).toMatchObject({ rootSessionId: top.id, from: { sessionId: leaf.id, agent: 'email', label: 'Read the thread', chain: [mid.id, leaf.id] } });
    expect((await call(OWNER, 'POST', `/api/questions/${q.id}`, { answers: { 'Which inbox?': 'Home' } })).status).toBe(200);
    expect(await answer).toEqual({ 'Which inbox?': 'Home' });
  }, 30_000);

  test("a member cannot see or answer the owner's subagent, and the owner's lists hold none of the member's", async () => {
    const top = (await call(OWNER, 'POST', '/api/sessions', { title: 'Owner chat' })).body as Session;
    const email = subagentOf(top, 'ses_email_owner_2', 'email', 'Owner mail');
    const ac = new AbortController();
    aborts.push(ac);
    const pending = engine.requestApproval(email.id, { toolUseId: 'tu_mail2', tool: 'MailRead', input: { id: 'm2' }, summary: 'Read mail m2' }, ac.signal);
    const id = engine.pendingApprovals().find((a) => a.sessionId === email.id)!.id;

    expect((await call(alice.token, 'GET', '/api/approvals')).body.map((a: any) => a.id)).not.toContain(id);
    expect((await call(alice.token, 'POST', `/api/approvals/${id}`, { decision: 'allow' })).status).toBe(404);
    expect(engine.pendingApprovals().some((a) => a.id === id)).toBe(true);

    // alice's own subagent: hers to answer, never in the owner's list
    const mine = (await call(alice.token, 'POST', '/api/sessions', { title: 'Alice chat' })).body as Session;
    const hers = subagentOf(mine, 'ses_email_alice', 'email', 'Alice mail');
    const ac2 = new AbortController();
    aborts.push(ac2);
    const herAnswer = engine.requestApproval(hers.id, { toolUseId: 'tu_mail3', tool: 'MailRead', input: { id: 'm3' }, summary: 'Read mail m3' }, ac2.signal);
    const herId = engine.pendingApprovals(alice.accountId).find((a) => a.sessionId === hers.id)!.id;
    const aliceList = (await call(alice.token, 'GET', '/api/approvals')).body as any[];
    expect(aliceList.find((a) => a.id === herId)).toMatchObject({ rootSessionId: mine.id, from: { agent: 'email' } });
    expect((await call(OWNER, 'GET', '/api/approvals')).body.map((a: any) => a.id)).not.toContain(herId);
    expect((await call(OWNER, 'POST', `/api/approvals/${herId}`, { decision: 'deny' })).status).toBe(404);
    expect((await call(alice.token, 'POST', `/api/approvals/${herId}`, { decision: 'deny' })).status).toBe(200);
    expect((await herAnswer).decision).toBe('deny');

    ac.abort();
    expect((await pending).decision).toBe('deny');
  }, 30_000);
});
