/**
 * Easing for motion drawn from time (canvas, rAF): the same curves as the
 * CSS tokens in styles/motion.css, as functions of 0..1. Pure, no DOM.
 */

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of progress 0..1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let u = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(u);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
}

/** The motion curves. Names match the CSS tokens (--ease, --ease-in, ...). */
export const EASE = {
  /** --ease: entrances and settles */
  out: cubicBezier(0.2, 0.7, 0.2, 1),
  /** --ease-in: exits */
  in: cubicBezier(0.4, 0, 1, 1),
  /** --ease-sine: loops */
  sine: cubicBezier(0.37, 0, 0.63, 1),
  /** --ease-morph: a firm in-out for the Knot's light writing and letting go */
  morph: cubicBezier(0.6, 0, 0.4, 1),
  /** --ease-emph: a container that grows (card to panel) */
  emph: cubicBezier(0.2, 0, 0, 1),
  /** --ease-std: a container that shrinks back, a fold that reopens */
  std: cubicBezier(0.4, 0, 0.2, 1),
} as const;

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Progress of t through [a, b], clamped to 0..1. */
export const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const mod = (x: number, m: number) => ((x % m) + m) % m;
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Step response of a damped spring, 0 to 1. `response` is the period in ms
 * (as in SwiftUI), `z` the damping ratio. z = 1 never overshoots.
 */
export function spring(t: number, response = 420, z = 1): number {
  if (t <= 0) return 0;
  const w = (2 * Math.PI) / response;
  if (z >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

/** How long the spring takes to come within 0.1% of rest, in ms (rounded up to 10ms). */
export function springSettle(response = 420, z = 1): number {
  let t = 0;
  for (; t < 5000; t += 10) if (Math.abs(1 - spring(t, response, z)) < 0.001 && Math.abs(1 - spring(t + 40, response, z)) < 0.001) break;
  return t;
}

/** The spring as a CSS linear() easing over springSettle(response, z) ms. */
export function springCss(response = 420, z = 1, points = 24): string {
  const d = springSettle(response, z);
  const out: string[] = [];
  for (let i = 0; i <= points; i++) {
    const v = i === points ? 1 : spring((i / points) * d, response, z);
    out.push(String(Math.round(v * 1000) / 1000));
  }
  return `linear(${out.join(', ')})`;
}
