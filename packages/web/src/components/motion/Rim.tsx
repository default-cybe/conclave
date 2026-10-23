import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/text';
import { EASE, clamp, lerp, mod, seg } from './ease';
import { dprNow, isDark, onFrame, tokenRGB, useColorVersion, type RGB } from './frame';
import { DUR, LOOP } from './tokens';
import { useOnscreen, usePageVisible, useReducedMotion } from './useReducedMotion';

/**
 * One thin light on the composer edge (light.html Rim, Breath, Settle, Fault).
 *
 * live     a violet light with a 190px tail runs once round the edge every 4s
 * waiting  the light goes out and the whole edge breathes amber: in 1.6s, out 2.2s, rest
 * done     the light coasts 700ms, its tail opens round the whole edge, glows evenly, then fades to the hairline
 * failed   the light brakes over 600ms, its tail draws in, it cools to the fault color and stays as a short mark
 * idle     nothing (the box's own hairline)
 *
 * Put it inside the composer box (position: relative); it reads the box's
 * size and corner radius and draws 4px past its edge, never over content.
 */
export type RimState = 'idle' | 'live' | 'waiting' | 'done' | 'failed';

export interface RimProps {
  state: RimState;
  className?: string;
}

const M = 4; // canvas margin past the box edge, for the glow (5px wide, so 2.5px out)
const TAIL = 190;
const FAULT_TAIL = 30;

interface Box {
  w: number;
  h: number;
  r: number;
  /** half the host's border width: the edge line sits on the border's middle */
  b: number;
}

const perimeter = ({ w, h, r }: Box) => 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;

/** The point at arc length s, clockwise from the left end of the top edge. */
function rrAt({ w, h, r }: Box, s: number): [number, number] {
  const L1 = w - 2 * r;
  const L2 = h - 2 * r;
  const A = (Math.PI * r) / 2;
  const P = 2 * L1 + 2 * L2 + 4 * A;
  s = mod(s, P);
  if (s < L1) return [r + s, 0];
  s -= L1;
  if (s < A) {
    const a = -Math.PI / 2 + s / r;
    return [w - r + r * Math.cos(a), r + r * Math.sin(a)];
  }
  s -= A;
  if (s < L2) return [w, r + s];
  s -= L2;
  if (s < A) {
    const a = s / r;
    return [w - r + r * Math.cos(a), h - r + r * Math.sin(a)];
  }
  s -= A;
  if (s < L1) return [w - r - s, h];
  s -= L1;
  if (s < A) {
    const a = Math.PI / 2 + s / r;
    return [r + r * Math.cos(a), h - r + r * Math.sin(a)];
  }
  s -= A;
  if (s < L2) return [0, h - r - s];
  s -= L2;
  const a = Math.PI + s / r;
  return [r + r * Math.cos(a), r + r * Math.sin(a)];
}

function rrPath(ctx: CanvasRenderingContext2D, { w, h, r }: Box) {
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
}

/** The light's head position on the live clock: one lap per 4s with a slight swell in pace. */
function headAt(P: number, t: number): number {
  const u = t / LOOP.rim;
  return P * (u + 0.018 * Math.sin(2 * Math.PI * u)) - 40;
}

/** Breath: in 1600ms on the sine, out 2200ms, then rest. */
export function breath(t: number): number {
  const u = mod(t, LOOP.breath);
  return u < 1600 ? EASE.sine(u / 1600) : u < 3800 ? 1 - EASE.sine((u - 1600) / 2200) : 0;
}

type Mode = 'off' | 'run' | 'settle' | 'fault';

/** The Rim through its states. Like the Knot, each clock runs only in its own state. */
export class RimMotion {
  state: RimState;
  mode: Mode = 'off';
  /** live clock: the light's travel */
  liveT = 0;
  /** breath clock */
  breathT = 0;
  /** since the light's mode began (settle, fault) */
  modeAt = 0;
  lightA = 0;
  breathA = 0;
  private last: number | null = null;
  private fadeFrom = { light: 0, breath: 0, at: 0 };

  constructor(state: RimState, now = 0) {
    this.state = state;
    this.last = now;
    if (state === 'live') {
      this.mode = 'run';
      this.lightA = 1;
    } else if (state === 'waiting') this.breathA = 1;
    else if (state === 'failed') {
      this.mode = 'fault';
      this.lightA = 1;
      this.modeAt = now - 2000;
    }
    this.fadeFrom = { light: this.lightA, breath: this.breathA, at: now };
  }

  private targets(): { light: number; breath: number } {
    switch (this.state) {
      case 'live':
        return { light: 1, breath: 0 };
      case 'waiting':
        return { light: 0, breath: 1 };
      case 'done':
        return { light: this.mode === 'settle' ? 1 : 0, breath: 0 };
      case 'failed':
        return { light: 1, breath: 0 };
      default:
        return { light: 0, breath: 0 };
    }
  }

  set(state: RimState, now: number) {
    if (state === this.state) return;
    this.advance(now);
    const running = this.mode === 'run' && this.lightA > 0.01;
    this.state = state;
    if (state === 'live') {
      if (this.mode !== 'run') {
        this.mode = 'run';
        this.lightA = 0;
      }
    } else if (state === 'done') {
      this.mode = running ? 'settle' : 'off';
      this.modeAt = now;
    } else if (state === 'failed') {
      // a running light brakes into the mark; otherwise the still mark fades in
      this.mode = 'fault';
      this.modeAt = running ? now : now - 2000;
    }
    this.fadeFrom = { light: this.lightA, breath: this.breathA, at: now };
    if ((state === 'done' || state === 'failed') && running) this.fadeFrom.light = 1;
  }

  private advance(now: number) {
    const dt = this.last === null ? 0 : clamp(now - this.last, 0, 100);
    this.last = now;
    if (this.state === 'live') this.liveT += dt;
    // the breath keeps its pace while it fades out, and starts from rest next time
    if (this.state === 'waiting' || this.breathA > 0.001) this.breathT += dt;
    else this.breathT = 0;
    const k = EASE.out(seg(now, this.fadeFrom.at, this.fadeFrom.at + DUR.d3));
    const tg = this.targets();
    this.lightA = lerp(this.fadeFrom.light, tg.light, k);
    this.breathA = lerp(this.fadeFrom.breath, tg.breath, k);
  }

  /** Advance to now; true while anything is drawn or changing. */
  step(now: number): boolean {
    this.advance(now);
    if (this.state === 'live' || this.state === 'waiting') return true;
    const fading = now - this.fadeFrom.at < DUR.d3 + 20;
    if (this.mode === 'settle' && this.state === 'done') return fading || now - this.modeAt < 1600;
    if (this.mode === 'fault' && this.state === 'failed') return fading || now - this.modeAt < 1300;
    return fading;
  }
}

interface RimColors {
  signal: RGB;
  hot: RGB;
  warn: RGB;
  fault: RGB;
  faultHot: RGB;
  even: RGB;
  dark: boolean;
}

const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a)})`;

function drawLight(ctx: CanvasRenderingContext2D, box: Box, head: number, tail: number, k: number, c: number, C: RimColors) {
  if (k <= 0.001) return;
  const col = mixRGB(C.signal, C.fault, c);
  const hot = mixRGB(C.hot, C.faultHot, c);
  const halo = C.dark ? 0.22 : 0.12;
  const wash = (C.dark ? 0.06 : 0.05) * (1 - c * 0.5);
  // the surface just inside the edge catches a little light near the head: a band 14px deep, never a blob
  const [hx, hy] = rrAt(box, head);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, box.w, box.h, box.r);
  ctx.roundRect(14, 14, Math.max(0, box.w - 28), Math.max(0, box.h - 28), Math.max(0, box.r - 14));
  ctx.clip('evenodd');
  const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 70);
  g.addColorStop(0, rgba(col, wash * k * 1.4));
  g.addColorStop(1, rgba(col, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, box.w, box.h);
  ctx.restore();
  const step = 2;
  const n = Math.max(2, Math.ceil(tail / step));
  ctx.lineCap = 'butt';
  for (let pass = 0; pass < 2; pass++) {
    let prev = rrAt(box, head);
    for (let i = 1; i <= n; i++) {
      const behind = i * step;
      const p = rrAt(box, head - behind);
      const f = Math.pow(1 - (behind - step / 2) / tail, 1.7);
      if (pass === 0) {
        ctx.lineWidth = 5;
        ctx.strokeStyle = rgba(col, halo * f * f * k);
      } else {
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(mixRGB(col, hot, f * f * f), f * k);
      }
      ctx.beginPath();
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      prev = p;
    }
  }
}

function drawEven(ctx: CanvasRenderingContext2D, box: Box, color: RGB, a: number, glow: number) {
  if (a <= 0.001) return;
  rrPath(ctx, box);
  ctx.lineWidth = 5;
  ctx.strokeStyle = rgba(color, a * glow);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(color, a);
  ctx.stroke();
}

/** Draw the Rim at time now (or its still pose under reduced motion). */
function drawRim(ctx: CanvasRenderingContext2D, box: Box, m: RimMotion, now: number, C: RimColors, still: boolean) {
  const P = perimeter(box);
  const v = P / LOOP.rim;
  const halo = C.dark ? 0.22 : 0.12;
  if (still) {
    if (m.state === 'live') drawLight(ctx, box, P * 0.3, TAIL, 1, 0, C);
    if (m.state === 'waiting') {
      drawEven(ctx, box, C.warn, 0.45, 0.2);
    }
    if (m.state === 'failed') drawLight(ctx, box, P * 0.3, FAULT_TAIL, 0.6, 1, C);
    return;
  }
  const tail = Math.min(TAIL, P * 0.45);
  const t = now - m.modeAt;
  if (m.mode === 'run') drawLight(ctx, box, headAt(P, m.liveT), tail, m.lightA, 0, C);
  else if (m.mode === 'settle') {
    const c = seg(t, 0, 700);
    const s = headAt(P, m.liveT) + v * 700 * (c - (c * c) / 2);
    const k = 1 - EASE.sine(seg(t, 50, 550));
    drawLight(ctx, box, s, lerp(tail, P, EASE.out(c)), k, 0, C);
    const fill = EASE.sine(seg(t, 50, 550)) * (1 - EASE.sine(seg(t, 600, 1500))) * 0.62;
    drawEven(ctx, box, C.even, fill, halo * 0.6);
  } else if (m.mode === 'fault') {
    const b = seg(t, 0, 600);
    const s = headAt(P, m.liveT) + v * 600 * (b - (b * b) / 2);
    const k = 1 - 0.4 * EASE.sine(seg(t, 600, 1200));
    drawLight(ctx, box, s, lerp(tail, FAULT_TAIL, EASE.out(b)), k * m.lightA, EASE.out(seg(t, 50, 600)), C);
  }
  if (m.breathA > 0.001) {
    const b = breath(m.breathT);
    // the whole edge breathes amber; the words stay still
    drawEven(ctx, box, C.warn, m.breathA * (0.16 + 0.42 * b), 0.08 + 0.22 * b);
  }
}

export function Rim({ state, className }: RimProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const onscreen = useOnscreen(ref);
  const visible = usePageVisible();
  const colorV = useColorVersion();
  const [box, setBox] = useState<Box | null>(null);
  const motion = useRef<RimMotion | null>(null);
  if (!motion.current) motion.current = new RimMotion(state, performance.now());
  const colors = useRef<RimColors | null>(null);

  useLayoutEffect(() => {
    motion.current!.set(state, performance.now());
  }, [state]);

  // follow the box's size and corner radius
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const read = () => {
      const cs = getComputedStyle(host);
      const bw = parseFloat(cs.borderTopWidth) || 0;
      // the edge line runs along the middle of the host's border
      const w = host.offsetWidth - bw;
      const h = host.offsetHeight - bw;
      const r = Math.max(0, Math.min((parseFloat(cs.borderTopLeftRadius) || 0) - bw / 2, w / 2, h / 2));
      setBox((o) => (o && o.w === w && o.h === h && o.r === r && o.b === bw / 2 ? o : { w, h, r, b: bw / 2 }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dark = isDark();
    const signal = tokenRGB(el, '--signal');
    const fault = tokenRGB(el, '--fault');
    colors.current = {
      signal,
      hot: dark ? mixRGB(tokenRGB(el, '--wave-hot'), [255, 255, 255], 0.35) : tokenRGB(el, '--wave-hot'),
      warn: tokenRGB(el, '--warn'),
      fault,
      faultHot: dark ? mixRGB(fault, [255, 255, 255], 0.25) : fault,
      even: mixRGB(signal, tokenRGB(el, '--fg-2'), 0.75),
      dark,
    };
  }, [colorV]);

  useEffect(() => {
    const el = ref.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx || !box) return;
    const m = motion.current!;
    const paint = (now: number) => {
      const C = colors.current;
      if (!C) return;
      const dpr = dprNow();
      const W = Math.round((box.w + 2 * M) * dpr);
      const H = Math.round((box.h + 2 * M) * dpr);
      if (el.width !== W || el.height !== H) {
        el.width = W;
        el.height = H;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(dpr, 0, 0, dpr, M * dpr, M * dpr);
      drawRim(ctx, box, m, now, C, reduced);
    };
    if (reduced) {
      paint(performance.now());
      return;
    }
    const first = performance.now();
    m.step(first);
    paint(first);
    if (!onscreen || !visible) return;
    let stop: (() => void) | null = onFrame((now) => {
      const more = m.step(now);
      paint(now);
      if (!more) {
        stop?.();
        stop = null;
      }
    });
    return () => stop?.();
  }, [box, reduced, onscreen, visible, state, colorV]);

  // the canvas sits M px out from the middle of the host's border on every side
  const at = box ? -(M + box.b) : 0;
  return <canvas ref={ref} aria-hidden className={cn('cv-rim', className)} data-state={state} style={box ? { left: at, top: at, width: box.w + 2 * M, height: box.h + 2 * M } : { display: 'none' }} />;
}
