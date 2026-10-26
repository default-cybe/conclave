/** Autocomplete for slash commands and @ paths. */
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
