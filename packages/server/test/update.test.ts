/**
 * Updates (docs/DESIGN.md, Updates): the signature check, the manifest, how
 * an install is told apart, and a whole hub update through the API with a
 * fake release server and the finisher run in this process: download, check,
 * swap, restart, health check, and the rollback when the new version does not
 * answer. Devices: a daemon older than the hub gets the selfUpdate RPC and is
 * done when it comes back with the hub's version. No network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  checkUnpacked,
  compareVersions,
  detectDaemonInstall,
  detectHubInstall,
  finishUpdate,
  hubArchive,
  hubTarget,
  hasAvx2,
  isNewer,
  keyLine,
  minisignSigner,
  parseManifest,
  parsePublicKey,
  readState,
  readUpdateKey,
  writeState,
  rollBack,
  swapIn,
  systemdUnit,
  UPDATE_KEY_TEXT,
  verifyMinisign,
  type HubInstall,
  type InstallProbe,
  type KeyState,
  type UpdateManifest,
  type UpdateRequest,
} from '@conclave/core/update/index.ts';
import type { UpdateStatusDto } from '@conclave/core/client/updates.ts';
import { runDaemon, type DaemonHandle } from '@conclave/core/machine/daemon.ts';
import { FakeMachine, waitFor } from '../../core/test/machine/fake-machine';
import { inWindow, UpdateService } from '../src/update/service';
import { ConfigStore } from '@conclave/core/config/index.ts';
import type { BusyWorkDto } from '@conclave/core/client/updates.ts';
import { createFakeEngine } from './fake-engine';
import { startHub, type TestHub } from './helpers';

const WORK: BusyWorkDto = { kind: 'session', id: 'ses_1', name: 'fix the build', device: 'local', status: 'running' };

const dirs: string[] = [];
function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `conclave-update-${name}-`));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function signerPair(keyId?: Uint8Array) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return minisignSigner(privateKey, publicKey, keyId);
}
const signer = signerPair();
const KEY = readUpdateKey(signer.publicKey) as Extract<KeyState, { ok: true }>;
/** Another key with another id. */
const other = signerPair(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
/** Another key that claims the same id. */
const impostor = signerPair();

/** From `tauri signer generate` and `tauri signer sign` over "conclave release bytes"; the private key was thrown away. The Rust and Kotlin tests use the same pair. */
const TAURI_PUB = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM0NkJEQjQ3MEM2Q0MxQUQKUldTdHdXd01SOXRyTkZwNE84WHF0Rmk0UUMrWHZxK3FiOGdzYnZwQ3pIWkM1dVYySTVITmhJckMK';
const TAURI_SIG =
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTdHdXd01SOXRyTkg1dmVUZFRUMk4zVWlyODE4Z3NLVWVOa2UzMWVWblRqRmVzbFBWNmZidm5EM2k0NE9jOTBTbHBZSlVGeGlCRmRpZFNNMjNYWkNVRGpJMzNVSzNHMndjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNTk0ODY5CWZpbGU6ZGF0YS5iaW4KS0hrUm01bHIrRGFUeElwdklONEp1MDdWOURJWnpQeGJJMjBHTFNlbXJsV1l1RWZFY25iUGZVR2UzaGxOejNXVHlPUGU0RXJuTWJkMTF2ZDVjUktrQUE9PQo=';

/** waitFor for a predicate that has to ask the hub. */
async function eventually(pred: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const TARGET = hubTarget(process.platform, process.arch, hasAvx2())!;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A release archive like the CLI job makes: conclave-<target>/conclave (a script that says its version) and web/. */
function buildArchive(version: string, opts: { says?: string; exitCode?: number } = {}): Uint8Array {
  const root = tmp('archive');
  const dir = join(root, `conclave-${TARGET}`);
  mkdirSync(join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, 'web', 'index.html'), `<p>${version}</p>`);
  writeFileSync(join(dir, 'conclave'), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${opts.says ?? version}; exit ${opts.exitCode ?? 0}; fi\nexit 0\n`);
  chmodSync(join(dir, 'conclave'), 0o755);
  const out = join(root, hubArchive(TARGET));
  const r = Bun.spawnSync(['tar', '-czf', out, '-C', root, `conclave-${TARGET}`]);
  expect(r.exitCode).toBe(0);
  return new Uint8Array(readFileSync(out));
}

/** A fake release server: a manifest per version and the files it names. */
function fakeReleases() {
  const files = new Map<string, Uint8Array>();
  const manifests = new Map<string, unknown>();
  let latest = '';
  const base = 'http://127.0.0.1:9/rel';
  const publish = (version: string, archive: Uint8Array, opts: { sign?: typeof signer | null; signedFlag?: boolean } = {}) => {
    const file = hubArchive(TARGET);
    const url = `${base}/download/v${version}/${file}`;
    files.set(url, archive);
    const s = opts.sign === undefined ? signer : opts.sign;
    const art = { file, url, sha256: sha(archive), size: archive.byteLength, ...(s ? { signature: s.sign(archive, `timestamp:1\tfile:${file}`) } : {}) };
    const m = { schema: 1, version, tag: `v${version}`, notes: `Conclave ${version}`, pubDate: '2026-10-21T00:00:00Z', signed: opts.signedFlag ?? !!s, hub: { [TARGET]: art }, daemon: {}, desktop: {} };
    manifests.set(version, m);
    latest = version;
    return m;
  };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /\/download\/v([^/]+)\/conclave-update\.json$/.exec(url);
    if (url === `${base}/latest/download/conclave-update.json`) return latest ? Response.json(manifests.get(latest)) : new Response('not found', { status: 404 });
    if (m) return manifests.has(m[1]) ? Response.json(manifests.get(m[1])) : new Response('not found', { status: 404 });
    const f = files.get(url);
    if (f) return new Response(f as unknown as BodyInit, { headers: { 'content-length': String(f.byteLength) } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const manifestUrl = (version?: string) => (version ? `${base}/download/v${version}/conclave-update.json` : `${base}/latest/download/conclave-update.json`);
  return { publish, fetch: fetchFn, manifestUrl, files };
}

// ---------------------------------------------------------------------------
// Signatures and the key
// ---------------------------------------------------------------------------

describe('minisign signatures', () => {
  const data = new TextEncoder().encode('conclave release bytes');

  test('a Tauri style signature checks out with its key, and says its trusted comment', () => {
    const sig = signer.sign(data, 'timestamp:1\tfile:conclave-linux-x64.tar.gz');
    expect(verifyMinisign(data, sig, KEY.key)).toBe('timestamp:1\tfile:conclave-linux-x64.tar.gz');
    // the raw text works too, not only Tauri's base64 of it
    expect(verifyMinisign(data, Buffer.from(sig, 'base64').toString('utf8'), KEY.key)).toContain('file:');
  });

  test('a signature made by `tauri signer sign` checks out (a throwaway key; only its public half is here)', () => {
    const key = readUpdateKey(TAURI_PUB);
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    expect(verifyMinisign(new TextEncoder().encode('conclave release bytes'), TAURI_SIG, key.key)).toBe('timestamp:1792594869\tfile:data.bin');
    expect(() => verifyMinisign(new TextEncoder().encode('conclave release bytes!'), TAURI_SIG, key.key)).toThrow('does not match');
  });

  test('a changed file, another key, a changed comment and the legacy kind are refused', () => {
    const sig = signer.sign(data);
    expect(() => verifyMinisign(new TextEncoder().encode('conclave release bytez'), sig, KEY.key)).toThrow('does not match');
    expect(() => verifyMinisign(data, other.sign(data), KEY.key)).toThrow('another key');
    expect(() => verifyMinisign(data, impostor.sign(data), KEY.key)).toThrow('does not match');
    const text = Buffer.from(sig, 'base64').toString('utf8').replace(/^trusted comment: .*$/m, 'trusted comment: timestamp:2');
    expect(() => verifyMinisign(data, text, KEY.key)).toThrow('comment was changed');
    const lines = Buffer.from(sig, 'base64').toString('utf8').split('\n');
    const raw = Buffer.from(lines[1], 'base64');
    raw[1] = 0x64; // "Ed": the whole file signed, not its hash
    lines[1] = raw.toString('base64');
    expect(() => verifyMinisign(data, lines.join('\n'), KEY.key)).toThrow('legacy');
  });

  test('the key file: the last line that is not a comment; the committed placeholder means no updates', () => {
    expect(keyLine('# a\n# b\nRWQabc\n\n')).toBe('RWQabc');
    const committed = readUpdateKey(UPDATE_KEY_TEXT);
    if (/^placeholder$/i.test(keyLine(UPDATE_KEY_TEXT))) expect(committed).toEqual({ ok: false, why: expect.stringContaining('no update key') });
    else expect(committed.ok).toBe(true);
    expect(readUpdateKey('# only comments\n').ok).toBe(false);
    expect(readUpdateKey('not a key at all').ok).toBe(false);
    // Tauri's base64 key file and the bare RWQ line are the same key
    const bare = Buffer.from(signer.publicKey, 'base64').toString('utf8').split('\n')[1];
    expect(parsePublicKey(bare)).toEqual(parsePublicKey(signer.publicKey));
  });
});

// ---------------------------------------------------------------------------
// The manifest, versions, targets, installs
// ---------------------------------------------------------------------------

describe('manifest and versions', () => {
  test('versions sort as semver; a test build is never behind', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('v0.4.1', '0.4.1')).toBe(0);
    expect(isNewer('0.5.0', '0.4.1')).toBe(true);
    expect(isNewer('0.4.1', '0.4.1')).toBe(false);
    expect(isNewer('9.9.9', 'test-123')).toBe(false);
  });

  test('a manifest is checked before anything trusts it', () => {
    const ok = { schema: 1, version: 'v0.5.0', notes: 'n', signed: true, hub: { 'linux-x64': { file: 'conclave-linux-x64.tar.gz', url: 'https://example.com/x', sha256: 'a'.repeat(64), size: 10, signature: 'sig' } } };
    expect(parseManifest(ok)).toMatchObject({ version: '0.5.0', tag: 'v0.5.0', signed: true, daemon: {}, desktop: {} });
    expect(() => parseManifest({ ...ok, schema: 2 })).toThrow('newer kind');
    expect(() => parseManifest({ ...ok, hub: { x: { ...ok.hub['linux-x64'], url: 'http://example.com/x' } } })).toThrow('bad address');
    expect(() => parseManifest({ ...ok, hub: { x: { ...ok.hub['linux-x64'], file: '../x' } } })).toThrow('bad file name');
    expect(() => parseManifest({ ...ok, hub: { x: { ...ok.hub['linux-x64'], sha256: 'zz' } } })).toThrow('SHA-256');
    expect(parseManifest({ ...ok, signed: 'yes' }).signed).toBe(false);
  });

  test('targets follow the release names, with the baseline build for CPUs without AVX2', () => {
    expect(hubTarget('linux', 'x64', true)).toBe('linux-x64');
    expect(hubTarget('linux', 'x64', false)).toBe('linux-x64-baseline');
    expect(hubTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(hubTarget('win32', 'x64')).toBe('windows-x64');
    expect(hubTarget('win32', 'arm64')).toBeUndefined();
    expect(hubArchive('windows-x64')).toBe('conclave-windows-x64.zip');
  });

  test('the night window is 03:00 to 05:00 on the hub clock', () => {
    const at = (h: number) => new Date(2026, 9, 21, h, 30).getTime();
    expect(inWindow(at(2))).toBe(false);
    expect(inWindow(at(3))).toBe(true);
    expect(inWindow(at(4))).toBe(true);
    expect(inWindow(at(5))).toBe(false);
  });
});

describe('how a hub was installed', () => {
  const USER_CG = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/conclave-hub.service\n';
  const SYSTEM_CG = '0::/system.slice/conclave-hub.service\n';
  const probe = (over: Partial<InstallProbe>): InstallProbe => ({
    platform: 'linux',
    env: {},
    execPath: '/home/kai/.local/share/conclave/conclave',
    main: '/$bunfs/root/conclave',
    uid: 1000,
    cgroup: USER_CG,
    exists: (p) => p.endsWith('/web'),
    writable: () => true,
    realpath: (p) => p,
    ...over,
  });

  test('install.sh with the user service updates itself', () => {
    const i = detectHubInstall(probe({ env: { INVOCATION_ID: 'x' } }));
    expect(i).toMatchObject({ kind: 'systemd-user', canUpdate: true, unit: 'conclave-hub.service', scope: 'user', helper: 'systemd-run', dir: '/home/kai/.local/share/conclave' });
  });

  test('setup.sh in a container uses the root helper, or says to run setup once more', () => {
    const base = { env: { INVOCATION_ID: 'x' }, cgroup: SYSTEM_CG, execPath: '/opt/conclave/release/conclave', writable: () => false };
    const withHelper = detectHubInstall(probe({ ...base, exists: (p) => p.endsWith('/web') || p === '/etc/systemd/system/conclave-update.path' }));
    expect(withHelper).toMatchObject({ kind: 'systemd-system', canUpdate: true, helper: 'path-unit', scope: 'system' });
    const old = detectHubInstall(probe(base));
    expect(old).toMatchObject({ kind: 'systemd-system', canUpdate: false });
    expect(old.why).toContain('Run setup once more');
  });

  test('Docker, the desktop app, a checkout, Windows and no service each say how to update', () => {
    expect(detectHubInstall(probe({ env: { CONCLAVE_INSTALL: 'docker' } }))).toMatchObject({ kind: 'docker', canUpdate: false, command: 'docker compose pull && docker compose up -d' });
    expect(detectHubInstall(probe({ env: { CONCLAVE_STOP_ON_STDIN_END: '1' } }))).toMatchObject({ kind: 'desktop', canUpdate: false });
    expect(detectHubInstall(probe({ main: '/src/packages/cli/src/index.ts' }))).toMatchObject({ kind: 'source', canUpdate: false });
    expect(detectHubInstall(probe({ platform: 'win32' }))).toMatchObject({ kind: 'manual', canUpdate: false });
    const manual = detectHubInstall(probe({ env: {} }));
    expect(manual).toMatchObject({ kind: 'manual', canUpdate: false });
    expect(manual.command).toContain('install.sh');
    // some other service is never restarted
    expect(detectHubInstall(probe({ env: { INVOCATION_ID: 'x' }, cgroup: '0::/system.slice/tmux.service\n' })).kind).toBe('manual');
  });

  test('the cgroup names the unit and its scope; systemd-run units are not services', () => {
    expect(systemdUnit(USER_CG)).toEqual({ unit: 'conclave-hub.service', scope: 'user' });
    expect(systemdUnit(SYSTEM_CG)).toEqual({ unit: 'conclave-hub.service', scope: 'system' });
    expect(systemdUnit('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeUndefined();
    expect(systemdUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-x.scope\n')).toBeUndefined();
  });

  test('daemons: the desktop app keeps its own, a service-run release updates itself', () => {
    const d = probe({ env: { INVOCATION_ID: 'x' }, cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/conclave-daemon.service\n' });
    expect(detectDaemonInstall(d)).toMatchObject({ mode: 'self', restart: 'systemd' });
    expect(detectDaemonInstall({ ...d, exists: (p) => p.endsWith('bundled.stamp') || p.endsWith('/web') })).toMatchObject({ mode: 'app' });
    expect(detectDaemonInstall({ ...d, env: {} }).mode).toBe('manual');
    expect(detectDaemonInstall({ ...d, platform: 'darwin', env: { XPC_SERVICE_NAME: 'dev.conclave.daemon' } })).toMatchObject({ mode: 'self', restart: 'launchd' });
  });
});

// ---------------------------------------------------------------------------
// Swap and rollback
// ---------------------------------------------------------------------------

describe('swap and rollback', () => {
  test('the new folder goes in, the old one stays as .prev, and rollback puts it back', () => {
    const root = tmp('swap');
    const install = join(root, 'conclave');
    mkdirSync(install);
    writeFileSync(join(install, 'v'), 'old');
    const staged = join(root, 'staged');
    mkdirSync(staged);
    writeFileSync(join(staged, 'v'), 'new');
    swapIn(install, staged);
    expect(readFileSync(join(install, 'v'), 'utf8')).toBe('new');
    expect(readFileSync(join(`${install}.prev`, 'v'), 'utf8')).toBe('old');
    expect(existsSync(staged)).toBe(false);
    expect(rollBack(install)).toBe(true);
    expect(readFileSync(join(install, 'v'), 'utf8')).toBe('old');
    expect(readFileSync(join(`${install}.failed`, 'v'), 'utf8')).toBe('new');
    expect(rollBack(install)).toBe(false);
  });

  test('the unpacked program must say the version asked for, and be newer', async () => {
    const say = (v: string | undefined) => async () => v;
    await expect(checkUnpacked('/x', '0.5.0', '0.4.1', say(undefined))).rejects.toThrow('does not start');
    await expect(checkUnpacked('/x', '0.5.0', '0.4.1', say('0.4.0'))).rejects.toThrow('says it is 0.4.0');
    await expect(checkUnpacked('/x', '0.4.1', '0.4.1', say('0.4.1'))).rejects.toThrow('not newer');
    await checkUnpacked('/x', '0.5.0', '0.4.1', say('0.5.0'));
  });
});

// ---------------------------------------------------------------------------
// The finisher on its own
// ---------------------------------------------------------------------------

describe('finisher', () => {
  function setup(version: string, archive: Uint8Array, sig: string | undefined) {
    const root = tmp('finish');
    const install = join(root, 'release');
    mkdirSync(join(install, 'web'), { recursive: true });
    writeFileSync(join(install, 'conclave'), '#!/bin/sh\necho 0.4.1\n');
    const updatesDir = join(root, 'home', 'updates');
    mkdirSync(updatesDir, { recursive: true });
    const file = hubArchive(TARGET);
    writeFileSync(join(updatesDir, file), archive);
    const req: UpdateRequest = {
      id: 'job1',
      version,
      from: '0.4.1',
      target: TARGET,
      artifact: { file, url: 'https://example.com/x', sha256: sha(archive), size: archive.byteLength, ...(sig ? { signature: sig } : {}) },
      healthUrl: 'http://127.0.0.1:7717',
      unit: 'conclave-hub.service',
      scope: 'user',
      by: 'owner',
      at: 1,
    };
    writeFileSync(join(updatesDir, 'request.json'), JSON.stringify(req));
    return { install, updatesDir, req };
  }

  test('a file signed with another key changes nothing', async () => {
    const archive = buildArchive('0.5.0');
    const { install, updatesDir } = setup('0.5.0', archive, other.sign(archive));
    const restarts: string[] = [];
    const s = await finishUpdate({ updatesDir, install, current: '0.4.1', key: KEY, restart: async (r) => void restarts.push(r.unit), health: async () => true });
    expect(s).toMatchObject({ phase: 'failed', message: expect.stringContaining('another key') });
    expect(restarts).toEqual([]);
    expect(readFileSync(join(install, 'conclave'), 'utf8')).toContain('0.4.1');
    expect(existsSync(join(updatesDir, 'request.json'))).toBe(false);
    expect(readState(updatesDir)?.phase).toBe('failed');
  });

  test('without the key (the placeholder) nothing installs', async () => {
    const archive = buildArchive('0.5.0');
    const { install, updatesDir } = setup('0.5.0', archive, signer.sign(archive));
    const s = await finishUpdate({ updatesDir, install, current: '0.4.1', key: readUpdateKey('PLACEHOLDER'), restart: async () => {}, health: async () => true });
    expect(s).toMatchObject({ phase: 'failed', message: expect.stringContaining('no update key') });
  });

  test('a program that says another version is not swapped in', async () => {
    const archive = buildArchive('0.5.0', { says: '0.3.0' });
    const { install, updatesDir } = setup('0.5.0', archive, signer.sign(archive));
    const s = await finishUpdate({ updatesDir, install, current: '0.4.1', key: KEY, restart: async () => {}, health: async () => true });
    expect(s).toMatchObject({ phase: 'failed', message: expect.stringContaining('says it is 0.3.0') });
    expect(existsSync(`${install}.prev`)).toBe(false);
  });

  test('a request naming a service that is not Conclave is ignored', async () => {
    const archive = buildArchive('0.5.0');
    const { install, updatesDir, req } = setup('0.5.0', archive, signer.sign(archive));
    writeFileSync(join(updatesDir, 'request.json'), JSON.stringify({ ...req, unit: 'sshd.service' }));
    const restarts: string[] = [];
    expect(await finishUpdate({ updatesDir, install, current: '0.4.1', key: KEY, restart: async (r) => void restarts.push(r.unit), health: async () => true })).toBeUndefined();
    expect(restarts).toEqual([]);
  });

  test('the state file is never written through a link the hub planted at the temp name', () => {
    const root = tmp('state');
    const updatesDir = join(root, 'updates');
    mkdirSync(updatesDir);
    const victim = join(root, 'victim');
    writeFileSync(victim, 'keep');
    // the old name was state.json.<pid>.tmp: a root finisher followed this link
    symlinkSync(victim, join(updatesDir, `state.json.${process.pid}.tmp`));
    writeState(updatesDir, { id: 'j', version: '0.5.0', from: '0.4.1', phase: 'installing', startedAt: 1, by: 'owner' });
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(readState(updatesDir)?.phase).toBe('installing');
    expect(readdirSync(updatesDir).filter((f) => f.endsWith('.tmp') && f !== `state.json.${process.pid}.tmp`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The whole update through the API
// ---------------------------------------------------------------------------

describe('hub update through the API', () => {
  let hub: TestHub;
  let installDir: string;
  const releases = fakeReleases();
  const restarts: string[] = [];
  /** What the fake service answers after a restart: the version in the folder, or nothing. */
  let answers: (version: string) => boolean = () => true;

  beforeAll(() => {
    const root = tmp('hub');
    installDir = join(root, 'share', 'conclave');
    mkdirSync(join(installDir, 'web'), { recursive: true });
    writeFileSync(join(installDir, 'conclave'), '#!/bin/sh\necho 0.0.0-test\n');
    const install: HubInstall = { kind: 'systemd-user', canUpdate: true, dir: installDir, unit: 'conclave-hub.service', scope: 'user', helper: 'systemd-run' };
    hub = startHub({
      update: {
        install,
        key: KEY,
        fetch: releases.fetch,
        manifestUrl: releases.manifestUrl,
        pollMs: 20,
        // the finisher, in this process, with a fake systemctl and a fake health check
        startFinisher: async (_req, i, updatesDir) => {
          void finishUpdate({
            updatesDir,
            install: i.dir!,
            current: '0.0.0-test',
            key: KEY,
            restart: async (r) => void restarts.push(`${r.scope} restart ${r.unit}`),
            health: async (_r, version) => answers(version),
          });
        },
      },
    });
  });
  afterAll(async () => {
    await hub.stop();
  });

  const status = async () => (await hub.api('/api/update').then((r) => r.json())) as UpdateStatusDto;
  const until = (pred: (s: UpdateStatusDto) => boolean, what: string) => eventually(async () => pred(await status()), 10_000, what);

  test('before a check: the running version and how this hub updates', async () => {
    const s = await status();
    expect(s).toMatchObject({ current: '0.0.0-test', available: false, checking: false, keyMissing: false, install: { kind: 'systemd-user', canUpdate: true }, auto: { on: true, window: 'idle', hours: '03:00 to 05:00' } });
    expect(s.install).not.toHaveProperty('unit');
  });

  test('no release yet, then a release: check says what is new', async () => {
    const none = await hub.api('/api/update/check', { method: 'POST' }).then((r) => r.json());
    expect(none.checkError).toBe('No release has an update manifest yet.');
    releases.publish('0.5.0', buildArchive('0.5.0'));
    const s = (await hub.api('/api/update/check', { method: 'POST' }).then((r) => r.json())) as UpdateStatusDto;
    expect(s).toMatchObject({ available: true, latest: { version: '0.5.0', notes: 'Conclave 0.5.0', signed: true } });
    expect(s.checkError).toBeUndefined();
    expect(s.checkedAt).toBeGreaterThan(0);
  });

  test('Update now while work runs: 409 with what runs, nothing starts', async () => {
    hub.engine.busyWork = () => [WORK, { kind: 'workflow', id: 'wr_1', name: 'review', device: 'local', status: 'running' }];
    const res = await hub.api('/api/update/apply', { method: 'POST', json: { version: '0.5.0' } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('1 session, 1 workflow run running: fix the build, review.');
    expect(body.busy).toHaveLength(2);
    expect((await status()).job).toBeUndefined();
    expect((await hub.api('/api/update/apply', { method: 'POST', json: { version: '0.5.0', force: 'yes' } })).status).toBe(400);
  });

  test('Update now: download, check, swap, restart, health; the old version stays as .prev', async () => {
    // Update anyway: force goes past the running work
    const res = await hub.api('/api/update/apply', { method: 'POST', json: { version: '0.5.0', force: true } });
    expect(res.status).toBe(202);
    hub.engine.busyWork = () => [];
    await until((s) => s.job?.phase === 'done', 'update done');
    const s = await status();
    expect(s.job).toMatchObject({ version: '0.5.0', from: '0.0.0-test', phase: 'done', by: 'owner' });
    expect(restarts).toEqual(['user restart conclave-hub.service']);
    expect(readFileSync(join(installDir, 'web', 'index.html'), 'utf8')).toContain('0.5.0');
    expect(readFileSync(join(`${installDir}.prev`, 'conclave'), 'utf8')).toContain('0.0.0-test');
    // the download is gone once it is in place
    expect(existsSync(join(hub.engine.config.paths.home, 'updates', hubArchive(TARGET)))).toBe(false);
    const audit = hub.engine.repos.audit.list({ limit: 20 }).map((a) => a.action);
    expect(audit).toContain('update.start');
    await waitFor(() => hub.engine.repos.audit.list({ limit: 20 }).some((a) => a.action === 'update.done'), 3000, 'audit line');
    // the owner hears it, once
    const told = hub.engine.calls.filter((c) => c.method === 'notifyEvent');
    expect(told).toHaveLength(1);
    expect(told[0].args).toEqual(['updates', expect.objectContaining({ title: 'Conclave updated to 0.5.0', body: 'Updated from 0.0.0-test to 0.5.0.', level: 'success' })]);
  });

  test('a version that does not answer after the restart is rolled back', async () => {
    restarts.length = 0;
    releases.publish('0.6.0', buildArchive('0.6.0'));
    answers = (v) => v !== '0.6.0';
    // the fake hub still says 0.0.0-test: what is in the folder now is 0.5.0, and rollback restores it
    const res = await hub.api('/api/update/apply', { method: 'POST', json: { version: '0.6.0' } });
    expect(res.status).toBe(202);
    await until((s) => s.job?.version === '0.6.0' && s.job.phase === 'rolled-back', 'rolled back');
    const s = await status();
    expect(s.job?.message).toContain('went back to 0.0.0-test');
    expect(restarts).toEqual(['user restart conclave-hub.service', 'user restart conclave-hub.service']);
    expect(readFileSync(join(installDir, 'web', 'index.html'), 'utf8')).toContain('0.5.0');
    expect(readFileSync(join(`${installDir}.failed`, 'web', 'index.html'), 'utf8')).toContain('0.6.0');
    await waitFor(() => hub.engine.repos.audit.list({ limit: 30 }).some((a) => a.action === 'update.rolled_back'), 3000, 'rollback audit');
    expect(hub.engine.calls.filter((c) => c.method === 'notifyEvent').at(-1)?.args).toEqual(['updates', expect.objectContaining({ title: 'Update to 0.6.0 rolled back', level: 'error' })]);
    answers = () => true;
  });

  test('an unsigned release, a wrong version and a second update at once are refused', async () => {
    releases.publish('0.7.0', buildArchive('0.7.0'), { sign: null });
    await hub.api('/api/update/check', { method: 'POST' });
    const unsigned = await hub.api('/api/update/apply', { method: 'POST', json: { version: '0.7.0' } });
    expect(unsigned.status).toBe(409);
    expect((await unsigned.json()).error).toContain('unsigned');
    const wrong = await hub.api('/api/update/apply', { method: 'POST', json: { version: '0.6.5' } });
    expect(wrong.status).toBe(409);
    expect((await hub.api('/api/update/apply', { method: 'POST', json: {} })).status).toBe(400);
    // a signature from another key fails at the hub's own check, before the finisher
    releases.publish('0.8.0', buildArchive('0.8.0'), { sign: other, signedFlag: true });
    await hub.api('/api/update/check', { method: 'POST' });
    expect((await hub.api('/api/update/apply', { method: 'POST', json: { version: '0.8.0' } })).status).toBe(202);
    await until((s) => s.job?.version === '0.8.0' && s.job.phase === 'failed', 'bad signature failed');
    expect((await status()).job?.message).toContain('another key');
    // the download that failed its check is gone
    expect(existsSync(join(hub.engine.config.paths.home, 'updates', `${hubArchive(TARGET)}.part`))).toBe(false);
    expect(hub.engine.repos.audit.list({ limit: 50 }).some((a) => a.action === 'update.failed' && a.detail.includes('0.8.0'))).toBe(true);
  });

  test('Install updates automatically is the owner\'s setting, kept in the config', async () => {
    const on = (await hub.api('/api/update/settings', { method: 'PUT', json: { auto: true } }).then((r) => r.json())) as UpdateStatusDto;
    expect(on.auto.on).toBe(true);
    expect(hub.engine.config.get().updates?.auto).toBe(true);
    expect((await hub.api('/api/update/settings', { method: 'PUT', json: { auto: 'yes' } })).status).toBe(400);
    await hub.api('/api/update/settings', { method: 'PUT', json: { auto: false } });
    expect(hub.engine.repos.audit.list({ limit: 50 }).filter((a) => a.action === 'update.auto')).toHaveLength(2);
    const night = (await hub.api('/api/update/settings', { method: 'PUT', json: { window: 'night' } }).then((r) => r.json())) as UpdateStatusDto;
    expect(night.auto).toEqual({ on: false, window: 'night', hours: '03:00 to 05:00' });
    expect(hub.engine.config.getUser().updates).toEqual({ auto: false, window: 'night' });
    expect((await hub.api('/api/update/settings', { method: 'PUT', json: { window: 'noon' } })).status).toBe(400);
  });

  test('without a token nothing is shown, and a member of the hub never sees updates', async () => {
    expect((await hub.api('/api/update', { token: null })).status).toBe(401);
    const pw = 'a long enough password';
    expect((await hub.api('/api/people', { method: 'POST', json: { name: 'alice', password: pw } })).status).toBe(200);
    const login = await hub.api('/api/login', { method: 'POST', token: null, json: { account: 'alice', password: pw, name: 'phone' } }).then((r) => r.json());
    expect(login.account.role).toBe('member');
    const routes: Array<[string, string]> = [
      ['GET', '/api/update'],
      ['POST', '/api/update/check'],
      ['POST', '/api/update/apply'],
      ['PUT', '/api/update/settings'],
      ['GET', '/api/devices/updates'],
      ['POST', '/api/devices/dev_x/update'],
    ];
    for (const [method, path] of routes) expect({ path, status: (await hub.api(path, { method, token: login.token, ...(method === 'GET' ? {} : { json: {} }) })).status }).toEqual({ path, status: 403 });
  });
});

describe('automatic updates', () => {
  const noon = new Date(2026, 9, 21, 12, 0).getTime();
  function auto(config: Parameters<typeof createFakeEngine>[0] = {}) {
    const releases = fakeReleases();
    releases.publish('0.5.0', buildArchive('0.5.0'));
    const engine = createFakeEngine(config);
    let now = noon;
    const svc = new UpdateService(engine, {
      install: { kind: 'systemd-user', canUpdate: true, dir: tmp('auto'), unit: 'conclave-hub.service', scope: 'user', helper: 'systemd-run' },
      key: KEY,
      fetch: releases.fetch,
      manifestUrl: releases.manifestUrl,
      updatesDir: join(tmp('auto-home'), 'updates'),
      background: false,
      now: () => now,
      pollMs: 60_000,
      startFinisher: async () => {},
    });
    const started = () => svc.status().job?.version;
    return {
      engine,
      svc,
      started,
      at: (t: number) => (now = t),
      done: () => {
        svc.dispose();
        engine.cleanup();
      },
    };
  }

  test('defaults: on, when idle; the defaults are not written to config.json', () => {
    const home = tmp('cfg');
    const cfg = new ConfigStore(home);
    expect(cfg.get().updates).toEqual({ auto: true, window: 'idle', check: true });
    expect(cfg.getUser().updates).toBeUndefined();
  });

  test('a saved auto: false stays off, and nothing installs', async () => {
    const home = tmp('cfg-off');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ updates: { auto: false } }));
    expect(new ConfigStore(home).get().updates).toEqual({ auto: false, window: 'idle', check: true });
    const a = auto({ updates: { auto: false } });
    try {
      for (let i = 0; i < 3; i++) await a.svc.tick();
      expect(a.svc.status().available).toBe(true);
      expect(a.started()).toBeUndefined();
    } finally {
      a.done();
    }
  });

  test('when idle: it installs on the second idle tick in a row; work in between starts the count again', async () => {
    const a = auto();
    try {
      await a.svc.tick();
      expect(a.started()).toBeUndefined();
      a.engine.busyWork = () => [WORK];
      await a.svc.tick();
      a.engine.busyWork = () => [];
      await a.svc.tick();
      expect(a.started()).toBeUndefined();
      await a.svc.tick();
      expect(a.svc.status().job).toMatchObject({ version: '0.5.0', by: 'auto' });
    } finally {
      a.done();
    }
  });

  test('when idle looks every hour; at night waits for 03:00 and nothing running', async () => {
    const a = auto({ updates: { window: 'night' } });
    try {
      await a.svc.tick();
      await a.svc.tick();
      expect(a.started()).toBeUndefined();
      a.at(new Date(2026, 9, 22, 3, 30).getTime());
      a.engine.busyWork = () => [WORK];
      await a.svc.tick();
      expect(a.started()).toBeUndefined();
      a.engine.busyWork = () => [];
      await a.svc.tick();
      expect(a.started()).toBe('0.5.0');
    } finally {
      a.done();
    }
    const b = auto();
    try {
      await b.svc.tick();
      const first = b.svc.status().checkedAt;
      b.at(noon + 61 * 60_000);
      b.engine.busyWork = () => [WORK];
      await b.svc.tick();
      expect(b.svc.status().checkedAt).toBeGreaterThan(first!);
    } finally {
      b.done();
    }
  });

  test('Update when idle: a one-shot that installs once nothing runs, also with automatic updates off', async () => {
    const a = auto({ updates: { auto: false } });
    try {
      await a.svc.check();
      a.engine.busyWork = () => [WORK];
      expect((await a.svc.applyWhenIdle('0.5.0', 'owner')).whenIdle).toBe('0.5.0');
      await a.svc.tick();
      await a.svc.tick();
      expect(a.started()).toBeUndefined();
      a.engine.busyWork = () => [];
      await a.svc.tick();
      await a.svc.tick();
      expect(a.svc.status().job).toMatchObject({ version: '0.5.0', by: 'auto' });
      expect(a.svc.status().whenIdle).toBeUndefined();
    } finally {
      a.done();
    }
  });
});

describe('a hub that cannot update itself', () => {
  test('Docker says the pull command and refuses Update now', async () => {
    const releases = fakeReleases();
    releases.publish('0.5.0', buildArchive('0.5.0'));
    const hub = startHub({ update: { install: { kind: 'docker', canUpdate: false, why: 'Docker', command: 'docker compose pull && docker compose up -d' }, key: KEY, fetch: releases.fetch, manifestUrl: releases.manifestUrl } });
    try {
      const s = (await hub.api('/api/update/check', { method: 'POST' }).then((r) => r.json())) as UpdateStatusDto;
      expect(s).toMatchObject({ available: true, install: { kind: 'docker', canUpdate: false, command: 'docker compose pull && docker compose up -d' } });
      expect((await hub.api('/api/update/apply', { method: 'POST', json: { version: '0.5.0' } })).status).toBe(409);
    } finally {
      await hub.stop();
    }
  });

  test('the placeholder key: status says so and Update now is refused', async () => {
    const releases = fakeReleases();
    releases.publish('0.5.0', buildArchive('0.5.0'));
    const hub = startHub({ update: { install: { kind: 'systemd-user', canUpdate: true, dir: tmp('nokey'), unit: 'conclave-hub.service', scope: 'user' }, key: readUpdateKey('PLACEHOLDER'), fetch: releases.fetch, manifestUrl: releases.manifestUrl } });
    try {
      const s = (await hub.api('/api/update/check', { method: 'POST' }).then((r) => r.json())) as UpdateStatusDto;
      expect(s.keyMissing).toBe(true);
      const res = await hub.api('/api/update/apply', { method: 'POST', json: { version: '0.5.0' } });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('no update key');
    } finally {
      await hub.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

describe('device daemons', () => {
  let hub: TestHub;
  const daemons: DaemonHandle[] = [];
  const releases = fakeReleases();
  let manifest: UpdateManifest;

  beforeAll(() => {
    // the hub's own version is 0.0.0-test, so devices update to the manifest of that version
    manifest = parseManifest(releases.publish('0.0.0-test', buildArchive('0.0.0-test')));
    hub = startHub({ heartbeatMs: 1000, update: { install: { kind: 'docker', canUpdate: false }, key: KEY, fetch: releases.fetch, manifestUrl: releases.manifestUrl } });
  });
  afterAll(async () => {
    for (const d of daemons) d.stop();
    await hub.stop();
  });

  async function pair(name: string) {
    const pairing = await hub.api('/api/pairing', { method: 'POST', json: { kind: 'device' } }).then((r) => r.json());
    return (await hub.api('/api/daemon/register', { method: 'POST', token: null, json: { code: pairing.code, name } }).then((r) => r.json())) as { deviceId: string; token: string };
  }

  function machine(name: string, daemon: Record<string, unknown>) {
    const m = new FakeMachine(name, name);
    const info = m.info.bind(m);
    m.info = async () => ({ ...(await info()), daemon: daemon as never });
    return m;
  }

  test('an older daemon that can update itself gets the hub version and its manifest, and is done when it comes back', async () => {
    const reg = await pair('Work PC');
    const asked: unknown[] = [];
    const old = runDaemon({
      hubUrl: hub.url,
      deviceId: reg.deviceId,
      token: reg.token,
      name: 'pc',
      maxBackoffMs: 200,
      machine: machine('pc', { impl: 'ts', version: '0.0.0-alpha', update: 'self' }),
      selfUpdate: async (params) => {
        asked.push(params);
        return { from: '0.0.0-alpha', to: params.version, restarting: true };
      },
    });
    daemons.push(old);
    await waitFor(() => hub.engine.devices.isOnline(reg.deviceId), 3000, 'device online');

    const list = await hub.api('/api/devices/updates').then((r) => r.json());
    expect(list.hubVersion).toBe('0.0.0-test');
    expect(list.devices.find((d: { deviceId: string }) => d.deviceId === reg.deviceId)).toMatchObject({ current: '0.0.0-alpha', target: '0.0.0-test', mode: 'self', behind: true });

    const res = await hub.api(`/api/devices/${reg.deviceId}/update`, { method: 'POST' });
    expect(res.status).toBe(202);
    await waitFor(() => asked.length === 1, 3000, 'selfUpdate sent');
    expect(asked[0]).toEqual({ version: '0.0.0-test', manifest });
    const updating = await hub.api('/api/devices/updates').then((r) => r.json());
    await eventually(async () => (await hub.api('/api/devices/updates').then((r) => r.json())).devices.some((d: { state?: string }) => d.state === 'updating'), 3000, 'updating');
    expect(updating.devices.length).toBe(1);

    // the service starts the new binary: it says the hub's version
    old.stop();
    const back = runDaemon({ hubUrl: hub.url, deviceId: reg.deviceId, token: reg.token, name: 'pc', maxBackoffMs: 200, machine: machine('pc', { impl: 'ts', version: '0.0.0-test', update: 'self' }) });
    daemons.push(back);
    await eventually(async () => (await hub.api('/api/devices/updates').then((r) => r.json())).devices.some((d: { state?: string; behind: boolean }) => d.state === 'done' && !d.behind), 5000, 'done');
    const actions = hub.engine.repos.audit.list({ limit: 20 }).map((a) => a.action);
    expect(actions).toContain('device.update');
    expect(actions).toContain('device.update.done');
    // up to date now: nothing more to send
    expect((await hub.api(`/api/devices/${reg.deviceId}/update`, { method: 'POST' })).status).toBe(409);
  });

  test("the desktop app's daemon is left to the app, and a failure is shown", async () => {
    const app = await pair('Laptop');
    daemons.push(runDaemon({ hubUrl: hub.url, deviceId: app.deviceId, token: app.token, name: 'laptop', maxBackoffMs: 200, machine: machine('laptop', { impl: 'rust', version: '0.0.0-alpha', update: 'app', updateWhy: 'The desktop app updates this daemon with itself.' }) }));
    const bad = await pair('Server');
    daemons.push(
      runDaemon({
        hubUrl: hub.url,
        deviceId: bad.deviceId,
        token: bad.token,
        name: 'server',
        maxBackoffMs: 200,
        machine: machine('server', { impl: 'rust', version: '0.0.0-alpha', update: 'self' }),
        selfUpdate: async () => {
          throw Object.assign(new Error('The update signature does not match the file. Nothing was installed.'), { code: 'EUPDATE' });
        },
      }),
    );
    await waitFor(() => hub.engine.devices.isOnline(app.deviceId) && hub.engine.devices.isOnline(bad.deviceId), 3000, 'both online');
    const refused = await hub.api(`/api/devices/${app.deviceId}/update`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain('desktop app');
    expect((await hub.api(`/api/devices/${bad.deviceId}/update`, { method: 'POST' })).status).toBe(202);
    await eventually(
      async () => (await hub.api('/api/devices/updates').then((r) => r.json())).devices.some((d: { deviceId: string; state?: string; message?: string }) => d.deviceId === bad.deviceId && d.state === 'failed' && d.message?.includes('signature')),
      3000,
      'failed shown',
    );
  });

  test('automatic updates leave a device alone while work runs on it', async () => {
    const reg = await pair('Busy PC');
    const asked: unknown[] = [];
    daemons.push(
      runDaemon({
        hubUrl: hub.url,
        deviceId: reg.deviceId,
        token: reg.token,
        name: 'busy',
        maxBackoffMs: 200,
        machine: machine('busy', { impl: 'rust', version: '0.0.0-alpha', update: 'self' }),
        selfUpdate: async (params) => {
          asked.push(params);
          return { from: '0.0.0-alpha', to: params.version, restarting: false };
        },
      }),
    );
    await waitFor(() => hub.engine.devices.isOnline(reg.deviceId), 3000, 'device online');
    const updates = hub.running.conclave.ctx.updates;
    hub.engine.busyWork = (device) => (device === reg.deviceId ? [{ ...WORK, device: reg.deviceId }] : []);
    await updates.tick();
    await Bun.sleep(100);
    expect(asked).toHaveLength(0);
    hub.engine.busyWork = () => [];
    await updates.tick();
    await waitFor(() => asked.length === 1, 3000, 'selfUpdate sent once idle');
  });
});
