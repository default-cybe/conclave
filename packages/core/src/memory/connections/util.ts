/**
 * Small helpers shared by the connection adapters: option readers, a JSON
 * HTTP client with timeouts, the test step runner, plain-language error
 * hints, argument templates and tolerant result parsing.
 */
import type { ExternalMemoryHit } from '../external';
import type { ConnectionTestResult, TestStep } from './types';

// ---------------------------------------------------------------------------
// option readers
// ---------------------------------------------------------------------------

export function optStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function optNum(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

export function optStrArr(o: Record<string, unknown>, key: string): string[] | undefined {
  const v = o[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && !!x.trim());
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
}

export function optRecord(o: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const v = o[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
}

export function optObject(o: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = o[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

// ---------------------------------------------------------------------------
// timeouts
// ---------------------------------------------------------------------------

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${redactUrl(url)}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpStatusError';
  }
}

export function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@\s]+@/, '//***@').replace(/([?&](?:key|token|api_key|apikey)=)[^&]+/gi, '$1***');
}

export function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function tryJson(s: string): unknown {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export interface HttpOpts {
  method?: string;
  headers?: Record<string, string>;
  /** Object bodies are sent as JSON; FormData as multipart. */
  body?: unknown;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Fetch and parse JSON (falls back to text). Throws HttpStatusError on non-2xx. */
export async function httpJson(url: string, o: HttpOpts): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json', ...(o.headers ?? {}) };
  let body: BodyInit | undefined;
  if (o.body instanceof FormData) body = o.body;
  else if (o.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const res = await (o.fetch ?? fetch)(url, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(o.timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new HttpStatusError(res.status, url, text);
  return tryJson(text) ?? text;
}

// ---------------------------------------------------------------------------
// errors in plain words
// ---------------------------------------------------------------------------

/** Turn a low-level failure into a short message plus a hint the user can act on. */
export function explainError(err: unknown, ctx: { url?: string; command?: string; what?: string } = {}): { error: string; hint?: string } {
  const e = err as { message?: string; code?: string; name?: string; cause?: { code?: string; message?: string } } | undefined;
  const msg = String(e?.message ?? err ?? 'unknown error');
  const code = e?.code ?? e?.cause?.code ?? '';
  const where = ctx.url ? ` ${redactUrl(ctx.url)}` : '';
  if (err instanceof HttpStatusError) {
    if (err.status === 401 || err.status === 403) {
      // sync and live search pass no url; the request carries its own
      const at = where || (err.url ? ` ${redactUrl(err.url)}` : '');
      return { error: `Not authorized (HTTP ${err.status})${at ? ` at${at}` : ''}`, hint: 'Check the API key or token in this connection.' };
    }
    if (err.status === 404) return { error: `Endpoint not found (HTTP 404) at ${redactUrl(err.url)}`, hint: 'Check the base URL. Use the server root, without /api or /v1 on the end.' };
    if (err.status === 405) return { error: `Method not allowed (HTTP 405) at ${redactUrl(err.url)}`, hint: 'The URL points at something else. Check the base URL and the connection type.' };
    if (err.status === 422 || err.status === 400) return { error: `The server rejected the request (HTTP ${err.status}): ${err.body.slice(0, 160)}`, hint: 'The server version may differ from what Conclave expects. Check the options for this type.' };
    if (err.status >= 500) return { error: `Server error (HTTP ${err.status}): ${err.body.slice(0, 160)}`, hint: 'Look at the memory server logs.' };
    return { error: msg };
  }
  const unknownServer = msg.match(/unknown mcp server:\s*(\S+)/i);
  if (unknownServer) return { error: `No MCP server named "${unknownServer[1]}"`, hint: 'Add it under mcpServers first, or define the server (command or url) in this connection.' };
  if (/mcp server \S+ is disabled/i.test(msg)) return { error: msg, hint: 'Enable that server in mcpServers, or point the connection at another one.' };
  if (/mcp server \S+ is in backoff/i.test(msg)) return { error: msg, hint: 'The MCP server failed to start recently. Check its command, then test again in a minute.' };
  if (e?.name === 'TimeoutError' || /timed out|timeout|aborted due to timeout/i.test(msg)) {
    return { error: `${ctx.what ?? 'Request'} timed out${where}`, hint: 'The server is slow or unreachable. Raise timeoutMs, or check that the host is up and the hub can reach it.' };
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|connection refused|Unable to connect/i.test(msg)) {
    return { error: `Connection refused${where}`, hint: 'Nothing is listening there. Is the server running, and is the port right?' };
  }
  if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo|could not resolve|DNS/i.test(msg)) {
    return { error: `Host not found${where}`, hint: 'Check the host name, and that the hub can reach that machine (same network, VPN or tailnet).' };
  }
  if (/certificate|self[- ]signed|CERT_|SSL|TLS/i.test(msg)) {
    return { error: `TLS problem${where}: ${msg}`, hint: 'The certificate is not trusted. Use the http URL on a private network, or a trusted cert.' };
  }
  if (code === 'ENOENT' || /ENOENT|not found in PATH|No such file or directory|command not found|Executable not found/i.test(msg)) {
    return {
      error: `Command not found${ctx.command ? `: ${ctx.command}` : ''}`,
      hint: ctx.command === 'uvx' ? 'Install uv (https://docs.astral.sh/uv/) on the hub, or point the connection at a Basic Memory HTTP URL.' : 'Install it on the hub, or give the full path in options.command.',
    };
  }
  return { error: msg.length > 300 ? msg.slice(0, 300) + '...' : msg };
}

/** Records test steps with timing; the first failure ends the test. */
export class TestRun {
  readonly steps: TestStep[] = [];
  private started = performance.now();
  private failure?: { error: string; hint?: string };
  hits?: number;
  tools?: string[];

  constructor(private ctx: { url?: string; command?: string } = {}) {}

  get failed(): boolean {
    return !!this.failure;
  }

  /** Run a step. Returns undefined (and records the failure) when it throws. */
  async step<T>(name: string, fn: () => Promise<T>, detail?: (v: T) => string | undefined): Promise<T | undefined> {
    if (this.failure) return undefined;
    const t0 = performance.now();
    try {
      const v = await fn();
      this.steps.push({ step: name, ok: true, ms: Math.round(performance.now() - t0), detail: detail?.(v) });
      return v;
    } catch (err) {
      const ex = explainError(err, { ...this.ctx, what: name });
      this.steps.push({ step: name, ok: false, ms: Math.round(performance.now() - t0), detail: ex.error });
      this.failure = ex;
      return undefined;
    }
  }

  /** Record a failure found by inspection (missing tool, wrong shape). */
  fail(name: string, error: string, hint?: string): void {
    if (this.failure) return;
    this.steps.push({ step: name, ok: false, detail: error });
    this.failure = { error, hint };
  }

  note(name: string, detail: string): void {
    this.steps.push({ step: name, ok: true, detail });
  }

  result(): ConnectionTestResult {
    return {
      ok: !this.failure,
      latencyMs: Math.round(performance.now() - this.started),
      steps: this.steps,
      error: this.failure?.error,
      hint: this.failure?.hint,
      hits: this.hits,
      tools: this.tools,
    };
  }
}

// ---------------------------------------------------------------------------
// argument templates
// ---------------------------------------------------------------------------

/**
 * Fill {{name}} placeholders in a JSON template. A string that is exactly one
 * placeholder takes the raw value (a number, an array); placeholders inside
 * longer strings are stringified. Unknown placeholders become empty and keys
 * whose whole value is an unknown placeholder are dropped.
 */
export function fillTemplate(tpl: unknown, vars: Record<string, unknown>): unknown {
  if (typeof tpl === 'string') {
    const whole = tpl.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole) return vars[whole[1]];
    return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = vars[k];
      return v === undefined || v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
    });
  }
  if (Array.isArray(tpl)) return tpl.map((x) => fillTemplate(x, vars)).filter((x) => x !== undefined);
  if (tpl && typeof tpl === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tpl)) {
      const filled = fillTemplate(v, vars);
      if (filled !== undefined) out[k] = filled;
    }
    return out;
  }
  return tpl;
}

// ---------------------------------------------------------------------------
// tolerant result parsing
// ---------------------------------------------------------------------------

/** Follow a dotted path ("data.results") into an object. */
export function getPath(v: unknown, path: string | undefined): unknown {
  if (!path) return v;
  let cur = v;
  for (const part of path.split('.').filter(Boolean)) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const LIST_KEYS = ['results', 'memories', 'items', 'notes', 'entities', 'hits', 'data', 'documents', 'matches'];

/** Find the list of rows in a search reply. */
export function findRows(data: unknown, path?: string): unknown[] | undefined {
  const v = getPath(data, path);
  if (Array.isArray(v)) return v;
  if (path || !v || typeof v !== 'object') return undefined;
  for (const k of LIST_KEYS) {
    const x = (v as Record<string, unknown>)[k];
    if (Array.isArray(x)) return x;
  }
  return undefined;
}

export interface RowFields {
  id?: string;
  title?: string;
  content?: string;
  score?: string;
  url?: string;
}

/** One search row into a hit. Strings are content; objects use the mapped or usual field names. */
export function rowToHit(row: unknown, i: number, f: RowFields = {}): ExternalMemoryHit | undefined {
  if (typeof row === 'string') return row.trim() ? { id: String(i), content: row.trim() } : undefined;
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  const pick = (field: string | undefined, fallbacks: string[]): unknown => {
    if (field) return getPath(r, field);
    for (const k of fallbacks) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
    return undefined;
  };
  let content = pick(f.content, ['content', 'text', 'memory', 'body', 'summary', 'snippet', 'matched_chunk', 'observations', 'description', 'value']);
  if (Array.isArray(content)) content = content.filter((x) => typeof x === 'string').join('; ');
  const title = str(pick(f.title, ['title', 'name']));
  const contentStr = str(content) ?? title;
  if (!contentStr) return undefined;
  const id = pick(f.id, ['id', 'permalink', 'uuid', 'name', 'uri', 'key']);
  const score = pick(f.score, ['score', 'similarity', 'relevance', 'rank_score']);
  return {
    id: id === undefined || id === null ? String(i) : String(id),
    title,
    content: contentStr.trim(),
    score: typeof score === 'number' && Number.isFinite(score) ? score : undefined,
    url: str(pick(f.url, ['url', 'link'])),
  };
}

/** Clip long text for recall and for imported notes. */
export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max - 3).trimEnd() + '...' : t;
}

/** Stable short hash for change detection. */
export function hashText(text: string): string {
  return new Bun.CryptoHasher('sha1').update(text).digest('hex').slice(0, 16);
}
