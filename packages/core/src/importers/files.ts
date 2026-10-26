/**
 * Small helpers shared by the session importers and the usage log readers:
 * locating Claude Code / Codex homes on a Machine, walking directories, and
 * tolerant JSONL parsing.
 */
import { zstdDecompressSync } from 'node:zlib';
import type { Machine } from '../machine/types';

/**
 * Limits on what a reader loads into memory: one session file, on disk or
 * decompressed, and the piece an incremental log scan reads at a time
 * (usage/readers/common.ts). Tests lower them.
 */
export const IMPORT_LIMITS = { maxSessionBytes: 512 * 1024 * 1024, scanChunkBytes: 8 * 1024 * 1024 };

export interface FoundFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** ~/.claude on the machine. CLAUDE_CONFIG_DIR is honored for the hub's own disk. */
export function claudeRootOn(machine: Machine): string {
  if (machine.id === 'local' && process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return machine.resolve('~/.claude', '/');
}

/** ~/.codex on the machine. CODEX_HOME is honored for the hub's own disk. */
export function codexRootOn(machine: Machine): string {
  if (machine.id === 'local' && process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return machine.resolve('~/.codex', '/');
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Walk a directory tree on a machine and return files whose name matches.
 * Missing directories yield nothing. Depth 0 means only `root` itself.
 */
export async function walkFiles(
  machine: Machine,
  root: string,
  opts: { match: (name: string, path: string) => boolean; maxDepth: number; skipDir?: (name: string, depth: number) => boolean },
): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await machine.readdir(dir);
    } catch {
      return;
    }
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of entries) {
      const p = joinPath(dir, e.name);
      if (e.type === 'dir') {
        if (depth < opts.maxDepth && !opts.skipDir?.(e.name, depth)) dirs.push(p);
      } else if ((e.type === 'file' || e.type === 'symlink') && opts.match(e.name, p)) files.push(p);
    }
    const stats = await Promise.all(files.map(async (p) => [p, await machine.stat(p).catch(() => null)] as const));
    for (const [p, s] of stats) if (s && s.type !== 'dir') out.push({ path: p, mtimeMs: s.mtimeMs, size: s.size });
    for (const d of dirs) await visit(d, depth + 1);
  };
  await visit(root, 0);
  return out;
}

/** One parsed JSONL line with its byte offset just after the line. */
export interface JsonlLine {
  value: Record<string, any>;
  /** Byte offset of the start of the next line. */
  end: number;
}

/**
 * Parse JSONL text, skipping blank and malformed lines. A trailing line with
 * no newline is treated as incomplete (still being written) and left out, so
 * `end` of the last returned line is a safe resume offset.
 */
export function parseJsonl(input: string | Uint8Array, opts: { startByte?: number; includePartialTail?: boolean } = {}): JsonlLine[] {
  return readJsonlChunk(input, opts).lines;
}

/**
 * Like parseJsonl, but also returns `end`: the offset just past the last
 * complete line looked at, including lines skipped by `filter`. Resume from
 * there next time. `filter` sees the raw line and lets callers skip JSON.parse
 * for lines they do not care about.
 */
export function readJsonlChunk(
  input: string | Uint8Array,
  opts: { startByte?: number; includePartialTail?: boolean; filter?: (raw: string) => boolean } = {},
): { lines: JsonlLine[]; end: number } {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const start = Math.min(opts.startByte ?? 0, bytes.length);
  const lines: JsonlLine[] = [];
  let pos = start;
  while (pos < bytes.length) {
    let nl = bytes.indexOf(10, pos);
    const partial = nl === -1;
    if (partial && !opts.includePartialTail) break;
    if (partial) nl = bytes.length;
    const end = partial ? bytes.length : nl + 1;
    const line = bytes.toString('utf8', pos, nl).trim();
    if (line && (!opts.filter || opts.filter(line))) {
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object' && !Array.isArray(v)) lines.push({ value: v, end });
      } catch {
        // tolerate garbage lines
      }
    }
    pos = end;
  }
  return { lines, end: pos };
}

export function parseTime(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}

export function truncateTitle(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

/** ~/.gemini on the machine. GEMINI_DIR is honored for the hub's own disk. */
export function geminiRootOn(machine: Machine): string {
  if (machine.id === 'local' && process.env.GEMINI_DIR) return process.env.GEMINI_DIR;
  return machine.resolve('~/.gemini', '/');
}

/** A session file the readers will not load: over IMPORT_LIMITS.maxSessionBytes on disk or once decompressed. */
export class TooLargeError extends Error {
  readonly code = 'E2BIG';
  constructor(path: string, bytes: number | undefined, max: number) {
    super(`${baseName(path)} is too large to import (${bytes === undefined ? 'over' : Math.round(bytes / 1048576)} MB${bytes === undefined ? ` ${Math.round(max / 1048576)} MB` : ''} once read; the limit is ${Math.round(max / 1048576)} MB)`);
  }
}

/**
 * Bytes of a session file. A .zst file (Codex can compress rollouts) is
 * decompressed, several frames included. Files over `max` (on disk, or once
 * decompressed) are refused before they are read into memory, so one huge
 * or hostile transcript cannot take the hub or the daemon down.
 */
export async function readSessionBytes(machine: Machine, path: string, max = IMPORT_LIMITS.maxSessionBytes): Promise<Uint8Array> {
  const st = await machine.stat(path).catch(() => null);
  if (st && st.size > max) throw new TooLargeError(path, st.size, max);
  const bytes = await machine.readFile(path);
  if (bytes.length > max) throw new TooLargeError(path, bytes.length, max);
  if (!path.endsWith('.zst')) return bytes;
  try {
    return new Uint8Array(zstdDecompressSync(bytes, { maxOutputLength: max }));
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new TooLargeError(path, undefined, max);
    throw err;
  }
}

/** Text of a session file, with the same size limit as readSessionBytes. */
export async function readSessionText(machine: Machine, path: string, max = IMPORT_LIMITS.maxSessionBytes): Promise<string> {
  const st = await machine.stat(path).catch(() => null);
  if (st && st.size > max) throw new TooLargeError(path, st.size, max);
  return machine.readText(path);
}

export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}
