/**
 * The memory map's surface, built like the Map's (features/map/MapCanvas):
 * links on a canvas, labels in the DOM above it, one pan and zoom. There
 * are no marks: a link runs from a label's outer edge to the next label's
 * inner edge. Labels glide 450 ms to their new places when the tree
 * changes and the canvas eases its links the same way (at once under
 * reduced motion). Hover lights an item's links, cross links too, and steps
 * the rest back. Zoom buttons and keys zoom around the focus (the picked
 * item, else the center), not the middle of the screen.
 *
 * Expand all (a layout with blocks) is a semantic zoom: the canvas draws
 * every item as a faint bar where its title would be, and only the labels
 * that have room at this zoom are in the DOM, at screen size
 * (visibleLabels), redrawn as the view moves.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useReducedMotion, usePageVisible } from '@/components/motion';
import { dprNow, isDark, onFrame, tokenRGB, useColorVersion } from '@/components/motion/frame';
import { EASE } from '@/components/motion/ease';
import { cn } from '@/lib/text';
import { clampView, fitView, pinch, wheelFactor, zoomAt, type Insets, type View } from '@/features/map/view';
import type { Measure } from '@/features/map/layout';
import { inX, outX, visibleLabels, type Indexed, type MLayout, type PNode } from './graph-model';

const MOVE_MS = 450;
/** The smallest words on the map are 12px: below this zoom they read under 11px, so no automatic view goes there. */
export const READ_K = 11 / 12;
/** Rings past the first unfold from this zoom, and fold again below UNFOLD_OFF. */
const UNFOLD_ON = 1.3;
const UNFOLD_OFF = 1.15;
/** Expand all zooms out this far, so Fit frames ~3,000 items. */
const ALL_MIN_K = 0.03;
type P = { x: number; y: number };
type RGB = [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

export interface MemoryCanvasProps {
  layout: MLayout;
  ix: Indexed;
  items: Set<string>;
  selected?: string;
  hover?: string;
  onHover: (id: string | undefined) => void;
  onPick: (p: PNode) => void;
  onCenter: (id: string) => void;
  onBlank: () => void;
  /** Tree ids on the path, the center first. */
  path?: string[];
  hits: Set<string>;
  /** Items the time scrubber or the source filter steps back. */
  faded: (p: PNode) => boolean;
  insets: Insets;
  fit: number;
  zoom: { n: number; factor: number };
  /** Bring these into the free room after the next layout (what just opened); center: a new center goes to the middle. */
  reveal?: { ids: string[]; n: number; center?: boolean; all?: boolean };
  onUnfold: (on: boolean) => void;
  measure?: Measure;
  className?: string;
  onKey?: (e: React.KeyboardEvent) => boolean;
}

export function MemoryCanvas(props: MemoryCanvasProps) {
  const { layout, ix, items, selected, hover, onHover, onPick, onCenter, onBlank, path, hits, faded, insets, fit, zoom, reveal, onUnfold, measure, className, onKey } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const colorV = useColorVersion();
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 });
  const pos = useRef(new Map<string, P>());
  const anim = useRef<{ from: Map<string, P>; to: Map<string, P>; start: number; dur: number } | null>(null);
  const layoutRef = useRef(layout);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const wake = useRef<() => void>(() => {});
  const colors = useRef<{ rule2: RGB; signal: RGB; fg: RGB; dark: boolean } | null>(null);
  const hot = useRef<{ lit?: string; cross?: string; path?: Set<string>; dim: boolean }>({ dim: false });
  const unfolded = useRef(false);
  const unfoldRef = useRef(onUnfold);
  unfoldRef.current = onUnfold;
  // expand all: the screen-size labels follow the view, one render a frame at most
  const [, setTick] = useState(0);
  const ticking = useRef(false);
  const labelled = useRef(new Set<string>());
  const hitsRef = useRef(hits);
  hitsRef.current = hits;
  const fadedRef = useRef(faded);
  fadedRef.current = faded;
  const minK = () => (layoutRef.current.blocks ? ALL_MIN_K : undefined);

  // ----- the view ----------------------------------------------------------------
  const applyView = useCallback((v: View) => {
    const c = clampView(v, layoutRef.current.bounds, size.current.w, size.current.h);
    view.current = c;
    if (layer.current) layer.current.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.k})`;
    const on = unfolded.current ? c.k >= UNFOLD_OFF : c.k >= UNFOLD_ON;
    if (on !== unfolded.current) (unfolded.current = on), unfoldRef.current(on);
    if (layoutRef.current.blocks && !ticking.current) {
      ticking.current = true;
      requestAnimationFrame(() => ((ticking.current = false), setTick((t) => t + 1)));
    }
    wake.current();
  }, []);

  const tween = useRef<(() => void) | null>(null);
  const panTo = useCallback(
    (to: View, ms = MOVE_MS) => {
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

  /** The whole tree in the free room, at zoom 1 at most; a tree too big to read whole keeps the center in the middle at READ_K. */
  const fitAll = useCallback((): View => {
    const { w, h } = size.current;
    const ins = insetsRef.current;
    return fitView(layoutRef.current.bounds, w, h, ins, 1, minK());
  }, []);
  const centerAt = useCallback((k: number): View => {
    const { w, h } = size.current;
    const ins = insetsRef.current;
    const l = layoutRef.current;
    const root = l.nodes[0];
    // one-sided trees (phones) keep the center near the left edge so its links have the width
    const oneSided = !l.nodes.some((p) => p.side === -1);
    const cx = oneSided ? ins.left + 8 - root.x * k : ins.left + (w - ins.left - ins.right) / 2;
    return { k, x: cx, y: ins.top + (h - ins.top - ins.bottom) / 2 };
  }, []);
  const homeView = useCallback((): View => {
    const all = fitAll();
    return all.k >= READ_K ? all : centerAt(READ_K);
  }, [fitAll, centerAt]);

  // ----- size -----------------------------------------------------------------------
  const sized = useRef(false);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
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
      if (!sized.current && r.width) {
        sized.current = true;
        applyView(homeView());
      } else applyView(view.current);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyView, homeView]);

  // ----- layout: glide from where things are drawn now --------------------------------
  const current = (t: number): Map<string, P> => {
    const a = anim.current;
    if (!a) return pos.current;
    const k = a.dur ? EASE.out(Math.min(1, (t - a.start) / a.dur)) : 1;
    const out = new Map<string, P>();
    for (const [id, to] of a.to) {
      const from = a.from.get(id) ?? to;
      out.set(id, { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
    }
    if (k >= 1) (anim.current = null), (pos.current = out);
    return out;
  };
  const fresh = useRef(new Set<string>());
  useLayoutEffect(() => {
    const t = performance.now();
    const was = current(t);
    const to = new Map(layout.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const from = new Map<string, P>();
    fresh.current = new Set();
    for (const [id, p] of to) {
      const old = was.get(id);
      // a new label grows out of its parent
      const par = layout.byId.get(id)?.parent;
      if (!old && was.size) fresh.current.add(id);
      from.set(id, old ?? (par ? was.get(par) : undefined) ?? p);
    }
    // into and out of expand all the labels change system: no glide
    anim.current = { from, to, start: t, dur: reduced || !was.size || !!layout.blocks || !!layoutRef.current.blocks ? 0 : MOVE_MS };
    layoutRef.current = layout;
    wake.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, reduced]);

  // what was just opened comes into the free room, moving as little as it must
  useEffect(() => {
    if (!reveal || (!reveal.ids.length && !reveal.all)) return;
    const l = layoutRef.current;
    const { w, h } = size.current;
    const ins = insetsRef.current;
    // expand all and collapse all: everything
    if (reveal.all) return panTo(fitAll());
    // a new center: the whole tree when it reads, else the center in the middle at the zoom the owner had
    if (reveal.center) {
      const all = fitAll();
      panTo(all.k >= READ_K ? all : centerAt(Math.max(READ_K, Math.min(view.current.k, 1))));
      return;
    }
    const want = new Set(reveal.ids);
    // one node opened: it and everything that grew out of it (a deeper depth grows two rings); a path: the chain
    const one = reveal.ids.length === 1;
    const under = (p: PNode): boolean => !!p.parent && (want.has(p.parent) || under(l.byId.get(p.parent)!));
    const ps = l.nodes.filter((p) => want.has(p.id) || (one && under(p)));
    if (!ps.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; // prettier-ignore
    for (const p of ps) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y - p.h)), (x1 = Math.max(x1, p.x + p.w)), (y1 = Math.max(y1, p.y + p.h)); // prettier-ignore
    let v = view.current;
    const room = { w: w - ins.left - ins.right, h: h - ins.top - ins.bottom };
    // zoom out when what opened is bigger than the room, never below where labels read
    const need = Math.min(room.w / (x1 - x0 + 40), room.h / (y1 - y0 + 40));
    if (need < v.k) v = { ...v, k: Math.max(READ_K, need) };
    const sx0 = x0 * v.k + v.x, sx1 = x1 * v.k + v.x, sy0 = y0 * v.k + v.y, sy1 = y1 * v.k + v.y; // prettier-ignore
    let dx = 0;
    let dy = 0;
    if (sx1 - sx0 > room.w) dx = ins.left + 12 - sx0;
    else if (sx1 > w - ins.right) dx = w - ins.right - sx1;
    else if (sx0 < ins.left) dx = ins.left - sx0;
    if (sy1 - sy0 > room.h) dy = ins.top + 12 - sy0;
    else if (sy1 > h - ins.bottom) dy = h - ins.bottom - sy1;
    else if (sy0 < ins.top) dy = ins.top - sy0;
    // a path too long for the room: its end (what was searched for) stays in view
    const end = !one ? l.byId.get(reveal.ids[reveal.ids.length - 1]) : undefined;
    if (end) {
      const ex1 = (end.x + end.w) * v.k + v.x + dx;
      const ey = end.y * v.k + v.y + dy;
      const ex0 = end.x * v.k + v.x + dx;
      if (ex1 > w - ins.right - 8) dx += w - ins.right - 8 - ex1;
      else if (ex0 < ins.left + 8) dx += ins.left + 8 - ex0;
      if (ey > h - ins.bottom - 16) dy += h - ins.bottom - 16 - ey;
      if (ey < ins.top + 16) dy += ins.top + 16 - ey;
    }
    if (dx || dy || v.k !== view.current.k) panTo({ ...v, x: v.x + dx, y: v.y + dy });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.n, layout]);

  // ----- colors ------------------------------------------------------------------------
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    colors.current = { rule2: tokenRGB(el, '--rule-2'), signal: tokenRGB(el, '--signal'), fg: tokenRGB(el, '--fg'), dark: isDark() };
    wake.current();
  }, [colorV]);

  // what lights up: the hovered item (else the picked one) and its links; the path
  const lit = hover ?? selected;
  const onPath = new Set(path ?? []);
  hot.current = { lit, cross: hover, path: onPath, dim: !!lit };
  useEffect(() => wake.current(), [lit, path]);

  // ----- drawing -------------------------------------------------------------------------
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    let stop: (() => void) | null = null;
    const draw = (t: number) => {
      const C = colors.current;
      const v = view.current;
      const dpr = c.width / Math.max(1, size.current.w);
      const p = current(t);
      const l = layoutRef.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      if (C) {
        ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
        ctx.lineCap = 'round';
        const { lit, path } = hot.current;
        const at = (id: string): PNode | undefined => {
          const n = l.byId.get(id);
          const q = p.get(id);
          return n && q ? { ...n, x: q.x, y: q.y } : undefined;
        };
        for (const k of l.links) {
          const a = at(k.from);
          const b = at(k.to);
          if (!a || !b) continue;
          const ax = outX(a, b.side) + (b.side === -1 ? -3 : 3);
          const bx = inX(b) + (b.side === -1 ? 3 : -3);
          const dx = bx - ax;
          ctx.beginPath();
          ctx.moveTo(ax, a.y);
          ctx.bezierCurveTo(ax + dx * 0.5, a.y, bx - dx * 0.5, b.y, bx, b.y);
          const isPath = path?.has(k.from) && path.has(k.to);
          const isLit = lit && (k.to === lit || k.from === lit);
          ctx.lineWidth = (isPath ? 2 : isLit ? 1.6 : 1) / v.k;
          ctx.strokeStyle = isPath ? rgba(C.signal, 0.9) : isLit ? rgba(C.fg, 0.55) : rgba(C.rule2, hot.current.dim ? 0.6 : 1);
          ctx.stroke();
        }
        if (l.blocks) drawBlocks(ctx, l, v, size.current, C, p);
        // links between items on the map that the tree does not draw: only for the hovered item
        const cross = hot.current.cross;
        const from = cross && cross === lit ? at(cross) : undefined;
        if (from?.item)
          for (const n of ix.nbrs.get(from.item.id) ?? []) {
            const to = at(n.id);
            if (!to || to.parent === from.id || from.parent === n.id) continue;
            const ax = from.x + from.w / 2;
            const bx = to.x + to.w / 2;
            const mx = (ax + bx) / 2;
            const my = (from.y + to.y) / 2 - Math.min(80, Math.hypot(bx - ax, to.y - from.y) * 0.18);
            ctx.beginPath();
            ctx.moveTo(ax, from.y);
            ctx.quadraticCurveTo(mx, my, bx, to.y);
            ctx.setLineDash([3 / v.k, 3 / v.k]);
            ctx.lineWidth = 1.2 / v.k;
            ctx.strokeStyle = rgba(C.fg, C.dark ? 0.45 : 0.4);
            ctx.stroke();
            ctx.setLineDash([]);
          }
      }
      if (!anim.current && stop) (stop(), (stop = null));
    };
    /** Expand all: a bracket per area, and a faint bar where each title without a label would read. */
    const drawBlocks = (ctx: CanvasRenderingContext2D, l: MLayout, v: View, s: { w: number; h: number }, C: NonNullable<typeof colors.current>, p: Map<string, P>) => {
      ctx.lineWidth = 1 / v.k;
      ctx.strokeStyle = rgba(C.rule2, 1);
      ctx.beginPath();
      for (const b of l.blocks!) {
        const a = l.byId.get(b.id)!;
        ctx.moveTo(outX(a, b.side) + b.side * 3, b.y0);
        ctx.lineTo(b.x, b.y0);
        ctx.lineTo(b.x, Math.max(b.y0, b.y1));
      }
      ctx.stroke();
      // world box on screen, culled
      const wx0 = -v.x / v.k, wy0 = -v.y / v.k, wx1 = (s.w - v.x) / v.k, wy1 = (s.h - v.y) / v.k; // prettier-ignore
      const bar = Math.min(2.5 / v.k, 8);
      const shown = labelled.current;
      const { lit } = hot.current;
      const groups: Array<[string, PNode[]]> = [[rgba(C.fg, C.dark ? 0.2 : 0.16), []], [rgba(C.fg, 0.05), []], [rgba(C.signal, 0.9), []]];
      for (const n of l.rank ?? []) {
        const q = p.get(n.id) ?? n;
        if (shown.has(n.id) || q.x > wx1 || q.x + n.w < wx0 || q.y > wy1 || q.y < wy0) continue;
        groups[n.id === lit || hitsRef.current.has(n.id) ? 2 : fadedRef.current(n) ? 1 : 0][1].push(n);
      }
      for (const [color, ns] of groups) {
        ctx.fillStyle = color;
        for (const n of ns) {
          const q = p.get(n.id) ?? n;
          const w = Math.max(4, (n.w - 10) * 0.9);
          ctx.fillRect(n.side === -1 ? q.x + n.w - 4 - w : q.x + 4, q.y - bar / 2, w, bar);
        }
      }
    };
    wake.current = () => {
      if (stop || !visible) return;
      stop = onFrame(draw);
    };
    wake.current();
    return () => {
      stop?.();
      stop = null;
      wake.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, items, ix]);

  // ----- buttons and keys ---------------------------------------------------------------
  /** Where zoom holds still: the picked item, else the center, on screen. */
  const focusPoint = (): [number, number] => {
    const l = layoutRef.current;
    const p = (selected && l.byId.get(selected)) || l.nodes[0];
    const v = view.current;
    const x = p ? p.x + p.w / 2 : 0;
    const y = p ? p.y : 0;
    return [x * v.k + v.x, y * v.k + v.y];
  };
  const firstFit = useRef(fit);
  useEffect(() => {
    if (fit === firstFit.current) return;
    panTo(fitAll());
  }, [fit, panTo, fitAll]);
  const firstZoom = useRef(zoom.n);
  useEffect(() => {
    if (zoom.n === firstZoom.current) return;
    panTo(zoomAt(view.current, ...focusPoint(), zoom.factor, minK()), 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, panTo]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.shiftKey && !e.ctrlKey) applyView({ ...view.current, x: view.current.x - (e.deltaY || e.deltaX) });
      else applyView(zoomAt(view.current, e.clientX - r.left, e.clientY - r.top, wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), minK()));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyView]);

  const pointers = useRef(new Map<number, [number, number]>());
  const drag = useRef<{ moved: boolean; x: number; y: number } | null>(null);
  const swallow = useRef(false);
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) drag.current = { moved: false, x: e.clientX, y: e.clientY };
    swallow.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const ps = pointers.current;
    const prev = ps.get(e.pointerId);
    if (!prev) return;
    const next = local(e);
    if (ps.size >= 2) {
      const ids = [...ps.keys()];
      const other = ps.get(ids[0] === e.pointerId ? ids[1] : ids[0])!;
      ps.set(e.pointerId, next);
      if (drag.current) drag.current.moved = true;
      applyView(pinch(view.current, prev, other, next, other, minK()));
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
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) return;
    if (drag.current?.moved) swallow.current = true;
    drag.current = null;
    wrap.current?.removeAttribute('data-dragging');
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input')) return;
    if (onKey?.(e)) return;
    const v = view.current;
    const keys: Record<string, () => View | 'fit'> = {
      '+': () => zoomAt(v, ...focusPoint(), 1.25, minK()),
      '=': () => zoomAt(v, ...focusPoint(), 1.25, minK()),
      '-': () => zoomAt(v, ...focusPoint(), 0.8, minK()),
      '0': () => 'fit',
      ArrowLeft: () => ({ ...v, x: v.x + 60 }),
      ArrowRight: () => ({ ...v, x: v.x - 60 }),
      ArrowUp: () => ({ ...v, y: v.y + 60 }),
      ArrowDown: () => ({ ...v, y: v.y - 60 }),
    };
    const f = keys[e.key];
    if (!f || e.metaKey || e.ctrlKey || e.altKey) return;
    // arrows on a label move between labels (the browser's Tab order); on the surface they pan
    if (e.key.startsWith('Arrow') && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const next = f();
    if (next === 'fit') panTo(fitAll());
    else applyView(next);
  };

  // what steps back while something is lit: everything but it and its links
  const near = new Set<string>();
  if (lit) {
    near.add(lit);
    const lp = layout.byId.get(lit);
    const item = lp?.item?.id;
    if (item) for (const n of ix.nbrs.get(item) ?? []) near.add(n.id);
    for (const c of lp?.t.children ?? []) near.add(c.id);
    if (lp?.parent) near.add(lp.parent);
  }

  // expand all: the labels that have room at this view, at screen size
  const all = !!layout.blocks;
  const shown = all ? visibleLabels(layout, view.current, size.current.w, size.current.h, measure, new Set([...(selected ? [selected] : []), ...(lit ? [lit] : []), ...[...hits].slice(0, 24)])) : [];
  labelled.current = new Set(shown.map((b) => b.p.id));
  // the canvas leaves out the bars under the labels this render placed
  useEffect(() => {
    if (all) wake.current();
  });
  const label = (p: PNode, key = p.id) => (
    <Label
      key={key}
      p={p}
      selected={selected === p.id}
      dim={!!lit && !near.has(p.id) && !onPath.has(p.id)}
      faded={faded(p)}
      path={onPath.has(p.id)}
      hit={!!p.item && hits.has(p.item.id)}
      fresh={!all && fresh.current.has(p.id)}
      onPick={onPick}
      onCenter={onCenter}
      onHover={onHover}
    />
  );

  return (
    <div
      ref={wrap}
      tabIndex={0}
      aria-label="Memory map. Drag or the arrow keys move it, plus and minus zoom, 0 fits, [ and ] change the depth, Escape steps back."
      className={cn('map-surface relative h-full w-full overflow-hidden outline-none', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={(e) => {
        if (!swallow.current) return;
        swallow.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        onBlank();
      }}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0" />
      <div ref={layer} className="map-layer" role="group" aria-label={`${items.size} items on the map`}>
        {!all && layout.nodes.map((p) => label(p))}
      </div>
      {all && (
        <div className="mm-overlay" role="group" aria-label={`All ${items.size} items. ${shown.length} labels have room at this zoom; zoom in for more.`}>
          {shown.map((b) => label({ ...b.p, x: b.x, y: b.y + b.h / 2, w: b.w, h: b.h }))}
        </div>
      )}
    </div>
  );
}

const SOURCE_WORD = { conclave: 'Conclave', 'basic-memory': 'Basic Memory', both: 'Conclave and Basic Memory' } as const;

const Label = memo(function Label({ p, selected, dim, faded, path, hit, fresh, onPick, onCenter, onHover }: { p: PNode; selected: boolean; dim: boolean; faded: boolean; path: boolean; hit: boolean; fresh: boolean; onPick: (p: PNode) => void; onCenter: (id: string) => void; onHover: (id: string | undefined) => void }) {
  const { t } = p;
  const n = p.item;
  const style: CSSProperties = { transform: `translate(${p.x}px, ${p.y - p.h / 2}px)`, width: p.w, height: p.h };
  const align = p.side === -1 ? 'end' : p.side === 0 ? 'center' : 'start';
  const counted = p.count ? (t.kind === 'node' || t.kind === 'focus' ? `, ${p.count} links${t.kind === 'node' ? ' not shown' : ''}` : `, ${p.count}`) : '';
  const words =
    t.kind === 'more'
      ? `Show ${p.title}`
      : t.kind === 'brain'
        ? `Brain, all memory${counted}`
        : t.kind === 'area'
          ? `${p.title}${counted}`
          : t.kind === 'group'
            ? `${p.title}${counted}`
            : `${n?.title ?? p.title}. ${n ? `${t.via ? `${t.via}, ` : ''}${n.kind === 'note' ? 'note' : n.kind} in ${SOURCE_WORD[n.source]}` : ''}${counted}.`;
  // a short tick under the start of the title tells the store: none for Basic Memory, one for Conclave, two for both
  const src = n && n.kind !== 'tag' && n.kind !== 'session' && n.source !== 'basic-memory' ? n.source : undefined;
  return (
    <button
      type="button"
      className="mm-label"
      style={style}
      data-id={p.id}
      data-kind={t.kind}
      data-align={align}
      data-src={src}
      data-new={fresh || undefined}
      data-dim={dim || undefined}
      data-faded={faded || undefined}
      data-path={path || undefined}
      data-hit={hit || undefined}
      data-selected={selected || undefined}
      aria-pressed={t.kind === 'node' || t.kind === 'focus' ? selected : undefined}
      aria-expanded={t.kind === 'area' || t.kind === 'group' ? t.children.length > 0 : undefined}
      aria-label={words}
      title={n && n.title !== p.title ? n.title : undefined}
      onClick={() => onPick(p)}
      onDoubleClick={() => n && onCenter(n.id)}
      onPointerEnter={(e) => e.pointerType === 'mouse' && (t.kind === 'node' || t.kind === 'focus') && matchMedia('(hover: hover)').matches && onHover(p.id)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onHover(undefined)}
    >
      <span className={cn('mm-title', `mm-f-${p.font}`, t.kind === 'more' && 'mm-more')}>{p.title}</span>
      {p.count && <span className="mm-count num">{p.count}</span>}
    </button>
  );
});
