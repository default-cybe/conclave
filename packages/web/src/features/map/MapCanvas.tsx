/**
 * The Map's surface (docs/DESIGN.md 29): a canvas for the links and the
 * streams, and marks and labels in the DOM above it, under one pan and zoom.
 * Wheel and pinch zoom, a drag pans, a click selects. Marks glide to new
 * places when the layout changes; the canvas eases its links the same way.
 * The canvas draws only while something moves, and not in a background tab.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { MapNode, MapSnapshot } from '@conclave/core/client';
import { Knot, useReducedMotion, usePageVisible } from '@/components/motion';
import { dprNow, isDark, onFrame, tokenRGB, useColorVersion } from '@/components/motion/frame';
import { EASE } from '@/components/motion/ease';
import { cn } from '@/lib/text';
import type { LBox, LLink, LNode, Layout } from './layout';
import { STATE_TONE, groupNoun, groupState, groupStats, hubKnot, isBusy, nodeMeta } from './model';
import { Streams, type StreamMode, type StreamSource } from './streams';
import { clampView, fitView, pinch, startView, wheelFactor, zoomAt, type Insets, type View } from './view';

const MOVE_MS = 450;
const KNOT_BOX = 76;

type P = { x: number; y: number };
type RGB = [number, number, number];

interface Colors {
  rule: RGB;
  rule2: RGB;
  signal: RGB;
  warn: RGB;
  fault: RGB;
  fg: RGB;
  bg: RGB;
  dark: boolean;
}

export interface MapCanvasProps {
  snap: MapSnapshot;
  layout: Layout;
  mode: StreamMode;
  selected?: string;
  onSelect: (id: string | undefined) => void;
  /** Room the overlays take on each side, kept clear when fitting. */
  insets: Insets;
  online: boolean;
  replay: boolean;
  /** Bumped by the Fit button. */
  fit: number;
  /** Bumped with a factor by the zoom buttons. */
  zoom: { n: number; factor: number };
  /** Called when the zoom changes (for the controls). */
  onView?: (v: View) => void;
  /** Fit again into the room the overlays leave when it changes, until the map is moved (desktop; a phone's sheet only covers it for a while). */
  refit?: boolean;
  /** Phones: open at zoom k on this box (the hub and its busiest project), so labels read (startView). Fit shows the whole map. */
  start?: { focus: LBox; k: number };
  now: number;
  className?: string;
}

const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The link between two points, as the layout draws it: horizontal at both ends. */
function cubic(a: P, b: P): LLink['p'] {
  const dx = b.x - a.x;
  return [a.x, a.y, a.x + dx * 0.5, a.y, b.x - dx * 0.5, b.y, b.x, b.y];
}

export function MapCanvas(props: MapCanvasProps) {
  const { snap, layout, mode, selected, onSelect, insets, online, replay, fit, zoom, onView, now, refit, start, className } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const colorV = useColorVersion();

  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const moved = useRef(false);
  const size = useRef({ w: 0, h: 0 });
  const streams = useRef(new Streams());
  const pos = useRef(new Map<string, P>());
  const anim = useRef<{ from: Map<string, P>; to: Map<string, P>; start: number; dur: number } | null>(null);
  const colors = useRef<Colors | null>(null);
  const layoutRef = useRef(layout);
  const snapRef = useRef(snap);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const startRef = useRef(start);
  startRef.current = start;
  /** Fit was asked for: the whole map from then on, not the opening view. */
  const whole = useRef(false);
  const wake = useRef<() => void>(() => {});
  const [kq, setKq] = useState(1);
  const fresh = useRef(new Set<string>());

  // ----- the view ------------------------------------------------------------------
  const applyView = useCallback(
    (v: View) => {
      const l = layoutRef.current;
      const c = clampView(v, l.bounds, size.current.w, size.current.h);
      view.current = c;
      if (layer.current) layer.current.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.k})`;
      // the hub's knot is drawn at the zoom it is seen at, in steps, so it stays sharp
      const q = Math.max(0.5, Math.min(160 / KNOT_BOX, Math.round(c.k * 4) / 4));
      setKq((old) => (old === q ? old : q));
      onView?.(c);
      wake.current();
    },
    [onView],
  );

  const fitNow = useCallback(() => {
    const { w, h } = size.current;
    if (!w || !h) return;
    const l = layoutRef.current;
    const s = startRef.current;
    applyView(s && !whole.current ? startView(l.bounds, s.focus, w, h, insetsRef.current, s.k) : fitView(l.bounds, w, h, insetsRef.current, w < 600 ? 1 : 1.15));
  }, [applyView]);

  // ----- size ------------------------------------------------------------------------
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
      if (!moved.current) fitNow();
      else applyView(view.current);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitNow, applyView]);

  // ----- layout: glide from where things are drawn now ---------------------------------
  const current = (t: number): Map<string, P> => {
    const a = anim.current;
    if (!a) return pos.current;
    const k = a.dur ? EASE.out(Math.min(1, (t - a.start) / a.dur)) : 1;
    const out = new Map<string, P>();
    for (const [id, to] of a.to) {
      const from = a.from.get(id) ?? to;
      out.set(id, { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
    }
    if (k >= 1) {
      anim.current = null;
      pos.current = out;
    }
    return out;
  };

  useLayoutEffect(() => {
    const t = performance.now();
    const was = current(t);
    const to = new Map(layout.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const from = new Map<string, P>();
    fresh.current = new Set();
    for (const [id, p] of to) {
      const old = was.get(id);
      if (!old && was.size) fresh.current.add(id);
      from.set(id, old ?? p);
    }
    anim.current = { from, to, start: t, dur: reduced || !was.size ? 0 : MOVE_MS };
    layoutRef.current = layout;
    if (!moved.current) fitNow();
    wake.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, reduced]);

  // ----- what flows: running nodes and their token rates; a new tool sends a pulse -----------
  const tools = useRef(new Map<string, string | undefined>());
  useEffect(() => {
    snapRef.current = snap;
    const s = streams.current;
    const sources: StreamSource[] = [];
    const seen = new Map<string, string | undefined>();
    for (const n of snap.nodes) {
      if (n.kind === 'workflow') continue;
      seen.set(n.id, n.tool?.id);
      if (n.state === 'running') sources.push({ id: n.id, rate: n.rate, working: n.rate > 0 ? 'tokens' : n.tool ? 'tool' : 'waiting' });
    }
    s.setSources(replay && reduced ? [] : sources);
    if (!replay)
      for (const [id, tool] of seen) {
        const before = tools.current.get(id);
        if (tool && tool !== before && tools.current.has(id)) s.pulse(id);
      }
    tools.current = seen;
    wake.current();
  }, [snap, replay, reduced]);

  useEffect(() => {
    streams.current.mode = reduced ? 'lines' : mode;
    wake.current();
  }, [mode, reduced]);

  // ----- colors -------------------------------------------------------------------------------
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    colors.current = {
      rule: tokenRGB(el, '--rule'),
      rule2: tokenRGB(el, '--rule-2'),
      signal: tokenRGB(el, '--signal'),
      warn: tokenRGB(el, '--warn'),
      fault: tokenRGB(el, '--fault'),
      fg: tokenRGB(el, '--fg'),
      bg: tokenRGB(el, '--bg'),
      dark: isDark(),
    };
    wake.current();
  }, [colorV]);

  // ----- drawing --------------------------------------------------------------------------------
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    let stop: (() => void) | null = null;
    let last = performance.now();
    let dirty = true;
    const s = streams.current;

    const draw = (t: number) => {
      const t0 = performance.now();
      const C = colors.current;
      const v = view.current;
      const dpr = c.width / Math.max(1, size.current.w);
      const moving = !!anim.current;
      const p = current(t);
      const l = layoutRef.current;
      const links: LLink[] = [];
      for (const k of l.links) {
        const a = p.get(k.from);
        const b = p.get(k.to);
        if (a && b) links.push({ ...k, p: cubic(a, b) });
      }
      if (moving || dirty) s.setLinks(links);
      s.step((t - last) / 1000);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      if (C) {
        const busy = new Map<string, 'run' | 'wait'>();
        const snapNow = snapRef.current;
        // a link carries work when a running node lies below it
        for (const n of snapNow.nodes) {
          if (n.state !== 'running' && n.state !== 'waiting') continue;
          let id: string | undefined = n.id;
          busy.set(n.id, n.state === 'waiting' ? 'wait' : 'run');
          if (n.state !== 'running') continue;
          for (let hop = 0; hop < 12 && id; hop++) {
            const ln: LNode | undefined = l.byId.get(id);
            if (!ln?.parent) break;
            if (!busy.has(ln.parent)) busy.set(ln.parent, 'run');
            id = ln.parent;
          }
        }
        const lines = s.mode === 'lines';
        ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
        ctx.lineCap = 'round';
        const base = C.dark ? C.rule2 : mix(C.rule2, C.bg, 0.15);
        for (const k of links) {
          const ln = l.byId.get(k.from);
          const tone = busy.get(k.from);
          ctx.beginPath();
          ctx.moveTo(k.p[0], k.p[1]);
          ctx.bezierCurveTo(k.p[2], k.p[3], k.p[4], k.p[5], k.p[6], k.p[7]);
          ctx.setLineDash(ln?.kind === 'device' ? [2 / v.k, 4 / v.k] : []);
          ctx.lineWidth = 1 / v.k;
          ctx.strokeStyle = rgba(base, 1);
          ctx.stroke();
          if (tone) {
            ctx.setLineDash([]);
            ctx.lineWidth = (lines ? 1.5 : 1.25) / v.k;
            ctx.strokeStyle = tone === 'wait' ? rgba(C.warn, lines ? 0.75 : 0.5) : rgba(C.signal, lines ? 0.7 : C.dark ? 0.3 : 0.38);
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
        // a file two agents change at once: a dashed link in the fault color between them
        for (const x of snapNow.conflicts ?? []) {
          const a = p.get(x.a);
          const b = p.get(x.b);
          if (!a || !b) continue;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2 - Math.min(60, Math.abs(a.x - b.x) * 0.2 + 18);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(mx, my, b.x, b.y);
          ctx.setLineDash([4 / v.k, 3 / v.k]);
          ctx.lineWidth = 1.5 / v.k;
          ctx.strokeStyle = rgba(C.fault, 0.9);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (!lines) s.draw(ctx, v, dpr, { dot: (C.dark ? mix(C.signal, C.fg, 0.28) : C.signal).map((x) => x | 0) as RGB, pulse: (C.dark ? mix(C.signal, C.fg, 0.75) : mix(C.signal, [20, 10, 40], 0.25)).map((x) => x | 0) as RGB });
      }
      dirty = false;
      s.quality.update(performance.now() - t0, t - last);
      last = t;
      if (!anim.current && !s.active && stop) {
        stop();
        stop = null;
      }
    };

    wake.current = () => {
      dirty = true;
      if (stop || !visible) return;
      last = performance.now();
      stop = onFrame(draw);
    };
    wake.current();
    return () => {
      stop?.();
      stop = null;
      wake.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ----- a selected node stays in sight: the drawer opens over the right of the map -----------------
  const tween = useRef<(() => void) | null>(null);
  const panTo = useCallback(
    (to: View, ms = 320) => {
      tween.current?.();
      const from = view.current;
      if (reduced || !ms) return applyView(to);
      const start = performance.now();
      let stop: (() => void) | null = onFrame((t) => {
        const k = EASE.out(Math.min(1, (t - start) / ms));
        applyView({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, k: from.k + (to.k - from.k) * k });
        if (k >= 1) {
          stop?.();
          stop = null;
        }
      });
      tween.current = () => {
        stop?.();
        stop = null;
      };
    },
    [applyView, reduced],
  );
  const lastRight = useRef(insets.right);
  useEffect(() => {
    const { w, h } = size.current;
    const ins = insetsRef.current;
    const opened = ins.right - lastRight.current;
    lastRight.current = ins.right;
    if (!w) return;
    // the drawer closed on a map nobody moved: it fits the whole room again
    if (opened < 0 && !moved.current && refit) {
      panTo(fitView(layoutRef.current.bounds, w, h, ins, w < 600 ? 1 : 1.15));
      return;
    }
    if (!selected) return;
    const ln = layoutRef.current.byId.get(selected);
    if (!ln) return;
    const v = view.current;
    const x0 = Math.min(ln.x - ln.r, ln.label.x) * v.k + v.x;
    const x1 = Math.max(ln.x + ln.r, ln.label.x + ln.label.w) * v.k + v.x;
    const y0 = Math.min(ln.y - ln.r, ln.label.y) * v.k + v.y;
    const y1 = Math.max(ln.y + ln.r, ln.label.y + ln.label.h) * v.k + v.y;
    let dx = 0;
    let dy = 0;
    if (x1 > w - ins.right) dx = w - ins.right - x1;
    if (x0 + dx < ins.left) dx = ins.left - x0;
    if (y1 > h - ins.bottom) dy = h - ins.bottom - y1;
    if (y0 + dy < ins.top) dy = ins.top - y0;
    if (!dx && !dy) return;
    // the map moves only as far as it must, and this does not count as the owner moving it
    panTo({ ...v, x: v.x + dx, y: v.y + dy });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, insets.right, insets.bottom]);

  // ----- the buttons: fit and zoom --------------------------------------------------------------
  const firstFit = useRef(fit);
  useEffect(() => {
    if (fit === firstFit.current) return;
    moved.current = false;
    whole.current = true;
    fitNow();
  }, [fit, fitNow]);
  const firstZoom = useRef(zoom.n);
  useEffect(() => {
    if (zoom.n === firstZoom.current) return;
    moved.current = true;
    applyView(zoomAt(view.current, size.current.w / 2, size.current.h / 2, zoom.factor));
  }, [zoom, applyView]);

  // ----- wheel, drag, pinch ------------------------------------------------------------------------
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      moved.current = true;
      if (e.shiftKey && !e.ctrlKey) applyView({ ...view.current, x: view.current.x - (e.deltaY || e.deltaX), y: view.current.y });
      else applyView(zoomAt(view.current, e.clientX - r.left, e.clientY - r.top, wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey)));
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
      moved.current = true;
      if (drag.current) drag.current.moved = true;
      applyView(pinch(view.current, prev, other, next, other));
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    if (!d.moved) {
      d.moved = true;
      wrap.current?.setPointerCapture(e.pointerId);
      wrap.current?.setAttribute('data-dragging', '');
    }
    ps.set(e.pointerId, next);
    moved.current = true;
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
    const v = view.current;
    const { w, h } = size.current;
    const step = 60;
    const keys: Record<string, () => View | 'fit'> = {
      '+': () => zoomAt(v, w / 2, h / 2, 1.25),
      '=': () => zoomAt(v, w / 2, h / 2, 1.25),
      '-': () => zoomAt(v, w / 2, h / 2, 0.8),
      '0': () => 'fit',
      ArrowLeft: () => ({ ...v, x: v.x + step }),
      ArrowRight: () => ({ ...v, x: v.x - step }),
      ArrowUp: () => ({ ...v, y: v.y + step }),
      ArrowDown: () => ({ ...v, y: v.y - step }),
    };
    if (e.key === 'Escape' && selected) {
      onSelect(undefined);
      return;
    }
    const f = keys[e.key];
    if (!f || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const next = f();
    if (next === 'fit') {
      moved.current = false;
      whole.current = true;
      fitNow();
    } else {
      moved.current = true;
      applyView(next);
    }
  };

  const nodes = new Map(snap.nodes.map((n) => [n.id, n]));
  const hubState = hubKnot(snap.hub.state, snap.nodes, online);

  return (
    <div
      ref={wrap}
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
        onSelect(undefined);
      }}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0" />
      <div ref={layer} className="map-layer" role="group" aria-label="The hub, its devices, projects and agents">
        {layout.nodes.map((ln) => (
          <Mark
            key={ln.id}
            ln={ln}
            node={ln.node ? (nodes.get(ln.node.id) ?? ln.node) : undefined}
            snap={snap}
            selected={selected === ln.id}
            onSelect={onSelect}
            fresh={fresh.current.has(ln.id)}
            hub={ln.kind === 'hub' ? { state: hubState, k: kq, still: replay || reduced, online } : undefined}
            now={now}
          />
        ))}
        {(snap.conflicts ?? []).map((x) => {
          const a = layout.byId.get(x.a);
          const b = layout.byId.get(x.b);
          if (!a || !b) return null;
          const style: CSSProperties = { left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 - Math.min(60, Math.abs(a.x - b.x) * 0.2 + 18) / 2 };
          return (
            <span key={`${x.a}:${x.b}:${x.file}`} className="map-conflict" style={style} title={`Both change ${x.file}`}>
              {x.file}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One mark and its label
// ---------------------------------------------------------------------------

const TONE_COLOR = { signal: 'var(--signal)', warn: 'var(--warn)', fault: 'var(--fault)', dim: 'var(--fg-3)', neutral: 'var(--fg-2)', ok: 'var(--ok)' } as const;

const Mark = memo(function Mark({
  ln,
  node,
  snap,
  selected,
  onSelect,
  fresh,
  hub,
  now,
}: {
  ln: LNode;
  node?: MapNode;
  snap: MapSnapshot;
  selected: boolean;
  onSelect: (id: string | undefined) => void;
  fresh: boolean;
  hub?: { state: ReturnType<typeof hubKnot>; k: number; still: boolean; online: boolean };
  now: number;
}) {
  const r = ln.r;
  const markBox: CSSProperties = { left: -r, top: -r, width: 2 * r, height: 2 * r };
  const L = ln.label;
  const labelStyle: CSSProperties = { left: L.x - ln.x, top: L.y - ln.y, width: L.w, height: L.h };
  const align = L.place === 'beside' ? (ln.side === -1 ? 'end' : 'start') : 'center';
  const style: CSSProperties = { transform: `translate(${ln.x}px, ${ln.y}px)` };

  if (ln.kind === 'hub' && hub) {
    const size = Math.round(KNOT_BOX * hub.k);
    const tone = !hub.online ? 'dim' : STATE_TONE[snap.hub.state];
    return (
      <div className="map-node" style={style} data-id="hub">
        {/* the links end under the knot, and the streams fade into it */}
        <span aria-hidden className="absolute rounded-full bg-bg" style={{ left: -r, top: -r, width: 2 * r, height: 2 * r }} />
        <div className="absolute" style={{ left: -KNOT_BOX / 2, top: -KNOT_BOX / 2, width: KNOT_BOX, height: KNOT_BOX }}>
          <div style={{ width: size, height: size, transform: `scale(${1 / hub.k})`, transformOrigin: '0 0' }}>
            <Knot state={hub.state} size={size} still={hub.still} label={`Hub ${L.title}, ${L.meta}`} surface="var(--bg)" />
          </div>
        </div>
        <span className="map-label" data-align="center" style={labelStyle}>
          <span className="map-name">{L.title}</span>
          <span className="map-meta" style={{ color: TONE_COLOR[tone] }}>
            {L.meta}
          </span>
        </span>
      </div>
    );
  }

  if (ln.kind === 'device') {
    const online = ln.device?.online;
    return (
      <div className="map-node" style={style} data-id={ln.id} data-new={fresh || undefined}>
        <span className="map-mark map-device" style={markBox} data-online={online === false ? 'false' : 'true'} />
        <span className="map-label" data-align={align} style={labelStyle}>
          <span className="map-name">{L.title}</span>
          <span className="map-meta" style={{ color: online ? 'var(--ok)' : 'var(--fg-4)' }}>
            {L.meta}
          </span>
        </span>
      </div>
    );
  }

  if (ln.kind === 'group' && ln.group) {
    const stats = groupStats(ln.group.id, snap.nodes);
    const st = groupState(ln.group.id, snap.nodes);
    return (
      <div className="map-node" style={style} data-id={ln.id} data-new={fresh || undefined}>
        <span className="map-mark map-group" style={markBox} data-state={st} />
        <span className="map-label" data-align={align} style={labelStyle}>
          <span className="map-name">{L.title}</span>
          <span className="map-meta">
            {stats.agents} {groupNoun(stats.agents, ln.group.kind === 'chats')}
            {stats.running > 0 && (
              <>
                , <span className="text-signal">{stats.running} running</span>
              </>
            )}
            {stats.waiting > 0 && (
              <>
                , <span className="text-warn">{stats.waiting} waiting</span>
              </>
            )}
          </span>
        </span>
      </div>
    );
  }

  const n = node ?? ln.node!;
  const meta = nodeMeta(n, now);
  const word = meta.word;
  const tone = n.stuckSince ? 'warn' : STATE_TONE[n.state];
  const kindWord = n.kind === 'chat' ? 'chat' : n.kind === 'subagent' ? 'subagent' : n.kind === 'workflow' ? 'workflow run' : n.kind === 'agent' ? 'workflow agent' : 'session';
  return (
    <button
      type="button"
      className="map-node text-left"
      style={{ transform: `translate(${ln.x - r}px, ${ln.y - r}px)`, width: 2 * r, height: 2 * r }}
      data-id={ln.id}
      data-new={fresh || undefined}
      aria-pressed={selected}
      aria-label={`${n.title}, ${kindWord}, ${word}`}
      title={n.title}
      onClick={() => onSelect(selected ? undefined : n.id)}
    >
      <span className={cn('map-mark', n.kind === 'workflow' ? 'map-run' : 'map-dot', selected && 'map-selected', n.stuckSince && 'map-stuck')} style={{ left: 0, top: 0, width: 2 * r, height: 2 * r }} data-state={n.state} />
      <span className="map-label" data-align={align} style={{ ...labelStyle, left: L.x - ln.x + r, top: L.y - ln.y + r }}>
        <span className="map-title" data-quiet={!isBusy(n.state) || undefined}>
          {/* the short name the layout measured (it lays out again when a title changes); the full title is the tooltip and the drawer's */}
          {L.title}
        </span>
        <span className="map-meta">
          {meta.mode} · <span style={{ color: TONE_COLOR[tone] }}>{word}</span>
          {meta.when && ` · ${meta.when}`}
        </span>
      </span>
    </button>
  );
});
