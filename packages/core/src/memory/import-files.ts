/**
 * Import the memory files other harnesses keep: Claude Code's CLAUDE.md
 * files and Codex's AGENTS.md files. They are read through a Machine (the
 * hub or a paired PC), split by heading, and turned into profile, fact and
 * procedure memories by the small model, deduped against what is stored.
 *
 * Where each tool looks (and so what we read by default):
 * - Claude Code: ~/.claude/CLAUDE.md (user), <project>/CLAUDE.md,
 *   <project>/.claude/CLAUDE.md, <project>/CLAUDE.local.md (personal, not committed),
 *   and auto memory in ~/.claude/projects/<sanitized-cwd>/memory/ (MEMORY.md
 *   index plus topic files Claude writes itself)
 * - Codex: ~/.codex/AGENTS.md or ~/.codex/AGENTS.override.md (user),
 *   AGENTS.md from the repo root down to the working directory, and its own
 *   memory in ~/.codex/memories/ (MEMORY.md and memory_summary.md, which
 *   Codex's memory_consolidation threads write)
 * - Gemini CLI: ~/.gemini/GEMINI.md (user, also where its memory tool
 *   writes), <project>/GEMINI.md
 * - OpenCode: ~/.config/opencode/AGENTS.md (user), <project>/AGENTS.md, and
 *   CLAUDE.md files as a fallback
 */
import type { KvRepo } from '../storage/repos';
import type { Machine } from '../machine/types';
import type { MemoryEntry } from '../types';
import { claudeRootOn, codexRootOn, joinPath } from '../importers/files';
import type { ExtractAdd, ExtractUpdate } from './extract';
import type { SqliteMemory } from './store';
import { hashText } from './connections/util';

export interface MemoryFileCandidate {
  path: string;
  scope: 'global' | 'project';
  /** Project directory for project files (the scope key sessions use). */
  project?: string;
  source: 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'file';
}

export interface FileImportStatus {
  path: string;
  source: MemoryFileCandidate['source'];
  scope: 'global' | 'project';
  status: 'imported' | 'unchanged' | 'missing' | 'empty' | 'error' | 'preview';
  added: number;
  updated: number;
  error?: string;
}

export interface FileImportResult {
  files: FileImportStatus[];
  added: MemoryEntry[];
  updated: MemoryEntry[];
  /** dryRun only: what would be saved. */
  proposed: Array<ExtractAdd & { file: string }>;
  proposedUpdates: Array<ExtractUpdate & { file: string }>;
  /** Items dropped because they looked like secrets. */
  dropped: number;
}

export interface FileImportOptions {
  /** Project directory on that machine; adds its CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, AGENTS.md. */
  cwd?: string;
  /** Re-import files that did not change since the last import. */
  force?: boolean;
  /** Show what would be saved, save nothing. */
  dryRun?: boolean;
}

const MAX_FILE_BYTES = 256 * 1024;
const CHUNK_CHARS = 6000;
const MAX_CHUNKS = 8;

const PROJECT_FILES: Array<[string, MemoryFileCandidate['source']]> = [
  ['CLAUDE.md', 'claude-code'],
  ['.claude/CLAUDE.md', 'claude-code'],
  ['CLAUDE.local.md', 'claude-code'],
  ['AGENTS.md', 'codex'],
  ['AGENTS.override.md', 'codex'],
  ['GEMINI.md', 'gemini'],
];

/** The files Claude Code and Codex read, on this machine, for the user and (with cwd) one project. */
export function defaultMemoryFiles(machine: Machine, cwd?: string): MemoryFileCandidate[] {
  const claude = claudeRootOn(machine);
  const codex = codexRootOn(machine);
  const out: MemoryFileCandidate[] = [
    { path: joinPath(claude, 'CLAUDE.md'), scope: 'global', source: 'claude-code' },
    { path: joinPath(codex, 'AGENTS.md'), scope: 'global', source: 'codex' },
    { path: joinPath(codex, 'AGENTS.override.md'), scope: 'global', source: 'codex' },
    // Codex's own memory (its consolidation threads write it; the chat import never learns from those threads)
    { path: joinPath(codex, 'memories', 'MEMORY.md'), scope: 'global', source: 'codex' },
    { path: joinPath(codex, 'memories', 'memory_summary.md'), scope: 'global', source: 'codex' },
    { path: machine.resolve('~/.gemini/GEMINI.md', '/'), scope: 'global', source: 'gemini' },
    { path: machine.resolve('~/.config/opencode/AGENTS.md', '/'), scope: 'global', source: 'opencode' },
  ];
  if (cwd) {
    const dir = machine.resolve(cwd, '/').replace(/\/+$/, '');
    for (const [rel, source] of PROJECT_FILES) out.push({ path: joinPath(dir, rel), scope: 'project', project: dir, source });
  }
  return out;
}

/** Claude Code's project folder name: every character that is not a letter or digit becomes "-". */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Claude Code auto memory for a project: MEMORY.md first, then the topic files next to it. */
export async function autoMemoryFiles(machine: Machine, cwd: string): Promise<MemoryFileCandidate[]> {
  const dir = machine.resolve(cwd, '/').replace(/\/+$/, '');
  const memDir = joinPath(claudeRootOn(machine), 'projects', claudeProjectDir(dir), 'memory');
  const entries = await machine.readdir(memDir).catch(() => []);
  const names = entries
    .filter((e) => (e.type === 'file' || e.type === 'symlink') && /\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)))
    .slice(0, 30);
  return names.map((n) => ({ path: joinPath(memDir, n), scope: 'project' as const, project: dir, source: 'claude-code' as const }));
}

/** Work out scope and project for a path the user picked. */
export function classifyMemoryFile(machine: Machine, path: string, cwd?: string): MemoryFileCandidate {
  const abs = machine.resolve(path, cwd ?? machine.resolve('~', '/'));
  const claude = claudeRootOn(machine).replace(/\/+$/, '');
  const codex = codexRootOn(machine).replace(/\/+$/, '');
  const gemini = machine.resolve('~/.gemini', '/');
  const opencode = machine.resolve('~/.config/opencode', '/');
  const name = abs.slice(abs.lastIndexOf('/') + 1);
  let source: MemoryFileCandidate['source'] = /^CLAUDE(\.local)?\.md$/i.test(name) ? 'claude-code' : /^AGENTS(\.override)?\.md$/i.test(name) ? 'codex' : /^GEMINI\.md$/i.test(name) ? 'gemini' : 'file';
  if (abs.startsWith(codex + '/memories/')) source = 'codex';
  if (abs.startsWith(opencode + '/')) source = 'opencode';
  if ([claude, codex, gemini, opencode].some((root) => abs.startsWith(root + '/'))) return { path: abs, scope: 'global', source };
  let dir = abs.slice(0, abs.lastIndexOf('/')) || '/';
  if (dir.endsWith('/.claude')) dir = dir.slice(0, -'/.claude'.length) || '/';
  return { path: abs, scope: 'project', project: dir, source };
}

/** Split markdown on headings into pieces the small model can take. */
export function chunkMarkdown(text: string, max = CHUNK_CHARS): string[] {
  const sections = text.split(/\n(?=#{1,3}\s)/);
  const out: string[] = [];
  let cur = '';
  for (const sec of sections) {
    if (cur && cur.length + sec.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    if (sec.length > max) {
      for (let i = 0; i < sec.length; i += max) out.push(sec.slice(i, i + max));
      continue;
    }
    cur = cur ? `${cur}\n${sec}` : sec;
  }
  if (cur.trim()) out.push(cur);
  return out.filter((c) => c.trim()).slice(0, MAX_CHUNKS);
}

/** Strip noise that is never memory: HTML comments and @import lines. */
function cleanText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\s*@[\w~./-]+\s*$/.test(l))
    .join('\n')
    .trim();
}

export async function importMemoryFiles(
  memory: SqliteMemory,
  kv: KvRepo,
  machine: Machine,
  paths?: string[],
  opts: FileImportOptions = {},
): Promise<FileImportResult> {
  const candidates = paths?.length
    ? paths.map((p) => classifyMemoryFile(machine, p, opts.cwd))
    : [...defaultMemoryFiles(machine, opts.cwd), ...(opts.cwd ? await autoMemoryFiles(machine, opts.cwd) : [])];
  const result: FileImportResult = { files: [], added: [], updated: [], proposed: [], proposedUpdates: [], dropped: 0 };
  const seen = new Set<string>();

  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const status: FileImportStatus = { path: c.path, source: c.source, scope: c.scope, status: 'missing', added: 0, updated: 0 };
    result.files.push(status);
    try {
      const st = await machine.stat(c.path);
      if (!st || st.type === 'dir') continue;
      if (st.size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES / 1024} KB`);
      const text = cleanText(await machine.readText(c.path));
      if (text.length < 20) {
        status.status = 'empty';
        continue;
      }
      const hash = hashText(text);
      const key = `memory.files.${machine.id}:${c.path}`;
      if (!opts.force && !opts.dryRun && kv.get<string>(key, '') === hash) {
        status.status = 'unchanged';
        continue;
      }
      const tags = [c.source === 'file' ? 'notes' : c.source];
      const chunks = chunkMarkdown(text);
      for (const [i, chunk] of chunks.entries()) {
        const label = `${c.path}${chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ''}`;
        const r = await memory.extractFromDocument(chunk, { label, scope: c.scope, scopeKey: c.project, tags, dryRun: opts.dryRun });
        result.dropped += r.dropped;
        if (opts.dryRun) {
          result.proposed.push(...r.proposed.map((p) => ({ ...p, file: c.path })));
          result.proposedUpdates.push(...r.proposedUpdates.map((u) => ({ ...u, file: c.path })));
          status.added += r.proposed.length;
          status.updated += r.proposedUpdates.length;
        } else {
          result.added.push(...r.added);
          result.updated.push(...r.updated);
          status.added += r.added.length;
          status.updated += r.updated.length;
        }
      }
      status.status = opts.dryRun ? 'preview' : 'imported';
      if (!opts.dryRun) kv.set(key, hash);
    } catch (err) {
      status.status = 'error';
      status.error = (err as Error).message;
    }
  }
  // save() merges near duplicates, so one entry can come back twice
  result.added = [...new Map(result.added.map((e) => [e.id, e])).values()];
  return result;
}
