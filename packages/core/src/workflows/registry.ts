/**
 * The workflow library (docs/WORKFLOWS.md, "Registry"). Workflows load in
 * this order, and a later source wins a name:
 *
 * 1. built in: packages/core/src/workflows/defaults/*.js, embedded as text;
 * 2. plugins: <plugin>/workflows/*.js, named plugin:<meta.name>;
 * 3. user: ~/.conclave/workflows/*.js;
 * 4. project: <project>/.conclave/workflows/*.js, read through the Machine of
 *    the session's device;
 * 5. Claude Code's saved workflows, behind compat.claudeCode:
 *    ~/.claude/workflows/*.js and <project>/.claude/workflows/*.js (the
 *    folders Claude Code's Workflow tool saves to, its user and project
 *    scopes).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import type { Machine } from '../machine/types';
import type { WorkflowArgFieldDto, WorkflowMetaDto, WorkflowSource, WorkflowSummary } from '../client/workflows';
import { MAX_SCRIPT_BYTES, parseScript, WorkflowLoadError } from './meta';
import { evalMeta } from './sandbox';
import { DEFAULT_WORKFLOWS } from './defaults';
import { sha256 } from './store';
import { logger } from '../util/log';

const log = logger('workflows');

export interface LibraryEntry {
  id: string;
  source: WorkflowSource;
  path?: string;
  script: string;
  meta?: WorkflowMetaDto;
  error?: string;
}

/** Parse and check a script's meta. Throws WorkflowLoadError with the reason. */
export async function loadMeta(script: string): Promise<{ meta: WorkflowMetaDto; body: string }> {
  const parsed = parseScript(script);
  let value: unknown;
  try {
    value = await evalMeta(parsed.metaSource);
  } catch (err) {
    throw new WorkflowLoadError(`meta could not be read: ${(err as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowLoadError('meta must be an object');
  const m = value as Record<string, unknown>;
  if (typeof m.name !== 'string' || !m.name.trim()) throw new WorkflowLoadError('meta.name is required');
  if (typeof m.description !== 'string' || !m.description.trim()) throw new WorkflowLoadError('meta.description is required');
  if (m.phases !== undefined) {
    if (!Array.isArray(m.phases) || m.phases.some((p) => !p || typeof p !== 'object' || typeof (p as { title?: unknown }).title !== 'string')) {
      throw new WorkflowLoadError('meta.phases must be a list of { title, detail? }');
    }
  }
  if (m.args !== undefined) {
    if (!m.args || typeof m.args !== 'object' || Array.isArray(m.args)) throw new WorkflowLoadError('meta.args must be an object of { name: { type: \'string\' | \'number\' | \'boolean\', description? } }');
    for (const [k, v] of Object.entries(m.args as Record<string, unknown>)) {
      const bad = (why: string) => new WorkflowLoadError(`meta.args.${k} ${why}`);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('must be { type, description? }');
      const f = v as { type?: unknown; description?: unknown };
      if (f.type !== 'string' && f.type !== 'number' && f.type !== 'boolean') throw bad("type must be 'string', 'number' or 'boolean'");
      if (f.description !== undefined && typeof f.description !== 'string') throw bad('description must be a string');
    }
  }
  return { meta: m as WorkflowMetaDto, body: parsed.body };
}

const metaCache = new Map<string, { meta?: WorkflowMetaDto; error?: string }>();

async function describe(script: string): Promise<{ meta?: WorkflowMetaDto; error?: string }> {
  const key = sha256(script);
  const hit = metaCache.get(key);
  if (hit) return hit;
  let out: { meta?: WorkflowMetaDto; error?: string };
  try {
    out = { meta: (await loadMeta(script)).meta };
  } catch (err) {
    out = { error: (err as Error).message };
  }
  if (metaCache.size > 500) metaCache.clear();
  metaCache.set(key, out);
  return out;
}

function jsFilesIn(dir: string): string[] {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

const TOO_LARGE = `the script is larger than ${MAX_SCRIPT_BYTES / 1024} KB`;

/**
 * A library file's text, or why it was not read. Only regular files are
 * read (a pipe or a device behind a .js name would block or never end), and
 * only up to the script size cap.
 */
export function readScriptFile(path: string): { script?: string; error?: string; skip?: boolean } {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { skip: true };
    if (st.size > MAX_SCRIPT_BYTES) return { error: TOO_LARGE };
    return { script: readFileSync(path, 'utf8') };
  } catch {
    return { skip: true };
  }
}

export interface RegistryDeps {
  /** ~/.conclave */
  home: string;
  plugins: () => Array<{ name: string; dir: string; enabled: boolean }>;
  claudeCodeCompat: () => boolean;
  /** Claude Code's home (~/.claude, or CLAUDE_CONFIG_DIR). */
  claudeHome?: () => string;
}

export class WorkflowRegistry {
  constructor(private deps: RegistryDeps) {}

  /** Where user workflows live on the hub; saved runs are under runs/. */
  get userDir(): string {
    return join(this.deps.home, 'workflows');
  }

  get runsDir(): string {
    return join(this.userDir, 'runs');
  }

  private claudeHome(): string {
    return this.deps.claudeHome?.() ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  }

  /** Every workflow, the later source winning a name. Project workflows need the session's machine and folder. */
  async list(project?: { machine: Machine; cwd: string }): Promise<LibraryEntry[]> {
    const byId = new Map<string, LibraryEntry>();
    const add = async (source: WorkflowSource, script: string, path: string | undefined, prefix?: string, readError?: string) => {
      const { meta, error } = readError ? { meta: undefined, error: readError } : await describe(script);
      const base = meta?.name ?? (path ? posix.basename(path).replace(/\.js$/, '') : 'workflow');
      const id = prefix ? `${prefix}:${base}` : base;
      byId.set(id, { id, source, path, script, ...(meta ? { meta } : {}), ...(error ? { error } : {}) });
    };
    for (const d of DEFAULT_WORKFLOWS) await add('builtin', d.script, `builtin:${d.file}`);
    for (const p of this.deps.plugins()) {
      if (!p.enabled) continue;
      for (const f of jsFilesIn(join(p.dir, 'workflows'))) {
        const r = readScriptFile(f);
        if (!r.skip) await add('plugin', r.script ?? '', f, p.name, r.error);
      }
    }
    for (const f of jsFilesIn(this.userDir)) {
      const r = readScriptFile(f);
      if (!r.skip) await add('user', r.script ?? '', f, undefined, r.error);
    }
    const compat = this.deps.claudeCodeCompat();
    if (project) await this.addProjectDir(project, posix.join(project.cwd, '.conclave', 'workflows'), 'project', add);
    if (compat) {
      for (const f of jsFilesIn(join(this.claudeHome(), 'workflows'))) {
        const r = readScriptFile(f);
        if (!r.skip) await add('claude-code', r.script ?? '', f, undefined, r.error);
      }
      if (project) await this.addProjectDir(project, posix.join(project.cwd, '.claude', 'workflows'), 'claude-code', add);
    }
    return [...byId.values()];
  }

  private async addProjectDir(
    project: { machine: Machine; cwd: string },
    dir: string,
    source: WorkflowSource,
    add: (source: WorkflowSource, script: string, path: string | undefined, prefix?: string, readError?: string) => Promise<void>,
  ): Promise<void> {
    const entries = await project.machine.readdir(dir).catch(() => []);
    for (const e of entries.filter((x) => x.type === 'file' && x.name.endsWith('.js')).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = posix.join(dir, e.name);
      try {
        // a repository may carry a huge file under a .js name: check the size before it crosses the wire
        const st = await project.machine.stat(path);
        if (!st || st.type !== 'file') continue;
        if (st.size > MAX_SCRIPT_BYTES) {
          await add(source, '', path, undefined, TOO_LARGE);
          continue;
        }
        await add(source, await project.machine.readText(path), path);
      } catch (err) {
        log.debug(`could not read ${path}`, err);
      }
    }
  }

  async get(id: string, project?: { machine: Machine; cwd: string }): Promise<LibraryEntry | undefined> {
    const all = await this.list(project);
    return all.find((e) => e.id === id) ?? all.find((e) => e.id.toLowerCase() === id.toLowerCase()) ?? all.find((e) => e.id.endsWith(`:${id}`));
  }
}

export function summaryOf(e: LibraryEntry, lastRun?: WorkflowSummary['lastRun']): WorkflowSummary {
  return {
    id: e.id,
    name: e.meta?.name ?? e.id,
    description: e.meta?.description ?? (e.error ? `Cannot load: ${e.error}` : ''),
    ...(e.meta?.whenToUse ? { whenToUse: e.meta.whenToUse } : {}),
    phases: e.meta?.phases ?? [],
    ...(Object.keys(e.meta?.args ?? {}).length ? { argsSchema: e.meta?.args as Record<string, WorkflowArgFieldDto> } : {}),
    source: e.source,
    ...(e.path && !e.path.startsWith('builtin:') ? { path: e.path } : {}),
    portable: e.meta?.runtime !== 'conclave',
    runnable: !e.error,
    ...(e.error ? { error: e.error } : {}),
    ...(lastRun ? { lastRun } : {}),
  };
}
