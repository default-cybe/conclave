/**
 * The steps every native updater shares (the hub, and the TypeScript daemon
 * in the same files): download one artifact, check its size, SHA-256 and
 * signature, unpack it next to the install, ask the new program its version,
 * and swap the folders so the old one stays as <install>.prev.
 *
 * Nothing here restarts anything; the hub's finisher (finish.ts) and the
 * daemon do that their own way.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { blake2b512, verifyPrehashed, SignatureError, type MinisignKey } from './minisign';
import type { KeyState } from './key';
import { allowedUrl, compareVersions, type UpdateArtifact } from './manifest';

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateError';
  }
}

/** No release file is anywhere near this; a bigger answer is not ours. */
const MAX_BYTES = 512 * 1024 * 1024;

export interface FileHashes {
  sha256: string;
  blake2b: Uint8Array;
  size: number;
}

/**
 * Stream `a.url` into `dest` (this user only), hashing on the way. Checks
 * the size and SHA-256 the manifest names; the file is removed when either
 * is wrong. The signature is checked with verifyArtifact.
 */
export async function downloadArtifact(
  a: UpdateArtifact,
  dest: string,
  opts: { fetch?: typeof fetch; onProgress?: (done: number, total: number) => void; timeoutMs?: number } = {},
): Promise<FileHashes> {
  if (!allowedUrl(a.url)) throw new UpdateError('The update address is not https. Nothing was downloaded.');
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(a.url, { headers: { 'user-agent': 'conclave-updater' }, redirect: 'follow', signal: AbortSignal.timeout(opts.timeoutMs ?? 20 * 60_000) });
  } catch (err) {
    throw new UpdateError(`Could not download ${a.file} (${(err as Error).message}).`);
  }
  if (!res.ok || !res.body) throw new UpdateError(`The release server answered ${res.status} for ${a.file}.`);
  const length = Number(res.headers.get('content-length') ?? '') || undefined;
  if (length && length !== a.size) throw new UpdateError(`${a.file} is ${length} bytes, the release says ${a.size}. Nothing was installed.`);
  mkdirSync(dirname(dest), { recursive: true });
  const sha = createHash('sha256');
  const b2 = blake2b512();
  const fd = openSync(dest, 'w', 0o600);
  let done = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      if (!value?.byteLength) continue;
      done += value.byteLength;
      if (done > a.size || done > MAX_BYTES) throw new UpdateError(`${a.file} is larger than the release says. Nothing was installed.`);
      sha.update(value);
      b2.update(value);
      writeSync(fd, value);
      opts.onProgress?.(done, a.size);
    }
  } catch (err) {
    closeSync(fd);
    rmSync(dest, { force: true });
    if (err instanceof UpdateError) throw err;
    throw new UpdateError(`The download of ${a.file} stopped (${(err as Error).message}). Try again.`);
  }
  closeSync(fd);
  const sha256 = sha.digest('hex');
  const fail = (msg: string): never => {
    rmSync(dest, { force: true });
    throw new UpdateError(msg);
  };
  if (done !== a.size) fail(`${a.file} was cut off at ${done} of ${a.size} bytes. Try again.`);
  if (sha256 !== a.sha256) fail(`${a.file} does not match the SHA-256 of the release. Nothing was installed.`);
  return { sha256, blake2b: new Uint8Array(b2.digest()), size: done };
}

/** SHA-256 and BLAKE2b-512 of a file on disk. */
export async function hashFile(path: string): Promise<FileHashes> {
  const sha = createHash('sha256');
  const b2 = blake2b512();
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path);
    s.on('data', (chunk: Buffer | string) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += b.byteLength;
      sha.update(b);
      b2.update(b);
    });
    s.on('end', () => resolve());
    s.on('error', reject);
  });
  return { sha256: sha.digest('hex'), blake2b: new Uint8Array(b2.digest()), size };
}

/**
 * The file's signature, with the key this program trusts. Throws an
 * UpdateError when the release is unsigned, the key is the placeholder or the
 * signature is wrong. Returns the signature's trusted comment.
 */
export function verifyArtifact(hashes: FileHashes, a: UpdateArtifact, key: KeyState | MinisignKey): string {
  const k = 'ok' in key ? key : ({ ok: true, key } as const);
  if (!k.ok) throw new UpdateError(k.why);
  if (!a.signature) throw new UpdateError('This release is unsigned, so it is not installed. Update by hand, or wait for a signed release.');
  if (hashes.sha256 !== a.sha256) throw new UpdateError(`${a.file} does not match the SHA-256 of the release. Nothing was installed.`);
  try {
    return verifyPrehashed(hashes.blake2b, a.signature, k.key);
  } catch (err) {
    if (err instanceof SignatureError) throw new UpdateError(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Unpack, ask the version, swap
// ---------------------------------------------------------------------------

/** Run a command; its exit code and output. */
export function run(argv: string[], opts: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env as NodeJS.ProcessEnv | undefined, windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8').slice(0, 64 * 1024)));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8').slice(0, 64 * 1024)));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** `<bin> --version`, the first version-looking word it prints. */
export async function probeVersion(bin: string, timeoutMs = 20_000): Promise<string | undefined> {
  const r = await run([bin, '--version'], { timeoutMs });
  if (r.code !== 0) return undefined;
  return /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(r.stdout.trim().split('\n')[0] ?? '')?.[1];
}

/** A new private folder next to `install`, so the swap is a rename on the same disk. */
export function makeStage(install: string): string {
  mkdirSync(dirname(install), { recursive: true });
  return mkdtempSync(join(dirname(install), `.${basename(install)}-update-`));
}

/**
 * Unpack a hub archive (conclave-<target>.tar.gz) into `stage` (from
 * makeStage). Returns the folder that holds `conclave` and `web/`. The caller
 * removes `stage` when done.
 */
export async function unpackHub(archive: string, target: string, stage: string): Promise<{ dir: string }> {
  const zip = archive.endsWith('.zip');
  const out = join(stage, 'unpacked');
  mkdirSync(out, { recursive: true });
  // never the archive's owners (a root finisher would keep CI's uid otherwise)
  const r = await run(zip ? ['tar', '-xf', archive, '-C', out] : ['tar', '--no-same-owner', '-xzf', archive, '-C', out], { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new UpdateError(`Could not unpack the update: ${(r.stderr || 'tar failed').trim().split('\n')[0]}.`);
  const dir = join(out, `conclave-${target}`);
  const exe = join(dir, target.startsWith('windows-') ? 'conclave.exe' : 'conclave');
  if (!existsSync(exe) || !statSync(exe).isFile()) throw new UpdateError(`The update has no conclave-${target}/conclave in it. Nothing was installed.`);
  if (!target.startsWith('windows-')) chmodSync(exe, 0o755);
  return { dir };
}

/** Check the unpacked program says the version the release says, and that it is newer than this one. */
export async function checkUnpacked(exe: string, want: string, current: string, probe: (bin: string) => Promise<string | undefined> = probeVersion): Promise<void> {
  const v = await probe(exe);
  if (!v) throw new UpdateError(`The downloaded Conclave ${want} does not start on this computer. Nothing was changed.`);
  if (compareVersions(v, want) !== 0) throw new UpdateError(`The downloaded program says it is ${v}, not ${want}. Nothing was installed.`);
  if (compareVersions(v, current) <= 0) throw new UpdateError(`The download is ${v}, not newer than ${current}. Nothing was installed.`);
}

export const prevPath = (install: string) => `${install}.prev`;
export const failedPath = (install: string) => `${install}.failed`;

/**
 * Put `staged` in place of `install`. The old folder becomes <install>.prev
 * (an older .prev goes). Two renames on one disk: a running program keeps its
 * open files, and the folder is never half written.
 */
export function swapIn(install: string, staged: string): void {
  const prev = prevPath(install);
  rmSync(prev, { recursive: true, force: true });
  const had = existsSync(install);
  if (had) renameSync(install, prev);
  try {
    renameSync(staged, install);
  } catch (err) {
    if (had) renameSync(prev, install);
    throw new UpdateError(`Could not put the update in place (${(err as Error).message}). The old version stays.`);
  }
}

/** Put <install>.prev back. The version that failed stays as <install>.failed. False when there is no .prev. */
export function rollBack(install: string): boolean {
  const prev = prevPath(install);
  if (!existsSync(prev)) return false;
  const failed = failedPath(install);
  rmSync(failed, { recursive: true, force: true });
  if (existsSync(install)) renameSync(install, failed);
  renameSync(prev, install);
  return true;
}

/** A path is a plain file inside `dir` (no link), for a request a less trusted user wrote. */
export function plainFileIn(path: string, dir: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink() && dirname(path) === dir;
  } catch {
    return false;
  }
}

/** Names in a folder, or none. */
export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
