/**
 * mem0 (github.com/mem0ai/mem0). Two backends with different routes:
 *
 * Platform (api.mem0.ai), header "Authorization: Token <key>":
 *   GET  /v1/ping/                                        check the key
 *   POST /v3/memories/search/  {query, filters:{user_id}, top_k}
 *   POST /v3/memories/add/     {messages:[{role,content}], user_id, metadata, infer}
 *   POST /v3/memories/?page=N&page_size=M  {filters:{user_id}}   list
 *
 * Self-hosted server (mem0/server, the successor of OpenMemory; docker
 * compose maps it to port 8888), header "X-API-Key: <key>":
 *   POST /search    {query, filters:{user_id}, top_k}
 *   POST /memories  {messages, user_id, metadata, infer}
 *   GET  /memories?user_id=...&top_k=N
 *
 * Options: variant ("platform" | "self-hosted", default by url), url,
 * apiKey, userId (default "conclave"), agentId, infer (default false: Conclave
 * already extracted the fact, so mem0 stores it as given).
 */
import { type ExternalMemoryHit, type ExternalNote } from '../external';
import type { AdapterDeps, ConnectionTestResult, MemoryAdapter, PulledNote, ResolvedConnection } from './types';
import { findRows, httpJson, optBool, optRecord, optStr, rowToHit, TestRun, trimBase } from './util';

export const MEM0_PLATFORM_URL = 'https://api.mem0.ai';

export class Mem0Adapter implements MemoryAdapter {
  readonly type = 'mem0' as const;
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

  get base(): string {
    const url = optStr(this.o, 'url');
    return trimBase(url ? this.deps.config.expand(url) : MEM0_PLATFORM_URL);
  }

  get variant(): 'platform' | 'self-hosted' {
    const v = optStr(this.o, 'variant');
    if (v === 'platform' || v === 'self-hosted') return v;
    try {
      return /(^|\.)mem0\.ai$/i.test(new URL(this.base).hostname) ? 'platform' : 'self-hosted';
    } catch {
      return 'self-hosted';
    }
  }

  private get userId(): string {
    return optStr(this.o, 'userId') ?? 'conclave';
  }

  private headers(): Record<string, string> {
    const key = optStr(this.o, 'apiKey') ? this.deps.config.expand(optStr(this.o, 'apiKey')!) : '';
    const extra = this.deps.config.expandRecord(optRecord(this.o, 'headers')) ?? {};
    if (!key) return extra;
    return this.variant === 'platform' ? { Authorization: `Token ${key}`, ...extra } : { 'X-API-Key': key, ...extra };
  }

  private filters(): Record<string, string> {
    const f: Record<string, string> = { user_id: this.userId };
    const agent = optStr(this.o, 'agentId');
    if (agent) f.agent_id = agent;
    return f;
  }

  private req(path: string, body: unknown, method?: string, timeoutMs = this.conn.timeoutMs): Promise<unknown> {
    return httpJson(this.base + path, { method, body, headers: this.headers(), timeoutMs: Math.max(timeoutMs, 1000), fetch: this.deps.fetch });
  }

  private toHits(data: unknown): ExternalMemoryHit[] {
    return (findRows(data) ?? []).map((r, i) => rowToHit(r, i)).filter((h): h is ExternalMemoryHit => !!h);
  }

  async search(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    const body = { query: q, filters: this.filters(), top_k: limit };
    const data = await this.req(this.variant === 'platform' ? '/v3/memories/search/' : '/search', body);
    return this.toHits(data).slice(0, limit);
  }

  async write(note: ExternalNote): Promise<void> {
    const text = (note.text ?? note.content).trim();
    const agent = optStr(this.o, 'agentId');
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: text }],
      user_id: this.userId,
      ...(agent ? { agent_id: agent } : {}),
      metadata: { source: 'conclave', kind: note.kind ?? 'fact', tags: note.tags ?? [], title: note.title },
      infer: optBool(this.o, 'infer') ?? false,
    };
    await this.req(this.variant === 'platform' ? '/v3/memories/add/' : '/memories', body, 'POST', 30_000);
  }

  async pullAll({ max }: { max: number }): Promise<PulledNote[]> {
    const out: PulledNote[] = [];
    if (this.variant === 'platform') {
      for (let page = 1; out.length < max && page <= 50; page++) {
        const data = (await this.req(`/v3/memories/?page=${page}&page_size=100`, { filters: this.filters() }, 'POST', 30_000)) as { next?: unknown };
        const hits = this.toHits(data);
        out.push(...hits.map((h) => ({ id: h.id, content: h.content })));
        if (!hits.length || !data || typeof data !== 'object' || !('next' in data) || !data.next) break;
      }
    } else {
      const qs = new URLSearchParams({ user_id: this.userId, top_k: String(Math.min(max, 1000)) });
      const agent = optStr(this.o, 'agentId');
      if (agent) qs.set('agent_id', agent);
      const data = await this.req(`/memories?${qs}`, undefined, 'GET', 30_000);
      out.push(...this.toHits(data).map((h) => ({ id: h.id, content: h.content })));
    }
    return out.slice(0, max);
  }

  async test(): Promise<ConnectionTestResult> {
    const run = new TestRun({ url: this.base });
    if (this.variant === 'platform') {
      if (!optStr(this.o, 'apiKey')) {
        run.fail('config', 'The mem0 platform needs an API key.', 'Create one at app.mem0.ai and paste it into apiKey.');
        return run.result();
      }
      await run.step('ping', () => this.req('/v1/ping/', undefined, 'GET'), (r) => {
        const d = r as { status?: string } | undefined;
        return d?.status ? `status ${d.status}` : undefined;
      });
    }
    run.note('backend', `${this.variant} at ${this.base}, user_id ${this.userId}`);
    const hits = await run.step('search', () => this.search('conclave connection test', 3), (h) => `${h.length} result(s)`);
    if (hits) run.hits = hits.length;
    return run.result();
  }
}
