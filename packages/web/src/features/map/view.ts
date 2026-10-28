/**
 * Pan and zoom on the Map: a world point (x, y) shows at (x·k + vx, y·k + vy)
 * on screen. Pure, so test/map-view.test.ts checks the math.
 */
import type { LBox } from './layout';

export interface View {
  x: number;
  y: number;
  k: number;
}

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 3;

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// `min`: Memory > Map's expand all goes further out than the Map, to frame ~3,000 labels
const clampK = (k: number, min = ZOOM_MIN) => Math.min(ZOOM_MAX, Math.max(min, k));

/** The view that shows all of `b` inside a w by h screen, less the insets, at most at zoom `max`. */
export function fitView(b: LBox, w: number, h: number, inset: Insets = { top: 0, right: 0, bottom: 0, left: 0 }, max = 1.25, min = ZOOM_MIN): View {
  const aw = Math.max(40, w - inset.left - inset.right);
  const ah = Math.max(40, h - inset.top - inset.bottom);
  const k = clampK(Math.min(max, aw / Math.max(1, b.w), ah / Math.max(1, b.h)), min);
  return {
    k,
    x: inset.left + (aw - b.w * k) / 2 - b.x * k,
    y: inset.top + (ah - b.h * k) / 2 - b.y * k,
  };
}

/** The smallest text in a label on a phone: the state and the short id, 12px (titles are 13px, names 14px; map.css). */
export const LABEL_SMALLEST = 12;
/** The zoom a phone opens at: every label's text at 12px or more on screen. */
export const READ_K = 12 / LABEL_SMALLEST;

/**
 * A phone's first view. A small map fits whole, as on a desktop. A larger
 * one opens at zoom `k`, where its labels read, with `focus` (the hub and
 * its busiest project) in the middle of the room the overlays leave. A
 * focus wider than the room keeps its left side, where a phone has the
 * hub. The view moves only so no empty room shows past the map's edges.
 * Fit shows the whole map.
 */
export function startView(b: LBox, focus: LBox, w: number, h: number, inset: Insets, k = READ_K): View {
  const whole = fitView(b, w, h, inset, k);
  if (whole.k >= k) return whole;
  k = clampK(k);
  const aw = Math.max(40, w - inset.left - inset.right);
  const ah = Math.max(40, h - inset.top - inset.bottom);
  const axis = (lo: number, room: number, at: number, size: number, f0: number, fs: number, keepStart: boolean) => {
    if (size * k <= room) return lo + (room - size * k) / 2 - at * k;
    const v = fs * k > room && keepStart ? lo - f0 * k : lo + room / 2 - (f0 + fs / 2) * k;
    // where the map is wider (taller) than the room, its edges stay at the room's
    return Math.min(lo - at * k, Math.max(lo + room - (at + size) * k, v));
  };
  return { k, x: axis(inset.left, aw, b.x, b.w, focus.x, focus.w, true), y: axis(inset.top, ah, b.y, b.h, focus.y, focus.h, false) };
}

/** Zoom by `factor` keeping the world point under the screen point (sx, sy) in place. */
export function zoomAt(v: View, sx: number, sy: number, factor: number, min = ZOOM_MIN): View {
  const k = clampK(v.k * factor, min);
  const f = k / v.k;
  return { k, x: sx - (sx - v.x) * f, y: sy - (sy - v.y) * f };
}

export const toWorld = (v: View, sx: number, sy: number): [number, number] => [(sx - v.x) / v.k, (sy - v.y) / v.k];
export const toScreen = (v: View, wx: number, wy: number): [number, number] => [wx * v.k + v.x, wy * v.k + v.y];

/**
 * Two fingers moved from (a0, b0) to (a1, b1), in screen points: the world
 * point under their middle stays under it, and the zoom follows their
 * distance.
 */
export function pinch(v: View, a0: [number, number], b0: [number, number], a1: [number, number], b1: [number, number], min = ZOOM_MIN): View {
  const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]);
  const d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]);
  const m0: [number, number] = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2];
  const m1: [number, number] = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
  const k = clampK(v.k * (d0 > 4 ? d1 / d0 : 1), min);
  const [wx, wy] = toWorld(v, m0[0], m0[1]);
  return { k, x: m1[0] - wx * k, y: m1[1] - wy * k };
}

/** A wheel event's zoom factor: a mouse notch is about 12%, a trackpad pinch follows its delta. */
export function wheelFactor(deltaY: number, deltaMode: number, pinching: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const rate = pinching ? 0.01 : 0.0022;
  return Math.exp(-Math.max(-60, Math.min(60, px)) * rate);
}

/** Keep part of the map on screen: at least `keep` px of the content box stays inside. */
export function clampView(v: View, b: LBox, w: number, h: number, keep = 80): View {
  const x0 = b.x * v.k + v.x;
  const x1 = (b.x + b.w) * v.k + v.x;
  const y0 = b.y * v.k + v.y;
  const y1 = (b.y + b.h) * v.k + v.y;
  let x = v.x;
  let y = v.y;
  if (x1 < keep) x += keep - x1;
  if (x0 > w - keep) x -= x0 - (w - keep);
  if (y1 < keep) y += keep - y1;
  if (y0 > h - keep) y -= y0 - (h - keep);
  return { k: v.k, x, y };
}
