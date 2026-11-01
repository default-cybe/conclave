/**
 * Conclave dot-matrix wave (spec 9). Our own engine, ported from
 * docs/design/reference/wave.js with no globals.
 *
 * A grid of dots whose brightness comes from a variant field. Each cell gets a
 * stable grain so flat areas have texture that never shimmers, then the value
 * is quantized into four levels with a 4x4 Bayer threshold, so mid tones break
 * into an ordered dither. One Path2D per level, four fills per frame.
 *
 * Runtime:
 * - one requestAnimationFrame loop drives every mounted wave at 30fps
 * - backing store at devicePixelRatio (capped 2 on touch, 3 elsewhere)
 * - offscreen canvases and hidden documents do not draw; each wave keeps its
 *   own clock, so it resumes where it stopped
 * - reduced motion (system or Appearance) or `static` draws one frame at t = 6
 * - a wave that takes more than 8ms to draw three frames running widens its
 *   dot pitch by 1px, up to twice the start value
 */

export type WaveVariant = 'hero' | 'scope' | 'strip' | 'ambient';
export type WaveTone = 'ink' | 'signal';

export interface WaveOptions {
  variant: WaveVariant;
  /** dot pitch in px */
  gap: number;
  /** radius of the brightest dot in px */
  radius: number;
  speed: number;
  amplitude: number;
  /** 0..1 activity level for strip and scope */
  rate: number;
  /** scope only: values 0..1, oldest first */
  series?: number[] | null;
  tone: WaveTone;
  static: boolean;
  levels: number;
}

export interface WaveHandle {
  set(next: Partial<WaveOptions>): void;
  redraw(): void;
  destroy(): void;
}

export const WAVE_DEFAULTS: Record<WaveVariant, Pick<WaveOptions, 'gap' | 'radius' | 'tone'>> = {
  hero: { gap: 7, radius: 1.25, tone: 'ink' },
  scope: { gap: 4, radius: 1.1, tone: 'ink' },
  strip: { gap: 3, radius: 0.9, tone: 'signal' },
  ambient: { gap: 6, radius: 1, tone: 'ink' },
};

const TAU = Math.PI * 2;
const FRAME_MS = 1000 / 30;
const STATIC_T = 6.0;
const BUDGET_MS = 8;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16);

/** cheap stable per-cell grain in 0..1 */
function grain(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Brightness field. u in 0..1 left to right, v in -1..1 bottom to top. */
function field(o: WaveOptions, rows: number, u: number, v: number, t: number): number {
  const A = o.amplitude;
  switch (o.variant) {
    case 'strip': {
      // a short undulating trace; packets of brightness ride along it
      const y = 0.62 * Math.sin(TAU * (u * 1.4 - t * 0.45)) * Math.min(1, A);
      const d = v - y;
      const line = Math.exp(-(d * d) / 0.22);
      const packet = 0.5 + 0.5 * Math.sin(TAU * (u * 2.6 - t * 0.9));
      return 0.07 + line * (0.5 + 0.72 * o.rate * packet);
    }
    case 'scope': {
      const s = o.series;
      let y = 0.3;
      if (s && s.length > 1) {
        const f = u * (s.length - 1);
        const i = Math.floor(f);
        const k = f - i;
        const a = s[Math.min(i, s.length - 1)];
        const b = s[Math.min(i + 1, s.length - 1)];
        y = a + (b - a) * (k * k * (3 - 2 * k));
      }
      // a small live ripple at the leading edge
      const edge = Math.max(0, (u - 0.86) / 0.14);
      y += edge * 0.06 * A * o.rate * 1.67 * Math.sin(TAU * (u * 9 - t * 1.4));
      const top = -1 + 2 * Math.min(0.98, Math.max(0.02, y * A));
      const d = v - top;
      const line = Math.exp(-(d * d) / Math.max(0.004, 0.6 * Math.pow(2 / rows, 2)));
      const area = d < 0 ? 0.16 + 0.26 * Math.max(0, 1 + d * 0.9) : 0;
      const sweepPos = (t * 0.12) % 1.25;
      const sweep = Math.exp(-Math.pow((u - sweepPos) * 9, 2)) * 0.35 * (d < 0.05 ? 1 : 0.2);
      const live = edge * 0.25;
      return Math.max(line * (0.95 + live), area) + sweep * (area > 0 ? 1 : 0.3);
    }
    case 'ambient': {
      const a = Math.sin(TAU * (u * 1.1 - t * 0.03) + v * 2.1);
      const b = Math.sin(TAU * (u * 2.7 + t * 0.02) - v * 1.3 + 1.9);
      return 0.06 + 0.14 * (0.5 + 0.5 * (a * 0.6 + b * 0.4));
    }
    default: {
      // hero: a composite trace with a delayed afterglow
      const env = 0.35 + 0.65 * Math.sin(Math.PI * u);
      const tr = (tt: number) =>
        A *
        env *
        (0.52 * Math.sin(TAU * (1.15 * u - 0.07 * tt)) + 0.27 * Math.sin(TAU * (2.6 * u + 0.045 * tt) + 1.7) + 0.12 * Math.sin(TAU * (6.3 * u - 0.19 * tt) + 0.4));
      const d1 = v - tr(t) * 0.62;
      const d2 = v - tr(t - 2.2) * 0.62;
      const line = Math.exp(-(d1 * d1) / 0.01);
      const halo = Math.exp(-(d1 * d1) / 0.09) * 0.34;
      const glow = Math.exp(-(d2 * d2) / 0.035) * 0.26;
      const swell = 0.17 * Math.pow(0.5 + 0.5 * Math.sin(2.4 * u + 1.8 * v - 0.5 * t), 2) * (1 - Math.abs(v) * 0.6);
      return line * 0.92 + halo + glow + swell;
    }
  }
}

// ---------------------------------------------------------------------------
// Environment: reduced motion, theme changes, visibility, one shared loop
// ---------------------------------------------------------------------------

const hasDom = typeof window !== 'undefined';
const reduceMQ = hasDom ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
const coarseMQ = hasDom ? window.matchMedia('(pointer: coarse)') : undefined;
const schemeMQ = hasDom ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;

export function motionReduced(): boolean {
  if (!hasDom) return true;
  return !!reduceMQ?.matches || document.documentElement.dataset.motion === 'reduce';
}

class Instance {
  o: WaveOptions;
  ctx: CanvasRenderingContext2D;
  W = 0;
  H = 0;
  t = STATIC_T;
  last = 0;
  onscreen = true;
  slow = 0;
  baseGap: number;
  ink = '#888';
  hot = '#fff';
  rows = 1;

  constructor(
    public canvas: HTMLCanvasElement,
    o: WaveOptions,
  ) {
    this.o = o;
    this.baseGap = o.gap;
    this.ctx = canvas.getContext('2d', { alpha: true })!;
    this.readColors();
  }

  get still() {
    return this.o.static || motionReduced();
  }

  readColors() {
    const cs = getComputedStyle(this.canvas);
    const ink = this.o.tone === 'signal' ? cs.getPropertyValue('--signal') : cs.getPropertyValue('--wave-ink');
    const hot = this.o.tone === 'signal' ? cs.getPropertyValue('--signal') : cs.getPropertyValue('--wave-hot');
    this.ink = usable(this.ctx, ink.trim()) ?? cs.color;
    this.hot = usable(this.ctx, hot.trim()) ?? this.ink;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, coarseMQ?.matches ? 2 : 3);
    this.W = Math.max(1, Math.round(r.width));
    this.H = Math.max(1, Math.round(r.height));
    const bw = Math.round(this.W * dpr);
    const bh = Math.round(this.H * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** Advance the clock by real elapsed time and draw. */
  tick(now: number) {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.t += dt * this.o.speed;
    const t0 = performance.now();
    this.draw();
    const took = performance.now() - t0;
    if (took > BUDGET_MS) {
      if (++this.slow >= 3 && this.o.gap < this.baseGap * 2) {
        this.o.gap = Math.min(this.baseGap * 2, this.o.gap + 1);
        this.slow = 0;
      }
    } else this.slow = 0;
  }

  draw() {
    const { ctx, W, H, o } = this;
    if (W < 2 || H < 2) return;
    const t = this.still ? STATIC_T : this.t;
    ctx.clearRect(0, 0, W, H);
    const g = o.gap;
    const L = o.levels;
    const cols = Math.max(1, Math.floor(W / g));
    const rows = Math.max(1, Math.floor(H / g));
    this.rows = rows;
    const ox = (W - (cols - 1) * g) / 2;
    const oy = (H - (rows - 1) * g) / 2;
    const paths: Path2D[] = [];
    for (let i = 0; i <= L; i++) paths.push(new Path2D());
    for (let cy = 0; cy < rows; cy++) {
      const v = rows === 1 ? 0 : 1 - (2 * cy) / (rows - 1);
      for (let cx = 0; cx < cols; cx++) {
        const u = cols === 1 ? 0.5 : cx / (cols - 1);
        let f = field(o, rows, u, v, t);
        f += (grain(cx, cy) - 0.5) * 0.06;
        const q = Math.max(0, Math.min(1, f)) * L;
        let lvl = Math.floor(q);
        if (q - lvl > BAYER[(cy & 3) * 4 + (cx & 3)]) lvl++;
        if (!(lvl > 0)) continue;
        if (lvl > L) lvl = L;
        const r = o.radius * (0.42 + 0.58 * (lvl / L));
        const x = ox + cx * g;
        const y = oy + cy * g;
        paths[lvl].moveTo(x + r, y);
        paths[lvl].arc(x, y, r, 0, TAU);
      }
    }
    for (let i = 1; i <= L; i++) {
      ctx.globalAlpha = i === L ? 1 : 0.18 + 0.6 * (i / L);
      ctx.fillStyle = i === L ? this.hot : this.ink;
      ctx.fill(paths[i]);
    }
    ctx.globalAlpha = 1;
  }
}

/** Canvas fillStyle accepts most CSS colors; fall back when it does not (old WebKit and oklch). */
function usable(ctx: CanvasRenderingContext2D, color: string): string | undefined {
  if (!color) return undefined;
  const prev = ctx.fillStyle;
  ctx.fillStyle = '#010203';
  ctx.fillStyle = color;
  const ok = ctx.fillStyle !== '#010203' || color === '#010203';
  ctx.fillStyle = prev;
  return ok ? color : undefined;
}

const live = new Set<Instance>();
const byCanvas = new Map<Element, Instance>();
let raf = 0;
let lastFrame = 0;
let visible = !hasDom || document.visibilityState === 'visible';
let ro: ResizeObserver | undefined;
let io: IntersectionObserver | undefined;
let wired = false;

function loop(now: number) {
  raf = 0;
  if (!visible) return;
  let any = false;
  if (now - lastFrame >= FRAME_MS - 1) {
    lastFrame = now;
    for (const w of live) {
      if (!w.onscreen || w.still) {
        w.last = 0;
        continue;
      }
      any = true;
      w.tick(now);
    }
  } else {
    for (const w of live) if (w.onscreen && !w.still) any = true;
  }
  if (any) raf = requestAnimationFrame(loop);
}

function kick() {
  if (!raf && visible && live.size) raf = requestAnimationFrame(loop);
}

function redrawAll(readColors: boolean) {
  for (const w of live) {
    if (readColors) w.readColors();
    w.draw();
  }
  kick();
}

function wire() {
  if (wired || !hasDom) return;
  wired = true;
  ro = new ResizeObserver((entries) => {
    for (const e of entries) byCanvas.get(e.target)?.resize();
  });
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const w = byCanvas.get(e.target);
      if (!w) continue;
      w.onscreen = e.isIntersecting;
      w.last = 0;
    }
    kick();
  });
  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState === 'visible';
    for (const w of live) w.last = 0;
    kick();
  });
  // theme flips: html[data-theme] or the system scheme
  new MutationObserver(() => redrawAll(true)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion', 'class'] });
  schemeMQ?.addEventListener('change', () => redrawAll(true));
  reduceMQ?.addEventListener('change', () => redrawAll(false));
}

/** Mount a wave on a canvas sized by CSS. Returns a handle for live changes. */
export function mountWave(canvas: HTMLCanvasElement, opts: Partial<WaveOptions> & { variant: WaveVariant }): WaveHandle {
  wire();
  const d = WAVE_DEFAULTS[opts.variant];
  const o: WaveOptions = { gap: d.gap, radius: d.radius, tone: d.tone, speed: 1, amplitude: 1, rate: 0.6, series: null, static: false, levels: 4, ...strip(opts), variant: opts.variant };
  const w = new Instance(canvas, o);
  live.add(w);
  byCanvas.set(canvas, w);
  ro?.observe(canvas);
  io?.observe(canvas);
  w.resize();
  kick();
  return {
    set(next) {
      const n = strip(next);
      const toneChanged = n.tone !== undefined && n.tone !== w.o.tone;
      if (n.gap !== undefined) w.baseGap = n.gap;
      Object.assign(w.o, n);
      if (toneChanged) w.readColors();
      w.draw();
      kick();
    },
    redraw() {
      w.readColors();
      w.draw();
    },
    destroy() {
      live.delete(w);
      byCanvas.delete(canvas);
      ro?.unobserve(canvas);
      io?.unobserve(canvas);
    },
  };
}

function strip<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in o) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Map live tokens per second to a strip rate (spec 9.2). */
export function rateFromTps(tps: number | undefined): number {
  if (tps === undefined || Number.isNaN(tps)) return 0.6;
  return Math.max(0.15, Math.min(1, tps / 60));
}
