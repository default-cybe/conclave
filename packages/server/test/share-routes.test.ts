/**
 * GET /api/sessions/:id/export and /bundle: the default export is the
 * sanitized copy (core session/share.ts), the raw rows are for the owner
 * token only, and a bundle carries the hub key's signature.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConclaveClient } from '@conclave/core/client/index.ts';
import type { ConclaveBundle } from '@conclave/core/client/share.ts';
import { verifyBundle } from '@conclave/core/session/share.ts';
import { reminder } from '@conclave/core/session/transcript.ts';
import type { Message, Session } from '@conclave/core/types.ts';
import { OWNER, startHub, type TestHub } from './helpers';

let hub: TestHub;
let phone: string;
const TOKEN = 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8';

beforeAll(() => {
  hub = startHub();
  phone = hub.running.conclave.ctx.auth.clients.create({ name: 'Phone' }).token;
  const now = Date.now();
  const base: Session = {
    id: 'ses_share', title: 'Fix the deploy', agent: 'coder', model: 'anthropic/claude-sonnet-5-5', mode: 'agent', permissionMode: 'default', cwd: '/home/me/app', device: 'local',
    status: 'idle', tags: [], pinned: false, archived: false, createdAt: now, updatedAt: now,
    stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0.4 },
  };
  hub.engine.repos.sessions.insert(base);
  hub.engine.repos.sessions.insert({ ...base, id: 'ses_sub', parentId: 'ses_share', title: 'Look around' });
  const add = (m: Omit<Message, 'createdAt'>) => hub.engine.repos.messages.insert({ ...m, createdAt: now });
  add({ id: 'm1', sessionId: 'ses_share', seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: `Deploy /home/me/app with ${TOKEN}` }, reminder('Relevant memories:\n- [mem_1] The owner banks with Example Bank')], meta: { recalled: ['mem_1'] } });
  add({ id: 'm2', sessionId: 'ses_share', seq: 2, role: 'assistant', kind: 'normal', content: [{ type: 'thinking', thinking: 'private chain', signature: 'sig' }, { type: 'tool_use', id: 'tu1', name: 'Task', input: { prompt: 'look in /home/me/app/src' } }] });
  add({ id: 'm3', sessionId: 'ses_share', seq: 3, role: 'user', kind: 'normal', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'found /home/me/app/src/deploy.ts', meta: { sessionId: 'ses_sub' } }] });
  add({ id: 'm4', sessionId: 'ses_sub', seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'look in /home/me/app/src' }] });
});
afterAll(() => hub.stop());

const LEAKS = ['system-reminder', 'Example Bank', 'mem_1', TOKEN, '/home/me', 'private chain'];

describe('GET /api/sessions/:id/export', () => {
  test('markdown and JSON are sanitized by default, for the owner and paired apps', async () => {
    for (const token of [OWNER, phone]) {
      const client = new ConclaveClient({ baseUrl: hub.url, token });
      const md = await client.exportSession('ses_share', 'md');
      expect(md.filename).toBe('Fix-the-deploy.md');
      expect(md.content).toContain('Deploy . with [redacted]');
      for (const bad of LEAKS) expect(md.content).not.toContain(bad);
      expect(md.report?.reminders).toBe(1);
      const json = await client.exportSession('ses_share', 'json');
      for (const bad of LEAKS) expect(json.content).not.toContain(bad);
      expect(JSON.parse(json.content).format).toBe('conclave-export');
    }
  });

  test('?thinking=1 keeps the thinking text, without its signature', async () => {
    const res = await hub.api('/api/sessions/ses_share/export?format=json&thinking=1');
    const body = await res.json();
    expect(body.content).toContain('private chain');
    expect(body.content).not.toContain('"signature"');
  });

  test('?raw=1 is the stored rows, for the owner token only', async () => {
    const res = await hub.api('/api/sessions/ses_share/export?format=json&raw=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain('Example Bank');
    expect(body.content).toContain('/home/me/app');
    expect(body.report).toBeUndefined();
    expect(hub.engine.repos.audit.list({ sessionId: 'ses_share' }).some((a) => a.action === 'session.export.raw')).toBe(true);

    const refused = await hub.api('/api/sessions/ses_share/export?format=md&raw=1', { token: phone });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain('owner token');
  });

  test('a bad switch is a 400, an unknown session a 404', async () => {
    expect((await hub.api('/api/sessions/ses_share/export?raw=maybe')).status).toBe(400);
    expect((await hub.api('/api/sessions/ses_nope/export')).status).toBe(404);
  });
});

describe('GET /api/sessions/:id/bundle', () => {
  test('a signed bundle of the session and its subagent, for the owner and paired apps', async () => {
    const identity = await (await hub.api('/api/identity?nonce=' + 'n'.repeat(24), { token: null })).json();
    for (const token of [OWNER, phone]) {
      const res = await hub.api('/api/sessions/ses_share/bundle', { token });
      expect(res.status).toBe(200);
      const bundle = (await res.json()) as ConclaveBundle;
      expect(bundle.from.fingerprint).toBe(identity.fingerprint);
      expect(bundle.sessions.map((s) => s.id)).toEqual(['ses_share', 'ses_sub']);
      const text = JSON.stringify(bundle);
      for (const bad of [...LEAKS, '"cwd"', '"device"', 'costUsd']) expect(text).not.toContain(bad);
      expect(verifyBundle(bundle, { fingerprint: identity.fingerprint })).toEqual({ ok: true, fingerprint: identity.fingerprint });
      bundle.sessions[0].title = 'Fix the deploy!';
      expect(verifyBundle(bundle).ok).toBe(false);
    }
  });

  test('switches reach the bundle; unknown sessions are a 404', async () => {
    const client = new ConclaveClient({ baseUrl: hub.url, token: OWNER });
    const bundle = await client.sessionBundle('ses_share', { toolOutput: false, code: true });
    expect(bundle.includes).toEqual({ thinking: false, toolOutput: false, attachments: true, code: true });
    expect(JSON.stringify(bundle)).toContain('[tool output left out]');
    expect((await hub.api('/api/sessions/ses_nope/bundle')).status).toBe(404);
    expect((await hub.api('/api/sessions/ses_share/bundle', { token: null })).status).toBe(401);
  });
});
