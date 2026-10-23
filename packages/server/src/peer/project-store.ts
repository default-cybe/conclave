/**
 * Storage for shared projects (docs/design/FRIENDS.md, "Shared projects as
 * built"), next to the friends tables (store.ts) and made the same way.
 *
 *   shared_projects          one row per project this hub owns or is in
 *   shared_project_members   the members as the owner's hub lists them, with
 *                            the key each one signs items with
 *   shared_project_items     the newest version of each item, signed by its author
 *   shared_project_versions  the last HISTORY_KEEP versions of each item: edits keep history
 *
 * Every hub keeps its own copy. An item's body is exactly what its author
 * signed, so a hub can pass it on and the next one checks it again.
 */
import type { Db } from '@conclave/core/storage/db.ts';
import type { SharedItemKind, SharedMemberState, SharedProjectRole, SharedProjectState } from '@conclave/core/client/shared-projects.ts';
import type { ShareSummary } from '@conclave/core/client/friends.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_projects (
  id TEXT PRIMARY KEY,
  owner_fp TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  repo TEXT,
  state TEXT NOT NULL,
  meta_seq INTEGER NOT NULL DEFAULT 0,
  local_project_id TEXT,
  share_new INTEGER NOT NULL DEFAULT 0,
  share_new_since INTEGER,
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shared_project_members (
  project_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  public_key TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  github TEXT,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS shared_project_items (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  source TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS shared_project_items_received ON shared_project_items(project_id, received_at);
CREATE TABLE IF NOT EXISTS shared_project_versions (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, id, version)
);
`;

type Row = Record<string, any>;

/**
 * Versions of an item a hub keeps: the newest and the 49 before it
 * (FRIENDS.md, "Shared projects as built"). An older one goes when a newer
 * one is kept, and is never sent on.
 */
export const HISTORY_KEEP = 50;

/** An item as its author signed it: what goes between hubs. */
export interface WireItem {
  v: 1;
  /** The project's id. */
  project: string;
  /** A ULID the author's hub made. */
  id: string;
  /** The author's hub fingerprint. */
  author: string;
  kind: SharedItemKind;
  version: number;
  createdAt: number;
  updatedAt: number;
  deleted?: true;
  title?: string;
  text: string;
  chat?: { shareId: string; kind: 'chat' | 'session'; summary: ShareSummary };
  /** The author's hub key over the canonical JSON of the rest. */
  sig: string;
}

export interface ProjectRow {
  id: string;
  ownerFp: string;
  name: string;
  description?: string;
  repo?: string;
  state: SharedProjectState;
  metaSeq: number;
  localProjectId?: string;
  shareNew: boolean;
  shareNewSince?: number;
  readAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemberRow {
  projectId: string;
  fingerprint: string;
  publicKey: string;
  name: string;
  role: SharedProjectRole;
  state: SharedMemberState;
  github?: string;
  addedAt: number;
  updatedAt: number;
}

export interface ItemRow {
  projectId: string;
  id: string;
  author: string;
  kind: SharedItemKind;
  version: number;
  item: WireItem;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  receivedAt: number;
  /** Where it came from on this hub (a memory or session id). Never sent. */
  source?: string;
}

function parse<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const toProject = (r: Row): ProjectRow => ({
  id: r.id,
  ownerFp: r.owner_fp,
  name: r.name,
  ...(r.description ? { description: r.description } : {}),
  ...(r.repo ? { repo: r.repo } : {}),
  state: r.state,
  metaSeq: r.meta_seq,
  ...(r.local_project_id ? { localProjectId: r.local_project_id } : {}),
  shareNew: !!r.share_new,
  ...(r.share_new_since ? { shareNewSince: r.share_new_since } : {}),
  ...(r.read_at ? { readAt: r.read_at } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMember = (r: Row): MemberRow => ({
  projectId: r.project_id,
  fingerprint: r.fingerprint,
  publicKey: r.public_key,
  name: r.name,
  role: r.role === 'owner' ? 'owner' : 'member',
  state: r.state,
  ...(r.github ? { github: r.github } : {}),
  addedAt: r.added_at,
  updatedAt: r.updated_at,
});

const toItem = (r: Row): ItemRow => ({
  projectId: r.project_id,
  id: r.id,
  author: r.author,
  kind: r.kind,
  version: r.version,
  item: parse<WireItem>(r.body, { v: 1, project: r.project_id, id: r.id, author: r.author, kind: r.kind, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, text: '', sig: '' }),
  deleted: !!r.deleted,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  receivedAt: r.received_at,
  ...(r.source ? { source: r.source } : {}),
});

export class ProjectShareStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
    // a hub from before the history was bounded: what is past it goes now, not at the item's next edit
    db.query(
      `DELETE FROM shared_project_versions WHERE version <= (SELECT i.version FROM shared_project_items i WHERE i.project_id = shared_project_versions.project_id AND i.id = shared_project_versions.id) - ?`,
    ).run(HISTORY_KEEP);
  }

  // ----- projects -----

  insert(p: Omit<ProjectRow, 'createdAt' | 'updatedAt'>): ProjectRow {
    const at = this.now();
    this.db
      .query('INSERT INTO shared_projects (id, owner_fp, name, description, repo, state, meta_seq, local_project_id, share_new, share_new_since, read_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(p.id, p.ownerFp, p.name, p.description ?? null, p.repo ?? null, p.state, p.metaSeq, p.localProjectId ?? null, p.shareNew ? 1 : 0, p.shareNewSince ?? null, p.readAt ?? null, at, at);
    return this.get(p.id)!;
  }

  get(id: string): ProjectRow | undefined {
    const r = this.db.query('SELECT * FROM shared_projects WHERE id = ?').get(id) as Row | null;
    return r ? toProject(r) : undefined;
  }

  list(): ProjectRow[] {
    return (this.db.query('SELECT * FROM shared_projects ORDER BY updated_at DESC, id DESC').all() as Row[]).map(toProject);
  }

  /** Change some fields. Undefined leaves a field; null clears it. */
  update(id: string, patch: { [K in keyof ProjectRow]?: ProjectRow[K] | null }): ProjectRow | undefined {
    const cols: Record<string, string> = {
      name: 'name',
      description: 'description',
      repo: 'repo',
      state: 'state',
      metaSeq: 'meta_seq',
      localProjectId: 'local_project_id',
      shareNew: 'share_new',
      shareNewSince: 'share_new_since',
      readAt: 'read_at',
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!cols[k] || v === undefined) continue;
      sets.push(`${cols[k]} = ?`);
      values.push(v === null ? null : k === 'shareNew' ? (v ? 1 : 0) : (v as string | number));
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      values.push(this.now());
      this.db.query(`UPDATE shared_projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.get(id);
  }

  /** Something in the project changed (an item): lists put it first. */
  touch(id: string): void {
    this.db.query('UPDATE shared_projects SET updated_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** The project leaves this hub: its members, items and history. */
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM shared_project_versions WHERE project_id = ?').run(id);
      this.db.query('DELETE FROM shared_project_items WHERE project_id = ?').run(id);
      this.db.query('DELETE FROM shared_project_members WHERE project_id = ?').run(id);
      this.db.query('DELETE FROM shared_projects WHERE id = ?').run(id);
    })();
  }

  // ----- members -----

  members(projectId: string): MemberRow[] {
    return (this.db.query(`SELECT * FROM shared_project_members WHERE project_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, added_at, rowid`).all(projectId) as Row[]).map(toMember);
  }

  member(projectId: string, fingerprint: string): MemberRow | undefined {
    const r = this.db.query('SELECT * FROM shared_project_members WHERE project_id = ? AND fingerprint = ?').get(projectId, fingerprint) as Row | null;
    return r ? toMember(r) : undefined;
  }

  putMember(m: Omit<MemberRow, 'addedAt' | 'updatedAt'> & { addedAt?: number }): void {
    const at = this.now();
    this.db
      .query(
        `INSERT INTO shared_project_members (project_id, fingerprint, public_key, name, role, state, github, added_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_id, fingerprint) DO UPDATE SET public_key = excluded.public_key, name = excluded.name, role = excluded.role, state = excluded.state, github = excluded.github, updated_at = excluded.updated_at`,
      )
      .run(m.projectId, m.fingerprint, m.publicKey, m.name, m.role, m.state, m.github ?? null, m.addedAt ?? at, at);
  }

  /** The owner's list, as it sent it: rows it leaves out go. */
  replaceMembers(projectId: string, list: Array<Omit<MemberRow, 'projectId' | 'addedAt' | 'updatedAt'>>): void {
    this.db.transaction(() => {
      const keep = new Set(list.map((m) => m.fingerprint));
      for (const m of this.members(projectId)) if (!keep.has(m.fingerprint)) this.db.query('DELETE FROM shared_project_members WHERE project_id = ? AND fingerprint = ?').run(projectId, m.fingerprint);
      for (const m of list) this.putMember({ ...m, projectId });
    })();
  }

  /** Projects a hub is a member of (any state), for a friend who was removed or whose key changed. */
  projectsWith(fingerprint: string): string[] {
    return (this.db.query('SELECT project_id FROM shared_project_members WHERE fingerprint = ?').all(fingerprint) as Row[]).map((r) => r.project_id);
  }

  // ----- items -----

  item(projectId: string, id: string): ItemRow | undefined {
    const r = this.db.query('SELECT * FROM shared_project_items WHERE project_id = ? AND id = ?').get(projectId, id) as Row | null;
    return r ? toItem(r) : undefined;
  }

  items(projectId: string, opts: { deleted?: boolean } = {}): ItemRow[] {
    const where = opts.deleted ? '' : 'AND deleted = 0';
    return (this.db.query(`SELECT * FROM shared_project_items WHERE project_id = ? ${where} ORDER BY updated_at DESC, id DESC`).all(projectId) as Row[]).map(toItem);
  }

  /** Items from others that came after `since` (this hub's clock). */
  unread(projectId: string, mine: string, since: number): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM shared_project_items WHERE project_id = ? AND author != ? AND deleted = 0 AND received_at > ?').get(projectId, mine, since) as { n: number }).n;
  }

  /** This item by source on this hub (a memory or session shared already). */
  bySource(projectId: string, source: string): ItemRow | undefined {
    const r = this.db.query('SELECT * FROM shared_project_items WHERE project_id = ? AND source = ? AND deleted = 0').get(projectId, source) as Row | null;
    return r ? toItem(r) : undefined;
  }

  /**
   * Keep a version (the callers keep only one newer than the item's, or the
   * same one again): it goes in items, and in versions, which hold the last
   * HISTORY_KEEP. Versions at or below the newest minus HISTORY_KEEP go.
   */
  putItem(i: WireItem, source?: string): ItemRow {
    const at = this.now();
    const body = JSON.stringify(i);
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO shared_project_items (project_id, id, author, kind, version, body, deleted, created_at, updated_at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(project_id, id) DO UPDATE SET version = excluded.version, body = excluded.body, deleted = excluded.deleted, updated_at = excluded.updated_at, received_at = excluded.received_at, source = COALESCE(excluded.source, shared_project_items.source)`,
        )
        .run(i.project, i.id, i.author, i.kind, i.version, body, i.deleted ? 1 : 0, i.createdAt, i.updatedAt, at, source ?? null);
      this.db.query('INSERT OR REPLACE INTO shared_project_versions (project_id, id, version, body, received_at) VALUES (?,?,?,?,?)').run(i.project, i.id, i.version, body, at);
      this.db.query('DELETE FROM shared_project_versions WHERE project_id = ? AND id = ? AND version <= ?').run(i.project, i.id, i.version - HISTORY_KEEP);
      this.touch(i.project);
    })();
    return this.item(i.project, i.id)!;
  }

  versions(projectId: string, id: string): Array<{ item: WireItem; receivedAt: number }> {
    return (this.db.query('SELECT * FROM shared_project_versions WHERE project_id = ? AND id = ? ORDER BY version DESC').all(projectId, id) as Row[]).map((r) => ({
      item: parse<WireItem>(r.body, { v: 1, project: projectId, id, author: '', kind: 'note', version: r.version, createdAt: 0, updatedAt: 0, text: '', sig: '' }),
      receivedAt: r.received_at,
    }));
  }

  counts(projectId: string): { notes: number; memories: number; chats: number } {
    const rows = this.db.query('SELECT kind, COUNT(*) AS n FROM shared_project_items WHERE project_id = ? AND deleted = 0 GROUP BY kind').all(projectId) as Row[];
    const n = (k: string) => rows.find((r) => r.kind === k)?.n ?? 0;
    return { notes: n('note'), memories: n('memory'), chats: n('chat') };
  }
}
