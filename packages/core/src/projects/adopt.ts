/**
 * Where a session's work went: the folders it cloned into and the files it
 * edited, read from its tool calls. ProjectsService.adopt moves a session
 * that has no project into the one repository that holds most of that work.
 */
import { posix } from 'node:path';
import type { Message } from '../types';

/** git clone options that take a value as the next word. */
const VALUE_OPTS = new Set(['-b', '--branch', '-o', '--origin', '-c', '--config', '--depth', '--reference', '--reference-if-able', '--filter', '-u', '--upload-pack', '-j', '--jobs', '--template', '--separate-git-dir', '--shallow-since', '--shallow-exclude', '--server-option', '--bundle-uri']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function abs(p: string, cwd: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return posix.join(home, p.slice(2));
  return posix.resolve(cwd, p);
}

/** The folder a clone URL makes by default: its last path part without .git. */
function defaultDir(url: string): string {
  return (url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? '').trim();
}

/**
 * Folders a shell command clones into (git clone, gh repo clone), as absolute
 * paths. cd within the command is followed.
 * shortcut: no quoting with spaces, subshells or variables; a clone the parser misses just does not move the session.
 */
export function cloneTargets(command: string, cwd: string, home: string): string[] {
  const out: string[] = [];
  let dir = cwd;
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (words[0] === 'cd') {
      dir = words[1] ? abs(words[1], dir, home) : home;
      continue;
    }
    let args: string[] | undefined;
    let at = dir;
    let gh = false;
    if (words[0] === 'git') {
      let i = 1;
      // git -C <dir> clone ..., git -c k=v clone ...
      while (words[i]?.startsWith('-')) {
        if (words[i] === '-C' && words[i + 1]) at = abs(words[i + 1], at, home);
        i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
      }
      if (words[i] === 'clone') args = words.slice(i + 1);
    } else if (words[0] === 'gh' && words[1] === 'repo' && words[2] === 'clone') {
      args = words.slice(3);
      gh = true;
    }
    if (!args) continue;
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') {
        // gh passes what follows to git; git takes positionals after it
        if (gh) break;
        pos.push(...args.slice(i + 1));
        break;
      }
      if (a.startsWith('-')) {
        if (!gh && !a.includes('=') && VALUE_OPTS.has(a)) i++;
        continue;
      }
      pos.push(a);
    }
    const target = pos[1] ?? (pos[0] ? defaultDir(pos[0]) : '');
    if (target) out.push(abs(target, at, home));
  }
  return out;
}

export interface SessionWork {
  /** Folders cloned into by Bash calls that succeeded. */
  clones: string[];
  /** Folders of files edited by calls that succeeded, with how many edits. */
  edits: Map<string, number>;
}

/** Add the work in these messages (a turn's) to work. Relative paths are read against cwd. */
export function readWork(msgs: Message[], cwd: string, home: string, work: SessionWork): void {
  const failed = new Set<string>();
  for (const m of msgs) for (const b of m.content) if (b.type === 'tool_result' && b.isError) failed.add(b.toolUseId);
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type !== 'tool_use' || failed.has(b.id)) continue;
      const input = b.input ?? {};
      if (b.name === 'Bash' && typeof input.command === 'string') work.clones.push(...cloneTargets(input.command, cwd, home));
      else if (EDIT_TOOLS.has(b.name)) {
        const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
        if (!file) continue;
        const dir = posix.dirname(abs(file, cwd, home));
        work.edits.set(dir, (work.edits.get(dir) ?? 0) + 1);
      }
    }
  }
}

/** Weight of one clone against one file edit. */
export const CLONE_WEIGHT = 3;

/**
 * The repository root most of the work went to, or undefined: at least
 * CLONE_WEIGHT points (one clone, or that many edits) and more than half of
 * all of it. rootOf maps a folder to its repository root (undefined outside git).
 */
export async function workRoot(work: SessionWork, rootOf: (dir: string) => Promise<string | undefined>): Promise<string | undefined> {
  const score = new Map<string, number>();
  let total = [...work.edits.values()].reduce((a, n) => a + n, 0);
  const add = async (dir: string, n: number, clone = false) => {
    if (clone) total += n;
    const root = await rootOf(dir);
    if (root) score.set(root, (score.get(root) ?? 0) + n);
  };
  for (const c of new Set(work.clones)) await add(c, CLONE_WEIGHT, true);
  // the busiest folders only: each one costs a probe on the device
  for (const [dir, n] of [...work.edits].sort((a, b) => b[1] - a[1]).slice(0, 12)) await add(dir, n);
  let best: [string, number] | undefined;
  for (const e of score) if (!best || e[1] > best[1]) best = e;
  return best && best[1] >= CLONE_WEIGHT && best[1] * 2 > total ? best[0] : undefined;
}
