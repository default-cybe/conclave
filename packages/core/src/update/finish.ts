/**
 * The finisher: the part of a hub update that must outlive the hub. The hub
 * downloads and checks the release, writes <home>/updates/request.json and
 * starts this (`conclave update finish`) outside its own service:
 *
 *   systemd-user    systemd-run --user, a unit of its own, as the hub's user
 *   systemd-system  conclave-update.path sees the request and starts
 *                   conclave-update.service as root (scripts/lxc/setup.sh)
 *
 * It trusts nothing in the request but the version and the file name. It
 * copies the archive into a folder of its own, checks the size, SHA-256 and
 * signature again with the key built into it, unpacks it next to the install,
 * asks the new program its version (it must be the one asked for and newer
 * than this one), swaps the folders (the old one stays as <install>.prev),
 * restarts the service and waits for /api/health to answer with the new
 * version. When it does not, the old folder goes back, the service restarts
 * again, and the state says what happened.
 *
 * Every step is written to <home>/updates/state.json, which the hub reads to
 * show progress and to write the audit line.
 */
import { chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { UpdateJobDto, UpdateJobPhase } from '../client/updates';
import { checkUnpacked, hashFile, makeStage, plainFileIn, rollBack, swapIn, unpackHub, UpdateError, verifyArtifact } from './apply';
import type { KeyState } from './key';
import type { MinisignKey } from './minisign';
import { isVersion, type UpdateArtifact } from './manifest';

export const REQUEST_FILE = 'request.json';
export const STATE_FILE = 'state.json';

export interface UpdateRequest {
  id: string;
  /** To. */
  version: string;
  /** From: the hub that asked. */
  from: string;
  /** The hub release target: linux-x64 and so on. */
  target: string;
  /** What the manifest says about the archive: name, size, SHA-256, signature. The archive is <updates>/<artifact.file>. */
  artifact: UpdateArtifact;
  /** Where the hub answers /api/health. */
  healthUrl: string;
  /** The service to restart: conclave-hub.service. */
  unit: string;
  scope: 'user' | 'system';
  by: string;
  at: number;
}

/** state.json: the job as the hub shows it. */
export type UpdateState = UpdateJobDto;

export interface FinishDeps {
  /** <home>/updates. */
  updatesDir: string;
  /** The folder the hub runs from (it holds conclave and web/). */
  install: string;
  /** This program's version: the update must be newer. */
  current: string;
  key: KeyState | MinisignKey;
  /** Restart the hub's service. */
  restart: (req: UpdateRequest) => Promise<void>;
  /** True once the hub at req.healthUrl answers with `version`. */
  health: (req: UpdateRequest, version: string) => Promise<boolean>;
  probe?: (bin: string) => Promise<string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
  /** Give the state file to this user (a root finisher writes it for the hub's user). */
  owner?: { uid: number; gid: number };
}

export function readRequest(updatesDir: string): UpdateRequest | undefined {
  const file = join(updatesDir, REQUEST_FILE);
  if (!plainFileIn(file, updatesDir)) return undefined;
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdateRequest>;
    const a = r.artifact as Partial<UpdateArtifact> | undefined;
    if (
      typeof r.id !== 'string' ||
      !isVersion(r.version) ||
      typeof r.from !== 'string' ||
      typeof r.target !== 'string' ||
      !/^[a-z0-9-]+$/.test(r.target) ||
      !a ||
      typeof a.file !== 'string' ||
      basename(a.file) !== a.file ||
      typeof a.sha256 !== 'string' ||
      typeof a.size !== 'number' ||
      typeof r.healthUrl !== 'string' ||
      // where the hub listens: plain http on this machine or the address it is pinned to
      !/^http:\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):\d+$/.test(r.healthUrl) ||
      typeof r.unit !== 'string' ||
      // only a Conclave unit: a root finisher restarts what the request names
      !/^conclave[A-Za-z0-9@_.-]*\.service$/.test(r.unit) ||
      (r.scope !== 'user' && r.scope !== 'system')
    )
      return undefined;
    return r as UpdateRequest;
  } catch {
    return undefined;
  }
}

export function readState(updatesDir: string): UpdateState | undefined {
  try {
    return JSON.parse(readFileSync(join(updatesDir, STATE_FILE), 'utf8')) as UpdateState;
  } catch {
    return undefined;
  }
}

export function writeState(updatesDir: string, state: UpdateState, owner?: { uid: number; gid: number }): void {
  mkdirSync(updatesDir, { recursive: true });
  const file = join(updatesDir, STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o644 });
  if (owner) {
    try {
      chownSync(tmp, owner.uid, owner.gid);
    } catch {
      /* the hub can still read it */
    }
  }
  renameSync(tmp, file);
}

export const FINAL_PHASES: UpdateJobPhase[] = ['done', 'rolled-back', 'failed'];

/** Run the request in `deps.updatesDir`. Returns the final state (also in state.json). */
export async function finishUpdate(deps: FinishDeps): Promise<UpdateState | undefined> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const req = readRequest(deps.updatesDir);
  // gone first, so a path unit never starts the finisher twice for one request
  rmSync(join(deps.updatesDir, REQUEST_FILE), { force: true });
  if (!req) {
    log('no update request, or one that is not valid');
    return undefined;
  }
  const state: UpdateState = { id: req.id, version: req.version, from: req.from, phase: 'installing', startedAt: req.at, by: req.by };
  const set = (phase: UpdateJobPhase, message?: string) => {
    state.phase = phase;
    state.message = message;
    if (FINAL_PHASES.includes(phase)) state.finishedAt = now();
    writeState(deps.updatesDir, state, deps.owner);
    log(`${phase}${message ? `: ${message}` : ''}`);
  };
  set('installing', `Installing Conclave ${req.version}.`);

  const archive = join(deps.updatesDir, req.artifact.file);
  let stage: string | undefined;
  try {
    if (!plainFileIn(archive, deps.updatesDir)) throw new UpdateError('The downloaded update is missing. Nothing was installed.');
    // a copy of our own: the file the hub wrote can change after it is checked, this one cannot
    stage = makeStage(deps.install);
    const copy = join(stage, req.artifact.file);
    copyFileSync(archive, copy);
    const hashes = await hashFile(copy);
    if (hashes.size !== req.artifact.size) throw new UpdateError(`The update is ${hashes.size} bytes, the release says ${req.artifact.size}. Nothing was installed.`);
    verifyArtifact(hashes, req.artifact, deps.key);
    const { dir } = await unpackHub(copy, req.target, stage);
    const exe = join(dir, req.target.startsWith('windows-') ? 'conclave.exe' : 'conclave');
    await checkUnpacked(exe, req.version, deps.current, deps.probe);
    swapIn(deps.install, dir);
  } catch (err) {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(archive, { force: true });
    set('failed', err instanceof UpdateError ? err.message : `The update stopped: ${(err as Error).message}. Nothing was changed.`);
    return state;
  }
  rmSync(stage, { recursive: true, force: true });
  rmSync(archive, { force: true });

  set('restarting', `Restarting the hub on ${req.version}.`);
  let restartError: string | undefined;
  try {
    await deps.restart(req);
  } catch (err) {
    restartError = (err as Error).message;
  }
  set('verifying', `Waiting for Conclave ${req.version} to answer.`);
  if (!restartError && (await deps.health(req, req.version))) {
    set('done', `Updated from ${req.from} to ${req.version}. The previous version is kept next to it.`);
    return state;
  }

  // the new one did not come up: the previous folder goes back
  const why = restartError ? `the restart failed (${restartError})` : 'it did not answer in time';
  if (!rollBack(deps.install)) {
    set('failed', `Conclave ${req.version} did not start: ${why}. There was no previous version to go back to.`);
    return state;
  }
  try {
    await deps.restart(req);
  } catch {
    /* the health check below says how it went */
  }
  if (await deps.health(req, req.from)) {
    set('rolled-back', `Conclave ${req.version} did not start (${why}), so the hub went back to ${req.from}.`);
  } else {
    set('failed', `Conclave ${req.version} did not start (${why}). ${req.from} is back in place but did not answer either. Check the service: ${req.scope === 'user' ? 'journalctl --user -u' : 'journalctl -u'} ${req.unit}.`);
  }
  return state;
}

/** The hub's health URL answers with `version`, within `timeoutMs`. */
export async function waitForVersion(url: string, version: string, timeoutMs: number, f: typeof fetch = fetch, everyMs = 1000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await f(`${url.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { version?: string };
        if (body.version === version) return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

/** The owner of a folder (a root finisher gives the state file to the hub's user). */
export function ownerOf(dir: string): { uid: number; gid: number } | undefined {
  try {
    const st = statSync(dir);
    return { uid: st.uid, gid: st.gid };
  } catch {
    return undefined;
  }
}

export function hasRequest(updatesDir: string): boolean {
  return existsSync(join(updatesDir, REQUEST_FILE));
}
