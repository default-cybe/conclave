/**
 * Settings > Reflect's routes (routes-assistant.ts): the page and Settings >
 * Assistant set one switch, the time and model go on the same routine, and
 * Reflect now is the hub owner's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AssistantService, attachAssistant } from '@conclave/core/assistant/index.ts';
import { RateLimiter } from '../src/auth';
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
    new AssistantService({ db: e.repos.db, kv: e.repos.kv, repos: e.repos, memory: e.memoryStore, routines: e.routines, createTask: (input) => e.createTask(input, accountId), complete: async (o) => (calls.push({ accountId: accountId ?? 'owner', prompt: o.prompt }), JSON.stringify({ headline: 'A calm week.' })), ...(accountId ? { accountId } : {}) });
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
    await e.createSession({ kind: 'chat', title: 'Owner secret roadmap' });
    await e.createSession({ kind: 'chat', title: 'Mia garden planning' }, miaId);
    const mem = (id: string, content: string, account: string) =>
      e.repos.db.query(`INSERT INTO memories (id, scope, kind, content, tags, created_at, updated_at, account_id, meta) VALUES (?, 'global', 'fact', ?, '["person"]', ?, ?, ?, '{}')`).run(id, content, Date.now(), Date.now(), account);
    mem('owner-person', 'Omar: owner colleague', 'owner');
    mem('mia-person', 'Tara: gardening friend', miaId);

    const own = await asJson(await hub.api('/api/reflect/report?range=week'));
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ range: 'week', totals: { chats: 1 }, headline: 'A calm week.', insights: 'model' });
    expect(own.body.fun.newPeople).toEqual(['Omar']);
    expect(JSON.stringify(own.body)).not.toMatch(/Mia|garden|Tara/);
    expect(calls.at(-1)!.accountId).toBe('owner');

    // the owner has no way to ask for a member's report: any extra parameter still reads the caller's own
    const tried = await asJson(await hub.api(`/api/reflect/report?range=week&account=${miaId}`));
    expect(JSON.stringify(tried.body)).not.toMatch(/garden|Tara/);

    const hers = await asJson(await hub.api('/api/reflect/report/refresh?range=12m', { method: 'POST', token: mia }));
    expect(hers.status).toBe(200);
    expect(hers.body).toMatchObject({ range: '12m', totals: { chats: 1 } });
    expect(hers.body.fun.newPeople).toEqual(['Tara']);
    expect(JSON.stringify(hers.body)).not.toMatch(/roadmap|Omar/);
    expect(calls.at(-1)!.accountId).toBe(miaId);
    expect(calls.at(-1)!.prompt).toContain('garden');
    expect(calls.at(-1)!.prompt).not.toMatch(/roadmap|Omar/);

    expect((await hub.api('/api/reflect/report?range=decade')).status).toBe(400);
  });
});
