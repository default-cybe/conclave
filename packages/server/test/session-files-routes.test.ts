/**
 * GET /api/sessions/:id/files/:toolUseId (routes.ts) on a real engine: a
 * ShareFile call in a turn, then the download. Headers, inline only for
 * safe types, 404 for unknown ids and other people's sessions, a member on
 * her own chat, and the path checked again (deleted, swapped for a symlink).
 *
 *   bun test packages/server/test/session-files-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Device } from '@conclave/core/types.ts';
import { FakeMachine } from '../../core/test/machine/fake-machine';
import { startTestEngine, type TestEngine } from '../../core/test/engine/harness';
import { startServer, type RunningServer } from '../src/app';

const OWNER = 'owner-token-session-files-0123456789';
const PASSWORD = 'correct horse battery staple';

let t: TestEngine;
let running: RunningServer;
let alice: { id: string; token: string };

const get = (path: string, token = OWNER) => fetch(`${running.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'ok' }]],
    // "SHARE:<path>" makes the model call ShareFile; its result gets a short answer
    route: (body) => {
      const last = JSON.stringify((body.messages ?? []).at(-1));
      if (last.includes('tool_result')) return [{ text: 'shared' }];
      const path = /SHARE:([^\s"\\]+)/.exec(last)?.[1];
      return path ? [{ tool: 'ShareFile', input: { path } }] : undefined;
    },
  });
  t.engine.config.update({ server: { ...t.engine.config.get().server, token: OWNER } });
  running = startServer(t.engine, { host: '127.0.0.1', port: 0 });
  const made = await fetch(`${running.url}/api/people`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'alice', password: PASSWORD, providers: { mock: { monthlyUsd: 5 } } }) }).then((r) => r.json());
  const login = await fetch(`${running.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: 'alice', password: PASSWORD, name: 'alice phone', platform: 'web' }) }).then((r) => r.json());
  alice = { id: made.person.id, token: login.token };
});

afterAll(async () => {
  await running?.stop();
  await t?.close();
});

/** Run a turn that shares `path` in the session; the ShareFile call's id, or undefined when it was refused. */
async function share(sessionId: string, path: string): Promise<{ id: string; ok: boolean }> {
  await t.run(sessionId, `SHARE:${path}`);
  for (const m of t.engine.getMessages(sessionId).reverse()) {
    for (const b of m.content) if (b.type === 'tool_result') return { id: b.toolUseId, ok: !b.isError && !!b.meta?.file };
  }
  throw new Error('no ShareFile result');
}

describe('downloads', () => {
  let sid: string;
  beforeAll(async () => {
    sid = (await t.engine.createSession({ title: 'files', cwd: t.cwd, device: 'local' })).id;
  });

  test('the owner gets a PDF with its type, an attachment, nosniff and the sandbox CSP', async () => {
    writeFileSync(join(t.cwd, 'report.pdf'), '%PDF-1.4 bytes');
    const { id, ok } = await share(sid, 'report.pdf');
    expect(ok).toBe(true);
    const r = await get(`/api/sessions/${sid}/files/${id}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('%PDF-1.4 bytes');
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-length')).toBe('14');
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toStartWith('sandbox;');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect((await get(`/api/sessions/${sid}/files/${id}?inline=1`)).headers.get('content-disposition')).toStartWith('inline;');
    expect(t.engine.repos.audit.list({ limit: 50 }).some((a) => a.action === 'session.file.download')).toBe(true);
  });

  test('inline=1 on an SVG or HTML file stays an attachment', async () => {
    for (const name of ['pic.svg', 'page.html']) {
      writeFileSync(join(t.cwd, name), '<svg onload="alert(1)"/>');
      const { id } = await share(sid, name);
      const r = await get(`/api/sessions/${sid}/files/${id}?inline=1`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-disposition')).toStartWith('attachment;');
    }
  });

  test('an unknown or malformed toolUseId, and one from another session, are 404', async () => {
    writeFileSync(join(t.cwd, 'a.txt'), 'a');
    const { id } = await share(sid, 'a.txt');
    expect((await get(`/api/sessions/${sid}/files/toolu_nope`)).status).toBe(404);
    expect((await get(`/api/sessions/${sid}/files/..%2F..%2Fsecrets.json`)).status).toBe(404);
    const other = (await t.engine.createSession({ title: 'other', cwd: t.cwd, device: 'local' })).id;
    expect((await get(`/api/sessions/${other}/files/${id}`)).status).toBe(404);
  });

  test('a refused path makes no card and nothing to download', async () => {
    const { id, ok } = await share(sid, join(t.home, 'secrets.json'));
    expect(ok).toBe(false);
    expect((await get(`/api/sessions/${sid}/files/${id}`)).status).toBe(404);
  });

  test('a file deleted after sharing is 404; one swapped for a symlink to secrets.json is refused', async () => {
    const p = join(t.cwd, 'gone.txt');
    writeFileSync(p, 'x');
    const gone = await share(sid, 'gone.txt');
    rmSync(p);
    expect((await get(`/api/sessions/${sid}/files/${gone.id}`)).status).toBe(404);

    const q = join(t.cwd, 'swap.txt');
    writeFileSync(q, 'x');
    const swap = await share(sid, 'swap.txt');
    rmSync(q);
    writeFileSync(join(t.home, 'secrets.json'), '{"providers":{"k":"sk-secret"}}');
    symlinkSync(join(t.home, 'secrets.json'), q);
    const r = await get(`/api/sessions/${sid}/files/${swap.id}`);
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain('sk-secret');
  });

  test('a file swapped between the check and the read is never sent', async () => {
    const machine = t.engine.localMachine as unknown as { stat: (p: string) => Promise<unknown> };
    const real = machine.stat.bind(machine);
    const swapAfterCheck = (swap: () => void) => {
      // the swap lands after checkShareable's stat, before the download opens the file
      machine.stat = async (p: string) => {
        const st = await real(p);
        if (p.endsWith('race.txt')) swap();
        return st;
      };
    };
    const p = join(t.cwd, 'race.txt');
    try {
      writeFileSync(p, 'checked');
      const a = await share(sid, 'race.txt');
      swapAfterCheck(() => {
        writeFileSync(join(t.cwd, 'decoy.txt'), 'DECOY');
        renameSync(join(t.cwd, 'decoy.txt'), p);
      });
      const r = await get(`/api/sessions/${sid}/files/${a.id}`);
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain('DECOY');

      delete (machine as { stat?: unknown }).stat;
      writeFileSync(p, 'checked');
      swapAfterCheck(() => {
        rmSync(p);
        symlinkSync(join(t.home, 'secrets.json'), p);
      });
      const s = await get(`/api/sessions/${sid}/files/${a.id}`);
      expect(s.status).not.toBe(200);
      expect(await s.text()).not.toContain('sk-secret');
    } finally {
      delete (machine as { stat?: unknown }).stat;
    }
  });

  test('a download makes no outputs folder', async () => {
    writeFileSync(join(t.cwd, 'plain.txt'), 'x');
    const { id } = await share(sid, 'plain.txt');
    expect((await get(`/api/sessions/${sid}/files/${id}`)).status).toBe(200);
    expect(existsSync(join(t.home, 'outputs', sid))).toBe(false);
  });

  test('needs a token', async () => {
    expect((await fetch(`${running.url}/api/sessions/${sid}/files/toolu_1_0`)).status).toBe(401);
  });
});

describe('a member', () => {
  test("gets 404 on the owner's session and her own file from her own session", async () => {
    const owners = (await t.engine.createSession({ title: 'mine', cwd: t.cwd, device: 'local' })).id;
    writeFileSync(join(t.cwd, 'owner.txt'), 'owner');
    const { id } = await share(owners, 'owner.txt');
    expect((await get(`/api/sessions/${owners}/files/${id}`, alice.token)).status).toBe(404);

    // her own paired device (a fake one), where her session made a file
    const m = new FakeMachine('alice-laptop', 'alice laptop');
    t.engine.repos.devices.insert({ id: m.id, name: m.name, tokenHash: 'test', accountId: alice.id });
    t.engine.devices.attach({ ...t.engine.repos.devices.get(m.id)!, online: true, info: await m.info() } as Device, m);
    m.dirs.add('/home/me/work');
    await m.writeFile('/home/me/work/hers.txt', 'hers');
    const hers = (await t.engine.createSession({ title: 'hers', device: m.id, cwd: '/home/me/work' }, alice.id)).id;
    const mine = await share(hers, 'hers.txt');
    expect(mine.ok).toBe(true);
    const r = await get(`/api/sessions/${hers}/files/${mine.id}`, alice.token);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hers');
  });
});
