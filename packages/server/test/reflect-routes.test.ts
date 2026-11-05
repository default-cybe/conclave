/**
 * Settings > Reflect's routes (routes-assistant.ts): the page and Settings >
 * Assistant set one switch, the time and model go on the same routine, and
 * Reflect now is the hub owner's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AssistantService, attachAssistant } from '@conclave/core/assistant/index.ts';
import { RateLimiter } from '../src/auth';
import { accountKv } from '@conclave/core/people/scoped.ts';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
/** Summarise calls the fake model got: whose account and what it read. */
const calls: Array<{ accountId: string; prompt: string }> = [];
beforeAll(() => {
  hub = startHub();
  (hub.running.conclave.ctx as { pairLimiter: RateLimiter }).pairLimiter = new RateLimiter(1000, 60_000);
  // the fake engine has no assistant: a real one over its database, memory and routines, as engine/create.ts attaches it
  const e = hub.engine;
  const make = (accountId?: string) =>
    new AssistantService({ db: e.repos.db, kv: accountKv(e.repos.kv, accountId ?? 'owner'), repos: e.repos, memory: accountId ? e.memoryFor(accountId) : e.memoryStore, routines: e.routines, createTask: (input) => e.createTask(input, accountId), complete: async (o) => (calls.push({ accountId: accountId ?? 'owner', prompt: o.prompt }), JSON.stringify({ headline: 'A calm week.' })), ...(accountId ? { accountId } : {}) });
  attachAssistant(e, make(), (id) => make(id));
});
afterAll(() => hub.stop());

const asJson = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => undefined)) as any });

describe('Settings > Reflect', () => {
  test('one switch with Settings > Assistant, and the time and model on the same routine', async () => {
    const first = await asJson(await hub.api('/api/assistant/reflect'));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ enabled: false, time: '02:40', notes: [] });

    const on = await asJson(await hub.api('/api/assistant/reflect', { method: 'PUT', json: { enabled: true, time: '03:10', model: 'fast' } }));
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, time: '03:10', model: 'fast' });
    const settings = await asJson(await hub.api('/api/assistant'));
    expect(settings.body.reflection).toMatchObject({ enabled: true, schedule: '10 3 * * *', model: 'fast', routineId: on.body.routineId });

    // off from Settings > Assistant: Reflect reads off
    await hub.api('/api/assistant/reflection', { method: 'PUT', json: { enabled: false } });
    expect((await asJson(await hub.api('/api/assistant/reflect'))).body.enabled).toBe(false);

    const bad = await asJson(await hub.api('/api/assistant/reflect', { method: 'PUT', json: { time: '3pm' } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('HH:MM');
  });

  test('Reflect now is the owner\'s; with no chats it calls no model', async () => {
    const now = await asJson(await hub.api('/api/assistant/reflect/run', { method: 'POST', json: {} }));
    expect(now.status).toBe(200);
    expect(now.body.skipped).toBe('No chats since the last reflection');
    expect(now.body.run).toBeUndefined();

    const made = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'rosa', password: 'a long enough password' } }));
    expect(made.status).toBe(200);
    const login = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'rosa', password: 'a long enough password', name: 'phone' } }));
    const rosa = login.body.token as string;
    expect((await hub.api('/api/assistant/reflect/run', { method: 'POST', token: rosa, json: {} })).status).toBe(403);
    // her own page and switch are hers
    const mine = await asJson(await hub.api('/api/assistant/reflect', { token: rosa }));
    expect(mine.status).toBe(200);
    expect(mine.body.enabled).toBe(false);
  });
});

describe('Reflect report', () => {
  test('each account reads only its own report, and the model pass reads only its own data on its own account', async () => {
    const e = hub.engine;
    const made = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'mia', password: 'a long enough password' } }));
    const miaId = made.body.person.id as string;
    const login = await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'mia', password: 'a long enough password', name: 'phone' } }));
    const mia = login.body.token as string;
    // three chats with two typed messages each: enough for the model pass (a thin range makes none)
    const chats = async (title: string, account?: string) => {
      for (const n of [1, 2, 3]) {
        const s = await e.createSession({ kind: 'chat', title: `${title} ${n}` }, account);
        for (const seq of [1, 2]) e.repos.messages.insert({ id: `msg_${s.id}_${seq}`, sessionId: s.id, seq, role: 'user', kind: 'normal', content: [{ type: 'text', text: `step ${seq}` }], createdAt: Date.now() } as never);
      }
    };
    await chats('Owner secret roadmap');
    await chats('Mia garden planning', miaId);
    const mem = (id: string, content: string, account: string) =>
      e.repos.db.query(`INSERT INTO memories (id, scope, kind, content, tags, created_at, updated_at, account_id, meta) VALUES (?, 'global', 'fact', ?, '["person"]', ?, ?, ?, '{}')`).run(id, content, Date.now(), Date.now(), account);
    mem('owner-person', 'Omar: owner colleague', 'owner');
    mem('mia-person', 'Tara: gardening friend', miaId);

    const own = await asJson(await hub.api('/api/reflect/report?range=week'));
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ range: 'week', totals: { chats: 3 }, headline: 'A calm week.', insights: 'model' });
    expect(own.body.fun.newPeople).toEqual(['Omar']);
    expect(JSON.stringify(own.body)).not.toMatch(/Mia|garden|Tara/);
    expect(calls.at(-1)!.accountId).toBe('owner');

    // the owner has no way to ask for a member's report: any extra parameter still reads the caller's own
    const tried = await asJson(await hub.api(`/api/reflect/report?range=week&account=${miaId}`));
    expect(JSON.stringify(tried.body)).not.toMatch(/garden|Tara/);

    const hers = await asJson(await hub.api('/api/reflect/report/refresh?range=12m', { method: 'POST', token: mia }));
    expect(hers.status).toBe(200);
    expect(hers.body).toMatchObject({ range: '12m', totals: { chats: 3 } });
    expect(hers.body.fun.newPeople).toEqual(['Tara']);
    expect(JSON.stringify(hers.body)).not.toMatch(/roadmap|Omar/);
    expect(calls.at(-1)!.accountId).toBe(miaId);
    expect(calls.at(-1)!.prompt).toContain('garden');
    expect(calls.at(-1)!.prompt).not.toMatch(/roadmap|Omar/);

    expect((await hub.api('/api/reflect/report?range=decade')).status).toBe(400);
  });
});

describe('Reflect learnings', () => {
  test('each account sees and saves only its own queue; nothing is written before Save', async () => {
    const e = hub.engine;
    const made = await asJson(await hub.api('/api/people', { method: 'POST', json: { name: 'lea', password: 'a long enough password' } }));
    const leaId = made.body.person.id as string;
    const lea = (await asJson(await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'lea', password: 'a long enough password', name: 'phone' } }))).body.token as string;
    const item = (id: string, fact: string) => ({ id, kind: 'preference', fact, rule: fact, quote: fact, confidence: 0.9, count: 1, sessionId: 's', status: 'pending', createdAt: 1, updatedAt: 1 });
    accountKv(e.repos.kv, 'owner').set('learn.queue', [item('lrn_owner', 'The user prefers dark roast coffee.')]);
    accountKv(e.repos.kv, leaId).set('learn.queue', [item('lrn_lea', 'The user prefers green tea.')]);

    const own = await asJson(await hub.api('/api/reflect/learnings'));
    expect(own.status).toBe(200);
    expect(own.body.items.map((i: { id: string }) => i.id)).toEqual(['lrn_owner']);
    expect((await asJson(await hub.api('/api/reflect/learnings/count', { token: lea }))).body).toEqual({ pending: 1 });
    const hers = await asJson(await hub.api('/api/reflect/learnings', { token: lea }));
    expect(JSON.stringify(hers.body)).not.toContain('coffee');

    // another account's id is unknown here; a bad target is refused
    expect((await hub.api('/api/reflect/learnings/lrn_owner/save', { method: 'POST', token: lea, json: { target: 'memory' } })).status).toBe(404);
    expect((await hub.api('/api/reflect/learnings/lrn_owner/save', { method: 'POST', json: { target: 'disk' } })).status).toBe(400);

    const before = e.memoryStore.stats().total;
    const preview = await asJson(await hub.api('/api/reflect/learnings/lrn_owner/preview', { method: 'POST', json: { target: 'memory' } }));
    expect(preview.body).toMatchObject({ target: 'memory', text: 'The user prefers dark roast coffee.' });
    expect(e.memoryStore.stats().total).toBe(before);
    const saved = await asJson(await hub.api('/api/reflect/learnings/lrn_owner/save', { method: 'POST', json: { target: 'memory' } }));
    expect(saved.status).toBe(200);
    expect(saved.body.pending).toBe(0);
    expect(e.memoryStore.stats().total).toBe(before + 1);
    expect(e.memoryFor(leaId).list().some((m) => m.content.includes('coffee'))).toBe(false);
    expect((await hub.api('/api/reflect/learnings/lrn_lea/skip', { method: 'POST', token: lea })).status).toBe(200);
    expect(e.memoryFor(leaId).list().some((m) => m.content.includes('tea'))).toBe(false);
  });
});
