/**
 * Cached GET for every catalog source. Each URL keeps its body, ETag and
 * Last-Modified in catalog_http. A fresh row (inside its TTL) is served with
 * no network call. A stale row is revalidated with If-None-Match, and a 304
 * only bumps its time. When the network fails the stale row is served and
 * the result says so. Tests pass their own fetch that replays fixtures.
 */
import type { CatalogStore } from './store';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface CachedGetOptions {
  /** How long a stored row counts as fresh. 0 always revalidates. Infinity never does. */
  ttlMs: number;
  headers?: Record<string, string>;
  /** Keep the body in the cache (default true). Large feeds keep only the ETag and their parsed items. */
  storeBody?: boolean;
  /** Reject bodies larger than this (default 20 MB). */
  maxBytes?: number;
  timeoutMs?: number;
  /** Skip the fresh check and revalidate now. */
  force?: boolean;
  /** Called before a network call; returning false serves the cache (or fails) without calling. */
  allow?: () => boolean;
}

export interface CachedResponse {
  url: string;
  status: number;
  body: string;
  headers: Record<string, string>;
  /** Served from the cache without a network call, or after a 304. */
  fromCache: boolean;
  /** The cached copy is older than its TTL (served because the network failed or calls are paused). */
  stale: boolean;
  fetchedAt: number;
  /** Set when a network call was tried and failed. */
  error?: string;
  /** True when the body was not changed since the stored copy (304). */
  notModified?: boolean;
  /** Status of the live call when it failed and the cached copy was served instead (403, 429, 5xx). */
  liveStatus?: number;
}

export class OfflineError extends Error {
  constructor(
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = 'OfflineError';
  }
}

function headerRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export class CatalogHttp {
  private fetchFn: FetchFn;
  private now: () => number;
  /** Set when the last call failed for a network reason. Cleared by the next success. */
  offline = false;
  lastError?: string;

  constructor(
    private store: CatalogStore,
    opts: { fetch?: FetchFn; now?: () => number } = {},
  ) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
  }

  async get(url: string, opts: CachedGetOptions): Promise<CachedResponse> {
    const now = this.now();
    const row = this.store.httpGet(url);
    const fresh = row && !opts.force && now - row.fetchedAt < opts.ttlMs;
    if (row && fresh) return { url, status: row.status, body: row.body, headers: {}, fromCache: true, stale: false, fetchedAt: row.fetchedAt };
    if (opts.allow && !opts.allow()) {
      if (row) return { url, status: row.status, body: row.body, headers: {}, fromCache: true, stale: true, fetchedAt: row.fetchedAt, error: 'paused' };
      throw new OfflineError(url, 'calls are paused and nothing is cached');
    }
    const headers: Record<string, string> = { 'user-agent': 'conclave-hub', ...(opts.headers ?? {}) };
    // a row stored without its body cannot answer a 304
    const revalidate = row && (row.body || opts.storeBody === false);
    if (revalidate && row?.etag) headers['if-none-match'] = row.etag;
    if (revalidate && row?.lastModified) headers['if-modified-since'] = row.lastModified;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    } catch (err) {
      this.offline = true;
      this.lastError = (err as Error).message;
      if (row) return { url, status: row.status, body: row.body, headers: {}, fromCache: true, stale: true, fetchedAt: row.fetchedAt, error: this.lastError };
      throw new OfflineError(url, `could not reach ${new URL(url).host}: ${this.lastError}`);
    }
    this.offline = false;
    const resHeaders = headerRecord(res.headers);
    if (res.status === 304 && row) {
      this.store.httpTouch(url, now);
      return { url, status: row.status, body: row.body, headers: resHeaders, fromCache: true, stale: false, fetchedAt: now, notModified: true };
    }
    const text = await res.text();
    const max = opts.maxBytes ?? 20 * 1024 * 1024;
    if (text.length > max) throw new Error(`${url} is larger than ${Math.round(max / 1024 / 1024)} MB`);
    if (res.ok || res.status === 404 || res.status === 410) {
      // 404s are cached too, so a missing manifest is not asked for again until the TTL ends
      this.store.httpPut({
        url,
        etag: resHeaders.etag,
        lastModified: resHeaders['last-modified'],
        status: res.status,
        body: opts.storeBody === false ? '' : text,
        fetchedAt: now,
      });
      return { url, status: res.status, body: text, headers: resHeaders, fromCache: false, stale: false, fetchedAt: now };
    }
    // 403, 429, 5xx: keep the old copy and let the caller decide
    if (row) return { url, status: row.status, body: row.body, headers: resHeaders, fromCache: true, stale: true, fetchedAt: row.fetchedAt, error: `${res.status} ${text.slice(0, 200)}`, liveStatus: res.status };
    return { url, status: res.status, body: text, headers: resHeaders, fromCache: false, stale: false, fetchedAt: now, error: `${res.status}`, liveStatus: res.status };
  }

  async json<T>(url: string, opts: CachedGetOptions): Promise<{ data?: T; res: CachedResponse }> {
    const res = await this.get(url, opts);
    if (res.status < 200 || res.status >= 300 || !res.body) return { res };
    try {
      return { data: JSON.parse(res.body) as T, res };
    } catch {
      return { res };
    }
  }
}
