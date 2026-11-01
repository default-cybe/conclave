import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runDaemon, type DaemonHandle } from '@conclave/core/machine/daemon.ts';
import { LogRing, daemonLogTail } from '@conclave/core/logs/ring.ts';
import { listLogFiles } from '@conclave/core/logs/sink.ts';
import { readZip } from '@conclave/core/logs/zip.ts';
import { CLIENT_BATCH_MAX } from '@conclave/core/logs/index.ts';
import type { LogLine, LogsStatus } from '@conclave/core/client/index.ts';
import { FakeMachine, waitFor } from '../../core/test/machine/fake-machine';
import { OWNER, openWs, startHub, type TestHub } from './helpers';

const FAKE_KEY = 'sk-ant-api03-PLANTEDrouteKEY0123456789abcdefXYZ';
const MESSAGE_TEXT = 'PLANTED-ROUTE-TEXT from a chat';

let hub: TestHub;
const daemons: DaemonHandle[] = [];

beforeAll(() => {
  hub = startHub({ heartbeatMs: 1000 });
  // a route that fails, added before the first request builds the router
  hub.running.conclave.app.get('/api/test-boom', () => {
    throw new Error('boom for the logs test');
  });
  hub.engine.config.update({ providers: { ...hub.engine.config.get().providers, anthropic: { type: 'anthropic', apiKey: FAKE_KEY } } });
});
afterAll(async () => {
  for (const d of daemons) d.stop();
  await hub.stop();
});

function lines(): LogLine[] {
  return listLogFiles(hub.running.conclave.ctx.logs.dir).flatMap((f) =>
    readFileSync(f.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogLine),
  );
}

async function pairClient(name: string): Promise<string> {
  const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'client' } }).then((r) => r.json());
  const res = await hub.api('/api/pair', { method: 'POST', token: null, json: { code: pairing.code, name, platform: 'ios' } });
  expect(res.status).toBe(200);
  return (await res.json()).token;
}

describe('logs routes', () => {
  test('the hub wrote that it started; status counts files and errors', async () => {
    expect(lines().some((l) => l.component === 'hub' && l.msg === 'hub started' && l.fields?.version === hub.engine.version)).toBe(true);
    const res = await hub.api('/api/logs');
    expect(res.status).toBe(200);
    const s = (await res.json()) as LogsStatus;
    expect(s).toMatchObject({ files: 1, keepDays: 28, maxMB: 500, errorsToday: expect.any(Number) });
    expect(s.dir).toBe(hub.running.conclave.ctx.logs.dir);
    expect((await hub.api('/api/logs', { token: null })).status).toBe(401);
  });

  test('a 500 is in the files with the stack, as server error and http server error', async () => {
    const res = await hub.api('/api/test-boom?token=should-not-be-logged');
    expect(res.status).toBe(500);
    const all = lines();
    const err = all.find((l) => l.component === 'server' && l.level === 'error' && l.msg.includes('/api/test-boom'))!;
    expect(String(err.fields?.stack)).toContain('boom for the logs test');
    const http = all.find((l) => l.component === 'http' && l.msg === 'server error')!;
    expect(http.fields).toMatchObject({ method: 'GET', path: '/api/test-boom', status: 500 });
    expect(JSON.stringify(all)).not.toContain('should-not-be-logged');
    const errors = await hub.api('/api/logs/errors?days=1').then((r) => r.json());
    expect(errors.errors).toBeGreaterThanOrEqual(1);
    expect(errors.top.some((g: { sample: string }) => g.sample.includes('/api/test-boom'))).toBe(true);
    expect((await hub.api('/api/logs/errors?days=40')).status).toBe(400);
  });

  test('an app socket connecting is a line', async () => {
    const ws = await openWs(hub.url.replace('http', 'ws') + `/api/ws?token=${OWNER}`);
    await waitFor(() => lines().some((l) => l.component === 'ws' && l.msg === 'client connected'), 3000, 'ws line');
    ws.close();
    await waitFor(() => lines().some((l) => l.component === 'ws' && l.msg === 'client disconnected'), 3000, 'ws close line');
    expect(JSON.stringify(lines())).not.toContain(OWNER);
  });

  test('client lines: stored with the paired app, capped per batch and by size, never without a token', async () => {
    const token = await pairClient('iPhone of Sam');
    const events = Array.from({ length: CLIENT_BATCH_MAX + 5 }, (_, i) => ({ level: 'error', event: 'render.error', msg: `TypeError ${i}`, fields: { route: '/settings', text: MESSAGE_TEXT } }));
    const res = await hub.api('/api/logs/client', { method: 'POST', token, json: { app: 'iphone', version: '0.1.0', platform: 'iOS', events } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: CLIENT_BATCH_MAX, dropped: 5 });
    const mine = lines().filter((l) => l.component === 'client' && l.msg === 'render.error');
    expect(mine.length).toBe(CLIENT_BATCH_MAX);
    expect(mine[0].client).toMatchObject({ device: 'iPhone of Sam', app: 'iphone', version: '0.1.0', platform: 'iOS' });
    expect(mine[0].client!.id).toMatch(/^cl/);
    expect(JSON.stringify(lines())).not.toContain(MESSAGE_TEXT);
    expect(JSON.stringify(lines())).not.toContain(token);
    const big = await hub.api('/api/logs/client', { method: 'POST', token, json: { app: 'iphone', events: [{ level: 'info', event: 'x', msg: 'y'.repeat(70 * 1024) }] } });
    expect(big.status).toBe(413);
    // a batch sent without a length is cut off at the cap, not read whole first
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (pulled >= 256 * 1024 * 1024) return ctl.close();
        pulled += 64 * 1024;
        ctl.enqueue(new Uint8Array(64 * 1024).fill(32));
      },
    });
    const chunked = await fetch(`${hub.url}/api/logs/client`, { method: 'POST', body: endless, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }).catch(() => undefined);
    if (chunked) expect(chunked.status).toBe(413);
    expect(pulled).toBeLessThan(64 * 1024 * 1024);
    expect((await hub.api('/api/logs/client', { method: 'POST', token: null, json: { app: 'x', events: [] } })).status).toBe(401);
    const tail = await hub.api('/api/logs/tail?lines=5&component=client').then((r) => r.json());
    expect(tail.lines.length).toBe(5);
    expect(tail.cursor).toMatch(/^\d{4}-\d{2}-\d{2}:\d+$/);
  });

  test('the debug switch: on for hours, off with 0, refused past a week', async () => {
    const on = await hub.api('/api/logs/debug', { method: 'PUT', json: { hours: 2 } }).then((r) => r.json());
    expect(on.debugUntil).toBeGreaterThan(Date.now() + 3_600_000);
    expect(hub.engine.config.get().logs?.debugUntil).toBe(on.debugUntil);
    const off = await hub.api('/api/logs/debug', { method: 'PUT', json: { hours: 0 } }).then((r) => r.json());
    expect(off.debugUntil).toBeUndefined();
    expect((await hub.api('/api/logs/debug', { method: 'PUT', json: { hours: 500 } })).status).toBe(400);
    expect((await hub.api('/api/logs/debug', { method: 'PUT', json: {} })).status).toBe(400);
    expect(lines().some((l) => l.msg === 'debug on')).toBe(true);
  });

  test('export: one zip with the files, summary.md, the config without secrets and a paired device log', async () => {
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
    const reg = await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code: pairing.code, name: 'Work PC' } }).then((r) => r.json());
    const ring = new LogRing();
    ring.push(`10:00:00 ● online, a key went by: ${FAKE_KEY}`);
    const d = runDaemon({ hubUrl: hub.url, deviceId: reg.deviceId, token: reg.token, machine: new FakeMachine('pc', 'pc'), name: 'pc', maxBackoffMs: 200, logTail: (n) => daemonLogTail({ lines: n, impl: 'ts', version: 'test', ring }) });
    daemons.push(d);
    await waitFor(() => hub.engine.devices.isOnline(reg.deviceId), 3000, 'device online');
    await waitFor(() => lines().some((l) => l.component === 'device' && l.msg === 'device connected' && l.fields?.name === 'Work PC'), 3000, 'device line');

    const res = await hub.api('/api/logs/export?days=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
    expect(name).toMatch(/^conclave-logs-.+-\d{4}-\d{2}-\d{2}\.zip$/);
    const files = readZip(new Uint8Array(await res.arrayBuffer()));
    const names = [...files.keys()];
    const root = name!.replace(/\.zip$/, '');
    expect(names).toContain(`${root}/summary.md`);
    expect(names).toContain(`${root}/config.json`);
    expect(names.some((n) => n.startsWith(`${root}/logs/hub-`))).toBe(true);
    const deviceLog = names.find((n) => n.startsWith(`${root}/devices/work-pc-`))!;
    expect(deviceLog).toBeDefined();
    const dec = new TextDecoder();
    const all = [...files.values()].map((b) => dec.decode(b)).join('\n');
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain(OWNER);
    expect(dec.decode(files.get(deviceLog)!)).toContain('a key went by: [redacted]');
    const summary = dec.decode(files.get(`${root}/summary.md`)!);
    expect(summary).toContain(`Version: ${hub.engine.version}`);
    expect(summary).toContain('| Work PC |');
    expect(summary).toMatch(/Providers set up\n\n.*anthropic/);
    expect(summary).toContain('## Top 20 errors');
    expect(summary).toContain('boom for the logs test');
    const cfg = JSON.parse(dec.decode(files.get(`${root}/config.json`)!));
    expect(cfg.server.token).toBeUndefined();
    expect(cfg.providers.anthropic.apiKey).toBeUndefined();
    expect(lines().some((l) => l.component === 'logs' && l.msg === 'logs exported')).toBe(true);
    expect((await hub.api('/api/logs/export?days=0')).status).toBe(400);
    expect((await hub.api('/api/logs/export', { token: null })).status).toBe(401);

    d.stop();
    await waitFor(() => lines().some((l) => l.component === 'device' && l.msg === 'device disconnected' && l.fields?.name === 'Work PC'), 3000, 'device off line');
  });
});
