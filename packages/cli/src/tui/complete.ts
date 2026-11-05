/** Autocomplete for slash commands and @ paths. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Edit } from './editor';

export interface Suggestion {
  /** Text that replaces the token. */
  value: string;
  label: string;
  hint?: string;
  kind: 'command' | 'file' | 'dir';
  /** For commands: true when it runs without arguments. */
  noArgs?: boolean;
}

export interface TokenRange {
  start: number;
  end: number;
  query: string;
}

/** "/mo|" -> { query: "mo" } while the cursor is in the first word of a slash line. */
export function slashToken(e: Edit): TokenRange | undefined {
  if (!e.value.startsWith('/')) return undefined;
  const firstSpace = e.value.search(/\s/);
  const end = firstSpace < 0 ? e.value.length : firstSpace;
  if (e.cursor > end || e.cursor === 0) return undefined;
  return { start: 0, end, query: e.value.slice(1, end) };
}

/** "@src/ap|" -> { query: "src/ap" } for the word under the cursor. */
export function atToken(e: Edit): TokenRange | undefined {
  let s = e.cursor;
  while (s > 0 && !/\s/.test(e.value[s - 1])) s--;
  if (e.value[s] !== '@') return undefined;
  let end = e.cursor;
  while (end < e.value.length && !/\s/.test(e.value[end])) end++;
  const query = e.value.slice(s + 1, e.cursor);
  if (query.startsWith('"')) return undefined;
  return { start: s, end, query };
}

export interface CommandInfo {
  name: string;
  description?: string;
  args?: string;
  source?: string;
}

export function matchCommands(cmds: CommandInfo[], query: string, limit = 8): Suggestion[] {
  const q = query.toLowerCase();
  const scored: Array<[number, CommandInfo]> = [];
  for (const c of cmds) {
    const n = c.name.toLowerCase();
    let score = -1;
    if (n === q) score = 0;
    else if (n.startsWith(q)) score = 1;
    else if (n.includes(q)) score = 2;
    else if (q.length > 2 && (c.description ?? '').toLowerCase().includes(q)) score = 3;
    if (score >= 0) scored.push([score, c]);
  }
  // a bare "/" lists commands in their own order (most used first); a query ranks short matches first
  if (q) scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].name.localeCompare(b[1].name));
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const [, c] of scored) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ value: '/' + c.name, label: '/' + c.name + (c.args ? ' ' + c.args : ''), hint: c.description, kind: 'command', noArgs: !c.args || /^\[/.test(c.args) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Split "@src/ap" into the directory to list and the name prefix. */
export function splitPathQuery(query: string): { dir: string; base: string } {
  const i = query.lastIndexOf('/');
  if (i < 0) return { dir: '', base: query };
  return { dir: query.slice(0, i + 1), base: query.slice(i + 1) };
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.cache', '__pycache__', '.venv', 'venv']);

/**
 * Paths under `root` (relative, dirs end in "/"), breadth first so shallow
 * files come first. Bounded, so a huge tree costs at most `max` entries.
 */
export function walkFiles(root: string, max = 4000, depth = 6): string[] {
  const out: string[] = [];
  let level = [''];
  for (let d = 0; d < depth && level.length && out.length < max; d++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries;
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const path = rel + e.name;
        if (e.isDirectory()) {
          out.push(path + '/');
          next.push(path + '/');
        } else out.push(path);
        if (out.length >= max) return out;
      }
    }
    level = next;
  }
  return out;
}

/** Subsequence score of `q` in `path`: lower is better, -1 when it does not match. Name hits and runs beat scattered ones. */
export function fuzzyScore(path: string, q: string): number {
  const p = path.toLowerCase();
  const name = p.replace(/\/$/, '').split('/').pop() ?? p;
  // "app" names app.ts exactly: that beats a longer name that only starts with it
  if (name.replace(/\.[^.]*$/, '') === q) return p.length - name.length - 1000;
  if (name.startsWith(q)) return p.length - name.length;
  if (name.includes(q)) return 100 + p.length;
  if (p.includes(q)) return 200 + p.length;
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (let k = 0; k < p.length && i < q.length; k++) {
    if (p[k] !== q[i]) continue;
    if (last >= 0 && k > last + 1) gaps++;
    last = k;
    i++;
  }
  return i === q.length ? 400 + gaps * 20 + p.length : -1;
}

/** Fuzzy @-completion across folders: "@apptsx" finds src/tui/App.tsx. */
export function fuzzyFiles(paths: string[], query: string, limit = 10): Suggestion[] {
  const q = query.toLowerCase();
  return paths
    .map((path) => [fuzzyScore(path, q), path] as const)
    .filter(([s]) => s !== -1)
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
    .slice(0, limit)
    .map(([, path]): Suggestion => ({ value: '@' + path, label: path, kind: path.endsWith('/') ? 'dir' : 'file' }));
}

export function matchFiles(entries: Array<{ name: string; type: string }>, query: string, limit = 10): Suggestion[] {
  const { dir, base } = splitPathQuery(query);
  const b = base.toLowerCase();
  const list = entries
    .filter((e) => (b.startsWith('.') || !e.name.startsWith('.')) && e.name !== '.git' && e.name !== 'node_modules')
    .filter((e) => !b || e.name.toLowerCase().startsWith(b) || (b.length > 1 && e.name.toLowerCase().includes(b)))
    .sort((x, y) => {
      const px = x.name.toLowerCase().startsWith(b) ? 0 : 1;
      const py = y.name.toLowerCase().startsWith(b) ? 0 : 1;
      if (px !== py) return px - py;
      if ((x.type === 'dir') !== (y.type === 'dir')) return x.type === 'dir' ? -1 : 1;
      return x.name.localeCompare(y.name);
    })
    .slice(0, limit);
  return list.map((e) => {
    const isDir = e.type === 'dir';
    const path = dir + e.name + (isDir ? '/' : '');
    return { value: '@' + path, label: path, kind: isDir ? 'dir' : 'file' };
  });
}
