/**
 * Claude Code usage from its local transcripts (~/.claude/projects/**.jsonl),
 * the same source ccusage reads. Each assistant line carries message.usage.
 * One API response is often written as several lines (one per content block)
 * with the same message.id and requestId, so those are deduped.
 *
 * Also works out the current 5-hour billing block the way ccusage does:
 * a block starts at the hour of the first message after a gap and lasts 5h.
 */
import type { LimitState } from '../../types';
import { claudeRootOn, joinPath, parseTime, walkFiles, type FoundFile } from '../../importers/files';
import { num, scanIncremental, type ExtUsage, type ReaderContext } from './common';

export const CLAUDE_CODE_SOURCE = 'claude-code';
export const BLOCK_MS = 5 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Project dirs to scan: ~/.claude/projects and the older ~/.config/claude/projects. */
function projectRoots(ctx: ReaderContext): string[] {
  if (ctx.root) return [joinPath(ctx.root, 'projects')];
  return [joinPath(claudeRootOn(ctx.machine), 'projects'), ctx.machine.resolve('~/.config/claude/projects', '/')];
}

export async function claudeCodeLogFiles(ctx: ReaderContext): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  for (const root of projectRoots(ctx)) out.push(...(await walkFiles(ctx.machine, root, { match: (n) => n.endsWith('.jsonl'), maxDepth: 4 })));
  return out;
}

/** New usage records since the last scan of this machine. */
export async function readClaudeCodeUsage(ctx: ReaderContext): Promise<{ records: ExtUsage[]; files: number }> {
  const files = await claudeCodeLogFiles(ctx);
  // within one read, keep the line with the most output tokens per response (later lines are more complete)
  const byKey = new Map<string, ExtUsage>();
  const read = await scanIncremental(
    ctx,
    CLAUDE_CODE_SOURCE,
    files,
    (_file, lines) => {
      for (const { value: l } of lines) {
        const rec = toRecord(l);
        if (!rec) continue;
        if (typeof l.sessionId === 'string' && ctx.counted?.(l.sessionId, rec.record.ts ?? 0)) continue;
        rec.record.device = ctx.machine.id;
        const prev = byKey.get(rec.extKey);
        if (!prev || rec.record.outputTokens > prev.record.outputTokens) byKey.set(rec.extKey, rec);
      }
    },
    (raw) => raw.includes('"usage"') && raw.includes('"assistant"'),
  );
  return { records: [...byKey.values()], files: read };
}

/** One transcript line to a usage record, or undefined if it has no billable usage. */
export function claudeLineToUsage(l: Record<string, any>): ExtUsage | undefined {
  return toRecord(l);
}

function toRecord(l: Record<string, any>): ExtUsage | undefined {
  if (l.type !== 'assistant') return undefined;
  const msg = l.message;
  const u = msg?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const model = typeof msg.model === 'string' ? msg.model : undefined;
  if (!model || model === '<synthetic>') return undefined;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  if (!input && !output && !cacheRead && !cacheWrite) return undefined;
  const id = typeof msg.id === 'string' ? msg.id : undefined;
  const req = typeof l.requestId === 'string' ? l.requestId : undefined;
  const extKey = id && req ? `${id}:${req}` : (id ?? (typeof l.uuid === 'string' ? l.uuid : undefined));
  if (!extKey) return undefined;
  const ts = parseTime(l.timestamp, 0);
  if (!ts) return undefined;
  return {
    extKey,
    record: {
      ts,
      source: CLAUDE_CODE_SOURCE,
      provider: 'anthropic',
      model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: 0,
      ...(typeof l.cwd === 'string' && l.cwd ? { cwd: l.cwd } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 5-hour blocks
// ---------------------------------------------------------------------------

export interface BlockEntry {
  ts: number;
  tokens: number;
  costUsd?: number;
}

export interface BlockInfo {
  start: number;
  end: number;
  lastActivity: number;
  /** input + output + cache read + cache write, like ccusage. */
  tokens: number;
  costUsd: number;
  entries: number;
  active: boolean;
}

/**
 * Split entries into 5-hour blocks (ccusage rules) and return the last one.
 * A block starts at the floored hour of its first entry. A new block starts
 * when an entry is 5h past the block start or 5h after the previous entry.
 */
export function currentBlock(entries: BlockEntry[], now = Date.now()): BlockInfo | undefined {
  const sorted = [...entries].filter((e) => e.ts <= now).sort((a, b) => a.ts - b.ts);
  let block: BlockInfo | undefined;
  for (const e of sorted) {
    if (!block || e.ts - block.start >= BLOCK_MS || e.ts - block.lastActivity >= BLOCK_MS) {
      const start = Math.floor(e.ts / HOUR) * HOUR;
      block = { start, end: start + BLOCK_MS, lastActivity: e.ts, tokens: 0, costUsd: 0, entries: 0, active: false };
    }
    block.lastActivity = e.ts;
    block.tokens += e.tokens;
    block.costUsd += e.costUsd ?? 0;
    block.entries++;
  }
  if (block) block.active = now < block.end && now - block.lastActivity < BLOCK_MS;
  return block;
}

export function claudeCodeLimit(block: BlockInfo | undefined, now = Date.now()): LimitState {
  return {
    provider: 'claude-code',
    label: 'Claude Code (local logs)',
    windows: block?.active ? [{ name: '5h block', resetsAt: block.end }] : [],
    updatedAt: now,
    source: 'logs',
  };
}
