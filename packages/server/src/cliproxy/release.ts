/**
 * The CLIProxyAPI program (github.com/router-for-me/CLIProxyAPI, MIT, a
 * separate project). The hub installs one pinned release into <home>/bin
 * (/data/bin in Docker) and nothing newer: a new version reaches a hub when
 * a Conclave update adds its pin here.
 *
 * Every download is checked before it runs:
 *   1. the release's checksums.txt lists the archive, and its SHA-256 there
 *      is the one pinned below (when this OS and CPU are pinned);
 *   2. the archive's size matches the pin, its Content-Length and the bytes
 *      that arrived, and its SHA-256 matches checksums.txt;
 *   3. only the cli-proxy-api member is unpacked, it starts like a program
 *      for this machine (ELF, Mach-O, PE) and is big enough to be one;
 *   4. `cli-proxy-api -h` runs and prints the pinned version.
 * It is unpacked and staged next to its final path and renamed into place,
 * so nothing runs from a temp folder. The copy it replaces stays as
 * cli-proxy-api.prev until the new one has started, for the rollback.
 */
import { createHash } from 'node:crypto';
import { logger } from '@conclave/core/util/log.ts';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { looksExecutable, readHead, receiptPath } from '../remote/cloudflared';

export const CLIPROXY_REPO = 'router-for-me/CLIProxyAPI';
export const RELEASE_BASE = `https://github.com/${CLIPROXY_REPO}/releases/download`;

/** Every CLIProxyAPI build is far bigger than this; anything smaller is an error page. */
const MIN_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 200 * 1024 * 1024;

export interface PinnedAsset {
  sha256: string;
  size: number;
}

export interface Pin {
  /** "8.0.32", as the program prints it. */
  version: string;
  /** Release tag, "v8.0.32". */
  tag: string;
  /** Subscriptions this version signs in to (GET /v8/management/oauth/auth-url?provider=). */
  providers: string[];
  /** Archive name to its SHA-256 (from the release's checksums.txt) and size. */
  assets: Record<string, PinnedAsset>;
}

/**
 * Pinned releases, oldest first. To move to a new version: take its
 * checksums.txt and the archive sizes from the release page, add an entry
 * and update docs/INSTALL.md. Keep both Linux variants: the static build
 * preserves existing subscriptions on musl and older/unknown glibc hosts.
 */
export const PINS: Pin[] = [
  {
    version: '8.0.32',
    tag: 'v8.0.32',
    providers: ['claude', 'codex', 'antigravity', 'xai', 'kimi', 'kimi-ai', 'meta', 'devin'],
    assets: {
      'CLIProxyAPI_8.0.32_linux_amd64_no-plugin.tar.gz': { sha256: '2b48544067f25d8c8cb9db598baa4a741ed252292faacb22e67ef0a6f46257b7', size: 23362713 },
      'CLIProxyAPI_8.0.32_linux_aarch64_no-plugin.tar.gz': { sha256: 'ac44a4cc627bb53729e8b24020bac75e3aba68169cfd68eeaffb9a91f3d5566e', size: 21051593 },
      'CLIProxyAPI_8.0.32_linux_amd64.tar.gz': { sha256: '082a4a38d9470c070ac85ab2d9c4a2aa51f9a7ee19831c3b811e26fe5b7480a7', size: 23480745 },
      'CLIProxyAPI_8.0.32_linux_aarch64.tar.gz': { sha256: '76aac452dd224490ea5ea1ea0224199d7a410f14ef39a087b81893d15c62f363', size: 21158331 },
      'CLIProxyAPI_8.0.32_darwin_amd64.tar.gz': { sha256: 'c327f421d995692f6590a752abd449db5e71df61803b7041e4d3bd59cd1e1bd8', size: 23431584 },
      'CLIProxyAPI_8.0.32_darwin_aarch64.tar.gz': { sha256: '48fe6a391a01e730ee6ebe3f1609ff92578a97a7a9a44579013ca8f3a6d58d51', size: 21629235 },
      'CLIProxyAPI_8.0.32_windows_amd64.zip': { sha256: 'df364b1f2dc9fe357f6a481bfb8a4066c3e5f5ef4ad7abfe45e59b4cec547c18', size: 23752725 },
      'CLIProxyAPI_8.0.32_windows_aarch64.zip': { sha256: '9e83b3f19f3359b52a1fe7acc763ed9285698a46d49caec650943d5b67e82010', size: 21184737 },
    },
  },
];

export function newestPin(pins: Pin[] = PINS): Pin {
  return [...pins].sort((a, b) => compareVersions(a.version, b.version)).at(-1)!;
}

/** The pin for a version, or the newest pin at or below it (an external CLIProxyAPI may run any version). */
export function pinFor(version: string | undefined, pins: Pin[] = PINS): Pin {
  if (!version) return newestPin(pins);
  const below = [...pins].filter((p) => compareVersions(p.version, version) <= 0).sort((a, b) => compareVersions(a.version, b.version));
  return below.at(-1) ?? newestPin(pins);
}

/** "8.0.10" vs "8.0.9": numeric parts compared in order. "v" and anything after a "-" are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split('-')[0].split('.').map((x) => Number.parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface CliAsset {
  name: string;
  kind: 'tar.gz' | 'zip';
  /** The program's name inside the archive. */
  binary: string;
}

export interface PluginHost {
  platform?: string;
  arch?: string;
  /** null means musl/unknown. Undefined asks the runtime report. */
  glibcVersion?: string | null;
}

export function runtimeGlibc(): string | null {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
    return report?.header?.glibcVersionRuntime ?? null;
  } catch { return null; }
}

/** Only reviewed Linux plugin artifacts are offered for automatic installation.
 * Both amd64 and arm64 plugins need glibc 2.34. The main executable alone
 * needs only 2.3.2 (amd64) / 2.17 (arm64); that does not imply plugin support.
 */
export function pluginHostProblem(host: PluginHost = {}): string | undefined {
  if ((host.platform ?? process.platform) !== 'linux' || !['x64', 'arm64'].includes(host.arch ?? process.arch))
    return 'Automatic Copilot and Kiro plugin installation is supported only on reviewed Linux x64/arm64 hosts. Use an external CLIProxyAPI with these plugins already enabled.';
  const libc = host.glibcVersion === undefined ? runtimeGlibc() : host.glibcVersion;
  if (!libc || !/^\d+\.\d+(?:\.\d+)?$/.test(libc) || compareVersions(libc, '2.34') < 0)
    return 'Copilot and Kiro plugins require glibc 2.34 or newer, not musl or an unknown libc. Existing subscriptions still work with the static CLIProxyAPI build; use an external plugin-capable CLIProxyAPI for these two sign-ins.';
}

/** The release archive for this OS and CPU, or undefined when CLIProxyAPI publishes none the hub can run. */
export function assetFor(version: string, platform: string = process.platform, arch: string = process.arch, glibcVersion?: string | null): CliAsset | undefined {
  const cpu = ({ x64: 'amd64', arm64: 'aarch64' } as Record<string, string>)[arch];
  if (!cpu) return undefined;
  if (platform === 'linux') {
    const suffix = pluginHostProblem({ platform, arch, glibcVersion }) ? '_no-plugin' : '';
    return { name: `CLIProxyAPI_${version}_linux_${cpu}${suffix}.tar.gz`, kind: 'tar.gz', binary: 'cli-proxy-api' };
  }
  if (platform === 'darwin') return { name: `CLIProxyAPI_${version}_darwin_${cpu}.tar.gz`, kind: 'tar.gz', binary: 'cli-proxy-api' };
  if (platform === 'win32') return { name: `CLIProxyAPI_${version}_windows_${cpu}.zip`, kind: 'zip', binary: 'cli-proxy-api.exe' };
  return undefined;
}

export function binaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
}

/** checksums.txt ("<sha256>  <name>" per line, as sha256sum writes it) to name -> sha256. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** "CLIProxyAPI Version: 8.0.32, Commit: abc, BuiltAt: ..." -> "8.0.32". */
export function parseVersion(text: string): string | undefined {
  return /CLIProxyAPI Version:\s*v?([0-9][^\s,]*)/i.exec(text)?.[1];
}

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseError';
  }
}

/** What the hub knows about the copy it installed, kept next to it as cli-proxy-api.json. */
export interface Receipt {
  version: string;
  tag: string;
  asset: string;
  /** SHA-256 of the archive. */
  sha256: string;
  size: number;
  /** checksums: matched the release's checksums.txt. pin: matched the SHA-256 pinned in this hub. */
  checks: { checksums: boolean; pin: boolean };
  at: number;
}

export interface BinaryInfo {
  path: string;
  version?: string;
  /** The hub installed it into its home (it may replace it). False for models.cliproxy.binary. */
  managed: boolean;
  /** SHA-256 checked against checksums.txt and the pin. */
  verified: boolean;
  sha256?: string;
  receipt?: Receipt;
}

export function binDir(home: string): string {
  return join(home, 'bin');
}

export function managedPath(home: string, platform: string = process.platform): string {
  return join(binDir(home), binaryName(platform));
}

export function readReceipt(bin: string): Receipt | undefined {
  try {
    return JSON.parse(readFileSync(receiptPath(bin), 'utf8')) as Receipt;
  } catch {
    return undefined;
  }
}

/** The managed copy as its receipt describes it, without running it. */
export function installedBinary(home: string, platform: string = process.platform): BinaryInfo | undefined {
  const path = managedPath(home, platform);
  if (!existsSync(path)) return undefined;
  const r = readReceipt(path);
  return { path, version: r?.version, managed: true, verified: !!(r?.checks.checksums && r.checks.pin), sha256: r?.sha256, receipt: r };
}

/** Runs `<path> -h` and reads the version line. Undefined when it does not start. */
export type VersionProbe = (path: string) => Promise<string | undefined>;

export interface InstallOptions extends PluginHost {
  /** The hub home: the program goes in <home>/bin. */
  home: string;
  pin: Pin;
  /** Release download base (tests serve a fake release). Default GitHub. */
  base?: string;
  fetch?: typeof fetch;
  platform?: string;
  arch?: string;
  probe: VersionProbe;
  onProgress?: (done: number, total: number | undefined) => void;
}

async function fetchText(url: string, f: typeof fetch, max: number): Promise<string> {
  const res = await f(url, { headers: { 'user-agent': 'conclave-hub' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > max) throw new Error('too large');
  return text;
}

/** Stream `url` into `dest`, checking size on the way. Returns the SHA-256. */
async function download(url: string, dest: string, size: number | undefined, f: typeof fetch, onProgress?: InstallOptions['onProgress']): Promise<string> {
  let res: Response;
  try {
    res = await f(url, { headers: { 'user-agent': 'conclave-hub' }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  } catch (err) {
    throw new ReleaseError(`Could not download CLIProxyAPI (${(err as Error).message}). Check that the hub can reach github.com, or set models.cliproxy.binary to a copy you installed.`);
  }
  if (!res.ok || !res.body) throw new ReleaseError(`GitHub answered ${res.status} for the CLIProxyAPI download. Try again in a minute.`);
  const length = Number(res.headers.get('content-length') ?? '') || undefined;
  if (size && length && length !== size) throw new ReleaseError(`The CLIProxyAPI download is ${length} bytes, the pinned release is ${size}. Nothing was installed.`);
  const total = size ?? length;
  if (total && (total < MIN_BYTES || total > MAX_BYTES)) throw new ReleaseError(`The CLIProxyAPI download is ${total} bytes, which is not a CLIProxyAPI build. Nothing was installed.`);
  const hash = createHash('sha256');
  const fd = openSync(dest, 'w', 0o600);
  let done = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (!value?.byteLength) continue;
      done += value.byteLength;
      if (done > MAX_BYTES || (size && done > size)) throw new ReleaseError('The CLIProxyAPI download is larger than the pinned release. Nothing was installed.');
      hash.update(value);
      writeSync(fd, value);
      onProgress?.(done, total);
    }
  } catch (err) {
    closeSync(fd);
    rmSync(dest, { force: true });
    if (err instanceof ReleaseError) throw err;
    throw new ReleaseError(`The CLIProxyAPI download stopped (${(err as Error).message}). Try again.`);
  }
  closeSync(fd);
  const fail = (msg: string): never => {
    rmSync(dest, { force: true });
    throw new ReleaseError(msg);
  };
  if (done < MIN_BYTES) fail(`The CLIProxyAPI download was only ${done} bytes. Nothing was installed. Try again.`);
  if (size && done !== size) fail(`The CLIProxyAPI download has ${done} bytes, the pinned release has ${size}. Nothing was installed. Try again.`);
  if (length && done !== length) fail(`The CLIProxyAPI download was cut off at ${done} of ${length} bytes. Try again.`);
  return hash.digest('hex');
}

/** Unpack only the program from the archive into dir. bsdtar (macOS, Windows) reads zip too. */
async function extract(archive: string, asset: CliAsset, dir: string): Promise<string> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const args = asset.kind === 'zip' ? ['tar', '-xf', archive, '-C', dir, asset.binary] : ['tar', '-xzf', archive, '-C', dir, asset.binary];
  const proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new ReleaseError(`Could not unpack the CLIProxyAPI download: ${err.trim().split('\n')[0] || 'tar failed'}.`);
  const out = join(dir, asset.binary);
  if (!existsSync(out)) throw new ReleaseError('The CLIProxyAPI download did not contain the cli-proxy-api program.');
  return out;
}

/** The install running for each home: its temp files have fixed names, so a second caller waits for the first. */
const installing = new Map<string, Promise<BinaryInfo>>();
const ensuring = new Map<string, Promise<BinaryInfo>>();

/** Owner and members share the managed executable, never their configs or keys.
 * Lock the read/probe/migration decision too, so a late probe cannot initiate
 * another migration after the first caller replaced the static receipt.
 */
export function ensureManagedBinary(opts: InstallOptions): Promise<BinaryInfo> {
  const key = resolve(opts.home);
  const running = ensuring.get(key);
  if (running) return running;
  const run = (async () => {
    const have = installedBinary(opts.home, opts.platform);
    const migrate = have?.receipt?.asset.includes('_no-plugin') && !pluginHostProblem(opts);
    if (have && !migrate) {
      const version = await opts.probe(have.path).catch(() => undefined);
      if (version) return { ...have, version };
    }
    if (!migrate || !have) return installRelease(opts);
    // An offline hub must keep running the working static copy, not go down.
    try {
      return await installRelease(opts);
    } catch (err) {
      const version = await opts.probe(have.path).catch(() => undefined);
      if (!version) throw err;
      logger('cliproxy').warn(`plugin-capable CLIProxyAPI not installed (${(err as Error).message}); keeping the static build`);
      return { ...have, version };
    }
  })().finally(() => ensuring.delete(key));
  ensuring.set(key, run);
  return run;
}

/**
 * Download, check and install the pinned release. The copy it replaces is
 * kept as cli-proxy-api.prev (see rollback and dropPrevious). A call while
 * another runs for the same home gets that one's result (its pin and progress).
 */
export function installRelease(opts: InstallOptions): Promise<BinaryInfo> {
  const key = resolve(opts.home);
  const running = installing.get(key);
  if (running) return running;
  const run = install(opts).finally(() => installing.delete(key));
  installing.set(key, run);
  return run;
}

async function install(opts: InstallOptions): Promise<BinaryInfo> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const f = opts.fetch ?? fetch;
  const base = (opts.base ?? RELEASE_BASE).replace(/\/+$/, '');
  const { pin } = opts;
  const asset = assetFor(pin.version, platform, arch, opts.glibcVersion);
  if (!asset) throw new ReleaseError(`CLIProxyAPI publishes no build for ${platform} ${arch}. Run one yourself and pick "I already run CLIProxyAPI".`);
  const pinned = pin.assets[asset.name];
  const bin = binDir(opts.home);
  mkdirSync(bin, { recursive: true });

  // 1. the release's own checksums
  let sums: Map<string, string>;
  try {
    sums = parseChecksums(await fetchText(`${base}/${pin.tag}/checksums.txt`, f, 64 * 1024));
  } catch (err) {
    throw new ReleaseError(`Could not read the checksums file of CLIProxyAPI ${pin.version} (${(err as Error).message}). Nothing was installed. Check that the hub can reach github.com and try again.`);
  }
  const listed = sums.get(asset.name);
  if (!listed) throw new ReleaseError(`The checksums file of CLIProxyAPI ${pin.version} does not list ${asset.name}. Nothing was installed.`);
  if (pinned && listed !== pinned.sha256) throw new ReleaseError(`The checksums file of CLIProxyAPI ${pin.version} does not match the checksum this hub pins for it. Nothing was installed. The release may have been replaced; update Conclave or install CLIProxyAPI yourself.`);

  // 2. the archive
  const partial = join(bin, `.${asset.name}.download`);
  const unpack = join(bin, '.cli-proxy-api-unpack');
  try {
    const sha = await download(`${base}/${pin.tag}/${asset.name}`, partial, pinned?.size, f, opts.onProgress);
    if (sha !== listed) throw new ReleaseError('The CLIProxyAPI download does not match the checksum its release publishes. Nothing was installed.');
    const size = statSync(partial).size;

    // 3. the program inside
    const file = await extract(partial, asset, unpack);
    if (!looksExecutable(readHead(file), platform)) throw new ReleaseError('The CLIProxyAPI download is not a program for this computer. Nothing was installed.');
    if (statSync(file).size < MIN_BYTES) throw new ReleaseError('The cli-proxy-api program in the download is too small. Nothing was installed.');
    if (platform !== 'win32') chmodSync(file, 0o755);
    const final = managedPath(opts.home, platform);
    const staged = `${final}.new`;
    rmSync(staged, { force: true });
    renameSync(file, staged);

    // 4. it starts and is the version we asked for
    const v = await opts.probe(staged).catch(() => undefined);
    if (!v) {
      rmSync(staged, { force: true });
      throw new ReleaseError(`The downloaded CLIProxyAPI ${pin.version} does not start on this computer. Nothing was changed.`);
    }
    if (compareVersions(v, pin.version) !== 0) {
      rmSync(staged, { force: true });
      throw new ReleaseError(`The downloaded program says it is CLIProxyAPI ${v}, not ${pin.version}. Nothing was installed.`);
    }

    // keep the copy it replaces until the new one has started
    const prev = `${final}.prev`;
    if (existsSync(final)) {
      rmSync(prev, { force: true });
      renameSync(final, prev);
      if (existsSync(receiptPath(final))) renameSync(receiptPath(final), receiptPath(prev));
    }
    renameSync(staged, final);
    const receipt: Receipt = { version: pin.version, tag: pin.tag, asset: asset.name, sha256: sha, size, checks: { checksums: true, pin: !!pinned }, at: Date.now() };
    try {
      writeFileSync(receiptPath(final), JSON.stringify(receipt, null, 2) + '\n');
    } catch {
      /* the receipt only feeds Settings; the program is in place */
    }
    return { path: final, version: v, managed: true, verified: receipt.checks.checksums && receipt.checks.pin, sha256: sha, receipt };
  } finally {
    rmSync(partial, { force: true });
    rmSync(unpack, { recursive: true, force: true });
  }
}

/** Put the copy an update replaced back. False when there is none. */
export function rollback(home: string, platform: string = process.platform): boolean {
  const final = managedPath(home, platform);
  const prev = `${final}.prev`;
  if (!existsSync(prev)) return false;
  rmSync(final, { force: true });
  renameSync(prev, final);
  rmSync(receiptPath(final), { force: true });
  if (existsSync(receiptPath(prev))) renameSync(receiptPath(prev), receiptPath(final));
  return true;
}

/** The new copy started: forget the old one. */
export function dropPrevious(home: string, platform: string = process.platform): void {
  const prev = `${managedPath(home, platform)}.prev`;
  rmSync(prev, { force: true });
  rmSync(receiptPath(prev), { force: true });
}
