/**
 * Memory > Map, 3D view: the owner's memory as a holographic instrument
 * (Tree / Rings / 3D). Loaded on its own (MemoryMap lazy-imports this file),
 * so three.js costs nothing until the view opens.
 *
 * The core in the middle is the whole memory, with live counts; the areas
 * are glowing clusters around it (Clusters) or lanes along a time axis
 * (Timeline); every item is one point of a single Points object, every
 * real link a curve in one additive LineSegments, faded with distance and
 * bundled through the core or the time spine (holo-model.ts). The camera
 * orbits slowly at rest, a sweep passes over the clusters, and the found
 * or picked item is locked on with brackets and a leader line. Labels,
 * readouts and the lock are DOM over the canvas, placed every frame with a
 * box test, so they stay crisp and never overlap.
 *
 * Mouse, trackpad and touch orbit, zoom and pan (OrbitControls). Hover
 * lights an item's links; click opens the drawer; double click flies to the
 * item and keeps its neighbours lit; Esc steps back; Fit returns to the
 * overview. Rendering stops when the tab is hidden or the view is off
 * screen. Reduced motion stops the orbit and the sweep and jumps instead of
 * flying (MemoryMap shows Rings instead unless the owner asks for 3D).
 *
 * The Memory map's 3D view alone may glow, use the cyan and violet
 * palette, the sweep, brackets and crosshair ticks (docs/DESIGN.md, 29).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  Points,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  type Blending,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MemoryGraphNode } from '@conclave/core/client';
import { useOnscreen, usePageVisible } from '@/components/motion';
import { isDark, useColorVersion } from '@/components/motion/frame';
import { cn } from '@/lib/text';
import { edgeOn } from './link-model';
import { areaId, nodeLabel } from './graph-model';
import { CORE_R, SPAN, holoStats, layoutHolo, linkCurve, pickEdges, timeX, type HoloLayout, type HoloMode } from './holo-model';
import type { LinkViewProps } from './RingCanvas';
import './holo.css';

export interface HoloProps extends LinkViewProps {
  nodes: readonly MemoryGraphNode[];
  mode: HoloMode;
  /** No orbit, no sweep, jumps instead of flights. */
  still: boolean;
  /** The time scrubber's cutoff, drawn as a ring on the Timeline. */
  cut?: number;
}

const num = (n: number) => n.toLocaleString('en-US');
const day = (t?: number) => (t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'none');
const ITEM_POOL = 26;
const TICK_POOL = 24;
const FLY_MS = 1100;
const LOCK_MS = 340;
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
const POINT_VS = /* glsl */ `
attribute float size;
attribute float alpha;
attribute vec3 tint;
uniform float uScale;
uniform vec4 uSweep;
uniform float uNear;
uniform float uFar;
varying vec3 vTint;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = 0.0;
  if (uSweep.x > -0.5) {
    if (uSweep.x < 0.5) {
      float d = mod(uSweep.y - atan(position.z, position.x) + 12.566371, 6.283185);
      s = exp(-d * 2.4);
    } else {
      float d = uSweep.y - position.x;
      s = d >= 0.0 ? exp(-d / uSweep.z) : exp(-d * d / 60.0);
    }
    s *= uSweep.w;
  }
  float depth = max(1.0, -mv.z);
  float fade = clamp(1.0 - (depth - uNear) / max(1.0, uFar - uNear), 0.3, 1.0);
  gl_PointSize = clamp(size * uScale / depth * (1.0 + 0.6 * s), 1.6, 36.0);
  vTint = tint + s * 0.5;
  vAlpha = alpha * fade * (1.0 + 0.9 * s);
}`;
const POINT_FS = /* glsl */ `
uniform float uLight;
uniform float uSoft;
varying vec3 vTint;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.46, 0.2, d) * (1.0 - uSoft);
  float halo = exp(-d * d * mix(4.5, 3.0, uSoft)) * mix(mix(0.55, 0.25, uLight), 1.0, uSoft);
  vec3 c = mix(vTint, vec3(1.0), core * 0.4 * (1.0 - uLight));
  gl_FragColor = vec4(c, (core + halo) * vAlpha);
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
  float fade = clamp(1.0 - (-mv.z - uNear) / max(1.0, uFar - uNear), 0.1, 1.0);
  vTint = tint;
  vAlpha = alpha * fade * uDim;
}`;
const LINE_FS = /* glsl */ `
varying vec3 vTint;
varying float vAlpha;
void main() { gl_FragColor = vec4(vTint, vAlpha); }`;
const RIM_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const RIM_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(vN, vV)), 2.0);
  gl_FragColor = vec4(uColor, (0.06 + f) * uAlpha);
}`;
const SWEEP_VS = /* glsl */ `
varying vec3 vP;
void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SWEEP_FS = /* glsl */ `
uniform float uAngle;
uniform float uAlpha;
uniform vec2 uR;
uniform vec3 uColor;
varying vec3 vP;
void main() {
  float r = length(vP.xz);
  float d = mod(uAngle - atan(vP.z, vP.x) + 12.566371, 6.283185);
  float wake = exp(-d * 3.0) * 0.22 + smoothstep(0.025, 0.0, d) * 0.55;
  float edge = smoothstep(uR.x, uR.x + 0.06, r) * (1.0 - smoothstep(uR.y * 0.9, uR.y, r));
  gl_FragColor = vec4(uColor, wake * edge * uAlpha);
}`;

interface Palette {
  dark: boolean;
  a: Color;
  b: Color;
  ink: Color;
  areas: Color[];
  blend: Blending;
}

function palette(nAreas: number, order: number[]): Palette {
  const dark = isDark();
  const areas: Color[] = new Array(nAreas);
  // cyan to violet along the ring, so neighbouring constellations are near in hue
  order.forEach((a, k) => (areas[a] = new Color().setHSL((186 + (k / Math.max(1, nAreas - 1)) * 92) / 360, dark ? 0.85 : 0.75, dark ? 0.66 : 0.4)));
  return {
    dark,
    a: new Color(dark ? '#67e8f9' : '#0e7490'),
    b: new Color(dark ? '#a78bfa' : '#6d28d9'),
    ink: new Color(dark ? '#ecfeff' : '#082f3a'),
    areas,
    blend: dark ? AdditiveBlending : NormalBlending,
  };
}

/** Line segments for circles: `n` pieces each, around `c` in the plane of axes u and v. */
function circles(list: Array<{ c: [number, number, number]; r: number; u: 0 | 1 | 2; v: 0 | 1 | 2; n?: number; gap?: number }>): Float32Array {
  const total = list.reduce((s, x) => s + (x.n ?? 64), 0);
  const out = new Float32Array(total * 6);
  let o = 0;
  for (const { c, r, u, v, n = 64, gap = 0 } of list)
    for (let k = 0; k < n; k++) {
      // a gap leaves every other piece out: a dashed ring
      for (const t of [k, k + 1 - gap]) {
        const p = [...c];
        p[u] += Math.cos((t / n) * Math.PI * 2) * r;
        p[v] += Math.sin((t / n) * Math.PI * 2) * r;
        out.set(p, o);
        o += 3;
      }
    }
  return out;
}

function lineMat(blend: Blending, uniforms: Record<string, { value: unknown }> = {}) {
  return new ShaderMaterial({ vertexShader: LINE_VS, fragmentShader: LINE_FS, transparent: true, depthWrite: false, blending: blend, uniforms: { uNear: { value: 0 }, uFar: { value: 4000 }, uDim: { value: 1 }, ...uniforms } });
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
          <span className="num holo-core-n">{num(stats.items)}</span>
          <span className="holo-core-w">
            <span className="num">{num(stats.links)}</span> links
          </span>
        </div>
        {L.areas.map((a, i) => (
          <button key={a.name} type="button" tabIndex={-1} className="holo-area" data-k={`area${i}`} data-lit={litArea === i || undefined} onClick={() => onArea(a.name)} onPointerEnter={(e) => e.pointerType === 'mouse' && onHover(areaId(a.name))} onPointerLeave={(e) => e.pointerType === 'mouse' && onHover(undefined)}>
            <span className="holo-area-n">{a.name}</span>
            <span className="num">{num(a.to - a.from)}</span>
          </button>
        ))}
        {Array.from({ length: ITEM_POOL }, (_, k) => (
          <button key={k} type="button" tabIndex={-1} className="holo-item" data-k={`item${k}`} onClick={(e) => onPick((e.currentTarget as HTMLElement).dataset.id!)} onPointerEnter={(e) => e.pointerType === 'mouse' && onHover((e.currentTarget as HTMLElement).dataset.id)} />
        ))}
        {Array.from({ length: TICK_POOL }, (_, k) => (
          <span key={k} className="holo-tick num" data-k={`tick${k}`} />
        ))}
        <div className="holo-lock" data-k="lock">
          <i />
          <i />
          <i />
          <i />
        </div>
        <svg className="holo-leader" data-k="leader">
          <polyline points="" />
        </svg>
      </div>
      {sel && (
        <button type="button" className="holo-callout" data-k="callout" onClick={() => onPick(sel.id)} aria-label={`${hit === sel.id ? 'Search hit' : 'Picked'}: ${sel.title}. Open its details.`}>
          <span className="holo-callout-t">{nodeLabel(sel)}</span>
          <span className="holo-callout-m">
            {sel.area} · <span className="num">{selLinks.length}</span> links · {day(sel.at)}
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
            <span className="num holo-v">{v}</span> {k.toLowerCase()}
          </span>
        ))}
      </p>
    );
  const rows = (list: string[][]) =>
    list.map(([k, v]) => (
      <div key={k} className="holo-row">
        <dt>{k}</dt>
        <dd className="num">{v}</dd>
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
        <span className="holo-dot" aria-hidden /> {mode === 'clusters' ? 'Clusters: areas as constellations, linked items together' : 'Timeline: oldest on the left, areas as lanes'}
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
  const renderer = new WebGLRenderer({ canvas, antialias: !phone0, alpha: true, powerPreference: 'high-performance' });
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
  controls.autoRotateSpeed = 0.28;

  const order = Array.from({ length: A }, (_, i) => i);
  // the hue order follows the ring: holo-model's chain, read back from the cluster angles
  let P = palette(A, order);
  let H = S().H;
  const chainHue = () => {
    const c = H.centers;
    const ang = order.map((a) => Math.atan2(c[a * 3 + 2], c[a * 3]));
    const by = [...order].sort((x, y) => ang[x] - ang[y]);
    P = palette(A, by);
  };
  chainHue();

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
  const pUni = { uScale: { value: 1 }, uSweep: { value: new Vector4(-1, 0, 0, 0) }, uNear: { value: 0 }, uFar: { value: 4000 }, uLight: { value: 0 }, uSoft: { value: 0 } };
  const pMat = new ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false, uniforms: pUni });
  const points = new Points(pGeo, pMat);
  points.frustumCulled = false;

  // area glows: one soft point per area
  const gPos = new Float32Array(H.centers);
  const gTint = new Float32Array(A * 3);
  const gSize = new Float32Array(A);
  const gAlpha = new Float32Array(A);
  const gGeo = new BufferGeometry();
  attr(gGeo, 'position', gPos);
  attr(gGeo, 'tint', gTint);
  attr(gGeo, 'size', gSize);
  attr(gGeo, 'alpha', gAlpha);
  const gUni = { ...pUni, uSoft: { value: 1 }, uSweep: { value: new Vector4(-1, 0, 0, 0) } };
  const gMat = new ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false, uniforms: gUni });
  const glows = new Points(gGeo, gMat);
  glows.frustumCulled = false;

  // ----- links: all drawn, and the lit ones on top ------------------------------------------
  const lUni = { uNear: { value: 0 }, uFar: { value: 4000 }, uDim: { value: 1 } };
  const lMat = lineMat(AdditiveBlending, lUni);
  const lGeo = new BufferGeometry();
  const links = new LineSegments(lGeo, lMat);
  links.frustumCulled = false;
  const hiUni = { uNear: { value: 0 }, uFar: { value: 4000 }, uDim: { value: 1 } };
  const hiMat = lineMat(AdditiveBlending, hiUni);
  const hiGeo = new BufferGeometry();
  const hiLinks = new LineSegments(hiGeo, hiMat);
  hiLinks.frustumCulled = false;
  let drawn: Int32Array = new Int32Array(0);

  // ----- the core, shells, the sweep and the time spine -----------------------------------------
  const core = new Group();
  const rimUni = { uColor: { value: new Color() }, uAlpha: { value: 1 } };
  const rim = new Mesh(new SphereGeometry(CORE_R * 0.62, 48, 32), new ShaderMaterial({ vertexShader: RIM_VS, fragmentShader: RIM_FS, transparent: true, depthWrite: false, uniforms: rimUni }));
  const wire = new LineSegments(new EdgesGeometry(new IcosahedronGeometry(CORE_R * 0.9, 1)), new LineBasicMaterial({ transparent: true, depthWrite: false }));
  const ringGeo = new BufferGeometry();
  // three rings round the core: one dashed, one with tick marks, one plain
  const ticks = new Float32Array(72 * 6);
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const l = k % 6 ? 4 : 9;
    ticks.set([Math.cos(a) * CORE_R * 1.5, 0, Math.sin(a) * CORE_R * 1.5, Math.cos(a) * (CORE_R * 1.5 + l), 0, Math.sin(a) * (CORE_R * 1.5 + l)], k * 6);
  }
  const ringPts = new Float32Array([...circles([{ c: [0, 0, 0], r: CORE_R * 1.22, u: 0, v: 2, n: 96, gap: 0.5 }, { c: [0, 0, 0], r: CORE_R * 1.5, u: 0, v: 2, n: 128 }]), ...ticks]);
  attr(ringGeo, 'position', ringPts);
  const rings = new LineSegments(ringGeo, new LineBasicMaterial({ transparent: true, depthWrite: false }));
  const tilt = new Group();
  tilt.add(rings);
  tilt.rotation.x = 0.35;
  const orbit2 = new LineSegments(new BufferGeometry().setAttribute('position', new BufferAttribute(circles([{ c: [0, 0, 0], r: CORE_R * 1.85, u: 0, v: 1, n: 160, gap: 0.6 }]), 3)), new LineBasicMaterial({ transparent: true, depthWrite: false }));
  core.add(rim, wire, tilt, orbit2);

  const shellGeo = new BufferGeometry();
  const shells = new LineSegments(shellGeo, lineMat(AdditiveBlending));
  shells.frustumCulled = false;

  // a unit disc, scaled to the layout
  const swUni = { uAngle: { value: 0 }, uAlpha: { value: 1 }, uR: { value: [0.12, 1.06] }, uColor: { value: new Color() } };
  const sweepGeo = new RingGeometry(0.12, 1.06, 160, 1);
  sweepGeo.rotateX(-Math.PI / 2);
  const sweep = new Mesh(sweepGeo, new ShaderMaterial({ vertexShader: SWEEP_VS, fragmentShader: SWEEP_FS, transparent: true, depthWrite: false, side: 2, uniforms: swUni }));
  const scanRing = new LineSegments(new BufferGeometry().setAttribute('position', new BufferAttribute(circles([{ c: [0, 0, 0], r: 255, u: 1, v: 2, n: 128 }, { c: [0, 0, 0], r: 240, u: 1, v: 2, n: 128, gap: 0.5 }]), 3)), new LineBasicMaterial({ transparent: true, depthWrite: false }));
  const spineGeo = new BufferGeometry();
  const spine = new LineSegments(spineGeo, lineMat(AdditiveBlending));
  spine.frustumCulled = false;
  const cutRing = new LineSegments(new BufferGeometry().setAttribute('position', new BufferAttribute(circles([{ c: [0, 0, 0], r: 270, u: 1, v: 2, n: 128 }]), 3)), new LineBasicMaterial({ transparent: true, depthWrite: false }));

  scene.add(shells, spine, links, hiLinks, glows, points, core, sweep, scanRing, cutRing);

  // ----- DOM pieces ---------------------------------------------------------------------
  const q = (k: string) => wrap.querySelector<HTMLElement>(`[data-k="${k}"]`);
  const coreEl = q('core')!;
  const areaEls = L.areas.map((_, i) => q(`area${i}`)!);
  const itemEls = Array.from({ length: ITEM_POOL }, (_, k) => q(`item${k}`)!);
  const tickEls = Array.from({ length: TICK_POOL }, (_, k) => q(`tick${k}`)!);
  const lockEl = q('lock')!;
  const leaderEl = q('leader')!;
  const leaderLine = leaderEl.querySelector('polyline')!;
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
    gUni.uScale.value = scale;
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
      // the ring is flat and seen at an angle: it fits in less than its sphere
      const d = fitDist(h.extent * 0.9);
      return { target: new Vector3(0, 0, 0), cam: new Vector3(0, Math.sin(0.5) * d, Math.cos(0.5) * d) };
    }
    // along history: from in front of the oldest end, a little above, looking toward now
    // the axis is long: fit its length across the room
    const m = room();
    const d = (SPAN * 0.56) / Math.tan(Math.atan(Math.tan((FOV * Math.PI) / 360) * (m.w / Hh)));
    return { target: new Vector3(0, 0, 0), cam: new Vector3(-SPAN * 0.12, d * 0.3, d * 0.95) };
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
  let morph: { t0: number; from: Float32Array; to: Float32Array; gFrom: Float32Array; gTo: Float32Array } | undefined;
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
    chainHue();
    const blend = P.blend;
    for (const m of [pMat, gMat, lMat, hiMat, shells.material, spine.material, wire.material, rings.material, orbit2.material, sweep.material, scanRing.material, cutRing.material] as Array<ShaderMaterial | LineBasicMaterial>) {
      m.blending = blend;
      m.needsUpdate = true;
    }
    pUni.uLight.value = P.dark ? 0 : 1;
    gUni.uLight.value = P.dark ? 0 : 1;
    rimUni.uColor.value.copy(P.a);
    rimUni.uAlpha.value = P.dark ? 0.9 : 0.55;
    const lb = (o: LineSegments, c: Color, a: number) => {
      const m = o.material as LineBasicMaterial;
      m.color.copy(c);
      m.opacity = a;
    };
    lb(wire, P.a, P.dark ? 0.55 : 0.5);
    lb(rings, P.a, P.dark ? 0.6 : 0.55);
    lb(orbit2, P.b, P.dark ? 0.45 : 0.45);
    lb(scanRing, P.a, P.dark ? 0.6 : 0.55);
    lb(cutRing, P.b, P.dark ? 0.9 : 0.85);
    swUni.uColor.value.copy(P.a);
    swUni.uAlpha.value = P.dark ? 1 : 0.7;
    for (let a = 0; a < A; a++) {
      const c = P.areas[a];
      gTint.set([c.r, c.g, c.b], a * 3);
      gSize[a] = H.radius[a] * (H.mode === 'clusters' ? 2.6 : 0);
      gAlpha[a] = P.dark ? 0.16 : 0.1;
    }
    gGeo.attributes.tint.needsUpdate = true;
    gGeo.attributes.size.needsUpdate = true;
    gGeo.attributes.alpha.needsUpdate = true;
    buildShells();
    buildSpine();
    buildLinks();
    paint();
  };

  const buildShells = () => {
    if (H.mode !== 'clusters') return attr(shellGeo, 'position', new Float32Array(0)), attr(shellGeo, 'tint', new Float32Array(0)), attr(shellGeo, 'alpha', new Float32Array(0));
    const list: Parameters<typeof circles>[0] = [];
    for (let a = 0; a < A; a++) {
      const c: [number, number, number] = [H.centers[a * 3], H.centers[a * 3 + 1], H.centers[a * 3 + 2]];
      const r = H.radius[a] * 1.08;
      list.push({ c, r, u: 0, v: 2, n: 72 }, { c, r, u: 0, v: 1, n: 72, gap: 0.5 }, { c, r: r * 1.12, u: 0, v: 2, n: 72, gap: 0.6 });
    }
    const p = circles(list);
    const t = new Float32Array(p.length);
    const al = new Float32Array(p.length / 3);
    const per = (72 * 3 * 2);
    for (let a = 0; a < A; a++) {
      const c = P.areas[a];
      for (let v = a * per; v < (a + 1) * per; v++) (t.set([c.r, c.g, c.b], v * 3), (al[v] = P.dark ? 0.32 : 0.4));
    }
    // the bezel on the floor round everything: a ring, a dashed ring, a tick every 5 degrees
    const R = H.extent * 1.06;
    const y = -H.extent * 0.22;
    const ring = circles([
      { c: [0, y, 0], r: R, u: 0, v: 2, n: 180 },
      { c: [0, y, 0], r: R * 1.04, u: 0, v: 2, n: 240, gap: 0.55 },
    ]);
    const tk = new Float32Array(72 * 6);
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      const l = R * (k % 6 ? 0.025 : 0.06);
      tk.set([Math.cos(a) * R, y, Math.sin(a) * R, Math.cos(a) * (R - l), y, Math.sin(a) * (R - l)], k * 6);
    }
    const all = new Float32Array(p.length + ring.length + tk.length);
    all.set(p);
    all.set(ring, p.length);
    all.set(tk, p.length + ring.length);
    const t2 = new Float32Array(all.length);
    t2.set(t);
    const al2 = new Float32Array(all.length / 3);
    al2.set(al);
    for (let v = p.length / 3; v < al2.length; v++) (t2.set([P.a.r, P.a.g, P.a.b], v * 3), (al2[v] = P.dark ? 0.3 : 0.4));
    attr(shellGeo, 'position', all);
    attr(shellGeo, 'tint', t2);
    attr(shellGeo, 'alpha', al2);
    sweep.scale.setScalar(H.extent);
    sweep.position.y = y;
  };
  const buildSpine = () => {
    if (H.mode !== 'timeline') return attr(spineGeo, 'position', new Float32Array(0)), attr(spineGeo, 'tint', new Float32Array(0)), attr(spineGeo, 'alpha', new Float32Array(0));
    const list: Parameters<typeof circles>[0] = H.ticks.map((t) => ({ c: [t.x, 0, 0] as [number, number, number], r: t.year ? 60 : 22, u: 1 as const, v: 2 as const, n: t.year ? 96 : 40 }));
    const rp = circles(list);
    const p = new Float32Array(rp.length + 6);
    p.set([-SPAN / 2 - 130, 0, 0, SPAN / 2 + 200, 0, 0]);
    p.set(rp, 6);
    const t = new Float32Array(p.length);
    const al = new Float32Array(p.length / 3);
    for (let v = 0; v < al.length; v++) (t.set([P.a.r, P.a.g, P.a.b], v * 3), (al[v] = v < 2 ? 0.7 : P.dark ? 0.3 : 0.35));
    attr(spineGeo, 'position', p);
    attr(spineGeo, 'tint', t);
    attr(spineGeo, 'alpha', al);
  };

  /** The links the filters leave, as curves, tinted from one end's area to the other's. */
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
      const ca = P.areas[L.items[E.a].area];
      const cb = P.areas[L.items[E.b].area];
      // across areas fainter: they bundle through the core, so many overlap there
      const base = E.cross ? (P.dark ? 0.07 : 0.1) : P.dark ? 0.2 : 0.22;
      for (let v = 0; v < seg * 2; v++) {
        const f = (Math.floor(v / 2) + (v % 2)) / seg;
        const o = (k * seg * 2 + v) * 3;
        t[o] = ca.r + (cb.r - ca.r) * f;
        t[o + 1] = ca.g + (cb.g - ca.g) * f;
        t[o + 2] = ca.b + (cb.b - ca.b) * f;
        al[k * seg * 2 + v] = base;
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
      const mine = one !== undefined && (E.a === one || E.b === one);
      const c = mine ? P.ink : P.areas[L.items[E.a].area];
      const c2 = mine ? P.a : P.areas[L.items[E.b].area];
      for (let v = 0; v < seg * 2; v++) {
        const f = (Math.floor(v / 2) + (v % 2)) / seg;
        const o = (k * seg * 2 + v) * 3;
        t[o] = c.r + (c2.r - c.r) * f;
        t[o + 1] = c.g + (c2.g - c.g) * f;
        t[o + 2] = c.b + (c2.b - c.b) * f;
        al[k * seg * 2 + v] = list.length > 300 ? 0.35 : 0.9;
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
      const c = P.areas[it.area];
      const d = s.deg[i];
      let sz = 4.5 + 2.4 * Math.log2(1 + d);
      let a = dark ? 0.9 : 0.85;
      let r = c.r;
      let g = c.g;
      let b = c.b;
      if (s.gone(it.node)) (a = dark ? 0.05 : 0.08), (sz *= 0.7);
      else if (busy && !s.near.has(i) && s.litArea !== it.area) a *= dark ? 0.16 : 0.22;
      else if (busy && s.near.has(i)) sz *= 1.35;
      if (s.hits.has(it.id)) ((r = P.ink.r), (g = P.ink.g), (b = P.ink.b), (sz *= 1.6), (a = 1));
      if (i === s.lockI || i === s.focusItem) ((r = P.ink.r), (g = P.ink.g), (b = P.ink.b), (sz *= 2.2), (a = 1));
      tint[i * 3] = r;
      tint[i * 3 + 1] = g;
      tint[i * 3 + 2] = b;
      size[i] = sz;
      alpha[i] = a;
    }
    pGeo.attributes.tint.needsUpdate = true;
    pGeo.attributes.size.needsUpdate = true;
    pGeo.attributes.alpha.needsUpdate = true;
    lUni.uDim.value = busy ? (dark ? 0.3 : 0.35) : 1;
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

    // the core's count
    const cp = H.mode === 'clusters' ? [0, 0, 0] : [SPAN / 2 + 150, 0, 0];
    // under the core, clear of its rings
    const [cx, cy0, , cf] = project(cp[0], cp[1], cp[2]);
    const [, cyb] = project(cp[0], cp[1] - CORE_R * 1.9, cp[2]);
    const cy = Math.max(cy0, cyb) + 20;
    const cw = 96;
    if (cf && inRoom(cx - cw / 2, cy - 20, cw, 40)) (show(coreEl, cx - cw / 2, cy - 20), boxes.push([cx - cw / 2, cy - 20, cw, 40]));
    else hide(coreEl);

    // the lock on: brackets closing on the item, a leader to its callout
    const callout = wrap.querySelector<HTMLElement>('[data-k="callout"]');
    if (s.lockI !== undefined) {
      const i = s.lockI;
      const [x, y, , f] = project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      if (f) {
        const k = s.still ? 1 : Math.min(1, (performance.now() - lockT) / LOCK_MS);
        const half = 15 + (1 - ease(k)) * 34;
        lockEl.style.visibility = 'visible';
        lockEl.style.transform = `translate(${Math.round(x - half)}px, ${Math.round(y - half)}px)`;
        lockEl.style.width = lockEl.style.height = `${Math.round(half * 2)}px`;
        lockEl.style.opacity = String(0.4 + 0.6 * k);
        boxes.push([x - half, y - half, half * 2, half * 2]);
        if (callout) {
          const cw2 = callout.offsetWidth;
          const ch = callout.offsetHeight;
          // up and to the right, else the other way, staying in the room
          const sides: Array<[number, number]> = [[1, -1], [-1, -1], [1, 1], [-1, 1]];
          let best: [number, number] | undefined;
          for (const [sx, sy] of sides) {
            const bx = sx > 0 ? x + 64 : x - 64 - cw2;
            const by = sy < 0 ? y - 58 - ch : y + 58;
            if (inRoom(bx, by, cw2, ch) && !hitBox(boxes, bx, by, cw2, ch)) {
              best = [bx, by];
              break;
            }
          }
          best ??= [Math.max(m.x + 4, Math.min(right - cw2 - 4, x + 64)), Math.max(top, Math.min(bottom - ch, y - 58 - ch))];
          const [bx, by] = best;
          callout.style.visibility = 'visible';
          callout.style.transform = `translate(${Math.round(bx)}px, ${Math.round(by)}px)`;
          boxes.push([bx - 4, by - 4, cw2 + 8, ch + 8]);
          // elbow leader: from the bracket's corner, diagonal, then along the callout's edge
          const ex = bx < x ? bx + cw2 : bx;
          const ey = by < y ? by + ch : by;
          const sx = x + (ex > x ? half : -half);
          const sy = y + (ey > y ? half : -half);
          const kx = ex + (ex > x ? -14 : 14);
          leaderEl.style.visibility = 'visible';
          leaderLine.setAttribute('points', `${sx},${sy} ${kx},${ey} ${ex + (ex > x ? 0 : 0)},${ey}`);
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
      const w = measure(L.areas[a].name, s.phone ? 13 : 14, 600) + measure(num(L.areas[a].to - L.areas[a].from), 12) + 8;
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
        const r = t.year ? 66 : 28;
        const [x, y, , f] = project(t.x, -r, 0);
        const w = measure(t.label, 11.5) + 6;
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
    const max = s.phone ? 7 : ITEM_POOL;
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
      for (let j = 0; j < gPos.length; j++) gPos[j] = morph.gFrom[j] + (morph.gTo[j] - morph.gFrom[j]) * k;
      pGeo.attributes.position.needsUpdate = true;
      gGeo.attributes.position.needsUpdate = true;
      lUni.uDim.value = Math.max(0, 1 - k * 3);
      if (k >= 1) {
        morph = undefined;
        buildLinks();
        paint();
      }
      labelsDirty = true;
    }
    controls.autoRotate = !s.still && !fly && s.focusItem === undefined && s.lockI === undefined && now - idleAt > 2500;
    controls.update();
    // the core turns, the sweep passes
    const t = now / 1000;
    if (!s.still) {
      wire.rotation.y = t * 0.15;
      wire.rotation.x = t * 0.05;
      rings.rotation.y = -t * 0.22;
      orbit2.rotation.z = t * 0.1;
      orbit2.rotation.x = 1.1;
    }
    const sweepOn = !s.still && !morph;
    if (H.mode === 'clusters') {
      const ang = (t * 0.55) % (Math.PI * 2);
      swUni.uAngle.value = ang;
      sweep.visible = sweepOn;
      scanRing.visible = false;
      pUni.uSweep.value.set(sweepOn ? 0 : -1, ang, 0, P.dark ? 0.9 : 0.6);
    } else {
      sweep.visible = false;
      const x = -SPAN / 2 - 100 + ((t * 160) % (SPAN + 400));
      scanRing.visible = sweepOn;
      scanRing.position.set(x, 0, 0);
      pUni.uSweep.value.set(sweepOn ? 1 : -1, x, 90, P.dark ? 0.9 : 0.6);
    }
    core.position.set(H.mode === 'clusters' ? 0 : SPAN / 2 + 150, 0, 0);
    const dist = camera.position.distanceTo(controls.target);
    for (const u of [pUni, lUni, hiUni]) {
      u.uNear.value = dist * 0.55;
      u.uFar.value = dist * 2.1;
    }
    gUni.uNear.value = dist * 0.55;
    gUni.uFar.value = dist * 2.1;
    hiUni.uDim.value = 1;
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
        const m = o as Mesh;
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
      const fromG = new Float32Array(gPos);
      H = next;
      const still = S().still;
      if (still) {
        pos.set(H.pos);
        gPos.set(H.centers);
        pGeo.attributes.position.needsUpdate = true;
        gGeo.attributes.position.needsUpdate = true;
      } else morph = { t0: performance.now(), from: fromP, to: H.pos, gFrom: fromG, gTo: H.centers };
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
      const c = S().cut;
      cutRing.visible = H.mode === 'timeline' && c !== undefined;
      if (cutRing.visible) cutRing.position.set(timeX(H.times, H.lo, H.hi, c!), 0, 0);
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
