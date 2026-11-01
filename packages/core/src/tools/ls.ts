import type { DirEntry } from '../machine/types';
import type { Tool, ToolContext } from './types';
import { fail, formatBytes, joinPath, resolveAbsolute, pathRule } from './util';

export interface LSInput {
  path: string;
  ignore?: string[];
}

const MAX_DEPTH = 2;
const MAX_ENTRIES = 1000;
/** Listed but never opened. */
const HEAVY_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'dist', 'build', 'target', '.cache', '.turbo', '.gradle', 'Pods', 'DerivedData', '.mypy_cache', '.pytest_cache', 'coverage']);

const DESCRIPTION = `List a directory as a tree, two levels deep.

Usage:
- path is a directory, absolute or relative to the working directory.
- ignore is an optional list of glob patterns for names to leave out (e.g. ["*.log", "tmp"]).
- Directories end with "/". Large generated folders (node_modules, .git, dist, build...) are shown but not expanded.
- Prefer Glob or Grep when you know what you are looking for.`;

export const LSTool: Tool<LSInput> = {
  name: 'LS',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the directory to list, absolute or relative to the working directory' },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns for names to skip' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  readOnly: true,
  ruleContent: (input, ctx) => pathRule(ctx, input.path),
  summarize: (input) => `List ${input.path}`,
  async run(input, ctx) {
    const r = resolveAbsolute(ctx, input.path, 'path');
    if ('error' in r) return fail(r.error);
    const root = r.path;
    const st = await ctx.machine.stat(root);
    if (!st) return fail(`Directory does not exist: ${root}`);
    if (st.type !== 'dir') return fail(`${root} is a file, not a directory. Use Read to view it.`);

    const ignores = (Array.isArray(input.ignore) ? input.ignore : []).filter((g) => typeof g === 'string' && g).map((g) => new Bun.Glob(g));
    const skip = (name: string) => ignores.some((g) => g.match(name));
    const state = { count: 0, truncated: false };
    const lines = [`${root.endsWith('/') ? root : root + '/'}`];
    await walk(ctx, root, 1, '  ', lines, skip, state);
    if (state.truncated) lines.push(`(Listing stopped at ${MAX_ENTRIES} entries. List a subdirectory or use Glob for a narrower view.)`);
    return { content: lines.join('\n'), meta: { path: root, truncated: state.truncated || undefined } };
  },
};

async function walk(
  ctx: ToolContext,
  dir: string,
  depth: number,
  indent: string,
  lines: string[],
  skip: (name: string) => boolean,
  state: { count: number; truncated: boolean },
): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await ctx.machine.readdir(dir);
  } catch (err) {
    lines.push(`${indent}(cannot read: ${(err as Error).message})`);
    return;
  }
  entries = entries.filter((e) => !skip(e.name));
  entries.sort((a, b) => {
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    return ad - bd || a.name.localeCompare(b.name);
  });
  for (const e of entries) {
    if (state.count >= MAX_ENTRIES) {
      state.truncated = true;
      return;
    }
    state.count++;
    if (e.type === 'dir') {
      const heavy = HEAVY_DIRS.has(e.name);
      const deeper = depth < MAX_DEPTH && !heavy;
      lines.push(`${indent}- ${e.name}/${heavy ? ' (not expanded)' : ''}`);
      if (deeper) await walk(ctx, joinPath(dir, e.name), depth + 1, indent + '  ', lines, skip, state);
    } else {
      const size = e.size !== undefined ? ` (${formatBytes(e.size)})` : '';
      lines.push(`${indent}- ${e.name}${e.type === 'symlink' ? ' ->' : ''}${size}`);
    }
  }
}
