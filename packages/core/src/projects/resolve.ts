/**
 * Where a project lives on another device (ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 2.4). Steps stop at the first folder that matches at strong or better:
 *
 *   1. the same path on the target
 *   2. a pinned or verified location of the project on the target
 *   3. Syncthing: the old folder sits in synced folder F at R, the target has F at P: P/R
 *   4. a learned path pair for the two devices (both ways)
 *   5. a search of the device's roots (or ~/code, ~/Developer, ~/src, ~/projects, ~/Sync)
 *
 * Every folder looked at becomes a candidate for the Choose folder sheet
 * (step 6) when none matches; step 7 (Clone here, Continue without files) is
 * up to the owner.
 */
import type { Machine } from '../machine/types';
import type { SyncthingFolder } from '../machine/syncthing';
import type { FolderCandidate, LocationVia, MatchLevel } from '../client/projects';
import { atLeast, baseName, compareIdentity, comparisonLine, hasCommit, identifyFolder, levelRank, syncthingFolderFor, type FolderProbe } from './identity';
import { DEFAULT_SEARCH_ROOTS, rootsOf, searchFolders } from './search';
import type { ProjectRow, ProjectStore } from './store';
import { trimSlash } from './store';
import { logger } from '../util/log';

const log = logger('projects');

/** Search hits whose root commits are read in one call. */
const BATCH_MAX = 80;

export interface ResolveContext {
  store: ProjectStore;
  /** The project, when its identity is known. */
  project?: ProjectRow;
  fromDevice: string;
  /** The project root on the old device. */
  fromRoot: string;
  toDevice: string;
  target: Machine;
  /** Names for one-line explanations. */
  fromName: string;
  /** Device.roots of the target (empty: the default search roots). */
  targetRoots: string[];
  /** Syncthing folders of each device, undefined when unknown. */
  fromFolders?: SyncthingFolder[];
  toFolders?: SyncthingFolder[];
  /** Extra search roots from config (paths.searchRoots). */
  searchRoots?: string[];
}

export interface Resolved {
  path: string;
  via: LocationVia;
  level: MatchLevel;
  line: string;
  probe: FolderProbe;
}

export interface ResolveOutcome {
  hit?: Resolved;
  candidates: FolderCandidate[];
  /** Where Choose folder starts: the prefix-mapped parent, else a device root. */
  browseFrom?: string;
}

/** Compare a probe with the project; asks git for the last HEAD only when it can change the answer. */
export async function judge(ctx: Pick<ResolveContext, 'project' | 'fromName' | 'target'>, probe: FolderProbe): Promise<{ level: MatchLevel; line: string }> {
  const p = ctx.project;
  if (!probe.exists) return { level: 'none', line: 'This folder does not exist on the device' };
  if (!p) return { level: 'weak', line: `No identity is known for the ${ctx.fromName} copy, so this cannot be checked` };
  let cmp = compareIdentity(p.identity, p.name, probe);
  if (!atLeast(cmp.level, 'strong') && probe.isGit && p.identity.head) {
    if (await hasCommit(ctx.target, probe.toplevel ?? probe.path, p.identity.head)) cmp = compareIdentity(p.identity, p.name, probe, { headOnTarget: true });
  }
  return { level: cmp.level, line: comparisonLine(cmp, ctx.fromName) };
}

/** Identify a path on the target and judge it. undefined when the folder is not there. */
export async function check(ctx: ResolveContext, path: string, via: LocationVia): Promise<Resolved | undefined> {
  let probe: FolderProbe;
  try {
    probe = await identifyFolder(ctx.target, path, { syncthing: ctx.toFolders ?? null });
  } catch (err) {
    log.debug(`identify ${path} on ${ctx.toDevice} failed`, err);
    return undefined;
  }
  if (!probe.exists) return undefined;
  const { level, line } = await judge(ctx, probe);
  // the path as given: git's top level resolves symlinks (/tmp is /private/tmp on a Mac)
  return { path: trimSlash(path), via, level, line, probe };
}

function join(base: string, rel: string): string {
  return rel ? `${trimSlash(base)}/${rel.replace(/^\/+/, '')}` : trimSlash(base);
}

function dirOf(p: string): string {
  const i = trimSlash(p).lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** Search roots on the target: Device.roots, else the defaults, plus config paths.searchRoots. */
export function searchRootsFor(target: Machine, deviceRoots: string[], extra: string[] = []): string[] {
  const list = deviceRoots.length ? deviceRoots : DEFAULT_SEARCH_ROOTS;
  return [...new Set([...list, ...extra].map((r) => target.resolve(r, '/')))];
}

/**
 * Run the resolution order. Steps that cannot run (no project identity, an
 * old daemon without Syncthing, no path pairs) are skipped.
 */
export async function resolveLocation(ctx: ResolveContext): Promise<ResolveOutcome> {
  const seen = new Map<string, FolderCandidate>();
  const note = (r: Resolved | undefined) => {
    if (!r) return;
    const prev = seen.get(r.path);
    if (!prev || levelRank(r.level) > levelRank(prev.level)) seen.set(r.path, { device: ctx.toDevice, path: r.path, level: r.level, via: r.via, line: r.line });
  };
  const done = (hit: Resolved): ResolveOutcome => ({ hit, candidates: rank(seen, ctx) });
  const good = (r: Resolved | undefined): r is Resolved => !!r && atLeast(r.level, 'strong');

  // 1. the same path
  const same = await check(ctx, ctx.fromRoot, 'same-path');
  note(same);
  if (good(same)) return done(same);

  // 2. pinned, then verified locations of the project on this device
  if (ctx.project) {
    const locs = ctx.store
      .locations(ctx.project.id)
      .filter((l) => l.device === ctx.toDevice && trimSlash(l.path) !== trimSlash(ctx.fromRoot))
      .slice(0, 4);
    for (const l of locs) {
      const r = await check(ctx, l.path, l.pinned ? 'pinned' : l.via);
      note(r);
      // the owner pinned it (Use and remember): it wins even below strong
      if (good(r) || (r && l.pinned)) return done({ ...r, via: l.pinned ? 'pinned' : r.via });
    }
  }

  // 3. Syncthing: the same synced folder at its path on the target
  const src = (ctx.fromFolders ? syncthingFolderFor(ctx.fromFolders, ctx.fromRoot) : undefined) ?? (ctx.project?.identity.syncthing ? { folder: { id: ctx.project.identity.syncthing.folderId }, rel: ctx.project.identity.syncthing.rel } : undefined);
  if (src && ctx.toFolders) {
    const there = ctx.toFolders.find((f) => f.id === src.folder.id);
    if (there) {
      const r = await check(ctx, join(there.path, src.rel), 'syncthing');
      note(r);
      if (good(r)) return done(r);
    }
  }

  // 4. learned path pairs between the two devices
  const mapped = ctx.store.mapByPrefix(ctx.fromDevice, ctx.fromRoot, ctx.toDevice).slice(0, 3);
  for (const m of mapped) {
    const r = await check(ctx, m.path, 'prefix');
    note(r);
    if (good(r)) return done(r);
  }

  // 5. search the device's roots: same root commits first, then the same name
  const roots = searchRootsFor(ctx.target, ctx.targetRoots, ctx.searchRoots);
  const name = ctx.project?.name ?? baseName(ctx.fromRoot);
  const found = (await searchFolders(ctx.target, roots, name)).filter((d) => !seen.has(trimSlash(d)));
  const known = ctx.project?.identity.gitRoots ?? [];
  const rootMap = known.length ? await rootsOf(ctx.target, found.slice(0, BATCH_MAX)) : new Map<string, string[]>();
  const sameHistory = found.filter((d) => (rootMap.get(d) ?? []).some((r) => known.includes(r)));
  const sameName = found.filter((d) => baseName(d).toLowerCase() === name.toLowerCase() && !sameHistory.includes(d));
  for (const d of [...sameHistory, ...sameName].slice(0, 6)) {
    const r = await check(ctx, d, 'search');
    note(r);
    if (good(r)) return done(r);
  }

  return { candidates: rank(seen, ctx), browseFrom: mapped[0] ? dirOf(mapped[0].path) : roots[0] };
}

function rank(seen: Map<string, FolderCandidate>, ctx: Pick<ResolveContext, 'project' | 'fromRoot'>): FolderCandidate[] {
  const name = (ctx.project?.name ?? baseName(ctx.fromRoot)).toLowerCase();
  return [...seen.values()].sort((a, b) => {
    const byLevel = levelRank(b.level) - levelRank(a.level);
    if (byLevel) return byLevel;
    return Number(baseName(b.path).toLowerCase() === name) - Number(baseName(a.path).toLowerCase() === name);
  });
}
