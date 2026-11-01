/**
 * A cheap sample of the hub's event-loop lag: a timer is set to fire every
 * `intervalMs` and the drift of its firing is the loop's lag. One warn line
 * per stall above `thresholdMs` (rate-limited), so the log shows when a stall
 * happened and how long it lasted; the cause is whatever else is in the log
 * at that moment.
 */
import { logger } from '@conclave/core/util/log.ts';

const log = logger('lag');

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
  let deadline = now() + intervalMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const t = now();
    const lag = t - deadline;
    if (lagWorthWarn(lag, t, lastWarnAt, thresholdMs, rateLimitMs)) {
      lastWarnAt = t;
      log.warn('hub event loop lagged', { lagMs: lag, at: new Date(t).toISOString() });
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
