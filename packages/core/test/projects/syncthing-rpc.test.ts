/**
 * Syncthing over the daemon protocol (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.5):
 * a v2 daemon answers syncthingFolders and syncthingStatus, a v1 daemon has
 * neither (the resolver skips the Syncthing step), and the GUI API key is
 * used on the device for one status call and never sent.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MachineServer } from '../../src/machine/daemon';
import { RemoteMachine } from '../../src/machine/remote';
import { syncthingConfigDirs, syncthingFolders, syncthingStatus, type SyncthingFolder, type SyncthingStatus } from '../../src/machine/syncthing';
import type { DaemonMessage, HubMessage } from '../../src/machine/protocol';
import { SyncthingCache, syncthingLine } from '../../src/projects/syncthing';
import { FakeMachine } from '../machine/fake-machine';
import { writeSyncthing } from './machines';

const base = mkdtempSync(join(tmpdir(), 'conclave-stsync-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

class SyncedFake extends FakeMachine {
  folders: SyncthingFolder[] = [{ id: 'code-1', label: 'code', path: '/home/me/code', paused: false }];
  async syncthingFolders(): Promise<SyncthingFolder[]> {
    return this.folders;
  }
  async syncthingStatus(folderId: string): Promise<SyncthingStatus> {
    if (folderId !== 'code-1') throw Object.assign(new Error(`no Syncthing folder ${folderId} on this device`), { code: 'ENOENT' });
    return { state: 'syncing', needFiles: 3, needBytes: 1200, pullErrors: 0 };
  }
}

/** A RemoteMachine wired straight to a MachineServer, as the hub and a daemon are over the socket. */
function wire(device: FakeMachine, protocol: number): { remote: RemoteMachine; sent: DaemonMessage[] } {
  const sent: DaemonMessage[] = [];
  let remote!: RemoteMachine;
  const server = new MachineServer(device, (msg) => {
    sent.push(msg);
    queueMicrotask(() => remote.handleMessage(JSON.parse(JSON.stringify(msg)) as DaemonMessage));
  });
  remote = new RemoteMachine({
    id: device.id,
    name: device.name,
    info: { hostname: 'x', platform: 'linux', arch: 'x64', home: '/home/me', shell: '/bin/sh', clis: {}, capabilities: [] },
    send: (m) => queueMicrotask(() => server.handle(JSON.parse(JSON.stringify(m)) as HubMessage)),
    rpcTimeoutMs: 2_000,
    protocol,
  });
  return { remote, sent };
}

describe('the daemon RPCs', () => {
  test('a v2 daemon lists folders and reports one folder state', async () => {
    const { remote } = wire(new SyncedFake('mac', 'macbook'), 2);
    expect(remote.protocol).toBe(2);
    expect(await remote.syncthingFolders!()).toEqual([{ id: 'code-1', label: 'code', path: '/home/me/code', paused: false }]);
    expect(await remote.syncthingStatus!('code-1')).toEqual({ state: 'syncing', needFiles: 3, needBytes: 1200, pullErrors: 0 });
    await expect(remote.syncthingStatus!('other')).rejects.toThrow('no Syncthing folder other');
  });

  test('a v1 daemon has no Syncthing methods, and the cache says unknown', async () => {
    const { remote } = wire(new SyncedFake('old', 'old box'), 1);
    expect(remote.syncthingFolders).toBeUndefined();
    expect(remote.syncthingStatus).toBeUndefined();
    const kv = new Map<string, unknown>();
    const cache = new SyncthingCache({ get: (k: string, d: unknown) => (kv.has(k) ? kv.get(k) : d), set: (k: string, v: unknown) => void kv.set(k, v) } as never);
    expect(await cache.folders('old', remote)).toBeUndefined();
    expect(syncthingLine(undefined, [])).toContain('cannot report Syncthing folders');
    const two = [
      { id: 'a', label: 'a', path: '/a', paused: false },
      { id: 'b', label: 'b', path: '/b', paused: true },
    ];
    expect(syncthingLine(two, [undefined, undefined])).toBe('2 folders, 1 paused. Syncthing is not answering here, so their sync state is unknown.');
    expect(syncthingLine(two, [{ state: 'syncing', needFiles: 4, needBytes: 1, pullErrors: 0 }, undefined])).toBe('2 folders, 1 syncing, 1 paused.');
  });

  test('a v2 daemon on a machine without Syncthing support says not implemented', async () => {
    const { remote } = wire(new FakeMachine('bare', 'bare box'), 2);
    await expect(remote.syncthingFolders!()).rejects.toThrow('not implemented');
  });

  test('the cache keeps the last answer for 10 minutes and serves it while the device is offline', async () => {
    let now = 1_000;
    const kv = new Map<string, unknown>();
    const repo = { get: (k: string, d: unknown) => (kv.has(k) ? kv.get(k) : d), set: (k: string, v: unknown) => void kv.set(k, v) };
    const cache = new SyncthingCache(repo as never, 10 * 60_000, () => now);
    const dev = new SyncedFake('mac', 'macbook');
    expect(await cache.folders('mac', dev)).toHaveLength(1);
    dev.folders = [];
    now += 60_000;
    expect(await cache.folders('mac', dev)).toHaveLength(1);
    expect(await cache.folders('mac', undefined)).toHaveLength(1);
    now += 10 * 60_000;
    expect(await cache.folders('mac', dev)).toEqual([]);
    expect(await cache.folders('mac', dev, { refresh: true })).toEqual([]);
  });
});

describe('config.xml and the local REST API', () => {
  test('config dirs follow Syncthing order, newest layout first', () => {
    expect(syncthingConfigDirs('/home/k', { XDG_STATE_HOME: '/s' })).toEqual(['/s/syncthing', '/home/k/.local/state/syncthing', '/home/k/.config/syncthing', '/home/k/Library/Application Support/Syncthing']);
    expect(syncthingConfigDirs('/home/k', { STCONFDIR: '/c' })[0]).toBe('/c');
  });

  test('status calls 127.0.0.1:8384 with the key from config.xml and returns only four fields', async () => {
    const home = join(base, 'h1');
    writeSyncthing(home, [{ id: 'code-1', path: '~/code' }]);
    const calls: Array<{ url: string; key: string | null }> = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key') });
      return new Response(JSON.stringify({ state: 'idle', needFiles: 0, needBytes: 0, pullErrors: 1, globalBytes: 99, inSyncFiles: 12 }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const st = await syncthingStatus('code-1', home, {}, fakeFetch);
    expect(st).toEqual({ state: 'idle', needFiles: 0, needBytes: 0, pullErrors: 1 });
    expect(calls).toEqual([{ url: 'http://127.0.0.1:8384/rest/db/status?folder=code-1', key: 'SECRET-KEY-NEVER-LEAVES' }]);
    await expect(syncthingStatus('nope', home, {}, fakeFetch)).rejects.toThrow('no Syncthing folder nope');
    // the folder list never carries the key
    expect(JSON.stringify(await syncthingFolders(home, {}))).not.toContain('SECRET');
  });
});
