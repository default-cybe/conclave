/**
 * Shared plumbing for usage readers: the record shape they return and an
 * incremental scanner that only reads files changed since the last scan,
 * resuming at the byte offset where it stopped. Scan state lives in repos.kv
 * per reader and machine. Records carry an ext_key so a re-read is harmless.
 */
import type { UsageRecord } from '../../types';
import type { Machine } from '../../machine/types';
import type { KvRepo } from '../../storage/repos';
import { readJsonlChunk, type FoundFile, type JsonlLine } from '../../importers/files';

export type UsageInput = Omit<UsageRecord, 'id' | 'ts' | 'costUsd' | 'apiValueEstimated'> & {
  costUsd?: number;
  ts?: number;
  /** The part of cacheWriteTokens written for 1 hour: not kept, but it prices the API value. */
  cacheWrite1hTokens?: number;
};

/** A usage record from a log, with the key that makes re-reading idempotent. */
export interface ExtUsage {
  extKey: string;
  record: UsageInput;
}

export interface ReaderContext {
  machine: Machine;
  kv: KvRepo;
  /** Override the tool's home dir (~/.claude or ~/.codex). */
  root?: string;
  now?: number;
  /**
   * True for a line of a harness session that Conclave ran over ACP and
   * already counted at that time (usage/service.ts), so it is not counted twice.
   */
  counted?: (harnessSession: string, ts: number) => boolean;
}

/** Per-file scan state. `x` is reader specific (Codex keeps model and running totals there). */
export interface FileState {
  /** mtime ms */
  m: number;
  /** size */
  s: number;
  /** byte offset to resume from */
  o: number;
  x?: Record<string, unknown>;
}

export function scanKey(reader: string, machineId: string): string {
  return `usage.scan.${reader}.${machineId}`;
}

/**
 * Read new lines from changed files. `onLines` gets the lines after the stored
 * offset plus the file's state object (mutable, saved afterwards). Returns the
 * number of files read.
 */
export async function scanIncremental(
  ctx: ReaderContext,
  reader: string,
  files: FoundFile[],
  onLines: (file: FoundFile, lines: JsonlLine[], state: FileState) => void,
  filter?: (raw: string) => boolean,
): Promise<number> {
  const key = scanKey(reader, ctx.machine.id);
  const prev = ctx.kv.get<Record<string, FileState>>(key, {});
  const next: Record<string, FileState> = {};
  let read = 0;
  for (const f of files) {
    const old = prev[f.path];
    if (old && old.m === f.mtimeMs && old.s === f.size) {
      next[f.path] = old;
      continue;
    }
    // a file that shrank was rewritten: start over
    const restart = !old || f.size < old.o;
    const state: FileState = restart ? { m: f.mtimeMs, s: f.size, o: 0 } : { ...old, m: f.mtimeMs, s: f.size };
    let bytes: Uint8Array;
    // a grown file: read only the new bytes when the machine can, not the whole transcript again
    const base = state.o > 0 && ctx.machine.readRange ? state.o : 0;
    try {
      bytes = base ? await ctx.machine.readRange!(f.path, base, f.size - base) : await ctx.machine.readFile(f.path);
    } catch {
      if (old) next[f.path] = old;
      continue;
    }
    const { lines, end } = readJsonlChunk(bytes, { startByte: state.o - base, filter });
    onLines(f, lines, state);
    state.o = base + end;
    // the file may have grown while we read it; remember what we actually saw
    state.s = Math.max(base + bytes.byteLength, state.o);
    if (base + bytes.byteLength !== f.size) state.m = -1;
    next[f.path] = state;
    read++;
  }
  ctx.kv.set(key, next);
  return read;
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
