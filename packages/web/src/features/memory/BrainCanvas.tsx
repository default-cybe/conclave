/**
 * Memory > Map, Brain view: every item on the outline of two hemispheres,
 * every real link a curve bundled through its areas (brain-model.ts), so
 * busy pairs of areas show as tracts. Links on a canvas in neutral ink,
 * thin and see-through, so many over one another read darker, like white
 * matter. The resting picture is drawn once into a second canvas; pans
 * and zooms move that picture and redraw it crisp when they stop, and
 * hover only dims it and draws the lit links on top, so both stay fast
 * with all ~3,000 items and links. Labels are DOM at screen size: the
 * brain, the areas (lobes) inside the outline, and item titles running
 * outward from it where they have room, the most linked first. Violet
 * (--signal) only marks the picked item and search hits.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { usePageVisible, useReducedMotion } from '@/components/motion';
import { dprNow, isDark, onFrame, tokenRGB, useColorVersion } from '@/components/motion/frame';
import { EASE } from '@/components/motion/ease';
import { cn } from '@/lib/text';
import type { Measure } from '@/features/map/layout';
import { clampView, fitView, pinch, wheelFactor, zoomAt, type Insets, type View } from '@/features/map/view';
import { edgeOn, FISSURE, RX, RY, type BrainFilter, type BrainLayout } from './brain-model';
import { areaId, nodeLabel, type Indexed } from './graph-model';

type RGB = [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const num = (n: number) => n.toLocaleString('en-US');
/** Item titles (12px on screen, memory-map.css .mb-item) shorter than this are left out. */
const MIN_W = 40;
/** Room an item title needs along the outline, on screen. */
const PITCH = 17;

export interface BrainCanvasProps {
  ix: Indexed;
  layout: BrainLayout;
  filter: BrainFilter;
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

interface Colors {
  fg: RGB;
  fg3: RGB;
  rule2: RGB;
  signal: RGB;
  dark: boolean;
}

/** Stroke a bundled curve's path. */
function trace(ctx: CanvasRenderingContext2D, pts: Float32Array) {
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 6) ctx.bezierCurveTo(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
}

export function BrainCanvas(props: BrainCanvasProps) {
  const { ix, layout: L, filter, gone, hits, hit, selected, hover, onHover, onPick, onArea, onBlank, insets, fit, zoom, phone, measure, className } = props;
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

  // the links the filters leave, and what is lit: the hovered item or area, else the picked item, else the search hit
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
  // the items at the far end of the lit links: their titles claim room first
  const near = useMemo(() => {
    const s = new Set<number>();
    for (const e of lit ?? []) (s.add(L.edges[e].a), s.add(L.edges[e].b));
    return s;
  }, [lit, L]);
  const state = useRef({ on, lit, near, hits, selected, hit, gone });
  state.current = { on, lit, near, hits, selected, hit, gone };

  // ----- the view -----------------------------------------------------------------
  const applyView = useCallback((v: View) => {
    const c = clampView(v, L.bounds, size.current.w, size.current.h, 120);
    view.current = c;
    if (!ticking.current) {
      ticking.current = true;
      requestAnimationFrame(() => ((ticking.current = false), setTick((t) => t + 1)));
    }
    wake.current();
  }, [L]);
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
  // the brain with room for the titles around it
  const fitAll = useCallback((): View => {
    // titles run out from the outline: room for them at the sides; above and below, titles that would leave the view are left out
    const i = insetsRef.current;
    const side = phone ? 8 : 150;
    return fitView(L.bounds, size.current.w, size.current.h, { top: i.top + 24, bottom: i.bottom + 24, left: i.left + side, right: i.right + side }, 3);
  }, [L, phone]);

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
    colors.current = { fg: tokenRGB(el, '--fg'), fg3: tokenRGB(el, '--fg-3'), rule2: tokenRGB(el, '--rule-2'), signal: tokenRGB(el, '--signal'), dark: isDark() };
    base.current.key = '';
    wake.current();
  }, [colorV]);

  // ----- drawing ------------------------------------------------------------------
  // the resting links, drawn once per view and filter into their own canvas
  const base = useRef<{ key: string; cv?: HTMLCanvasElement; v?: View; idle?: number }>({ key: '' });
  const filterKey = useRef(0);
  useEffect(() => {
    filterKey.current++;
    base.current.key = '';
    wake.current();
  }, [on]);
  useEffect(() => wake.current(), [lit, hits, selected, hit]);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    let stop: (() => void) | null = null;
    let first = true;
    const drawBase = (v: View, dpr: number, C: Colors) => {
      const b = base.current;
      const cv = b.cv ?? (b.cv = document.createElement('canvas'));
      if (cv.width !== c.width || cv.height !== c.height) (cv.width = c.width), (cv.height = c.height);
      const x = cv.getContext('2d')!;
      const t0 = performance.now();
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, cv.width, cv.height);
      x.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
      x.lineCap = 'round';
      const { on } = state.current;
      // within an area: lighter; across: the tracts
      const w = Math.max(0.6, Math.min(1.1, 0.9 * Math.sqrt(v.k))) / v.k;
      x.lineWidth = w;
      for (const pass of [false, true]) {
        x.strokeStyle = rgba(C.fg, pass ? (C.dark ? 0.085 : 0.075) : C.dark ? 0.05 : 0.045);
        for (let i = 0; i < L.edges.length; i++) {
          const e = L.edges[i];
          if (!on[i] || e.cross !== pass) continue;
          x.beginPath();
          trace(x, e.pts);
          x.stroke();
        }
      }
      b.key = `${v.x},${v.y},${v.k},${filterKey.current},${c.width}`;
      b.v = { ...v };
      if (first) {
        first = false;
        mark('memory-brain:first-links', t0);
      }
    };
    const draw = () => {
      const C = colors.current;
      if (!C) return;
      const t0 = performance.now();
      const v = view.current;
      const dpr = c.width / Math.max(1, size.current.w);
      const b = base.current;
      const key = `${v.x},${v.y},${v.k},${filterKey.current},${c.width}`;
      const moving = b.key !== key;
      // while the view moves, the last picture moves with it; once it rests, the links are drawn again, crisp
      if (moving && (!b.cv || !b.v || b.key.split(',').slice(3).join(',') !== key.split(',').slice(3).join(','))) drawBase(v, dpr, C);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      const { lit, hits, selected, hit, gone, on } = state.current;
      if (b.cv && b.v) {
        const s = v.k / b.v.k;
        ctx.globalAlpha = lit ? (C.dark ? 0.32 : 0.38) : 1;
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
      ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
      ctx.lineCap = 'round';
      // the two hemispheres, faint, a little out from the ticks
      ctx.lineWidth = 1 / v.k;
      ctx.strokeStyle = rgba(C.rule2, 1);
      ctx.beginPath();
      for (const sd of [-1, 1] as const) {
        const g = 14 / Math.max(1, Math.sqrt(v.k));
        ctx.moveTo(sd * FISSURE, -(RY + g));
        ctx.ellipse(sd * FISSURE, 0, RX + g, RY + g, 0, sd === 1 ? -Math.PI / 2 : Math.PI / 2, sd === 1 ? Math.PI / 2 : (3 * Math.PI) / 2);
        ctx.closePath();
      }
      ctx.stroke();
      // the lit links, strong
      if (lit?.size) {
        ctx.lineWidth = Math.max(0.9, Math.min(1.4, 1.2 * Math.sqrt(v.k))) / v.k;
        ctx.strokeStyle = rgba(C.fg, lit.size > 200 ? (C.dark ? 0.22 : 0.2) : C.dark ? 0.6 : 0.5);
        ctx.beginPath();
        for (const e of lit) trace(ctx, L.edges[e].pts);
        ctx.stroke();
      }
      // the outline: a tick per item, longer the more it links; the picked item and hits in violet
      const tick = (i: number) => {
        const it = L.items[i];
        const d = ix.byId.get(it.id)!.degree;
        const len = (3 + Math.min(9, 2.2 * Math.log2(1 + d))) / Math.max(1, Math.sqrt(v.k));
        ctx.moveTo(it.x, it.y);
        ctx.lineTo(it.x + it.nx * len, it.y + it.ny * len);
      };
      const faint: number[] = [];
      const plain: number[] = [];
      const { near } = state.current;
      for (let i = 0; i < L.items.length; i++) {
        const id = L.items[i].id;
        if (id === selected || id === hit || hits.has(id)) continue;
        (gone(L.items[i].node) || (lit && !near.has(i)) ? faint : plain).push(i);
      }
      ctx.lineWidth = 1 / v.k;
      ctx.strokeStyle = rgba(C.fg3, C.dark ? 0.75 : 0.7);
      ctx.beginPath();
      for (const i of plain) tick(i);
      ctx.stroke();
      ctx.strokeStyle = rgba(C.fg3, 0.22);
      ctx.beginPath();
      for (const i of faint) tick(i);
      ctx.stroke();
      if (hits.size || selected) {
        ctx.lineWidth = 2 / v.k;
        ctx.strokeStyle = rgba(C.signal, 1);
        ctx.beginPath();
        for (const id of [...hits, ...(selected ? [selected] : [])]) {
          const i = L.byId.get(id);
          if (i !== undefined) tick(i);
        }
        ctx.stroke();
        // the picked or found item's own links in violet: what it connects to
        const one = selected ?? hit;
        const i = one ? L.byId.get(one) : undefined;
        if (i !== undefined && (!hover || hover === one)) {
          ctx.lineWidth = Math.max(1, Math.min(1.6, 1.3 * Math.sqrt(v.k))) / v.k;
          ctx.strokeStyle = rgba(C.signal, 0.75);
          ctx.beginPath();
          for (const e of L.edgesOf[i]) if (on[e]) trace(ctx, L.edges[e].pts);
          ctx.stroke();
        }
      }
      mark(lit ? 'memory-brain:hover-draw' : 'memory-brain:draw', t0);
      if (stop) (stop(), (stop = null));
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
  }, [visible, L, ix]);

  // ----- pointer ------------------------------------------------------------------
  /** The item whose tick is nearest a screen point, within `r` px. */
  const itemAt = (sx: number, sy: number, r: number): number | undefined => {
    const v = view.current;
    const wx = (sx - v.x) / v.k;
    const wy = (sy - v.y) / v.k;
    let best: number | undefined;
    let bd = (r / v.k) ** 2;
    for (let i = 0; i < L.items.length; i++) {
      const it = L.items[i];
      // the tick runs outward from the outline: measure to a point a little out on it
      const o = 4 / Math.sqrt(Math.max(1, v.k));
      const d = (it.x + it.nx * o - wx) ** 2 + (it.y + it.ny * o - wy) ** 2;
      if (d < bd) (bd = d), (best = i);
    }
    return best;
  };
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
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
  const drag = useRef<{ moved: boolean; x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) drag.current = { moved: false, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const ps = pointers.current;
    const prev = ps.get(e.pointerId);
    if (!prev) {
      // hover: the item under a mouse, unless a label is under it
      if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('button')) return;
      const i = itemAt(...local(e), 9);
      const id = i === undefined ? undefined : L.items[i].id;
      if (id !== hover && (id || !hover?.startsWith('area:'))) onHover(id);
      return;
    }
    const next = local(e);
    if (ps.size >= 2) {
      const ids = [...ps.keys()];
      const other = ps.get(ids[0] === e.pointerId ? ids[1] : ids[0])!;
      ps.set(e.pointerId, next);
      if (drag.current) drag.current.moved = true;
      applyView(pinch(view.current, prev, other, next, other));
      return;
    }
    const d = drag.current;
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
    const tap = drag.current && !drag.current.moved && pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) return;
    drag.current = null;
    wrap.current?.removeAttribute('data-dragging');
    if (!tap || (e.target as HTMLElement).closest('button')) return;
    const i = itemAt(...local(e), e.pointerType === 'mouse' ? 9 : 16);
    if (i !== undefined) onPick(L.items[i].id);
    else onBlank();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input')) return;
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

  // ----- labels -------------------------------------------------------------------
  const labels = placeLabels(L, ix, view.current, size.current, { phone, measure, focus, near, hits, hit, selected, insets });

  return (
    <div
      ref={wrap}
      tabIndex={0}
      aria-label="Brain view: every item on the outline of two hemispheres, grouped by area, and its links bundled through the middle. Drag or the arrow keys move it, plus and minus zoom, 0 fits."
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
        {labels.map((b) => (
          <BrainLabel key={b.id} b={b} onPick={onPick} onArea={onArea} onHover={onHover} dim={!!focus && b.kind === 'item' && !b.near && b.id !== focus} />
        ))}
      </div>
    </div>
  );
}

/** Keep the last time a step took, for the owner's checks (performance.getEntriesByName). */
function mark(name: string, t0: number) {
  try {
    performance.clearMeasures(name);
    performance.measure(name, { start: t0, end: performance.now() });
  } catch {
    /* old browsers */
  }
}

interface BLabel {
  id: string;
  kind: 'brain' | 'area' | 'item';
  title: string;
  count?: string;
  x: number;
  y: number;
  w: number;
  /** item: the angle it runs out at; flip: it reads right to left of its anchor. */
  angle?: number;
  flip?: boolean;
  /** area: which side its anchor is on. */
  align?: 'start' | 'end' | 'center';
  near?: boolean;
  hit?: boolean;
  selected?: boolean;
  lit?: boolean;
  aria: string;
}

/**
 * Which labels show, at screen size: the brain in the middle, each area's
 * name inside its lobe (moved further in when two would touch), then item
 * titles running outward from the outline, never closer than PITCH to
 * another along it: the picked item, the search hits, the lit links' far
 * ends, then the most linked. Far out only hubs read; zooming in makes room.
 */
function placeLabels(L: BrainLayout, ix: Indexed, v: View, s: { w: number; h: number }, o: { phone: boolean; measure?: Measure; focus?: string; near: Set<number>; hits: ReadonlySet<string>; hit?: string; selected?: string; insets: Insets }): BLabel[] {
  const out: BLabel[] = [];
  if (!s.w) return out;
  const boxes: Array<[number, number, number, number]> = [];
  const free = (x: number, y: number, w: number, h: number) => !boxes.some(([a, b, c, d]) => x < a + c && a < x + w && y < b + d && b < y + h);
  const sx = (x: number) => x * v.k + v.x;
  const sy = (y: number) => y * v.k + v.y;
  const meas = o.measure ?? ((t: string, f: 'name' | 'title' | 'meta') => t.length * (f === 'name' ? 8 : 7) + 12);
  const brainW = Math.ceil(meas('Brain', 'name') * 1.22) + meas(num(L.items.length), 'meta') - 6;
  const cx = sx(0);
  const cy = sy(0);
  boxes.push([cx - brainW / 2, cy - 12, brainW, 24]);
  out.push({ id: 'brain', kind: 'brain', title: 'Brain', count: num(L.items.length), x: cx - brainW / 2, y: cy, w: brainW, align: 'center', aria: `Brain, ${num(L.items.length)} items` });

  // areas: inside the outline, biggest first
  const areas = [...L.areas].sort((a, b) => b.to - b.from - (a.to - a.from));
  for (const a of areas) {
    const id = areaId(a.name);
    const n = a.to - a.from;
    const w = meas(a.name, 'name') + meas(num(n), 'meta') - 6;
    const lit = o.focus === id;
    // inward from the arc's middle, then a row up or down, until it has room (a phone's lobes are close)
    for (const [depth, dy] of [26, 50, 74, 98, 122, 146].flatMap((d) => [[d, 0], [d, -22], [d, 22]])) {
      const ax = sx(a.mx) - a.nx * depth;
      const ay = sy(a.my) - a.ny * depth + dy;
      const x = a.side === 1 ? ax - w : ax;
      if (!free(x, ay - 10, w, 20) && !lit) continue;
      boxes.push([x, ay - 10, w, 20]);
      out.push({ id, kind: 'area', title: a.name, count: num(n), x, y: ay, w, align: a.side === 1 ? 'end' : 'start', lit, aria: `${a.name}, ${num(n)} items` });
      break;
    }
  }

  // item titles along the outline
  const max = o.phone ? 104 : 168;
  const cell = PITCH;
  const grid = new Map<number, Array<[number, number]>>();
  const roomAt = (x: number, y: number) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++) for (const [px, py] of grid.get(i * 8192 + j) ?? []) if ((px - x) ** 2 + (py - y) ** 2 < PITCH * PITCH) return false;
    return true;
  };
  const take = (x: number, y: number) => {
    const k = Math.floor(x / cell) * 8192 + Math.floor(y / cell);
    grid.set(k, [...(grid.get(k) ?? []), [x, y]]);
  };
  const put = (i: number, forced: boolean) => {
    const it = L.items[i];
    const n = ix.byId.get(it.id)!;
    // the label starts past the longest tick
    const gap = 3 + 11 / Math.max(1, Math.sqrt(v.k)) * v.k + 4;
    const x = sx(it.x) + it.nx * gap;
    const y = sy(it.y) + it.ny * gap;
    if (x < -20 || y < -10 || x > s.w + 20 || y > s.h + 10) return;
    // only the picked item and the hit Enter went to may sit on another title
    if (!forced && !roomAt(x, y)) return;
    const title = nodeLabel(n);
    const w = Math.min(max, meas(title, 'title') - 8);
    if (w < MIN_W) return;
    // the whole title in the room between the bands, or none of it
    const ex = x + it.nx * w;
    const ey = y + it.ny * w;
    if (Math.min(y, ey) < o.insets.top - 6 || Math.max(y, ey) > s.h - o.insets.bottom + 6 || Math.min(x, ex) < 2 || Math.max(x, ex) > s.w - 2) return;
    take(x, y);
    const angle = Math.atan2(it.ny, it.nx);
    const flip = it.nx < 0;
    out.push({ id: it.id, kind: 'item', title, x, y, w, angle, flip, near: o.near.has(i), hit: o.hits.has(it.id), selected: o.selected === it.id, aria: `${n.title}, ${L.areas[it.area].name}, ${n.degree} links` });
  };
  const done = new Set<number>();
  const first = [o.selected, o.hit, o.focus && !o.focus.startsWith('area:') ? o.focus : undefined];
  for (const id of first) {
    const i = id ? L.byId.get(id) : undefined;
    if (i !== undefined && !done.has(i)) (done.add(i), put(i, true));
  }
  for (const id of o.hits) {
    const i = L.byId.get(id);
    if (i !== undefined && !done.has(i)) (done.add(i), put(i, false));
  }
  const byDeg = (a: number, b: number) => ix.byId.get(L.items[b].id)!.degree - ix.byId.get(L.items[a].id)!.degree;
  for (const i of [...o.near].sort(byDeg)) if (!done.has(i)) (done.add(i), put(i, false));
  // an area lit: only the titles its links reach
  if (!o.focus?.startsWith('area:')) for (const i of rankOf(L, ix)) if (!done.has(i)) (done.add(i), put(i, false));
  return out;
}

const ranks = new WeakMap<BrainLayout, number[]>();
/** Items most linked first, once per layout. */
function rankOf(L: BrainLayout, ix: Indexed): number[] {
  let r = ranks.get(L);
  if (!r) ranks.set(L, (r = L.items.map((_, i) => i).sort((a, b) => ix.byId.get(L.items[b].id)!.degree - ix.byId.get(L.items[a].id)!.degree)));
  return r;
}

const BrainLabel = memo(function BrainLabel({ b, dim, onPick, onArea, onHover }: { b: BLabel; dim: boolean; onPick: (id: string) => void; onArea: (name: string) => void; onHover: (id: string | undefined) => void }) {
  if (b.kind === 'item') {
    const style: CSSProperties = {
      transform: `translate(${b.x}px, ${b.y}px) rotate(${b.flip ? b.angle! + Math.PI : b.angle!}rad) translate(${b.flip ? '-100%' : '0'}, -50%)`,
      maxWidth: b.w,
    };
    return (
      <button
        type="button"
        className="mb-item"
        style={style}
        data-flip={b.flip || undefined}
        data-dim={dim || undefined}
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
  }
  return (
    <button
      type="button"
      className={b.kind === 'area' ? 'mb-area' : 'mb-brain'}
      style={{ transform: `translate(${b.x}px, ${b.y}px) translateY(-50%)`, width: b.w, justifyContent: b.align === 'end' ? 'flex-end' : b.align === 'center' ? 'center' : 'flex-start' }}
      data-lit={b.lit || undefined}
      aria-label={b.aria}
      aria-pressed={b.kind === 'area' ? !!b.lit : undefined}
      onClick={() => (b.kind === 'area' ? onArea(b.title) : undefined)}
      onPointerEnter={(e) => b.kind === 'area' && e.pointerType === 'mouse' && onHover(b.id)}
      onPointerLeave={(e) => b.kind === 'area' && e.pointerType === 'mouse' && onHover(undefined)}
    >
      <span className="mb-name">{b.title}</span>
      {b.count && <span className="mm-count num">{b.count}</span>}
    </button>
  );
});
