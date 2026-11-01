/**
 * The release side of updates: which assets are update files, the manifest
 * and the Tauri latest.json made from a release folder, and the updater
 * config tauri build gets. Fake files, no network, no key.
 *
 *   bun test scripts/releases
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest } from '../../packages/core/src/update/manifest';
import { buildManifest, classify, signAll, tauriConfig, updateFiles } from './updates';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const TAG = 'v0.5.0';
const TAURI_PUB = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM0NkJEQjQ3MEM2Q0MxQUQKUldTdHdXd01SOXRyTkZwNE84WHF0Rmk0UUMrWHZxK3FiOGdzYnZwQ3pIWkM1dVYySTVITmhJckMK';

/** A release folder as Publish public downloads it. `sign`: which files have a .sig. */
function release(names: string[], sign: (n: string) => boolean = () => true): string {
  const d = mkdtempSync(join(tmpdir(), 'conclave-release-'));
  dirs.push(d);
  for (const n of names) {
    writeFileSync(join(d, n), `bytes of ${n}`);
    writeFileSync(join(d, `${n}.sha256`), 'x');
    if (classify(n, TAG) && sign(n)) writeFileSync(join(d, `${n}.sig`), `sig-of-${n}`);
  }
  return d;
}

const ALL = [
  'conclave-linux-x64.tar.gz',
  'conclave-linux-x64-baseline.tar.gz',
  'conclave-linux-arm64.tar.gz',
  'conclave-darwin-x64.tar.gz',
  'conclave-darwin-arm64.tar.gz',
  'conclave-windows-x64.zip',
  'conclave-daemon-x86_64-unknown-linux-gnu',
  'conclave-daemon-aarch64-unknown-linux-gnu',
  'conclave-daemon-aarch64-apple-darwin',
  'conclave-daemon-x86_64-apple-darwin',
  'conclave-daemon-x86_64-pc-windows-msvc.exe',
  'conclave-v0.5.0.apk',
  'Conclave_aarch64.app.tar.gz',
  'Conclave_x64.app.tar.gz',
  'Conclave_0.5.0_x64-setup.exe',
  'Conclave_0.5.0_amd64.AppImage',
  // not update files: installers people download, the debug APK
  'Conclave_0.5.0_aarch64.dmg',
  'Conclave_0.5.0_amd64.deb',
  'Conclave_0.5.0_x64_en-US.msi',
  'conclave-v0.5.0-debug.apk',
  'install.sh',
];

describe('release files', () => {
  test('update files are the hub archives, the daemons, the release APK and the Tauri updater bundles', () => {
    const d = release(ALL);
    expect(updateFiles(d, TAG)).toEqual(
      [
        'Conclave_0.5.0_amd64.AppImage',
        'Conclave_0.5.0_x64-setup.exe',
        'Conclave_aarch64.app.tar.gz',
        'Conclave_x64.app.tar.gz',
        'conclave-daemon-aarch64-apple-darwin',
        'conclave-daemon-aarch64-unknown-linux-gnu',
        'conclave-daemon-x86_64-apple-darwin',
        'conclave-daemon-x86_64-pc-windows-msvc.exe',
        'conclave-daemon-x86_64-unknown-linux-gnu',
        'conclave-darwin-arm64.tar.gz',
        'conclave-darwin-x64.tar.gz',
        'conclave-linux-arm64.tar.gz',
        'conclave-linux-x64-baseline.tar.gz',
        'conclave-linux-x64.tar.gz',
        'conclave-v0.5.0.apk',
        'conclave-windows-x64.zip',
      ].sort(),
    );
    expect(classify('conclave-linux-x64.tar.gz.sig', TAG)).toBeUndefined();
    expect(classify('conclave-v0.5.0-debug.apk', TAG)).toBeUndefined();
  });

  test('a signed release: every entry with its URL on the public repo, SHA-256, size and signature; Tauri gets its shape', () => {
    const d = release(ALL);
    const b = buildManifest({ dir: d, tag: TAG, repo: 'default-cybe/conclave-releases', notes: 'What changed', now: new Date('2026-10-21T12:00:00Z') });
    const m = parseManifest(b.manifest);
    expect(m).toMatchObject({ version: '0.5.0', tag: TAG, notes: 'What changed', signed: true, pubDate: '2026-10-21T12:00:00.000Z' });
    expect(Object.keys(m.hub).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-x64-baseline', 'windows-x64']);
    expect(Object.keys(m.daemon).sort()).toEqual(['aarch64-apple-darwin', 'aarch64-unknown-linux-gnu', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']);
    expect(m.hub['linux-x64']).toEqual({
      file: 'conclave-linux-x64.tar.gz',
      url: 'https://github.com/default-cybe/conclave-releases/releases/download/v0.5.0/conclave-linux-x64.tar.gz',
      sha256: new Bun.CryptoHasher('sha256').update('bytes of conclave-linux-x64.tar.gz').digest('hex'),
      size: 'bytes of conclave-linux-x64.tar.gz'.length,
      signature: 'sig-of-conclave-linux-x64.tar.gz',
    });
    expect(m.android?.file).toBe('conclave-v0.5.0.apk');
    expect(b.tauri).toEqual({
      version: '0.5.0',
      notes: 'What changed',
      pub_date: '2026-10-21T12:00:00.000Z',
      platforms: {
        'darwin-aarch64': { signature: 'sig-of-Conclave_aarch64.app.tar.gz', url: 'https://github.com/default-cybe/conclave-releases/releases/download/v0.5.0/Conclave_aarch64.app.tar.gz' },
        'darwin-x86_64': { signature: 'sig-of-Conclave_x64.app.tar.gz', url: 'https://github.com/default-cybe/conclave-releases/releases/download/v0.5.0/Conclave_x64.app.tar.gz' },
        'windows-x86_64': { signature: 'sig-of-Conclave_0.5.0_x64-setup.exe', url: 'https://github.com/default-cybe/conclave-releases/releases/download/v0.5.0/Conclave_0.5.0_x64-setup.exe' },
        'linux-x86_64': { signature: 'sig-of-Conclave_0.5.0_amd64.AppImage', url: 'https://github.com/default-cybe/conclave-releases/releases/download/v0.5.0/Conclave_0.5.0_amd64.AppImage' },
      },
    });
  });

  test('a release built without the key is marked unsigned, and Tauri gets no platforms', () => {
    const d = release(ALL, () => false);
    const b = buildManifest({ dir: d, tag: TAG, repo: 'o/r' });
    expect(b.manifest.signed).toBe(false);
    expect(b.manifest.hub['linux-x64'].signature).toBeUndefined();
    expect(b.manifest.desktop).toEqual({});
    expect(b.tauri.platforms).toEqual({});
    expect(b.unsigned).toContain('conclave-linux-x64.tar.gz');
    // one file missing its signature is enough to call the release unsigned
    expect(buildManifest({ dir: release(ALL, (n) => n !== 'conclave-daemon-aarch64-apple-darwin'), tag: TAG, repo: 'o/r' }).manifest.signed).toBe(false);
    expect(() => buildManifest({ dir: d, tag: 'latest', repo: 'o/r' })).toThrow('Not a release tag');
  });

  test('signing without the secret signs nothing and says so', () => {
    const d = release(ALL, () => false);
    expect(signAll(d, TAG, {})).toEqual({ signed: [], skipped: true });
  });

  test('tauri build gets the updater bundles only with the secret and a real key', () => {
    expect(tauriConfig(`# key\n${TAURI_PUB}\n`, false).config).toBe('{}');
    const placeholder = tauriConfig('# key\nPLACEHOLDER\n', true);
    expect(placeholder.config).toBe('{}');
    expect(placeholder.note).toContain('placeholder');
    const on = JSON.parse(tauriConfig(`# key\n${TAURI_PUB}\n`, true).config);
    expect(on).toEqual({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: TAURI_PUB } } });
    // a bare RWQ line becomes the key file Tauri wants
    const bare = Buffer.from(TAURI_PUB, 'base64').toString('utf8').split('\n')[1];
    const wrapped = JSON.parse(tauriConfig(bare, true).config).plugins.updater.pubkey;
    expect(Buffer.from(wrapped, 'base64').toString('utf8')).toContain(bare);
  });
});
