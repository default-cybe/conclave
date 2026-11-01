/**
 * Chat import across devices (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.3, 1.6):
 * a v2 daemon scans and converts on its own disk (importScan, importRead),
 * a v1 daemon is read from the hub once per change, and a Syncthing copy of
 * the same chats on another device at another path lands in the same
 * Conclave sessions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { importOf } from '../../src/import/registry';
import type { ImportService } from '../../src/import/service';
import { MachineServer } from '../../src/machine/daemon';
import { LocalMachine } from '../../src/machine/local';
import { RemoteMachine } from '../../src/machine/remote';
import type { DaemonMessage, HubMessage } from '../../src/machine/protocol';
import { clipToolResults } from '../../src/import/wire';
import { buildOwnerHome, growClaudeA, OWNER, type OwnerHome } from '../importers/owner-home';

/** A device machine whose ~ is a folder of its own. */
class HomeMachine extends LocalMachine {
  constructor(
    readonly home: string,
    id: string,
  ) {
    super({ id, name: id });
  }
  override resolve(path: string, cwd: string): string {
    const p = path === '~' ? this.home : path.startsWith('~/') ? `${this.home}/${path.slice(2)}` : path;
    return super.resolve(p, cwd === '~' ? this.home : cwd);
  }
}

/** A daemon and the hub's RemoteMachine for it, wired in memory, every frame through JSON. */
async function pair(device: HomeMachine, protocol: number) {
  const calls: string[] = [];
  let remote: RemoteMachine;
  const server = new MachineServer(device, (msg: DaemonMessage) => queueMicrotask(() => remote.handleMessage(JSON.parse(JSON.stringify(msg)))));
  const info = { ...(await device.info()), home: device.home };
  remote = new RemoteMachine({
    id: device.id,
    name: device.name,
    info,
    protocol,
    send: (msg: HubMessage) => {
      if (msg.type === 'rpc') calls.push(`${msg.method} ${String((msg.params as { path?: unknown }).path ?? '')}`.trim());
      queueMicrotask(() => server.handle(JSON.parse(JSON.stringify(msg))));
    },
  });
  return { remote, calls };
}

let t: TestEngine;
let svc: ImportService;
let hub: OwnerHome;
let mac: string;
let pc: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  hub = buildOwnerHome();
  // the MacBook has a Syncthing copy of the same chats at another path; the PC has its own copy
  mac = mkdtempSync(join(tmpdir(), 'conclave-mac-'));
  pc = mkdtempSync(join(tmpdir(), 'conclave-pc-'));
  cpSync(hub.home, mac, { recursive: true, preserveTimestamps: true });
  cpSync(hub.home, pc, { recursive: true, preserveTimestamps: true });
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  for (const k of ['CODEX_HOME', 'GEMINI_DIR']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = join(hub.home, '.claude');
  process.env.CODEX_HOME = join(hub.home, '.codex');
  process.env.GEMINI_DIR = join(hub.home, '.gemini');
  svc = importOf(t.engine)!;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await t.close();
  for (const d of [hub.home, mac, pc]) rmSync(d, { recursive: true, force: true });
});

function attach(id: string, name: string, machine: RemoteMachine): void {
  if (!t.engine.repos.devices.get(id)) t.engine.repos.devices.insert({ id, name, tokenHash: 'x' });
  t.engine.devices.attach({ id, name, online: true, roots: [], createdAt: Date.now() }, machine);
}

describe('a v2 daemon', () => {
  test('scans and converts on the device; the hub never reads the transcripts', async () => {
    const { remote, calls } = await pair(new HomeMachine(mac, 'macbook'), 2);
    attach('macbook', 'macbook', remote);
    const page = await svc.scan({ device: 'macbook', refresh: true });
    expect(page.failed).toEqual([]);
    expect(page.items.find((x) => x.id === OWNER.claudeA)).toMatchObject({ title: 'Portfolio contact form', device: 'macbook', humanPrompts: 4 });
    expect(calls).toContain('importScan');
    // only the small settings files for the cleanup warning; never a transcript
    const transcripts = () => calls.filter((c) => /^read(File|Text|Range) .*\.jsonl(\.zst)?$/.test(c));
    expect(transcripts()).toEqual([]);
    const b = await svc.startBatch({ device: 'macbook', keys: [page.items.find((x) => x.id === OWNER.claudeA)!.key], mode: 'chats' });
    await svc.runBatch(b.id);
    expect(svc.batch(b.id).imported).toBe(1);
    expect(calls.some((c) => c.startsWith('importRead'))).toBe(true);
    expect(transcripts()).toEqual([]);
    // a second scan sends what the hub knows; the device reads nothing again
    calls.length = 0;
    const again = await svc.scan({ device: 'macbook', refresh: true });
    expect(again.items.find((x) => x.id === OWNER.claudeA)!.imported?.state).toBe('current');
  });

  test('the Syncthing copy on another device at another path lands in the same session', async () => {
    const hubPage = await svc.scan({ device: 'local', refresh: true });
    const local = hubPage.items.find((x) => x.id === OWNER.claudeA)!;
    expect(local.path.startsWith(hub.home)).toBe(true);
    // already imported from the MacBook: the fingerprint matches, nothing new
    expect(local.imported?.state).toBe('current');
    const before = t.engine.repos.sessions.list({ archived: true } as never).length;
    const b = await svc.startBatch({ device: 'local', keys: [local.key], mode: 'chats' });
    await svc.runBatch(b.id);
    expect(svc.batch(b.id)).toMatchObject({ imported: 0, unchanged: 1 });
    expect(t.engine.repos.sessions.list({ archived: true } as never).length).toBe(before);
  });

  test('a sync reads every copy: the one that grew appends, the stale one adds nothing, nothing forks', async () => {
    const page = await svc.scan({ device: 'macbook' });
    const sid = page.items.find((x) => x.id === OWNER.claudeA)!.imported!.sessionId!;
    const before = t.engine.repos.messages.list(sid).length;
    const sessions = t.engine.repos.sessions.list({ archived: true } as never).length;
    // the owner kept going in Claude Code on the MacBook; the hub's Syncthing copy has not caught up
    growClaudeA(mac, new Date().toISOString());
    expect(await svc.syncSession(sid)).toEqual({ state: 'updated', added: 2 });
    expect(t.engine.repos.messages.list(sid).length).toBe(before + 2);
    expect(await svc.syncSession(sid)).toEqual({ state: 'unchanged', added: 0 });
    expect(t.engine.repos.sessions.list({ archived: true } as never).length).toBe(sessions);
  });

  test('long tool results are cut on the device', () => {
    const long = 'x'.repeat(10_000);
    const c = clipToolResults(
      { source: 'codex', nativeIdUnique: true, kind: 'main', unknown: {}, learnable: true, messages: [{ role: 'user', kind: 'normal', createdAt: 0, content: [{ type: 'tool_result', toolUseId: 't', content: long }] }] },
      2_000,
    );
    const b = c.messages[0].content[0] as { content: string; meta?: Record<string, unknown> };
    expect(b.content.length).toBeLessThan(2_200);
    expect(b.meta?.clippedFrom).toBe(10_000);
  });
});

describe('a v1 daemon', () => {
  test('is read from the hub, once per change', async () => {
    const { remote, calls } = await pair(new HomeMachine(pc, 'arch-desktop'), 1);
    expect(remote.importScan).toBeUndefined();
    attach('arch-desktop', 'arch-desktop', remote);
    const page = await svc.scan({ device: 'arch-desktop', refresh: true });
    expect(page.items.find((x) => x.id === OWNER.codexT1)).toMatchObject({ title: 'Dark mode toggle for the portfolio', device: 'arch-desktop' });
    expect(calls).not.toContain('importScan');
    const transcripts = () => calls.filter((c) => /^read(File|Text) .*\.jsonl(\.zst)?$/.test(c));
    expect(transcripts().length).toBeGreaterThan(5);
    calls.length = 0;
    await svc.scan({ device: 'arch-desktop', refresh: true });
    // nothing changed, so no transcript is read again
    expect(transcripts()).toEqual([]);
  });

  test('an offline device shows its cached rows with their scan time', async () => {
    t.engine.devices.detach('arch-desktop');
    const page = await svc.scan({ device: 'arch-desktop' });
    expect(page.offline).toBe(true);
    expect(page.scannedAt).toBeGreaterThan(0);
    expect(page.items.length).toBeGreaterThan(5);
    const b = await svc.startBatch({ device: 'arch-desktop', keys: [page.items[0].key], mode: 'chats' });
    await svc.runBatch(b.id);
    expect(svc.batch(b.id)).toMatchObject({ status: 'paused', error: 'arch-desktop is offline. Resume when it is back.' });
  });
});
