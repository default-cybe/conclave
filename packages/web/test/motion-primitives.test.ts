/**
 * The pure parts of the motion primitives: Ink's pacing, which Roll cells
 * change, the send glyph, the Rim's breath, the spring and how far a view
 * glides when a list at its foot gets shorter.
 *
 *   bun test packages/web/test/motion-primitives.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { inkBoundary, inkSchedule, type InkRun } from '../src/components/motion/InkReveal';
import { rollCells } from '../src/components/motion/Roll';
import { sendStopPoints } from '../src/components/motion/SendStop';
import { breath } from '../src/components/motion/Rim';
import { clockLeft } from '../src/components/motion/LiveStatus';
import { spring } from '../src/components/motion/ease';
import { glideDrop } from '../src/components/motion/GapList';
import { LOOP, STREAM } from '../src/components/motion/tokens';

describe('Ink pacing', () => {
  test('words are released 40ms apart', () => {
    expect(inkSchedule([3, 4, 5], 1000, -Infinity)).toEqual([1000, 1040, 1080]);
  });

  test('never more than 320ms behind the stream: a big chunk is spread over what is left', () => {
    const t = inkSchedule(new Array(41).fill(4), 0, -Infinity);
    expect(t[t.length - 1]).toBeLessThanOrEqual(STREAM.lag);
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeLessThanOrEqual(STREAM.word + 1e-9);
  });

  test('a chunk waits for the queue, but not past the cap', () => {
    // the last word of the previous chunk goes at 1300; the next chunk arrived at 1000
    const t = inkSchedule([2, 2], 1000, 1300);
    expect(t[0]).toBe(1320);
    expect(t[1]).toBeLessThanOrEqual(1000 + STREAM.lag);
  });

  test('the boundary finds the first letter not yet released', () => {
    const runs: InkRun[] = [
      { start: 0, end: 4, t0: 0, t1: 40 },
      { start: 4, end: 8, t0: 40, t1: 80 },
    ];
    expect(inkBoundary(runs, -1, 8)).toBe(0);
    expect(inkBoundary(runs, 20, 8)).toBe(3);
    expect(inkBoundary(runs, 45, 8)).toBe(5);
    expect(inkBoundary(runs, 500, 8)).toBe(8);
  });
});

describe('Roll', () => {
  test('only the changed digits roll, lower ones first', () => {
    const cells = rollCells('1,962', '1,994');
    expect(cells.map((c) => c.cur).join('')).toBe('1,994');
    expect(cells.filter((c) => c.prev !== undefined).map((c) => c.rank)).toEqual([1, 0]);
    expect(cells[0].prev).toBeUndefined();
  });

  test('5:00 to 4:59 rolls three digits at once', () => {
    const cells = rollCells('5:00', '4:59');
    expect(cells.filter((c) => c.prev !== undefined).length).toBe(3);
    expect(cells[1].prev).toBeUndefined();
  });

  test('a new leading digit rolls in from nothing', () => {
    const cells = rollCells('999', '1,000');
    expect(cells[0]).toEqual({ cur: '1', prev: '', rank: 4 });
  });

  test('a shorter value rolls out whole, so no leading digit vanishes unrolled', () => {
    expect(rollCells('$147.86', '$35.67')).toEqual([{ cur: '$35.67', prev: '$147.86', rank: 0, whole: true }]);
    expect(rollCells('10s', '9s')[0].whole).toBe(true);
    expect(rollCells('$8.58', '$147.86')[0].whole).toBe(true);
    expect(rollCells('9s', '10s').map((c) => c.whole)).toEqual([undefined, undefined, undefined]);
  });

  test('countdowns read m:ss or h:mm:ss', () => {
    expect(clockLeft(303_000)).toBe('5:03');
    expect(clockLeft(59_001)).toBe('1:00');
    expect(clockLeft(4_916_000)).toBe('1:21:56');
    expect(clockLeft(-5)).toBe('0:00');
  });
});

describe('Send to stop', () => {
  test('starts as the arrow, ends as the square, dips in between', () => {
    const a = sendStopPoints(0);
    const s = sendStopPoints(1);
    expect(a[0]).toEqual([15, 7.6]);
    expect(s[4]).toEqual([19.2, 19.2]);
    const mid = sendStopPoints(0.5);
    const extent = (pts: Array<[number, number]>) => Math.max(...pts.map(([x, y]) => Math.max(Math.abs(x - 15), Math.abs(y - 15))));
    expect(extent(mid)).toBeLessThan(extent(a));
  });
});

describe('Rim breath', () => {
  test('in 1.6s, out 2.2s, then a rest, and the loop closes', () => {
    expect(breath(0)).toBe(0);
    expect(breath(1600)).toBeCloseTo(1, 6);
    expect(breath(3800)).toBeCloseTo(0, 6);
    expect(breath(4000)).toBe(0);
    expect(breath(LOOP.breath + 800)).toBeCloseTo(breath(800), 9);
  });
});

describe('spring', () => {
  test('critically damped: never passes its target', () => {
    for (let t = 0; t <= 1000; t += 5) expect(spring(t, 420, 1)).toBeLessThanOrEqual(1);
    expect(spring(300, 420, 1)).toBeGreaterThan(0.9);
  });
});

describe('Gap list at the foot of a scrolled view', () => {
  // a view 582px tall scrolled to its end at 177 (content 759 tall); a 311px card leaves the flow
  test('content that stays taller than the view drops by what the list gave up', () => {
    // flow now ends at 759 - 311 + 600 more content above = taller than the view
    expect(glideDrop(900, 1159, 0, 582)).toEqual({ drop: 323, hold: 323 });
  });
  test('content that ends up shorter than the view drops to the top', () => {
    const { drop, hold } = glideDrop(177, 448, 0, 582);
    expect(drop).toBe(177);
    // the spacer keeps the scroll range exactly as it was, so nothing moves before the glide
    expect(448 + hold).toBe(177 + 582);
  });
  test('a view that was not scrolled to its end does not move', () => {
    expect(glideDrop(100, 1000, 32, 582).drop).toBe(0);
  });
  test('the end padding of the scroller counts', () => {
    expect(glideDrop(500, 1000, 64, 582).drop).toBe(18);
  });
});
