/**
 * Folder search on a device (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.4
 * step 5): one find through machine.exec over the device's roots, to depth
 * 4, for git repos and Conclave markers. Capped at 5 seconds and 3,000 hits.
 * Root commits of every hit come back in a second call, so only folders with
 * the same history are identified in full.
 */
import type { Machine } from '../machine/types';
import { shellQuote } from '../tools/util';
import { baseName } from './identity';

export const DEFAULT_SEARCH_ROOTS = ['~/code', '~/Developer', '~/src', '~/projects', '~/Sync'];
const PRUNE = ['node_modules', '.venv', 'venv', 'vendor', 'target', 'dist', 'build', '.cache', 'Library', '.Trash'];

function expand(machine: Machine, root: string, home?: string): string {
  if (home && (root === '~' || root.startsWith('~/'))) return home + root.slice(1);
  try {
    return machine.resolve(root, home ?? '/');
  } catch {
    return root;
  }
}

/** Folders under roots that hold a .git or .conclave/project.json, same name as `name` first. */
export async function searchFolders(machine: Machine, roots: string[], name: string, opts: { home?: string; timeoutMs?: number; limit?: number } = {}): Promise<string[]> {
  const dirs = [...new Set(roots.map((r) => expand(machine, r, opts.home)).filter((r) => r.startsWith('/') || /^[A-Za-z]:/.test(r)))];
  if (!dirs.length) return [];
  const prune = PRUNE.map((p) => `-name ${shellQuote(p)}`).join(' -o ');
  const script =
    `for r in ${dirs.map(shellQuote).join(' ')}; do [ -d "$r" ] && find "$r" -maxdepth 5 \\( ${prune} \\) -prune -o \\( -name .git -o -path '*/.conclave/project.json' \\) -print 2>/dev/null; done | head -n ${opts.limit ?? 3000}`;
  let stdout = '';
  try {
    const res = await machine.exec(script, { cwd: '/', timeoutMs: opts.timeoutMs ?? 5_000 });
    stdout = res.stdout;
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const line of stdout.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (l.endsWith('/.git')) found.add(l.slice(0, -5));
    else if (l.endsWith('/.conclave/project.json')) found.add(l.slice(0, -'/.conclave/project.json'.length));
  }
  const want = name.toLowerCase();
  return [...found].sort((a, b) => Number(baseName(b).toLowerCase() === want) - Number(baseName(a).toLowerCase() === want) || a.length - b.length || a.localeCompare(b));
}

/** Root commits of each folder, in one call. Folders that are not git repos get an empty list. */
export async function rootsOf(machine: Machine, folders: string[], timeoutMs = 8_000): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!folders.length) return out;
  const script = folders
    .slice(0, 300)
    .map((d) => `echo ${shellQuote(`==${d}`)}; git -C ${shellQuote(d)} rev-list --max-parents=0 HEAD 2>/dev/null`)
    .join('; ');
  try {
    const res = await machine.exec(script, { cwd: '/', timeoutMs });
    let cur: string | undefined;
    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('==')) {
        cur = line.slice(2);
        out.set(cur, []);
      } else if (cur && /^[0-9a-f]{40,64}$/.test(line.trim())) out.get(cur)!.push(line.trim());
    }
  } catch {
    /* leave empty */
  }
  return out;
}
