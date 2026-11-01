/**
 * All memory connections behind one ExternalMemory, so SqliteMemory treats
 * them as a single external store:
 *
 * - search: every enabled connection with search on, in parallel, each with
 *   its own timeout. A failing connection is skipped (and backs off) without
 *   hurting the others. Results are score-normalized per connection, merged
 *   and deduped.
 * - write: follows each connection's mode. mirror and external connections
 *   get the note; read connections never do.
 * - adapters are rebuilt when their config changes, so the API can add,
 *   edit and remove connections at run time.
 */
import type { ConfigStore } from '../../config';
import { logger } from '../../util/log';
import type { ExternalMemory, ExternalMemoryHit, ExternalNote } from '../external';
import { jaccard, termSet } from '../text';
import { createAdapter, listConfigured } from './registry';
import type { AdapterDeps, ConnectionStatus, ConnectionTestResult, MemoryAdapter, PulledNote, ResolvedConnection } from './types';
import { explainError, TimeoutError, withTimeout } from './util';
import type { NoteLayout } from './grouped';

/** A connection's note layout. Only Basic Memory has a grouped layout; the rest write one item per memory. */
export function layoutOf(conn: Pick<ResolvedConnection, 'type' | 'options'>): NoteLayout {
  return conn.type === 'basic-memory' && conn.options?.layout === 'grouped' ? 'grouped' : 'per-fact';
}

const log = logger('memory.connections');

/** Writes may be slow (Cognee builds a graph); they run in the background for mirror mode. */
export const WRITE_TIMEOUT_MS = 30_000;
/** After this many failures in a row, live search skips the connection for a while. */
const BACKOFF_AFTER = 2;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export interface MemoryConnectionsOptions extends Omit<AdapterDeps, 'config'> {
  config: ConfigStore;
  now?: () => number;
}

interface Slot {
  key: string;
  conn: ResolvedConnection;
  adapter: MemoryAdapter;
}

export class MemoryConnections implements ExternalMemory {
  readonly name = 'connections';
  private config: ConfigStore;
  private deps: AdapterDeps;
  private slots = new Map<string, Slot>();
  private status = new Map<string, Omit<ConnectionStatus, 'imported' | 'lastSync'>>();
  private now: () => number;

  constructor(opts: MemoryConnectionsOptions) {
    this.config = opts.config;
    this.deps = { config: opts.config, callTool: opts.callTool, listTools: opts.listTools, mcpClientFactory: opts.mcpClientFactory, fetch: opts.fetch };
    this.now = opts.now ?? Date.now;
  }

  /** Configured connections with defaults (legacy memory.external included). */
  list(): ResolvedConnection[] {
    return listConfigured(this.config.get().memory);
  }

  get(id: string): ResolvedConnection | undefined {
    return this.list().find((c) => c.id === id);
  }

  private active(): ResolvedConnection[] {
    return this.list().filter((c) => c.enabled);
  }

  /** Adapter for a configured connection, rebuilt when its config changed. */
  adapter(conn: ResolvedConnection): MemoryAdapter {
    const key = JSON.stringify(conn);
    const cur = this.slots.get(conn.id);
    if (cur && cur.key === key) return cur.adapter;
    if (cur) void cur.adapter.close?.().catch(() => {});
    const adapter = createAdapter(conn, this.deps);
    this.slots.set(conn.id, { key, conn, adapter });
    return adapter;
  }

  /** Close adapters whose connection is gone. Call after config edits. */
  async prune(): Promise<void> {
    const ids = new Set(this.list().map((c) => c.id));
    for (const [id, slot] of this.slots) {
      if (ids.has(id)) continue;
      this.slots.delete(id);
      this.status.delete(id);
      await slot.adapter.close?.().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  statusOf(id: string): Omit<ConnectionStatus, 'imported' | 'lastSync'> {
    const conn = this.get(id);
    const s = this.status.get(id);
    if (conn && !conn.enabled) return { ...(s ?? { failures: 0 }), state: 'disabled' };
    if (!s) return { state: 'unknown', failures: 0 };
    if (s.retryAt && s.retryAt > this.now()) return { ...s, state: 'backoff' };
    return s;
  }

  private ok(id: string, latencyMs?: number): void {
    const prev = this.status.get(id);
    if (prev?.state === 'error') log.info('memory connection works again', { connection: id, after: prev.failures });
    this.status.set(id, { state: 'ok', failures: 0, lastOkAt: this.now(), latencyMs: latencyMs ?? prev?.latencyMs, lastError: prev?.lastError, lastErrorAt: prev?.lastErrorAt });
  }

  private failed(id: string, err: unknown): void {
    const prev = this.status.get(id);
    const failures = (prev?.failures ?? 0) + 1;
    const message = explainError(err).error;
    const retryAt = failures >= BACKOFF_AFTER ? this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - BACKOFF_AFTER)) : undefined;
    this.status.set(id, { ...(prev ?? {}), state: 'error', failures, lastError: message, lastErrorAt: this.now(), retryAt });
    // the first failure, and each time it backs off, so a dead connection is one line, not one a search
    if (failures === 1 || (retryAt && failures >= BACKOFF_AFTER)) log.warn('memory connection failed', { connection: id, failures, error: message, ...(retryAt ? { retryInMs: retryAt - this.now() } : {}) });
  }

  // -------------------------------------------------------------------------
  // ExternalMemory
  // -------------------------------------------------------------------------

  /** The store waits this long for search(): the slowest per-connection timeout plus a margin. */
  get searchTimeoutMs(): number {
    const list = this.active().filter((c) => c.search);
    return Math.min(15_000, Math.max(500, ...list.map((c) => c.timeoutMs)) + 250);
  }

  writeMode(): 'mirror' | 'external' | undefined {
    const list = this.active();
    if (list.some((c) => c.mode === 'external')) return 'external';
    if (list.some((c) => c.mode === 'mirror')) return 'mirror';
    return undefined;
  }

  async search(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    const now = this.now();
    const targets = this.active().filter((c) => c.search && !((this.status.get(c.id)?.retryAt ?? 0) > now));
    if (!targets.length) return [];
    const results = await Promise.all(
      targets.map(async (conn) => {
        const t0 = performance.now();
        try {
          const hits = await withTimeout(this.adapter(conn).search(q, limit), conn.timeoutMs, `${conn.id} search`);
          this.ok(conn.id, Math.round(performance.now() - t0));
          return { conn, hits };
        } catch (err) {
          this.failed(conn.id, err);
          if (!(err instanceof TimeoutError)) log.warn(`memory connection ${conn.id} search failed: ${(err as Error).message}`);
          return { conn, hits: [] as ExternalMemoryHit[] };
        }
      }),
    );
    return mergeHits(results, limit);
  }

  /**
   * The owner's own notes on every connection that keeps them (Basic
   * Memory), without the folder Conclave writes: the same connections,
   * timeouts and backoff as search(). Throws when every one of them failed,
   * so the caller can tell "no note says it" from "nobody answered".
   */
  async searchOwnNotes(q: string, limit: number): Promise<ExternalMemoryHit[]> {
    const now = this.now();
    const targets = this.active().filter((c) => c.search && !((this.status.get(c.id)?.retryAt ?? 0) > now));
    const results = await Promise.all(
      targets.map(async (conn) => {
        let adapter: MemoryAdapter;
        try {
          adapter = this.adapter(conn);
        } catch {
          return undefined;
        }
        if (!adapter.searchOwnNotes) return undefined;
        const t0 = performance.now();
        try {
          const hits = await withTimeout(adapter.searchOwnNotes(q, limit), conn.timeoutMs, `${conn.id} search`);
          this.ok(conn.id, Math.round(performance.now() - t0));
          return { ok: true, hits: hits.map((h) => ({ ...h, source: h.source ?? conn.id })) };
        } catch (err) {
          this.failed(conn.id, err);
          return { ok: false, hits: [] as ExternalMemoryHit[], err };
        }
      }),
    );
    const asked = results.filter((r) => !!r);
    if (asked.length && !asked.some((r) => r.ok)) throw asked[0].err;
    return asked.flatMap((r) => r.hits);
  }

  /** Connections that take grouped notes: Basic Memory with options.layout "grouped" (connections/grouped.ts). */
  groupedTargets(): string[] {
    return this.active()
      .filter((c) => c.mode !== 'read' && layoutOf(c) === 'grouped')
      .map((c) => c.id);
  }

  /** Write a grouped note to the grouped connections only. Throws when every one of them failed. */
  async writeGrouped(note: ExternalNote): Promise<void> {
    const ids = new Set(this.groupedTargets());
    await this.writeTo(
      this.active().filter((c) => ids.has(c.id)),
      { ...note, grouped: true },
    );
  }

  /** Delete one note on one connection, when its adapter can. */
  async removeNote(connId: string, id: string): Promise<boolean> {
    const conn = this.get(connId);
    if (!conn) return false;
    const adapter = this.adapter(conn);
    if (!adapter.remove) return false;
    await withTimeout(adapter.remove(id), WRITE_TIMEOUT_MS, `${conn.id} remove`);
    return true;
  }

  canRemove(connId: string): boolean {
    const conn = this.get(connId);
    return !!conn && typeof this.adapter(conn).remove === 'function';
  }

  async write(note: ExternalNote): Promise<void> {
    if (note.grouped) return this.writeGrouped(note);
    // a grouped mirror connection gets its facts and episodes through the grouped notes instead
    const targets = this.active().filter((c) => c.mode !== 'read' && (note.always || !(c.mode === 'mirror' && layoutOf(c) === 'grouped')));
    return this.writeTo(targets, note);
  }

  private async writeTo(targets: ResolvedConnection[], note: ExternalNote): Promise<void> {
    if (!targets.length) return;
    const outcomes = await Promise.all(
      targets.map(async (conn) => {
        try {
          const adapter = this.adapter(conn);
          if (!adapter.canWrite) return { conn, ok: false, error: `${conn.id} cannot write` };
          await withTimeout(adapter.write(note), WRITE_TIMEOUT_MS, `${conn.id} write`);
          this.ok(conn.id);
          return { conn, ok: true };
        } catch (err) {
          this.failed(conn.id, err);
          return { conn, ok: false, error: `${conn.id}: ${explainError(err).error}` };
        }
      }),
    );
    const primary = outcomes.filter((o) => o.conn.mode === 'external');
    const counted = primary.length ? primary : outcomes;
    if (!counted.some((o) => o.ok)) throw new Error(`memory write failed: ${counted.map((o) => o.error).join('; ')}`);
    for (const o of outcomes) if (!o.ok) log.warn(`memory write to ${o.error}`);
  }

  // -------------------------------------------------------------------------
  // test and pull
  // -------------------------------------------------------------------------

  /** Test a configured connection (by id) or an unsaved one. */
  async test(conn: ResolvedConnection, opts: { saved: boolean }): Promise<ConnectionTestResult> {
    const adapter = opts.saved ? this.adapter(conn) : createAdapter(conn, this.deps);
    try {
      const res = await adapter.test();
      if (opts.saved) {
        if (res.ok) this.ok(conn.id, res.latencyMs);
        else this.failed(conn.id, new Error(res.error ?? 'test failed'));
      }
      return res;
    } finally {
      if (!opts.saved) await adapter.close?.().catch(() => {});
    }
  }

  canPull(conn: ResolvedConnection): boolean {
    return typeof this.adapter(conn).pullAll === 'function';
  }

  async pullAll(conn: ResolvedConnection, max: number): Promise<PulledNote[]> {
    const adapter = this.adapter(conn);
    if (!adapter.pullAll) throw new Error(`${conn.name} (${conn.type}) has no list call, so it cannot be imported. Live search still works.`);
    try {
      const notes = await adapter.pullAll({ max });
      this.ok(conn.id);
      return notes;
    } catch (err) {
      this.failed(conn.id, err);
      throw err;
    }
  }

  async close(): Promise<void> {
    const slots = [...this.slots.values()];
    this.slots.clear();
    await Promise.all(slots.map((s) => s.adapter.close?.().catch(() => {})));
  }
}

/**
 * Merge per-connection results: scores normalized within each connection
 * (rank based when a backend gives none), near duplicates dropped, best first.
 */
export function mergeHits(results: Array<{ conn: { id: string }; hits: ExternalMemoryHit[] }>, limit: number): ExternalMemoryHit[] {
  const all: Array<ExternalMemoryHit & { norm: number }> = [];
  for (const { conn, hits } of results) {
    const max = Math.max(0, ...hits.map((h) => h.score ?? 0));
    hits.forEach((h, i) => {
      const norm = max > 0 && h.score !== undefined ? h.score / max : Math.max(0.1, 1 - i * 0.12);
      all.push({ ...h, source: h.source ?? conn.id, norm });
    });
  }
  all.sort((a, b) => b.norm - a.norm);
  const kept: Array<{ hit: ExternalMemoryHit; terms: Set<string>; key: string }> = [];
  for (const h of all) {
    const text = `${h.title ?? ''} ${h.content}`;
    const key = h.content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
    const terms = termSet(text);
    if (kept.some((k) => k.key === key || (terms.size >= 3 && jaccard(terms, k.terms) >= 0.8))) continue;
    const { norm, ...hit } = h;
    kept.push({ hit: { ...hit, score: Math.round(norm * 1e4) / 1e4 }, terms, key });
    if (kept.length >= limit) break;
  }
  return kept.map((k) => k.hit);
}
