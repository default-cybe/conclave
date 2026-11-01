import { dirname, join, isAbsolute, relative } from 'node:path';
import type { Machine } from '../machine/types';
import type { ConclaveConfig } from '../config/schema';
import { parseFrontmatter, toList } from '../util/frontmatter';

export interface InstructionFile {
  path: string;
  content: string;
}

const MAX_IMPORT_DEPTH = 4;

/**
 * Collect project and user instruction files for a session, in load order
 * (least specific first, most specific last). Resolves @path imports.
 *
 * Reads everything through the session's Machine, so a remote device's own
 * CLAUDE.md / AGENTS.md apply when a session runs there.
 */
export async function loadProjectInstructions(machine: Machine, cwd: string, config: ConclaveConfig): Promise<InstructionFile[]> {
  const out: InstructionFile[] = [];
  const seen = new Set<string>();
  const home = await machineHome(machine);

  const add = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    const content = await readIfFile(machine, path);
    if (content === undefined) return;
    out.push({ path, content });
    await resolveImports(machine, path, content, seen, out, 1);
  };

  /** Codex rule: in each folder take the first of AGENTS.override.md and AGENTS.md. */
  const addFirst = async (...paths: string[]): Promise<void> => {
    for (const p of paths) {
      if (await readIfFile(machine, p) !== undefined) return add(p);
    }
  };

  /** Claude Code `.claude/rules/**\/*.md`. Rules with `paths:` load when a matching file is touched (loadScopedInstructions), so they are skipped here. */
  const addRules = async (dir: string): Promise<void> => {
    for (const file of await listMarkdown(machine, dir)) {
      const content = await readIfFile(machine, file);
      if (content === undefined || seen.has(file)) continue;
      const { data } = parseFrontmatter<Record<string, unknown>>(content);
      if (data.paths !== undefined && data.paths !== null && data.paths !== '') continue;
      await add(file);
    }
  };

  // User level.
  if (home) {
    await add(join(home, '.conclave', 'CONCLAVE.md'));
    if (config.compat.agentsMd) await addFirst(join(home, '.codex', 'AGENTS.override.md'), join(home, '.codex', 'AGENTS.md'));
    if (config.compat.opencode) await add(join(home, '.config', 'opencode', 'AGENTS.md'));
    if (config.compat.gemini) await add(join(home, '.gemini', 'GEMINI.md'));
    if (config.compat.claudeCode) {
      await add(join(home, '.claude', 'CLAUDE.md'));
      await addRules(join(home, '.claude', 'rules'));
    }
  }

  // Project level: repo root down to cwd (so cwd is most specific and last).
  for (const dir of dirsRootToCwd(cwd, home)) {
    await add(join(dir, 'CONCLAVE.md'));
    if (config.compat.agentsMd) await addFirst(join(dir, 'AGENTS.override.md'), join(dir, 'AGENTS.md'));
    if (config.compat.gemini) await add(join(dir, 'GEMINI.md'));
    if (config.compat.claudeCode) {
      await add(join(dir, 'CLAUDE.md'));
      await add(join(dir, '.claude', 'CLAUDE.md'));
      await addRules(join(dir, '.claude', 'rules'));
      await add(join(dir, 'CLAUDE.local.md'));
    }
  }

  return out;
}

/** A `.claude/rules` file with `paths:` globs: it loads once a matching file is touched. */
export interface PathRule {
  path: string;
  /** Folder the globs are relative to: the one that holds `.claude/` (the session folder for user rules). */
  base: string;
  globs: string[];
  body: string;
}

/** Rules with `paths:` from the user's and the project's `.claude/rules` folders (Claude Code). */
export async function loadPathRules(machine: Machine, cwd: string, config: ConclaveConfig): Promise<PathRule[]> {
  if (!config.compat.claudeCode) return [];
  const home = await machineHome(machine);
  const out: PathRule[] = [];
  const scan = async (dir: string, base: string) => {
    for (const file of await listMarkdown(machine, join(dir, '.claude', 'rules'))) {
      const content = await readIfFile(machine, file);
      if (content === undefined) continue;
      const { data, body } = parseFrontmatter<Record<string, unknown>>(content);
      const globs = toList(data.paths) ?? [];
      if (globs.length && body.trim()) out.push({ path: file, base, globs, body: body.trim() });
    }
  };
  if (home) await scan(home, cwd);
  for (const dir of dirsRootToCwd(cwd, home)) if (dir !== home) await scan(dir, dir);
  return out;
}

/**
 * Instruction files that apply once a file is touched (HARNESS-REVIEW item
 * 11): CONCLAVE.md, AGENTS.md (or AGENTS.override.md), GEMINI.md and
 * CLAUDE.md in the folders below cwd down to the file's folder, closest last
 * (cwd's own load with the system prompt), then the path rules that match.
 */
export async function loadScopedInstructions(
  machine: Machine,
  cwd: string,
  path: string,
  config: ConclaveConfig,
  rules: PathRule[] = [],
  /** Files found per folder, kept by the caller for a turn so a remote device is asked once per folder. */
  cache?: Map<string, InstructionFile[]>,
): Promise<InstructionFile[]> {
  const out: InstructionFile[] = [];
  const root = cwd.replace(/\/+$/, '');
  const dir = dirname(path);
  if (dir.startsWith(`${root}/`)) {
    const chain: string[] = [];
    for (let d = dir; d !== root && d.startsWith(`${root}/`); d = dirname(d)) chain.unshift(d);
    for (const d of chain) {
      const hit = cache?.get(d);
      if (hit) {
        out.push(...hit);
        continue;
      }
      const found: InstructionFile[] = [];
      const names = ['CONCLAVE.md'];
      if (config.compat.agentsMd) names.push((await readIfFile(machine, join(d, 'AGENTS.override.md'))) !== undefined ? 'AGENTS.override.md' : 'AGENTS.md');
      if (config.compat.gemini) names.push('GEMINI.md');
      if (config.compat.claudeCode) names.push('CLAUDE.md');
      for (const n of names) {
        const content = await readIfFile(machine, join(d, n));
        if (content?.trim()) found.push({ path: join(d, n), content });
      }
      cache?.set(d, found);
      out.push(...found);
    }
  }
  for (const r of rules) {
    const rels = [relative(r.base, path), relative(root, path)].filter((p) => p && !p.startsWith('..'));
    if (r.globs.some((g) => rels.some((p) => new Bun.Glob(g).match(p)))) out.push({ path: r.path, content: r.body });
  }
  return out;
}

async function listMarkdown(machine: Machine, dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await machine.readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, e.name);
    if (e.type === 'dir') out.push(...(await listMarkdown(machine, full, depth + 1)));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

async function machineHome(machine: Machine): Promise<string | undefined> {
  try {
    const info = await machine.info();
    return info.home || undefined;
  } catch {
    return undefined;
  }
}

async function readIfFile(machine: Machine, path: string): Promise<string | undefined> {
  try {
    const st = await machine.stat(path);
    if (!st || st.type !== 'file') return undefined;
    return await machine.readText(path);
  } catch {
    return undefined;
  }
}

/** Every folder from cwd up to home (or the filesystem root outside home), the top one first. */
function dirsRootToCwd(cwd: string, home?: string): string[] {
  const chain: string[] = [];
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    chain.push(dir);
    if (home && dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // chain is cwd..ancestors; reverse to get root..cwd.
  return chain.reverse();
}

async function resolveImports(
  machine: Machine,
  fromPath: string,
  content: string,
  seen: Set<string>,
  out: InstructionFile[],
  depth: number,
): Promise<void> {
  if (depth > MAX_IMPORT_DEPTH) return;
  const base = dirname(fromPath);
  const re = /(?:^|\s)@([^\s]+)/g;
  const imports = new Set<string>();
  for (const m of content.matchAll(re)) {
    const ref = m[1];
    if (!ref || ref.startsWith('@')) continue;
    imports.add(isAbsolute(ref) ? ref : join(base, ref));
  }
  for (const path of imports) {
    if (seen.has(path)) continue;
    seen.add(path);
    const imported = await readIfFile(machine, path);
    if (imported === undefined) continue;
    out.push({ path, content: imported });
    await resolveImports(machine, path, imported, seen, out, depth + 1);
  }
}
