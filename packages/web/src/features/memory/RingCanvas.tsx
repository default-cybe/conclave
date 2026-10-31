/**
 * Memory > Map, Rings view: the ring instrument (Tree / Rings / 3D). It is
 * also the 3D view's fallback without WebGL. Same
 * props as the 3D view plus the time cutoff, so MemoryMap, the tree,
 * filters and the drawer stay as they are.
 *
 * From the core out: every real link bundled through its area's anchor and
 * the core (ring-model.ts); the item ring, one tick per item, longer the
 * more it links, oldest to newest within its area; the area arcs with a
 * scale tick every 10 items and a long one every 100; the time bezel, a
 * tick per bin as long as the writes in it, with the cutoff handle.
 * Readouts are plain text lines in the corners. Neutral ink throughout;
 * --signal only for the picked item, search hits and the lock on.
 *
 * Fast with all ~3,000 items: links are drawn once into a cached canvas
 * (moved while the view moves, redrawn crisp 140 ms after), ticks and rings
 * are a few paths per frame, and labels are DOM buttons placed with a box
 * test, horizontal, never rotated. Motion: the brackets close on a found
 * item in 260 ms and one sweep runs once after a filter or time change;
 * reduced motion draws neither.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePageVisible, useReducedMotion } from '@/components/motion';
import { dprNow, isDark, onFrame, tokenRGB, useColorVersion } from '@/components/motion/frame';
import { EASE } from '@/components/motion/ease';
import { cn } from '@/lib/text';
import { clampView, pinch, wheelFactor, zoomAt, type View } from '@/features/map/view';
import type { Measure } from '@/features/map/layout';
import type { Insets } from '@/features/map/view';
import { edgeOn, type LinkFilter, type LinkLayout } from './link-model';
import { areaId, nodeLabel, type Indexed } from './graph-model';
import { angleTime, areaAtAngle, CORE, itemAtAngle, layoutHud, R, SEAM, timeAngle, type HudLayout } from './ring-model';
import './ring.css';

type RGB = [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const num = (n: number) => n.toLocaleString('en-US');
const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const DAY = 86_400_000;
const TAU = Math.PI * 2;
/** Screen offsets from the item ring, px: area arc, time bezel, labels. */
const OFF = { area: 17, time: 33, label: 50 } as const;
const SWEEP_MS = 1100;
const LOCK_MS = 260;

/** What the Rings and 3D views take from MemoryMap. */
export interface LinkViewProps {
  ix: Indexed;
  layout: LinkLayout;
  filter: LinkFilter;
  /** Items the time scrubber or the store filter steps back, by node index. */
  gone: (node: number) => boolean;
  hits: ReadonlySet<string>;
  /** The search hit Enter went to. */
  hit?: string;
  selected?: string;
  /** An item id or area:<name> under the pointer (or tapped, on a phone). */
  hover?: string;
  onHover: (id: string | undefined) => void;
  onPick: (id: string) => void;
  onArea: (name: string) => void;
  onBlank: () => void;
  insets: Insets;
  fit: number;
  zoom: { n: number; factor: number };
  phone: boolean;
  measure?: Measure;
  className?: string;
}

export interface HudCanvasProps extends LinkViewProps {
  time?: { at?: number; onAt: (t: number | undefined) => void };
}

interface Colors {
  fg: RGB;
  fg3: RGB;
  fg4: RGB;
  rule2: RGB;
  signal: RGB;
  bg: RGB;
  dark: boolean;
}

function trace(ctx: CanvasRenderingContext2D, pts: Float32Array) {
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 6) ctx.bezierCurveTo(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
}

const hudCache = new WeakMap<object, HudLayout>();

export function RingCanvas(props: HudCanvasProps) {
  const { ix, layout: L, filter, gone, hits, hit, selected, hover, onHover, onPick, onArea, onBlank, insets, fit, zoom, phone, measure, className, time } = props;
  const H = useMemo(() => {
    let h = hudCache.get(L);
    if (!h) {
      const t0 = performance.now();
      hudCache.set(L, (h = layoutHud(L, ix)));
      mark('memory-hud:layout', t0);
    }
    return h;
  }, [L, ix]);
  const deg = useMemo(() => Float32Array.from(L.items, (it) => ix.byId.get(it.id)?.degree ?? 0), [L, ix]);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const colorV = useColorVersion();
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 });
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const colors = useRef<Colors | null>(null);
  const [, setTick] = useState(0);
  const ticking = useRef(false);
  const wake = useRef<() => void>(() => {});
  const [timeDrag, setTimeDrag] = useState<number>();
  const timeHot = useRef(false);

  const on = useMemo(() => L.edges.map((e) => edgeOn(L, e, { ...filter, gone })), [L, filter, gone]);
  const focus = hover ?? selected ?? hit;
  const lit = useMemo(() => {
    if (!focus) return undefined;
    const out = new Set<number>();
    if (focus.startsWith('area:')) {
      const a = L.areas.find((x) => areaId(x.name) === focus);
      if (a) for (let i = a.from; i < a.to; i++) for (const e of L.edgesOf[i]) if (on[e]) out.add(e);
    } else {
      const i = L.byId.get(focus);
      if (i !== undefined) for (const e of L.edgesOf[i]) if (on[e]) out.add(e);
    }
    return out;
  }, [focus, L, on]);
  const near = useMemo(() => {
    const s = new Set<number>();
    for (const e of lit ?? []) (s.add(L.edges[e].a), s.add(L.edges[e].b));
    return s;
  }, [lit, L]);
  const litArea = focus?.startsWith('area:') ? H.areas.find((a) => areaId(a.name) === focus) : undefined;
  const lock = hit ?? selected;
  const anim = useRef({ sweep: 0, lock: 0 });
  const state = useRef({ on, lit, near, hits, selected, hit, gone, lock, litArea, cut: time?.at, timeDrag, labels: [] as Lbl[] });
  state.current = { ...state.current, on, lit, near, hits, selected, hit, gone, lock, litArea, cut: timeDrag ?? time?.at, timeDrag };

  // ----- the view -----------------------------------------------------------------
  const bounds = useMemo(() => ({ x: -R, y: -R, w: 2 * R, h: 2 * R }), []);
  const applyView = useCallback(
    (v: View) => {
      view.current = clampView(v, bounds, size.current.w, size.current.h, 120);
      if (!ticking.current) {
        ticking.current = true;
        requestAnimationFrame(() => ((ticking.current = false), setTick((t) => t + 1)));
      }
      wake.current();
    },
    [bounds],
  );
  const tween = useRef<(() => void) | null>(null);
  const panTo = useCallback(
    (to: View, ms = 450) => {
      tween.current?.();
      const from = view.current;
      if (reduced || !ms) return applyView(to);
      const start = performance.now();
      let stop: (() => void) | null = onFrame((t) => {
        const k = EASE.out(Math.min(1, (t - start) / ms));
        applyView({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, k: from.k + (to.k - from.k) * k });
        if (k >= 1) (stop?.(), (stop = null));
      });
      tween.current = () => (stop?.(), (stop = null));
    },
    [applyView, reduced],
  );
  // the rings and the labels outside them in the room between the bands; on a phone the labels go inside
  const fitAll = useCallback((): View => {
    const i = insetsRef.current;
    const { w, h } = size.current;
    const top = i.top + (phone ? 24 : 8);
    const bottom = i.bottom + 8;
    const left = i.left + (phone ? 0 : 150);
    const right = i.right + (phone ? 0 : 150);
    const ring = phone ? OFF.time + 12 : OFF.label + 22;
    const room = Math.min((w - left - right) / 2, (h - top - bottom) / 2) - ring;
    const k = Math.max(0.12, Math.min(2.5, room / R));
    return { x: left + (w - left - right) / 2, y: top + (h - top - bottom) / 2, k };
  }, [phone]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let first = true;
    const measureBox = () => {
      const r = el.getBoundingClientRect();
      size.current = { w: r.width, h: r.height };
      const c = canvas.current;
      if (c) {
        const dpr = dprNow();
        c.width = Math.round(r.width * dpr);
        c.height = Math.round(r.height * dpr);
        c.style.width = `${r.width}px`;
        c.style.height = `${r.height}px`;
      }
      base.current.key = '';
      if (first && r.width) {
        first = false;
        applyView(fitAll());
      } else applyView(view.current);
    };
    measureBox();
    const ro = new ResizeObserver(measureBox);
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyView, fitAll]);

  const firstFit = useRef(fit);
  useEffect(() => {
    if (fit !== firstFit.current) panTo(fitAll());
  }, [fit, panTo, fitAll]);
  const firstZoom = useRef(zoom.n);
  useEffect(() => {
    if (zoom.n === firstZoom.current) return;
    const { w, h } = size.current;
    panTo(zoomAt(view.current, w / 2, h / 2, zoom.factor), 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, panTo]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    colors.current = { fg: tokenRGB(el, '--fg'), fg3: tokenRGB(el, '--fg-3'), fg4: tokenRGB(el, '--fg-4'), rule2: tokenRGB(el, '--rule-2'), signal: tokenRGB(el, '--signal'), bg: tokenRGB(el, '--bg'), dark: isDark() };
    base.current.key = '';
    wake.current();
  }, [colorV]);

  // ----- drawing ------------------------------------------------------------------
  const base = useRef<{ key: string; cv?: HTMLCanvasElement; v?: View; idle?: number }>({ key: '' });
  const filterKey = useRef(0);
  useEffect(() => {
    filterKey.current++;
    base.current.key = '';
    // one sweep after the filters or the cutoff settle, never while the handle moves
    if (!reduced && timeDrag === undefined) anim.current.sweep = performance.now();
    wake.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  useEffect(() => {
    if (!reduced && lock) anim.current.lock = performance.now();
    wake.current();
  }, [lock, reduced]);
  useEffect(() => wake.current(), [lit, hits, selected, hit, timeDrag, time?.at]);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    let stop: (() => void) | null = null;
    const cosA = Float64Array.from(H.angle, Math.cos);
    const sinA = Float64Array.from(H.angle, Math.sin);
    const drawBase = (v: View, dpr: number, C: Colors) => {
      const b = base.current;
      const cv = b.cv ?? (b.cv = document.createElement('canvas'));
      if (cv.width !== c.width || cv.height !== c.height) (cv.width = c.width), (cv.height = c.height);
      const x = cv.getContext('2d')!;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, cv.width, cv.height);
      x.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
      x.lineCap = 'round';
      x.lineWidth = Math.max(0.6, Math.min(1.1, 0.9 * Math.sqrt(v.k))) / v.k;
      const { on } = state.current;
      for (const pass of [false, true]) {
        x.strokeStyle = rgba(C.fg, pass ? (C.dark ? 0.085 : 0.075) : C.dark ? 0.05 : 0.045);
        x.beginPath();
        for (let i = 0; i < L.edges.length; i++) if (on[i] && L.edges[i].cross === pass) trace(x, H.pts[i]);
        x.stroke();
      }
      b.key = `${v.x},${v.y},${v.k},${filterKey.current},${c.width}`;
      b.v = { ...v };
    };
    const draw = (now: number) => {
      const C = colors.current;
      if (!C) return;
      const t0 = performance.now();
      const v = view.current;
      const dpr = c.width / Math.max(1, size.current.w);
      const b = base.current;
      const key = `${v.x},${v.y},${v.k},${filterKey.current},${c.width}`;
      if (b.key !== key && (!b.cv || !b.v || b.key.split(',').slice(3).join(',') !== key.split(',').slice(3).join(','))) drawBase(v, dpr, C);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      const S = state.current;
      const { lit, near, hits, selected, hit, gone, on } = S;
      if (b.cv && b.v) {
        const s = v.k / b.v.k;
        ctx.globalAlpha = lit ? (C.dark ? 0.3 : 0.36) : 1;
        ctx.setTransform(s, 0, 0, s, dpr * (v.x - b.v.x * s), dpr * (v.y - b.v.y * s));
        ctx.drawImage(b.cv, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (b.key !== key) {
        window.clearTimeout(b.idle);
        b.idle = window.setTimeout(() => {
          drawBase(view.current, c.width / Math.max(1, size.current.w), colors.current!);
          wake.current();
        }, 140);
      }
      // screen space from here on: the center and the item ring's radius in px
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = v.x;
      const cy = v.y;
      const rr = R * v.k;
      ctx.lineCap = 'butt';

      // the core: an aperture the resting links pass under, the lit ones over
      const rc = R * CORE * v.k;
      ctx.fillStyle = rgba(C.bg, 0.86);
      ctx.beginPath();
      ctx.arc(cx, cy, rc, 0, TAU);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(C.rule2, 1);
      ctx.stroke();
      // the core's own scale: a tick toward each area's arc
      ctx.beginPath();
      for (const a of S.litArea ? [S.litArea] : H.areas) {
        const m = (a.a0 + a.a1) / 2;
        ctx.moveTo(cx + Math.cos(m) * rc, cy + Math.sin(m) * rc);
        ctx.lineTo(cx + Math.cos(m) * (rc + 5), cy + Math.sin(m) * (rc + 5));
      }
      ctx.stroke();

      // lit links over the core
      ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
      ctx.lineCap = 'round';
      if (lit?.size) {
        ctx.lineWidth = Math.max(0.9, Math.min(1.4, 1.2 * Math.sqrt(v.k))) / v.k;
        ctx.strokeStyle = rgba(C.fg, lit.size > 200 ? (C.dark ? 0.24 : 0.2) : C.dark ? 0.62 : 0.52);
        ctx.beginPath();
        for (const e of lit) trace(ctx, H.pts[e]);
        ctx.stroke();
      }
      const one = selected ?? hit;
      const oi = one ? L.byId.get(one) : undefined;
      if (oi !== undefined && (!props.hover || props.hover === one)) {
        ctx.lineWidth = Math.max(1, Math.min(1.6, 1.3 * Math.sqrt(v.k))) / v.k;
        ctx.strokeStyle = rgba(C.signal, 0.8);
        ctx.beginPath();
        for (const e of L.edgesOf[oi]) if (on[e]) trace(ctx, H.pts[e]);
        ctx.stroke();
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'butt';

      // the item ring
      const len = (i: number) => 3 + Math.min(9, 2.2 * Math.log2(1 + deg[i]));
      const tick = (i: number, extra = 0, from = 0) => {
        const l = len(i) + extra;
        ctx.moveTo(cx + cosA[i] * (rr + from), cy + sinA[i] * (rr + from));
        ctx.lineTo(cx + cosA[i] * (rr + l), cy + sinA[i] * (rr + l));
      };
      const plain = new Path2D();
      const faint = new Path2D();
      const sweep = anim.current.sweep ? (now - anim.current.sweep) / SWEEP_MS : 2;
      const sa = -Math.PI / 2 + Math.min(1, sweep) * TAU;
      const swept: number[] = [];
      for (let i = 0; i < L.items.length; i++) {
        const id = L.items[i].id;
        if (id === selected || id === hit || hits.has(id)) continue;
        const p = gone(L.items[i].node) || (lit && !near.has(i)) ? faint : plain;
        const l = len(i);
        p.moveTo(cx + cosA[i] * rr, cy + sinA[i] * rr);
        p.lineTo(cx + cosA[i] * (rr + l), cy + sinA[i] * (rr + l));
        // the sweep's wake: items it passed in the last 0.35 rad read full ink for a moment
        if (sweep < 1) {
          const d = (((sa - H.angle[i]) % TAU) + TAU) % TAU;
          if (d < 0.35) swept.push(i);
        }
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(C.fg3, C.dark ? 0.75 : 0.7);
      ctx.stroke(plain);
      ctx.strokeStyle = rgba(C.fg3, 0.2);
      ctx.stroke(faint);
      if (swept.length) {
        ctx.strokeStyle = rgba(C.fg, 0.9);
        ctx.beginPath();
        for (const i of swept) tick(i);
        ctx.stroke();
      }

      // area arcs with their scale: a tick every 10 items, a long one every 100
      const ra = rr + OFF.area;
      for (const a of H.areas) {
        const on = S.litArea === a;
        ctx.strokeStyle = on ? rgba(C.fg, 1) : rgba(C.fg3, S.litArea ? 0.45 : 0.9);
        ctx.lineWidth = on ? 2 : 1;
        ctx.beginPath();
        ctx.arc(cx, cy, ra, a.a0, a.a1);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.beginPath();
        a.items.forEach((i, m) => {
          if (m % 10 || (m === 0 && a.items.length < 10)) return;
          const l = m % 100 ? 3 : 6;
          ctx.moveTo(cx + cosA[i] * ra, cy + sinA[i] * ra);
          ctx.lineTo(cx + cosA[i] * (ra + l), cy + sinA[i] * (ra + l));
        });
        // the ends of the arc
        for (const e of [a.a0, a.a1]) {
          ctx.moveTo(cx + Math.cos(e) * (ra - 3), cy + Math.sin(e) * (ra - 3));
          ctx.lineTo(cx + Math.cos(e) * (ra + 3), cy + Math.sin(e) * (ra + 3));
        }
        ctx.stroke();
      }

      // the time bezel: writes per bin outward, month ticks inward, the cutoff handle
      const rt = rr + OFF.time;
      const lo = H.lo;
      const hi = H.hi;
      const cut = S.cut;
      const ca = timeAngle(cut ?? hi, lo, hi);
      const a0 = timeAngle(lo, lo, hi);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(C.rule2, 1);
      ctx.beginPath();
      ctx.arc(cx, cy, rt, a0, timeAngle(hi, lo, hi));
      ctx.stroke();
      if (cut !== undefined) {
        ctx.strokeStyle = rgba(C.fg, 0.9);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, rt, a0, ca);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      const max = Math.max(1, ...H.bins);
      const binA = (TAU - SEAM) / H.bins.length;
      const past = new Path2D();
      const after = new Path2D();
      H.bins.forEach((n, k) => {
        if (!n) return;
        const a = a0 + (k + 0.5) * binA;
        const l = 1.5 + 8 * Math.sqrt(n / max);
        const p = cut !== undefined && a > ca ? after : past;
        p.moveTo(cx + Math.cos(a) * (rt + 2), cy + Math.sin(a) * (rt + 2));
        p.lineTo(cx + Math.cos(a) * (rt + 2 + l), cy + Math.sin(a) * (rt + 2 + l));
      });
      ctx.strokeStyle = rgba(C.fg3, 0.9);
      ctx.stroke(past);
      ctx.strokeStyle = rgba(C.fg3, 0.25);
      ctx.stroke(after);
      ctx.strokeStyle = rgba(C.rule2, 1);
      ctx.beginPath();
      const d = new Date(lo);
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      for (d.setMonth(d.getMonth() + 1); d.getTime() < hi; d.setMonth(d.getMonth() + 1)) {
        const a = timeAngle(d.getTime(), lo, hi);
        const l = d.getMonth() === 0 ? 7 : 3.5;
        ctx.moveTo(cx + Math.cos(a) * rt, cy + Math.sin(a) * rt);
        ctx.lineTo(cx + Math.cos(a) * (rt - l), cy + Math.sin(a) * (rt - l));
      }
      ctx.stroke();
      // the handle: a radial bar across the bezel
      ctx.strokeStyle = rgba(C.fg, cut === undefined && !timeHot.current ? 0.55 : 1);
      ctx.lineWidth = timeHot.current || S.timeDrag !== undefined ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ca) * (rt - 7), cy + Math.sin(ca) * (rt - 7));
      ctx.lineTo(cx + Math.cos(ca) * (rt + 12), cy + Math.sin(ca) * (rt + 12));
      ctx.stroke();
      ctx.lineWidth = 1;

      // leader lines from item ticks out to their titles
      for (const l of S.labels) {
        if (l.kind !== 'item' || !l.lead) continue;
        ctx.strokeStyle = l.hit || l.selected ? rgba(C.signal, 0.9) : rgba(C.fg4, l.dim ? 0.3 : 0.7);
        ctx.beginPath();
        ctx.moveTo(l.lead[0], l.lead[1]);
        ctx.lineTo(l.lead[2], l.lead[3]);
        ctx.stroke();
      }

      // hits and the picked item: longer ticks in violet
      if (hits.size || selected) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(C.signal, 1);
        ctx.beginPath();
        for (const id of [...hits, ...(selected ? [selected] : [])]) {
          const i = L.byId.get(id);
          if (i !== undefined) tick(i, 5);
        }
        ctx.stroke();
      }
      // the lock: four corner brackets that close on the found or picked item
      const li = S.lock ? L.byId.get(S.lock) : undefined;
      let busy = false;
      if (li !== undefined) {
        const f = anim.current.lock ? Math.min(1, (now - anim.current.lock) / LOCK_MS) : 1;
        busy ||= f < 1;
        const s = 12 + (1 - EASE.out(f)) * 22;
        const px = cx + cosA[li] * (rr + 6);
        const py = cy + sinA[li] * (rr + 6);
        const arm = 5;
        ctx.strokeStyle = rgba(C.signal, 1);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          ctx.moveTo(px + sx * s, py + sy * (s - arm));
          ctx.lineTo(px + sx * s, py + sy * s);
          ctx.lineTo(px + sx * (s - arm), py + sy * s);
        }
        ctx.stroke();
      }
      // the sweep: one thin radial stroke, once
      if (sweep < 1) {
        busy = true;
        ctx.strokeStyle = rgba(C.fg, 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(sa) * rc, cy + Math.sin(sa) * rc);
        ctx.lineTo(cx + Math.cos(sa) * (rt + 12), cy + Math.sin(sa) * (rt + 12));
        ctx.stroke();
      } else anim.current.sweep = 0;
      mark(lit ? 'memory-hud:hover-draw' : 'memory-hud:draw', t0);
      if (!busy && stop) (stop(), (stop = null));
    };
    wake.current = () => {
      if (stop || !visible) return;
      stop = onFrame(draw);
    };
    wake.current();
    return () => {
      stop?.();
      stop = null;
      window.clearTimeout(base.current.idle);
      wake.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, L, ix, H, deg]);

  // ----- pointer ------------------------------------------------------------------
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  /** What is under a screen point: the bezel, an item tick, or an area arc. */
  const hitTest = (sx: number, sy: number, touch: boolean): { kind: 'time'; a: number } | { kind: 'item'; i: number } | { kind: 'area'; name: string } | undefined => {
    const v = view.current;
    const dx = sx - v.x;
    const dy = sy - v.y;
    const r = Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx);
    const rr = R * v.k;
    const pad = touch ? 8 : 0;
    if (time && Math.abs(r - (rr + OFF.time + 4)) < 9 + pad) return { kind: 'time', a };
    if (r > rr - 6 - pad && r < rr + 14 + pad / 2) {
      const i = itemAtAngle(H, a, (touch ? 14 : 8) / Math.max(1, r));
      if (i !== undefined) return { kind: 'item', i };
    }
    if (r >= rr + 10 && r < rr + OFF.area + 8 + pad) {
      const ar = areaAtAngle(H, a);
      if (ar) return { kind: 'area', name: ar.name };
    }
    return undefined;
  };
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.shiftKey && !e.ctrlKey) applyView({ ...view.current, x: view.current.x - (e.deltaY || e.deltaX) });
      else applyView(zoomAt(view.current, e.clientX - r.left, e.clientY - r.top, wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyView]);
  const pointers = useRef(new Map<number, [number, number]>());
  const drag = useRef<{ moved: boolean; x: number; y: number; time?: boolean } | null>(null);
  const setTime = (a: number) => setTimeDrag(angleTime(a, H.lo, H.hi));
  const settle = (t: number | undefined) => (t === undefined || H.hi - t < (H.hi - H.lo) * 0.01 ? undefined : Math.round(t));
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button,[role="slider"]')) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size !== 1) return;
    const h = hitTest(...p, e.pointerType !== 'mouse');
    drag.current = { moved: false, x: e.clientX, y: e.clientY, time: h?.kind === 'time' };
    if (h?.kind === 'time') {
      wrap.current?.setPointerCapture(e.pointerId);
      setTime(h.a);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const ps = pointers.current;
    const prev = ps.get(e.pointerId);
    if (!prev) {
      if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('button,[role="slider"]')) return;
      const h = hitTest(...local(e), false);
      const hot = h?.kind === 'time';
      if (hot !== timeHot.current) ((timeHot.current = hot), wake.current());
      if (wrap.current) wrap.current.style.cursor = hot ? 'grab' : h ? 'pointer' : '';
      const id = h?.kind === 'item' ? L.items[h.i].id : h?.kind === 'area' ? areaId(h.name) : undefined;
      if (id !== hover && (id || !hover?.startsWith('area:') || h === undefined)) onHover(id);
      return;
    }
    const next = local(e);
    const d = drag.current;
    if (d?.time) {
      const v = view.current;
      setTime(Math.atan2(next[1] - v.y, next[0] - v.x));
      return;
    }
    if (ps.size >= 2) {
      const ids = [...ps.keys()];
      const other = ps.get(ids[0] === e.pointerId ? ids[1] : ids[0])!;
      ps.set(e.pointerId, next);
      if (d) d.moved = true;
      applyView(pinch(view.current, prev, other, next, other));
      return;
    }
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    if (!d.moved) {
      d.moved = true;
      tween.current?.();
      wrap.current?.setPointerCapture(e.pointerId);
      wrap.current?.setAttribute('data-dragging', '');
    }
    ps.set(e.pointerId, next);
    applyView({ ...view.current, x: view.current.x + next[0] - prev[0], y: view.current.y + next[1] - prev[1] });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    const tap = d && !d.moved && pointers.current.size === 1;
    const p = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) return;
    drag.current = null;
    wrap.current?.removeAttribute('data-dragging');
    if (d?.time) {
      time?.onAt(settle(timeDrag));
      setTimeDrag(undefined);
      return;
    }
    if (!tap || !p) return;
    const h = hitTest(...p, e.pointerType !== 'mouse');
    if (h?.kind === 'item') onPick(L.items[h.i].id);
    else if (h?.kind === 'area') onArea(h.name);
    else onBlank();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,[role="slider"]')) return;
    if (e.key === 'Escape') return onBlank();
    const v = view.current;
    const { w, h } = size.current;
    const keys: Record<string, () => View | 'fit'> = {
      '+': () => zoomAt(v, w / 2, h / 2, 1.25),
      '=': () => zoomAt(v, w / 2, h / 2, 1.25),
      '-': () => zoomAt(v, w / 2, h / 2, 0.8),
      '0': () => 'fit',
      ArrowLeft: () => ({ ...v, x: v.x + 60 }),
      ArrowRight: () => ({ ...v, x: v.x - 60 }),
      ArrowUp: () => ({ ...v, y: v.y + 60 }),
      ArrowDown: () => ({ ...v, y: v.y - 60 }),
    };
    const f = keys[e.key];
    if (!f || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.startsWith('Arrow') && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const next = f();
    if (next === 'fit') panTo(fitAll());
    else applyView(next);
  };

  // ----- labels and readouts ------------------------------------------------------
  const labels = placeLabels(L, H, ix, deg, view.current, size.current, { phone, measure, focus, near, hits, hit, selected, insets });
  state.current.labels = labels;
  const read = readouts(L, H, ix, on, gone, focus, state.current.cut);
  const v = view.current;
  const rc = R * CORE * v.k;
  const cut = state.current.cut;
  const handleA = timeAngle(cut ?? H.hi, H.lo, H.hi);
  const rt = R * v.k + OFF.time;
  // the core is the whole memory: what exists at the cutoff, whatever is lit
  let shownItems = 0;
  for (let i = 0; i < L.items.length; i++) if (!gone(L.items[i].node) && !(cut !== undefined && H.at[i] > cut)) shownItems++;
  // the drawer narrows the room: the right column joins the left
  const narrow = !phone && insets.right > 120;

  return (
    <div
      ref={wrap}
      tabIndex={0}
      aria-label="Ring view: every item a tick on the ring, grouped into its area's arc, oldest to newest; every real link bundled through the core. The outer ring is time. Drag or the arrow keys move it, plus and minus zoom, 0 fits."
      className={cn('map-surface relative h-full w-full overflow-hidden outline-none', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={(e) => e.pointerType === 'mouse' && !pointers.current.size && hover && !hover.startsWith('area:') && onHover(undefined)}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0" />
      <div className="mm-overlay" role="group" aria-label={`${num(L.items.length)} items in ${L.areas.length} areas`}>
        {rc > 16 && (
          <div className="hud-core" style={{ transform: `translate(${v.x}px, ${v.y}px) translate(-50%, -50%)` }} aria-hidden>
            <span className="num hud-core-n">{num(shownItems)}</span>
            {rc > 28 && <span className="hud-core-w">items</span>}
          </div>
        )}
        {labels.map((b) => (
          <HudLabel key={b.id} b={b} onPick={onPick} onArea={onArea} onHover={onHover} />
        ))}
        {time && (
          <div
            role="slider"
            tabIndex={0}
            aria-label="Show memory as it was on a day"
            aria-valuemin={H.lo}
            aria-valuemax={H.hi}
            aria-valuenow={Math.round(cut ?? H.hi)}
            aria-valuetext={cut === undefined ? 'Everything' : `Up to ${day(cut)}`}
            className="hud-handle"
            style={{ transform: `translate(${v.x + Math.cos(handleA) * (rt + 3)}px, ${v.y + Math.sin(handleA) * (rt + 3)}px) translate(-50%, -50%)` }}
            onKeyDown={(e) => {
              const c = time.at ?? H.hi;
              const step = (e.shiftKey ? 30 : 7) * DAY;
              let next: number | undefined | null = null;
              if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(H.lo, c - step);
              else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = settle(Math.min(H.hi, c + step));
              else if (e.key === 'Home') next = H.lo;
              else if (e.key === 'End') next = undefined;
              if (next === null) return;
              e.preventDefault();
              e.stopPropagation();
              time.onAt(next);
            }}
          />
        )}
      </div>
      <Readouts read={read} phone={phone} quiet={!!hover} narrow={narrow} insets={insets} cut={cut} onAll={time && time.at !== undefined ? () => time.onAt(undefined) : undefined} lo={H.lo} hi={H.hi} />
    </div>
  );
}

function mark(name: string, t0: number) {
  try {
    performance.clearMeasures(name);
    performance.measure(name, { start: t0, end: performance.now() });
  } catch {
    /* old browsers */
  }
}

// ----- readouts --------------------------------------------------------------------
interface Read {
  /** What the numbers describe: everything, an area or an item. */
  subject?: string;
  items: number;
  links: number;
  cross: number;
  /** Links per item. */
  density: number;
  last?: number;
  /** An item's links out and in. */
  out?: number;
  in?: number;
  /** Areas reached, most first. */
  top: Array<[string, number]>;
}

function readouts(L: HudCanvasProps['layout'], H: HudLayout, ix: Indexed, on: boolean[], gone: (n: number) => boolean, focus: string | undefined, cut: number | undefined): Read {
  const area = focus?.startsWith('area:') ? L.areas.findIndex((a) => areaId(a.name) === focus) : -1;
  const item = focus && area < 0 ? L.byId.get(focus) : undefined;
  const mine = (i: number) => (area >= 0 ? L.items[i].area === area : item !== undefined ? i === item : true);
  let items = 0;
  let last = 0;
  for (let i = 0; i < L.items.length; i++) {
    // the cutoff counts while the handle moves, before the map's filter catches up
    if (!mine(i) || gone(L.items[i].node) || (cut !== undefined && H.at[i] > cut)) continue;
    items++;
    last = Math.max(last, H.at[i]);
  }
  let links = 0;
  let cross = 0;
  let out = 0;
  let inn = 0;
  const to = new Map<number, number>();
  L.edges.forEach((e, k) => {
    if (!on[k]) return;
    const a = mine(e.a);
    const b = mine(e.b);
    if (!a && !b) return;
    if (cut !== undefined && (H.at[e.a] > cut || H.at[e.b] > cut)) return;
    links++;
    if (e.cross) cross++;
    if (item !== undefined) (e.a === item ? out++ : inn++);
    const other = a ? e.b : e.a;
    if (focus && L.items[other].area !== (area >= 0 ? area : L.items[item!].area)) to.set(L.items[other].area, (to.get(L.items[other].area) ?? 0) + 1);
  });
  const subject = area >= 0 ? L.areas[area].name : item !== undefined ? nodeLabel(ix.byId.get(focus!)!) : undefined;
  return {
    subject,
    items,
    links,
    cross,
    density: items ? links / items : 0,
    last: last || undefined,
    ...(item !== undefined ? { out, in: inn } : {}),
    top: [...to].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([a, n]) => [L.areas[a].name, n]),
  };
}

function Readouts({ read: r, phone, quiet, narrow, insets, cut, onAll, lo, hi }: { read: Read; phone: boolean; quiet: boolean; narrow: boolean; insets: HudCanvasProps['insets']; cut?: number; onAll?: () => void; lo: number; hi: number }) {
  const pct = r.links ? Math.round((100 * r.cross) / r.links) : 0;
  const when = cut !== undefined ? `Up to ${day(cut)}` : 'All time';
  // a phone's header already says what the pointer lights
  if (phone && quiet) return null;
  if (phone)
    return (
      <p className="hud-line" style={{ top: insets.top + 2, left: insets.left, right: insets.right }} aria-live="polite">
        {r.subject && <span className="text-fg">{r.subject}: </span>}
        <span className="num">{num(r.items)}</span> items, <span className="num">{num(r.links)}</span> links, <span className="num">{pct}%</span> across
        {r.out !== undefined && (
          <>
            , <span className="num">{r.out}</span> out <span className="num">{r.in}</span> in
          </>
        )}
        . {when}
        {onAll && (
          <>
            {' '}
            <button type="button" className="hud-all" onClick={onAll}>
              Show all
            </button>
          </>
        )}
      </p>
    );
  const row = (k: string, val: React.ReactNode) => (
    <div className="hud-row">
      <dt>{k}</dt>
      <dd className="num">{val}</dd>
    </div>
  );
  const ratios = (
    <>
      {row('Across areas', `${pct}%`)}
      {row('Links per item', r.density.toFixed(2))}
      {r.top.map(([a, n]) => row(`To ${a}`, num(n)))}
    </>
  );
  const clock = (
    <>
      <div className="hud-row">
        <span className="text-fg-3">Time</span>
        <span className={cn('num', cut !== undefined && 'text-fg')}>{when}</span>
      </div>
      {onAll && (
        <button type="button" className="hud-all" onClick={onAll}>
          Show all
        </button>
      )}
    </>
  );
  return (
    <>
      <dl className="hud-read" style={{ top: insets.top + 8, left: insets.left }} aria-live="polite">
        <div className="hud-subject">{r.subject ?? 'All memory'}</div>
        {row('Items', num(r.items))}
        {row('Links', num(r.links))}
        {r.out !== undefined && row('Out / in', `${r.out} / ${r.in}`)}
        {narrow && ratios}
      </dl>
      {!narrow && (
        <dl className="hud-read hud-right" style={{ top: insets.top + 8, right: insets.right }}>
          {ratios}
        </dl>
      )}
      <dl className="hud-read" style={{ bottom: insets.bottom + 8, left: insets.left }}>
        {row('Last write', r.last ? day(r.last) : 'none')}
        {row('Span', `${day(lo)} to ${day(hi)}`)}
        {narrow && clock}
      </dl>
      {!narrow && (
        <div className="hud-read hud-right" style={{ bottom: insets.bottom + 8, right: insets.right }}>
          {clock}
        </div>
      )}
    </>
  );
}

// ----- labels ----------------------------------------------------------------------
interface Lbl {
  id: string;
  kind: 'area' | 'item';
  title: string;
  count?: string;
  x: number;
  y: number;
  w: number;
  align: 'start' | 'end' | 'center';
  lit?: boolean;
  hit?: boolean;
  selected?: boolean;
  dim?: boolean;
  /** Screen line from the tick to the title. */
  lead?: [number, number, number, number];
  aria: string;
}

const ranks = new WeakMap<HudLayout, number[]>();

/**
 * Labels at screen size, horizontal: area names and counts just outside
 * the bezel (inside the ring when there is no room out there, as on a
 * phone), then item titles out past the bezel on a leader line: the picked
 * item, the found one, the search hits, the lit links' far ends, then the
 * most linked, each only where it does not touch another.
 */
function placeLabels(L: HudCanvasProps['layout'], H: HudLayout, ix: Indexed, deg: Float32Array, v: View, s: { w: number; h: number }, o: { phone: boolean; measure?: HudCanvasProps['measure']; focus?: string; near: Set<number>; hits: ReadonlySet<string>; hit?: string; selected?: string; insets: HudCanvasProps['insets'] }): Lbl[] {
  const out: Lbl[] = [];
  if (!s.w) return out;
  const boxes: Array<[number, number, number, number]> = [];
  const top = o.insets.top + (o.phone ? 22 : 0);
  const bottom = s.h - o.insets.bottom;
  const right = s.w - Math.max(2, o.insets.right - 24);
  const inside = (x: number, y: number, w: number, h: number) => x >= 2 && x + w <= right && y >= top && y + h <= bottom;
  const free = (x: number, y: number, w: number, h: number) => !boxes.some(([a, b, c, d]) => x < a + c && a < x + w && y < b + d && b < y + h);
  const meas = o.measure ?? ((t: string, f: 'name' | 'title' | 'meta') => t.length * (f === 'name' ? 8 : 7) + 12);
  const cx = v.x;
  const cy = v.y;
  const rr = R * v.k;
  /** A box hung off a point at angle a: right of it on the right, left on the left, above or below at the top and bottom. */
  const hang = (a: number, r: number, w: number, h: number, inward = false) => {
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const px = cx + c * r;
    const py = cy + sn * r;
    const dir = inward ? -1 : 1;
    if (c * dir > 0.35) return { x: px, y: py - h / 2, align: 'start' as const, px, py };
    if (c * dir < -0.35) return { x: px - w, y: py - h / 2, align: 'end' as const, px, py };
    return { x: px - w / 2, y: sn * dir > 0 ? py : py - h, align: 'center' as const, px, py };
  };

  // the core keeps its room
  const rc = R * CORE * v.k;
  boxes.push([cx - rc, cy - rc, 2 * rc, 2 * rc]);

  for (const a of [...H.areas].sort((x, y) => y.items.length - x.items.length)) {
    const id = areaId(a.name);
    const count = num(a.items.length);
    const w = meas(a.name, 'name') + meas(count, 'meta') - 6;
    const lit = o.focus === id;
    const m = (a.a0 + a.a1) / 2;
    let put = false;
    for (const [r, inward] of [[rr + OFF.label - 4, false], [rr + OFF.label + 14, false], [rr - 16, true], [rr - 40, true]] as const) {
      const b = hang(m, r, w, 20, inward);
      if (!inside(b.x, b.y, w, 20) || (!free(b.x, b.y, w, 20) && !lit)) continue;
      boxes.push([b.x, b.y, w, 20]);
      out.push({ id, kind: 'area', title: a.name, count, x: b.x, y: b.y + 10, w, align: b.align, lit, aria: `${a.name}, ${count} items` });
      put = true;
      break;
    }
    if (!put && lit) {
      const b = hang(m, rr - 16, w, 20, true);
      out.push({ id, kind: 'area', title: a.name, count, x: b.x, y: b.y + 10, w, align: b.align, lit, aria: `${a.name}, ${count} items` });
    }
  }

  const max = o.phone ? 150 : 170;
  const len = (i: number) => 3 + Math.min(9, 2.2 * Math.log2(1 + deg[i]));
  const put = (i: number, forced: boolean) => {
    const it = L.items[i];
    const n = ix.byId.get(it.id)!;
    const title = nodeLabel(n);
    const w = Math.min(max, meas(title, 'title') - 8);
    if (w < 40 && !forced) return;
    const a = H.angle[i];
    const b = hang(a, rr + OFF.label, w, 16);
    let { x, y } = b;
    if (!inside(x, y, w, 16) || !free(x - 2, y - 1, w + 4, 18)) {
      if (!forced) return;
      // the picked or found item always reads: pulled into the view, its leader follows
      x = Math.max(4, Math.min(right - 4 - w, x));
      y = Math.max(top + 2, Math.min(bottom - 18, y));
    }
    boxes.push([x - 2, y - 1, w + 4, 18]);
    const ax = b.align === 'start' ? x : b.align === 'end' ? x + w : x + w / 2;
    const ay = b.align === 'center' ? (y < cy ? y + 16 : y) : y + 8;
    const from = rr + len(i) + 2;
    const sel = o.selected === it.id || o.hit === it.id;
    out.push({
      id: it.id,
      kind: 'item',
      title,
      x,
      y: y + 8,
      w,
      align: b.align,
      hit: o.hits.has(it.id),
      selected: sel,
      dim: !!o.focus && !o.near.has(i) && o.focus !== it.id && !sel && !o.hits.has(it.id),
      lead: [cx + Math.cos(a) * from, cy + Math.sin(a) * from, ax, ay],
      aria: `${n.title}, ${L.areas[it.area].name}, ${n.degree} links`,
    });
  };
  const done = new Set<number>();
  for (const id of [o.selected, o.hit, o.focus && !o.focus.startsWith('area:') ? o.focus : undefined]) {
    const i = id ? L.byId.get(id) : undefined;
    if (i !== undefined && !done.has(i)) (done.add(i), put(i, true));
  }
  for (const id of o.hits) {
    const i = L.byId.get(id);
    if (i !== undefined && !done.has(i)) (done.add(i), put(i, false));
  }
  for (const i of [...o.near].sort((a, b) => deg[b] - deg[a]).slice(0, 60)) if (!done.has(i)) (done.add(i), put(i, false));
  if (!o.focus) {
    let r = ranks.get(H);
    if (!r) ranks.set(H, (r = L.items.map((_, i) => i).sort((a, b) => deg[b] - deg[a])));
    // at rest a phone shows no titles: there is no room out past the bezel
    if (!o.phone || v.k > 0.8) for (const i of r.slice(0, 400)) if (!done.has(i)) (done.add(i), put(i, false));
  }
  return out;
}

const HudLabel = memo(function HudLabel({ b, onPick, onArea, onHover }: { b: Lbl; onPick: (id: string) => void; onArea: (name: string) => void; onHover: (id: string | undefined) => void }) {
  const style = { transform: `translate(${b.x}px, ${b.y}px) translateY(-50%)`, width: b.w, justifyContent: b.align === 'end' ? 'flex-end' : b.align === 'center' ? 'center' : 'flex-start' } as const;
  if (b.kind === 'item')
    return (
      <button
        type="button"
        className="hud-item"
        style={{ ...style, textAlign: b.align === 'end' ? 'right' : b.align === 'center' ? 'center' : 'left' }}
        data-dim={b.dim || undefined}
        data-hit={b.hit || undefined}
        data-selected={b.selected || undefined}
        aria-label={b.aria}
        aria-pressed={!!b.selected}
        onClick={() => onPick(b.id)}
        onPointerEnter={(e) => e.pointerType === 'mouse' && onHover(b.id)}
      >
        {b.title}
      </button>
    );
  return (
    <button
      type="button"
      className="hud-area"
      style={style}
      data-lit={b.lit || undefined}
      aria-label={b.aria}
      aria-pressed={!!b.lit}
      onClick={() => onArea(b.title)}
      onPointerEnter={(e) => e.pointerType === 'mouse' && onHover(b.id)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onHover(undefined)}
    >
      <span className="hud-name">{b.title}</span>
      <span className="mm-count num">{b.count}</span>
    </button>
  );
});
