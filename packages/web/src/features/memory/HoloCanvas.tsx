/**
 * Memory > Map, 3D view: the owner's memory as a quiet studio space
 * (Tree / Rings / 3D). Loaded on its own (MemoryMap lazy-imports this file),
 * so three.js costs nothing until the view opens.
 *
 * A small labeled origin stands for the whole memory; the areas are
 * clusters of points around it (Clusters) or lanes along one fine time axis
 * (Timeline); every item is one point of a single Points object, every
 * real link a hairline curve in one LineSegments whose opacity carries its
 * weight, fogged with distance and bundled through the origin or the time
 * axis (holo-model.ts). Colours are the app's tokens, read from CSS: points
 * and links in --signal violet, faint at rest and fuller the more linked an
 * item is, the most linked in a brighter (dark) or deeper (light) violet;
 * focus in full violet with the picked item in ink. The camera
 * drifts very slowly at rest, and a found or picked item gets a fine ring,
 * its links in the accent and one leader line to a label card. Labels,
 * readouts and the card are DOM over the canvas, placed every frame with a
 * box test, so they stay crisp and never overlap.
 *
 * Mouse, trackpad and touch orbit, zoom and pan (OrbitControls). Hover
 * lights an item's links; click opens the drawer; double click flies to the
 * item and keeps its neighbours lit; Esc steps back; Fit returns to the
 * overview. Rendering stops when the tab is hidden or the view is off
 * screen. Reduced motion stops the drift and jumps instead of flying
 * (MemoryMap shows Rings instead unless the owner asks for 3D).
 *
 * What this view still does differently from the rest of the app is listed
 * in docs/DESIGN.md (Memory > Map, 3D view).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BufferAttribute, BufferGeometry, Color, LineSegments, Matrix4, PerspectiveCamera, Points, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MemoryGraphNode } from '@conclave/core/client';
import { useOnscreen, usePageVisible } from '@/components/motion';
import { isDark, useColorVersion } from '@/components/motion/frame';
import { cn } from '@/lib/text';
import { edgeOn } from './link-model';
import { areaId, nodeLabel } from './graph-model';
import { SPAN, holoStats, layoutHolo, linkCurve, pickEdges, timeX, type HoloLayout, type HoloMode } from './holo-model';
import type { LinkViewProps } from './RingCanvas';
import './holo.css';

export interface HoloProps extends LinkViewProps {
  nodes: readonly MemoryGraphNode[];
  mode: HoloMode;
  /** No drift, jumps instead of flights. */
  still: boolean;
  /** The time scrubber's cutoff, drawn as a fine line across the Timeline axis. */
  cut?: number;
}

const num = (n: number) => n.toLocaleString('en-US');
const day = (t?: number) => (t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'none');
const ITEM_POOL = 26;
const TICK_POOL = 24;
const FLY_MS = 1400;
const LOCK_MS = 420;
/** Rest before the slow drift starts, ms. */
const DRIFT_AFTER = 6000;
/** Timeline: where the axis ends, past now (the origin's label sits there), and its tick lengths, world units. */
const SPAN_END = SPAN / 2 + 200;
const TICK_M = 9;
const TICK_Y = 20;
/** The focus ring's radius, CSS px. */
const MARK_R = 7;
const MORPH_MS = 1200;
const FOV = 48;
/** Curve pieces per link: fewer on a phone. */
const SEG = { desk: 10, phone: 5 } as const;
/** Links drawn at most, most linked first: all of them on a desktop. */
const CAP = { desk: 100_000, phone: 1400 } as const;

const cache = new WeakMap<object, Partial<Record<HoloMode, HoloLayout>>>();
function holo(L: LinkViewProps['layout'], nodes: readonly MemoryGraphNode[], mode: HoloMode): HoloLayout {
  const c = cache.get(L) ?? (cache.set(L, {}), cache.get(L)!);
  if (!c[mode]) {
    const t0 = performance.now();
    c[mode] = layoutHolo(L, nodes, mode);
    mark(`memory-3d:layout-${mode}`, t0);
  }
  return c[mode]!;
}

function mark(name: string, t0: number) {
  try {
    performance.clearMeasures(name);
    performance.measure(name, { start: t0, end: performance.now() });
  } catch {
    /* old browsers */
  }
}

// ----- shaders ----------------------------------------------------------------------
// crisp discs, one device pixel of anti-aliased edge, fogged toward the background with depth
const POINT_VS = /* glsl */ `
attribute float size;
attribute float alpha;
attribute vec3 tint;
uniform float uScale;
uniform float uPx;
uniform float uNear;
uniform float uFar;
varying vec3 vTint;
varying float vAlpha;
varying float vSize;
varying float vFog;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(1.0, -mv.z);
  vFog = clamp((depth - uNear) / max(1.0, uFar - uNear), 0.0, 1.0);
  gl_PointSize = clamp(size * uScale / depth, 1.5 * uPx, 6.0 * uPx) + uPx;
  vSize = gl_PointSize;
  vTint = tint;
  vAlpha = alpha;
}`;
const POINT_FS = /* glsl */ `
uniform vec3 uFog;
varying vec3 vTint;
varying float vAlpha;
varying float vSize;
varying float vFog;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float e = 1.0 - smoothstep(1.0 - 2.0 / vSize, 1.0, d);
  if (e <= 0.0) discard;
  gl_FragColor = vec4(mix(vTint, uFog, vFog * 0.6), e * vAlpha * (1.0 - 0.35 * vFog));
}`;
const LINE_VS = /* glsl */ `
attribute vec3 tint;
attribute float alpha;
uniform float uNear;
uniform float uFar;
uniform float uDim;
varying vec3 vTint;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float fog = clamp((-mv.z - uNear) / max(1.0, uFar - uNear), 0.0, 1.0);
  vTint = tint;
  vAlpha = alpha * uDim * (1.0 - 0.75 * fog);
}`;
const LINE_FS = /* glsl */ `
varying vec3 vTint;
varying float vAlpha;
void main() { gl_FragColor = vec4(vTint, vAlpha); }`;

interface Palette {
  dark: boolean;
  /** Background: what depth fades toward. */
  bg: Color;
  /** Ink: the picked item's highlight; line: the time axis. */
  ink: Color;
  line: Color;
  /** Violet: points and links, and in full what has focus. */
  accent: Color;
  /** The most linked items and their links: a brighter violet in dark, a deeper one in light. */
  hot: Color;
}

/** The app's colour tokens as sRGB values, raw, so the shaders draw exactly what CSS draws. */
function palette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const c2 = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const tok = (name: string) => {
    if (!c2) return new Color(0.5, 0.5, 0.5);
    c2.clearRect(0, 0, 1, 1);
    c2.fillStyle = css.getPropertyValue(name).trim() || 'gray';
    c2.fillRect(0, 0, 1, 1);
    const [r, g, b] = c2.getImageData(0, 0, 1, 1).data;
    return new Color(r / 255, g / 255, b / 255);
  };
  const dark = isDark();
  const accent = tok('--signal');
  const ink = tok('--fg');
  return { dark, bg: tok('--bg'), ink, line: tok('--fg-3'), accent, hot: dark ? tok('--wave-hot') : accent.clone().lerp(ink, 0.3) };
}

function lineMat(uniforms: Record<string, { value: unknown }> = {}) {
  return new ShaderMaterial({ vertexShader: LINE_VS, fragmentShader: LINE_FS, transparent: true, depthWrite: false, uniforms: { uNear: { value: 0 }, uFar: { value: 4000 }, uDim: { value: 1 }, ...uniforms } });
}

/** Plain segments in one colour and alpha each, for the time axis and the cutoff. */
function plain(g: BufferGeometry, p: number[], c: Color, a: number) {
  attr(g, 'position', Float32Array.from(p));
  attr(g, 'tint', Float32Array.from({ length: p.length }, (_, k) => [c.r, c.g, c.b][k % 3]));
  attr(g, 'alpha', new Float32Array(p.length / 3).fill(a));
}

function attr(g: BufferGeometry, name: string, a: Float32Array) {
  g.setAttribute(name, new BufferAttribute(a, name === 'position' || name === 'tint' ? 3 : 1));
}

// ----- the component ----------------------------------------------------------------------
export default function HoloCanvas(props: HoloProps) {
  const { ix, layout: L, nodes, filter, gone, hits, hit, selected, hover, onHover, onPick, onArea, onBlank, insets, fit, zoom, phone, mode, still, cut, className } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const visible = usePageVisible();
  const onscreen = useOnscreen(wrap);
  const colorV = useColorVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dark = useMemo(() => isDark(), [colorV]);
  const H = useMemo(() => holo(L, nodes, mode), [L, nodes, mode]);
  const deg = useMemo(() => Float32Array.from(L.items, (it) => nodes[it.node]?.degree ?? 0), [L, nodes]);
  const on = useMemo(() => L.edges.map((e) => edgeOn(L, e, { ...filter, gone })), [L, filter, gone]);
  const stats = useMemo(() => holoStats(L, nodes, on, gone), [L, nodes, on, gone]);
  // double click: fly to an item and keep its neighbours lit until Esc or Fit
  const [focusItem, setFocusItem] = useState<number>();
  const [failed, setFailed] = useState(false);
  const focus = hover ?? selected ?? hit;
  const lit = useMemo(() => {
    const out = new Set<number>();
    const add = (i: number) => {
      for (const e of L.edgesOf[i]) if (on[e]) out.add(e);
    };
    if (focus?.startsWith('area:')) {
      const a = L.areas.find((x) => areaId(x.name) === focus);
      if (a) for (let i = a.from; i < a.to; i++) add(i);
    } else if (focus) {
      const i = L.byId.get(focus);
      if (i !== undefined) add(i);
    }
    if (focusItem !== undefined) add(focusItem);
    return out;
  }, [focus, focusItem, L, on]);
  const near = useMemo(() => {
    const s = new Set<number>();
    for (const e of lit) (s.add(L.edges[e].a), s.add(L.edges[e].b));
    return s;
  }, [lit, L]);
  const lock = hit ?? selected;
  const lockI = lock ? L.byId.get(lock) : undefined;
  const litArea = focus?.startsWith('area:') ? L.areas.findIndex((a) => areaId(a.name) === focus) : -1;

  // everything the frame loop reads, without re-rendering
  const live = useRef({ H, on, lit, near, hits, selected, hit, hover, gone, lockI, litArea, insets, phone, still, focusItem, cut, deg });
  live.current = { H, on, lit, near, hits, selected, hit, hover, gone, lockI, litArea, insets, phone, still, focusItem, cut, deg };
  const api = useRef<Engine | null>(null);

  // the engine: made once per mount, torn down on unmount
  useLayoutEffect(() => {
    const c = canvas.current;
    const w = wrap.current;
    if (!c || !w) return;
    let e: Engine;
    try {
      e = engine(c, w, L, ix, nodes, live, { onHover, onPick, onBlank, setFocusItem });
    } catch (err) {
      console.warn('memory 3d: WebGL did not start', err);
      setFailed(true);
      return;
    }
    api.current = e;
    return () => {
      api.current = null;
      e.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L]);
  // handlers change identity every render: keep the latest
  useEffect(() => void api.current?.handlers({ onHover, onPick, onBlank, setFocusItem }));
  useEffect(() => void api.current?.colors(), [colorV]);
  useEffect(() => void api.current?.layout(H), [H]);
  useEffect(() => void api.current?.links(), [on, H, phone]);
  useEffect(() => void api.current?.paint(), [lit, near, hits, selected, hit, gone, focusItem, litArea, H]);
  useEffect(() => void api.current?.run(visible && onscreen), [visible, onscreen]);
  useEffect(() => void api.current?.motion(), [still]);
  useEffect(() => void api.current?.timeCut(), [cut, H]);
  const firstFit = useRef(fit);
  useEffect(() => {
    if (fit === firstFit.current) return;
    setFocusItem(undefined);
    api.current?.overview();
  }, [fit]);
  const firstZoom = useRef(zoom.n);
  useEffect(() => {
    if (zoom.n !== firstZoom.current) api.current?.dolly(zoom.factor);
  }, [zoom]);
  // a search step, or an item picked in the drawer: fly there and lock on; a click on the map only locks on
  useEffect(() => {
    if (lockI === undefined) return;
    api.current?.lockOn();
    if (api.current?.picked() !== lock) api.current?.flyTo(lockI, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lock]);
  useEffect(() => {
    if (focusItem !== undefined) api.current?.flyTo(focusItem, 220);
  }, [focusItem]);
  useEffect(() => void api.current?.resize(), [insets.left, insets.right, insets.top, insets.bottom]);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).closest('input')) return;
    const a = api.current;
    if (!a || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'Escape') {
      if (focusItem !== undefined) (setFocusItem(undefined), a.overview());
      else if (selected || hit || hover) onBlank();
      else a.overview();
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowLeft: () => a.turn(0.12, 0),
      ArrowRight: () => a.turn(-0.12, 0),
      ArrowUp: () => a.turn(0, 0.1),
      ArrowDown: () => a.turn(0, -0.1),
      '+': () => a.dolly(1.25),
      '=': () => a.dolly(1.25),
      '-': () => a.dolly(0.8),
      '0': () => (setFocusItem(undefined), a.overview()),
    };
    const f = keys[ev.key];
    if (!f || (ev.key.startsWith('Arrow') && (ev.target as HTMLElement).closest('button'))) return;
    ev.preventDefault();
    f();
  };

  const pct = stats.links ? Math.round((100 * stats.cross) / stats.links) : 0;
  const sel = lockI !== undefined ? nodes[L.items[lockI].node] : undefined;
  const selLinks = lockI !== undefined ? L.edgesOf[lockI].filter((e) => on[e]) : [];
  const selOut = lockI !== undefined ? selLinks.filter((e) => L.edges[e].a === lockI).length : 0;
  const narrow = !phone && insets.right > 120;
  if (failed) return <div className={cn('grid place-items-center text-[14px] text-fg-3', className)}>The 3D view needs WebGL, which this browser did not start. Rings shows the same map.</div>;
  return (
    <div
      ref={wrap}
      className={cn('holo', className)}
      data-dark={dark || undefined}
      tabIndex={0}
      role="application"
      aria-roledescription="3D map"
      aria-label={`3D map of ${num(stats.items)} memory items in ${L.areas.length} areas, ${mode === 'clusters' ? 'grouped into area clusters around the core' : 'along a time axis, oldest on the left'}. Drag to orbit, scroll or pinch to zoom, arrow keys turn, plus and minus zoom, 0 fits, Escape steps back. Tab reaches the areas.`}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} aria-hidden />
      <div className="holo-overlay" aria-hidden>
        <div className="holo-core" data-k="core">
          <i className="holo-core-dot" />
          Memory <span className="holo-n">{num(stats.items)}</span>
        </div>
        {L.areas.map((a, i) => (
          <button key={a.name} type="button" tabIndex={-1} className="holo-area" data-k={`area${i}`} data-lit={litArea === i || undefined} onClick={() => onArea(a.name)} onPointerEnter={(e) => e.pointerType === 'mouse' && onHover(areaId(a.name))} onPointerLeave={(e) => e.pointerType === 'mouse' && onHover(undefined)}>
            <span className="holo-area-n">{a.name}</span>
            <span className="holo-n">{num(a.to - a.from)}</span>
          </button>
        ))}
        {Array.from({ length: ITEM_POOL }, (_, k) => (
          <button key={k} type="button" tabIndex={-1} className="holo-item" data-k={`item${k}`} onClick={(e) => onPick((e.currentTarget as HTMLElement).dataset.id!)} onPointerEnter={(e) => e.pointerType === 'mouse' && onHover((e.currentTarget as HTMLElement).dataset.id)} />
        ))}
        {Array.from({ length: TICK_POOL }, (_, k) => (
          <span key={k} className="holo-tick" data-k={`tick${k}`} />
        ))}
        <div className="holo-mark" data-k="lock" />
        <svg className="holo-leader" data-k="leader">
          <line />
        </svg>
      </div>
      {sel && (
        <button type="button" className="holo-callout" data-k="callout" onClick={() => onPick(sel.id)} aria-label={`${hit === sel.id ? 'Search hit' : 'Picked'}: ${sel.title}. Open its details.`}>
          <span className="holo-callout-t">{nodeLabel(sel)}</span>
          <span className="holo-callout-m">
            {sel.area ?? 'Other'} <span className="holo-sep">·</span> <span className="holo-n">{num(selLinks.length)}</span> links <span className="holo-sep">·</span> {day(sel.at)}
          </span>
        </button>
      )}
      <Readouts phone={phone} narrow={narrow} insets={insets} mode={mode}>
        {{
          all: [
            ['Items', num(stats.items)],
            ['Links', num(stats.links)],
            ['Across areas', `${pct}%`],
            ['Last write', day(stats.last)],
          ],
          sel: sel
            ? {
                title: nodeLabel(sel),
                rows: [
                  ['Area', sel.area ?? 'Other'],
                  ['Links shown', `${num(selLinks.length)} of ${num(sel.degree)}`],
                  ['Out / in', `${selOut} / ${selLinks.length - selOut}`],
                  ['Written', day(sel.at)],
                ],
              }
            : undefined,
        }}
      </Readouts>
      {/* the text alternative: the areas in order, each one flies the camera there when focused */}
      <nav className="holo-areas" aria-label="Areas">
        <ul>
          {L.areas.map((a, i) => (
            <li key={a.name}>
              <button type="button" onFocus={() => (api.current?.flyArea(i), onHover(areaId(a.name)))} onBlur={() => onHover(undefined)} onClick={() => onArea(a.name)}>
                {a.name}, {num(a.to - a.from)} items
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function Readouts({ phone, narrow, insets, mode, children: r }: { phone: boolean; narrow: boolean; insets: LinkViewProps['insets']; mode: HoloMode; children: { all: string[][]; sel?: { title: string; rows: string[][] } } }) {
  if (phone)
    return (
      <p className="holo-line" style={{ top: insets.top + 4, left: insets.left, right: insets.right }} aria-live="polite">
        {r.all.slice(0, 3).map(([k, v], i) => (
          <span key={k}>
            {i > 0 && <span className="holo-sep"> · </span>}
            <span className="holo-n holo-v">{v}</span> {k.toLowerCase()}
          </span>
        ))}
      </p>
    );
  const rows = (list: string[][]) =>
    list.map(([k, v]) => (
      <div key={k} className="holo-row">
        <dt>{k}</dt>
        <dd className="holo-n">{v}</dd>
      </div>
    ));
  return (
    <>
      <dl className="holo-read" data-k="read" style={{ top: insets.top + 10, left: insets.left }} aria-live="polite">
        <div className="holo-subject">All memory</div>
        {rows(r.all)}
      </dl>
      {r.sel && !narrow && (
        <dl className="holo-read holo-right" data-k="read" style={{ top: insets.top + 10, right: insets.right }}>
          <div className="holo-subject">{r.sel.title}</div>
          {rows(r.sel.rows)}
        </dl>
      )}
      <div className="holo-read holo-mode" data-k="read" style={{ bottom: insets.bottom + 10, left: insets.left }}>
        {mode === 'clusters' ? 'Clusters' : 'Timeline'} <span className="holo-sep">·</span> {mode === 'clusters' ? 'newer items sit higher' : 'oldest on the left, areas as lanes'}
      </div>
    </>
  );
}

// ----- the engine ------------------------------------------------------------------------
interface Handlers {
  onHover: (id: string | undefined) => void;
  onPick: (id: string) => void;
  onBlank: () => void;
  setFocusItem: (i: number | undefined) => void;
}
type Live = React.RefObject<{
  H: HoloLayout;
  on: boolean[];
  lit: Set<number>;
  near: Set<number>;
  hits: ReadonlySet<string>;
  selected?: string;
  hit?: string;
  hover?: string;
  gone: (n: number) => boolean;
  lockI?: number;
  litArea: number;
  insets: LinkViewProps['insets'];
  phone: boolean;
  still: boolean;
  focusItem?: number;
  cut?: number;
  deg: Float32Array;
}>;

interface Engine {
  dispose(): void;
  handlers(h: Handlers): void;
  colors(): void;
  layout(h: HoloLayout): void;
  links(): void;
  paint(): void;
  run(on: boolean): void;
  motion(): void;
  timeCut(): void;
  overview(): void;
  dolly(f: number): void;
  turn(left: number, up: number): void;
  flyTo(i: number, dist: number): void;
  flyArea(a: number): void;
  lockOn(): void;
  picked(): string | undefined;
  resize(): void;
}

type Box = [number, number, number, number];
const hitBox = (boxes: Box[], x: number, y: number, w: number, h: number) => boxes.some(([a, b, c, d]) => x < a + c && a < x + w && y < b + d && b < y + h);
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function engine(canvas: HTMLCanvasElement, wrap: HTMLDivElement, L: LinkViewProps['layout'], ix: LinkViewProps['ix'], nodes: readonly MemoryGraphNode[], live: Live, h0: Handlers): Engine {
  const t0 = performance.now();
  let hand = h0;
  const S = () => live.current!;
  const n = L.items.length;
  const A = L.areas.length;
  const phone0 = S().phone;
  // antialias on phones too: hairlines stair-step without it, and MSAA is cheap on tiled mobile GPUs
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  let ratio = Math.min(window.devicePixelRatio || 1, phone0 ? 1.5 : 2);
  renderer.setPixelRatio(ratio);
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 2, 9000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  // a drift you notice only if you look for it: about 25 minutes a turn
  controls.autoRotateSpeed = 0.04;

  const order = Array.from({ length: A }, (_, i) => i);
  let P = palette();
  let H = S().H;

  // ----- the items ----------------------------------------------------------------------
  const pos = new Float32Array(H.pos);
  const tint = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const alpha = new Float32Array(n);
  const pGeo = new BufferGeometry();
  attr(pGeo, 'position', pos);
  attr(pGeo, 'tint', tint);
  attr(pGeo, 'size', size);
  attr(pGeo, 'alpha', alpha);
  const pUni = { uScale: { value: 1 }, uPx: { value: ratio }, uNear: { value: 0 }, uFar: { value: 4000 }, uFog: { value: new Color() } };
  const pMat = new ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false, uniforms: pUni });
  const points = new Points(pGeo, pMat);
  points.frustumCulled = false;

  // ----- links: all drawn, and the lit ones on top ------------------------------------------
  const lUni = { uNear: { value: 0 }, uFar: { value: 4000 }, uDim: { value: 1 } };
  const lMat = lineMat(lUni);
  const lGeo = new BufferGeometry();
  const links = new LineSegments(lGeo, lMat);
  links.frustumCulled = false;
  const hiUni = { uNear: { value: 0 }, uFar: { value: 4000 }, uDim: { value: 1 } };
  const hiMat = lineMat(hiUni);
  const hiGeo = new BufferGeometry();
  const hiLinks = new LineSegments(hiGeo, hiMat);
  hiLinks.frustumCulled = false;
  let drawn: Int32Array = new Int32Array(0);

  // ----- the time axis and the cutoff (Timeline only) -----------------------------------------
  const spineGeo = new BufferGeometry();
  const axUni = { uNear: { value: 0 }, uFar: { value: 4000 }, uDim: { value: 1 } };
  const spine = new LineSegments(spineGeo, lineMat(axUni));
  spine.frustumCulled = false;
  const cutGeo = new BufferGeometry();
  const cutLine = new LineSegments(cutGeo, lineMat(axUni));
  cutLine.frustumCulled = false;

  scene.add(spine, links, hiLinks, points, cutLine);

  // ----- DOM pieces ---------------------------------------------------------------------
  const q = (k: string) => wrap.querySelector<HTMLElement>(`[data-k="${k}"]`);
  const coreEl = q('core')!;
  const areaEls = L.areas.map((_, i) => q(`area${i}`)!);
  const itemEls = Array.from({ length: ITEM_POOL }, (_, k) => q(`item${k}`)!);
  const tickEls = Array.from({ length: TICK_POOL }, (_, k) => q(`tick${k}`)!);
  const lockEl = q('lock')!;
  const leaderEl = q('leader')!;
  const leaderLine = leaderEl.querySelector('line')!;
  const textW = new Map<string, number>();
  const ctx2d = document.createElement('canvas').getContext('2d');
  const measure = (t: string, px: number, weight = 400) => {
    const k = `${px}|${weight}|${t}`;
    let w = textW.get(k);
    if (w === undefined) {
      if (ctx2d) ctx2d.font = `${weight} ${px}px ${getComputedStyle(document.documentElement).getPropertyValue('--sans') || 'sans-serif'}`;
      w = Math.ceil(ctx2d ? ctx2d.measureText(t).width * 1.04 : t.length * px * 0.56);
      textW.set(k, w);
    }
    return w;
  };

  // ----- size and view --------------------------------------------------------------------
  let W = 1;
  let Hh = 1;
  const room = () => {
    const i = S().insets;
    return { x: i.left, y: i.top, w: Math.max(1, W - i.left - i.right), h: Math.max(1, Hh - i.top - i.bottom) };
  };
  const resize = () => {
    const r = wrap.getBoundingClientRect();
    W = Math.max(1, r.width);
    Hh = Math.max(1, r.height);
    renderer.setSize(W, Hh, false);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${Hh}px`;
    camera.aspect = W / Hh;
    // the middle of the free room, between the bands and beside the drawer, is the middle of the picture
    const m = room();
    camera.setViewOffset(W, Hh, -(m.x + m.w / 2 - W / 2), -(m.y + m.h / 2 - Hh / 2), W, Hh);
    camera.updateProjectionMatrix();
    const scale = renderer.getDrawingBufferSize(new Vector2()).y / (2 * Math.tan((FOV * Math.PI) / 360));
    pUni.uScale.value = scale;
    pUni.uPx.value = ratio;
    readBoxes = undefined;
    request();
  };

  /** Camera distance that fits a sphere of radius r in the free room. */
  const fitDist = (r: number) => {
    const m = room();
    const vf = (FOV * Math.PI) / 360;
    const hf = Math.atan(Math.tan(vf) * (m.w / Hh));
    const vfr = Math.atan(Math.tan(vf) * (m.h / Hh));
    return r / Math.sin(Math.min(hf, vfr));
  };
  const home = (h: HoloLayout) => {
    if (h.mode === 'clusters') {
      // areas fill a sphere: fit nearly all of it, high and low
      const d = fitDist(h.extent * 0.95);
      return { target: new Vector3(0, 0, 0), cam: new Vector3(0, Math.sin(0.5) * d, Math.cos(0.5) * d) };
    }
    // square to history, a little above it, so the axis reads level across the room
    const m = room();
    const d = (SPAN * 0.6) / Math.tan(Math.atan(Math.tan((FOV * Math.PI) / 360) * (m.w / Hh)));
    // a tall room (a phone) looks down more, so the lanes open up vertically
    return { target: new Vector3(SPAN * 0.03, 0, 0), cam: new Vector3(SPAN * 0.03, d * (m.w > m.h ? 0.26 : 0.7), d) };
  };

  // ----- motion ---------------------------------------------------------------------
  let fly: { t0: number; ms: number; fc: Vector3; ft: Vector3; tc: Vector3; tt: Vector3 } | undefined;
  const flyCam = (tc: Vector3, tt: Vector3) => {
    if (S().still) {
      camera.position.copy(tc);
      controls.target.copy(tt);
      fly = undefined;
      controls.update();
      return request();
    }
    fly = { t0: performance.now(), ms: FLY_MS, fc: camera.position.clone(), ft: controls.target.clone(), tc, tt };
    idleAt = performance.now();
    request();
  };
  let morph: { t0: number; from: Float32Array; to: Float32Array } | undefined;
  let lockT = 0;
  let idleAt = performance.now();
  let pickedId: string | undefined;
  controls.addEventListener('start', () => {
    fly = undefined;
    idleAt = Infinity;
  });
  controls.addEventListener('end', () => (idleAt = performance.now()));
  controls.addEventListener('change', () => request());

  // ----- colors ------------------------------------------------------------------------
  const colors = () => {
    P = palette();
    pUni.uFog.value.copy(P.bg);
    buildSpine();
    buildCut();
    buildLinks();
    paint();
  };

  /** Timeline: one fine axis, and a short tick down from it at each month (or year, when there are many). */
  const buildSpine = () => {
    if (H.mode !== 'timeline') return plain(spineGeo, [], P.line, 0);
    const p = [-SPAN / 2 - 130, 0, 0, SPAN_END, 0, 0];
    const yearsOnly = H.ticks.length > 30;
    for (const t of H.ticks) if (!yearsOnly || t.year) p.push(t.x, 0, 0, t.x, -(t.year ? TICK_Y : TICK_M), 0);
    plain(spineGeo, p, P.line, P.dark ? 0.75 : 0.7);
  };
  /** Timeline: the scrubber's cutoff, one accent line across the axis. */
  const buildCut = () => {
    const c = S().cut;
    if (H.mode !== 'timeline' || c === undefined) return plain(cutGeo, [], P.accent, 0);
    const x = timeX(H.times, H.lo, H.hi, c);
    plain(cutGeo, [x, -230, 0, x, 230, 0], P.accent, 0.8);
  };

  /** The links the filters leave, as hairline curves; opacity carries weight: links between well linked items read stronger. */
  const buildLinks = () => {
    const s = S();
    const seg = s.phone ? SEG.phone : SEG.desk;
    drawn = pickEdges(L, s.on, s.phone ? CAP.phone : CAP.desk, s.deg);
    const p = new Float32Array(drawn.length * seg * 6);
    const t = new Float32Array(p.length);
    const al = new Float32Array(p.length / 3);
    const hh = morph ? { ...H, pos } : H;
    for (let k = 0; k < drawn.length; k++) {
      const e = drawn[k];
      const E = L.edges[e];
      linkCurve(hh, L, e, seg, p, k * seg * 6);
      // across areas fainter: they bundle through the origin, so many overlap there
      const base = E.cross ? (P.dark ? 0.08 : 0.06) : P.dark ? 0.17 : 0.13;
      const lo = Math.min(s.deg[E.a], s.deg[E.b]);
      const w = Math.min(1, Math.log2(2 + lo) / 5);
      // between two hubs: the brighter (deeper) violet
      const c = lo >= 8 ? P.hot : P.accent;
      for (let v = 0; v < seg * 2; v++) {
        const o = (k * seg * 2 + v) * 3;
        t[o] = c.r;
        t[o + 1] = c.g;
        t[o + 2] = c.b;
        al[k * seg * 2 + v] = base * (0.45 + 0.9 * w);
      }
    }
    attr(lGeo, 'position', p);
    attr(lGeo, 'tint', t);
    attr(lGeo, 'alpha', al);
    buildLit();
  };
  const buildLit = () => {
    const s = S();
    const seg = s.phone ? SEG.phone : SEG.desk;
    const list = [...s.lit];
    const one = s.lockI;
    const p = new Float32Array(list.length * seg * 6);
    const t = new Float32Array(p.length);
    const al = new Float32Array(p.length / 3);
    const hh = morph ? { ...H, pos } : H;
    list.forEach((e, k) => {
      linkCurve(hh, L, e, seg, p, k * seg * 6);
      const E = L.edges[e];
      // the picked or found item's own links in the strong violet, the rest lit in full violet
      const mine = one !== undefined && (E.a === one || E.b === one);
      const c = mine ? P.hot : P.accent;
      const a = mine ? 0.9 : (list.length > 120 ? 0.3 : 0.55) * (P.dark ? 1 : 0.8);
      for (let v = 0; v < seg * 2; v++) {
        const o = (k * seg * 2 + v) * 3;
        t[o] = c.r;
        t[o + 1] = c.g;
        t[o + 2] = c.b;
        al[k * seg * 2 + v] = a;
      }
    });
    attr(hiGeo, 'position', p);
    attr(hiGeo, 'tint', t);
    attr(hiGeo, 'alpha', al);
  };

  /** Item colors, sizes and alphas from the state: lit, found, picked, stepped back. */
  const paint = () => {
    const s = S();
    readBoxes = undefined;
    const busy = s.lit.size > 0 || s.focusItem !== undefined;
    const dark = P.dark;
    for (let i = 0; i < n; i++) {
      const it = L.items[i];
      const d = s.deg[i];
      // small and crisp violet, fuller the more linked; hubs a little larger in the strong violet
      let sz = 2.2 + 0.95 * Math.log2(1 + d);
      let a = (dark ? 0.5 : 0.42) + 0.45 * Math.min(1, Math.log2(1 + d) / 4);
      let c = d >= 8 ? P.hot : P.accent;
      if (s.gone(it.node)) ((a = dark ? 0.08 : 0.12), (sz *= 0.7));
      else if (busy && !s.near.has(i) && s.litArea !== it.area) a *= dark ? 0.3 : 0.32;
      else if (busy && (s.near.has(i) || s.litArea === it.area)) ((sz *= 1.15), (a = 1));
      if (s.hits.has(it.id)) ((c = P.hot), (sz *= 1.3), (a = 1));
      // the picked item: an ink highlight inside its violet ring
      if (i === s.lockI || i === s.focusItem) ((c = P.ink), (sz *= 1.5), (a = 1));
      tint[i * 3] = c.r;
      tint[i * 3 + 1] = c.g;
      tint[i * 3 + 2] = c.b;
      size[i] = sz;
      alpha[i] = a;
    }
    pGeo.attributes.tint.needsUpdate = true;
    pGeo.attributes.size.needsUpdate = true;
    pGeo.attributes.alpha.needsUpdate = true;
    lUni.uDim.value = busy ? 0.35 : 1;
    buildLit();
    labelsDirty = true;
    request();
  };

  // ----- labels -----------------------------------------------------------------------
  const v3 = new Vector3();
  const vp = new Matrix4();
  /** A world point on screen: x, y in CSS px, its depth, and whether it is in front. */
  const project = (x: number, y: number, z: number): [number, number, number, boolean] => {
    v3.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    const depth = -v3.z;
    v3.applyMatrix4(camera.projectionMatrix);
    return [(v3.x * 0.5 + 0.5) * W, (-v3.y * 0.5 + 0.5) * Hh, depth, depth > 1 && Math.abs(v3.x) < 1.2 && Math.abs(v3.y) < 1.2];
  };
  let readBoxes: Box[] | undefined;
  let cand: number[] = [];
  let candAt = 0;
  let labelsDirty = true;
  const shown = new Array<string>(ITEM_POOL).fill('');
  const hide = (el: HTMLElement) => el.style.visibility !== 'hidden' && (el.style.visibility = 'hidden');
  const show = (el: HTMLElement, x: number, y: number) => {
    el.style.visibility = 'visible';
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  /** Pick which items get a title: the picked, found and lit ones, then the most linked near the camera. */
  const choose = () => {
    const s = S();
    const out: number[] = [];
    const seen = new Set<number>();
    const push = (i: number | undefined) => i !== undefined && !seen.has(i) && !s.gone(L.items[i].node) && (seen.add(i), out.push(i));
    push(s.lockI);
    push(s.hover ? L.byId.get(s.hover) : undefined);
    push(s.focusItem);
    for (const i of [...s.near].sort((a, b) => s.deg[b] - s.deg[a]).slice(0, 40)) push(i);
    for (const id of s.hits) push(L.byId.get(id));
    if (!s.near.size) {
      // near the camera and well linked, in front and on screen
      const score: Array<[number, number]> = [];
      const cam = camera.position;
      for (let i = 0; i < n; i++) {
        if (s.deg[i] < 2) continue;
        const [x, y, depth, front] = project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        if (!front || x < 0 || y < 0 || x > W || y > Hh) continue;
        score.push([i, Math.log2(1 + s.deg[i]) / (depth / cam.length() + 0.2) ** 2]);
      }
      score.sort((a, b) => b[1] - a[1]);
      for (const [i] of score.slice(0, 50)) push(i);
    }
    cand = out;
    candAt = performance.now();
  };
  const placeLabels = () => {
    const s = S();
    const m = room();
    const top = m.y + 2;
    const bottom = m.y + m.h - 2;
    const right = m.x + m.w;
    if (!readBoxes) {
      const r0 = wrap.getBoundingClientRect();
      readBoxes = [...wrap.querySelectorAll<HTMLElement>('[data-k="read"], .holo-line')].map((el) => {
        const r = el.getBoundingClientRect();
        return [r.left - r0.left - 6, r.top - r0.top - 4, r.width + 12, r.height + 8] as Box;
      });
    }
    const boxes: Box[] = [...readBoxes];
    const inRoom = (x: number, y: number, w: number, hh: number) => x >= m.x + 2 && x + w <= right - 2 && y >= top && y + hh <= bottom;

    // the origin: a small dot and "Memory 2,980" beside it (Timeline: at the end of the axis)
    const [cx, cy, , cf] = H.mode === 'clusters' ? project(0, 0, 0) : project(SPAN_END, 0, 0);
    const cw = coreEl.offsetWidth || 110;
    if (cf && inRoom(cx - 3, cy - 10, cw, 20) && !hitBox(boxes, cx - 6, cy - 12, cw + 8, 24)) (show(coreEl, cx - 3, cy - 10), boxes.push([cx - 6, cy - 12, cw + 8, 24]));
    else hide(coreEl);

    // focus: a fine ring on the item, one leader line to its card
    const callout = wrap.querySelector<HTMLElement>('[data-k="callout"]');
    if (s.lockI !== undefined) {
      const i = s.lockI;
      const [x, y, , f] = project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      if (f) {
        const k = ease(s.still ? 1 : Math.min(1, (performance.now() - lockT) / LOCK_MS));
        show(lockEl, x - MARK_R, y - MARK_R);
        lockEl.style.opacity = String(k);
        boxes.push([x - MARK_R - 2, y - MARK_R - 2, MARK_R * 2 + 4, MARK_R * 2 + 4]);
        if (callout) {
          const cw2 = callout.offsetWidth;
          const ch = callout.offsetHeight;
          // up and to the right, else the other way, staying in the room
          const sides: Array<[number, number]> = [[1, -1], [-1, -1], [1, 1], [-1, 1]];
          let best: [number, number] | undefined;
          for (const [sx, sy] of sides) {
            const bx = sx > 0 ? x + 56 : x - 56 - cw2;
            const by = sy < 0 ? y - 52 - ch : y + 52;
            if (inRoom(bx, by, cw2, ch) && !hitBox(boxes, bx, by, cw2, ch)) {
              best = [bx, by];
              break;
            }
          }
          best ??= [Math.max(m.x + 4, Math.min(right - cw2 - 4, x + 56)), Math.max(top, Math.min(bottom - ch, y - 52 - ch))];
          const [bx, by] = best;
          callout.style.visibility = 'visible';
          // the card settles 4px into place as it fades in
          callout.style.transform = `translate(${Math.round(bx)}px, ${Math.round(by + (1 - k) * 4)}px)`;
          callout.style.opacity = String(k);
          boxes.push([bx - 4, by - 4, cw2 + 8, ch + 8]);
          // one straight hairline from the ring's edge to the nearest point of the card's near edge
          const ex = Math.max(bx, Math.min(bx + cw2, x));
          const ey = by < y ? by + ch : by;
          const d = Math.hypot(ex - x, ey - y) || 1;
          leaderEl.style.visibility = 'visible';
          leaderEl.style.opacity = String(k);
          leaderLine.setAttribute('x1', String(x + ((ex - x) / d) * (MARK_R + 2)));
          leaderLine.setAttribute('y1', String(y + ((ey - y) / d) * (MARK_R + 2)));
          leaderLine.setAttribute('x2', String(ex));
          leaderLine.setAttribute('y2', String(ey));
        }
      } else (hide(lockEl), hide(leaderEl), callout && hide(callout));
    } else (hide(lockEl), hide(leaderEl), callout && hide(callout));

    // area names over their constellations (or lanes), biggest first
    const areaOrder = order.slice().sort((a, b) => (L.areas[b].to - L.areas[b].from) - (L.areas[a].to - L.areas[a].from));
    if (s.litArea >= 0) areaOrder.unshift(...areaOrder.splice(areaOrder.indexOf(s.litArea), 1));
    for (const a of areaOrder) {
      const el = areaEls[a];
      const c = H.centers;
      const up = H.mode === 'clusters' ? H.radius[a] * 1.2 : 0;
      const [x, y, , f] = project(c[a * 3], c[a * 3 + 1] + up, c[a * 3 + 2]);
      // the count is mono: about 0.6em a figure
      const w = measure(L.areas[a].name, s.phone ? 13 : 12, 500) + num(L.areas[a].to - L.areas[a].from).length * 6.8 + 8;
      let put = false;
      if (f)
        for (const dy of [-22, -2, -42, 18]) {
          const bx = x - w / 2;
          const by = y + dy;
          if (inRoom(bx, by, w, 20) && !hitBox(boxes, bx - 4, by, w + 8, 20)) {
            show(el, bx, by);
            boxes.push([bx - 4, by, w + 8, 20]);
            put = true;
            break;
          }
        }
      if (!put) hide(el);
    }

    // month and year marks along the time axis
    let tk = 0;
    if (H.mode === 'timeline') {
      const yearsOnly = H.ticks.length > 30;
      for (const t of H.ticks) {
        if (tk >= TICK_POOL) break;
        if (yearsOnly && !t.year) continue;
        const [x, y0, , f] = project(t.x, -(t.year ? TICK_Y : TICK_M), 0);
        const y = y0 + 4;
        const w = t.label.length * 6.6 + 6;
        if (!f || !inRoom(x - w / 2, y, w, 16) || hitBox(boxes, x - w / 2, y, w, 16)) continue;
        const el = tickEls[tk++];
        if (el.textContent !== t.label) el.textContent = t.label;
        el.dataset.year = t.year ? '1' : '';
        show(el, x - w / 2, y);
        boxes.push([x - w / 2 - 3, y, w + 6, 16]);
      }
    }
    for (; tk < TICK_POOL; tk++) hide(tickEls[tk]);

    // item titles beside their points
    let k = 0;
    // at rest only a few titles, so the space stays calm; more once something is lit or found
    const max = s.near.size || s.hits.size ? (s.phone ? 7 : ITEM_POOL) : s.phone ? 5 : 12;
    for (const i of cand) {
      if (k >= max) break;
      const [x, y, , f] = project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      if (!f) continue;
      const it = L.items[i];
      const nd = ix.byId.get(it.id)!;
      const title = nodeLabel(nd);
      const w = Math.min(s.phone ? 150 : 210, measure(title, 12) + 4);
      const forced = i === s.lockI;
      if (forced) continue;
      let px: number | undefined;
      for (const bx of [x + 9, x - 9 - w]) if (inRoom(bx, y - 8, w, 16) && !hitBox(boxes, bx - 2, y - 9, w + 4, 18)) ((px = bx), 0);
      if (px === undefined) continue;
      boxes.push([px - 2, y - 9, w + 4, 18]);
      const el = itemEls[k];
      if (shown[k] !== it.id) {
        shown[k] = it.id;
        el.textContent = title;
        el.dataset.id = it.id;
        el.setAttribute('aria-label', `${nd.title}, ${L.areas[it.area].name}, ${nd.degree} links`);
      }
      el.style.width = `${w}px`;
      el.dataset.near = s.near.has(i) || s.hits.has(it.id) ? '1' : '';
      show(el, px, y - 8);
      k++;
    }
    for (; k < ITEM_POOL; k++) (hide(itemEls[k]), (shown[k] = ''));
  };

  // ----- pointer ---------------------------------------------------------------------
  const nearest = (cx: number, cy: number, touch: boolean): number | undefined => {
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = vp.elements;
    const s = S();
    let best: number | undefined;
    let bd = (touch ? 22 : 12) ** 2;
    for (let i = 0; i < n; i++) {
      if (s.gone(L.items[i].node)) continue;
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1) continue;
      const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 * W + W / 2;
      const sy = (-(e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 * Hh + Hh / 2;
      const d = (sx - cx) ** 2 + (sy - cy) ** 2;
      if (d < bd) ((bd = d), (best = i));
    }
    return best;
  };
  const local = (ev: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top] as const;
  };
  let down: { x: number; y: number; id: number } | undefined;
  let hoverRaf = 0;
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse' || ev.buttons) return;
    const [x, y] = local(ev);
    cancelAnimationFrame(hoverRaf);
    hoverRaf = requestAnimationFrame(() => {
      const i = nearest(x, y, false);
      const id = i === undefined ? undefined : L.items[i].id;
      canvas.style.cursor = id ? 'pointer' : '';
      const cur = S().hover;
      if (id !== cur && !(id === undefined && cur?.startsWith('area:'))) hand.onHover(id);
    });
  };
  const onDown = (ev: PointerEvent) => {
    down = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    idleAt = Infinity;
  };
  const onUp = (ev: PointerEvent) => {
    const d = down;
    down = undefined;
    idleAt = performance.now();
    if (!d || d.id !== ev.pointerId || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6) return;
    const [x, y] = local(ev);
    const i = nearest(x, y, ev.pointerType !== 'mouse');
    if (i === undefined) return hand.onBlank();
    pickedId = L.items[i].id;
    hand.onPick(pickedId);
  };
  const onDbl = (ev: MouseEvent) => {
    const [x, y] = local(ev);
    const i = nearest(x, y, false);
    if (i !== undefined) hand.setFocusItem(i);
  };
  const onLeave = () => S().hover && !S().hover!.startsWith('area:') && hand.onHover(undefined);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('pointerleave', onLeave);

  // ----- the loop ---------------------------------------------------------------------
  let raf = 0;
  let running = true;
  let first = true;
  let last = 0;
  const perf = { first: 0, frames: [] as number[], cpu: [] as number[], ratio, edges: 0, degraded: false };
  (window as unknown as { __HOLO_PERF__: typeof perf }).__HOLO_PERF__ = perf;
  const request = () => {
    if (!raf && running) raf = requestAnimationFrame(frame);
  };
  const animating = () => !S().still || !!fly || !!morph || (lockT && performance.now() - lockT < LOCK_MS);
  function frame(now: number) {
    raf = 0;
    const c0 = performance.now();
    const s = S();
    if (last) {
      perf.frames.push(now - last);
      if (perf.frames.length > 240) perf.frames.shift();
    }
    last = now;
    // flights and the layout morph
    if (fly) {
      const k = ease(Math.min(1, (now - fly.t0) / fly.ms));
      camera.position.lerpVectors(fly.fc, fly.tc, k);
      controls.target.lerpVectors(fly.ft, fly.tt, k);
      if (k >= 1) fly = undefined;
    }
    if (morph) {
      const k = ease(Math.min(1, (now - morph.t0) / MORPH_MS));
      for (let j = 0; j < pos.length; j++) pos[j] = morph.from[j] + (morph.to[j] - morph.from[j]) * k;
      pGeo.attributes.position.needsUpdate = true;
      lUni.uDim.value = Math.max(0, 1 - k * 3);
      if (k >= 1) {
        morph = undefined;
        buildLinks();
        paint();
      }
      labelsDirty = true;
    }
    controls.autoRotate = !s.still && !fly && s.focusItem === undefined && s.lockI === undefined && now - idleAt > DRIFT_AFTER;
    controls.update();
    // depth fog: from a little in front of the target to well behind it
    const dist = camera.position.distanceTo(controls.target);
    for (const u of [pUni, lUni, hiUni, axUni]) {
      u.uNear.value = dist * 0.6;
      u.uFar.value = dist * 2;
    }
    renderer.render(scene, camera);
    if (labelsDirty || now - candAt > 400) choose();
    placeLabels();
    labelsDirty = false;
    perf.cpu.push(performance.now() - c0);
    if (perf.cpu.length > 240) perf.cpu.shift();
    if (first) {
      first = false;
      perf.first = performance.now() - t0;
      mark('memory-3d:first-frame', t0);
    }
    // slow frames: a lower pixel ratio first
    if (!perf.degraded && perf.frames.length >= 90 && !s.still) {
      const sorted = [...perf.frames].sort((a, b) => a - b);
      if (sorted[sorted.length >> 1] > 26 && ratio > 1) {
        ratio = 1;
        perf.ratio = 1;
        perf.degraded = true;
        renderer.setPixelRatio(1);
        resize();
      }
    }
    if (animating()) request();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();
  colors();
  const h = home(H);
  camera.position.copy(h.cam);
  controls.target.copy(h.target);
  controls.maxDistance = fitDist(H.extent) * 3;
  controls.minDistance = 12;
  controls.update();
  perf.edges = drawn.length;
  request();

  return {
    dispose() {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(hoverRaf);
      running = false;
      ro.disconnect();
      controls.dispose();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('pointerleave', onLeave);
      scene.traverse((o) => {
        const m = o as Points;
        m.geometry?.dispose();
        (m.material as ShaderMaterial | undefined)?.dispose?.();
      });
      renderer.dispose();
    },
    handlers: (x) => (hand = x),
    colors,
    layout(next) {
      if (next === H) return;
      const fromP = new Float32Array(pos);
      H = next;
      const still = S().still;
      if (still) {
        pos.set(H.pos);
        pGeo.attributes.position.needsUpdate = true;
      } else morph = { t0: performance.now(), from: fromP, to: H.pos };
      colors();
      const hm = home(H);
      controls.maxDistance = fitDist(H.extent) * 3;
      flyCam(hm.cam, hm.target);
    },
    links() {
      if (morph) return;
      buildLinks();
      perf.edges = drawn.length;
      request();
    },
    paint,
    run(on) {
      running = on;
      if (on) request();
      else (cancelAnimationFrame(raf), (raf = 0), (last = 0));
    },
    motion() {
      if (S().still) ((fly = undefined), (morph = undefined), pos.set(H.pos), (pGeo.attributes.position.needsUpdate = true));
      request();
    },
    timeCut() {
      buildCut();
      request();
    },
    overview() {
      const hm = home(H);
      flyCam(hm.cam, hm.target);
    },
    dolly(f) {
      const off = camera.position.clone().sub(controls.target).multiplyScalar(1 / f);
      flyCam(controls.target.clone().add(off), controls.target.clone());
    },
    turn(left, up) {
      controls.rotateLeft(left);
      controls.rotateUp(up);
      idleAt = performance.now();
      request();
    },
    flyTo(i, d) {
      const p = new Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const dir = camera.position.clone().sub(controls.target).normalize();
      flyCam(p.clone().add(dir.multiplyScalar(d)), p);
    },
    flyArea(a) {
      const c = new Vector3(H.centers[a * 3], H.centers[a * 3 + 1], H.centers[a * 3 + 2]);
      const dir = camera.position.clone().sub(controls.target).normalize();
      flyCam(c.clone().add(dir.multiplyScalar(fitDist(H.mode === 'clusters' ? H.radius[a] * 1.6 : 320))), c);
    },
    lockOn() {
      lockT = performance.now();
      labelsDirty = true;
      request();
    },
    picked: () => pickedId,
    resize,
  };
}
