/**
 * Finding and reading past sessions on one machine. The same code runs on
 * the hub against any Machine (the local disk, or a paired device through
 * its daemon) and on a v2 daemon against its own disk (importScan and
 * importRead), so a 23 MB transcript is read where it lives.
 *
 * A scan sends the paths, sizes and mtimes already known; only files that
 * changed are read again.
 */
import type { ImportSource } from '../client/import';
import type { FoundSession, RowInfo, ScanResult } from './types';

export type { FoundSession, RowInfo, ScanResult } from './types';
import type { Machine } from '../machine/types';
import { claudeCodeFiles, convertClaudeCode } from '../importers/claude-code';
import { codexFiles, codexHistoryBase, codexTitles, convertCodex, parseRolloutName } from '../importers/codex';
import { convertGemini, geminiFiles, geminiProjects } from '../importers/gemini';
import { readSessionBytes, readSessionText, sha256Hex } from '../importers/files';
import { sessionStats, type ConvertedSession } from '../importers/types';
import { renderedTokens } from './render';
import { redactSecrets } from '../memory/secrets';

/** Sources a device scan reads. Uploads (claude-ai, chatgpt) come in through POST /api/import/upload. */
export const DEVICE_SOURCES: ImportSource[] = ['claude-code', 'codex', 'gemini'];

/**
 * Same on every device for the same conversation: the source, the native id
 * where the source's ids are unique, and the first 3 message ids. A Claude
 * Code chat resumed under a new id starts with the same message ids, so the id
 * keeps the two apart (older ledger rows left it out: ImportService.knownRows).
 */
export function fingerprintOf(c: Pick<ConvertedSession, 'source' | 'nativeId' | 'nativeIdUnique'>, firstIds: string[]): string {
  return sha256Hex([c.source, c.nativeIdUnique ? (c.nativeId ?? '') : '', ...firstIds].join('\n')).slice(0, 32);
}

const SOURCE_NAME: Record<ImportSource, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', 'claude-ai': 'claude.ai', chatgpt: 'ChatGPT' };

export function sourceName(s: ImportSource | string): string {
  return SOURCE_NAME[s as ImportSource] ?? s;
}

export function rowInfo(c: ConvertedSession, found: Pick<FoundSession, 'path' | 'mtime' | 'archived'>): RowInfo {
  const st = sessionStats(c.messages);
  const unknown = Object.keys(c.unknown).length ? c.unknown : undefined;
  return {
    id: c.nativeId ?? found.path.split('/').pop()!.replace(/\.jsonl?(\.zst)?$/, ''),
    // a title is often the first prompt: a token in it never reaches the lists
    title: c.title ? redactSecrets(c.title) : `Untitled ${sourceName(c.source)} session`,
    ...(c.cwd ? { cwd: c.cwd } : {}),
    ...(c.gitBranch ? { gitBranch: c.gitBranch } : {}),
    ...(c.repo ? { repo: c.repo } : {}),
    ...(c.model ? { model: c.model } : {}),
    kind: c.kind,
    ...(c.parentNativeId ? { parentId: c.parentNativeId } : {}),
    ...(c.entrypoint ? { entrypoint: c.entrypoint } : {}),
    messages: st.messages,
    humanPrompts: st.humanPrompts,
    humanChars: st.humanChars,
    createdAt: st.createdAt || found.mtime,
    updatedAt: st.updatedAt || found.mtime,
    fingerprint: fingerprintOf(c, st.firstIds),
    estTokens: renderedTokens(c.messages),
    learnable: c.learnable,
    ...(found.archived ? { archived: true } : {}),
    ...(unknown ? { unknown } : {}),
  };
}

export interface SourceRoots {
  claude?: string;
  codex?: string;
  gemini?: string;
}

/** Every session file of the given sources on a machine, with size and mtime. */
export async function discover(machine: Machine, sources: ImportSource[] = DEVICE_SOURCES, roots: SourceRoots = {}): Promise<{ found: FoundSession[]; failed: ScanResult['failed'] }> {
  const found: FoundSession[] = [];
  const failed: ScanResult['failed'] = [];
  await Promise.all(
    sources.map(async (source) => {
      try {
        if (source === 'claude-code') {
          for (const f of await claudeCodeFiles(machine, roots.claude)) found.push({ source, path: f.path, size: f.size, mtime: Math.round(f.mtimeMs), ...(f.parent ? { parent: f.parent } : {}) });
        } else if (source === 'codex') {
          for (const f of await codexFiles(machine, roots.codex)) found.push({ source, path: f.path, size: f.size, mtime: Math.round(f.mtimeMs), ...(f.archived ? { archived: true } : {}) });
        } else if (source === 'gemini') {
          for (const f of await geminiFiles(machine, roots.gemini)) found.push({ source, path: f.path, size: f.size, mtime: Math.round(f.mtimeMs), project: f.project });
        }
      } catch (err) {
        failed.push({ source, error: (err as Error).message });
      }
    }),
  );
  return { found, failed };
}

/** Per-scan lookups shared by every file: Codex titles and threads, Gemini projects. */
export class ReadContext {
  private titles?: Promise<Map<string, string>>;
  private projects?: Promise<Map<string, string>>;
  private threads?: Map<string, string>;
  /**
   * Converted base threads of paginated forks, once each is fully read.
   * Only finished results are shared: a pending read is never awaited by
   * another chain, so history_base records that name each other (or a fork
   * that names itself) end the chain instead of waiting on each other.
   */
  private bases = new Map<string, ConvertedSession | undefined>();

  constructor(
    readonly machine: Machine,
    readonly roots: SourceRoots = {},
    /** Codex files by thread id, for paginated forks. Filled lazily when missing. */
    threadPaths?: Map<string, string>,
  ) {
    this.threads = threadPaths;
  }

  codexTitles(): Promise<Map<string, string>> {
    return (this.titles ??= codexTitles(this.machine, this.roots.codex));
  }

  geminiProjects(): Promise<Map<string, string>> {
    return (this.projects ??= geminiProjects(this.machine, this.roots.gemini));
  }

  private async threadPath(threadId: string): Promise<string | undefined> {
    if (!this.threads) {
      this.threads = new Map();
      for (const f of await codexFiles(this.machine, this.roots.codex)) {
        const id = parseRolloutName(f.path)?.threadId;
        if (id && !this.threads.has(id)) this.threads.set(id, f.path);
      }
    }
    return this.threads.get(threadId);
  }

  /**
   * The converted base thread of a paginated fork. Forks of forks resolve too
   * (depth 4). `chain` holds the threads being read on the way here: a base
   * already in it is a loop and resolves to nothing.
   */
  async codexBase(threadId: string, depth = 0, chain: ReadonlySet<string> = new Set()): Promise<ConvertedSession | undefined> {
    if (this.bases.has(threadId)) return this.bases.get(threadId);
    if (chain.has(threadId) || depth > 4) return undefined;
    const path = await this.threadPath(threadId);
    if (!path) return undefined;
    const conv = await this.read({ source: 'codex', path, size: 0, mtime: 0 }, depth + 1, chain);
    // a result cut short by a loop is not cached: a read from outside the loop may get further
    if (!conv.unknown['history_base:loop']) this.bases.set(threadId, conv);
    return conv;
  }

  /** Read and convert one session file. */
  async read(found: FoundSession, depth = 0, chain: ReadonlySet<string> = new Set()): Promise<ConvertedSession> {
    const { machine } = this;
    if (found.source === 'claude-code') {
      const bytes = await readSessionBytes(machine, found.path);
      return convertClaudeCode(bytes, found.parent ? { subagent: true, parent: found.parent } : {});
    }
    if (found.source === 'codex') {
      const bytes = await readSessionBytes(machine, found.path);
      const hb = codexHistoryBase(bytes);
      const id = parseRolloutName(found.path)?.threadId;
      const here = new Set(chain);
      if (id) here.add(id);
      const loop = !!hb && here.has(hb.threadId);
      const base = hb && !loop ? await this.codexBase(hb.threadId, depth, here) : undefined;
      const titles = await this.codexTitles();
      const conv = convertCodex(bytes, { title: id ? titles.get(id) : undefined, base, path: found.path });
      if (loop) conv.unknown['history_base:loop'] = 1;
      return conv;
    }
    if (found.source === 'gemini') {
      const text = await readSessionText(machine, found.path);
      const projects = await this.geminiProjects();
      // the project dir is the folder above chats/ (a single file read later has no scan row to say so)
      const project = found.project ?? /\/tmp\/([^/]+)\/chats\/[^/]+$/.exec(found.path)?.[1];
      return convertGemini(text, { cwd: project ? projects.get(project) : undefined, path: found.path });
    }
    throw new Error(`${sourceName(found.source)} sessions are not read from devices.`);
  }
}

/**
 * Scan a machine. Files whose size and mtime match `known` are not read.
 * The daemon runs this for importScan; the hub runs it for older daemons and
 * its own disk.
 */
export async function scanMachine(
  machine: Machine,
  opts: { sources?: ImportSource[]; known?: Map<string, { size: number; mtime: number }>; roots?: SourceRoots; concurrency?: number } = {},
): Promise<ScanResult> {
  const { found, failed } = await discover(machine, opts.sources ?? DEVICE_SOURCES, opts.roots);
  const known = opts.known ?? new Map();
  const changed = found.filter((f) => {
    const k = known.get(f.path);
    return !k || k.size !== f.size || k.mtime !== f.mtime;
  });
  const threads = new Map<string, string>();
  for (const f of found) {
    if (f.source !== 'codex') continue;
    const id = parseRolloutName(f.path)?.threadId;
    if (id && !threads.has(id)) threads.set(id, f.path);
  }
  const ctx = new ReadContext(machine, opts.roots, threads);
  const rows: ScanResult['rows'] = [];
  let i = 0;
  const worker = async () => {
    while (i < changed.length) {
      const f = changed[i++];
      try {
        const c = await ctx.read(f);
        rows.push({ found: f, info: rowInfo(c, f) });
      } catch (err) {
        rows.push({ found: f, error: (err as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return { rows, present: found, failed };
}
