/**
 * Shared plumbing for usage readers: the record shape they return and an
 * incremental scanner that only reads files changed since the last scan,
 * resuming at the byte offset where it stopped. Scan state lives in repos.kv
 * per reader and machine. Records carry an ext_key so a re-read is harmless.
 */
import type { UsageRecord } from '../../types';
import type { Machine } from '../../machine/types';
import type { KvRepo } from '../../storage/repos';
import { IMPORT_LIMITS, readJsonlChunk, type FoundFile, type JsonlLine } from '../../importers/files';
import { MAX_READ_BYTES } from '../../machine/protocol';
import { isOfflineError } from '../../projects/offline';
import { logger } from '../../util/log';

const log = logger('usage');

/** First wait after a file fails to read; it doubles per failure up to a day. */
const RETRY_MS = 20 * 60_000;
const RETRY_MAX_MS = 24 * 60 * 60_000;

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
  /** failures in a row, and the time before which the file is not tried again */
  e?: number;
  r?: number;
}

export function scanKey(reader: string, machineId: string): string {
  return `usage.scan.${reader}.${machineId}`;
}

/**
 * Read new lines from changed files. `onLines` gets the lines after the stored
 * offset plus the file's state object (mutable, saved afterwards), once per
 * piece of at most IMPORT_LIMITS.scanChunkBytes, so no single read moves a
 * whole transcript off a device. A line longer than a piece is skipped. A file
 * that fails keeps the progress made and waits longer before each new try.
 * When the device itself drops, the scan stops there without counting a failure.
 * Returns the number of files read.
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
  const now = ctx.now ?? Date.now();
  let read = 0;
  for (const [i, f] of files.entries()) {
    const old = prev[f.path];
    if (old && old.m === f.mtimeMs && old.s === f.size) {
      next[f.path] = old;
      continue;
    }
    if (old?.r && now < old.r) {
      next[f.path] = old;
      continue;
    }
    // a file that shrank was rewritten: start over
    const restart = !old || f.size < old.o;
    const state: FileState = restart ? { m: f.mtimeMs, s: f.size, o: 0 } : { ...old, m: f.mtimeMs, s: f.size };
    try {
      const seen = ctx.machine.readRange ? await scanPieces(ctx.machine, f, state, onLines, filter) : await scanWhole(ctx.machine, f, state, onLines, filter);
      // the file may have grown or shrunk while we read it; remember what we actually saw
      state.s = Math.max(seen, state.o);
      if (seen !== f.size) state.m = -1;
      delete state.e;
      delete state.r;
      read++;
    } catch (err) {
      state.m = -1;
      if (machineGone(ctx.machine, err)) {
        // not this file's fault: keep its progress and every other file's state, and stop
        next[f.path] = state;
        for (const g of files.slice(i + 1)) if (prev[g.path]) next[g.path] = prev[g.path];
        log.info(`${reader} scan on ${ctx.machine.name} stopped: ${(err as Error).message}`);
        break;
      }
      // keep what was read; try again later, waiting longer each time
      state.e = (old?.e ?? 0) + 1;
      const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (state.e - 1));
      state.r = now + wait;
      log.warn(`${reader} scan of ${f.path} on ${ctx.machine.name} failed (${(err as Error).message}); next try in ${Math.round(wait / 60_000)} min`);
    }
    next[f.path] = state;
  }
  ctx.kv.set(key, next);
  return read;
}

/** The device dropped (RemoteMachine after dispose, or an OfflineMachine), as opposed to an error of one file. */
function machineGone(machine: Machine, err: unknown): boolean {
  return isOfflineError(err) || (machine as { online?: boolean }).online === false || /: device not connected$/.test((err as Error)?.message ?? '');
}

type OnLines = (file: FoundFile, lines: JsonlLine[], state: FileState) => void;

/** Read from state.o to the end in pieces, advancing state.o past each complete line. Returns the bytes seen. */
async function scanPieces(machine: Machine, f: FoundFile, state: FileState, onLines: OnLines, filter?: (raw: string) => boolean): Promise<number> {
  const piece = IMPORT_LIMITS.scanChunkBytes;
  let skipped = 0;
  let seen = state.o;
  try {
    while (state.o < f.size) {
      const want = Math.min(piece, f.size - state.o);
      const bytes = await machine.readRange!(f.path, state.o, want);
      seen = state.o + bytes.byteLength;
      const { lines, end } = readJsonlChunk(bytes, { filter });
      if (lines.length) onLines(f, lines, state);
      if (end > 0) state.o += end;
      // a short read is the end of the file; a full piece without a newline is one line over the limit
      if (bytes.byteLength < want) break;
      if (end > 0) continue;
      const next = await nextLineStart(machine, f, state.o + bytes.byteLength, piece);
      if (next === undefined) {
        // looked through to the end: wait for the file to change
        seen = f.size;
        break;
      }
      skipped++;
      seen = state.o = next;
    }
  } finally {
    if (skipped) log.warn(`skipped ${skipped} line(s) over ${Math.round(piece / 1048576)} MB in ${f.path} on ${machine.name}`);
  }
  return seen;
}

/**
 * Offset just past the next newline at or after `from`, read a piece at a time,
 * or undefined when the file ends first (the long line is still being written;
 * shortcut: it is looked at again on the next change, fine unless such lines get common).
 */
async function nextLineStart(machine: Machine, f: FoundFile, from: number, piece: number): Promise<number | undefined> {
  for (let pos = from; pos < f.size; ) {
    const bytes = await machine.readRange!(f.path, pos, Math.min(piece, f.size - pos));
    const nl = bytes.indexOf(10);
    if (nl >= 0) return pos + nl + 1;
    if (!bytes.byteLength) return undefined;
    pos += bytes.byteLength;
  }
  return undefined;
}

/** A machine without readRange: the whole file in one read, only when that fits in one reply. Returns the bytes seen. */
async function scanWhole(machine: Machine, f: FoundFile, state: FileState, onLines: OnLines, filter?: (raw: string) => boolean): Promise<number> {
  if (f.size > MAX_READ_BYTES) throw new Error(`${Math.round(f.size / 1048576)} MB is more than this device sends at once (update its daemon)`);
  const bytes = await machine.readFile(f.path);
  const { lines, end } = readJsonlChunk(bytes, { startByte: state.o, filter });
  onLines(f, lines, state);
  state.o = end;
  return bytes.byteLength;
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
