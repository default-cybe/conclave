/**
 * The TypeScript daemon updates itself (cli/src/daemon-update.ts, protocol 4):
 * the first checks it shares with the Rust daemon, the desktop app's copy,
 * and a whole update from a fake release server: download, signature, the
 * new conclave's version, the folder swap and the mark the next start reads.
 *
 *   bun test packages/cli/test/daemon-update.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { hubArchive, hubTarget, minisignSigner, readUpdateKey, type UpdateManifest } from '@conclave/core/update/index.ts';
import { daemonSelf, selfUpdate, settleUpdate } from '../src/daemon-update';

const dirs: string[] = [];
const tmp = (n: string) => {
  const d = mkdtempSync(join(tmpdir(), `conclave-dupd-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = minisignSigner(privateKey, publicKey);
const KEY = readUpdateKey(signer.publicKey);
const TARGET = hubTarget('linux', 'x64', true)!;

function archive(version: string): Uint8Array {
  const root = tmp('arch');
  const dir = join(root, `conclave-${TARGET}`);
  mkdirSync(join(dir, 'web'), { recursive: true });
  writeFileSync(join(dir, 'conclave'), `#!/bin/sh\necho ${version}\n`);
  chmodSync(join(dir, 'conclave'), 0o755);
  const out = join(root, 'a.tar.gz');
  expect(Bun.spawnSync(['tar', '-czf', out, '-C', root, `conclave-${TARGET}`]).exitCode).toBe(0);
  return new Uint8Array(readFileSync(out));
}

function manifest(version: string, bytes: Uint8Array, signedBy = signer): UpdateManifest {
  const file = hubArchive(TARGET);
  return {
    schema: 1,
    version,
    tag: `v${version}`,
    notes: '',
    pubDate: '',
    signed: true,
    hub: { [TARGET]: { file, url: `http://127.0.0.1:9/${file}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength, signature: signedBy.sign(bytes) } },
    daemon: {},
    desktop: {},
  };
}

const serve = (bytes: Uint8Array) => (async () => new Response(bytes as unknown as BodyInit, { headers: { 'content-length': String(bytes.byteLength) } })) as unknown as typeof fetch;

describe('selfUpdate', () => {
  test('the first checks, in the order the Rust daemon has them', async () => {
    const m = manifest('0.5.0', archive('0.5.0'));
    await expect(selfUpdate({ version: 'nope', manifest: m }, { current: '0.4.1' })).rejects.toMatchObject({ message: 'selfUpdate needs a version.', code: 'EINVAL' });
    await expect(selfUpdate({ version: '0.4.1', manifest: m }, { current: '0.4.1' })).rejects.toMatchObject({ message: 'Conclave 0.4.1 is not newer than this daemon (0.4.1).', code: 'EUPTODATE' });
    await expect(selfUpdate({ version: '0.6.0', manifest: m }, { current: '0.4.1' })).rejects.toMatchObject({ code: 'EINVAL' });
  });

  test("the desktop app's copy, the placeholder key and an unsigned release are refused", async () => {
    const m = manifest('0.5.0', archive('0.5.0'));
    await expect(selfUpdate({ version: '0.5.0', manifest: m }, { current: '0.4.1', install: { mode: 'app', why: 'The desktop app updates this daemon with itself.' } })).rejects.toMatchObject({ code: 'EAPP' });
    const own = { mode: 'self' as const, dir: tmp('own'), restart: 'systemd' as const };
    await expect(selfUpdate({ version: '0.5.0', manifest: m }, { current: '0.4.1', install: own, key: readUpdateKey('PLACEHOLDER') })).rejects.toMatchObject({ code: 'ENOKEY' });
    await expect(selfUpdate({ version: '0.5.0', manifest: { ...m, signed: false } }, { current: '0.4.1', install: own, key: KEY })).rejects.toMatchObject({ code: 'EUNSIGNED' });
  });

  test('download, check, swap: the old folder stays as .prev and the next start says it went through', async () => {
    const root = tmp('swap');
    const dir = join(root, 'conclave');
    mkdirSync(join(dir, 'web'), { recursive: true });
    writeFileSync(join(dir, 'conclave'), '#!/bin/sh\necho 0.4.1\n');
    const bytes = archive('0.5.0');
    const mark = join(root, 'daemon-update.json');
    let restarted = false;
    const r = await selfUpdate(
      { version: '0.5.0', manifest: manifest('0.5.0', bytes) },
      { current: '0.4.1', install: { mode: 'self', dir, restart: 'systemd' }, key: KEY, fetch: serve(bytes), platform: 'linux', arch: 'x64', avx2: true, markFile: mark, restart: () => (restarted = true) },
    );
    expect(r).toEqual({ from: '0.4.1', to: '0.5.0', restarting: true });
    expect(readFileSync(join(dir, 'conclave'), 'utf8')).toContain('0.5.0');
    expect(readFileSync(join(`${dir}.prev`, 'conclave'), 'utf8')).toContain('0.4.1');
    await Bun.sleep(900);
    expect(restarted).toBe(true);
    // the new binary starts: the mark says done, and the hello carries it
    const last = settleUpdate(mark, '0.5.0');
    expect(last).toMatchObject({ from: '0.4.1', to: '0.5.0', ok: true });
    expect(daemonSelf({ mode: 'self', dir }, last)).toMatchObject({ impl: 'ts', update: 'self', lastUpdate: { to: '0.5.0', ok: true } });
  });

  test('a file signed with another key changes nothing', async () => {
    const root = tmp('bad');
    const dir = join(root, 'conclave');
    mkdirSync(join(dir, 'web'), { recursive: true });
    writeFileSync(join(dir, 'conclave'), '#!/bin/sh\necho 0.4.1\n');
    const bytes = archive('0.5.0');
    const other = generateKeyPairSync('ed25519');
    const m = manifest('0.5.0', bytes, minisignSigner(other.privateKey, other.publicKey, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])));
    await expect(
      selfUpdate({ version: '0.5.0', manifest: m }, { current: '0.4.1', install: { mode: 'self', dir, restart: 'systemd' }, key: KEY, fetch: serve(bytes), platform: 'linux', arch: 'x64', avx2: true, markFile: join(root, 'm.json') }),
    ).rejects.toMatchObject({ code: 'EUPDATE', message: expect.stringContaining('another key') });
    expect(readFileSync(join(dir, 'conclave'), 'utf8')).toContain('0.4.1');
    expect(existsSync(`${dir}.prev`)).toBe(false);
  });
});
