/** Small helpers shared by the bench runner. No dependencies beyond Bun and Node built-ins. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const BENCH_DIR = resolve(import.meta.dir, '..');
export const REPO_DIR = dirname(BENCH_DIR);

export function log(msg: string): void {
  process.stderr.write(`[bench] ${msg}\n`);
}

export function readJson<T = any>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Append one JSON line and fsync, so a crash never loses a finished run. */
export function appendJsonl(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  // a cut-off last line (runner killed mid-write) must not swallow this one
  let lead = '';
  if (existsSync(file)) {
    const size = statSync(file).size;
    if (size > 0) {
      const rfd = openSync(file, 'r');
      const b = Buffer.alloc(1);
      readSync(rfd, b, 0, 1, size - 1);
      closeSync(rfd);
      if (b[0] !== 0x0a) lead = '\n';
    }
  }
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, lead + JSON.stringify(data) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Every whole JSON line of a .jsonl file. A runner killed in the middle of a
 * write can leave half a line at the end; that line is skipped with a warning
 * instead of breaking --resume and the report.
 */
export function readJsonl<T = any>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((l, i) => {
      if (!l.trim()) return;
      try {
        out.push(JSON.parse(l) as T);
      } catch {
        log(`skipping a broken line ${i + 1} in ${file} (a write was cut off)`);
      }
    });
  return out;
}

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomId(len = 6): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  let out = 'r';
  for (let i = 0; i < len - 1; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(text: string): number {
  return parseInt(sha256(text).slice(0, 8), 16);
}

export function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** True when a relative path sits in an excluded folder ("node_modules/") or matches an excluded glob. */
export function isExcluded(rel: string, excludes: string[]): boolean {
  const parts = rel.split('/');
  for (const ex of excludes) {
    if (ex.endsWith('/')) {
      const name = ex.slice(0, -1);
      if (parts.includes(name)) return true;
    } else if (globToRegExp(ex).test(rel) || globToRegExp(ex).test(parts[parts.length - 1])) return true;
  }
  return false;
}

/** All files under dir as relative paths with forward slashes, skipping excluded ones. */
export function listFiles(dir: string, excludes: string[] = []): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      const rel = relative(dir, abs).split(sep).join('/');
      if (isExcluded(ent.isDirectory() ? rel + '/x' : rel, excludes)) continue;
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() || ent.isSymbolicLink()) out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

export function copyTree(src: string, dst: string, excludes: string[] = []): void {
  mkdirSync(dst, { recursive: true });
  for (const rel of listFiles(src, excludes)) {
    const to = join(dst, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(src, rel), to, { preserveTimestamps: true, verbatimSymlinks: true });
  }
}

export function fileEquals(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false;
  const sa = statSync(a);
  const sb = statSync(b);
  if (sa.size !== sb.size) return false;
  return readFileSync(a).equals(readFileSync(b));
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

/** Run a command, capture output, kill the process group on timeout. */
export function exec(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const max = opts.maxBuffer ?? 20 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // decode across chunks: a character split between two reads stays whole
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr!.on('data', (d: string) => {
      if (stderr.length < max) stderr += d;
    });
    if (opts.input !== undefined) {
      child.stdin!.end(opts.input);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, 'SIGTERM');
        setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref();
      }, opts.timeoutMs);
    }
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, signal: null, stdout, stderr: stderr + String(e), ms: Date.now() - started, timedOut });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started, timedOut });
    });
  });
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
}

export async function which(name: string): Promise<string | null> {
  const r = await exec(['sh', '-c', `command -v ${name}`]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseDuration(text: string): number {
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  let total = 0;
  let matched = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g)) {
    matched = true;
    total += Number(m[1]) * ({ ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 } as Record<string, number>)[m[2]];
  }
  if (!matched) throw new Error(`bad duration: ${text}`);
  return total;
}

/** Parse "150M", "2.5k", "8000000" into a number. */
export function parseCount(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmMgG]?)$/.exec(text.trim());
  if (!m) throw new Error(`bad number: ${text}`);
  const mult = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, g: 1e9, G: 1e9 }[m[2]]!;
  return Math.round(Number(m[1]) * mult);
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function quantile(xs: number[], q: number): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export function sum(xs: Array<number | null | undefined>): number {
  let s = 0;
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) s += x;
  return s;
}

export function ensureDir(d: string): string {
  mkdirSync(d, { recursive: true });
  return d;
}

export function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
