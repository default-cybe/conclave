/**
 * Git worktrees for `isolation: 'worktree'` agent() calls, made through the
 * Machine of the run's device (docs/WORKFLOWS.md, "Worktrees on devices").
 *
 * - Path: ~/.conclave/worktrees/<repo hash>/<runId>-<seq> on that device,
 *   never inside the repository, because a repository synced with Syncthing
 *   would carry the worktree to the other machine. A path with a .stfolder
 *   marker above it is refused.
 * - Branch: conclave/wf/<runId>/<seq>, from HEAD or from an earlier call's
 *   commit (opts.conclave.worktreeFrom).
 * - Afterwards: clean with no new commits removes the worktree and branch.
 *   Otherwise the leftovers are committed as "wf <runId> <label>", the branch
 *   is kept with its sha, and the worktree folder is removed.
 *
 * addWorktree and mergeBranch are shared with repo sessions (github/service.ts),
 * GitHub ones and "Run in a worktree" on any git folder: one way to make a
 * worktree and one way to merge it back.
 */
import { posix } from 'node:path';
import type { Machine } from '../machine/types';
import type { WorktreeAction, WorktreeState } from '../client/workflows';
import { git, shq, withCommittedBy } from '../github/git';
import { sha256 } from './store';

export { shq };

export interface RepoInfo {
  root: string;
  head: string;
}

/** The repository root and HEAD commit for a folder, or undefined outside git. */
export async function repoInfo(machine: Machine, cwd: string): Promise<RepoInfo | undefined> {
  const r = await git(machine, cwd, 'rev-parse --show-toplevel HEAD', 20_000).catch(() => undefined);
  if (!r?.ok) return undefined;
  const [root, head] = r.out.split('\n').map((l) => l.trim());
  return root && head ? { root, head } : undefined;
}

/**
 * A fingerprint of the code a check runs on: HEAD plus a hash of the
 * uncommitted diff and untracked file names. A journaled lib.exec replays
 * only on the same fingerprint. Undefined outside git (then it always runs).
 */
export async function codeFingerprint(machine: Machine, cwd: string): Promise<string | undefined> {
  const cmd = `git rev-parse HEAD 2>/dev/null && { git diff HEAD --no-ext-diff 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | { sha256sum 2>/dev/null || shasum -a 256; }`;
  const r = await machine.exec(cmd, { cwd, timeoutMs: 30_000, maxOutputBytes: 10_000 }).catch(() => undefined);
  if (!r || r.exitCode !== 0) return undefined;
  const lines = r.stdout.trim().split('\n');
  if (lines.length < 2) return undefined;
  return `${lines[0].trim()}:${lines[1].split(/\s/)[0]}`;
}

/** The first folder at or above path that holds a Syncthing .stfolder marker. */
export async function syncthingMarkerAbove(machine: Machine, path: string): Promise<string | undefined> {
  let dir = posix.normalize(path);
  for (let i = 0; i < 64; i++) {
    const st = await machine.stat(posix.join(dir, '.stfolder')).catch(() => null);
    if (st) return dir;
    const up = posix.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

export interface Worktree {
  path: string;
  branch: string;
  base: string;
  root: string;
}

/** Why a worktree could not be made or merged; status is the HTTP status a hub route answers with. */
export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

/**
 * git worktree add of a new branch at path from base, never under a
 * Syncthing folder. replace removes a worktree and branch left at the same
 * place first (a workflow call's retry); otherwise a path that is there is refused.
 */
export async function addWorktree(machine: Machine, opts: { root: string; path: string; branch: string; base: string; replace?: boolean }): Promise<void> {
  const marker = await syncthingMarkerAbove(machine, posix.dirname(opts.path));
  if (marker) throw new WorktreeError(`${marker} is a Syncthing folder (.stfolder). A worktree there would sync to your other machines.`, 409);
  if (opts.replace) {
    await git(machine, opts.root, `worktree remove --force ${shq(opts.path)}`).catch(() => undefined);
    await git(machine, opts.root, `branch -D ${shq(opts.branch)}`).catch(() => undefined);
  } else if (await machine.stat(opts.path).catch(() => null)) {
    throw new WorktreeError(`${opts.path} is already there.`, 409);
  }
  await machine.mkdir(posix.dirname(opts.path)).catch(() => {});
  const r = await git(machine, opts.root, `worktree add --no-track -b ${shq(opts.branch)} ${shq(opts.path)} ${shq(opts.base)}`, 10 * 60_000);
  if (!r.ok) throw new WorktreeError(`git worktree add failed on ${machine.name}: ${r.err || r.out}`);
}

/** `-c user.name -c user.email` for what the device's own git identity lacks, so a commit is not refused. */
export async function identArgs(machine: Machine, cwd: string, fallback = { name: 'Conclave', email: 'workflows@conclave.local' }): Promise<string> {
  const name = await git(machine, cwd, 'config user.name');
  const email = await git(machine, cwd, 'config user.email');
  return `${name.out ? '' : `-c ${shq(`user.name=${fallback.name}`)} `}${email.out ? '' : `-c ${shq(`user.email=${fallback.email}`)} `}`;
}

/**
 * Merge a branch into the checkout at root. With into, root must be on that
 * branch. Refused when root has uncommitted changes to tracked files; a
 * conflict is undone, so root is as it was. squash makes one commit with message.
 */
export async function mergeBranch(
  machine: Machine,
  opts: { root: string; branch: string; into?: string; squash?: boolean; message?: string },
): Promise<{ ok: boolean; output: string; conflict?: boolean }> {
  if (opts.into) {
    const cur = await git(machine, opts.root, 'symbolic-ref --short -q HEAD', 20_000);
    if (cur.out !== opts.into) throw new WorktreeError(`The main checkout at ${opts.root} is on ${cur.out || 'a detached commit'}, not on ${opts.into}. Switch it back to ${opts.into}, then merge.`, 409);
  }
  const status = await git(machine, opts.root, 'status --porcelain --untracked-files=no', 60_000);
  const dirty = status.ok && status.out ? status.out.split('\n').length : 0;
  if (dirty) throw new WorktreeError(`The main checkout at ${opts.root} has ${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}. Commit or stash ${dirty === 1 ? 'it' : 'them'} there first, then merge.`, 409);
  const ident = await identArgs(machine, opts.root);
  const r = await git(machine, opts.root, `${ident}merge ${opts.squash ? '--squash' : '--no-edit'} ${shq(opts.branch)}`, 120_000);
  const conflict = !r.ok && /CONFLICT|unmerged|not possible because you have unmerged/i.test(`${r.out}\n${r.err}`);
  if (r.ok && opts.squash) {
    const c = await git(machine, opts.root, `${ident}commit -q --no-verify -m ${shq(opts.message || `Squash merge ${opts.branch}`)}`, 120_000);
    if (c.ok) return { ok: true, output: r.out };
    await git(machine, opts.root, 'reset -q --merge').catch(() => undefined);
    return { ok: false, output: c.err || c.out };
  }
  // merge --abort needs MERGE_HEAD, which a squash never writes; reset --merge undoes both
  if (!r.ok) await git(machine, opts.root, 'reset -q --merge').catch(() => undefined);
  return { ok: r.ok, output: r.out || r.err, ...(conflict ? { conflict } : {}) };
}

export function worktreePath(home: string, root: string, runId: string, seq: number): string {
  return posix.join(home, '.conclave', 'worktrees', sha256(root).slice(0, 12), `${runId}-${seq}`);
}

export function worktreeBranch(runId: string, seq: number): string {
  return `conclave/wf/${runId}/${seq}`;
}

/** Make a worktree for one call. Throws WorktreeError with a reason. */
export async function createWorktree(machine: Machine, opts: { home: string; root: string; base: string; runId: string; seq: number }): Promise<Worktree> {
  const path = worktreePath(opts.home, opts.root, opts.runId, opts.seq);
  const branch = worktreeBranch(opts.runId, opts.seq);
  // a branch left from an earlier attempt of the same call goes first
  await addWorktree(machine, { root: opts.root, path, branch, base: opts.base, replace: true });
  return { path, branch, base: opts.base, root: opts.root };
}

/** Clean up after the call: remove when untouched, else commit what is left and keep the branch. */
export async function finishWorktree(machine: Machine, wt: Worktree, message: string, model?: string): Promise<{ state: WorktreeState; commit?: string; files: number }> {
  const status = await git(machine, wt.path, 'status --porcelain');
  if (status.ok && status.out) {
    await git(machine, wt.path, 'add -A');
    // the device's own git identity authors it; Conclave only when the device has none, so git does not refuse
    const ident = await identArgs(machine, wt.path);
    const c = await git(machine, wt.path, `${ident}commit -q --no-verify -m ${shq(withCommittedBy(message, model))}`);
    if (!c.ok) throw new WorktreeError(`could not commit the worktree's changes: ${c.err || c.out}`);
  }
  const head = await git(machine, wt.path, 'rev-parse HEAD');
  const commit = head.ok ? head.out : undefined;
  const files = commit && commit !== wt.base ? Number((await git(machine, wt.root, `diff --name-only ${shq(wt.base)} ${shq(commit)}`)).out.split('\n').filter(Boolean).length) : 0;
  await git(machine, wt.root, `worktree remove --force ${shq(wt.path)}`);
  if (!commit || commit === wt.base) {
    await git(machine, wt.root, `branch -D ${shq(wt.branch)}`);
    return { state: 'removed', files: 0 };
  }
  return { state: 'kept', commit, files };
}

/** The commit a branch points at, or undefined when it is gone. */
export async function branchCommit(machine: Machine, root: string, branch: string): Promise<string | undefined> {
  const r = await git(machine, root, `rev-parse --verify --quiet ${shq(`${branch}^{commit}`)}`).catch(() => undefined);
  return r?.ok && r.out ? r.out : undefined;
}

/** Run a command in a temporary detached worktree at a commit (lib.runCheck with a worktree). */
export async function withDetached<T>(machine: Machine, opts: { home: string; root: string; commit: string; tag: string }, fn: (path: string) => Promise<T>): Promise<T> {
  const path = posix.join(opts.home, '.conclave', 'worktrees', sha256(opts.root).slice(0, 12), `check-${opts.tag}`);
  const marker = await syncthingMarkerAbove(machine, posix.dirname(path));
  if (marker) throw new WorktreeError(`refusing to make a worktree under ${marker}: it is a Syncthing folder`);
  await git(machine, opts.root, `worktree remove --force ${shq(path)}`).catch(() => undefined);
  const r = await git(machine, opts.root, `worktree add --detach ${shq(path)} ${shq(opts.commit)}`, 120_000);
  if (!r.ok) throw new WorktreeError(`git worktree add failed: ${r.err || r.out}`);
  try {
    return await fn(path);
  } finally {
    await git(machine, opts.root, `worktree remove --force ${shq(path)}`).catch(() => undefined);
  }
}

/** git worktree prune in a repository (at boot, for repos runs used). */
export async function pruneWorktrees(machine: Machine, root: string): Promise<void> {
  await git(machine, root, 'worktree prune').catch(() => undefined);
}

/** The owner's Diff, Merge, Cherry-pick and Discard on a kept branch. */
export async function worktreeAction(
  machine: Machine,
  opts: { root: string; branch: string; base: string; commit: string },
  action: WorktreeAction,
): Promise<{ ok: boolean; output: string; state?: WorktreeState }> {
  if (action === 'diff') {
    const r = await git(machine, opts.root, `diff ${shq(opts.base)} ${shq(opts.commit)}`);
    return { ok: r.ok, output: r.ok ? r.out : r.err };
  }
  if (action === 'discard') {
    const r = await git(machine, opts.root, `branch -D ${shq(opts.branch)}`);
    return { ok: r.ok || /not found/i.test(r.err), output: r.out || r.err, state: 'discarded' };
  }
  if (action === 'merge') {
    const r = await mergeBranch(machine, { root: opts.root, branch: opts.branch }).catch((err: Error) => ({ ok: false, output: err.message }));
    return { ok: r.ok, output: r.output, ...(r.ok ? { state: 'merged' as const } : {}) };
  }
  const r = await git(machine, opts.root, `-c user.name=Conclave -c user.email=workflows@conclave.local cherry-pick ${shq(`${opts.base}..${opts.commit}`)}`, 120_000);
  if (!r.ok) await git(machine, opts.root, 'cherry-pick --abort').catch(() => undefined);
  return { ok: r.ok, output: r.out || r.err, ...(r.ok ? { state: 'merged' as const } : {}) };
}
