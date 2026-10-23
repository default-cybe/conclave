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
 * Non-2xx responses throw a classified ProviderError.
 */
export async function httpRequest(url: string, init: RequestInit, opts: HttpOptions): Promise<Response> {
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

  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (timedOut) throw new ProviderError('network', `${provider}: no response after ${Math.round(timeoutMs / 1000)}s`, { provider });
    throw classifyFetchError(provider, err, signal);
  } finally {
    clearTimeout(timer);
    // Body reads watch the signal themselves (parseSse); a lingering listener would pile up on long-lived signals.
    signal?.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw classifyHttpError(provider, res.status, res.headers, text);
  }
  return res;
}

/** POST a streaming request and check that an event stream came back. */
export async function openStream(url: string, headers: Record<string, string>, body: unknown, opts: HttpOptions): Promise<Response> {
  const res = await httpRequest(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers }, body: JSON.stringify(body) },
    opts,
  );
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    // Some gateways answer a stream request with a JSON error and status 200.
    const text = await res.text().catch(() => '');
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
  const res = await httpRequest(url, { method: 'GET', headers }, opts);
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, headers: Record<string, string>, body: unknown, opts: HttpOptions): Promise<T> {
  const res = await httpRequest(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    opts,
  );
  return (await res.json()) as T;
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
