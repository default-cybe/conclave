import type { LimitWindow } from '../types';
import { parseDuration } from '../util/text';
import { ProviderError, type ProviderErrorKind } from './types';
import { accessProgramError } from './access-programs';

export type HeaderSource = Headers | Record<string, string | undefined> | undefined;

/** Waits up to this long are short enough to retry in place. Longer ones get a resetAt. */
const LONG_WAIT_MS = 90_000;

export function getHeader(h: HeaderSource, name: string): string | undefined {
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === lower && v != null) return v;
  return undefined;
}

function headerEntries(h: HeaderSource): Array<[string, string]> {
  if (!h) return [];
  if (h instanceof Headers) return [...h.entries()].map(([k, v]) => [k.toLowerCase(), v]);
  return Object.entries(h)
    .filter((e): e is [string, string] => e[1] != null)
    .map(([k, v]) => [k.toLowerCase(), v]);
}

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

/**
 * Parse a reset value into epoch ms. Accepts epoch seconds or ms, relative
 * seconds, Go style durations ("6m0s", "20ms") and RFC3339 / HTTP dates.
 */
export function parseResetValue(value: string | undefined, now = Date.now()): number | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 1e12) return Math.round(n);
    if (n > 1e9) return Math.round(n * 1000);
    return now + Math.round(n * 1000);
  }
  if (/^(\d+(\.\d+)?(ms|h|m|s))+$/.test(v)) {
    const ms = parseDuration(v);
    return ms === undefined ? undefined : now + Math.round(ms);
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Milliseconds to wait from retry-after-ms or retry-after (seconds or HTTP date). */
export function parseRetryAfter(headers: HeaderSource, now = Date.now()): number | undefined {
  const ms = getHeader(headers, 'retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.max(0, Math.round(Number(ms)));
  const ra = getHeader(headers, 'retry-after');
  if (!ra) return undefined;
  if (/^\d+(\.\d+)?$/.test(ra.trim())) return Math.max(0, Math.round(Number(ra) * 1000));
  const t = Date.parse(ra);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

const DATE_TIME_RE =
  /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2}|\(\s*(?:UTC|GMT)?\s*[+-]\d{1,2}(?::?\d{2})?\s*\)|(?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?)?/i;

function normalizeOffset(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^z$/i.test(raw)) return 'Z';
  const m = raw.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return undefined;
  return `${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}`;
}

/**
 * Parse a calendar time out of free text ("Your limit will reset at
 * 2026-10-14 12:03:22"). Z.ai prints times without an offset; they are
 * Beijing time (UTC+8). If that reading lands in the past but UTC would be in
 * the future, the UTC reading wins.
 */
export function parseTextResetTime(text: string, now = Date.now(), defaultOffset = '+08:00'): number | undefined {
  const m = text.match(DATE_TIME_RE);
  if (!m) return undefined;
  const base = `${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}`;
  const explicit = normalizeOffset(m[3]);
  if (explicit) {
    const t = Date.parse(base + explicit);
    return Number.isNaN(t) ? undefined : t;
  }
  const local = Date.parse(base + defaultOffset);
  if (Number.isNaN(local)) return undefined;
  if (local < now - 60_000) {
    const utc = Date.parse(base + 'Z');
    if (utc > now) return utc;
  }
  return local;
}

/** "Please try again in 6m0s" / "in 1.5s" / "in 20ms" (OpenAI, Groq). */
function parseTryAgainIn(text: string): number | undefined {
  const m = text.match(/try again in\s+((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i);
  if (!m) return undefined;
  return parseDuration(m[1].replace(/\s+/g, ''));
}

/** Next midnight in an IANA zone (Gemini daily quotas reset at midnight Pacific). */
export function nextMidnightIn(timeZone: string, now = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000;
  return now - elapsed + 86_400_000 - (now % 1000);
}

// ---------------------------------------------------------------------------
// Error body parsing
// ---------------------------------------------------------------------------

interface ErrorInfo {
  message: string;
  type?: string;
  code?: string;
  status?: string;
  details: Array<Record<string, unknown>>;
  json?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

export function extractErrorInfo(bodyText: string): ErrorInfo {
  let json: unknown;
  try {
    json = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    json = undefined;
  }
  // Gemini sometimes wraps errors in an array.
  if (Array.isArray(json)) json = json[0];
  if (!json || typeof json !== 'object') {
    return { message: bodyText.trim().slice(0, 1000), details: [] };
  }
  const obj = json as Record<string, unknown>;
  const errVal = obj.error;
  const err = (errVal && typeof errVal === 'object' ? errVal : obj) as Record<string, unknown>;
  const message =
    str(err.message) ??
    (typeof errVal === 'string' ? errVal : undefined) ??
    str(obj.message) ??
    str(err.msg) ??
    str(obj.msg) ??
    str(obj.detail) ??
    bodyText.trim().slice(0, 1000);
  const details = Array.isArray(err.details) ? (err.details as Array<Record<string, unknown>>) : [];
  return {
    message,
    type: str(err.type) ?? (str(obj.type) !== 'error' ? str(obj.type) : undefined),
    code: str(err.code) ?? str(obj.code),
    status: str(err.status),
    details,
    json: obj,
  };
}

// ---------------------------------------------------------------------------
// Z.ai (GLM coding plan and API) business codes
// ---------------------------------------------------------------------------

/**
 * Z.ai returns business codes in error.code. Sources: docs.z.ai error table
 * (1302, 1305, 1308, 1309, 1310 and the 1316-1321 reset-at family), and
 * community harnesses for codes the table omits (1303, 1304, 1312, 1313).
 */
const ZAI_CODES: Record<string, ProviderErrorKind> = {
  '1000': 'auth',
  '1001': 'auth',
  '1002': 'auth',
  '1003': 'auth',
  '1004': 'auth',
  '1110': 'auth',
  '1111': 'auth',
  '1112': 'auth',
  '1113': 'quota', // account in arrears
  '1120': 'auth',
  '1121': 'auth',
  '1211': 'bad_request', // model does not exist
  '1220': 'auth', // no permission for model
  '1261': 'context_length',
  '1301': 'bad_request', // content filter
  '1302': 'rate_limit', // concurrency
  '1303': 'rate_limit', // frequency
  '1304': 'quota', // daily call limit
  '1305': 'overloaded',
  '1308': 'quota', // 5 hour plan window
  '1309': 'quota', // plan expired
  '1310': 'quota', // weekly or monthly limit
  '1311': 'quota', // model not in plan
  '1312': 'rate_limit',
  '1313': 'quota', // fair use
  '1316': 'quota',
  '1317': 'quota',
  '1318': 'quota',
  '1319': 'quota',
  '1320': 'quota',
  '1321': 'quota',
};

function zaiCode(info: ErrorInfo): string | undefined {
  for (const c of [info.code, info.type]) {
    if (c && ZAI_CODES[c]) return c;
  }
  return undefined;
}

function zaiReset(info: ErrorInfo, now: number): number | undefined {
  const raw = info.json;
  const err = raw && typeof raw.error === 'object' ? (raw.error as Record<string, unknown>) : raw;
  for (const key of ['next_flush_time', 'nextFlushTime', 'reset_at', 'resetAt']) {
    const v = err?.[key] ?? raw?.[key];
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string') {
      const t = /^\d+$/.test(v) ? parseResetValue(v, now) : parseTextResetTime(v, now);
      if (t) return t;
    }
  }
  return parseTextResetTime(info.message, now);
}

// ---------------------------------------------------------------------------
// Rate limit headers
// ---------------------------------------------------------------------------

const ANTHROPIC_KINDS = ['requests', 'tokens', 'input-tokens', 'output-tokens'] as const;

function num(v: string | undefined): number | undefined {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function windowFrom(name: string, limit?: number, remaining?: number, resetsAt?: number): LimitWindow | undefined {
  if (limit === undefined && remaining === undefined && resetsAt === undefined) return undefined;
  const w: LimitWindow = { name };
  if (limit !== undefined) w.limit = limit;
  if (remaining !== undefined) w.remaining = remaining;
  if (limit && remaining !== undefined) w.usedPercent = Math.min(100, Math.max(0, (1 - remaining / limit) * 100));
  if (resetsAt !== undefined) w.resetsAt = resetsAt;
  return w;
}

/** Map Anthropic unified window ids ("5h", "7d", "7d_opus", "five_hour") to the names the OAuth reader uses ("7d opus"). */
function unifiedName(id: string): string {
  const map: Record<string, string> = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d opus', seven_day_sonnet: '7d sonnet' };
  return map[id] ?? id.replace(/_/g, ' ');
}

/** "5h", "7d" from a window length in minutes. */
function minutesName(minutes: number | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Usage windows from response headers. Covers Anthropic API limits
 * (anthropic-ratelimit-*), Anthropic subscription windows
 * (anthropic-ratelimit-unified-*), OpenAI style x-ratelimit-*-{requests,tokens},
 * the plain x-ratelimit-limit/remaining/reset trio (OpenRouter), and the
 * ChatGPT plan's x-codex-{primary,secondary}-* windows. Names are matched
 * without regard to case, so CLIProxyAPI's stored signals
 * ("Anthropic-Ratelimit-Unified-5h-Utilization") read the same.
 */
export function parseRateLimitHeaders(_provider: string, headers: HeaderSource, now = Date.now()): LimitWindow[] {
  const out: LimitWindow[] = [];
  const h = (n: string) => getHeader(headers, n);

  for (const kind of ANTHROPIC_KINDS) {
    const w = windowFrom(
      kind,
      num(h(`anthropic-ratelimit-${kind}-limit`)),
      num(h(`anthropic-ratelimit-${kind}-remaining`)),
      parseResetValue(h(`anthropic-ratelimit-${kind}-reset`), now),
    );
    if (w) out.push(w);
  }

  const unified = new Map<string, LimitWindow>();
  for (const [k, v] of headerEntries(headers)) {
    const m = k.match(/^anthropic-ratelimit-unified-([a-z0-9_]+)-(utilization|reset|remaining|limit)$/);
    if (!m || m[1] === 'overage' || m[1] === 'fallback') continue;
    const name = unifiedName(m[1]);
    const w = unified.get(name) ?? { name };
    if (m[2] === 'utilization') {
      const u = num(v);
      if (u !== undefined) w.usedPercent = Math.min(100, u <= 1.5 ? u * 100 : u);
    } else if (m[2] === 'reset') w.resetsAt = parseResetValue(v, now);
    else if (m[2] === 'remaining') w.remaining = num(v);
    else w.limit = num(v);
    unified.set(name, w);
  }
  out.push(...unified.values());

  for (const kind of ['requests', 'tokens']) {
    const reset = h(`x-ratelimit-reset-${kind}`);
    const w = windowFrom(
      kind,
      num(h(`x-ratelimit-limit-${kind}`)),
      num(h(`x-ratelimit-remaining-${kind}`)),
      parseResetValue(reset, now),
    );
    if (w) out.push(w);
  }
  if (!out.some((w) => w.name === 'requests')) {
    const w = windowFrom(
      'requests',
      num(h('x-ratelimit-limit')),
      num(h('x-ratelimit-remaining')),
      parseResetValue(h('x-ratelimit-reset'), now),
    );
    if (w) out.push(w);
  }

  for (const which of ['primary', 'secondary'] as const) {
    const used = num(h(`x-codex-${which}-used-percent`));
    if (used === undefined) continue;
    const minutes = num(h(`x-codex-${which}-window-minutes`));
    const after = num(h(`x-codex-${which}-reset-after-seconds`));
    const at = parseResetValue(h(`x-codex-${which}-reset-at`), now);
    const resetsAt = at ?? (after !== undefined ? now + after * 1000 : undefined);
    out.push({ name: minutesName(minutes, which === 'primary' ? '5h' : '7d'), usedPercent: Math.min(100, Math.max(0, used)), ...(resetsAt !== undefined ? { resetsAt } : {}), ...(minutes ? { windowMs: minutes * 60_000 } : {}) });
  }
  return out;
}

/**
 * The Anthropic spend cap: the organization's monthly limit (429
 * rate_limit_error with error.details.error_code enforced_spend_limit_reached,
 * no retry-after) or a limit the owner set on the key (400
 * invalid_request_error "You have reached your specified API usage limits").
 * Neither clears by waiting minutes.
 */
export function isSpendCapError(status: number, bodyText: string): boolean {
  const info = extractErrorInfo(bodyText);
  const err = info.json && typeof info.json.error === 'object' ? (info.json.error as Record<string, unknown>) : undefined;
  const details = err?.details && typeof err.details === 'object' && !Array.isArray(err.details) ? (err.details as Record<string, unknown>) : undefined;
  if (details?.error_code === 'enforced_spend_limit_reached') return true;
  if (/enforced_spend_limit_reached/.test(bodyText)) return true;
  return status === 400 && /reached your specified API usage limits/i.test(info.message);
}

/** Latest reset among exhausted windows: every exhausted window must recover before a retry works. */
function exhaustedReset(headers: HeaderSource, now: number): number | undefined {
  let best: number | undefined;
  for (const w of parseRateLimitHeaders('', headers, now)) {
    const exhausted = w.remaining === 0 || (w.usedPercent !== undefined && w.usedPercent >= 100);
    if (!exhausted || !w.resetsAt || w.resetsAt <= now) continue;
    best = best === undefined ? w.resetsAt : Math.max(best, w.resetsAt);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const CONTEXT_RE =
  /prompt is too long|context[ _-]?(length|window)|maximum context|context_length_exceeded|too many (input )?tokens|input is too long|input token count.*exceeds|exceeds the maximum (number of )?tokens|reduce the length|token limit|maximum allowed (input )?tokens|model_context_window_exceeded|request too large for model/i;

const QUOTA_RE =
  /insufficient[_ ]quota|exceeded your current quota|credit balance is too low|billing|out of credits|insufficient (balance|credits|funds)|account (is )?in arrears|quota (has been )?exhausted|usage limit (reached|exceeded)|weekly limit|monthly limit|daily limit|plan (has )?expired|subscription (has )?expired|spend limit/i;

function kindFromType(type: string | undefined): ProviderErrorKind | undefined {
  switch (type) {
    case 'overloaded_error':
      return 'overloaded';
    case 'rate_limit_error':
    case 'rate_limit_exceeded':
    case 'tokens_exceeded':
      return 'rate_limit';
    case 'authentication_error':
    case 'permission_error':
    case 'invalid_api_key':
    case 'PERMISSION_DENIED':
    case 'UNAUTHENTICATED':
      return 'auth';
    case 'billing_error':
    case 'insufficient_quota':
    // Codex (ChatGPT plans): the plan's window is spent, or the plan does not include the model
    case 'usage_limit_reached':
    case 'usage_not_included':
      return 'quota';
    case 'RESOURCE_EXHAUSTED':
      return 'rate_limit';
    case 'api_error':
    case 'server_error':
    case 'INTERNAL':
      return 'server';
    case 'UNAVAILABLE':
      return 'overloaded';
    case 'context_length_exceeded':
      return 'context_length';
    default:
      return undefined;
  }
}

function geminiRetry(info: ErrorInfo): { retryAfterMs?: number; daily: boolean } {
  let retryAfterMs: number | undefined;
  let daily = false;
  for (const d of info.details) {
    const type = String(d['@type'] ?? '');
    if (type.endsWith('RetryInfo') && typeof d.retryDelay === 'string') {
      retryAfterMs = parseDuration(d.retryDelay) ?? retryAfterMs;
    }
    if (type.endsWith('QuotaFailure') && Array.isArray(d.violations)) {
      for (const v of d.violations as Array<Record<string, unknown>>) {
        const id = `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`;
        if (/PerDay/i.test(id)) daily = true;
      }
    }
  }
  return { retryAfterMs, daily };
}

/**
 * Turn an HTTP error response into a ProviderError with kind, retryAfterMs
 * and, for long windows, resetAt.
 */
export function classifyHttpError(
  provider: string,
  status: number,
  headers: HeaderSource,
  bodyText: string,
  now = Date.now(),
): ProviderError {
  const info = extractErrorInfo(bodyText);
  const message = info.message || `HTTP ${status}`;
  const typeKind = kindFromType(info.type) ?? kindFromType(info.code) ?? kindFromType(info.status);
  const zcode = zaiCode(info);
  const spendCap = isSpendCapError(status, bodyText);

  let kind: ProviderErrorKind;
  // a spend cap is a quota: retrying in seconds cannot help, another account can
  if (spendCap) kind = 'quota';
  else if (zcode) kind = ZAI_CODES[zcode];
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 402) kind = 'quota';
  else if (status === 529 || status === 503) kind = 'overloaded';
  // Gemini says "exceeded your current quota" for per-minute limits too; the details decide.
  else if (status === 429 && info.status === 'RESOURCE_EXHAUSTED') kind = 'rate_limit';
  else if (status === 429) {
    if (typeKind === 'rate_limit' || typeKind === 'overloaded') kind = typeKind;
    else kind = typeKind === 'quota' || QUOTA_RE.test(message) ? 'quota' : 'rate_limit';
  }
  else if (typeKind === 'context_length' || CONTEXT_RE.test(message)) kind = 'context_length';
  else if (typeKind === 'quota' || (status === 400 && /credit balance is too low/i.test(message))) kind = 'quota';
  else if (typeKind) kind = typeKind;
  else if (status === 408) kind = 'network';
  else if (status >= 500) kind = 'server';
  else if (status >= 400) kind = 'bad_request';
  else kind = 'unknown';
  // a Cyber access program ChatGPT refused (providers/access-programs.ts): the request's choice, not the account, so no fallback to another account
  const program = accessProgramError(info.code, message);
  if (program) kind = 'bad_request';

  let retryAfterMs = parseRetryAfter(headers, now);
  let resetAt: number | undefined;

  if (kind === 'rate_limit' || kind === 'quota' || kind === 'overloaded') {
    const gem = geminiRetry(info);
    if (gem.daily) {
      kind = 'quota';
      resetAt = nextMidnightIn('America/Los_Angeles', now);
    }
    retryAfterMs ??= gem.retryAfterMs;

    if (zcode) {
      const t = zaiReset(info, now);
      if (t && t > now) resetAt = t;
    }

    // Anthropic subscription windows (Claude Max style).
    if (getHeader(headers, 'anthropic-ratelimit-unified-status') === 'rejected') {
      const t = parseResetValue(getHeader(headers, 'anthropic-ratelimit-unified-reset'), now) ?? exhaustedReset(headers, now);
      if (t && t > now) {
        resetAt = t;
        if (t - now > LONG_WAIT_MS) kind = 'quota';
      }
    }

    if (retryAfterMs === undefined && resetAt === undefined) {
      const t = exhaustedReset(headers, now);
      if (t) retryAfterMs = t - now;
    }
    if (retryAfterMs === undefined && resetAt === undefined) {
      retryAfterMs = parseTryAgainIn(message);
      if (retryAfterMs === undefined && kind !== 'overloaded') {
        const t = parseTextResetTime(message, now);
        if (t && t > now) resetAt = t;
      }
    }
    if (resetAt !== undefined && retryAfterMs === undefined) retryAfterMs = Math.max(0, resetAt - now);
    if (resetAt === undefined && retryAfterMs !== undefined && retryAfterMs > LONG_WAIT_MS) resetAt = now + retryAfterMs;
    // a 529/503 that says come back in hours is a usage limit (CLIProxyAPI with every credential cooling down), not a blip
    if (kind === 'overloaded' && resetAt !== undefined) kind = 'rate_limit';
  }

  const label = info.type || info.code || info.status;
  const text = `${provider} ${status}${label ? ` ${label}` : ''}: ${program ?? message}`;
  return new ProviderError(kind, text, {
    status,
    retryAfterMs,
    resetAt,
    provider,
    body: bodyText.slice(0, 4000),
    ...(spendCap ? { code: 'spend_cap' } : {}),
  });
}

/** Status code implied by an error type sent mid-stream (no HTTP status available). */
function statusForType(type: string | undefined, code: string | undefined): number {
  const key = type ?? code ?? '';
  const map: Record<string, number> = {
    overloaded_error: 529,
    rate_limit_error: 429,
    rate_limit_exceeded: 429,
    insufficient_quota: 429,
    usage_limit_reached: 429,
    usage_not_included: 429,
    api_error: 500,
    server_error: 500,
    invalid_request_error: 400,
    context_length_exceeded: 400,
    invalid_prompt: 400,
    authentication_error: 401,
    permission_error: 403,
    billing_error: 402,
    not_found_error: 404,
    request_too_large: 413,
    RESOURCE_EXHAUSTED: 429,
    UNAVAILABLE: 503,
    INVALID_ARGUMENT: 400,
  };
  if (map[key] !== undefined) return map[key];
  if (code && ZAI_CODES[code]) return 429;
  if (code && /^\d{3}$/.test(code)) return Number(code);
  return 500;
}

/** Classify an error object that arrived inside a 200 stream. */
export function classifyStreamError(provider: string, error: unknown, headers?: HeaderSource): ProviderError {
  const body = JSON.stringify(error && typeof error === 'object' && 'error' in error ? error : { error });
  const info = extractErrorInfo(body);
  return classifyHttpError(provider, statusForType(info.type ?? info.status, info.code), headers, body);
}

/** Wrap a fetch failure. */
export function classifyFetchError(provider: string, err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted) return new ProviderError('aborted', 'Request aborted', { provider });
  const e = err as Error & { code?: string; cause?: { code?: string } };
  const msg = e?.message ?? String(err);
  return new ProviderError('network', `${provider}: ${msg}${e?.code ? ` (${e.code})` : ''}`, { provider });
}
