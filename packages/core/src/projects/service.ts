/**
 * Folders across devices (ROUND-IMPORT-PATHS-WORKFLOWS.md 2). The projects
 * service knows each project's identity and where it lives on every device,
 * moves sessions between devices (resolution, freshness, the move note, a
 * checkpoint on the new device), and serves the location banner and the
 * Devices > Folders page. Its runner extension (extension.ts) parks turns on
 * offline devices, asks before the first write in a folder that is not an
 * exact match, and maps old paths for the file tools.
 */
import type { Engine } from '../engine/engine';
import type { Machine } from '../machine/types';
import type { EngineEventEnvelope, Session } from '../types';
import type { PathMap } from '../tools/types';
import type {
  DeviceFoldersDto,
  FolderCandidate,
  IdentifyResult,
  LocationVia,
  MappingSuggestion,
  MatchLevel,
  MoveInput,
  MoveResult,
  ProjectDto,
  SessionLocationDto,
} from '../client/projects';
import { EngineError } from '../engine/errors';
import { reminder } from '../session/transcript';
import { externalAt, setExternalAt } from '../session/harness';
import { shellQuote } from '../tools/util';
import { logger } from '../util/log';
import { OWNER_ID } from '../people/context';
import { MachineRefused } from '../people/guard';
import { atLeast, baseName, compareIdentity, comparisonLine, folderIdentity, identifyFolder, identityOf, type FolderProbe } from './identity';
import { ProjectStore, trimSlash, type ProjectRow, type SessionLocationRow } from './store';
import { SyncthingCache, syncthingLine } from './syncthing';
import { check, judge, resolveLocation, type ResolveContext, type Resolved } from './resolve';
import { checkFreshness } from './freshness';
import { gateReason, projectsExtension } from './extension';
import { underParent } from '../session/delegated';
import { readWork, workRoot, type SessionWork } from './adopt';

const log = logger('projects');

/** The line of a move without the project files (Continue without files). */
const NO_FILES = 'No project folder on this device';

export const VIA_WORDS: Record<LocationVia, string> = {
  origin: 'where it started',
  'same-path': 'same path',
  pinned: 'pinned folder',
  syncthing: 'Syncthing',
  prefix: 'learned path pair',
  search: 'found by search',
  chosen: 'chosen folder',
};

export const LEVEL_WORDS: Record<MatchLevel, string> = {
  exact: 'Exact match',
  strong: 'Strong match: the same git history',
  weak: 'Weak match: only the name is the same',
  none: 'Not matched to the project',
  mismatch: 'A different git history from the old copy',
};

/** Show a path with ~ for the device's home. */
export function tilde(path: string, home?: string): string {
  if (!home || home === '/') return path;
  const h = trimSlash(home);
  if (path === h) return '~';
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

/**
 * The repository root of a folder the owner picked: the folder without its
 * path inside the repo. The picked path is kept as written (git's top level
 * resolves symlinks, /tmp is /private/tmp on a Mac).
 */
export function repoRoot(path: string, probe: FolderProbe): string {
  const p = trimSlash(path);
  return probe.isGit && probe.rel && p.endsWith(`/${probe.rel}`) ? p.slice(0, -(probe.rel.length + 1)) : p;
}

function join(base: string, rel: string): string {
  return rel ? `${trimSlash(base)}/${rel.replace(/^\/+/, '')}` : trimSlash(base);
}

/** The text of the reminder that rides on the next user message after a move (2.7). */
export function moveNote(from: { name: string; cwd: string }, to: { name: string; cwd: string }): string {
  return `This session moved from ${from.name} at ${from.cwd} to ${to.name} at ${to.cwd}. Paths in earlier messages under the old folder now live under the new one. File tools map them for you.`;
}

interface SourceInfo {
  project?: ProjectRow;
  /** The project root on the session's device (the cwd when it is not in a repo). */
  root: string;
  /** The cwd inside the root ("" at the root). */
  rel: string;
  probe?: FolderProbe;
  /** A folder of another history the owner chose to use once: it says nothing about the project's copies. */
  foreign?: boolean;
}

export class ProjectsService {
  readonly store: ProjectStore;
  readonly syncthing: SyncthingCache;
  /** Old roots per session that file tools map (2.7), filled on a move and lazily before a turn. */
  private maps = new Map<string, PathMap['roots']>();
  /** Old roots already explained to the model, per session. */
  private noted = new Map<string, Set<string>>();
  private lastStatus = new Map<string, Session['status']>();
  /** Sessions whose turn is parked until their device is back (they may move). */
  private parked = new Set<string>();
  private off: Array<() => void> = [];
  /** Per session without a project: the last message read and the work seen so far (adopt). */
  private work = new Map<string, SessionWork & { seq: number }>();
  /** Work started in the background (a checkpoint after a move, the state at a turn end). */
  private bg = new Set<Promise<unknown>>();

  private track(p: Promise<unknown>): void {
    const done = p.catch(() => undefined).finally(() => this.bg.delete(done));
    this.bg.add(done);
  }

  /** Wait for background work to finish (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.bg.size) await Promise.allSettled([...this.bg]);
  }

  constructor(readonly engine: Engine) {
    this.store = new ProjectStore(engine.repos.db);
    this.syncthing = new SyncthingCache(engine.repos.kv);
  }

  start(): void {
    if (this.off.length) return;
    this.off.push(this.engine.runnerExtensions.register(projectsExtension(this)));
    this.off.push(this.engine.bus.on((e) => this.onEvent(e)));
  }

  stop(): void {
    for (const f of this.off.splice(0)) f();
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  deviceName(id: string): string {
    return this.engine.devices.list().find((d) => d.id === id)?.name ?? id;
  }

  /** The machine of an online device, or undefined. */
  machine(id: string): Machine | undefined {
    return this.engine.devices.get(id || 'local');
  }

  online(id: string): boolean {
    return !id || id === 'local' || !!this.engine.devices.get(id);
  }

  private async home(device: string): Promise<string | undefined> {
    const m = this.machine(device);
    if (m) return this.engine.machineHome(m);
    return this.engine.devices.list().find((d) => d.id === device)?.info?.home;
  }

  private async show(device: string, path: string): Promise<string> {
    return tilde(path, await this.home(device));
  }

  private deviceRoots(id: string): string[] {
    return this.engine.devices.list().find((d) => d.id === id)?.roots ?? [];
  }

  /** The top session of a subagent chain that shares its folder: moves, approvals and path maps are kept there. */
  rootSession(session: Session): Session {
    let s = session;
    for (let i = 0; i < 6 && underParent(s); i++) {
      const p = this.engine.repos.sessions.get(s.parentId!);
      if (!p || p.device !== s.device || p.cwd !== s.cwd) break;
      s = p;
    }
    return s;
  }

  // -------------------------------------------------------------------------
  // Identity and projects
  // -------------------------------------------------------------------------

  async probe(device: string, path: string): Promise<FolderProbe> {
    const m = this.machine(device);
    if (!m) throw new EngineError(409, `${this.deviceName(device)} is offline`);
    const folders = await this.syncthing.folders(device, m);
    return identifyFolder(m, path, { syncthing: folders ?? null });
  }

  dto(p: ProjectRow): ProjectDto {
    const { cloneUrl: _c, ...identity } = p.identity;
    return { id: p.id, ...(p.accountId ? { accountId: p.accountId } : {}), name: p.name, identity, createdAt: p.createdAt, updatedAt: p.updatedAt, locations: this.store.locations(p.id).map((l) => ({ ...l, deviceName: this.deviceName(l.device) })) };
  }

  /** One account's projects (the owner's when left out). */
  list(accountId?: string): ProjectDto[] {
    return this.store.list(accountId).map((p) => this.dto(p));
  }

  /** The account a device's folders belong to ("local", the hub, is the owner's). */
  private deviceAccount(device: string): string {
    return this.engine.repos.devices.accountOf(device) ?? OWNER_ID;
  }

  get(id: string): ProjectDto | undefined {
    const p = this.store.get(id);
    return p ? this.dto(p) : undefined;
  }

  /**
   * The known project a folder belongs to. Exact matches count; a strong one
   * (same history) only when the remotes cannot disagree, so two forks of
   * one template stay two projects.
   */
  private findProject(probe: FolderProbe, device: string, root: string, accountId: string): ProjectRow | undefined {
    const at = this.store.projectAt(device, root);
    if (at && (at.accountId ?? OWNER_ID) === accountId) return at;
    let best: { p: ProjectRow; level: MatchLevel } | undefined;
    // only this account's projects: the same repository in someone else's account is their project
    for (const p of this.store.list(accountId)) {
      const level = compareIdentity(p.identity, p.name, probe).level;
      const ok = level === 'exact' || (level === 'strong' && (!p.identity.remotes.length || !probe.remotes.length));
      if (ok && (!best || (level === 'exact' && best.level !== 'exact'))) best = { p, level };
    }
    return best?.p;
  }

  /**
   * Is the folder at device:root still this project? match: it is, and its
   * identity may teach the project more (new roots after the first commit, a
   * new remote). kept: a known location with another history (the owner chose
   * Use and remember, or rewrote the history there); it stays the project's
   * folder but teaches nothing. other: a folder of some other project.
   */
  private async fit(project: ProjectRow, device: string, root: string, probe: FolderProbe): Promise<'match' | 'kept' | 'other'> {
    const m = this.machine(device);
    const level = m ? (await judge({ project, fromName: '', target: m }, probe)).level : 'none';
    if (atLeast(level, 'strong')) return 'match';
    const known = this.store.locations(project.id).some((l) => l.device === device && trimSlash(l.path) === root);
    // a known location teaches the project only what it does not know yet (the root commit after the first commit)
    if (known) return level !== 'mismatch' && !project.identity.gitRoots.length ? 'match' : 'kept';
    return 'other';
  }

  /** Only folders that can be told apart get a project: git repos, synced folders and marked folders. */
  private identifiable(probe: FolderProbe): boolean {
    return probe.exists && (probe.isGit || !!probe.syncthing || !!probe.marker);
  }

  private emitProject(p: ProjectRow | undefined): void {
    if (p) this.engine.bus.emit({ type: 'project.updated', project: this.dto(this.store.get(p.id) ?? p) });
  }

  /** Learn (or find) the project of a session's folder and keep its location. */
  async source(session: Session): Promise<SourceInfo> {
    const s = this.rootSession(session);
    let project = s.projectId ? this.store.get(s.projectId) : undefined;
    const m = this.machine(s.device);
    if (m) {
      let probe: FolderProbe | undefined;
      try {
        probe = await this.probe(s.device, s.cwd);
      } catch (err) {
        log.debug(`identify ${s.cwd} failed`, err);
      }
      if (probe?.exists) {
        const rel = probe.rel && trimSlash(s.cwd).endsWith(`/${probe.rel}`) ? probe.rel : '';
        const root = rel ? trimSlash(s.cwd).slice(0, -(rel.length + 1)) : trimSlash(s.cwd);
        if (this.identifiable(probe)) {
          const identity = identityOf(probe);
          // the folder may no longer be the session's project: a cwd changed to another
          // repository, or a different history the owner chose to use once
          const fit = project ? await this.fit(project, s.device, root, probe) : 'other';
          if (project && fit === 'other') {
            const cur = this.store.currentMove(s.id);
            // Use once: the session keeps its project, and the project learns nothing from this folder
            if (cur && cur.device === s.device && trimSlash(cur.root) === root) return { project, root, rel, probe, foreign: true };
            project = undefined;
          }
          // a known location with another history (Use and remember) keeps the project's identity as it is
          if (project) project = fit === 'match' ? (this.store.updateIdentity(project.id, identity) ?? project) : project;
          else {
            const acct = this.engine.accountOf(s);
            const found = this.findProject(probe, s.device, root, acct);
            project = found ? (this.store.updateIdentity(found.id, identity) ?? found) : this.store.create(probe.name, identity, acct);
          }
          const known = this.store.locations(project.id).find((l) => l.device === s.device && trimSlash(l.path) === root);
          this.store.saveLocation(project.id, { device: s.device, path: root, via: known?.via ?? 'origin', head: probe.head });
          if (s.projectId !== project.id) this.setProject(s.id, project.id);
          this.emitProject(project);
        }
        return { project, root, rel, probe };
      }
    }
    // offline (or the folder is gone): what is known about it
    if (!project) {
      const at = this.store.projectAt(s.device, s.cwd);
      if (at && (at.accountId ?? OWNER_ID) === this.engine.accountOf(s)) project = at;
    }
    if (!project) {
      for (const p of this.store.list(this.engine.accountOf(s))) {
        const loc = this.store.locations(p.id).find((l) => l.device === s.device && (trimSlash(s.cwd) === l.path || trimSlash(s.cwd).startsWith(`${l.path}/`)));
        if (loc) {
          project = p;
          break;
        }
      }
    }
    const loc = project ? this.store.locations(project.id).find((l) => l.device === s.device && (trimSlash(s.cwd) === l.path || trimSlash(s.cwd).startsWith(`${l.path}/`))) : undefined;
    const root = loc?.path ?? trimSlash(s.cwd);
    const rel = loc && trimSlash(s.cwd) !== loc.path ? trimSlash(s.cwd).slice(loc.path.length + 1) : '';
    return { project, root, rel };
  }

  private setProject(sessionId: string, projectId: string): void {
    const s = this.engine.repos.sessions.get(sessionId);
    if (!s || s.projectId === projectId) return;
    const next = { ...s, projectId };
    this.engine.repos.sessions.update(next);
    // the session lists group by project: they learn it now, not on their next load
    this.engine.bus.emit({ type: 'session.updated', session: next });
  }

  /**
   * Give a session its project without waiting for a turn to end (an
   * imported session). The folder is read when its device is online; offline,
   * a known location of a project on that device answers. Returns the
   * project id, when the folder belongs to one.
   */
  async attach(session: Session): Promise<string | undefined> {
    if (session.kind === 'chat' || !session.cwd || session.cwd === '~') return session.projectId;
    let src: SourceInfo;
    try {
      src = await this.source(session);
    } catch (err) {
      log.debug(`project of ${session.id} not found`, err);
      return session.projectId;
    }
    if (!src.project) return session.projectId;
    // source() keeps the project on the top session of a chain, and offline it only looks it up
    if (!src.foreign) this.setProject(session.id, src.project.id);
    return src.project.id;
  }

  async identify(device: string, path: string, opts: { sessionId?: string; projectId?: string } = {}): Promise<IdentifyResult> {
    const m = this.machine(device);
    if (!m) throw new EngineError(409, `${this.deviceName(device)} is offline`);
    const abs = trimSlash(m.resolve(path, '/'));
    const probe = await this.probe(device, abs);
    let project = opts.projectId ? this.store.get(opts.projectId) : undefined;
    // the copy to compare with: the session's own device when it is another one, else the project on another device
    let fromName: string | undefined;
    if (!project && opts.sessionId) {
      const s = this.engine.repos.sessions.get(opts.sessionId);
      if (s) {
        const root = this.rootSession(s);
        // a session whose project is not learned yet (no turn ended): read its folder now
        project = root.projectId ? this.store.get(root.projectId) : ((await this.source(root).catch(() => undefined))?.project ?? this.store.projectAt(root.device, root.cwd));
        if (root.device !== device) fromName = this.deviceName(root.device);
      }
    }
    if (!project && probe.exists) project = this.findProject(probe, device, probe.toplevel ?? abs, this.deviceAccount(device));
    if (project && !fromName) {
      const other = this.store.locations(project.id).find((l) => l.device !== device);
      if (other) fromName = this.deviceName(other.device);
    }
    fromName ??= 'earlier';
    const identity = folderIdentity(probe);
    if (!probe.exists) return { device, path: abs, identity, project: project ? this.dto(project) : undefined, level: 'none', line: 'This folder does not exist on the device' };
    if (!project) return { device, path: abs, identity, level: 'none', line: probe.isGit ? 'A git repository Conclave has not seen before' : 'A plain folder Conclave has not seen before' };
    const { level, line } = await judge({ project, fromName, target: m }, probe);
    return { device, path: abs, identity, project: this.dto(project), level, line };
  }

  /** PUT /api/projects/:id/locations: verify the folder and pin it. A different history is refused. */
  async pin(projectId: string, device: string, path: string): Promise<ProjectDto> {
    const p = this.store.get(projectId);
    if (!p) throw new EngineError(404, `unknown project ${projectId}`);
    const m = this.machine(device);
    if (!m) throw new EngineError(409, `${this.deviceName(device)} is offline`);
    const abs = trimSlash(m.resolve(path, '/'));
    const probe = await this.probe(device, abs);
    if (!probe.exists) throw new EngineError(400, `${abs} does not exist on ${this.deviceName(device)}`);
    const other = this.store.locations(p.id).find((l) => l.device !== device);
    const { level, line } = await judge({ project: p, fromName: other ? this.deviceName(other.device) : 'known', target: m }, probe);
    if (level === 'mismatch') throw new EngineError(409, `${line}. Not pinned.`);
    // a folder inside the repository pins the repository
    const root = repoRoot(abs, probe);
    this.store.saveLocation(p.id, { device, path: root, via: 'pinned', pinned: true, head: probe.head });
    if (atLeast(level, 'strong')) this.store.updateIdentity(p.id, identityOf(probe));
    if (other) this.store.learnPrefix(other.device, other.path, device, root);
    this.engine.audit(undefined, 'project.pin', `${p.name}: ${device} ${root}`);
    this.emitProject(p);
    return this.dto(this.store.get(p.id)!);
  }

  unpin(projectId: string, device: string, path: string): ProjectDto {
    const p = this.store.get(projectId);
    if (!p) throw new EngineError(404, `unknown project ${projectId}`);
    if (!this.store.removeLocation(p.id, device, path)) throw new EngineError(404, `no location ${path} on ${device}`);
    this.engine.audit(undefined, 'project.unpin', `${p.name}: ${device} ${path}`);
    this.emitProject(p);
    return this.dto(p);
  }

  deletePrefix(id: string): boolean {
    const ok = this.store.deletePrefix(id);
    if (ok) this.engine.audit(undefined, 'path-prefix.delete', id);
    return ok;
  }

  // -------------------------------------------------------------------------
  // Moving a session
  // -------------------------------------------------------------------------

  private resolveCtx(src: SourceInfo, fromDevice: string, toDevice: string, target: Machine, folders: { from?: ResolveContext['fromFolders']; to?: ResolveContext['toFolders'] }): ResolveContext {
    return {
      store: this.store,
      project: src.project,
      fromDevice,
      fromRoot: src.root,
      toDevice,
      target,
      fromName: this.deviceName(fromDevice),
      targetRoots: this.deviceRoots(toDevice),
      fromFolders: folders.from,
      toFolders: folders.to,
      searchRoots: this.engine.config.get().paths?.searchRoots,
    };
  }

  /** Sessions with a move in progress: a second one (a double click) is refused, not run twice. */
  private moving = new Set<string>();

  async move(sessionId: string, input: MoveInput): Promise<MoveResult> {
    const s = this.engine.requireSession(sessionId);
    if (this.moving.has(s.id)) throw new EngineError(409, 'This session is already moving. Wait for that move to finish.');
    this.moving.add(s.id);
    try {
      return await this.moveNow(s, input);
    } finally {
      this.moving.delete(s.id);
    }
  }

  private async moveNow(s: Session, input: MoveInput): Promise<MoveResult> {
    if (s.kind === 'chat') throw new EngineError(400, 'A chat runs on the hub and has no folder to move.');
    if (underParent(s)) throw new EngineError(400, 'A subagent runs where its parent session runs. Move the parent session instead.');
    // tools of a running turn would switch devices halfway; a turn parked for an offline device may move
    if (this.engine.runnerFor(s.id).busy && !this.parked.has(s.id)) throw new EngineError(409, 'This session is in the middle of a turn. Wait for it to end or stop it, then move it.');
    const toDevice = input.device || s.device;
    const toName = this.deviceName(toDevice);
    const target = this.machine(toDevice);
    if (!target) return { resolved: false, reason: 'offline', line: `${toName} is offline.`, candidates: [] };
    // the same device again looks for the folder only after Continue without files (via none)
    const without = this.store.currentMove(this.rootSession(s).id)?.via === 'none';
    if (toDevice === s.device && !input.cwd && !input.withoutFiles && !input.clone && !without) {
      return { resolved: true, cwd: s.cwd, via: 'same-path', level: 'exact', session: s, line: `Already on ${toName} at ${await this.show(toDevice, s.cwd)}.` };
    }

    const src = await this.source(s);
    const fromFolders = await this.syncthing.folders(s.device, this.machine(s.device));
    const toFolders = await this.syncthing.folders(toDevice, target, { refresh: true });
    const ctx = this.resolveCtx(src, s.device, toDevice, target, { from: fromFolders, to: toFolders });

    let hit: Resolved | undefined;
    let cwd: string | undefined;
    if (input.withoutFiles) {
      const home = (await this.engine.machineHome(target)) ?? target.resolve('~', '/');
      hit = { path: trimSlash(home), via: 'chosen', level: 'none', line: NO_FILES, probe: { path: home, exists: true, isGit: false, roots: [], remotes: [], rawRemotes: [], shallow: false, name: baseName(home), rel: '' } };
      cwd = hit.path;
    } else {
      let chosen = input.cwd;
      if (input.clone) chosen = await this.clone(target, toName, input.clone);
      if (chosen) {
        const path = trimSlash(target.resolve(chosen, '/'));
        const r = await check(ctx, path, 'chosen');
        if (!r) return { resolved: false, reason: 'not-found', line: `${await this.show(toDevice, path)} does not exist on ${toName}.`, candidates: [] };
        if (r.level === 'mismatch' && !input.allowMismatch) {
          return { resolved: false, reason: 'mismatch', line: `${r.line}.`, candidates: [this.candidate(toDevice, r)], cloneUrl: src.project?.identity.cloneUrl };
        }
        // a folder inside the repository: the repository is the location, the folder is the cwd
        hit = { ...r, path: repoRoot(path, r.probe) };
        cwd = r.path;
      } else {
        const outcome = await resolveLocation(ctx);
        if (!outcome.hit) {
          const name = src.project?.name ?? baseName(src.root);
          return {
            resolved: false,
            reason: 'not-found',
            line: `No copy of ${name} was found on ${toName}.`,
            candidates: outcome.candidates.slice(0, 8),
            cloneUrl: src.project?.identity.cloneUrl,
            browseFrom: outcome.browseFrom,
          };
        }
        hit = outcome.hit;
        // the same folder inside the project, when it is there
        cwd = hit.path;
        if (src.rel) {
          const inner = join(hit.path, src.rel);
          if ((await target.stat(inner).catch(() => null))?.type === 'dir') cwd = inner;
        }
      }
    }
    return this.finishMove(s, src, toDevice, target, hit, cwd ?? hit.path, input);
  }

  /** Syncthing's state for the synced folder that holds a probe on a device, and whether it is paused there. */
  private async syncState(device: string, m: Machine, probe: FolderProbe): Promise<{ sync?: Awaited<ReturnType<SyncthingCache['status']>>; paused?: boolean }> {
    const st = probe.syncthing;
    if (!st) return {};
    const folder = this.syncthing.cached(device)?.folders.find((f) => f.id === st.folderId);
    return { sync: await this.syncthing.status(m, st.folderId), ...(folder?.paused ? { paused: true } : {}) };
  }

  private candidate(device: string, r: Resolved): FolderCandidate {
    return { device, path: r.path, level: r.level, via: r.via, line: r.line };
  }

  private async clone(target: Machine, toName: string, clone: NonNullable<MoveInput['clone']>): Promise<string> {
    const url = clone.url?.trim();
    if (!url || /^-/.test(url)) throw new EngineError(400, 'clone.url is required');
    const into = trimSlash(target.resolve(clone.into ?? '', '/'));
    if (!clone.into || into === '/') throw new EngineError(400, 'clone.into must be a folder path');
    if (await target.stat(into).catch(() => null)) throw new EngineError(409, `${into} already exists on ${toName}`);
    const res = await target.exec(`git clone -- ${shellQuote(url)} ${shellQuote(into)}`, { cwd: '/', timeoutMs: 15 * 60_000, env: { GIT_TERMINAL_PROMPT: '0' } });
    if (res.exitCode !== 0) throw new EngineError(502, `git clone failed on ${toName}: ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')}`);
    return into;
  }

  private async finishMove(s: Session, src: SourceInfo, toDevice: string, target: Machine, hit: Resolved, cwd: string, input: MoveInput): Promise<MoveResult> {
    const engine = this.engine;
    const root = this.rootSession(s);
    const from = { device: s.device, cwd: s.cwd };
    const fromName = this.deviceName(s.device);
    const toName = this.deviceName(toDevice);

    // resume ids made before externalAt existed belong to the old place
    const at = externalAt(s);
    for (const harness of Object.keys(s.external ?? {})) if (!at[harness]) setExternalAt(engine, s.id, harness, from);

    const { sync, paused } = await this.syncState(toDevice, target, hit.probe);
    // the old copy as it is right now when its device is online, else as the last turn left it
    const p0 = src.probe;
    const live = p0?.exists && p0.isGit && s.device !== toDevice && !src.foreign ? { sessionId: root.id, device: s.device, root: src.root, ...(p0.branch ? { branch: p0.branch } : {}), ...(p0.head ? { head: p0.head } : {}), ...(p0.dirty !== undefined ? { dirty: p0.dirty } : {}), at: Date.now() } : undefined;
    if (live) this.store.saveState(live);
    const last = live ?? this.store.state(root.id);
    // git is compared only with the project's own history: a different one has nothing to be behind
    const freshness = input.withoutFiles
      ? undefined
      : await checkFreshness({ target, root: hit.path, probe: hit.probe, last: hit.level === 'mismatch' ? undefined : last, fromName: last ? this.deviceName(last.device) : fromName, toName, sync, paused });

    // one row per move; the first move also records where the session started
    if (!this.store.moves(root.id).length) this.store.addMove({ sessionId: root.id, fromSeq: 0, device: from.device, root: src.root, via: 'origin', approved: true });
    const prev = this.store.currentMove(root.id);
    const seq = Math.max(engine.repos.messages.nextSeq(s.id), (prev?.fromSeq ?? 0) + 1);
    // the write gate (extension.ts) asks once below exact; a folder the owner remembered or pinned is already confirmed
    // a pinned folder that now holds another history is not: every write there asks
    const approved = hit.level === 'exact' || !!input.remember || (hit.via === 'pinned' && hit.level !== 'mismatch');
    // a move without the project files is kept with via "none": no old path maps into the home folder
    this.store.addMove({ sessionId: root.id, fromSeq: seq, device: toDevice, root: hit.path, level: hit.level, via: input.withoutFiles ? 'none' : hit.via, approved, freshness, line: hit.line });

    // the project learns the new location, and a path pair when the owner confirmed one.
    // A different history is kept only when the owner chose Use and remember.
    const project = src.project;
    const keep = !input.withoutFiles && (hit.level !== 'mismatch' || !!input.remember);
    if (project && keep) {
      this.store.saveLocation(project.id, { device: toDevice, path: hit.path, via: hit.via, pinned: !!input.remember, head: hit.probe.head });
      if (atLeast(hit.level, 'strong')) this.store.updateIdentity(project.id, identityOf(hit.probe));
    }
    // the owner confirmed it, or a pair that already worked; a search hit teaches only a pair that generalizes
    // (same folder name), not a one-off rename such as portfolio to portfolio-v2
    const confirmed = hit.via === 'chosen' || hit.via === 'prefix' || !!input.remember || (hit.via === 'search' && baseName(src.root) === baseName(hit.path));
    if (from.device !== toDevice && confirmed && keep) this.store.learnPrefix(from.device, src.root, toDevice, hit.path);

    // a move ends any harness process for the session on the old device
    const harnessIds = Object.values(s.external ?? {});
    if (from.device !== toDevice && harnessIds.length) engine.acp?.endSessions?.(from.device || 'local', harnessIds);

    const next = engine.updateSession(s.id, { device: toDevice, cwd }, { quiet: true });
    if (project && next.projectId !== project.id) this.setProject(s.id, project.id);
    this.maps.delete(root.id);
    this.noted.delete(root.id);
    await this.refreshPathMap(next);

    // one note on the next user message, stored with it so later requests send the same bytes
    engine.runnerFor(s.id).deliver({ block: reminder(moveNote({ name: fromName, cwd: from.cwd }, { name: toName, cwd })), wake: false });

    // a checkpoint on the new device, so the first turn there can be undone
    if (!input.withoutFiles) {
      this.track(
        import('../session/checkpoints')
          .then((m) => m.takeCheckpoint(engine, engine.requireSession(s.id), target))
          .catch((err) => log.debug('checkpoint after move skipped', err)),
      );
    }

    const shown = await this.show(toDevice, cwd);
    const line = input.withoutFiles ? `Moved to ${toName} without the project files (${shown}).` : `Moved to ${toName} at ${shown} (${VIA_WORDS[hit.via]}).`;
    engine.bus.emit({ type: 'session.moved', sessionId: s.id, from, to: { device: toDevice, cwd }, via: hit.via, level: hit.level });
    // the chat log keeps the move with what the owner should know about the copy
    const extra = [hit.level === 'mismatch' ? `${hit.line}.` : '', freshness?.stale ? freshness.line : ''].filter(Boolean).join(' ');
    engine.notice(s.id, extra ? `${line} ${extra}` : line, freshness?.stale || hit.level === 'mismatch' ? 'warning' : 'info');
    engine.audit(s.id, 'session.move', `${from.device}:${from.cwd} -> ${toDevice}:${cwd} (${hit.via}, ${hit.level})`);
    this.emitProject(project);
    const session = engine.requireSession(s.id);
    return { resolved: true, cwd, via: hit.via, level: hit.level, ...(freshness ? { freshness } : {}), session, line };
  }

  // -------------------------------------------------------------------------
  // The location banner
  // -------------------------------------------------------------------------

  /** Another online device that has the session's project, for "Run on macbook". */
  async suggestion(session: Session): Promise<SessionLocationDto['suggestion']> {
    const s = this.rootSession(session);
    const project = s.projectId ? this.store.get(s.projectId) : this.store.projectAt(s.device, s.cwd);
    if (!project) return undefined;
    const locs = this.store.locations(project.id).filter((l) => l.device !== s.device && this.online(l.device));
    const pick = locs[0];
    const st = project.identity.syncthing;
    if (pick) {
      const loc = this.store.locations(project.id).find((l) => l.device === s.device && (trimSlash(s.cwd) === l.path || trimSlash(s.cwd).startsWith(`${l.path}/`)));
      const rel = loc && trimSlash(s.cwd) !== loc.path ? trimSlash(s.cwd).slice(loc.path.length + 1) : '';
      // the same Syncthing folder there: the files are the same files
      const synced = !!st && !!this.syncthing.cached(pick.device)?.folders.some((f) => f.id === st.folderId && join(f.path, st.rel) === trimSlash(pick.path));
      return { device: pick.device, deviceName: this.deviceName(pick.device), cwd: join(pick.path, rel), via: synced ? 'syncthing' : pick.via, level: synced ? 'exact' : 'strong' };
    }
    // a synced folder the other device also has
    if (st) {
      for (const d of this.engine.devices.list()) {
        if (d.id === s.device || !this.online(d.id)) continue;
        const f = this.syncthing.cached(d.id)?.folders.find((x) => x.id === st.folderId);
        if (f) return { device: d.id, deviceName: d.name, cwd: join(f.path, st.rel), via: 'syncthing', level: 'exact' };
      }
    }
    return undefined;
  }

  async location(sessionId: string, opts: { refresh?: boolean } = {}): Promise<SessionLocationDto> {
    const s = this.engine.requireSession(sessionId);
    const root = this.rootSession(s);
    const deviceName = this.deviceName(s.device);
    const online = this.online(s.device);
    const project = root.projectId ? this.store.get(root.projectId) : undefined;
    const moves = this.store.moves(root.id);
    const history = moves.map((m) => ({ fromSeq: m.fromSeq, device: m.device, deviceName: this.deviceName(m.device), root: m.root, ...(m.via && m.via !== 'none' ? { via: m.via as LocationVia } : {}), ...(m.level ? { level: m.level } : {}), at: m.at }));
    let cur = this.store.currentMove(root.id);
    if (cur && cur.device !== s.device) cur = undefined;
    const base: SessionLocationDto = {
      sessionId: s.id,
      device: s.device,
      deviceName,
      online,
      cwd: s.cwd,
      ...(project ? { projectId: project.id, projectName: project.name } : {}),
      ...(cur?.level ? { level: cur.level } : {}),
      ...(cur?.via && cur.via !== 'none' ? { via: cur.via as LocationVia } : {}),
      ...(cur?.freshness ? { freshness: cur.freshness } : {}),
      state: 'ok',
      history,
      ...(project?.identity.cloneUrl ? { cloneUrl: project.identity.cloneUrl } : {}),
    };
    if (s.kind === 'chat') return base;
    if (!online) {
      const suggestion = await this.suggestion(s);
      const where = suggestion ? ` Your folder is also on ${suggestion.deviceName} at ${await this.show(suggestion.device, suggestion.cwd)}${suggestion.via === 'syncthing' ? ' (Syncthing)' : ''}.` : '';
      return { ...base, state: 'offline', line: `${deviceName} is offline.${where}`, ...(suggestion ? { suggestion } : {}) };
    }
    const m = this.machine(s.device)!;
    let refused = false;
    const stat = await m.stat(s.cwd).catch((err: unknown) => {
      refused = err instanceof MachineRefused;
      return null;
    });
    // a member's session on the hub's own computer works without files by design (docs/design/ACCOUNTS.md 5): no folder to find
    if (refused) return base;
    if (stat?.type !== 'dir') {
      const roots = this.deviceRoots(s.device);
      // another online device that has the project, for "Run on macbook"
      const suggestion = await this.suggestion(s).catch(() => undefined);
      const where = suggestion ? ` It is on ${suggestion.deviceName} at ${await this.show(suggestion.device, suggestion.cwd)}${suggestion.via === 'syncthing' ? ' (Syncthing)' : ''}.` : '';
      return { ...base, exists: false, state: 'missing', line: `${await this.show(s.device, s.cwd)} is not on ${deviceName}.${where}`, browseFrom: roots[0] ?? (await this.home(s.device)), ...(suggestion ? { suggestion } : {}) };
    }
    base.exists = true;
    // Continue without files: the session works in the home folder until the project's folder is here
    if (cur?.via === 'none') {
      const roots = this.deviceRoots(s.device);
      const suggestion = await this.suggestion(s).catch(() => undefined);
      return { ...base, state: 'missing', line: `${deviceName} has no folder for ${project?.name ?? 'this project'} yet. This session works in ${await this.show(s.device, s.cwd)} without the project files.`, browseFrom: roots[0] ?? (await this.home(s.device)), ...(suggestion ? { suggestion } : {}) };
    }
    if (cur?.level === 'mismatch' && !cur.approved) {
      return { ...base, state: 'mismatch', line: cur.line ? `${cur.line}.` : `This folder has a different git history from the ${this.deviceName(moves[moves.length - 2]?.device ?? s.device)} copy.` };
    }
    if (cur?.freshness?.stale) {
      if (opts.refresh) {
        const probe = await this.probe(s.device, cur.root).catch(() => undefined);
        const prevMove = moves[moves.length - 2];
        const { sync, paused } = probe ? await this.syncState(s.device, m, probe) : { sync: undefined, paused: undefined };
        const last = this.store.state(root.id);
        const freshness = await checkFreshness({ target: m, root: cur.root, probe, last: cur.level === 'mismatch' ? undefined : last, fromName: this.deviceName(last?.device ?? prevMove?.device ?? s.device), toName: deviceName, sync, paused });
        this.store.addMove({ ...cur, freshness });
        if (!freshness.stale) return { ...base, freshness, state: 'ok' };
        return { ...base, freshness, state: 'stale', line: freshness.line };
      }
      return { ...base, state: 'stale', line: cur.freshness.line };
    }
    return base;
  }

  // -------------------------------------------------------------------------
  // Devices > Folders
  // -------------------------------------------------------------------------

  /**
   * Mappings proposed from imported and earlier sessions (2.11): a folder on
   * one device whose project is known, and a folder with the same name on
   * another device that is not a location of it yet.
   */
  suggestions(device: string): MappingSuggestion[] {
    const seen = new Map<string, { device: string; cwd: string; title: string; imported: boolean }>();
    const acct = this.deviceAccount(device);
    for (const s of this.engine.repos.sessions.list({ parentId: null, limit: 500, accountId: acct })) {
      if (s.kind === 'chat' || !s.cwd) continue;
      const key = `${s.device}\u0000${trimSlash(s.cwd)}`;
      if (!seen.has(key)) seen.set(key, { device: s.device, cwd: trimSlash(s.cwd), title: s.title, imported: (s.tags ?? []).includes('imported') });
    }
    const out: MappingSuggestion[] = [];
    const places = [...seen.values()];
    for (const there of places.filter((p) => p.device === device)) {
      if (this.store.projectAt(there.device, there.cwd)) continue;
      for (const p of this.store.list(acct)) {
        const locs = this.store.locations(p.id);
        if (locs.some((l) => l.device === device)) continue;
        const known = locs.find((l) => l.device !== device && baseName(l.path).toLowerCase() === baseName(there.cwd).toLowerCase());
        if (!known) continue;
        out.push({
          id: `${p.id}:${there.cwd}`,
          projectId: p.id,
          projectName: p.name,
          fromDevice: known.device,
          fromPath: known.path,
          toDevice: device,
          toPath: there.cwd,
          reason: there.imported ? `From the imported session "${there.title}"` : `From the session "${there.title}"`,
        });
        break;
      }
    }
    return out.slice(0, 20);
  }

  async deviceFolders(device: string): Promise<DeviceFoldersDto> {
    const d = this.engine.devices.list().find((x) => x.id === device);
    if (!d && device !== 'local') throw new EngineError(404, `unknown device ${device}`);
    const m = this.machine(device);
    const folders = await this.syncthing.folders(device, m);
    const statuses = m && folders ? await Promise.all(folders.slice(0, 24).map((f) => this.syncthing.status(m, f.id))) : [];
    const names = new Map(this.store.list(this.deviceAccount(device)).map((p) => [p.id, p.name]));
    return {
      device,
      deviceName: this.deviceName(device),
      online: this.online(device),
      locations: this.store.locationsOnDevice(device).map((l) => ({ ...l, deviceName: this.deviceName(device), projectName: names.get(l.projectId) ?? baseName(l.path) })),
      prefixes: this.store.prefixes(device),
      suggestions: this.suggestions(device),
      syncthing: { available: !!folders, folders: folders ?? [], line: m ? syncthingLine(folders, statuses) : syncthingLine(folders, [], this.deviceName(device)) },
    };
  }

  // -------------------------------------------------------------------------
  // The write gate (2.8)
  // -------------------------------------------------------------------------

  /**
   * The move whose folder still needs the owner's yes before a change: below
   * an exact match, not approved, and the session still works in it.
   */
  pendingGate(session: Session): SessionLocationRow | undefined {
    const root = this.rootSession(session);
    const cur = this.store.currentMove(root.id);
    if (!cur || cur.approved || cur.device !== session.device || !cur.level || cur.level === 'exact') return undefined;
    // the gate is for the folder the session moved to; a working folder changed since then is not it
    const cwd = trimSlash(session.cwd);
    if (cwd !== cur.root && !cwd.startsWith(`${cur.root}/`)) return undefined;
    return cur;
  }

  /** The approval card's reason: the folder, the match level and the freshness line. */
  async gateText(session: Session, cur: SessionLocationRow): Promise<string> {
    const home = await this.engine.machineHome(this.engine.machineFor(session)).catch(() => undefined);
    return gateReason({ folder: tilde(cur.root, home), deviceName: this.deviceName(cur.device), level: cur.level ?? 'none', line: cur.line, freshness: cur.freshness?.stale ? cur.freshness.line : undefined });
  }

  /** The owner said yes in the folder: one yes covers it, except a different history, which asks every time. */
  passGate(cur: Pick<SessionLocationRow, 'sessionId' | 'fromSeq' | 'level'>): void {
    if (cur.level !== 'mismatch') this.store.approveMove(cur.sessionId, cur.fromSeq);
  }

  // -------------------------------------------------------------------------
  // Path map for file tools (2.7)
  // -------------------------------------------------------------------------

  /** Old roots that do not exist on the session's current device, longest first. */
  async refreshPathMap(session: Session): Promise<PathMap['roots']> {
    const root = this.rootSession(session);
    const moves = this.store.moves(root.id);
    const cur = moves[moves.length - 1];
    // without the project files (via none) old paths have nowhere to go
    if (!cur || moves.length < 2 || cur.via === 'none') {
      this.maps.set(root.id, []);
      return [];
    }
    const m = this.machine(root.device);
    // an offline device cannot say which old folders are gone: ask again once it is back
    if (!m) {
      this.maps.delete(root.id);
      return [];
    }
    const to = cur.device === root.device ? cur.root : trimSlash(root.cwd);
    const out: PathMap['roots'] = [];
    const seen = new Set<string>([to]);
    for (const mv of moves.slice(0, -1).reverse()) {
      const from = trimSlash(mv.root);
      // a home folder used without the project files was never the project
      if (seen.has(from) || mv.via === 'none' || from === '' || from === '/') continue;
      seen.add(from);
      // a folder that is really there is never mapped away
      const exists = (await m.stat(from).catch(() => null)) !== null;
      if (!exists) out.push({ from, to, device: mv.device });
    }
    out.sort((a, b) => b.from.length - a.from.length);
    this.maps.set(root.id, out);
    return out;
  }

  /**
   * Memory keys of a session's folder (2.9). Project notes keep the folder
   * path as their key, since Memory shows it and the owner types it, so
   * recall matches every known location of the project on any device, plus
   * the project id. A note saved on the PC is recalled on the Mac.
   */
  memoryKeys(session: Session): string | string[] {
    const cwd = trimSlash(session.cwd);
    const root = this.rootSession(session);
    const pid = root.projectId ?? this.store.projectAt(session.device, cwd)?.id;
    if (!pid) return session.cwd;
    const locs = this.store.locations(pid);
    // the cwd inside its project root on this device ("" at the root)
    const here = locs.find((l) => l.device === session.device && (cwd === l.path || cwd.startsWith(`${l.path}/`)));
    const rel = here && cwd !== here.path ? cwd.slice(here.path.length) : '';
    const keys = new Set<string>([cwd]);
    for (const l of locs) {
      keys.add(l.path);
      if (rel) keys.add(l.path + rel);
    }
    // old folders of the session, except a home folder without the project files and a history used once
    for (const m of this.store.moves(root.id)) if (m.via !== 'none' && m.level !== 'mismatch') keys.add(trimSlash(m.root));
    keys.add(pid);
    return [...keys];
  }

  /**
   * Roots of a session's project, the current one first, then old ones from
   * its moves: compaction lists files relative to them (2.7). Empty when the
   * session has no project.
   */
  projectRoots(session: Session): string[] {
    const root = this.rootSession(session);
    if (!root.projectId) return [];
    const cwd = trimSlash(session.cwd);
    const locs = this.store.locations(root.projectId);
    const here = locs.find((l) => l.device === session.device && (cwd === l.path || cwd.startsWith(`${l.path}/`)));
    const out = [here?.path ?? cwd];
    for (const m of this.store.moves(root.id)) if (!out.includes(trimSlash(m.root))) out.push(trimSlash(m.root));
    return out;
  }

  /** The cached map for a session (filled by refreshPathMap). */
  pathMap(session: Session): PathMap['roots'] | undefined {
    return this.maps.get(this.rootSession(session).id);
  }

  hasPathMap(session: Session): boolean {
    return this.maps.has(this.rootSession(session).id);
  }

  /** Old roots not yet explained to the model; marks them explained. */
  takeUnnoted(session: Session, roots: string[]): string[] {
    const id = this.rootSession(session).id;
    const set = this.noted.get(id) ?? new Set<string>();
    this.noted.set(id, set);
    const fresh = roots.filter((r) => !set.has(r));
    for (const r of fresh) set.add(r);
    return fresh;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Wait until the device comes back, the session moves, or the turn is stopped. */
  waitForDevice(sessionId: string, device: string, signal: AbortSignal): Promise<'resume' | 'stop'> {
    return new Promise((resolve) => {
      let done = false;
      this.parked.add(sessionId);
      const finish = (v: 'resume' | 'stop') => {
        if (done) return;
        done = true;
        this.parked.delete(sessionId);
        off();
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onAbort = () => finish('stop');
      const off = this.engine.bus.on((e) => {
        if (e.type === 'device.updated' && e.device.id === device && e.device.online) finish('resume');
        else if (e.type === 'session.updated' && e.session.id === sessionId && e.session.device !== device) finish('resume');
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) finish('stop');
      else if (this.engine.devices.get(device)) finish('resume');
    });
  }

  private onEvent(e: EngineEventEnvelope): void {
    if (e.type === 'session.updated') {
      const s = e.session;
      const prev = this.lastStatus.get(s.id);
      this.lastStatus.set(s.id, s.status);
      // the end of a turn: keep where the session is and how the folder looks (2.8)
      if (prev && prev !== 'idle' && prev !== 'error' && (s.status === 'idle' || s.status === 'error') && !underParent(s) && s.kind !== 'chat') this.track(this.recordState(s));
    } else if (e.type === 'session.deleted') {
      this.lastStatus.delete(e.sessionId);
      this.work.delete(e.sessionId);
      this.maps.delete(e.sessionId);
      this.noted.delete(e.sessionId);
    } else if (e.type === 'device.updated' && e.device.online) {
      // fresh Syncthing folders once a device connects
      void this.syncthing.folders(e.device.id, this.machine(e.device.id), { refresh: true }).catch(() => {});
    }
  }

  /**
   * The end of a turn (2.8): learn the session's project from its folder and
   * keep the device, root, branch, HEAD and dirty count. One identify call
   * gives all of it.
   */
  async recordState(sessionOrId: Session | string): Promise<void> {
    const s = typeof sessionOrId === 'string' ? this.engine.repos.sessions.get(sessionOrId) : sessionOrId;
    if (!s || s.kind === 'chat' || !this.machine(s.device)) return;
    try {
      const src = await this.source(s);
      const probe = src.probe;
      // a folder used once keeps the state of the project's own copy as it was
      if (!probe?.exists || src.foreign) return;
      const st = probe.isGit ? { ...(probe.branch ? { branch: probe.branch } : {}), ...(probe.head ? { head: probe.head } : {}), ...(probe.dirty !== undefined ? { dirty: probe.dirty } : {}) } : {};
      this.store.saveState({ sessionId: s.id, device: s.device, root: src.root, ...st, at: Date.now() });
      if (!src.project) await this.adopt(s.id);
    } catch (err) {
      log.debug(`location state for ${s.id} skipped`, err);
    }
  }

  /**
   * A session with no project (a home folder, a plain folder) whose work went
   * into one repository under the home folder, cloned or edited this session,
   * moves into it on the same device: its cwd becomes the repo root, which is
   * learned as a project location there. Runs at a turn end, so no shell or
   * read state of a running turn changes under it.
   */
  private async adopt(id: string): Promise<void> {
    const s = this.engine.repos.sessions.get(id);
    // a session moved by the owner, even without files, stays where it was put
    if (!s || s.projectId || s.kind === 'chat' || underParent(s) || this.store.moves(s.id).length) return;
    const m = this.machine(s.device);
    const home = m ? await this.engine.machineHome(m) : undefined;
    if (!home || home === '/') return;
    const h = trimSlash(home);
    const work = this.work.get(s.id) ?? { seq: 0, clones: [], edits: new Map<string, number>() };
    this.work.set(s.id, work);
    const msgs = this.engine.repos.messages.list(s.id, { afterSeq: work.seq });
    if (!msgs.length) return;
    work.seq = msgs[msgs.length - 1].seq;
    // shortcut: clone paths are read against the session's cwd, not the shell's cd from earlier calls
    readWork(msgs, trimSlash(s.cwd), h, work);
    const root = await workRoot(work, async (dir) => {
      const p = await this.probe(s.device, dir).catch(() => undefined);
      return p?.exists && p.isGit ? repoRoot(dir, p) : undefined;
    });
    // only a repo inside the home folder: a scratch clone in /tmp is not where the session works
    if (!root || root === trimSlash(s.cwd) || !root.startsWith(`${h}/`)) return;
    // a turn that started meanwhile keeps its folder; the next turn end tries again
    if (this.engine.runnerFor(s.id).busy) return;
    const from = { device: s.device, cwd: s.cwd };
    const next = this.engine.updateSession(s.id, { cwd: root }, { quiet: true });
    this.work.delete(s.id);
    await this.source(next);
    this.engine.runnerFor(s.id).deliver({ block: reminder(`This session's working folder is now ${root}, the repository its work went into. The shell starts there.`), wake: false });
    this.engine.bus.emit({ type: 'session.moved', sessionId: s.id, from, to: { device: s.device, cwd: root }, via: 'chosen', level: 'exact' });
    this.engine.notice(s.id, `Moved this chat to project ${tilde(root, h)}`, 'info');
    this.engine.audit(s.id, 'session.adopt', `${from.cwd} -> ${root}`);
  }

  /** comparisonLine re-exported for routes and tests. */
  static line = comparisonLine;
}
