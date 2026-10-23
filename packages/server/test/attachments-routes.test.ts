/**
 * What the hub takes with a message over HTTP (docs/design/CHAT-AND-MOTION.md
 * 2.5): 15 files at most, the same line the apps show past that, and a zip
 * it will not open refused with its reason, both before the turn starts.
 *
 *   bun test packages/server/test/attachments-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestEngine, until, type TestEngine } from '../../core/test/engine/harness';
import { b64, makeZip } from '../../core/test/attachments/zipkit';
import { MAX_ATTACHMENTS, TOO_MANY_FILES } from '../../core/src/attachments/limits';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-attachments-0123456789';

let t: TestEngine;
let running: RunningServer;

async function call(method: string, path: string, json?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${running.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${OWNER}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

const file = (i: number) => ({ mediaType: 'text/plain', data: b64(new TextEncoder().encode(`file ${i}`)), name: `${i}.txt` });

describe('attachments over HTTP', () => {
  test('16 files are refused with the line the apps show; 15 go', async () => {
    const s = await call('POST', '/api/sessions', { kind: 'chat' });
    const id = s.body.id as string;
    const over = await call('POST', `/api/sessions/${id}/messages`, { text: 'many', attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(i)) });
    expect(over.status).toBe(400);
    expect(over.body.error).toBe(TOO_MANY_FILES);
    expect(t.engine.getMessages(id).length).toBe(0);

    const ok = await call('POST', `/api/sessions/${id}/messages`, { text: 'fifteen', attachments: Array.from({ length: MAX_ATTACHMENTS }, (_, i) => file(i)) });
    expect(ok.status).toBe(200);
    expect(await until(() => t.engine.getMessages(id).some((m) => m.role === 'user'))).toBe(true);
    expect(t.engine.getMessages(id).find((m) => m.role === 'user')!.content.filter((b) => b.type === 'document').length).toBe(MAX_ATTACHMENTS);
  });

  test('a zip bomb and a zip with a link are refused with the reason', async () => {
    const s = await call('POST', '/api/sessions', { kind: 'chat' });
    const id = s.body.id as string;
    const bomb = makeZip([{ name: 'zeros.txt', data: new Uint8Array(4 * 1024 * 1024), method: 8, claim: 512 }]);
    const r1 = await call('POST', `/api/sessions/${id}/messages`, { text: 'x', attachments: [{ mediaType: 'application/zip', data: b64(bomb), name: 'bomb.zip' }] });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe('bomb.zip is damaged (zeros.txt).');
    const link = makeZip([{ name: 'etc', data: '/etc', mode: 0o120777 }]);
    const r2 = await call('POST', `/api/sessions/${id}/messages`, { text: 'x', attachments: [{ mediaType: 'application/zip', data: b64(link), name: 'link.zip' }] });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe('link.zip holds a link (etc). The hub does not open zips with links.');
    expect(t.engine.getMessages(id).length).toBe(0);
  });
});
