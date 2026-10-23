/**
 * SQLite access for the catalog: the HTTP cache (catalog_http), live and feed
 * items with full-text search (catalog_items, catalog_items_fts) and what
 * Discover installed (catalog_installs). Tables come from migration 3 in
 * storage/db.ts.
 */
import type { Db } from '../storage/db';
import { json } from '../storage/db';
import type { CatalogItem, CatalogKind, InstallSpec } from './recommended';

export interface HttpRow {
  url: string;
  etag?: string;
  lastModified?: string;
  status: number;
  body: string;
  fetchedAt: number;
}

/** What an install wrote, so update, rollback and remove touch only that. */
export interface InstallMeta {
  name: string;
  repo?: string;
  /** Spec that was installed, after placeholders were filled (secrets as ${secret:key}). */
  spec?: InstallSpec;
  /** Absolute paths Conclave wrote (files and folders). */
  paths?: string[];
  /** MCP server name. */
  server?: string;
  /** Secret keys the install wrote. */
  secrets?: string[];
  /** Plugin names installed. */
  plugins?: string[];
  /** Marketplace the plugins came from. */
  marketplace?: string;
  /** Marketplaces this install added, removed with it once nothing else uses them. */
  addedMarketplaces?: string[];
  /** Snapshot of a live item, so Installed can show it after the cache is gone. */
  item?: CatalogItem;
  /** Where the copy of the previous version lives, for rollback (older rows: "<dest>.prev"). */
  prevPaths?: string[];
  /** Earlier copies under ~/.conclave/catalog-prev and the place each one goes back to. */
  prevPairs?: Array<{ prev: string; dest: string }>;
  /** Hook recipes: where the handlers were added, so Remove finds them. */
  where?: { scope?: 'user' | 'project'; cwd?: string; target?: { cli: 'claude-code' | 'codex' | 'gemini'; device: string } };
  /** Hash of hooks, MCP config and scripts at install, so updates can say what changed. */
  sensitiveHash?: string;
}

export interface InstallRow {
  id: string;
  kind: CatalogKind;
  ref: string;
  source: string;
  sha?: string;
  version?: string;
  filesHash?: string;
  installedAt: number;
  updatedAt: number;
  previous?: { sha?: string; version?: string; at: number; meta?: InstallMeta };
  upstreamSha?: string;
  checkedAt?: number;
  meta: InstallMeta;
}

interface ItemRowRaw {
  id: string;
  kind: string;
  source: string;
  repo: string | null;
  json: string;
  stars: number | null;
  stars_at: string | null;
  updated_at: string | null;
  fetched_at: number;
}

interface InstallRowRaw {
  id: string;
  kind: string;
  ref: string;
  source: string;
  sha: string | null;
  version: string | null;
  files_hash: string | null;
  installed_at: number;
  updated_at: number;
  previous_json: string | null;
  upstream_sha: string | null;
  checked_at: number | null;
  meta: string | null;
}

/** Turn free text into an FTS5 query: each word a prefix term, all required. */
export function ftsQuery(text: string): string {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
}

export class CatalogStore {
  constructor(readonly db: Db) {}

  // ----- HTTP cache ------------------------------------------------------------

  httpGet(url: string): HttpRow | undefined {
    const r = this.db
      .query<{ url: string; etag: string | null; last_modified: string | null; status: number; body: string; fetched_at: number }, [string]>(
        'SELECT url, etag, last_modified, status, body, fetched_at FROM catalog_http WHERE url = ?',
      )
      .get(url);
    if (!r) return undefined;
    return { url: r.url, etag: r.etag ?? undefined, lastModified: r.last_modified ?? undefined, status: r.status, body: r.body, fetchedAt: r.fetched_at };
  }

  httpPut(row: HttpRow): void {
    this.db
      .query(
        `INSERT INTO catalog_http (url, etag, last_modified, status, body, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at`,
      )
      .run(row.url, row.etag ?? null, row.lastModified ?? null, row.status, row.body, row.fetchedAt);
  }

  httpTouch(url: string, at: number): void {
    this.db.query('UPDATE catalog_http SET fetched_at = ? WHERE url = ?').run(at, url);
  }

  cacheSize(): { rows: number; bytes: number } {
    const r = this.db.query<{ n: number; b: number | null }, []>('SELECT COUNT(*) AS n, SUM(LENGTH(body)) AS b FROM catalog_http').get();
    return { rows: r?.n ?? 0, bytes: r?.b ?? 0 };
  }

  // ----- items -----------------------------------------------------------------

  upsertItem(item: CatalogItem, fetchedAt: number): void {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO catalog_items (id, kind, source, repo, json, stars, stars_at, updated_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, source = excluded.source, repo = excluded.repo, json = excluded.json,
             stars = excluded.stars, stars_at = excluded.stars_at, updated_at = excluded.updated_at, fetched_at = excluded.fetched_at`,
        )
        .run(item.id, item.kind, item.source, item.repo?.toLowerCase() ?? null, JSON.stringify(item), item.stars ?? null, item.starsAt ?? null, item.updatedAt ?? null, fetchedAt);
      this.db.query('DELETE FROM catalog_items_fts WHERE item_id = ?').run(item.id);
      this.db
        .query('INSERT INTO catalog_items_fts (name, description, tags, item_id) VALUES (?, ?, ?, ?)')
        .run(`${item.name} ${item.repo ?? ''}`, item.description, item.tags.join(' '), item.id);
    })();
  }

  upsertItems(items: CatalogItem[], fetchedAt: number): void {
    this.db.transaction(() => {
      for (const it of items) this.upsertItem(it, fetchedAt);
    })();
  }

  private toItem(r: ItemRowRaw): CatalogItem & { fetchedAt: number } {
    const it = json<CatalogItem>(r.json, undefined as unknown as CatalogItem);
    return { ...it, stars: r.stars ?? it.stars, starsAt: r.stars_at ?? it.starsAt, fetchedAt: r.fetched_at };
  }

  getItem(id: string): (CatalogItem & { fetchedAt: number }) | undefined {
    const r = this.db.query<ItemRowRaw, [string]>('SELECT * FROM catalog_items WHERE id = ?').get(id);
    return r ? this.toItem(r) : undefined;
  }

  itemsByRepo(repo: string): Array<CatalogItem & { fetchedAt: number }> {
    return this.db.query<ItemRowRaw, [string]>('SELECT * FROM catalog_items WHERE repo = ?').all(repo.toLowerCase()).map((r) => this.toItem(r));
  }

  listItems(q: { kind?: CatalogKind; sources?: string[]; limit?: number } = {}): Array<CatalogItem & { fetchedAt: number }> {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.kind) {
      where.push('kind = ?');
      args.push(q.kind);
    }
    if (q.sources?.length) {
      where.push(`source IN (${q.sources.map(() => '?').join(', ')})`);
      args.push(...q.sources);
    }
    const sql = `SELECT * FROM catalog_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY stars DESC NULLS LAST LIMIT ?`;
    args.push(q.limit ?? 5000);
    return this.db.query<ItemRowRaw, Array<string | number>>(sql).all(...args).map((r) => this.toItem(r));
  }

  searchItems(text: string, q: { kind?: CatalogKind; limit?: number } = {}): Array<CatalogItem & { fetchedAt: number }> {
    const match = ftsQuery(text);
    if (!match) return [];
    const args: Array<string | number> = [match];
    let sql = `SELECT i.* FROM catalog_items_fts f JOIN catalog_items i ON i.id = f.item_id WHERE catalog_items_fts MATCH ?`;
    if (q.kind) {
      sql += ' AND i.kind = ?';
      args.push(q.kind);
    }
    sql += ' ORDER BY bm25(catalog_items_fts), i.stars DESC LIMIT ?';
    args.push(q.limit ?? 200);
    try {
      return this.db.query<ItemRowRaw, Array<string | number>>(sql).all(...args).map((r) => this.toItem(r));
    } catch {
      return [];
    }
  }

  /** Update stars (and optional fields) of every cached row for a repo. */
  setRepoStats(repo: string, stats: { stars: number; at: string; updatedAt?: string; archived?: boolean; license?: string; description?: string }): number {
    const rows = this.itemsByRepo(repo);
    for (const r of rows) {
      const { fetchedAt: _f, ...it } = r;
      const next: CatalogItem = {
        ...it,
        stars: stats.stars,
        starsAt: stats.at,
        updatedAt: stats.updatedAt ?? it.updatedAt,
        archived: stats.archived ?? it.archived,
        license: it.license ?? stats.license,
        description: it.description || stats.description || '',
      };
      this.upsertItem(next, r.fetchedAt);
    }
    return rows.length;
  }

  countItems(): { total: number; bySource: Record<string, number> } {
    const rows = this.db.query<{ source: string; n: number }, []>('SELECT source, COUNT(*) AS n FROM catalog_items GROUP BY source').all();
    const bySource: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      bySource[r.source] = r.n;
      total += r.n;
    }
    return { total, bySource };
  }

  // ----- installs --------------------------------------------------------------

  private toInstall(r: InstallRowRaw): InstallRow {
    return {
      id: r.id,
      kind: r.kind as CatalogKind,
      ref: r.ref,
      source: r.source,
      sha: r.sha ?? undefined,
      version: r.version ?? undefined,
      filesHash: r.files_hash ?? undefined,
      installedAt: r.installed_at,
      updatedAt: r.updated_at,
      previous: json(r.previous_json, undefined),
      upstreamSha: r.upstream_sha ?? undefined,
      checkedAt: r.checked_at ?? undefined,
      meta: json<InstallMeta>(r.meta, { name: r.ref }),
    };
  }

  getInstall(id: string): InstallRow | undefined {
    const r = this.db.query<InstallRowRaw, [string]>('SELECT * FROM catalog_installs WHERE id = ?').get(id);
    return r ? this.toInstall(r) : undefined;
  }

  listInstalls(): InstallRow[] {
    return this.db.query<InstallRowRaw, []>('SELECT * FROM catalog_installs ORDER BY installed_at DESC').all().map((r) => this.toInstall(r));
  }

  putInstall(row: InstallRow): void {
    this.db
      .query(
        `INSERT INTO catalog_installs (id, kind, ref, source, sha, version, files_hash, installed_at, updated_at, previous_json, upstream_sha, checked_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, ref = excluded.ref, source = excluded.source, sha = excluded.sha, version = excluded.version,
           files_hash = excluded.files_hash, installed_at = excluded.installed_at, updated_at = excluded.updated_at, previous_json = excluded.previous_json,
           upstream_sha = excluded.upstream_sha, checked_at = excluded.checked_at, meta = excluded.meta`,
      )
      .run(
        row.id,
        row.kind,
        row.ref,
        row.source,
        row.sha ?? null,
        row.version ?? null,
        row.filesHash ?? null,
        row.installedAt,
        row.updatedAt,
        row.previous ? JSON.stringify(row.previous) : null,
        row.upstreamSha ?? null,
        row.checkedAt ?? null,
        JSON.stringify(row.meta),
      );
  }

  deleteInstall(id: string): boolean {
    return this.db.query('DELETE FROM catalog_installs WHERE id = ?').run(id).changes > 0;
  }
}
