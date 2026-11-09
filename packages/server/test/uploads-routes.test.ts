/**
 * POST /api/uploads (core attachments/uploads.ts): one file at a time,
 * streamed to the caller's uploads folder, then named by id in a message.
 *
 *   bun test packages/server/test/uploads-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, until, type TestEngine } from '../../core/test/engine/harness';
import { getUpload, sweepUploads, UPLOAD_TTL_MS } from '../../core/src/attachments/uploads';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-uploads-0123456789abcdef';

let t: TestEngine;
let running: RunningServer;

async function up(name: string, body: BodyInit, type = 'text/plain'): Promise<{ status: number; body: any }> {
  const res = await fetch(`${running.url}/api/uploads?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}` }, body });
  return { status: res.status, body: await res.json() };
}

async function call(method: string, path: string, json?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${running.url}${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER, uploadMaxMb: 1 } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

describe('uploads', () => {
  test('a file is stored under an id, and a message naming it carries it; the upload is then gone', async () => {
    const r = await up('notes.txt', 'hello from an upload');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'notes.txt', mediaType: 'text/plain', size: 20 });
    expect(r.body.id).toMatch(/^up_[a-f0-9]{24}$/);
    const home = t.engine.config.paths.home;
    expect(existsSync(join(home, 'uploads', r.body.id))).toBe(true);

    const s = await call('POST', '/api/sessions', { kind: 'chat' });
    const sent = await call('POST', `/api/sessions/${s.body.id}/messages`, { text: 'read it', attachments: [{ uploadId: r.body.id, name: 'notes.txt', mediaType: 'text/plain' }] });
    expect(sent.status).toBe(200);
    expect(await until(() => t.engine.getMessages(s.body.id).some((m) => m.role === 'user'))).toBe(true);
    const doc = t.engine.getMessages(s.body.id).find((m) => m.role === 'user')!.content.find((b) => b.type === 'document') as { data: string; title: string };
    expect(doc.title).toBe('notes.txt');
    expect(Buffer.from(doc.data, 'base64').toString()).toBe('hello from an upload');
    expect(await until(() => !existsSync(join(home, 'uploads', r.body.id)))).toBe(true);
  });

  test('an unknown upload id refuses the message', async () => {
    const s = await call('POST', '/api/sessions', { kind: 'chat' });
    const sent = await call('POST', `/api/sessions/${s.body.id}/messages`, { text: 'x', attachments: [{ uploadId: 'up_000000000000000000000000', name: 'gone.bin', mediaType: 'application/octet-stream' }] });
    expect(sent.status).toBe(404);
    expect(sent.body.error).toContain('gone.bin is no longer on the hub');
  });

  test('an upload id is taken by one message only; a second message naming it is refused', async () => {
    const r = await up('once.txt', 'once');
    const s = await call('POST', '/api/sessions', { kind: 'chat' });
    const att = [{ uploadId: r.body.id, name: 'once.txt', mediaType: 'text/plain' }];
    expect((await call('POST', `/api/sessions/${s.body.id}/messages`, { text: 'a', attachments: att })).status).toBe(200);
    expect(await until(() => !existsSync(join(t.engine.config.paths.home, 'uploads', r.body.id)))).toBe(true);
    const again = await call('POST', `/api/sessions/${s.body.id}/messages`, { text: 'b', attachments: att });
    expect(again.status).toBe(404);
  });

  test("a member's upload id named in the owner's message is unknown (404), and the member's file stays", async () => {
    const home = t.engine.config.paths.home;
    const { putUpload } = await import('../../core/src/attachments/uploads');
    const m = await putUpload(home, 'acct_member9', { name: 'theirs.txt', body: new Blob(['secret']).stream(), max: 100 });
    const s = await call('POST', '/api/sessions', { kind: 'chat' });
    const sent = await call('POST', `/api/sessions/${s.body.id}/messages`, { text: 'x', attachments: [{ uploadId: m.id, name: 'theirs.txt' }] });
    expect(sent.status).toBe(404);
    expect(existsSync(join(home, 'accounts', 'acct_member9', 'uploads', m.id))).toBe(true);
  });

  test('a body that says 1 GB is refused before it is read, and nothing is written', async () => {
    const { connect } = await import('node:net');
    const u = new URL(running.url);
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(Number(u.port), u.hostname, () => {
        sock.write(`POST /api/uploads?name=huge.bin HTTP/1.1\r\nHost: ${u.host}\r\nAuthorization: Bearer ${OWNER}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${1024 ** 3}\r\n\r\n`);
        sock.write(new Uint8Array(64 * 1024));
      });
      let got = '';
      sock.on('data', (d) => {
        got += d.toString();
        if (got.includes('\r\n\r\n')) {
          sock.destroy();
          resolve(got);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('no reply')), 5_000);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 413/);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(t.engine.config.paths.home, 'uploads')).filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  test('an APK in a chat is saved in its outputs folder on the hub, and the receipt says Chat cannot open it', async () => {
    const r = await up('app.apk', new Uint8Array([0x50, 0x4b, 3, 4, ...new Array(60).fill(0)]), 'application/vnd.android.package-archive');
    const s = await call('POST', '/api/sessions', { kind: 'chat' });
    expect((await call('POST', `/api/sessions/${s.body.id}/messages`, { text: 'what is this', attachments: [{ uploadId: r.body.id, name: 'app.apk' }] })).status).toBe(200);
    const saved = join(t.engine.config.paths.home, 'outputs', s.body.id, 'uploads', 'app.apk');
    expect(await until(() => existsSync(saved))).toBe(true);
    expect(await until(() => t.engine.getMessages(s.body.id).some((m) => m.role === 'user'))).toBe(true);
    const msg = t.engine.getMessages(s.body.id).find((m) => m.role === 'user')!;
    expect(msg.meta?.attachments).toEqual([expect.objectContaining({ name: 'app.apk', saved, savedOn: 'hub' })]);
    const note = msg.content.find((b) => b.type === 'document') as { data: string };
    expect(Buffer.from(note.data, 'base64').toString()).toContain('- app.apk (APK, 64 bytes)');
  });

  test('an uploaded ELF in a Code session is saved under uploads/, never run, and the model gets the note', async () => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...new Array(120).fill(0)]);
    const r = await up('tool', elf, 'application/octet-stream');
    const s = await call('POST', '/api/sessions', { title: 'code', agent: 'coder', cwd: t.cwd });
    const sent = await call('POST', `/api/sessions/${s.body.id}/messages`, { text: 'look', attachments: [{ uploadId: r.body.id, name: 'tool' }] });
    expect(sent.status).toBe(200);
    const saved = join(t.cwd, 'uploads', 'tool');
    expect(await until(() => existsSync(saved))).toBe(true);
    const { readFileSync, statSync } = await import('node:fs');
    expect(readFileSync(saved).equals(Buffer.from(elf))).toBe(true);
    // copied as data: no execute bit
    expect(statSync(saved).mode & 0o111).toBe(0);
    expect(await until(() => t.engine.getMessages(s.body.id).some((m) => m.role === 'user'))).toBe(true);
    const msg = t.engine.getMessages(s.body.id).find((m) => m.role === 'user')!;
    const note = msg.content.find((b) => b.type === 'document') as { data: string };
    expect(Buffer.from(note.data, 'base64').toString()).toBe(`Saved to the session folder, open with your tools:\n- ${saved} (ELF, 128 bytes)`);
    expect(msg.meta?.attachments).toEqual([expect.objectContaining({ name: 'tool', saved, savedOn: 'session' })]);
  });

  test('path traversal and control characters in a name are refused', async () => {
    for (const name of ['../../etc/passwd', '/etc/passwd', 'a\\b.txt', '..', 'C:evil', 'bad\nname.txt']) {
      const r = await up(name, 'x');
      expect(r.status).toBe(400);
    }
  });

  test('past the per-file cap (server.uploadMaxMb) is a 413, and nothing is kept', async () => {
    const r = await up('big.bin', new Uint8Array(1024 * 1024 + 10), 'application/octet-stream');
    expect(r.status).toBe(413);
    expect(r.body.error).toContain('over 1 MB');
  });

  test('a chunked body past the cap stops being written and is deleted', async () => {
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ >= 6) return c.close();
        c.enqueue(chunk);
      },
    });
    const res = await fetch(`${running.url}/api/uploads?name=stream.bin`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}` }, body, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
    const { readdirSync } = await import('node:fs');
    const left = readdirSync(join(t.engine.config.paths.home, 'uploads')).filter((n) => n.endsWith('.part'));
    expect(left).toEqual([]);
  });

  test('an upload no message took is deleted after a day', async () => {
    const r = await up('old.txt', 'old');
    const home = t.engine.config.paths.home;
    const old = (Date.now() - UPLOAD_TTL_MS - 60_000) / 1000;
    for (const n of [r.body.id, `${r.body.id}.json`]) utimesSync(join(home, 'uploads', n), old, old);
    const fresh = await up('fresh.txt', 'fresh');
    expect(await sweepUploads(home)).toBe(2);
    expect(getUpload(home, undefined, r.body.id)).toBeUndefined();
    expect(getUpload(home, undefined, fresh.body.id)?.name).toBe('fresh.txt');
  });

  test("a member's upload is in their own folder and not found for the owner", async () => {
    const home = t.engine.config.paths.home;
    const { putUpload } = await import('../../core/src/attachments/uploads');
    const m = await putUpload(home, 'acct_member1', { name: 'mine.txt', body: new Blob(['m']).stream(), max: 100 });
    expect(existsSync(join(home, 'accounts', 'acct_member1', 'uploads', m.id))).toBe(true);
    expect(getUpload(home, undefined, m.id)).toBeUndefined();
    expect(getUpload(home, 'acct_member2', m.id)).toBeUndefined();
    expect(getUpload(home, 'acct_member1', m.id)?.name).toBe('mine.txt');
  });
});
