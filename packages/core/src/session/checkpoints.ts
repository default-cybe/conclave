import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Checkpoint, Session } from '../types';
import type { Machine } from '../machine/types';
import type { Engine } from '../engine/engine';
import { EngineError } from '../engine/errors';
import { newId } from '../util/ids';
import { conclaveHome } from '../config/paths';
import { logger } from '../util/log';

const log = logger('checkpoints');

/**
 * A checkpoint is a snapshot of the session's working directory, so any turn
 * can be undone even when the project itself is not a git repo. We keep a
 * separate shadow git repo per device and folder, with the work tree pointed
 * at the session cwd (GIT_DIR + GIT_WORK_TREE). This never touches the
 * project's own .git.
 *
 * The shadow repo lives on the device that has the files: under the hub's
 * own home for the hub, under ~/.conclave/checkpoints on a paired device
 * (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.9). Its name is the first 16 hex of
 * sha256(device + folder), so my-app and my_app no longer share one.
 */
export function shadowKey(device: string, cwd: string): string {
  return createHash('sha256').update(`${device}\0${cwd.replace(/\/+$/, '')}`).digest('hex').slice(0, 16);
}

/**
 * Where the hub keeps its own shadow repos: under the engine's home, which is
 * CONCLAVE_HOME on a real hub. A test engine has its own home, so its
 * checkpoints go away with it instead of filling ~/.conclave/checkpoints.
 */
function hubCheckpoints(engine: Engine): string {
  return join(engine.config?.paths?.home ?? conclaveHome(), 'checkpoints');
}

/** Checkpoints made before 2.9 used a name built from the folder, on the hub. */
function legacyShadowDir(engine: Engine, cwd: string): string {
  const safe = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 120);
  return join(hubCheckpoints(engine), safe);
}

function onHub(engine: Engine, session: Session, machine: Machine): boolean {
  return !session.device || session.device === 'local' || machine === engine.localMachine;
}

export function shadowDir(engine: Engine, session: Session, machine: Machine, ckpt?: Checkpoint): string {
  // an old checkpoint (no device recorded) lives where it always did
  if (ckpt && !ckpt.device) return legacyShadowDir(engine, session.cwd);
  const key = shadowKey(session.device || 'local', session.cwd);
  if (onHub(engine, session, machine)) return join(hubCheckpoints(engine), key);
  return machine.resolve(`~/.conclave/checkpoints/${key}`, '/');
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The shadow repo for one folder, with no user or system git config. */
function gitEnv(gitDir: string, workTree: string): Record<string, string> {
  return { GIT_DIR: gitDir, GIT_WORK_TREE: workTree, GIT_CONFIG_NOSYSTEM: '1', HOME: workTree };
}

async function git(machine: Machine, gitDir: string, workTree: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const res = await machine.exec(`git ${args.map(shq).join(' ')}`, { cwd: workTree, env: gitEnv(gitDir, workTree), timeoutMs });
  return { code: res.exitCode ?? -1, stdout: res.stdout, stderr: res.stderr };
}

async function ensureRepo(machine: Machine, gitDir: string, workTree: string): Promise<boolean> {
  const stat = await machine.stat(gitDir);
  if (stat?.type === 'dir') return true;
  await machine.mkdir(gitDir);
  const init = await git(machine, gitDir, workTree, ['init', '-q']);
  if (init.code !== 0) return false;
  await git(machine, gitDir, workTree, ['config', 'user.email', 'conclave@localhost']);
  await git(machine, gitDir, workTree, ['config', 'user.name', 'Conclave']);
  await git(machine, gitDir, workTree, ['config', 'core.excludesFile', '']);
  return true;
}

/**
 * Folders a checkpoint never snapshots: giant or vendored trees. The long
 * pathspec form, because git reads ":!__pycache__" as unknown magic "_".
 */
const SKIP = ['node_modules', '.git', 'target', 'dist', '.venv', '__pycache__'];
const SKIP_SPECS = SKIP.map((d) => `:(exclude)${d}`);

/** Snapshot the session's folder. Returns the checkpoint, or undefined when none was taken. */
export async function takeCheckpoint(engine: Engine, session: Session, machine: Machine): Promise<Checkpoint | undefined> {
  // a home folder (a routine with no folder runs there) or one above it is too big to copy each turn,
  // and restoring it would roll back unrelated files, the hub's own database among them
  const cwd = session.cwd.replace(/\/+$/, '') || '/';
  const home = (await engine.machineHome(machine))?.replace(/\/+$/, '');
  if (cwd === '/' || (home && (home === cwd || home.startsWith(`${cwd}/`)))) return undefined;
  const gitDir = shadowDir(engine, session, machine);
  if (!(await ensureRepo(machine, gitDir, session.cwd))) return undefined;
  // do not snapshot giant or vendored trees
  const add = await git(machine, gitDir, session.cwd, ['add', '-A', '--', '.', ...SKIP_SPECS], 30_000);
  if (add.code !== 0) {
    log.debug('checkpoint add failed', add.stderr);
    return undefined;
  }
  const seq = engine.repos.messages.nextSeq(session.id) - 1;
  const commit = await git(machine, gitDir, session.cwd, ['commit', '-q', '--allow-empty', '-m', `checkpoint seq ${seq}`], 30_000);
  if (commit.code !== 0) return undefined;
  const rev = await git(machine, gitDir, session.cwd, ['rev-parse', 'HEAD']);
  const sha = rev.stdout.trim();
  if (!sha) return undefined;
  const countOut = await git(machine, gitDir, session.cwd, ['show', '--stat', '--format=', 'HEAD']);
  const files = countOut.stdout.split('\n').filter((l) => l.includes('|')).length;
  const checkpoint: Checkpoint = { id: newId('ckpt'), sessionId: session.id, seq, commit: sha, files, createdAt: Date.now(), device: session.device || 'local', root: session.cwd };
  engine.repos.checkpoints.add(checkpoint);
  engine.bus.emit({ type: 'checkpoint.created', sessionId: session.id, checkpoint });
  return checkpoint;
}

/**
 * The checkpoint a turn takes before anything can change files, and when it
 * was done. A run resumed after a usage limit keeps the parked turn's, so it
 * is the code from before the user turn, not from before the resume.
 */
export interface TurnCheckpoint {
  /** The checkpoint, or undefined when none was taken (a home folder, no git, an error). Never rejects. */
  done: Promise<Checkpoint | undefined>;
  startedAt: number;
  /** When `done` settled; undefined while the snapshot still runs. */
  settledAt?: number;
  /** When a tool that can change files first ran in the turn, subagents included (session/regression-gate.ts). */
  firstWriteAt?: number;
}

/** A parked turn's checkpoint in session meta (`turnBase`), so a resume after a hub restart finds it. */
export interface TurnBase {
  checkpoint: string;
  startedAt: number;
  settledAt?: number;
  firstWriteAt?: number;
}

/**
 * Keep the turn's checkpoint in session meta when a usage limit parks it
 * (session/limits.ts). The session.resume job is durable, so the resumed run
 * may start in a new hub process with a new runner.
 */
export function keepTurnBase(engine: Engine, sessionId: string, turn: TurnCheckpoint | undefined): void {
  if (!turn) return;
  void turn.done.then((ckpt) => {
    if (!ckpt || !engine.repos.sessions.get(sessionId)) return;
    const base: TurnBase = { checkpoint: ckpt.id, startedAt: turn.startedAt, settledAt: turn.settledAt, firstWriteAt: turn.firstWriteAt };
    engine.patchMeta(sessionId, { turnBase: base });
  });
}

/** The parked turn's checkpoint from session meta, for a run resumed in a new runner. */
export function restoreTurnCheckpoint(engine: Engine, session: Session): TurnCheckpoint | undefined {
  const base = session.meta?.turnBase as TurnBase | undefined;
  if (!base?.checkpoint) return undefined;
  const ckpt = engine.repos.checkpoints.get(base.checkpoint);
  if (!ckpt || ckpt.sessionId !== session.id) return undefined;
  return { done: Promise.resolve(ckpt), startedAt: base.startedAt, settledAt: base.settledAt ?? ckpt.createdAt, firstWriteAt: base.firstWriteAt };
}

/**
 * Start a turn's checkpoint without waiting for it: the turn's first model
 * call runs meanwhile (session/runner.ts). The regression gate waits for it
 * at stop, and knows from `settledAt` whether the turn changed files first.
 */
export function startTurnCheckpoint(engine: Engine, session: Session, machine: Machine): TurnCheckpoint {
  const turn: TurnCheckpoint = { done: Promise.resolve(undefined), startedAt: Date.now() };
  turn.done = takeCheckpoint(engine, session, machine)
    .catch((err) => {
      log.debug('checkpoint skipped', err);
      return undefined;
    })
    .finally(() => {
      turn.settledAt = Date.now();
    });
  return turn;
}

/** One path that differs between a checkpoint and the folder now. */
export interface ChangedFile {
  /** A (added), M (modified), D (deleted) or T (type changed). */
  status: string;
  path: string;
  /** Blob of the content now (all zeros for a deleted file), so a later look can tell whether it changed again. */
  blob: string;
}

/** `git diff --raw -z` output: ":<mode> <mode> <blob> <blob> <status>" NUL path NUL, per file. */
export function parseRawDiff(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].replace(/^\s+/, '');
    if (!meta.startsWith(':')) break;
    const [, , , blob, status] = meta.slice(1).split(' ');
    files.push({ status: (status ?? '?').charAt(0), path: parts[i + 1], blob: blob ?? '' });
  }
  return files;
}

/**
 * Files that differ between a checkpoint and the folder now, the way the
 * checkpoint sees them (the same folders left out). The folder's state goes
 * into a throwaway index (a copy of the shadow repo's, for its stat cache),
 * so the shadow repo and its own index stay as they were. Undefined when
 * git could not tell.
 */
export async function changesSince(engine: Engine, session: Session, machine: Machine, ckpt: Checkpoint, signal?: AbortSignal): Promise<ChangedFile[] | undefined> {
  const gitDir = shadowDir(engine, session, machine, ckpt);
  const script = [
    'set -e',
    'd=$(mktemp -d "${TMPDIR:-/tmp}/conclave-index-XXXXXX")',
    `trap 'rm -rf "$d"' EXIT`,
    // -p keeps the index's mtime: git trusts an entry's stat only when the file is older than the
    // index, so a same-size edit in the second the snapshot was taken is hashed again, not missed
    'if [ -f "$GIT_DIR/index" ]; then cp -p "$GIT_DIR/index" "$d/index"; fi',
    'export GIT_INDEX_FILE="$d/index"',
    `git add -A -- . ${SKIP_SPECS.map(shq).join(' ')}`,
    `git diff --cached --raw -z --no-renames --no-abbrev ${shq(ckpt.commit)}`,
  ].join('\n');
  try {
    const r = await machine.exec(script, { cwd: session.cwd, env: gitEnv(gitDir, session.cwd), timeoutMs: 30_000, signal, maxOutputBytes: 4_000_000 });
    if (r.exitCode !== 0 || r.timedOut) {
      log.debug('checkpoint diff failed', r.stderr);
      return undefined;
    }
    return parseRawDiff(r.stdout);
  } catch (err) {
    log.debug('checkpoint diff failed', err);
    return undefined;
  }
}

/** Name prefix of the temp folders treeAt makes; removeTree deletes nothing else. */
const TREE_PREFIX = 'conclave-before-';

/**
 * The folder as it was at a checkpoint, in a new temp folder on the same
 * device, with `overlay` (paths relative to the folder) copied over it from
 * the folder as it is now. node_modules is linked, since checkpoints leave it
 * out. Returns the temp folder's path; removeTree deletes it.
 */
export async function treeAt(engine: Engine, session: Session, machine: Machine, ckpt: Checkpoint, overlay: string[], signal?: AbortSignal): Promise<string | undefined> {
  const gitDir = shadowDir(engine, session, machine, ckpt);
  const copies = overlay.map((rel) => {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    return `${dir ? `mkdir -p "$d"/${shq(dir)} && ` : ''}cp -- ${shq(rel)} "$d"/${shq(rel)}`;
  });
  const script = [
    'set -e',
    `d=$(mktemp -d "\${TMPDIR:-/tmp}/${TREE_PREFIX}XXXXXX")`,
    `trap 'rm -rf "$d" "$d.tar"' EXIT`,
    `git archive --format=tar -o "$d.tar" ${shq(ckpt.commit)}`,
    'tar -xf "$d.tar" -C "$d"',
    'rm -f "$d.tar"',
    ...copies,
    'if [ -d node_modules ] && [ ! -e "$d/node_modules" ]; then ln -s "$PWD/node_modules" "$d/node_modules"; fi',
    'trap - EXIT',
    'printf %s "$d"',
  ].join('\n');
  try {
    const r = await machine.exec(script, { cwd: session.cwd, env: gitEnv(gitDir, session.cwd), timeoutMs: 30_000, signal });
    const dir = r.stdout.trim();
    if (r.exitCode === 0 && !r.timedOut && dir.includes(TREE_PREFIX)) return dir;
    log.debug('checkpoint tree failed', r.stderr);
  } catch (err) {
    log.debug('checkpoint tree failed', err);
  }
  return undefined;
}

/** Delete a folder treeAt made. */
export async function removeTree(machine: Machine, dir: string): Promise<void> {
  if (!dir.includes(TREE_PREFIX)) return;
  await machine.exec(`rm -rf -- ${shq(dir)}`, { cwd: '/', timeoutMs: 30_000 }).catch((err) => log.debug('temp tree not removed', err));
}

export async function restoreCheckpoint(engine: Engine, session: Session, machine: Machine, checkpointId: string): Promise<void> {
  const ckpt = engine.repos.checkpoints.get(checkpointId);
  if (!ckpt || ckpt.sessionId !== session.id) throw new Error('Checkpoint not found');
  // a checkpoint is a snapshot of one folder on one device: after a move it stays there
  if (ckpt.device && (ckpt.device !== (session.device || 'local') || ckpt.root !== session.cwd)) {
    const name = engine.devices.list().find((d) => d.id === ckpt.device)?.name ?? ckpt.device;
    throw new EngineError(409, `This checkpoint is on ${name} at ${ckpt.root}. Move the session back there to restore it.`);
  }
  const gitDir = shadowDir(engine, session, machine, ckpt);
  // snapshot current state first so a restore is itself undoable
  await takeCheckpoint(engine, session, machine);
  const res = await git(machine, gitDir, session.cwd, ['restore', '--source', ckpt.commit, '--worktree', '--', '.'], 30_000);
  if (res.code !== 0) {
    const co = await git(machine, gitDir, session.cwd, ['checkout', ckpt.commit, '--', '.'], 30_000);
    if (co.code !== 0) throw new Error(`Restore failed: ${res.stderr || co.stderr}`);
  }
  engine.audit(session.id, 'checkpoint:restore', `Restored files to checkpoint at seq ${ckpt.seq}`);
  engine.notice(session.id, `Restored files to the checkpoint before message ${ckpt.seq}.`, 'success');
}
