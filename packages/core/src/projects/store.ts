/**
 * Project storage (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.3). The
 * tables are made here with CREATE TABLE IF NOT EXISTS, so this module owns
 * them and no shared migration is needed.
 */
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import type { Freshness, LocationVia, MatchLevel, PathPrefixDto, ProjectLocationDto } from '../client/projects';
import { cleanRemote, type StoredIdentity } from './identity';
import { newId } from '../util/ids';
import { OWNER_ID } from '../people/context';
import { ensureAccountColumn } from '../people/tables';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  identity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_locations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device TEXT NOT NULL,
  path TEXT NOT NULL,
  via TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  head TEXT,
  PRIMARY KEY (project_id, device, path)
);
CREATE INDEX IF NOT EXISTS project_locations_device ON project_locations(device, path);
CREATE TABLE IF NOT EXISTS path_prefixes (
  id TEXT PRIMARY KEY,
  from_device TEXT NOT NULL,
  from_prefix TEXT NOT NULL,
  to_device TEXT NOT NULL,
  to_prefix TEXT NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS path_prefixes_pair ON path_prefixes(from_device, to_device);
CREATE TABLE IF NOT EXISTS session_locations (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_seq INTEGER NOT NULL,
  device TEXT NOT NULL,
  root TEXT NOT NULL,
  level TEXT,
  via TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  freshness TEXT,
  line TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (session_id, from_seq)
);
CREATE TABLE IF NOT EXISTS location_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  device TEXT NOT NULL,
  root TEXT NOT NULL,
  branch TEXT,
  head TEXT,
  dirty INTEGER,
  at INTEGER NOT NULL
);
`;

type Row = Record<string, any>;

export interface ProjectRow {
  id: string;
  /** Whose project (docs/design/ACCOUNTS.md). */
  accountId?: string;
  name: string;
  identity: StoredIdentity;
  createdAt: number;
  updatedAt: number;
}

export interface SessionLocationRow {
  sessionId: string;
  fromSeq: number;
  device: string;
  root: string;
  level?: MatchLevel;
  via?: LocationVia | 'none';
  approved: boolean;
  freshness?: Freshness;
  /** How the folder compared with the old copy, in one line. */
  line?: string;
  at: number;
}

export interface LocationStateRow {
  sessionId: string;
  device: string;
  root: string;
  branch?: string;
  head?: string;
  dirty?: number;
  at: number;
}

/** Drop trailing slashes (but keep "/"). */
export function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
}

/**
 * The shared prefixes of a confirmed pair: strip the path segments both end
 * with. /home/kai/code/portfolio and /Users/kai/Developer/portfolio teach
 * /home/kai/code and /Users/kai/Developer.
 */
export function prefixesOf(from: string, to: string): { from: string; to: string } | undefined {
  const a = trimSlash(from).split('/');
  const b = trimSlash(to).split('/');
  let i = a.length - 1;
  let j = b.length - 1;
  while (i > 0 && j > 0 && a[i] === b[j]) {
    i--;
    j--;
  }
  const fp = a.slice(0, i + 1).join('/') || '/';
  const tp = b.slice(0, j + 1).join('/') || '/';
  if (fp === tp || fp === '/' || tp === '/' || fp === '' || tp === '') return undefined;
  return { from: fp, to: tp };
}

function under(path: string, prefix: string): string | undefined {
  const p = trimSlash(path);
  const pre = trimSlash(prefix);
  if (p === pre) return '';
  if (p.startsWith(pre + '/')) return p.slice(pre.length);
  return undefined;
}

export class ProjectStore {
  constructor(readonly db: Db) {
    db.exec(SCHEMA);
    // a project is one account's (docs/design/ACCOUNTS.md): its folders are on that account's devices
    ensureAccountColumn(db, 'projects');
    // tables made by an earlier build of this module
    const cols = new Set((db.query('PRAGMA table_info(session_locations)').all() as Row[]).map((r) => r.name));
    if (!cols.has('line')) db.exec('ALTER TABLE session_locations ADD COLUMN line TEXT');
  }

  // ----- projects -------------------------------------------------------------

  private toProject(r: Row): ProjectRow {
    const identity = json<StoredIdentity>(r.identity, { gitRoots: [], remotes: [], shallow: false });
    // rows written before remotes were cleaned may hold a token in the clone URL
    if (identity.cloneUrl) identity.cloneUrl = cleanRemote(identity.cloneUrl);
    return { id: r.id, accountId: r.account_id ?? OWNER_ID, name: r.name, identity, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  /** One account's projects (the owner's when left out). */
  list(accountId: string = OWNER_ID): ProjectRow[] {
    return (this.db.query('SELECT * FROM projects WHERE account_id = ? ORDER BY updated_at DESC').all(accountId) as Row[]).map((r) => this.toProject(r));
  }

  get(id: string): ProjectRow | undefined {
    const r = this.db.query('SELECT * FROM projects WHERE id = ?').get(id) as Row | null;
    return r ? this.toProject(r) : undefined;
  }

  create(name: string, identity: StoredIdentity, accountId: string = OWNER_ID): ProjectRow {
    const now = Date.now();
    const p: ProjectRow = { id: newId('prj'), accountId, name, identity, createdAt: now, updatedAt: now };
    this.db.query('INSERT INTO projects (id, name, identity, created_at, updated_at, account_id) VALUES (?,?,?,?,?,?)').run(p.id, p.name, JSON.stringify(identity), now, now, accountId);
    return p;
  }

  /** Merge what a new probe learned (more roots after a merge, a new remote, the Syncthing folder). */
  updateIdentity(id: string, identity: StoredIdentity): ProjectRow | undefined {
    const p = this.get(id);
    if (!p) return undefined;
    // a shallow copy's root is its shallow boundary: the full root set, once known, stays
    const keepFull = identity.shallow && !p.identity.shallow && p.identity.gitRoots.length > 0;
    const merged: StoredIdentity = {
      ...p.identity,
      ...identity,
      gitRoots: keepFull ? p.identity.gitRoots : identity.gitRoots.length ? identity.gitRoots : p.identity.gitRoots,
      shallow: keepFull ? false : identity.shallow,
      remotes: [...new Set([...p.identity.remotes, ...identity.remotes])].sort(),
      syncthing: identity.syncthing ?? p.identity.syncthing,
      marker: identity.marker ?? p.identity.marker,
      cloneUrl: identity.cloneUrl ?? p.identity.cloneUrl,
      head: identity.head ?? p.identity.head,
    };
    const now = Date.now();
    this.db.query('UPDATE projects SET identity = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), now, id);
    return { ...p, identity: merged, updatedAt: now };
  }

  delete(id: string): void {
    this.db.query('DELETE FROM projects WHERE id = ?').run(id);
  }

  // ----- locations ------------------------------------------------------------

  private toLocation(r: Row): ProjectLocationDto {
    return {
      projectId: r.project_id,
      device: r.device,
      path: r.path,
      via: r.via,
      pinned: !!r.pinned,
      ...(r.verified_at ? { verifiedAt: r.verified_at } : {}),
      ...(r.head ? { head: r.head } : {}),
    };
  }

  locations(projectId: string): ProjectLocationDto[] {
    return (this.db.query('SELECT * FROM project_locations WHERE project_id = ? ORDER BY pinned DESC, verified_at DESC').all(projectId) as Row[]).map((r) => this.toLocation(r));
  }

  locationsOnDevice(device: string): ProjectLocationDto[] {
    return (this.db.query('SELECT * FROM project_locations WHERE device = ? ORDER BY path').all(device) as Row[]).map((r) => this.toLocation(r));
  }

  /** The project with a location at this exact device and path. */
  projectAt(device: string, path: string): ProjectRow | undefined {
    const r = this.db.query('SELECT project_id FROM project_locations WHERE device = ? AND path = ? ORDER BY pinned DESC, verified_at DESC LIMIT 1').get(device, trimSlash(path)) as Row | null;
    return r ? this.get(r.project_id) : undefined;
  }

  saveLocation(projectId: string, loc: { device: string; path: string; via: LocationVia; pinned?: boolean; head?: string }): void {
    const path = trimSlash(loc.path);
    const now = Date.now();
    // keep a pin once set; a later automatic confirmation does not unpin
    this.db
      .query(
        `INSERT INTO project_locations (project_id, device, path, via, pinned, verified_at, head) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(project_id, device, path) DO UPDATE SET via = CASE WHEN project_locations.pinned = 1 AND excluded.pinned = 0 THEN project_locations.via ELSE excluded.via END,
           pinned = MAX(project_locations.pinned, excluded.pinned), verified_at = excluded.verified_at, head = COALESCE(excluded.head, project_locations.head)`,
      )
      .run(projectId, loc.device, path, loc.via, loc.pinned ? 1 : 0, now, loc.head ?? null);
    this.db.query('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
  }

  removeLocation(projectId: string, device: string, path: string): boolean {
    const res = this.db.query('DELETE FROM project_locations WHERE project_id = ? AND device = ? AND path = ?').run(projectId, device, trimSlash(path));
    return res.changes > 0;
  }

  // ----- path prefixes --------------------------------------------------------

  private toPrefix(r: Row): PathPrefixDto {
    return { id: r.id, fromDevice: r.from_device, fromPrefix: r.from_prefix, toDevice: r.to_device, toPrefix: r.to_prefix, confirmations: r.confirmations, createdAt: r.created_at };
  }

  prefixes(device?: string): PathPrefixDto[] {
    const rows = device
      ? (this.db.query('SELECT * FROM path_prefixes WHERE from_device = ? OR to_device = ? ORDER BY confirmations DESC, created_at DESC').all(device, device) as Row[])
      : (this.db.query('SELECT * FROM path_prefixes ORDER BY confirmations DESC, created_at DESC').all() as Row[]);
    return rows.map((r) => this.toPrefix(r));
  }

  /** Learn a prefix pair from one confirmed folder pair (both ways). Returns the row, or undefined when nothing generalizes. */
  learnPrefix(fromDevice: string, fromPath: string, toDevice: string, toPath: string): PathPrefixDto | undefined {
    if (fromDevice === toDevice) return undefined;
    const pre = prefixesOf(fromPath, toPath) ?? { from: trimSlash(fromPath), to: trimSlash(toPath) };
    if (pre.from === pre.to) return undefined;
    const same = this.db
      .query('SELECT * FROM path_prefixes WHERE (from_device = ? AND from_prefix = ? AND to_device = ? AND to_prefix = ?) OR (from_device = ? AND from_prefix = ? AND to_device = ? AND to_prefix = ?)')
      .get(fromDevice, pre.from, toDevice, pre.to, toDevice, pre.to, fromDevice, pre.from) as Row | null;
    if (same) {
      this.db.query('UPDATE path_prefixes SET confirmations = confirmations + 1 WHERE id = ?').run(same.id);
      return this.toPrefix({ ...same, confirmations: same.confirmations + 1 });
    }
    const row: PathPrefixDto = { id: newId('pfx'), fromDevice, fromPrefix: pre.from, toDevice, toPrefix: pre.to, confirmations: 1, createdAt: Date.now() };
    this.db.query('INSERT INTO path_prefixes (id, from_device, from_prefix, to_device, to_prefix, confirmations, created_at) VALUES (?,?,?,?,?,?,?)').run(row.id, fromDevice, pre.from, toDevice, pre.to, 1, row.createdAt);
    return row;
  }

  deletePrefix(id: string): boolean {
    return this.db.query('DELETE FROM path_prefixes WHERE id = ?').run(id).changes > 0;
  }

  /** Where a path on one device maps to on another through learned prefixes, longest and most confirmed first. */
  mapByPrefix(fromDevice: string, path: string, toDevice: string): Array<{ path: string; prefix: PathPrefixDto }> {
    const out: Array<{ path: string; prefix: PathPrefixDto; len: number }> = [];
    for (const p of this.prefixes()) {
      if (p.fromDevice === fromDevice && p.toDevice === toDevice) {
        const rest = under(path, p.fromPrefix);
        if (rest !== undefined) out.push({ path: trimSlash(p.toPrefix + rest), prefix: p, len: p.fromPrefix.length });
      } else if (p.fromDevice === toDevice && p.toDevice === fromDevice) {
        const rest = under(path, p.toPrefix);
        if (rest !== undefined) out.push({ path: trimSlash(p.fromPrefix + rest), prefix: p, len: p.toPrefix.length });
      }
    }
    out.sort((a, b) => b.len - a.len || b.prefix.confirmations - a.prefix.confirmations);
    const seen = new Set<string>();
    return out.filter((o) => !seen.has(o.path) && seen.add(o.path)).map(({ path: p, prefix }) => ({ path: p, prefix }));
  }

  // ----- session locations (one row per move) ---------------------------------

  private toSessionLocation(r: Row): SessionLocationRow {
    return {
      sessionId: r.session_id,
      fromSeq: r.from_seq,
      device: r.device,
      root: r.root,
      ...(r.level ? { level: r.level } : {}),
      ...(r.via ? { via: r.via } : {}),
      approved: !!r.approved,
      ...(r.freshness ? { freshness: json<Freshness | undefined>(r.freshness, undefined) } : {}),
      ...(r.line ? { line: r.line } : {}),
      at: r.at,
    };
  }

  moves(sessionId: string): SessionLocationRow[] {
    return (this.db.query('SELECT * FROM session_locations WHERE session_id = ? ORDER BY from_seq').all(sessionId) as Row[]).map((r) => this.toSessionLocation(r));
  }

  currentMove(sessionId: string): SessionLocationRow | undefined {
    const r = this.db.query('SELECT * FROM session_locations WHERE session_id = ? ORDER BY from_seq DESC LIMIT 1').get(sessionId) as Row | null;
    return r ? this.toSessionLocation(r) : undefined;
  }

  addMove(row: Omit<SessionLocationRow, 'at'> & { at?: number }): void {
    this.db
      .query(
        `INSERT INTO session_locations (session_id, from_seq, device, root, level, via, approved, freshness, line, at) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, from_seq) DO UPDATE SET device = excluded.device, root = excluded.root, level = excluded.level, via = excluded.via,
           approved = excluded.approved, freshness = excluded.freshness, line = excluded.line, at = excluded.at`,
      )
      .run(
        row.sessionId,
        row.fromSeq,
        row.device,
        trimSlash(row.root),
        row.level ?? null,
        row.via ?? null,
        row.approved ? 1 : 0,
        row.freshness ? JSON.stringify(row.freshness) : null,
        row.line ?? null,
        row.at ?? Date.now(),
      );
  }

  approveMove(sessionId: string, fromSeq: number): void {
    this.db.query('UPDATE session_locations SET approved = 1 WHERE session_id = ? AND from_seq = ?').run(sessionId, fromSeq);
  }

  // ----- location state (end of each turn) ------------------------------------

  saveState(s: LocationStateRow): void {
    this.db
      .query(
        `INSERT INTO location_state (session_id, device, root, branch, head, dirty, at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET device = excluded.device, root = excluded.root, branch = excluded.branch, head = excluded.head, dirty = excluded.dirty, at = excluded.at`,
      )
      .run(s.sessionId, s.device, trimSlash(s.root), s.branch ?? null, s.head ?? null, s.dirty ?? null, s.at);
  }

  state(sessionId: string): LocationStateRow | undefined {
    const r = this.db.query('SELECT * FROM location_state WHERE session_id = ?').get(sessionId) as Row | null;
    if (!r) return undefined;
    return { sessionId: r.session_id, device: r.device, root: r.root, ...(r.branch ? { branch: r.branch } : {}), ...(r.head ? { head: r.head } : {}), ...(r.dirty !== null ? { dirty: r.dirty } : {}), at: r.at };
  }
}
