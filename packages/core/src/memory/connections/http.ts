/**
 * A plain REST memory service:
 *   POST {url}/search  {"query": "...", "limit": 5}  -> rows (results, memories, items or a bare array)
 *   POST {url}/add     {"title", "content", "tags", "folder"}
 *   GET  {url}{listPath}                             -> rows (optional, enables import)
 * Options: url, headers, searchPath, addPath, listPath.
 */
import { type ExternalMemoryHit, type ExternalNote } from '../external';
import type { AdapterDeps, ConnectionTestResult, MemoryAdapter, PulledNote, ResolvedConnection } from './types';
import { findRows, httpJson, optRecord, optStr, rowToHit, TestRun, trimBase } from './util';

export class HttpMemoryAdapter implements MemoryAdapter {
  readonly type = 'http' as const;
  readonly canWrite = true;
  readonly id: string;
  readonly name: string;
  private conn: ResolvedConnection;
  private deps: AdapterDeps;

  constructor(conn: ResolvedConnection, deps: AdapterDeps) {
    this.conn = conn;
    this.deps = deps;
    this.id = conn.id;
    this.name = conn.name;
  }

  private get base(): string {
    const url = optStr(this.conn.options, 'url');
    if (!url) throw new Error('options.url is required');
    return trimBase(this.deps.config.expand(url));
  }

  private get headers(): Record<string, string> {
    return this.deps.config.expandRecord(optRecord(this.conn.options, 'headers')) ?? {};
  }

  private path(key: string, fallback: string): string {
    const p = optStr(this.conn.options, key) ?? fallback;
    return p.startsWith('/') ? p : `/${p}`;
  }

  async search(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    const data = await httpJson(this.base + this.path('searchPath', '/search'), {
      body: { query: q, limit },
      headers: this.headers,
      timeoutMs: Math.max(this.conn.timeoutMs, 1000),
      fetch: this.deps.fetch,
    });
    const rows = findRows(data) ?? [];
    return rows
      .map((r, i) => rowToHit(r, i))
      .filter((h): h is ExternalMemoryHit => !!h)
      .slice(0, limit);
  }

  async write(note: ExternalNote): Promise<void> {
    await httpJson(this.base + this.path('addPath', '/add'), {
      body: { title: note.title, content: note.content, text: note.text, kind: note.kind, tags: note.tags ?? [], folder: note.folder },
      headers: this.headers,
      timeoutMs: 15_000,
      fetch: this.deps.fetch,
    });
  }

  get pullAll(): ((opts: { max: number }) => Promise<PulledNote[]>) | undefined {
    const listPath = optStr(this.conn.options, 'listPath');
    if (!listPath) return undefined;
    return async ({ max }) => {
      const data = await httpJson(this.base + this.path('listPath', listPath), { headers: this.headers, timeoutMs: 30_000, fetch: this.deps.fetch });
      return (findRows(data) ?? [])
        .map((r, i) => rowToHit(r, i))
        .filter((h): h is ExternalMemoryHit => !!h)
        .slice(0, max)
        .map((h) => ({ id: h.id, title: h.title, content: h.content, url: h.url }));
    };
  }

  async test(): Promise<ConnectionTestResult> {
    let url: string | undefined;
    try {
      url = this.base;
    } catch {
      /* reported below */
    }
    const run = new TestRun({ url });
    if (!url) {
      run.fail('config', 'options.url is required', 'Set the base URL of the memory service.');
      return run.result();
    }
    const hits = await run.step('search', () => this.search('conclave connection test', 3), (h) => `${h.length} result(s)`);
    if (hits) run.hits = hits.length;
    return run.result();
  }
}
