/**
 * The rope (docs/design/KNOT-MOTION.md): its geometry
 * (components/brand/knotGeometry.ts, generated from docs/design/brand/knot.json)
 * and its math (components/motion/knotMath.ts). Android's
 * dev.conclave.client.motion is the same; RopeTest checks it there.
 *
 *   bun test packages/web/test/knot-rope.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KNOT_HALOS, KNOT_PIECES, ROPE, ROPE_HALOS, ROPE_PATHS } from '../src/components/brand/knotGeometry';
import {
  KnotMotion,
  easeInOutCubic,
  knotBrand,
  knotStill,
  ropeBox,
  ropeCamera,
  ropeCameraAt,
  ropeCaps,
  ropeCinch,
  ropeDash,
  ropeDuration,
  ropeHead,
  ropeLap,
  ropeLapAt,
  ropePoint,
  ropePose,
  ropeRest,
  ropeRing,
  ropeSpan,
  ropeSwap,
  ropeW,
  type RopeMoment,
} from '../src/components/motion/knotMath';

const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);
const json = JSON.parse(readFileSync(repo('docs/design/brand/knot.json'), 'utf8'));
const pts = (d: string) => [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const knot = ROPE_PATHS.filter((p) => p.kind !== 'lead');
const byId = (id: string) => ROPE_PATHS.find((p) => p.id === id)!;
const close = (a: number[] | null, b: number[], digits = 3) => {
  expect(a).not.toBeNull();
  a!.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));
};

describe('rope geometry', () => {
  test('the generated module is knot.json', () => {
    expect(ROPE_PATHS.map((p) => ({ ...p }))).toEqual(json.rope.paths);
    expect(ROPE_HALOS.map((h) => ({ ...h, on: ROPE_PATHS[h.on].id }))).toEqual(json.rope.halos);
    expect(ROPE.light).toEqual(json.rope.light);
  });

  test('the seven segments of the spec, over and under by turns', () => {
    const table = knot.map((p) => [p.id, p.kind, p.from, p.length]);
    expect(table).toEqual([
      ['k0', 'over', 100, 11.07],
      ['k1', 'under', 111.07, 17.64],
      ['k2', 'over', 128.71, 15.7],
      ['k3', 'under', 144.41, 17.64],
      ['k4', 'over', 162.05, 15.69],
      ['k5', 'under', 177.74, 17.64],
      ['k6', 'over', 195.38, 4.62],
    ]);
    expect(knot.reduce((s, p) => s + p.length, 0)).toBeCloseTo(100, 6);
  });

  test('the six pieces of the still mark, unchanged', () => {
    for (let i = 0; i < 5; i++) expect(byId(`k${i + 1}`).d).toBe(KNOT_PIECES[i].d);
    // the last piece is k6 then k0, split where the rope starts
    const k6 = pts(byId('k6').d);
    const k0 = pts(byId('k0').d);
    expect([...k6, ...k0.slice(1)]).toEqual(pts(KNOT_PIECES[5].d));
    expect(k0[0]).toEqual(json.curve.origin);
  });

  test('one rope: each path starts where the last one ends, on the rope and on the page', () => {
    ROPE_PATHS.forEach((p, i) => {
      if (!i) return;
      const prev = ROPE_PATHS[i - 1];
      expect(prev.from + prev.length).toBeCloseTo(p.from, 6);
      expect(pts(prev.d).at(-1)).toEqual(pts(p.d)[0]);
    });
    expect(ROPE_PATHS.map((p) => p.id)).toEqual(['in', 'k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'out']);
    expect([ROPE_PATHS[0].from, ROPE_PATHS.at(-1)!.from + ROPE_PATHS.at(-1)!.length]).toEqual([-40, 350]);
  });

  test('one position is the same length everywhere on the rope', () => {
    const unit = ROPE_PATHS.map((p) => {
      const q = pts(p.d);
      let len = 0;
      for (let i = 1; i < q.length; i++) len += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
      return len / p.length;
    });
    // 205.34 in the 64 box for the knot's 100
    for (const u of unit) expect(Math.abs(u / 2.0534 - 1)).toBeLessThan(0.002);
  });

  test('the lead in is straight from the right; the lead out dips under the left lobe and leaves at y 60', () => {
    const lin = pts(byId('in').d);
    expect(lin.length).toBe(2);
    expect(lin[0][1]).toBe(lin[1][1]);
    expect(lin[0][0]).toBeGreaterThan(300);
    const out = pts(byId('out').d);
    expect(out.at(-1)![1]).toBe(60);
    expect(out.at(-1)![0]).toBeLessThan(-250);
    // under the left lobe: the knot's lowest point there is 52.37
    for (const [x, y] of out) if (x < 30 && x > 10) expect(y).toBeGreaterThan(57);
  });

  test('the halos sit on the over crossings, inside their over paths', () => {
    ROPE_HALOS.forEach((h, i) => {
      const p = ROPE_PATHS[h.on];
      expect(p.kind).toBe('over');
      expect(h.from + h.length / 2).toBeCloseTo([106.34, 139.68, 173.01][i], 2);
      expect(h.from).toBeGreaterThan(p.from);
      expect(h.from + h.length).toBeLessThan(p.from + p.length);
      expect(h.d).toBe(KNOT_HALOS[i].d);
      expect(h.from).toBeCloseTo(KNOT_HALOS[i].from + 100, 6);
    });
  });
});

describe('the window on each path', () => {
  test('straight, tied and half way', () => {
    // w = 0: all on the lead in
    expect(ropeSpan(byId('in'), 0, 100)).toEqual([40, 140]);
    for (const p of knot) expect(ropeSpan(p, 0, 100)).toBeNull();
    // w = 100: the knot, nothing on the leads
    for (const p of knot) close(ropeSpan(p, 100, 200), [0, p.length]);
    expect(ropeSpan(byId('in'), 100, 200)).toBeNull();
    expect(ropeSpan(byId('out'), 100, 200)).toBeNull();
    // w = 50: the end of the lead in, k0 to k2, part of k3
    close(ropeSpan(byId('in'), 50, 150), [90, 140]);
    close(ropeSpan(byId('k2'), 50, 150), [0, 15.7]);
    close(ropeSpan(byId('k3'), 50, 150), [0, 150 - 144.41]);
    expect(ropeSpan(byId('k4'), 50, 150)).toBeNull();
  });

  test('round the knot: a span past 200 wraps back to 100', () => {
    const lap = ropeLap(190);
    close(ropeRing(byId('k5'), ...lap)[0], [190 - 177.74, 17.64]);
    close(ropeRing(byId('k6'), ...lap)[0], [0, 4.62]);
    close(ropeRing(byId('k0'), ...lap)[0], [0, 6]);
    expect(ropeRing(byId('k1'), ...lap)).toEqual([]);
    // any lap is the same as one 100 on
    expect(ropeRing(byId('k0'), 290, 306)).toEqual(ropeRing(byId('k0'), ...lap));
    // a long span reaching both ends of one path: two parts
    const two = ropeRing(byId('k0'), 105, 202);
    expect(two.length).toBe(2);
    close(two[0], [0, 2]);
    close(two[1], [5, 11.07]);
  });

  test('the head light is the rope last 16; tied, it is the lap light at home', () => {
    expect(ropeHead(0)).toEqual([84, 100]);
    expect(ropeHead(100)).toEqual([184, 200]);
    for (const p of knot) {
      const head = ropeSpan(p, ...ropeHead(100));
      const lap = ropeRing(p, ...ropeLap(ROPE.light.home));
      expect(lap).toEqual(head ? [head] : []);
    }
    // the light at home is the still mark's: the last 16 of the knot, on k5 and k6
    close(ropeSpan(byId('k5'), ...ropeHead(100)), [184 - 177.74, 17.64]);
    close(ropeSpan(byId('k6'), ...ropeHead(100)), [0, 4.62]);
  });

  test('dashes: one part, two parts, none', () => {
    expect(ropeDash([[2, 5]], 10)).toEqual({ array: '3 11', offset: -2 });
    expect(ropeDash([[0, 2], [5, 11.07]], 11.07)).toEqual({ array: '2 3 6.07 12.07', offset: 0 });
    expect(ropeDash([], 10)).toBeNull();
  });
});

describe('moments', () => {
  const L = ROPE.launch;
  const tied = L.straight + L.move;

  test('launch: straight, tie in out cubic, cinch, one lap', () => {
    expect(ropeW(L, 0)).toBe(0);
    expect(ropeW(L, L.straight)).toBe(0);
    expect(ropeW(L, L.straight + L.move / 2)).toBeCloseTo(50, 6);
    expect(ropeW(L, L.straight + L.move / 4)).toBeCloseTo(100 * easeInOutCubic(0.25), 6);
    expect(ropeW(L, tied)).toBe(100);
    expect(ropeW(L, tied + 5000)).toBe(100);
    let last = -1;
    for (let t = 0; t <= tied; t += 10) {
      const w = ropeW(L, t);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
    expect(ropeLapAt(L, tied + L.lapAt)).toBe(184);
    expect(ropeLapAt(L, tied + L.lapAt + L.lap / 2)).toBeCloseTo(234, 6);
    expect(ropeLapAt(L, tied + L.lapAt + L.lap)).toBe(284);
    const p = ropePose('launch', 0);
    expect(p.fade).toBe(0);
    expect(ropePose('launch', L.fade).fade).toBe(1);
  });

  test('the spec timings', () => {
    expect([L.straight, L.move, L.cinch, L.lap]).toEqual([250, 1600, 450, 1000]);
    const R = ROPE.receive;
    expect([R.from, R.to, R.move, R.lap]).toEqual([-36, 100, 2700, 1260]);
    const S = ROPE.send;
    expect([S.from, S.to, S.move, S.easeIn]).toEqual([100, 250, 2500, 2.2]);
    expect([ROPE.run.loop, ROPE.run.length, ROPE.run.light]).toEqual([2400, 34, 10]);
    expect([ROPE.success.spin, ROPE.success.laps, ROPE.success.cinch]).toEqual([1500, 2, 450]);
    expect(ROPE.success.trail.opacity).toBe(0.32);
  });

  test('the head light and the lap light swap where they cover the same 16', () => {
    expect(ropeSwap(L, tied - 1)).toBe('head');
    expect(ropeSwap(L, tied)).toBe('lap');
    expect(ropeHead(ropeW(L, tied))).toEqual(ropeLap(ropeLapAt(L, tied)));
    const R = ROPE.receive;
    expect(ropeSwap(R, R.move - 1)).toBe('head');
    expect(ropeSwap(R, R.move)).toBe('lap');
    // send: the light leads the whole way
    for (const t of [0, 100, 1250, 2500, 4000]) expect(ropeSwap(ROPE.send, t)).toBe('head');
  });

  test('cinch: 1, .93, 1.025, 1', () => {
    expect(ropeCinch(-0.1)).toBe(1);
    expect(ropeCinch(0)).toBe(1);
    expect(ropeCinch(0.32)).toBeCloseTo(0.93, 6);
    expect(ropeCinch(0.68)).toBeCloseTo(1.025, 6);
    expect(ropeCinch(1)).toBe(1);
    expect(ropePose('launch', tied + 0.32 * L.cinch).cinch).toBeCloseTo(0.93, 6);
  });

  test('receive slides in from the right; send leaves to the left, slow then fast', () => {
    const R = ROPE.receive;
    expect(ropeW(R, 0)).toBe(-36);
    expect(ropeW(R, R.move)).toBe(100);
    // at -36 the whole rope is right of the send and receive view (it ends at x 96)
    const b = ropeBox(-36, 64)!;
    expect(b[0]).toBeGreaterThan(96);
    const S = ROPE.send;
    expect(ropeW(S, 0)).toBe(100);
    expect(ropeW(S, S.move / 2)).toBeCloseTo(100 + 150 * Math.pow(0.5, 2.2), 6);
    expect(ropeW(S, S.move)).toBe(250);
    // gone: left of the view (it starts at x -32)
    expect(ropeBox(250, 350)![2]).toBeLessThan(-32);
  });

  test('run: a 34 long piece with its 10 long light at the head, one lap per 2.4s', () => {
    const p0 = ropePose('run', 0);
    expect(p0.light).toBe('run');
    expect(p0.run).toBe(166);
    expect(ropePose('run', 2400).run).toBeCloseTo(266, 6);
    expect(ropePose('run', 1200).run).toBeCloseTo(216, 6);
    // it starts with its light ending where the home light ends
    expect(p0.run + ROPE.run.length).toBe(200);
  });

  test('success: two laps from home that slow into place, a trail, the cinch at the stop', () => {
    const S = ROPE.success;
    expect(ropePose('success', 0).lap).toBe(184);
    expect(ropePose('success', S.spin).lap).toBe(384);
    // fast, then slow into place: three quarters of the way in the first half of the time
    expect(ropePose('success', S.spin * 0.5).lap - 184).toBeGreaterThan(0.75 * 200);
    expect(ropePose('success', 0).trail).toBe(0);
    expect(ropePose('success', S.spin * 0.4).trail).toBe(1);
    expect(ropePose('success', S.spin).trail).toBe(0);
    expect(ropePose('success', S.cinchAt - 1).cinch).toBe(1);
    expect(ropePose('success', S.cinchAt + 0.32 * S.cinch).cinch).toBeCloseTo(0.93, 6);
    expect(ropePose('success', S.cinchAt + S.cinch).cinch).toBe(1);
  });

  test('how long each plays', () => {
    const d: Record<RopeMoment, number> = { launch: 3095, launchLong: 6080, receive: 4500, send: 2500, success: 1680, run: Infinity };
    for (const m of Object.keys(d) as RopeMoment[]) expect(ropeDuration(m)).toBe(d[m]);
  });

  test('every moment that ends tied ends at rest: the still mark', () => {
    const rest = ropeRest();
    for (const m of ['launch', 'launchLong', 'receive', 'success'] as RopeMoment[]) {
      const p = ropePose(m, ropeDuration(m));
      expect(p.w).toBe(100);
      expect(p.cinch).toBe(1);
      expect(p.trail).toBe(0);
      for (const k of knot) expect(ropeRing(k, ...ropeLap(p.lap))).toEqual(ropeRing(k, ...ropeLap(rest.lap)));
    }
  });
});

describe('where things are', () => {
  test('points along the rope', () => {
    close(ropePoint(100), json.curve.origin);
    close(ropePoint(200), json.curve.origin);
    close(ropePoint(-40), pts(byId('in').d)[0]);
    close(ropePoint(-100), pts(byId('in').d)[0]);
    close(ropePoint(350), pts(byId('out').d).at(-1)!);
    // half way along the straight lead in
    const [a, b] = pts(byId('in').d);
    close(ropePoint(30), [(a[0] + b[0]) / 2, a[1]]);
  });

  test('the box around the knot, and around a straight rope', () => {
    close(ropeBox(100, 200), [10, 11.65, 54, 52.37], 1);
    const b = ropeBox(0, 100)!;
    expect(b[1]).toBeCloseTo(52.37, 2);
    expect(b[3]).toBeCloseTo(52.37, 2);
    expect(b[2] - b[0]).toBeCloseTo(205.34, 0);
    expect(ropeBox(400, 500)).toBeNull();
  });

  test('round ends where the rope ends on an over path', () => {
    const at = (w: number) => ropeCaps({ ...ropeRest(), light: 'head', w });
    expect(at(105)).toEqual([105]);
    expect(at(120)).toEqual([]);
    expect(at(130)).toEqual([130]);
    expect(at(0)).toEqual([]);
    expect(at(-36)).toEqual([]);
    // the head on an over path: on k2 at 30 + 100
    expect(at(30)).toEqual([130]);
    // tied: the ends meet at the join of k6 and k0, two flat ends
    expect(ropeCaps(ropeRest())).toEqual([100]);
    // a run piece across that join
    expect(ropeCaps({ ...ropePose('run', 0), run: 180 })).toEqual([100]);
    // the run piece: 166 is on k4; its head at 200 ends k6, an over path
    expect(ropeCaps(ropePose('run', 0))).toEqual([166, 200]);
    // a head at the end of the lead in, a tail at the start of the lead out: round already
    expect(at(100 - 100)).toEqual([]);
    expect(at(200)).toEqual([]);
    // a head that just reached the end of k0
    expect(at(11.07)).toEqual([111.07]);
  });

  test('the launch camera: the straight rope fits, then it ends on the knot at scale 1', () => {
    const [vw, vh] = ROPE.camera.view;
    const start = ropeCameraAt(0, vw, vh, 5.2);
    // the board: scale .54, centered on the straight rope
    expect(start.s).toBeCloseTo(0.5416, 3);
    expect(start.y).toBeCloseTo(52.37, 2);
    expect(start.x).toBeCloseTo(146.6, 0);
    expect(ropeCameraAt(100, vw, vh, 5.2)).toEqual({ s: 1, x: 32, y: 32 });
    const L = ROPE.launch;
    const end = L.straight + L.move;
    expect(ropeCamera(L, 0, vw, vh, 5.2)).toEqual(start);
    expect(ropeCamera(L, end, vw, vh, 5.2)).toEqual({ s: 1, x: 32, y: 32 });
    // smooth: no jumps, never closer than 1, and the visible rope stays in view
    let prev = ropeCamera(L, 0, vw, vh, 5.2);
    for (let t = 0; t <= end + 300; t += 4) {
      const c = ropeCamera(L, t, vw, vh, 5.2);
      expect(c.s).toBeLessThanOrEqual(1);
      expect(Math.abs(c.s - prev.s)).toBeLessThan(0.01);
      expect(Math.hypot(c.x - prev.x, c.y - prev.y)).toBeLessThan(1.5);
      const w = ropeW(L, t);
      const b = ropeBox(w, w + 100)!;
      const left = vw / 2 + c.s * (b[0] - 2.6 - c.x);
      const right = vw / 2 + c.s * (b[2] + 2.6 - c.x);
      const top = vh / 2 + c.s * (b[1] - 2.6 - c.y);
      const bottom = vh / 2 + c.s * (b[3] + 2.6 - c.y);
      expect(left).toBeGreaterThan(0);
      expect(right).toBeLessThan(vw);
      expect(top).toBeGreaterThan(0);
      expect(bottom).toBeLessThan(vh);
      prev = c;
    }
  });
});

describe('the Knot settles into the mark', () => {
  test('brand: the light lets go from its tail until the home 16 is left', () => {
    const m = new KnotMotion('thinking', 0);
    // in the second loop, written to near the whole knot
    m.pose(3000 + 1400);
    m.set('brand', 3000 + 1400);
    const start = m.pose(3000 + 1400);
    const end = m.pose(3000 + 1400 + 2000);
    expect(end.head - end.tail).toBeCloseTo(16, 6);
    expect(end.head % 100).toBeCloseTo(0, 6);
    expect(end.light).toBe(1);
    // the head holds or moves on, the tail moves forward: no going back
    expect(end.head).toBeGreaterThanOrEqual(start.head);
    expect(end.tail).toBeGreaterThan(start.tail);
    expect(m.moving(3000 + 1400 + 2000)).toBe(false);
    expect(knotStill('brand')).toEqual(knotBrand());
    expect(new KnotMotion('brand', 0).pose(0)).toEqual(knotBrand());
  });
});
