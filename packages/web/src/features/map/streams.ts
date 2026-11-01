/**
 * Streams of light on the Map's links (docs/DESIGN.md 29). Particles leave
 * a working agent at a rate that follows its tokens per second, flow along
 * the curved link to its project, then on to the hub, and fade into it. A
 * tool call sends one brighter pulse the same way. Full, Quiet (about a
 * third) and Lines (none). Particle state lives in typed arrays; the draw
 * adapts to frame time by lowering how many there may be.
 */
import type { LLink } from './layout';
import { cubicAt } from './layout';
import type { View } from './view';

export type StreamMode = 'full' | 'quiet' | 'lines';
export const STREAM_MODES: StreamMode[] = ['full', 'quiet', 'lines'];

/** Particles a second for a source of `rate` tokens a second. A tool running or a request in flight still trickles. */
export function emitRate(rate: number, mode: StreamMode, working: 'tokens' | 'tool' | 'waiting' = 'tokens'): number {
  if (mode === 'lines') return 0;
  const base = rate > 0 ? Math.min(72, 2 + rate * 1.3) : working === 'tool' ? 2 : working === 'waiting' ? 0.8 : 0;
  return mode === 'quiet' ? base * 0.3 : base;
}

/** How many particles may live at once, by mode. */
export const CAP: Record<StreamMode, number> = { full: 5000, quiet: 1500, lines: 0 };

/**
 * Frame cost and frame interval, smoothed. Over budget, the share of
 * particles drops by a tenth each frame; well under, it climbs back slowly.
 */
export class Quality {
  q = 1;
  cost = 0;
  interval = 16.7;
  update(costMs: number, intervalMs: number): number {
    this.cost += (costMs - this.cost) * 0.1;
    this.interval += (Math.min(100, intervalMs) - this.interval) * 0.1;
    if (this.cost > 6 || this.interval > 26) this.q = Math.max(0.15, this.q * 0.9);
    else if (this.cost < 3 && this.interval < 19) this.q = Math.min(1, this.q + 0.01);
    return this.q;
  }
}

const SEGS = 22;

interface Path {
  id: string;
  /** Index of the path the particles go on to, or -1 at the hub. */
  next: number;
  /** Points along the curve, child to parent. */
  pts: Float32Array;
  /** Normals at those points. */
  nrm: Float32Array;
  len: number;
  /** Half the lane width, by the flow it carries. */
  half: number;
  flow: number;
}

export interface StreamSource {
  /** The node's id (its link has the same id). */
  id: string;
  rate: number;
  working: 'tokens' | 'tool' | 'waiting';
}

export interface StreamColors {
  /** The particle color (signal, lighter in the dark theme) and the pulse color. */
  dot: [number, number, number];
  pulse: [number, number, number];
}

export class Streams {
  mode: StreamMode = 'full';
  readonly quality = new Quality();
  private paths: Path[] = [];
  private index = new Map<string, number>();
  private sources: StreamSource[] = [];
  private acc = new Map<string, number>();
  private time = 0;

  // particles: path, position 0..1, speed px/s, lane -1..1, alpha, kind (0 dot, 1 pulse), screen x and y
  private max = CAP.full;
  private n = 0;
  private P = new Int32Array(this.max);
  private S = new Float32Array(this.max);
  private V = new Float32Array(this.max);
  private L = new Float32Array(this.max);
  private A = new Float32Array(this.max);
  private K = new Uint8Array(this.max);
  private X = new Float32Array(this.max);
  private Y = new Float32Array(this.max);

  private sprites: { key: string; list: Array<{ c: HTMLCanvasElement; o: number }> } | null = null;

  /** Four dots, one per level of light, made once per color and pixel ratio. */
  private spritesFor(rgb: [number, number, number], dpr: number) {
    const key = `${rgb.join(',')}@${dpr}`;
    if (this.sprites?.key === key) return this.sprites.list;
    const d = 1.75 * dpr;
    const size = Math.ceil(d) + 2;
    const list = [0, 1, 2, 3].map((level) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d')!;
      g.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(level + 0.5) / 4})`;
      g.beginPath();
      g.arc(size / 2, size / 2, d / 2, 0, Math.PI * 2);
      g.fill();
      return { c, o: Math.round(size / 2) };
    });
    this.sprites = { key, list };
    return list;
  }

  get count(): number {
    return this.n;
  }

  /** True while something moves or will: particles alive, or a source that emits. */
  get active(): boolean {
    return this.n > 0 || (this.mode !== 'lines' && this.sources.some((s) => emitRate(s.rate, this.mode, s.working) > 0));
  }

  /** The links as they are drawn now (they move while the layout settles). Particles keep their place along each link. */
  setLinks(links: LLink[]): void {
    const old = this.index;
    const paths: Path[] = [];
    const index = new Map<string, number>();
    const pt: [number, number] = [0, 0];
    for (const k of links) {
      const pts = new Float32Array((SEGS + 1) * 2);
      let len = 0;
      for (let i = 0; i <= SEGS; i++) {
        cubicAt(k.p, i / SEGS, pt);
        pts[i * 2] = pt[0];
        pts[i * 2 + 1] = pt[1];
        if (i) len += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
      }
      const nrm = new Float32Array((SEGS + 1) * 2);
      for (let i = 0; i <= SEGS; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(SEGS, i + 1);
        const tx = pts[b * 2] - pts[a * 2];
        const ty = pts[b * 2 + 1] - pts[a * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1;
        nrm[i * 2] = -ty / tl;
        nrm[i * 2 + 1] = tx / tl;
      }
      index.set(k.id, paths.length);
      paths.push({ id: k.id, next: -1, pts, nrm, len: Math.max(1, len), half: 2, flow: 0 });
    }
    for (let i = 0; i < links.length; i++) paths[i].next = index.get(links[i].to) ?? -1;
    // particles move to the same link in the new table, or go
    if (this.n) {
      const remap = new Int32Array(this.paths.length).fill(-1);
      for (const [id, i] of old) remap[i] = index.get(id) ?? -1;
      let w = 0;
      for (let i = 0; i < this.n; i++) {
        const p = remap[this.P[i]] ?? -1;
        if (p < 0) continue;
        this.copy(i, w);
        this.P[w] = p;
        w++;
      }
      this.n = w;
    }
    this.paths = paths;
    this.index = index;
    this.flows();
  }

  /** The working nodes and their token rates. */
  setSources(sources: StreamSource[]): void {
    this.sources = sources;
    this.flows();
  }

  /** A tool call: one bright pulse from the node to the hub. */
  pulse(id: string): void {
    if (this.mode === 'lines') return;
    const p = this.index.get(id);
    if (p === undefined || this.n >= this.max) return;
    this.spawn(p, 1);
  }

  private flows(): void {
    for (const p of this.paths) p.flow = 0;
    for (const s of this.sources) {
      const r = Math.max(s.rate, s.working === 'tool' ? 2 : 0);
      for (let i = this.index.get(s.id) ?? -1, hops = 0; i >= 0 && hops < 16; i = this.paths[i].next, hops++) this.paths[i].flow += r;
    }
    for (const p of this.paths) p.half = 1.6 + Math.min(7, Math.sqrt(p.flow) * 0.75);
  }

  private copy(from: number, to: number): void {
    if (from === to) return;
    this.P[to] = this.P[from];
    this.S[to] = this.S[from];
    this.V[to] = this.V[from];
    this.L[to] = this.L[from];
    this.A[to] = this.A[from];
    this.K[to] = this.K[from];
    this.X[to] = this.X[from];
    this.Y[to] = this.Y[from];
  }

  private spawn(path: number, kind: 0 | 1): void {
    const i = this.n++;
    this.P[i] = path;
    this.S[i] = kind ? 0 : Math.random() * 0.04;
    this.V[i] = kind ? 230 : 62 + Math.random() * 40;
    this.L[i] = kind ? 0 : (Math.random() * 2 - 1) * (0.35 + 0.65 * Math.random());
    this.A[i] = kind ? 1 : 0.3 + Math.random() * 0.65;
    this.K[i] = kind;
  }

  /** Advance by dt seconds: emit, move, hand over at each node, fade into the hub. */
  step(dt: number): void {
    dt = Math.min(0.05, Math.max(0, dt));
    this.time += dt;
    const cap = Math.floor(CAP[this.mode] * this.quality.q);
    if (this.mode !== 'lines') {
      for (const s of this.sources) {
        const p = this.index.get(s.id);
        if (p === undefined) continue;
        const want = emitRate(s.rate, this.mode, s.working) * this.quality.q * dt + (this.acc.get(s.id) ?? 0);
        let k = Math.floor(want);
        this.acc.set(s.id, want - k);
        while (k-- > 0 && this.n < Math.min(cap, this.max)) this.spawn(p, 0);
      }
    }
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      let p = this.P[i];
      let path = this.paths[p];
      if (!path) continue;
      let s = this.S[i] + (this.V[i] * dt) / path.len;
      while (s >= 1) {
        const next = path.next;
        if (next < 0) break;
        s = ((s - 1) * path.len) / this.paths[next].len;
        p = next;
        path = this.paths[p];
      }
      if (s >= 1) continue;
      this.copy(i, w);
      this.P[w] = p;
      this.S[w] = s;
      w++;
    }
    this.n = w;
    // over the cap after a mode change or a quality drop: the oldest go first
    if (this.n > cap) {
      const drop = this.n - cap;
      for (let i = 0; i < cap; i++) this.copy(i + drop, i);
      this.n = cap;
    }
    if (this.mode === 'lines') this.n = 0;
  }

  /** Draw the particles in screen space: 1.7 px dots, with a short trail behind each pulse. */
  draw(ctx: CanvasRenderingContext2D, v: View, dpr: number, c: StreamColors): void {
    if (!this.n) return;
    const pos = (path: Path, s: number, lane: number, out: [number, number]) => {
      const f = s * SEGS;
      const j = Math.min(SEGS - 1, Math.floor(f));
      const u = f - j;
      const P = path.pts;
      const N = path.nrm;
      const x = P[j * 2] + (P[j * 2 + 2] - P[j * 2]) * u;
      const y = P[j * 2 + 1] + (P[j * 2 + 3] - P[j * 2 + 1]) * u;
      // the lane narrows at both ends, so streams gather at every node
      const off = lane * path.half * (0.22 + 0.78 * Math.pow(Math.sin(Math.PI * s), 0.8));
      out[0] = ((x + N[j * 2] * off) * v.k + v.x) * dpr;
      out[1] = ((y + N[j * 2 + 1] * off) * v.k + v.y) * dpr;
      return out;
    };
    const pt: [number, number] = [0, 0];
    const fade = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const path = this.paths[this.P[i]];
      pos(path, this.S[i], this.L[i], pt);
      this.X[i] = pt[0];
      this.Y[i] = pt[1];
      // fade in as they leave, fade out into the hub
      const s = this.S[i];
      const out = path.next < 0 ? Math.min(1, (1 - s) / 0.22) : 1;
      fade[i] = this.A[i] * out * Math.min(1, s / 0.02 + (this.K[i] ? 1 : 0.35));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // four levels of light, each a small round sprite drawn at whole device pixels
    const sprites = this.spritesFor(c.dot, dpr);
    for (let i = 0; i < this.n; i++) {
      if (this.K[i]) continue;
      const a = fade[i];
      if (a <= 0.02) continue;
      const sp = sprites[Math.min(3, Math.floor(a * 4))];
      ctx.drawImage(sp.c, Math.round(this.X[i]) - sp.o, Math.round(this.Y[i]) - sp.o);
    }
    // pulses: a bright head and a trail
    const [pr, pg, pb] = c.pulse;
    for (let i = 0; i < this.n; i++) {
      if (!this.K[i]) continue;
      const path = this.paths[this.P[i]];
      for (let t = 5; t >= 0; t--) {
        const s = this.S[i] - t * (9 / path.len);
        if (s < 0) continue;
        pos(path, s, 0, pt);
        const a = fade[i] * (1 - t / 6) * (t ? 0.55 : 1);
        ctx.fillStyle = `rgba(${pr},${pg},${pb},${a})`;
        const d = (t ? 1.8 : 2.8) * dpr;
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], d / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
