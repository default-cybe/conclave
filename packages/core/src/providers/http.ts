import { classifyFetchError, classifyHttpError, extractErrorInfo } from './errors';
import { ProviderError } from './types';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Time allowed until response headers arrive. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;
/** Longest silence allowed inside a stream (reasoning models can think quietly for minutes). */
export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

export interface HttpOptions {
  provider: string;
  fetch?: FetchFn;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * fetch with a connect timeout, abort linking and error classification.
 * Non-2xx responses throw a classified ProviderError. read runs before the
 * timeout is cleared, so a body that never ends is bounded too; a stream is
 * returned unread and its reads watch the signal themselves (parseSse).
 */
export async function httpRequest(url: string, init: RequestInit, opts: HttpOptions): Promise<Response>;
export async function httpRequest<T>(url: string, init: RequestInit, opts: HttpOptions, read: (res: Response) => Promise<T>): Promise<T>;
export async function httpRequest<T>(url: string, init: RequestInit, opts: HttpOptions, read?: (res: Response) => Promise<T>): Promise<T | Response> {
  const { provider, signal } = opts;
  if (signal?.aborted) throw new ProviderError('aborted', 'Request aborted', { provider });
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new Error('timeout'));
  }, timeoutMs);

  const late = () => new ProviderError('network', `${provider}: no response after ${Math.round(timeoutMs / 1000)}s`, { provider });
  try {
    let res: Response;
    try {
      res = await (opts.fetch ?? fetch)(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      if (timedOut) throw late();
      throw classifyFetchError(provider, err, signal);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (timedOut) throw late();
      throw classifyHttpError(provider, res.status, res.headers, text);
    }
    if (!read) return res;
    try {
      return await read(res);
    } catch (err) {
      if (timedOut) throw late();
      if (signal?.aborted) throw classifyFetchError(provider, err, signal);
      throw err;
    }
  } finally {
    clearTimeout(timer);
    // a lingering listener would pile up on long-lived signals
    signal?.removeEventListener('abort', onAbort);
  }
}

/** POST a streaming request and check that an event stream came back. */
export async function openStream(url: string, headers: Record<string, string>, body: unknown, opts: HttpOptions): Promise<Response> {
  // Some gateways answer a stream request with a JSON error and status 200: that body is read inside the timeout.
  const { res, text } = await httpRequest(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers }, body: JSON.stringify(body) },
    opts,
    async (res) => ({ res, text: (res.headers.get('content-type') ?? '').includes('application/json') ? await res.text().catch(() => '') : undefined }),
  );
  if (text !== undefined) {
    const info = extractErrorInfo(text);
    if (info.json && 'error' in info.json) throw classifyHttpError(opts.provider, 500, res.headers, text);
    throw new ProviderError('bad_request', `${opts.provider}: expected an event stream, got JSON: ${text.slice(0, 300)}`, {
      provider: opts.provider,
      body: text.slice(0, 4000),
    });
  }
  return res;
}

export async function getJson<T>(url: string, headers: Record<string, string>, opts: HttpOptions): Promise<T> {
  return httpRequest(url, { method: 'GET', headers }, opts, (res) => res.json() as Promise<T>);
}

export async function postJson<T>(url: string, headers: Record<string, string>, body: unknown, opts: HttpOptions): Promise<T> {
  return httpRequest(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    opts,
    (res) => res.json() as Promise<T>,
  );
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
