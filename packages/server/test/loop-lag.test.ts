import { describe, expect, test } from 'bun:test';
import { setLogTap } from '@conclave/core/util/log.ts';
import { lagWorthWarn, majorFaults, startLoopLagWatch, trackRequest, trackToolDone, trackToolStarted } from '../src/lag';

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
      expect(warns[0]).toMatchObject({ msg: 'hub event loop lagged', extra: { lagMs: 9995, at: new Date(t).toISOString() } });
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

  test('the stall line names memory, page faults, the requests and the tool calls in flight', async () => {
    const warns: Record<string, unknown>[] = [];
    const prev = setLogTap((level, scope, _msg, extra) => {
      if (level === 'warn' && scope === 'lag') warns.push(extra as Record<string, unknown>);
    });
    const endReq = trackRequest('GET', '/api/sessions/ses_1/messages');
    const endDone = trackRequest('GET', '/api/health');
    endDone();
    trackToolStarted('tu_1', 'Bash');
    trackToolStarted('tu_2', 'Read');
    trackToolDone('tu_2');
    let t = 0;
    const watch = startLoopLagWatch({ intervalMs: 5, now: () => t });
    try {
      t = 5_000;
      await Bun.sleep(15);
      expect(warns).toHaveLength(1);
      const w = warns[0];
      expect(w.heapUsedMb).toBeNumber();
      expect(w.heapSizeMb).toBeNumber();
      expect(w.rssMb).toBeGreaterThan(0);
      if (process.platform === 'linux') expect(w.majorFaults).toBeGreaterThanOrEqual(0);
      expect((w.requests as string[]).map((r) => r.replace(/ \d+ms$/, ''))).toEqual(['GET /api/sessions/ses_1/messages']);
      expect((w.tools as string[]).map((r) => r.replace(/ \d+ms$/, ''))).toEqual(['Bash']);
    } finally {
      watch.stop();
      endReq();
      trackToolDone('tu_1');
      setLogTap(prev);
    }
  });

  test('major page faults read from /proc/self/stat on Linux', () => {
    if (process.platform === 'linux') expect(majorFaults()).toBeGreaterThanOrEqual(0);
    else expect(majorFaults()).toBeUndefined();
  });
});
