/**
 * Copy a folder from a cloned repo: skip .git, and resolve symlinks that
 * point to files inside the repo (some skill repos link SKILL.md from a
 * package folder). Links that point outside the repo, or nowhere, are
 * dropped, so a repo cannot pull in files from the rest of the disk.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

function inside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !r.startsWith('/'));
}

/** Where a symlink points, when that is inside `root` and exists. */
export function linkTarget(link: string, root: string): string | undefined {
  try {
    const real = realpathSync(link);
    return inside(realpathSync(root), real) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Targets of symlinks under `dir` that point inside `root` but are not on disk (a sparse checkout left them out). Paths relative to root. */
export function missingLinkTargets(dir: string, root: string): string[] {
  const out: string[] = [];
  const rootAbs = resolve(root);
  const walk = (d: string, depth: number) => {
    if (depth > 20 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        const target = resolve(dirname(p), readlinkSync(p));
        if (inside(rootAbs, target) && !existsSync(target)) out.push(relative(rootAbs, target));
      } else if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  return [...new Set(out)];
}

export function copyRepoTree(from: string, to: string, root = from): void {
  rmSync(to, { recursive: true, force: true });
  const rootReal = realpathSync(root);
  const seen = new Set<string>();
  const copyFile = (src: string, dst: string) => {
    copyFileSync(src, dst);
    chmodSync(dst, statSync(src).mode & 0o777);
  };
  const walk = (src: string, dst: string, depth: number) => {
    if (depth > 30) return;
    const real = realpathSync(src);
    if (seen.has(real)) return;
    seen.add(real);
    mkdirSync(dst, { recursive: true });
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const s = join(src, e.name);
      const d = join(dst, e.name);
      if (e.isSymbolicLink()) {
        const target = linkTarget(s, rootReal);
        if (!target) continue;
        const st = statSync(target);
        if (st.isDirectory()) walk(target, d, depth + 1);
        else if (st.isFile()) copyFile(target, d);
      } else if (e.isDirectory()) walk(s, d, depth + 1);
      else if (e.isFile()) copyFile(s, d);
    }
  };
  walk(from, to, 0);
}

/** Files under a folder, relative, skipping .git; symlinks count when they resolve to a file inside `root`. */
export function listRepoFiles(dir: string, root = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, base: string, depth: number) => {
    if (depth > 30) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        const target = linkTarget(p, root);
        if (!target) continue;
        if (lstatSync(target).isDirectory()) walk(target, rel, depth + 1);
        else out.push(rel);
      } else if (e.isDirectory()) walk(p, rel, depth + 1);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, '', 0);
  return out;
}
