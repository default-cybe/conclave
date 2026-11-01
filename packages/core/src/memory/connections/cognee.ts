/**
 * Cognee (github.com/topoteretes/cognee) REST API, default port 8000.
 *   GET  /health
 *   POST /api/v1/search    {query, search_type, datasets:[name], top_k}
 *   POST /api/v1/remember  multipart: data (file), datasetName, node_set, run_in_background
 *        (older servers: POST /api/v1/add, then POST /api/v1/cognify {datasets})
 * Auth: X-Api-Key header (options.apiKey) or a bearer token (options.token).
 * When the server runs with REQUIRE_AUTHENTICATION=false neither is needed.
 *
 * Options: url, apiKey, token, dataset (default "conclave"), searchType
 * (default CHUNKS: plain retrieval, no LLM call), nodeSet.
 * Cognee keeps a knowledge graph, not a list of notes, so there is no import.
 */
import { type ExternalMemoryHit, type ExternalNote } from '../external';
import type { AdapterDeps, ConnectionTestResult, MemoryAdapter, ResolvedConnection } from './types';
import { clip, httpJson, HttpStatusError, optStr, optStrArr, rowToHit, TestRun, trimBase } from './util';

export class CogneeAdapter implements MemoryAdapter {
  readonly type = 'cognee' as const;
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

  private get o() {
    return this.conn.options;
  }

  private get base(): string {
    const url = optStr(this.o, 'url');
    if (!url) throw new Error('options.url is required');
    return trimBase(this.deps.config.expand(url)).replace(/\/api(?:\/v1)?$/, '');
  }

  private get dataset(): string {
    return optStr(this.o, 'dataset') ?? 'conclave';
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    const key = optStr(this.o, 'apiKey');
    const token = optStr(this.o, 'token');
    if (key) h['X-Api-Key'] = this.deps.config.expand(key);
    if (token) h.Authorization = `Bearer ${this.deps.config.expand(token)}`;
    return h;
  }

  /** Flatten Cognee search output: [{search_result: [...]}, ...], a bare list of chunks, or strings. */
  static parseResults(data: unknown): ExternalMemoryHit[] {
    const out: ExternalMemoryHit[] = [];
    const push = (row: unknown) => {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        const r = row as Record<string, unknown>;
        if ('search_result' in r) {
          const inner = r.search_result;
          if (Array.isArray(inner)) inner.forEach(push);
          else push(inner);
          return;
        }
      }
      const hit = rowToHit(row, out.length, {});
      if (hit) out.push({ ...hit, content: clip(hit.content, 1200) });
    };
    if (Array.isArray(data)) data.forEach(push);
    else push(data);
    return out;
  }

  async search(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    const body = { query: q, search_type: optStr(this.o, 'searchType') ?? 'CHUNKS', datasets: [this.dataset], top_k: limit };
    try {
      const data = await httpJson(`${this.base}/api/v1/search`, { body, headers: this.headers(), timeoutMs: Math.max(this.conn.timeoutMs, 1000), fetch: this.deps.fetch });
      return CogneeAdapter.parseResults(data).slice(0, limit);
    } catch (err) {
      // a dataset nobody wrote to yet is not an error for recall
      if (err instanceof HttpStatusError && err.status === 404 && /dataset|not found|no data/i.test(err.body)) return [];
      throw err;
    }
  }

  private form(note: ExternalNote, withRemember: boolean): FormData {
    const f = new FormData();
    const text = `# ${note.title}\n\n${(note.text ?? note.content).trim()}\n`;
    const file = note.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'note';
    f.append('data', new Blob([text], { type: 'text/markdown' }), `${file}.md`);
    f.append('datasetName', this.dataset);
    for (const n of optStrArr(this.o, 'nodeSet') ?? []) f.append('node_set', n);
    if (withRemember) f.append('run_in_background', 'true');
    return f;
  }

  async write(note: ExternalNote): Promise<void> {
    const opts = { headers: this.headers(), timeoutMs: 30_000, fetch: this.deps.fetch };
    try {
      await httpJson(`${this.base}/api/v1/remember`, { ...opts, body: this.form(note, true) });
    } catch (err) {
      if (!(err instanceof HttpStatusError) || (err.status !== 404 && err.status !== 405)) throw err;
      // servers before /remember: add, then build the graph in the background
      await httpJson(`${this.base}/api/v1/add`, { ...opts, body: this.form(note, false) });
      await httpJson(`${this.base}/api/v1/cognify`, { ...opts, body: { datasets: [this.dataset], run_in_background: true } });
    }
  }

  async test(): Promise<ConnectionTestResult> {
    let base: string | undefined;
    try {
      base = this.base;
    } catch {
      /* below */
    }
    const run = new TestRun({ url: base });
    if (!base) {
      run.fail('config', 'options.url is required', 'Set the Cognee API URL, for example http://cognee:8000.');
      return run.result();
    }
    await run.step('health', () => httpJson(`${base}/health`, { headers: this.headers(), timeoutMs: Math.max(this.conn.timeoutMs, 5000), fetch: this.deps.fetch }), (r) => {
      const d = r as { status?: string } | undefined;
      return d && typeof d === 'object' && d.status ? `status ${d.status}` : undefined;
    });
    const hits = await run.step('search', () => this.search('conclave connection test', 3), (h) => `${h.length} result(s) in dataset ${this.dataset}`);
    if (hits) run.hits = hits.length;
    return run.result();
  }
}
