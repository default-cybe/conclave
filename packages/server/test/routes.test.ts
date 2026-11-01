import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ApiError, ConclaveClient } from '@conclave/core/client/index.ts';
import { ProviderError } from '@conclave/core/providers/types.ts';
import { OWNER, startHub, type TestHub } from './helpers';

let hub: TestHub;
let client: ConclaveClient;

beforeAll(() => {
  hub = startHub();
  client = new ConclaveClient({ baseUrl: hub.url, token: OWNER });
});
afterAll(() => hub.stop());

const status = (p: Promise<unknown>) => p.then(() => 200, (e: ApiError) => e.status);

describe('session routes via the typed client', () => {
  test('create, get, list, patch, messages, delete', async () => {
    const s = await client.createSession({ title: 'hello', cwd: '/srv' });
    expect(s.title).toBe('hello');
    expect((await client.getSession(s.id)).cwd).toBe('/srv');
    expect((await client.listSessions()).map((x) => x.id)).toContain(s.id);
    const patched = await client.updateSession(s.id, { title: 'renamed', pinned: true });
    expect(patched.title).toBe('renamed');
    const sent = await client.send(s.id, { text: 'hi there' });
    expect(sent.queued).toBe(false);
    const msgs = await client.messages(s.id);
    expect(msgs).toHaveLength(1);
    expect(await client.messages(s.id, { afterSeq: msgs[0].seq })).toHaveLength(0);
    expect(await client.messages(s.id, { limit: 1 })).toEqual(msgs);
    expect(await client.messages(s.id, { beforeSeq: msgs[0].seq, limit: 1 })).toHaveLength(0);
    expect(await status(client.messages(s.id, { limit: 0 }))).toBe(400);
    expect(await status(client.messages(s.id, { limit: 1.5 }))).toBe(400);
    expect((await client.search('there'))[0].sessionId).toBe(s.id);
    await client.deleteSession(s.id);
    expect(await status(client.getSession(s.id))).toBe(404);
  });

  test('trim=1 cuts blocks over 100 KB; the block route gives each back in full', async () => {
    const s = await client.createSession({ title: 'big', cwd: '/srv' });
    const big = 'x'.repeat(300_000);
    const image = { type: 'image' as const, mediaType: 'image/png', data: 'A'.repeat(200_000) };
    const content = [
      { type: 'text' as const, text: 'small' },
      { type: 'tool_result' as const, toolUseId: 'tu_1', content: [{ type: 'text' as const, text: 'shot' }, image] },
      { type: 'tool_result' as const, toolUseId: 'tu_2', content: big },
    ];
    hub.engine.repos.messages.insert({ id: 'msg_big', sessionId: s.id, seq: 1, role: 'user', kind: 'normal', content, createdAt: Date.now() });

    // untouched without trim: the apps that do not ask see what they always did
    expect((await client.messages(s.id))[0].content).toEqual(content);

    const [m] = await client.messages(s.id, { trim: true, limit: 50 });
    for (const b of m.content) expect(JSON.stringify(b).length).toBeLessThanOrEqual(100_100);
    expect(m.content[0]).toEqual(content[0]);
    expect(m.content[1]).toEqual({ type: 'tool_result', toolUseId: 'tu_1', content: [{ type: 'text', text: 'shot' }, { type: 'image', mediaType: 'image/png' }] });
    expect(m.meta?.trimmed).toEqual([1, 2].map((index) => ({ index, bytes: JSON.stringify(content[index]).length })));

    for (const i of [0, 1, 2]) expect(await client.messageBlock(s.id, m.id, i)).toEqual(content[i]);
    expect(await status(client.messageBlock(s.id, m.id, 3))).toBe(404);
    expect(await status(client.messageBlock(s.id, 'msg_nope', 0))).toBe(404);
    const other = await client.createSession({ title: 'other', cwd: '/srv' });
    expect(await status(client.messageBlock(other.id, m.id, 0))).toBe(404);
  });

  test('unknown session is 404 on every session route', async () => {
    expect(await status(client.getSession('ses_nope'))).toBe(404);
    expect(await status(client.send('ses_nope', { text: 'x' }))).toBe(404);
    expect(await status(client.abort('ses_nope'))).toBe(404);
    expect(await status(client.todos('ses_nope'))).toBe(404);
    expect(await status(client.updateSession('ses_nope', { title: 'x' }))).toBe(404);
    expect(await status(client.deleteSession('ses_nope'))).toBe(404);
    expect(await status(client.exportSession('ses_nope'))).toBe(404);
  });

  test('bad input is 400', async () => {
    const s = await client.createSession({});
    expect(await status(client.request('POST', `/api/sessions/${s.id}/messages`, { nope: 1 }))).toBe(400);
    expect(await status(client.request('POST', `/api/sessions/${s.id}/rewind`, {}))).toBe(400);
    expect(await status(client.request('POST', `/api/sessions/${s.id}/handoff`, {}))).toBe(400);
    const raw = await hub.api(`/api/sessions/${s.id}/messages`, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    expect(raw.status).toBe(400);
    expect((await raw.json()).error).toBe('invalid JSON body');
    expect(await status(client.request('GET', '/api/sessions', undefined, { limit: 'abc' }))).toBe(400);
  });

  test("a model provider's 401 is not the hub's 401", async () => {
    const s = await client.createSession({});
    const real = hub.engine.secondOpinion;
    hub.engine.secondOpinion = async () => {
      throw new ProviderError('auth', 'openai: invalid x-api-key', { status: 401 });
    };
    try {
      const res = await hub.api(`/api/sessions/${s.id}/second-opinion`, { method: 'POST', json: {} });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe('openai: invalid x-api-key');
    } finally {
      hub.engine.secondOpinion = real;
    }
  });

  test('session actions reach the engine', async () => {
    const s = await client.createSession({});
    await client.abort(s.id);
    await client.rewind(s.id, 3, true);
    await client.secondOpinion(s.id, { reviewer: 'openai/gpt-5.5' });
    expect((await client.handoff(s.id, 'zai/glm-5')).model).toBe('zai/glm-5');
    await client.compact(s.id);
    expect((await client.command(s.id, '/status')).output).toBe('ran /status');
    expect(await client.todos(s.id)).toHaveLength(1);
    expect(await client.checkpoints(s.id)).toEqual([]);
    expect(await client.diff(s.id)).toEqual({ diff: '', files: [] });
    expect((await client.exportSession(s.id, 'json')).filename).toBe('New-chat.json');
    expect((await client.forkSession(s.id, 2)).parentId).toBe(s.id);
    expect(await status(client.restoreCheckpoint(s.id, 'cp_nope'))).toBe(404);
    const methods = hub.engine.calls.map((c) => c.method);
    for (const m of ['abort', 'rewind', 'secondOpinion', 'handoff', 'compact', 'command', 'forkSession']) expect(methods).toContain(m);
    expect(hub.engine.calls.find((c) => c.method === 'rewind')!.args).toEqual([s.id, 3, true]);
  });

  test('a switch takes { model, brief }, and its price comes before it', async () => {
    const s = await client.createSession({});
    await client.handoff(s.id, 'zai/glm-5');
    await client.handoff(s.id, 'anthropic/claude-sonnet-5-5', { brief: true });
    const handoffs = hub.engine.calls.filter((c) => c.method === 'handoff').map((c) => c.args);
    expect(handoffs.at(-2)).toEqual([s.id, 'zai/glm-5', {}]);
    expect(handoffs.at(-1)).toEqual([s.id, 'anthropic/claude-sonnet-5-5', { brief: true }]);
    expect((await hub.api(`/api/sessions/${s.id}/handoff`, { method: 'POST', json: { model: 'x/y', brief: 'yes' } })).status).toBe(400);
    const est = await client.switchEstimate(s.id, 'anthropic/claude-sonnet-5-5');
    expect(est).toMatchObject({ to: 'anthropic/claude-sonnet-5-5', confirm: true, full: { onceUsd: 0.4, paybackReplies: 9 }, brief: { onceUsd: 0.145, paybackReplies: 3 } });
    expect(hub.engine.calls.at(-1)).toEqual({ method: 'switchEstimate', args: [s.id, 'anthropic/claude-sonnet-5-5'] });
    expect((await hub.api(`/api/sessions/${s.id}/switch-estimate`)).status).toBe(400);
  });

  test('list filters map from the query string', async () => {
    await client.listSessions({ archived: false, parentId: 'none', limit: 5, agent: 'assistant' });
    const last = hub.engine.calls.filter((c) => c.method === 'listSessions').at(-1)!;
    expect(last.args[0]).toMatchObject({ archived: false, parentId: null, limit: 5, agent: 'assistant' });
  });
});

describe('other routes', () => {
  test('tasks', async () => {
    const t = await client.createTask({ title: 'write tests' });
    expect((await client.tasks()).map((x) => x.id)).toContain(t.id);
    expect((await client.updateTask(t.id, { status: 'doing' })).status).toBe('doing');
    const s = await client.startTask(t.id);
    expect(s.title).toBe('write tests');
    await client.deleteTask(t.id);
    expect(await status(client.updateTask(t.id, { status: 'done' }))).toBe(404);
    expect(await status(client.createTask({} as never))).toBe(400);
  });

  test('routines, preview and webhook trigger', async () => {
    const r = await client.createRoutine({ name: 'brief', schedule: '0 8 * * *', prompt: 'morning' });
    expect((await client.routines()).map((x) => x.id)).toContain(r.id);
    expect((await client.previewSchedule('0 8 * * *')).next).toHaveLength(1);
    expect((await client.previewSchedule('bad')).error).toBe('invalid schedule');
    expect(await status(client.createRoutine({ name: 'x', schedule: 'bad', prompt: 'y' }))).toBe(400);
    await client.runRoutine(r.id);

    // webhook: no bearer, routine secret in header or query
    const noSecret = await hub.api(`/api/routines/${r.id}/trigger`, { method: 'POST', token: null, body: 'x' });
    expect(noSecret.status).toBe(401);
    const wrong = await hub.api(`/api/routines/${r.id}/trigger?secret=nope`, { method: 'POST', token: null, body: 'x' });
    expect(wrong.status).toBe(401);
    const ok = await hub.api(`/api/routines/${r.id}/trigger`, { method: 'POST', token: null, headers: { 'x-conclave-secret': 'hook-secret' }, body: 'build failed on main' });
    expect(ok.status).toBe(200);
    const ok2 = await hub.api(`/api/routines/${r.id}/trigger?secret=hook-secret`, { method: 'POST', token: null, body: '' });
    expect(ok2.status).toBe(200);
    expect(hub.engine.routineRuns).toEqual([
      { id: r.id, trigger: 'manual', extra: undefined },
      { id: r.id, trigger: 'webhook', extra: 'build failed on main' },
      { id: r.id, trigger: 'webhook', extra: undefined },
    ]);
    await client.updateRoutine(r.id, { enabled: false });
    const disabled = await hub.api(`/api/routines/${r.id}/trigger?secret=hook-secret`, { method: 'POST', token: null });
    expect(disabled.status).toBe(409);
    await client.deleteRoutine(r.id);
    expect(await status(client.runRoutine(r.id))).toBe(404);
  });

  test('memory', async () => {
    const m = await client.saveMemory({ content: 'likes short answers', kind: 'profile' });
    expect((await client.memories()).map((x) => x.id)).toContain(m.id);
    expect((await client.searchMemory('short'))[0].id).toBe(m.id);
    expect((await client.updateMemory(m.id, { content: 'likes very short answers' })).content).toBe('likes very short answers');
    expect((await client.memoryStats()).total).toBe(1);
    expect(await status(client.saveMemory({ content: 'x', kind: 'nope' as never }))).toBe(400);
    await client.deleteMemory(m.id);
    expect(await status(client.deleteMemory(m.id))).toBe(404);
  });

  test('extensions, models, usage, config, notify, audit', async () => {
    expect((await client.models())[0].provider).toBe('anthropic');
    expect((await client.testProvider('anthropic')).ok).toBe(true);
    expect(await status(client.testProvider('nope'))).toBe(404);
    const saved = await client.saveAgent({ name: 'reviewer', description: 'reviews', prompt: 'review it' });
    expect(saved.source).toBe('user');
    expect((await client.agents()).map((a) => a.name)).toContain('reviewer');
    await client.deleteAgent('reviewer');
    expect(await status(client.deleteAgent('reviewer'))).toBe(404);
    await client.reloadExtensions();
    expect((await client.syncToClis('local')).written).toEqual(['~/.claude/agents/x.md']);
    expect((await client.usage({ from: 0 })).totals.calls).toBe(0);
    for (const id of ['use_a', 'use_b']) hub.engine.repos.usage.insert({ id, ts: Date.now(), source: 'gateway', provider: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0 });
    expect(await (await hub.api('/api/usage/recent?limit=1')).json()).toHaveLength(1);
    // the cap holds for a negative limit too
    expect(await (await hub.api('/api/usage/recent?limit=-1')).json()).toHaveLength(0);
    expect(await client.limits()).toEqual([]);

    await client.updateConfig({ defaultModel: 'zai/glm-5' });
    expect(hub.engine.config.get().defaultModel).toBe('zai/glm-5');
    await client.setSecret('providers', 'zai', 'secret-key');
    expect((await client.config()).secrets.providers).toContain('zai');
    // a key from the hub's environment counts as set, though nothing is stored
    const envBefore = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'env-key';
    try {
      const { secrets } = await client.config();
      expect(secrets.keyed).toEqual(expect.arrayContaining(['zai', 'openrouter']));
      expect(secrets.providers).not.toContain('openrouter');
    } finally {
      if (envBefore === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = envBefore;
    }
    expect(await status(client.request('PATCH', '/api/config', { server: { token: 'short' } }))).toBe(400);
    // browser engines: a known engine and a sha256 pin pass, anything else is refused before it is saved
    await client.updateConfig({ browser: { profiles: { stealth: { engine: 'cloak' } }, cloak: { executablePath: '/opt/cloak/chrome', sha256: 'a'.repeat(64) } } } as never);
    expect(hub.engine.config.get().browser.profiles?.stealth?.engine).toBe('cloak');
    expect(await status(client.request('PATCH', '/api/config', { browser: { profiles: { stealth: { engine: 'firefox' } } } }))).toBe(400);
    expect(await status(client.request('PATCH', '/api/config', { browser: { cloak: { sha256: 'abc' } } }))).toBe(400);
    expect(hub.engine.config.get().browser.cloak?.sha256).toBe('a'.repeat(64));

    expect(await client.notifyChannels()).toEqual([{ id: 'webpush', enabled: true }]);
    await client.testNotify();
    await client.testNotify('webpush', { endpoint: 'https://push.example/x' });
    expect(hub.engine.calls.filter((x) => x.method === 'notifier.test').map((x) => x.args)).toEqual([
      ['webpush', { accountId: 'owner' }],
      ['webpush', { endpoint: 'https://push.example/x', accountId: 'owner' }],
    ]);
    expect(await status(client.testNotify('telegram'))).toBe(404);
    expect(await status(client.request('POST', '/api/notify/test', { endpoint: 5 }))).toBe(400);
    expect((await client.vapidKey()).publicKey).toBe('vapid-public');
    await client.pushSubscribe({ endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } }, 'Safari on iOS');
    expect(await status(client.pushSubscribe({ endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } }))).toBe(400);
    await client.pushUnsubscribe('https://push.example/x');
    expect(hub.engine.calls.find((x) => x.method === 'notifier.removePushSubscription')?.args).toEqual(['https://push.example/x']);
    expect(await client.notifyDevices()).toEqual([{ id: 'a1b2c3d4e5f60718', name: 'Safari on iOS', kind: 'webpush', createdAt: 1 }]);
    await client.removeNotifyDevice('a1b2c3d4e5f60718');
    expect(await status(client.removeNotifyDevice('ffff'))).toBe(404);
    // the routes that only served UnifiedPush are gone
    expect(await status(client.request('POST', '/api/notify/unifiedpush', { endpoint: 'https://ntfy.sh/up123' }))).toBe(404);
    expect((await client.audit({ limit: 50 })).some((a) => a.action === 'config.update')).toBe(true);
  });

  test('devices: list, browse, patch, delete', async () => {
    const devices = await client.devices();
    expect(devices[0].id).toBe('local');
    await hub.engine.devices.get('local')!.writeFile('/home/me/notes.md', '# hi');
    const files = await client.browse('local', '/home/me');
    expect(files.map((f) => f.name)).toContain('notes.md');
    expect((await client.readDeviceFile('local', '/home/me/notes.md')).content).toBe('# hi');
    expect(await status(client.browse('dev_nope', '/'))).toBe(404);
    hub.engine.repos.devices.insert({ id: 'dev_off', name: 'Old PC', tokenHash: 'x' });
    expect(await status(client.browse('dev_off', '/'))).toBe(409);
    expect((await client.updateDevice('dev_off', { name: 'Older PC', roots: ['/code'] })).name).toBe('Older PC');
    expect(await status(client.updateDevice('local', { roots: ['/code'] }))).toBe(400);
    await client.deleteDevice('dev_off');
    expect((await client.devices()).map((d) => d.id)).not.toContain('dev_off');
    expect(await status(client.deleteDevice('dev_off'))).toBe(404);
  });

  test('devices: only the owner renames the hub device, and every client sees the new name', async () => {
    const events: string[] = [];
    const off = hub.engine.bus.on((e) => {
      if (e.type === 'device.updated' && e.device.id === 'local') events.push(e.device.name);
    });
    const hostName = (await client.devices())[0].name;
    // a paired client may not
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
    const phone = new ConclaveClient({ baseUrl: hub.url });
    phone.token = (await phone.pair(pairing.code, 'Phone', 'ios')).token;
    expect(await status(phone.updateDevice('local', { name: 'Mine now' }))).toBe(403);
    // the owner may, with a name of 1 to 64 characters
    expect(await status(client.updateDevice('local', { name: '   ' }))).toBe(400);
    expect(await status(client.updateDevice('local', { name: 'x'.repeat(65) }))).toBe(400);
    const renamed = await client.updateDevice('local', { name: '  Home server ' });
    expect(renamed).toMatchObject({ id: 'local', name: 'Home server', online: true });
    expect((await phone.devices())[0].name).toBe('Home server');
    expect(events).toEqual(['Home server']);
    expect((await client.audit({ limit: 20 })).some((a) => a.action === 'device.update' && a.detail === 'local')).toBe(true);
    off();
    await client.updateDevice('local', { name: hostName });
  });

  test('gateway keys: create, list, revoke', async () => {
    const k = await client.createGatewayKey('codex', { agent: 'codex' });
    expect(k.key).toStartWith('cgw_');
    expect(k.prefix).toBe(k.key.slice(0, 10));
    const list = await client.gatewayKeys();
    expect(list.find((x) => x.id === k.id)).toMatchObject({ name: 'codex', revoked: false });
    expect(JSON.stringify(list)).not.toContain(k.key);
    await client.revokeGatewayKey(k.id);
    expect((await client.gatewayKeys()).find((x) => x.id === k.id)?.revoked).toBe(true);
  });

  test('unknown API route is a JSON 404', async () => {
    const res = await hub.api('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});
