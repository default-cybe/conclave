import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import type { ConclaveConfig } from '@conclave/core/config/index.ts';
import { ConclaveClient, type HubBackup } from '@conclave/core/client/index.ts';
import { startHub, type TestHub } from './helpers';

// a tiny upstream that answers every model call with a fixed JSON body
let upstream: Server<undefined>;
let hub: TestHub;
let gwKey = '';

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path.includes('/messages')) return Response.json({ id: 'msg_1', type: 'message', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } });
      return Response.json({ id: 'c1', object: 'chat.completion', model: 'gpt-test', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    },
  });
  const base = `http://127.0.0.1:${upstream.port}`;
  hub = startHub({}, {
    providers: {
      anthropic: { type: 'anthropic', baseUrl: base, apiKey: 'sk-upstream-anthropic' },
      openai: { type: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-upstream-openai' },
    },
  } as unknown as Partial<ConclaveConfig>);
  gwKey = (await hub.api('/api/gateway/keys', { method: 'POST', json: { name: 'arch-desktop claude-code' } }).then((r) => r.json())).key;
});

afterAll(async () => {
  await hub.stop();
  upstream.stop(true);
});

async function pairedToken(): Promise<string> {
  const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
  const paired = await new ConclaveClient({ baseUrl: hub.url }).pair(pairing.code, 'iPhone', 'ios');
  return paired.token;
}

describe('GET /api/backup and POST /api/restore', () => {
  test('the backup downloads as a JSON file without keys', async () => {
    hub.engine.config.update({ search: { provider: 'brave', apiKey: 'brv-secret' } });
    hub.engine.config.setSecret('providers', 'zai', 'zai-secret-key');
    const s = await hub.engine.createSession({ title: 'Suspend broken after kernel 6.17' });
    const res = await hub.api('/api/backup');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="conclave-backup-test-hub-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await res.text();
    expect(text).not.toContain('brv-secret');
    expect(text).not.toContain('zai-secret-key');
    expect(text).not.toContain('sk-upstream-anthropic');
    const b = JSON.parse(text) as HubBackup;
    expect(b.format).toBe('conclave-backup');
    expect(b.includesSecrets).toBe(false);
    expect(b.secretNames.providers).toContain('zai');
    expect(b.sessions.map((x) => x.id)).toContain(s.id);
    expect(b.redacted).toContain('providers.anthropic.apiKey');

    const noSessions = (await hub.api('/api/backup?sessions=0').then((r) => r.json())) as HubBackup;
    expect(noSessions.sessions).toEqual([]);

    const audit = hub.engine.repos.audit.list({ limit: 5 }).map((a) => a.action);
    expect(audit).toContain('backup.download');
  });

  test('keys come out only for the owner token', async () => {
    const withKeys = (await hub.api('/api/backup?secrets=1').then((r) => r.json())) as HubBackup;
    expect(withKeys.includesSecrets).toBe(true);
    expect(withKeys.secrets?.providers.zai).toBe('zai-secret-key');

    const token = await pairedToken();
    const phone = await hub.api('/api/backup?secrets=1', { token });
    expect(phone.status).toBe(403);
    expect((await phone.json()).error).toContain('Only the owner token can put keys in a backup');
    expect((await hub.api('/api/backup', { token })).status).toBe(200);
  });

  test('restore answers with what it added and refuses other files', async () => {
    const file = (await hub.api('/api/backup').then((r) => r.json())) as HubBackup;
    file.sessions.push({ ...file.sessions[0], id: 'ses_from_backup', title: 'Rust or Go for the device daemon', status: 'running' });
    const res = await hub.api('/api/restore', { method: 'POST', json: file });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.restored.sessions).toBe(1);
    expect(r.skipped.sessions).toBe(file.sessions.length - 1);
    expect(r.config).toBe(true);
    expect(hub.engine.getSession('ses_from_backup')?.status).toBe('idle');

    const skipConfig = await hub.api('/api/restore?config=0', { method: 'POST', json: file }).then((x) => x.json());
    expect(skipConfig.config).toBe(false);

    const bad = await hub.api('/api/restore', { method: 'POST', json: { hello: 'world' } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('This is not a Conclave backup');
    const notJson = await hub.api('/api/restore', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } });
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error).toContain('not valid JSON');
  });
});

describe('gateway routes can be turned off one by one', () => {
  const call = (path: string, body: unknown) => fetch(`${hub.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': gwKey, authorization: `Bearer ${gwKey}` }, body: JSON.stringify(body) });

  test('an off route answers 403 in the shape its SDK expects; the others keep working', async () => {
    expect((await call('/gw/anthropic/v1/messages', { model: 'claude-test', max_tokens: 5, messages: [] })).status).toBe(200);

    expect((await hub.api('/api/config', { method: 'PATCH', json: { gateway: { routes: { anthropic: false } } } })).status).toBe(200);
    const off = await call('/gw/anthropic/v1/messages', { model: 'claude-test', max_tokens: 5, messages: [] });
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ type: 'error', error: { type: 'permission_error', message: 'The /gw/anthropic gateway route is off on this hub. Turn it on in Settings, Gateway keys.' } });
    expect((await call('/gw/openai/v1/chat/completions', { model: 'gpt-test', messages: [] })).status).toBe(200);

    await hub.api('/api/config', { method: 'PATCH', json: { gateway: { routes: { anthropic: true, provider: false } } } });
    expect((await call('/gw/anthropic/v1/messages', { model: 'claude-test', max_tokens: 5, messages: [] })).status).toBe(200);
    const byId = await call('/gw/p/openai/v1/chat/completions', { model: 'gpt-test', messages: [] });
    expect(byId.status).toBe(403);
    expect((await byId.json()).error.message).toContain('/gw/p/<provider>');
  });
});
