/**
 * The Knot and the Mark: the geometry (components/brand/knotGeometry.ts,
 * generated from docs/design/brand/knot.json), the light's motion and the
 * state rules (components/motion/knotMath.ts). Android's
 * dev.conclave.client.motion is the same; MotionTest checks it there.
 *
 *   bun test packages/web/test/knot.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KNOT_HALOS, KNOT_LENGTH, KNOT_LIGHT, KNOT_PIECES, KNOT_STROKE } from '../src/components/brand/knotGeometry';
import { knotWidths } from '../src/components/brand/KnotSvg';
import { KNOT_LOOP, KNOT_STILL, KNOT_TOOL_LOOP, KNOT_TURN, KnotMotion, knotBrand, knotDash, knotLit, knotSpan, knotStill, knotTravel, type KnotPose } from '../src/components/motion/knotMath';
import { DUR, LOOP, SPRING, STREAM } from '../src/components/motion/tokens';
import { springCss, springSettle } from '../src/components/motion/ease';

const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const json = JSON.parse(readFileSync(repo('docs/design/brand/knot.json'), 'utf8'));
const pts = (d: string) => [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const len = (p: { head: number; tail: number }) => p.head - p.tail;

describe('geometry', () => {
  test('the generated module is knot.json, and the script has nothing to rewrite', () => {
    expect(KNOT_PIECES.map((p) => ({ ...p }))).toEqual(json.pieces);
    expect(KNOT_HALOS.map((h) => ({ ...h }))).toEqual(json.halos);
    expect(KNOT_STROKE).toEqual({ width: json.stroke.width, halo: json.stroke.halo, smallUpTo: json.stroke.small.upTo, smallWidth: json.stroke.small.width, smallHalo: json.stroke.small.halo });
    expect(JSON.parse(JSON.stringify(KNOT_LIGHT))).toEqual(json.light);
    const check = Bun.spawnSync(['bun', 'scripts/brand/knot.ts', '--check'], { cwd: repo('').pathname });
    expect(check.stderr.toString()).toBe('');
    expect(check.exitCode).toBe(0);
  });

  test('six pieces in path order, under and over by turns, sharing a path 100 long', () => {
    expect(KNOT_PIECES.map((p) => p.kind)).toEqual(['under', 'over', 'under', 'over', 'under', 'over']);
    expect(KNOT_PIECES.reduce((s, p) => s + p.length, 0)).toBeCloseTo(KNOT_LENGTH, 6);
    KNOT_PIECES.forEach((p, i) => {
      const next = KNOT_PIECES[(i + 1) % 6];
      expect((p.from + p.length) % KNOT_LENGTH).toBeCloseTo(next.from, 6);
      // each piece ends where the next starts, and the last where the first does
      expect(pts(p.d).at(-1)).toEqual(pts(next.d)[0]);
    });
    // the path starts at the bottom of the right lobe: inside the last piece
    const last = KNOT_PIECES[5];
    expect(last.from + last.length).toBeGreaterThan(KNOT_LENGTH);
    expect(json.curve.origin).toEqual([43.97, 52.37]);
  });

  test('every point lies on the trefoil, one lobe up, centered in the 64 box', () => {
    const { scale, shiftY } = json.curve;
    const curve: number[][] = [];
    for (let i = 0; i < 6000; i++) {
      const t = (i / 6000) * Math.PI * 2;
      curve.push([32 + scale * (Math.sin(t) + 2 * Math.sin(2 * t)), 32 + scale * (Math.cos(t) - 2 * Math.cos(2 * t) + shiftY)]);
    }
    const off = (q: number[]) => Math.min(...curve.map((c) => Math.hypot(c[0] - q[0], c[1] - q[1])));
    for (const p of KNOT_PIECES) for (const q of pts(p.d)) expect(off(q)).toBeLessThan(0.07);
    for (const h of KNOT_HALOS) for (const q of pts(h.d)) expect(off(q)).toBeLessThan(0.07);
    const all = KNOT_PIECES.flatMap((p) => pts(p.d));
    const ys = all.map((q) => q[1]);
    const xs = all.map((q) => q[0]);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(32, 0);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(32, 0);
    // the top of the knot is a lobe at x = 32
    const top = all.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(Math.abs(top[0] - 32)).toBeLessThan(1);
  });

  test('each halo sits on its crossing, inside its over piece', () => {
    const over: number[] = json.curve.crossings.over;
    KNOT_HALOS.forEach((h, i) => {
      const p = KNOT_PIECES[h.over];
      expect(p.kind).toBe('over');
      expect(h.from + h.length / 2).toBeCloseTo(over[i], 2);
      // inside the piece, positions taken round the path's end
      const from = h.from < p.from ? h.from + KNOT_LENGTH : h.from;
      expect(from).toBeGreaterThan(p.from);
      expect(from + h.length).toBeLessThan(p.from + p.length);
      const line = pts(p.d);
      for (const q of pts(h.d)) expect(Math.min(...line.map((o) => Math.hypot(o[0] - q[0], o[1] - q[1])))).toBeLessThan(0.6);
    });
  });

  test('pieces split away from the crossings, so no cap lands on another strand', () => {
    const all = KNOT_PIECES.flatMap((p) => pts(p.d));
    // a crossing: where two far apart stretches of the path meet
    const crossings = [...json.curve.crossings.over, ...json.curve.crossings.under].map((g: number) => {
      const p = KNOT_PIECES.find((x) => [0, KNOT_LENGTH].some((s) => g + s >= x.from && g + s <= x.from + x.length))!;
      const g0 = g < p.from ? g + KNOT_LENGTH : g;
      const line = pts(p.d);
      return line[Math.round(((g0 - p.from) / p.length) * (line.length - 1))];
    });
    expect(crossings.length).toBe(6);
    expect(all.length).toBeGreaterThan(100);
    for (const p of KNOT_PIECES) for (const end of [pts(p.d)[0], pts(p.d).at(-1)!]) for (const c of crossings) expect(Math.hypot(end[0] - c[0], end[1] - c[1])).toBeGreaterThan(6);
  });

  test('32px and under draw the heavier stroke', () => {
    expect(knotWidths(16)).toEqual({ w: 7, h: 11 });
    expect(knotWidths(32)).toEqual({ w: 7, h: 11 });
    expect(knotWidths(33)).toEqual({ w: 5.2, h: 9 });
    expect(knotWidths(112)).toEqual({ w: 5.2, h: 9 });
  });
});

describe('the light on the pieces', () => {
  test('the light at home: the last 16 of the path, ending at its start', () => {
    const b = knotBrand();
    expect([b.tail, b.head]).toEqual([84, 100]);
    const [[a4, e4]] = knotLit(KNOT_PIECES[4], b);
    expect(a4).toBeCloseTo(84 - 77.74, 6);
    expect(e4).toBeCloseTo(17.64, 6);
    const [[a5, e5]] = knotLit(KNOT_PIECES[5], b);
    expect(a5).toBe(0);
    expect(e5).toBeCloseTo(100 - 95.38, 6);
    for (const i of [0, 1, 2, 3]) expect(knotLit(KNOT_PIECES[i], b)).toEqual([]);
  });

  test('the last piece runs past 100, round to the start', () => {
    const p = { tail: 105, head: 115 };
    const [[a5, b5]] = knotLit(KNOT_PIECES[5], p);
    expect(a5).toBeCloseTo(105 - 95.38, 6);
    expect(b5).toBeCloseTo(15.69, 6);
    const [[a0, b0]] = knotLit(KNOT_PIECES[0], p);
    expect(a0).toBe(0);
    expect(b0).toBeCloseTo(115 - 111.07, 6);
    // positions are mod 100
    expect(knotLit(KNOT_PIECES[0], { tail: 205, head: 215 })).toEqual(knotLit(KNOT_PIECES[0], p));
    expect(knotLit(KNOT_PIECES[5], { tail: 0, head: 10 })[0][0]).toBeCloseTo(100 - 95.38, 6);
  });

  test('a long light can touch both ends of one piece: two dashes', () => {
    const p = { tail: 20, head: 115 };
    const lit = knotLit(KNOT_PIECES[0], p);
    expect(lit.length).toBe(2);
    expect(lit[0][0]).toBe(0);
    expect(lit[0][1]).toBeCloseTo(3.93, 6);
    expect(lit[1][0]).toBeCloseTo(8.93, 6);
    expect(knotDash(KNOT_PIECES[0], p)).toEqual({ array: '3.93 5 8.71 18.64', offset: 0 });
  });

  test('dashes: one interval, the whole knot, nothing', () => {
    expect(knotDash(KNOT_PIECES[1], { tail: 30, head: 40 })).toEqual({ array: '10 16.7', offset: -1.29 });
    for (const p of KNOT_PIECES) expect(knotLit(p, { tail: 3, head: 103 })).toEqual([[0, p.length]]);
    expect(knotDash(KNOT_PIECES[0], { tail: 40, head: 40 })).toBeNull();
  });
});

describe('thinking', () => {
  test('writes the knot from 0, whole at the turn, lets go from the tail', () => {
    expect(knotSpan(0)).toEqual({ tail: 0, head: 0 });
    // the ease is symmetric: halfway through the write, half the knot
    expect(knotSpan(KNOT_TURN / 2).head).toBeCloseTo(50, 3);
    expect(knotSpan(KNOT_TURN)).toEqual({ tail: 0, head: 100 });
    expect(knotSpan((KNOT_TURN + KNOT_LOOP) / 2).tail).toBeCloseTo(50, 3);
    expect(KNOT_TURN).toBe(1650);
    expect(KNOT_LOOP).toBe(3000);
  });

  test('closes after 3s, one lap on, with no jump at the seam', () => {
    const a = knotSpan(KNOT_LOOP);
    expect(a).toEqual({ tail: 100, head: 100 });
    const c = knotSpan(KNOT_LOOP - 0.01);
    expect(Math.abs(c.tail - a.tail)).toBeLessThan(1e-3);
    expect(Math.abs(c.head - a.head)).toBeLessThan(1e-3);
  });

  test('the head only moves forward, and so does the tail', () => {
    let prev = knotSpan(0);
    for (let t = 10; t <= KNOT_LOOP * 2; t += 10) {
      const s = knotSpan(t);
      expect(s.head).toBeGreaterThanOrEqual(prev.head - 1e-9);
      expect(s.tail).toBeGreaterThanOrEqual(prev.tail - 1e-9);
      expect(len(s)).toBeGreaterThanOrEqual(-1e-9);
      expect(len(s)).toBeLessThanOrEqual(100 + 1e-9);
      prev = s;
    }
  });

  test('the still pose is about three quarters written', () => {
    const p = knotStill('thinking');
    expect(p.tail).toBe(0);
    expect(p.head).toBeGreaterThan(70);
    expect(p.head).toBeLessThan(80);
    expect(KNOT_STILL).toBe(1000);
  });

  test('the tool light: 14 long, one lap per 2s', () => {
    expect(knotTravel(0, 0)).toEqual({ tail: 0, head: 14 });
    expect(knotTravel(KNOT_TOOL_LOOP, 3)).toEqual({ tail: 103, head: 117 });
  });
});

describe('states', () => {
  const run = (m: KnotMotion, from: number, to: number, step = 16): KnotPose => {
    let p = m.pose(from);
    for (let t = from; t < to; t += step) p = m.pose(t);
    return m.pose(to);
  };
  const near = (a: KnotPose, b: KnotPose, eps = 1e-6) => {
    expect(Math.abs(a.tail - b.tail)).toBeLessThan(eps);
    expect(Math.abs(a.head - b.head)).toBeLessThan(eps);
  };

  test('waiting holds the frame; thinking resumes from it', () => {
    const m = new KnotMotion('thinking', 0);
    run(m, 0, 700);
    const before = m.pose(700);
    m.set('waiting', 700);
    const held = run(m, 700, 3000);
    near(held, before);
    expect(held.light).toBe(1);
    expect(m.moving(3000)).toBe(false);
    const phase = m.phase;
    m.set('thinking', 3000);
    run(m, 3000, 3100);
    expect(m.phase).toBeGreaterThan(phase);
    expect(m.phase - phase).toBeLessThan(120);
  });

  test('an approval that comes with its tool call holds the tool light in amber (Knot via)', () => {
    // what <Knot state="waiting" via="tool"> does when both arrive in one update
    const m = new KnotMotion('thinking', 0);
    run(m, 0, 900);
    m.set('tool', 900);
    m.set('waiting', 900);
    const p = run(m, 900, 2000);
    const q = run(m, 2000, 4000);
    near(q, p);
    expect(m.live).toBe('tool');
    expect(m.moving(4000)).toBe(false);
    // mounted straight into it: the tool's still light
    const fresh = new KnotMotion('waiting', 0, 'tool').pose(0);
    expect(len(fresh)).toBeCloseTo(14, 6);
  });

  test('a tool keeps the written head and runs a 14 long light from there', () => {
    const m = new KnotMotion('thinking', 0);
    run(m, 0, 900);
    const at = m.pose(900);
    m.set('tool', 900);
    near(m.pose(900), at);
    const p = run(m, 900, 1600);
    expect(len(p)).toBeCloseTo(14, 6);
    expect(p.head).toBeCloseTo(at.head + (700 * 100) / KNOT_TOOL_LOOP, 6);
    const q = run(m, 1600, 2100);
    expect(q.tail - p.tail).toBeCloseTo((500 * 100) / KNOT_TOOL_LOOP, 6);
  });

  test('back to thinking: the tool light lets go from its tail, then writes again', () => {
    const m = new KnotMotion('tool', 0);
    const at = run(m, 0, 1000);
    m.set('thinking', 1000);
    near(m.pose(1000), at, 1e-3);
    let prev = at;
    for (let t = 1016; t < 1400; t += 16) {
      const p = m.pose(t);
      expect(p.head).toBeCloseTo(at.head, 3);
      expect(p.tail).toBeGreaterThanOrEqual(prev.tail - 1e-9);
      prev = p;
    }
    // the loop goes on from there: a new write starts at the old head
    const w = run(m, 1400, 1000 + 600 + 900);
    expect(w.tail).toBeCloseTo(at.head, 3);
    expect(len(w)).toBeGreaterThan(14);
  });

  test('done fades the light out and stops', () => {
    const m = new KnotMotion('thinking', 0);
    run(m, 0, 2000);
    m.set('done', 2000);
    const p = run(m, 2000, 3000);
    expect(p.light).toBe(0);
    expect(m.moving(3000)).toBe(false);
    // and thinking again writes from the start of the path
    m.set('thinking', 3000);
    const q = run(m, 3000, 3000 + KNOT_TURN / 2);
    expect(q.tail).toBeCloseTo(0, 6);
    expect(q.light).toBe(1);
  });

  test('failed stops the light where it is', () => {
    const m = new KnotMotion('thinking', 0);
    run(m, 0, 600);
    const at = m.pose(600);
    m.set('failed', 600);
    const p = run(m, 600, 1500);
    near(p, at);
    expect(p.light).toBe(1);
    expect(m.moving(1500)).toBe(false);
  });

  test('a limit holds the light; thinking writes on from it', () => {
    const m = new KnotMotion('thinking', 0);
    run(m, 0, 500);
    const at = m.pose(500);
    m.set('paused', 500);
    near(run(m, 500, 2000), at);
    m.set('thinking', 2000);
    const q = run(m, 2000, 2300);
    expect(q.tail).toBeCloseTo(at.tail, 6);
    expect(q.head).toBeGreaterThan(at.head);
    // mounted in a limit: the short light at rest, and the write goes on from it
    const fresh = new KnotMotion('paused', 0);
    expect(fresh.pose(0)).toMatchObject({ tail: 84, light: 1 });
    expect(fresh.pose(0).head).toBeCloseTo(100, 3);
    fresh.set('thinking', 0);
    expect(run(fresh, 0, 200).head).toBeGreaterThan(100);
  });

  test('one still pose per state', () => {
    expect(len(knotStill('tool'))).toBe(14);
    expect(knotStill('paused')).toEqual({ tail: 84, head: 100, light: 1 });
    expect(knotStill('tool')).toEqual({ tail: 84, head: 98, light: 1 });
    expect(knotStill('done').light).toBe(0);
    expect(knotStill('waiting')).toEqual(knotStill('thinking'));
    expect(knotStill('failed', 'tool')).toEqual(knotStill('tool'));
    // mounted already waiting: the clear still pose, not an empty loop
    near(new KnotMotion('waiting', 0).pose(0), knotStill('thinking'));
  });
});

describe('tokens', () => {
  const motion = readFileSync(new URL('../src/styles/motion.css', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');
  const ms = (css: string, name: string) => Number(new RegExp(`${name}:\\s*(\\d+)ms`).exec(css)?.[1]);

  test('tokens.ts mirrors the CSS', () => {
    expect(ms(motion, '--dur-0')).toBe(DUR.d0);
    expect(ms(index, '--dur-1')).toBe(DUR.d1);
    expect(ms(index, '--dur-2')).toBe(DUR.d2);
    expect(ms(index, '--dur-3')).toBe(DUR.d3);
    expect(ms(motion, '--dur-4')).toBe(DUR.d4);
    expect(ms(motion, '--loop-knot')).toBe(LOOP.knot);
    expect(ms(motion, '--loop-knot-tool')).toBe(LOOP.knotTool);
    expect(ms(motion, '--loop-rim')).toBe(LOOP.rim);
    expect(ms(motion, '--loop-breath')).toBe(LOOP.breath);
    expect(ms(motion, '--loop-shimmer')).toBe(LOOP.shimmer);
    expect(ms(motion, '--stream-word')).toBe(STREAM.word);
    expect(ms(motion, '--stream-lag')).toBe(STREAM.lag);
    expect(ms(motion, '--dur-spring')).toBe(SPRING.settle);
  });

  test('the knot loops and ease are the tokens', () => {
    expect(KNOT_LOOP).toBe(LOOP.knot);
    expect(KNOT_TOOL_LOOP).toBe(LOOP.knotTool);
    expect(motion).toContain(`--ease-morph: cubic-bezier(${KNOT_LIGHT.thinking.ease.join(', ')});`);
  });

  test('the --spring curve is the critically damped 420ms spring', () => {
    expect(springSettle(SPRING.response, SPRING.damping)).toBe(SPRING.settle);
    expect(motion).toContain(`--spring: ${springCss(SPRING.response, SPRING.damping)};`);
  });
});
