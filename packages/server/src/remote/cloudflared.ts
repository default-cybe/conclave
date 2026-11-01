/**
 * The cloudflared binary. The hub uses, in order: remote.cloudflared from the
 * config, the copy it downloaded before into <home>/bin, a cloudflared on the
 * PATH, or it downloads the latest release from GitHub into <home>/bin.
 *
 * A download is checked before it is used: the byte count must match the
 * release asset's size (and the Content-Length), the SHA-256 must match the
 * asset digest GitHub publishes, the file must start like an executable for
 * this OS, and `cloudflared --version` must run. It is written next to its
 * final path and renamed into place, so nothing ever runs from a temp dir.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const RELEASES_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const DOWNLOAD_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
/** Every cloudflared build is far bigger than this; anything smaller is an error page. */
const MIN_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 200 * 1024 * 1024;

export interface BinaryInfo {
  path: string;
  version?: string;
  /** True for the copy the hub downloaded into its home (it may replace it). */
  managed: boolean;
  /** For a downloaded copy: its SHA-256 matched the digest GitHub publishes. False when GitHub's API did not answer and only size and format were checked. */
  verified?: boolean;
}

/** What the hub knows about the copy it downloaded, kept next to it as cloudflared.json. */
interface Receipt {
  sha256: string;
  verified: boolean;
  tag?: string;
  at: number;
}

export function receiptPath(managed: string): string {
  return managed.replace(/(\.exe)?$/i, '.json');
}

function readReceipt(managed: string): Receipt | undefined {
  try {
    return JSON.parse(readFileSync(receiptPath(managed), 'utf8')) as Receipt;
  } catch {
    return undefined;
  }
}

export interface Asset {
  name: string;
  /** darwin builds ship as a .tgz with the binary inside. */
  archive: boolean;
}

/** The release asset for this OS and CPU, or undefined when cloudflared has none. */
export function assetFor(platform: string = process.platform, arch: string = process.arch): Asset | undefined {
  if (platform === 'linux') {
    const a = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch];
    return a ? { name: `cloudflared-linux-${a}`, archive: false } : undefined;
  }
  if (platform === 'darwin') {
    const a = { x64: 'amd64', arm64: 'arm64' }[arch];
    return a ? { name: `cloudflared-darwin-${a}.tgz`, archive: true } : undefined;
  }
  if (platform === 'win32') {
    // Windows on ARM runs the amd64 build
    const a = { x64: 'amd64', arm64: 'amd64', ia32: '386' }[arch];
    return a ? { name: `cloudflared-windows-${a}.exe`, archive: false } : undefined;
  }
  return undefined;
}

export function binaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/** True when the first bytes look like an executable for this OS (ELF, Mach-O, PE). */
export function looksExecutable(head: Uint8Array, platform: string = process.platform): boolean {
  const b = [...head.slice(0, 4)];
  const is = (...x: number[]) => x.every((v, i) => b[i] === v);
  if (platform === 'linux') return is(0x7f, 0x45, 0x4c, 0x46);
  if (platform === 'darwin') return is(0xcf, 0xfa, 0xed, 0xfe) || is(0xce, 0xfa, 0xed, 0xfe) || is(0xca, 0xfe, 0xba, 0xbe) || is(0xfe, 0xed, 0xfa, 0xcf);
  if (platform === 'win32') return is(0x4d, 0x5a);
  return false;
}

/** "cloudflared version 2025.8.1 (built ...)" -> "2025.8.1". */
export function parseVersion(text: string): string | undefined {
  return /cloudflared version (\S+)/i.exec(text)?.[1];
}

export class CloudflaredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflaredError';
  }
}

export interface EnsureOptions {
  /** The hub home; the binary goes in <home>/bin. */
  home: string;
  /** remote.cloudflared from the config. */
  override?: string;
  fetch?: typeof fetch;
  platform?: string;
  arch?: string;
  /** PATH lookup. Default Bun.which. Return null to skip. */
  which?: (cmd: string) => string | null;
  /** Runs `<path> --version`. Default spawns it. */
  version?: (path: string) => Promise<string | undefined>;
  /** Download progress in bytes. */
  onProgress?: (done: number, total: number | undefined) => void;
  /** Download even when a managed copy exists. */
  force?: boolean;
}

async function runVersion(path: string): Promise<string | undefined> {
  const proc = Bun.spawn([path, '--version'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (code !== 0) return undefined;
    return parseVersion(out) ?? parseVersion(err) ?? 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

interface ReleaseAsset {
  url: string;
  size?: number;
  sha256?: string;
  tag?: string;
}

/** Look the asset up in the latest release: its URL, size and SHA-256. Undefined when GitHub does not answer. */
export async function releaseAsset(name: string, f: typeof fetch = fetch): Promise<ReleaseAsset | undefined> {
  try {
    const res = await f(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'conclave-hub' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { tag_name?: string; assets?: Array<{ name: string; size?: number; digest?: string; browser_download_url?: string }> };
    const a = data.assets?.find((x) => x.name === name);
    if (!a?.browser_download_url) return undefined;
    const sha = /^sha256:([0-9a-f]{64})$/i.exec(a.digest ?? '')?.[1]?.toLowerCase();
    return { url: a.browser_download_url, size: a.size, sha256: sha, tag: data.tag_name };
  } catch {
    return undefined;
  }
}

/**
 * Download `url` into `dest` (a file next to the final path), checking size
 * and digest on the way. Throws CloudflaredError with what to do next.
 */
export async function download(url: string, dest: string, expect: { size?: number; sha256?: string }, f: typeof fetch = fetch, onProgress?: EnsureOptions['onProgress']): Promise<string> {
  let res: Response;
  try {
    res = await f(url, { headers: { 'user-agent': 'conclave-hub' }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  } catch (err) {
    throw new CloudflaredError(`Could not download cloudflared (${(err as Error).message}). Check that the hub can reach github.com, or install cloudflared yourself and set server.remote.cloudflared to its path.`);
  }
  if (!res.ok || !res.body) throw new CloudflaredError(`GitHub answered ${res.status} for the cloudflared download. Try again in a minute, or install cloudflared yourself and set server.remote.cloudflared to its path.`);
  const length = Number(res.headers.get('content-length') ?? '') || undefined;
  const total = expect.size ?? length;
  if (total && (total < MIN_BYTES || total > MAX_BYTES)) throw new CloudflaredError(`The cloudflared download is ${total} bytes, which is not a cloudflared build. Nothing was installed.`);
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
      if (done > MAX_BYTES) throw new CloudflaredError('The cloudflared download is larger than any cloudflared build. Nothing was installed.');
      hash.update(value);
      writeSync(fd, value);
      onProgress?.(done, total);
    }
  } catch (err) {
    closeSync(fd);
    rmSync(dest, { force: true });
    if (err instanceof CloudflaredError) throw err;
    throw new CloudflaredError(`The cloudflared download stopped (${(err as Error).message}). Try again.`);
  }
  closeSync(fd);
  const fail = (msg: string): never => {
    rmSync(dest, { force: true });
    throw new CloudflaredError(msg);
  };
  if (done < MIN_BYTES) fail(`The cloudflared download was only ${done} bytes. Nothing was installed. Try again.`);
  if (expect.size && done !== expect.size) fail(`The cloudflared download has ${done} bytes, the release says ${expect.size}. Nothing was installed. Try again.`);
  if (length && done !== length) fail(`The cloudflared download was cut off at ${done} of ${length} bytes. Try again.`);
  const sha = hash.digest('hex');
  if (expect.sha256 && sha !== expect.sha256) fail('The cloudflared download does not match the checksum GitHub publishes for it. Nothing was installed.');
  return sha;
}

export function readHead(path: string): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buf = new Uint8Array(4);
    readSync(fd, buf, 0, 4, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

async function extractTgz(archive: string, dir: string, binary: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const proc = Bun.spawn(['tar', '-xzf', archive, '-C', dir], { stdout: 'ignore', stderr: 'pipe' });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new CloudflaredError(`Could not unpack the cloudflared download: ${err.trim() || 'tar failed'}.`);
  const out = join(dir, binary);
  if (!existsSync(out)) throw new CloudflaredError('The cloudflared download did not contain the cloudflared program.');
  return out;
}

let pending: Promise<BinaryInfo> | undefined;

/** Find or download cloudflared. Concurrent calls share one download. */
export function ensureCloudflared(opts: EnsureOptions): Promise<BinaryInfo> {
  if (!pending) pending = resolveBinary(opts).finally(() => (pending = undefined));
  return pending;
}

async function resolveBinary(opts: EnsureOptions): Promise<BinaryInfo> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const version = opts.version ?? runVersion;
  const f = opts.fetch ?? fetch;
  const bin = join(opts.home, 'bin');
  const managed = join(bin, binaryName(platform));

  if (opts.override) {
    if (!existsSync(opts.override)) throw new CloudflaredError(`server.remote.cloudflared points at ${opts.override}, which does not exist. Fix the path or remove the setting to let the hub download it.`);
    return { path: opts.override, version: await version(opts.override).catch(() => undefined), managed: false };
  }
  if (!opts.force && existsSync(managed)) {
    const v = await version(managed).catch(() => undefined);
    if (v) return { path: managed, version: v, managed: true, verified: readReceipt(managed)?.verified ?? false };
    // a broken copy: download a fresh one
  }
  if (!opts.force) {
    const which = opts.which ?? ((cmd: string) => Bun.which(cmd));
    const found = which('cloudflared');
    if (found) {
      const v = await version(found).catch(() => undefined);
      if (v) return { path: found, version: v, managed: false };
    }
  }

  const asset = assetFor(platform, arch);
  if (!asset) throw new CloudflaredError(`Cloudflare does not publish cloudflared for ${platform} ${arch}. Use Tailscale or your own URL instead.`);
  mkdirSync(bin, { recursive: true });
  const info = (await releaseAsset(asset.name, f)) ?? { url: `${DOWNLOAD_BASE}/${asset.name}` };
  const partial = join(bin, `.${asset.name}.download`);
  const sha = await download(info.url, partial, { size: info.size, sha256: info.sha256 }, f, opts.onProgress);
  // for a .tgz the digest covers the archive; the program inside came out of that archive
  const receipt: Receipt = { sha256: sha, verified: !!info.sha256, tag: 'tag' in info ? info.tag : undefined, at: Date.now() };

  let file = partial;
  const unpackDir = join(bin, '.cloudflared-unpack');
  try {
    if (asset.archive) file = await extractTgz(partial, unpackDir, binaryName(platform));
    if (!looksExecutable(readHead(file), platform)) throw new CloudflaredError('The cloudflared download is not a program for this computer. Nothing was installed.');
    if (statSync(file).size < MIN_BYTES) throw new CloudflaredError('The cloudflared program in the download is too small. Nothing was installed.');
    if (platform !== 'win32') chmodSync(file, 0o755);
    const staged = `${managed}.new`;
    renameSync(file, staged);
    const v = await version(staged).catch(() => undefined);
    if (!v) {
      rmSync(staged, { force: true });
      throw new CloudflaredError('The downloaded cloudflared does not start on this computer. Install it yourself and set server.remote.cloudflared to its path.');
    }
    renameSync(staged, managed);
    try {
      writeFileSync(receiptPath(managed), JSON.stringify(receipt, null, 2) + '\n');
    } catch {
      /* the receipt only feeds Settings; the program is in place */
    }
    return { path: managed, version: v, managed: true, verified: receipt.verified };
  } finally {
    rmSync(partial, { force: true });
    rmSync(unpackDir, { recursive: true, force: true });
  }
}
