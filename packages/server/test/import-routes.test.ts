/**
 * Chat import routes (routes-import.ts, and the review routes in
 * routes-memory.ts): input checks, devices, uploads and the 501 without an
 * import service. The service itself is tested on a real engine in
 * packages/core/test/import; here a stub records what the routes pass on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attachImport } from '@conclave/core/import/registry.ts';
import type { ImportService } from '@conclave/core/import/service.ts';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
const calls: Array<{ method: string; args: unknown[] }> = [];
const rec =
  (method: string, out: unknown = {}) =>
  async (...args: unknown[]) => (calls.push({ method, args }), typeof out === 'function' ? (out as (...a: unknown[]) => unknown)(...args) : out);
const batch = { id: 'imp_1', device: 'local', mode: 'chats', status: 'importing', total: 2 };

beforeAll(() => {
  hub = startHub();
  hub.engine.repos.devices.insert({ id: 'mac', name: 'macbook', tokenHash: 'x', roots: [] });
});
afterAll(() => hub.stop());

const last = (method: string) => [...calls].reverse().find((c) => c.method === method);

describe('without an import service', () => {
  test('the routes answer 501', async () => {
    expect((await hub.api('/api/import/scan')).status).toBe(501);
    expect((await hub.api('/api/memory/review')).status).toBe(501);
  });
});

describe('with an import service', () => {
  beforeAll(() => {
    const svc = {
      scan: rec('scan', { items: [], total: 0, failed: [], retention: [], counts: {} }),
      estimate: rec('estimate', { sessions: 0 }),
      startBatch: rec('startBatch', batch),
      batches: () => ({ batches: [], notLearned: 0 }),
      batch: (id: string) => {
        if (id !== 'imp_1') throw Object.assign(new Error(`Unknown import batch ${id}`), { status: 404 });
        return { ...batch, items: [] };
      },
      pause: () => ({ ...batch, status: 'paused' }),
      resume: () => batch,
      cancel: () => ({ ...batch, status: 'cancelled' }),
      undo: rec('undo', { sessionsRemoved: 1, messagesRemoved: 0, memoriesRemoved: 0, supersedesCleared: 0, kept: [], keptSessions: [] }),
      upload: (...args: unknown[]) => (calls.push({ method: 'upload', args }), { uploadId: 'upl_x', source: args[0], items: 1, unknownContentTypes: {} }),
      syncSession: rec('syncSession', { state: 'unchanged', added: 0 }),
      retention: rec('retention', []),
      fixRetention: rec('fixRetention', []),
      reviewQueue: () => [],
      answerReview: rec('answerReview', { accepted: 1, rejected: 0 }),
    };
    attachImport(hub.engine, svc as unknown as ImportService);
  });

  test('scan: known devices and uploads only; lists and numbers are checked', async () => {
    expect((await hub.api('/api/import/scan?device=nope')).status).toBe(404);
    expect((await hub.api('/api/import/scan?device=mac&sources=claude-code,codex&includeImported=false&limit=50')).status).toBe(200);
    expect(last('scan')!.args[0]).toMatchObject({ device: 'mac', sources: ['claude-code', 'codex'], includeImported: false, limit: 50 });
    expect((await hub.api('/api/import/scan?device=upload:upl_abc')).status).toBe(200);
    expect((await hub.api('/api/import/scan?sources=claude-code,windows')).status).toBe(400);
    expect((await hub.api('/api/import/scan?limit=lots')).status).toBe(400);
    expect((await hub.api('/api/import/scan?since=not-a-date')).status).toBe(400);
  });

  test('estimate and start: mode, keys and query are checked', async () => {
    expect((await hub.api('/api/import/estimate', { method: 'POST', json: { device: 'local', mode: 'everything' } })).status).toBe(400);
    expect((await hub.api('/api/import/estimate', { method: 'POST', json: { device: 'local', mode: 'chats', keys: [1, 2] } })).status).toBe(400);
    expect((await hub.api('/api/import/estimate', { method: 'POST', json: { device: 'local', mode: 'chats', query: 'all' } })).status).toBe(400);
    const r = await hub.api('/api/import/batches', { method: 'POST', json: { device: 'local', mode: 'chats-learn', query: { sources: ['codex'], since: '2026-01-01' }, episodeNotes: true } });
    expect(r.status).toBe(200);
    expect(last('startBatch')!.args[0]).toMatchObject({ device: 'local', mode: 'chats-learn', query: { sources: ['codex'], since: '2026-01-01' }, episodeNotes: true });
    expect((await hub.api('/api/import/batches', { method: 'POST', json: { device: 'local', mode: 'chats', includeSkipped: 'yes' } })).status).toBe(400);
  });

  test('a batch that does not exist is 404', async () => {
    expect((await hub.api('/api/import/batches/imp_nope')).status).toBe(404);
    expect((await hub.api('/api/import/batches/imp_1')).status).toBe(200);
  });

  test('upload: the source is required and the body passes through as bytes', async () => {
    expect((await hub.api('/api/import/upload', { method: 'POST', body: '[]' })).status).toBe(400);
    expect((await hub.api('/api/import/upload?source=gemini', { method: 'POST', body: '[]' })).status).toBe(400);
    const r = await hub.api(`/api/import/upload?source=chatgpt&name=${'x'.repeat(300)}`, { method: 'POST', body: new Uint8Array([0x5b, 0x5d]) });
    expect(r.status).toBe(200);
    const [source, body, name] = last('upload')!.args as [string, Uint8Array, string];
    expect(source).toBe('chatgpt');
    expect([...body]).toEqual([0x5b, 0x5d]);
    expect(name.length).toBe(200);
  });

  test('sync needs a session that exists; retention needs an online device and a known tool', async () => {
    expect((await hub.api('/api/import/sessions/ses_nope/sync', { method: 'POST' })).status).toBe(404);
    expect((await hub.api('/api/import/retention?device=mac')).status).toBe(409);
    expect((await hub.api('/api/import/retention', { method: 'POST', json: { device: 'local', tool: 'codex' } })).status).toBe(400);
    expect((await hub.api('/api/import/retention', { method: 'POST', json: { device: 'local', tool: 'claude-code' } })).status).toBe(200);
  });

  test('review: ids are lists of strings, and one of accept or reject is required', async () => {
    expect((await hub.api('/api/memory/review', { method: 'POST', json: {} })).status).toBe(400);
    expect((await hub.api('/api/memory/review', { method: 'POST', json: { accept: 'mem_1' } })).status).toBe(400);
    const r = await hub.api('/api/memory/review', { method: 'POST', json: { accept: ['mem_1'] } });
    expect(await r.json()).toEqual({ accepted: 1, rejected: 0 });
  });

  test('every call needs the owner token', async () => {
    expect((await hub.api('/api/import/scan', { token: null })).status).toBe(401);
    expect((await hub.api('/api/import/batches', { method: 'POST', token: null, json: { device: 'local', mode: 'chats' } })).status).toBe(401);
  });
});
