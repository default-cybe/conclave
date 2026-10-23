import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Real plugin repos are cloned once into a cache folder and reused across runs.
 * Set CONCLAVE_COMPAT_CACHE to move it, or CONCLAVE_OFFLINE=1 to skip the
 * network tests. When a clone fails (offline, proxy), the tests that need it skip.
 */
export const CACHE = process.env.CONCLAVE_COMPAT_CACHE || join(tmpdir(), 'conclave-compat-cache');

async function git(args: string[], cwd?: string): Promise<boolean> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const timer = setTimeout(() => proc.kill(), 180_000);
  const code = await proc.exited;
  clearTimeout(timer);
  return code === 0;
}

/**
 * Clone github.com/<repo> (depth 1) into the cache, or reuse it. With
 * `sparse`, only those paths are checked out (blobs fetched on demand).
 * Returns the folder, or undefined when unavailable.
 */
export async function cachedRepo(repo: string, sparse?: string[]): Promise<string | undefined> {
  const dir = join(CACHE, repo.replace('/', '__'));
  if (existsSync(join(dir, '.git')) && existsSync(join(dir, '.conclave-ok'))) return dir;
  if (process.env.CONCLAVE_OFFLINE === '1') return undefined;
  mkdirSync(CACHE, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  const url = `https://github.com/${repo}.git`;
  let ok: boolean;
  if (sparse?.length) {
    ok = (await git(['clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', url, dir])) &&
      (await git(['sparse-checkout', 'set', '--no-cone', ...sparse], dir)) &&
      (await git(['checkout', '-q'], dir));
  } else {
    ok = await git(['clone', '-q', '--depth', '1', url, dir]);
  }
  if (!ok) {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  await Bun.write(join(dir, '.conclave-ok'), new Date().toISOString());
  return dir;
}
