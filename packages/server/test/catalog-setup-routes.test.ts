/**
 * POST /api/catalog/items/:id/setup ("Install on the hub") over the fake
 * engine. The hub's machine is the fake engine's FakeMachine with exec
 * replaced by a runner that records each command and "installs" by writing a
 * stub program; the readiness check is the real `command -v`, pointed at a
 * temp folder through PATH. Nothing is downloaded or installed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecOptions, ExecResult } from '@conclave/core/machine/types.ts';
import { HUB_INSTALLERS } from '@conclave/core/catalog/hub-setup.ts';
import type { CatalogItemDto, CatalogSetupResult } from '@conclave/core/catalog/types.ts';
import { startHub, OWNER, type TestHub } from './helpers';

let hub: TestHub;
let bin: string;
const prevOffline = process.env.CONCLAVE_CATALOG_OFFLINE;
const prevPath = process.env.PATH;
const calls: Array<{ command: string; opts: ExecOptions }> = [];
/** What the fake runner does for a command; default: exit 0, no output. */
let runner: (command: string, opts: ExecOptions) => Promise<Partial<ExecResult>> = async () => ({});

const UV_RUN = HUB_INSTALLERS.uv.run;
const SERENA_RUN = 'uv tool install -p 3.13 serena-agent && serena init';

/** A program on the test PATH. */
function stub(name: string): void {
  writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, name), 0o755);
}

beforeAll(() => {
  process.env.CONCLAVE_CATALOG_OFFLINE = '1';
  hub = startHub();
  const local = hub.engine.devices.get('local')!;
  local.exec = async (command: string, opts: ExecOptions): Promise<ExecResult> => {
    calls.push({ command, opts });
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1, ...(await runner(command, opts)) };
  };
  // the readiness check runs `sh -c 'command -v ...'`: only what is in this folder is "on the hub"
  bin = mkdtempSync(join(tmpdir(), 'conclave-setup-bin-'));
  symlinkSync(Bun.which('sh')!, join(bin, 'sh'));
  stub('curl');
  process.env.PATH = bin;
});

afterAll(async () => {
  process.env.PATH = prevPath;
  await hub.stop();
  rmSync(bin, { recursive: true, force: true });
  if (prevOffline === undefined) delete process.env.CONCLAVE_CATALOG_OFFLINE;
  else process.env.CONCLAVE_CATALOG_OFFLINE = prevOffline;
});

const post = (id: string, json: unknown, token: string | null = OWNER) => hub.api(`/api/catalog/items/${encodeURIComponent(id)}/setup`, { method: 'POST', json, token });

describe('install on the hub', () => {
  test('the card offers uv then the step, the run does them in that order, and the new readiness comes back', async () => {
    const before = (await hub.api('/api/catalog/items/mcp%3Aserena').then((r) => r.json())) as CatalogItemDto;
    expect(before.ready.ok).toBe(false);
    expect(before.ready.missing.map((n) => n.bin)).toEqual(['serena']);
    const offer = before.ready.hubSetup!;
    expect(offer.commands.map((c) => c.run)).toEqual([UV_RUN, SERENA_RUN]);
    expect(offer.user).toBeTruthy();

    calls.length = 0;
    runner = async (command, opts) => {
      opts.onOutput?.(`working on ${command.split(' ')[0]}\n`, 'stdout');
      if (command === UV_RUN) (stub('uv'), stub('uvx'));
      if (command === SERENA_RUN) stub('serena');
      return {};
    };
    const res = await post('mcp:serena', { commands: offer.commands.map((c) => c.run) });
    expect(res.status).toBe(200);
    const r = (await res.json()) as CatalogSetupResult;
    expect(r).toMatchObject({ ok: true, exitCode: 0, ran: [UV_RUN, SERENA_RUN], ready: { ok: true, missing: [] } });
    expect(r.tail).toContain('working on uv');
    expect(calls.map((c) => c.command)).toEqual([UV_RUN, SERENA_RUN]);
    expect(calls.every((c) => c.opts.cwd === offer.home && (c.opts.timeoutMs ?? 0) <= 10 * 60_000)).toBe(true);

    // audited with the command line, as the owner
    const audit = (await hub.api('/api/audit?limit=20').then((x) => x.json())) as Array<{ action: string; detail: string; actor: string }>;
    const line = audit.find((a) => a.action === 'catalog.setup');
    expect(line?.detail).toContain(`mcp:serena as ${offer.user}`);
    expect(line?.detail).toContain(`${UV_RUN} && ${SERENA_RUN}`);
    expect(line?.actor).toBe('owner');
    expect(audit.some((a) => a.action === 'catalog.setup.result' && a.detail.startsWith('mcp:serena: ok'))).toBe(true);

    // uv is there now: another item that runs through uvx is ready too
    const bm = (await hub.api('/api/catalog/items/mcp%3Abasic-memory').then((x) => x.json())) as CatalogItemDto;
    expect(bm.ready.ok).toBe(true);
  });

  test('a failing command stops the run and comes back with its exit code and output tail', async () => {
    calls.length = 0;
    runner = async (_command, opts) => {
      opts.onOutput?.('error: could not resolve semgrep\n', 'stderr');
      return { exitCode: 2 };
    };
    const res = await post('mcp:semgrep', { step: 0 });
    expect(res.status).toBe(200);
    const r = (await res.json()) as CatalogSetupResult;
    expect(r).toMatchObject({ ok: false, exitCode: 2, ran: ['uv tool install semgrep'], ready: { ok: false } });
    expect(r.tail).toBe('$ uv tool install semgrep\nerror: could not resolve semgrep');
    expect(r.ready.missing.map((n) => n.bin)).toEqual(['semgrep']);
  });

  test('refusals: a device step, no such step, nothing missing, root only, a changed plan, unknown items', async () => {
    calls.length = 0;
    expect((await post('mcp:ghidra', { step: 1 })).status).toBe(400);
    expect((await post('mcp:serena', { step: 9 })).status).toBe(400);
    expect((await post('mcp:serena', { step: 0, bin: 'serena' })).status).toBe(400);
    expect((await post('mcp:serena', { step: -1 })).status).toBe(400);
    expect((await post('mcp:serena', { commands: 'uv' })).status).toBe(400);
    // serena is there now
    const nothing = await post('mcp:serena', {});
    expect(nothing.status).toBe(409);
    expect(((await nothing.json()) as { error: string }).error).toBe('Nothing is missing on the hub.');
    // docker needs root: no command, the Debian one to copy
    const docker = await post('mcp:grafana', {});
    expect(docker.status).toBe(409);
    const body = (await docker.json()) as { error: string; setup: { byHand: Array<{ bin: string; run?: string }> } };
    expect(body.setup.byHand).toEqual([expect.objectContaining({ bin: 'docker', run: 'sudo apt-get install -y docker.io' })]);
    // what the owner confirmed is not what would run now
    const changed = await post('mcp:zotero', { commands: [UV_RUN, 'uv tool install zotero-mcp-server==0.15.1'] });
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { setup: { commands: Array<{ run: string }> } }).setup.commands.map((c) => c.run)).toEqual(['uv tool install zotero-mcp-server==0.15.1']);
    expect((await post('nope:x', {})).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('only the owner: no token is 401, a member is 403', async () => {
    expect((await post('mcp:zotero', {}, null)).status).toBe(401);
    const PASSWORD = 'correct horse battery staple';
    const made = await hub.api('/api/people', { method: 'POST', json: { name: 'alice', password: PASSWORD } });
    expect(made.status).toBeLessThan(300);
    const login = (await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'alice', password: PASSWORD, name: 'alice laptop', platform: 'web' } }).then((r) => r.json())) as { token: string };
    calls.length = 0;
    const res = await post('mcp:zotero', {}, login.token);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test('one run at a time per item', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    runner = async () => {
      await gate;
      return {};
    };
    const first = post('mcp:zotero', {});
    await Bun.sleep(150);
    expect((await post('mcp:zotero', {})).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});
