/**
 * A cheap sample of the hub's event-loop lag: a timer is set to fire every
 * `intervalMs` and the drift of its firing is the loop's lag. One warn line
 * per stall above `thresholdMs` (rate-limited), so the log shows when a stall
 * happened and how long it lasted, with what the hub was doing then: heap,
 * RSS, major page faults since the last line, the HTTP requests and tool
 * calls in flight. SQL calls are not recorded: repos call db.query directly
 * and there is no cheap hook.
 */
import { readFileSync } from 'node:fs';
import { logger } from '@conclave/core/util/log.ts';

const log = logger('lag');

const MB = 1024 * 1024;
/** Requests and tool calls in flight, label to start time. Capped so a missed end cannot grow them. */
const routes = new Map<object, { label: string; at: number }>();
const tools = new Map<string, { name: string; at: number }>();
const CAP = 200;

function capped<K, V>(m: Map<K, V>, k: K, v: V): void {
  if (m.size >= CAP) m.delete(m.keys().next().value as K);
  m.set(k, v);
}

/** Marks one HTTP request in flight ("GET /api/sessions/x/messages", no query string); call the result when it ends. */
export function trackRequest(method: string, path: string): () => void {
  const key = {};
  capped(routes, key, { label: `${method} ${path}`, at: Date.now() });
  return () => routes.delete(key);
}

export function trackToolStarted(toolUseId: string, name: string): void {
  capped(tools, toolUseId, { name, at: Date.now() });
}

export function trackToolDone(toolUseId: string): void {
  tools.delete(toolUseId);
}

/** Major page faults of this process so far (field 12 of /proc/self/stat), or undefined off Linux. */
export function majorFaults(): number | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    // the name in parentheses may hold spaces; fields count from after it (state is field 3)
    const n = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[9]);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function inFlight<T extends { at: number }>(m: Map<unknown, T>, name: (v: T) => string, t: number): string[] {
  return [...m.values()].slice(-10).map((v) => `${name(v)} ${t - v.at}ms`);
}

/** What the hub was doing at a stall, for its warn line. */
export function stallContext(t = Date.now(), lastFaults?: number): Record<string, unknown> {
  const mem = process.memoryUsage();
  const faults = majorFaults();
  return {
    heapUsedMb: Math.round(mem.heapUsed / MB),
    heapSizeMb: Math.round(mem.heapTotal / MB),
    rssMb: Math.round(mem.rss / MB),
    ...(faults !== undefined && lastFaults !== undefined ? { majorFaults: faults - lastFaults } : {}),
    requests: inFlight(routes, (v) => v.label, t),
    tools: inFlight(tools, (v) => v.name, t),
  };
}

export interface LoopLagOptions {
  /** How often the timer is set. Default 500 ms. */
  intervalMs?: number;
  /** A lag above this gets one warn line. Default 1 s. */
  thresholdMs?: number;
  /** At most one warn line per this many ms. Default 60 s. */
  rateLimitMs?: number;
  /** The clock, injectable so tests can fake a stall. */
  now?: () => number;
}

/** One sample's verdict: worth a warn line now, or not yet. Pure, for tests. */
export function lagWorthWarn(lagMs: number, now: number, lastWarnAt: number, thresholdMs = 1000, rateLimitMs = 60_000): boolean {
  return lagMs > thresholdMs && now - lastWarnAt >= rateLimitMs;
}

export interface LoopLagWatch {
  stop(): void;
}

export function startLoopLagWatch(opts: LoopLagOptions = {}): LoopLagWatch {
  const intervalMs = opts.intervalMs ?? 500;
  const thresholdMs = opts.thresholdMs ?? 1000;
  const rateLimitMs = opts.rateLimitMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let lastWarnAt = -Infinity;
  let lastFaults = majorFaults();
  let deadline = now() + intervalMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const t = now();
    const lag = t - deadline;
    if (lagWorthWarn(lag, t, lastWarnAt, thresholdMs, rateLimitMs)) {
      lastWarnAt = t;
      log.warn('hub event loop lagged', { lagMs: lag, at: new Date(t).toISOString(), ...stallContext(Date.now(), lastFaults) });
      lastFaults = majorFaults();
    }
    deadline = t + intervalMs;
    timer = setTimeout(tick, intervalMs);
    (timer as { unref?: () => void }).unref?.();
  };
  timer = setTimeout(tick, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
