import type { LimitState, LimitWindow } from '@conclave/core/types.ts';
import { parseDuration } from '@conclave/core/util/text.ts';

/** Epoch ms from "1729000000" (s), "1729000000000" (ms), an ISO date, or a relative duration ("6m0s"). */
function parseReset(v: string | null, now: number): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (n > 1e12) return Math.round(n);
    if (n > 1e9) return Math.round(n * 1000);
    // small numbers are seconds from now (x-codex-*-reset-after-seconds style)
    return now + Math.round(n * 1000);
  }
  const d = Date.parse(t);
  if (!Number.isNaN(d)) return d;
  const rel = parseDuration(t);
  return rel !== undefined ? now + rel : undefined;
}

function numHeader(h: Headers, name: string): number | undefined {
  const v = h.get(name);
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** retry-after (seconds or HTTP date) and retry-after-ms, in ms. */
export function retryAfterMs(h: Headers, now = Date.now()): number | undefined {
  const ms = numHeader(h, 'retry-after-ms');
  if (ms !== undefined) return Math.max(0, ms);
  const v = h.get('retry-after');
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.max(0, d - now);
}

function windowFrom(name: string, limit?: number, remaining?: number, resetsAt?: number): LimitWindow | undefined {
  if (limit === undefined && remaining === undefined && resetsAt === undefined) return undefined;
  const w: LimitWindow = { name };
  if (limit !== undefined) w.limit = limit;
  if (remaining !== undefined) w.remaining = remaining;
  if (limit && remaining !== undefined) w.usedPercent = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  if (resetsAt !== undefined) w.resetsAt = resetsAt;
  return w;
}

/**
 * Rate limit windows from response headers:
 * - Anthropic API: anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}
 * - Anthropic subscription: anthropic-ratelimit-unified-<window>-{utilization,reset}, -unified-status
 * - OpenAI: x-ratelimit-{limit,remaining,reset}-{requests,tokens}
 * - Codex backend: x-codex-{primary,secondary}-{used-percent,window-minutes,reset-after-seconds}
 * A 429 marks the provider blocked. Returns undefined when nothing useful was found.
 */
export function limitFromHeaders(
  provider: string,
  label: string,
  h: Headers,
  status: number,
  now = Date.now(),
): LimitState | undefined {
  const windows: LimitWindow[] = [];

  for (const kind of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    const w = windowFrom(
      kind,
      numHeader(h, `anthropic-ratelimit-${kind}-limit`),
      numHeader(h, `anthropic-ratelimit-${kind}-remaining`),
      parseReset(h.get(`anthropic-ratelimit-${kind}-reset`), now),
    );
    if (w) windows.push(w);
  }

  const unified = new Map<string, LimitWindow>();
  h.forEach((value, key) => {
    const m = /^anthropic-ratelimit-unified-(.+)-(utilization|reset)$/.exec(key.toLowerCase());
    if (!m || m[1] === 'fallback') return;
    const w = unified.get(m[1]) ?? { name: m[1] };
    if (m[2] === 'utilization') {
      const n = Number(value);
      if (Number.isFinite(n)) w.usedPercent = n <= 1 ? n * 100 : n;
    } else {
      w.resetsAt = parseReset(value, now);
    }
    unified.set(m[1], w);
  });
  windows.push(...unified.values());

  for (const kind of ['requests', 'tokens']) {
    const w = windowFrom(
      kind,
      numHeader(h, `x-ratelimit-limit-${kind}`),
      numHeader(h, `x-ratelimit-remaining-${kind}`),
      parseReset(h.get(`x-ratelimit-reset-${kind}`), now),
    );
    if (w) windows.push(w);
  }

  for (const which of ['primary', 'secondary']) {
    const used = numHeader(h, `x-codex-${which}-used-percent`);
    if (used === undefined) continue;
    const minutes = numHeader(h, `x-codex-${which}-window-minutes`);
    const after = numHeader(h, `x-codex-${which}-reset-after-seconds`);
    const name = minutes ? (minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`) : which;
    windows.push({ name, usedPercent: used, resetsAt: after !== undefined ? now + after * 1000 : undefined });
  }

  const unifiedStatus = h.get('anthropic-ratelimit-unified-status');
  const blocked = status === 429 || unifiedStatus === 'rejected';
  if (!windows.length && !blocked) return undefined;
  if (blocked && !windows.some((w) => w.resetsAt)) {
    const ra = retryAfterMs(h, now);
    windows.push({ name: 'retry', usedPercent: 100, resetsAt: ra !== undefined ? now + ra : undefined });
  }
  return { provider, label, windows, updatedAt: now, blocked, source: status === 429 ? 'error' : 'headers' };
}
