/**
 * Release tooling for updates (docs/DESIGN.md, Updates). The workflows call it:
 *
 *   bun scripts/releases/updates.ts tauri-config
 *       Release, desktop job: prints the TAURI_CONFIG that turns on the Tauri
 *       updater bundles with the committed public key, or {} when the signing
 *       secret or the key is missing (tauri build fails on a half setup).
 *
 *   bun scripts/releases/updates.ts sign <dir>
 *       Release and Publish public: signs every update file in <dir> that has
 *       no .sig yet, with `tauri signer sign` and TAURI_SIGNING_PRIVATE_KEY
 *       (+ _PASSWORD). Without the secret it signs nothing and says the release
 *       is unsigned. The key never reaches the log.
 *
 *   bun scripts/releases/updates.ts manifest <dir> --tag v0.5.0 --repo OWNER/NAME [--notes-file F]
 *       Publish public: writes conclave-update.json (the manifest every
 *       Conclave updater reads) and latest.json (the Tauri updater's shape)
 *       into <dir>, with URLs on that repo's release.
 *
 * The functions are exported for scripts/releases/updates.test.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keyLine, readUpdateKey, tauriPubkey } from '../../packages/core/src/update/key';
import type { UpdateArtifact, UpdateManifest } from '../../packages/core/src/update/manifest';

const ROOT = resolve(import.meta.dir, '..', '..');
export const KEY_FILE = join(ROOT, 'packages', 'core', 'src', 'update', 'update-key.pub');

// ---------------------------------------------------------------------------
// Which files are update files
// ---------------------------------------------------------------------------

const HUB = /^conclave-(linux-x64|linux-x64-baseline|linux-arm64|darwin-x64|darwin-arm64)\.tar\.gz$|^conclave-(windows-x64)\.zip$/;
const DAEMON = /^conclave-daemon-((?:x86_64|aarch64)-(?:unknown-linux-gnu|apple-darwin|pc-windows-msvc))(\.exe)?$/;

export type Kind = { kind: 'hub' | 'daemon' | 'desktop'; key: string } | { kind: 'android' };

/** What an asset is for the updaters, or undefined (checksums, signatures, installers people download). */
export function classify(name: string, tag: string): Kind | undefined {
  if (/\.(sig|sha256)$/.test(name)) return undefined;
  const hub = HUB.exec(name);
  if (hub) return { kind: 'hub', key: hub[1] ?? hub[2] };
  const daemon = DAEMON.exec(name);
  if (daemon) return { kind: 'daemon', key: daemon[1] };
  // the signed release APK only: a debug build has another key and cannot update the app in place
  if (name === `conclave-${tag}.apk`) return { kind: 'android' };
  // the Tauri updater bundles (bundle.createUpdaterArtifacts): the macOS .app.tar.gz, the NSIS installer, the AppImage
  if (/\.app\.tar\.gz$/.test(name)) return { kind: 'desktop', key: /aarch64|arm64/.test(name) ? 'darwin-aarch64' : 'darwin-x86_64' };
  if (/_x64-setup\.exe$/.test(name)) return { kind: 'desktop', key: 'windows-x86_64' };
  if (/_amd64\.AppImage$/.test(name)) return { kind: 'desktop', key: 'linux-x86_64' };
  return undefined;
}

/** Files in `dir` that updaters install, and so must be signed. */
export function updateFiles(dir: string, tag: string): string[] {
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isFile() && classify(n, tag))
    .sort();
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sigOf(dir: string, name: string): string | undefined {
  const f = join(dir, `${name}.sig`);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() || undefined : undefined;
}

export interface Built {
  manifest: UpdateManifest;
  /** The Tauri updater's static JSON. */
  tauri: { version: string; notes: string; pub_date: string; platforms: Record<string, { signature: string; url: string }> };
  /** Update files without a signature. */
  unsigned: string[];
}

export function buildManifest(opts: { dir: string; tag: string; repo: string; notes?: string; now?: Date }): Built {
  const { dir, tag } = opts;
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag)) throw new Error(`Not a release tag: ${tag}`);
  const version = tag.slice(1);
  const base = `https://github.com/${opts.repo}/releases/download/${tag}`;
  const notes = (opts.notes ?? '').trim().slice(0, 4000);
  const pubDate = (opts.now ?? new Date()).toISOString();
  const manifest: UpdateManifest = { schema: 1, version, tag, notes, pubDate, signed: false, hub: {}, daemon: {}, desktop: {} };
  const unsigned: string[] = [];
  for (const name of updateFiles(dir, tag)) {
    const k = classify(name, tag)!;
    const signature = sigOf(dir, name);
    if (!signature) unsigned.push(name);
    // Tauri cannot use a desktop bundle without its signature
    if (k.kind === 'desktop' && !signature) continue;
    const a: UpdateArtifact = { file: name, url: `${base}/${name}`, sha256: sha256(join(dir, name)), size: statSync(join(dir, name)).size, ...(signature ? { signature } : {}) };
    if (k.kind === 'android') manifest.android = a;
    else manifest[k.kind][k.key] = a;
  }
  const count = Object.keys(manifest.hub).length + Object.keys(manifest.daemon).length + (manifest.android ? 1 : 0);
  // signed: every file a Conclave updater installs carries a signature
  manifest.signed = count > 0 && unsigned.length === 0;
  const platforms: Built['tauri']['platforms'] = {};
  for (const [key, a] of Object.entries(manifest.desktop)) if (a.signature) platforms[key] = { signature: a.signature, url: a.url };
  return { manifest, tauri: { version, notes, pub_date: pubDate, platforms }, unsigned };
}

// ---------------------------------------------------------------------------
// Tauri's updater config for the build, and signing
// ---------------------------------------------------------------------------

/** TAURI_CONFIG for tauri build: the updater bundles with the committed key, or {} without a secret or a key. */
export function tauriConfig(keyText: string, hasSecret: boolean): { config: string; note?: string } {
  if (!hasSecret) return { config: '{}', note: 'No TAURI_SIGNING_PRIVATE_KEY secret: no updater bundles, the desktop app of this release does not update itself.' };
  const key = readUpdateKey(keyText);
  if (!key.ok) return { config: '{}', note: 'TAURI_SIGNING_PRIVATE_KEY is set, but packages/core/src/update/update-key.pub is still the placeholder. Commit the public key; until then no updater bundles.' };
  // the bundler checks the secret against this key and fails the build when they differ
  return { config: JSON.stringify({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: tauriPubkey(keyLine(keyText)) } } }) };
}

function tauriBin(): string {
  const bin = join(ROOT, 'packages', 'desktop', 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
  if (!existsSync(bin)) throw new Error('The Tauri CLI is missing: run bun install first.');
  return bin;
}

/** Sign every update file in `dir` that has no .sig. Returns what it signed; nothing without the secret. */
export function signAll(dir: string, tag: string, env: Record<string, string | undefined> = process.env): { signed: string[]; skipped: boolean } {
  if (!env.TAURI_SIGNING_PRIVATE_KEY) return { signed: [], skipped: true };
  const signed: string[] = [];
  for (const name of updateFiles(dir, tag)) {
    if (existsSync(join(dir, `${name}.sig`))) continue;
    // the CLI reads TAURI_SIGNING_PRIVATE_KEY and _PASSWORD itself; its output is the signature, never the key
    const r = Bun.spawnSync([tauriBin(), 'signer', 'sign', join(dir, name)], { env: { ...env, NO_COLOR: '1' }, stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode !== 0 || !existsSync(join(dir, `${name}.sig`))) {
      const said = new TextDecoder().decode(r.stderr).replace(/[A-Za-z0-9+/=]{60,}/g, '[redacted]').trim().split('\n').slice(-3).join(' ');
      throw new Error(`Could not sign ${name}: ${said || `tauri signer exited ${r.exitCode}`}`);
    }
    signed.push(name);
  }
  return { signed, skipped: false };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function tagOf(dir: string, args: string[]): string {
  const t = flag(args, '--tag') ?? process.env.TAG ?? '';
  if (!t) throw new Error('--tag is required');
  if (!existsSync(dir)) throw new Error(`No folder ${dir}`);
  return t;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'tauri-config') {
      // HAS_SIGNING_KEY: the workflow says whether the secret exists without handing it to this step
      const r = tauriConfig(readFileSync(KEY_FILE, 'utf8'), process.env.HAS_SIGNING_KEY === 'true' || !!process.env.TAURI_SIGNING_PRIVATE_KEY);
      if (r.note) console.error(`::notice::${r.note}`);
      console.log(r.config);
    } else if (cmd === 'sign') {
      const dir = rest[0];
      const tag = tagOf(dir, rest);
      const r = signAll(dir, tag);
      if (r.skipped) console.log(`::notice::No TAURI_SIGNING_PRIVATE_KEY secret, so ${tag} is unsigned. Updaters will not install it; people update by hand.`);
      else console.log(r.signed.length ? `Signed ${r.signed.join(', ')}` : 'Every update file was signed already.');
    } else if (cmd === 'manifest') {
      const dir = rest[0];
      const tag = tagOf(dir, rest);
      const repo = flag(rest, '--repo');
      if (!repo) throw new Error('--repo is required');
      const notesFile = flag(rest, '--notes-file');
      const b = buildManifest({ dir, tag, repo, notes: notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : '' });
      writeFileSync(join(dir, 'conclave-update.json'), JSON.stringify(b.manifest, null, 2) + '\n');
      writeFileSync(join(dir, 'latest.json'), JSON.stringify(b.tauri, null, 2) + '\n');
      console.log(`Manifest ${tag}: hub ${Object.keys(b.manifest.hub).join(' ') || 'none'}; daemon ${Object.keys(b.manifest.daemon).join(' ') || 'none'}; desktop ${Object.keys(b.manifest.desktop).join(' ') || 'none'}; android ${b.manifest.android ? 'yes' : 'no'}; ${b.manifest.signed ? 'signed' : 'UNSIGNED'}`);
      if (b.unsigned.length) console.log(`::warning::Unsigned update files: ${b.unsigned.join(', ')}`);
      // for the workflow: the release title says when it is unsigned
      if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `signed=${b.manifest.signed}\n`, { flag: 'a' });
    } else {
      console.error('Usage: bun scripts/releases/updates.ts tauri-config | sign <dir> --tag T | manifest <dir> --tag T --repo OWNER/NAME [--notes-file F]');
      process.exit(2);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
