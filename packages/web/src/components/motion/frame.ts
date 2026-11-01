/**
 * One requestAnimationFrame loop for every canvas primitive (Knot, Rim, the
 * send button), and the CSS colors they need as RGB. rAF stops by itself in
 * a background tab; each primitive also leaves the loop offscreen and when
 * it has nothing left to move.
 */
import { useSyncExternalStore } from 'react';

type FrameFn = (now: number) => void;
const subs = new Set<FrameFn>();
let raf = 0;

function loop(now: number) {
  raf = 0;
  for (const fn of [...subs]) fn(now);
  if (subs.size) raf = requestAnimationFrame(loop);
}

/** Call fn on every frame until the returned function is called. */
export function onFrame(fn: FrameFn): () => void {
  subs.add(fn);
  if (!raf && typeof requestAnimationFrame !== 'undefined') raf = requestAnimationFrame(loop);
  return () => {
    subs.delete(fn);
  };
}

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

let probe: CanvasRenderingContext2D | null = null;
const colorCache = new Map<string, RGBA>();

/** Any CSS color (oklch included) as sRGB bytes and alpha 0..1. */
export function rgbaOf(color: string): RGBA {
  const hit = colorCache.get(color);
  if (hit) return hit;
  if (!probe) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    probe = c.getContext('2d', { willReadFrequently: true });
  }
  let out: RGBA = [0, 0, 0, 0];
  if (probe) {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    const a = d[3] / 255;
    out = a > 0 ? [d[0], d[1], d[2], a] : [0, 0, 0, 0];
  }
  if (colorCache.size > 200) colorCache.clear();
  colorCache.set(color, out);
  return out;
}

export function rgbOf(color: string): RGB {
  const [r, g, b] = rgbaOf(color);
  return [r, g, b];
}

/** A custom property (like --signal) as RGB, read on el so a scoped theme applies. */
export function tokenRGB(el: Element, name: string, fallback = '#888'): RGB {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return rgbOf(v || fallback);
}

/** The color painted behind el: its ancestors' backgrounds, composited down to the first opaque one. */
export function surfaceOf(el: Element | null): RGB {
  const layers: RGBA[] = [];
  let base: RGB | null = null;
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = rgbaOf(getComputedStyle(n).backgroundColor || 'transparent');
    if (c[3] >= 0.99) {
      base = [c[0], c[1], c[2]];
      break;
    }
    if (c[3] > 0) layers.push(c);
  }
  let out: RGB = base ?? rgbOf(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#111');
  // inner layers last: each translucent background lies over the ones outside it
  for (let i = layers.length - 1; i >= 0; i--) {
    const [r, g, b, a] = layers[i];
    out = [out[0] + (r - out[0]) * a, out[1] + (g - out[1]) * a, out[2] + (b - out[2]) * a];
  }
  return out;
}

/** True when the page is in the dark theme. */
export function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t) return t !== 'light';
  return !window.matchMedia('(prefers-color-scheme: light)').matches;
}

// Bumps when the theme, contrast or color scheme changes, so canvas pieces re-read their colors.
let version = 0;
const listeners = new Set<() => void>();
let watching = false;
function watch() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  const bump = () => {
    version++;
    colorCache.clear();
    for (const l of listeners) l();
  };
  new MutationObserver(bump).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', bump);
  window.matchMedia('(prefers-contrast: more)').addEventListener('change', bump);
}

/** A number that changes whenever colors may have changed. */
export function useColorVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      watch();
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
    () => 0,
  );
}

/** Device pixels per CSS pixel, at least 1, at most 3. */
export const dprNow = () => Math.min(3, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
