import { describe, expect, test } from 'bun:test';
import { setLogTap } from '@conclave/core/util/log.ts';
import { lagWorthWarn, startLoopLagWatch } from '../src/lag';

describe('the loop-lag watch', () => {
  test('warns only above the threshold, and at most once per rate-limit window', () => {
    const t0 = 1_700_000_000_000;
    expect(lagWorthWarn(500, t0, -Infinity)).toBe(false);
    expect(lagWorthWarn(1000, t0, -Infinity)).toBe(false);
    expect(lagWorthWarn(1200, t0, -Infinity)).toBe(true);
    // a second stall inside the window stays quiet, the next one after it warns again
    expect(lagWorthWarn(5000, t0 + 1000, t0)).toBe(false);
    expect(lagWorthWarn(5000, t0 + 60_000, t0)).toBe(true);
  });

  test('the watch warns once on a stall seen by its injected clock and stops cleanly', async () => {
    const warns: unknown[] = [];
    const prev = setLogTap((level, scope, msg, extra) => {
      if (level === 'warn' && scope === 'lag') warns.push({ msg, extra });
    });
    let t = 0;
    const watch = startLoopLagWatch({ intervalMs: 5, thresholdMs: 1000, rateLimitMs: 10_000, now: () => t });
    try {
      // on-time samples stay quiet
      await Bun.sleep(15);
      expect(warns).toEqual([]);
      // a 10 s stall as the clock sees it: one warn line
      t = 10_000;
      await Bun.sleep(15);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toEqual({ msg: 'hub event loop lagged', extra: { lagMs: 9995, at: new Date(t).toISOString() } });
      t = 12_000;
      await Bun.sleep(15);
      expect(warns).toHaveLength(1);
      t = 20_000;
      await Bun.sleep(15);
      expect(warns).toHaveLength(2);
      watch.stop();
      // stopped: a later stall logs nothing
      t = 100_000;
      await Bun.sleep(15);
      expect(warns).toHaveLength(2);
    } finally {
      watch.stop();
      setLogTap(prev);
    }
  });
});
