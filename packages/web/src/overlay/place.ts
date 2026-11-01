/**
 * Where the overlay window sits (docs/design/MEETING-MODE.md 7.8): free, docked
 * to a screen edge (a slim tab when hidden), or the Mac notch. Pure geometry,
 * unit-tested (test/overlay-place.test.ts); dock.ts applies it.
 *
 * Units: a display's frame and work area are in "desktop units", the units the
 * window is moved in: points on macOS, physical pixels on Windows and Linux
 * (meeting/place.rs). `unit` is desktop units per CSS px on that display (1 on
 * macOS, the scale factor elsewhere), so window sizes, which are CSS px, become
 * desktop units with `* unit`. Coordinates may be negative: a display left of
 * or above the primary one.
 */
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type Mode = 'free' | 'edge' | 'notch';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** macOS only: NSScreen.safeAreaInsets.top and the widths of auxiliaryTopLeftArea and auxiliaryTopRightArea, in points. */
export interface NotchInsets {
  top: number;
  left: number;
  right: number;
}

export interface Display {
  id: string;
  frame: Rect;
  /** The frame less the menu bar and Dock (macOS visibleFrame) or the taskbar (Windows rcWork). */
  work: Rect;
  unit: number;
  scale: number;
  primary: boolean;
  notch?: NotchInsets;
}

/** What is kept on this device (localStorage, dock.ts). */
export interface Saved {
  mode: Mode;
  autoHide: boolean;
  display?: string;
  /** Edge mode: the edge it is snapped to; none while it floats. */
  edge?: Edge;
  /** Where along the edge its centre sits, 0 to 1. */
  along: number;
  /** Not snapped: the top left as a share (0 to 1) of the room it can move in on the work area. */
  fx?: number;
  fy?: number;
}

/** A window to place: its top left in desktop units, its size in CSS px (meeting_place). */
export interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Drag within this many CSS px of a work-area edge and it snaps there. */
export const SNAP_PX = 24;
/** The overlay's width, and the shortest it gets (meeting/mod.rs MIN_HEIGHT). */
export const WIDTH = 380;
export const MIN_HEIGHT = 96;
/** The hidden overlay's tab on an edge: TAB thick, TAB_LEN long (CSS px). */
export const TAB = 10;
export const TAB_LEN = 64;
/** The notch pill: room for the dot and the level on each side of the notch; the pill on a screen without one. */
export const EAR = 44;
export const PILL_W = 200;
export const PILL_H = 32;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const share = (v: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0.5);

/**
 * The notch from the screen's insets, as DynamicNotchKit computes it
 * (MrKai77/DynamicNotchKit@cd0b3e5 Utility/NSScreen+Extensions.swift 55-97, MIT):
 * the frame's width less both auxiliary top areas, and the top safe-area inset
 * tall. Undefined on a screen without one (both areas are empty there).
 */
export function notchSize(d: Display): { w: number; h: number } | undefined {
  const n = d.notch;
  if (!n || n.top <= 0 || n.left <= 0 || n.right <= 0) return undefined;
  const w = d.frame.w - n.left - n.right;
  return w > 0 ? { w, h: n.top } : undefined;
}

/** The display holding the point, else the nearest one. */
export function displayAt(displays: Display[], x: number, y: number): Display | undefined {
  let best: Display | undefined;
  let dist = Infinity;
  for (const d of displays) {
    const f = d.frame;
    const dx = Math.max(f.x - x, 0, x - (f.x + f.w));
    const dy = Math.max(f.y - y, 0, y - (f.y + f.h));
    const n = dx * dx + dy * dy;
    if (n < dist) [best, dist] = [d, n];
  }
  return best;
}

/** The saved display, else (it is gone) the primary one, else the first. */
export function pickDisplay(displays: Display[], id?: string): Display | undefined {
  return displays.find((d) => d.id === id) ?? displays.find((d) => d.primary) ?? displays[0];
}

/** The next display left to right (then top to bottom), wrapping around. */
export function nextDisplay(displays: Display[], id: string | undefined, dir: 1 | -1): Display | undefined {
  const list = [...displays].sort((a, b) => a.frame.x - b.frame.x || a.frame.y - b.frame.y);
  if (!list.length) return undefined;
  const i = list.findIndex((d) => d.id === id);
  return list[(((i < 0 ? 0 : i + dir) % list.length) + list.length) % list.length];
}

/** The edge the window is dragged to: the closest work-area edge within SNAP_PX (past it counts too), else none. */
export function snapEdge(win: Rect, work: Rect, unit: number): Edge | undefined {
  const gaps: [Edge, number][] = [
    ['left', win.x - work.x],
    ['right', work.x + work.w - (win.x + win.w)],
    ['top', win.y - work.y],
    ['bottom', work.y + work.h - (win.y + win.h)],
  ];
  let best: [Edge, number] | undefined;
  for (const g of gaps) if (g[1] <= SNAP_PX * unit && (!best || g[1] < best[1])) best = g;
  return best?.[0];
}

/** Where the window's centre is along an edge, 0 to 1. */
export function alongOf(win: Rect, work: Rect, edge: Edge): number {
  return edge === 'left' || edge === 'right' ? share((win.y + win.h / 2 - work.y) / work.h) : share((win.x + win.w / 2 - work.x) / work.w);
}

/** The top left as a share of the room the window has on the work area. */
export function freeShares(win: Rect, work: Rect): { fx: number; fy: number } {
  const rx = work.w - win.w;
  const ry = work.h - win.h;
  return { fx: rx > 0 ? share((win.x - work.x) / rx) : 0, fy: ry > 0 ? share((win.y - work.y) / ry) : 0 };
}

/** The tallest the overlay gets: three quarters of the work area (meeting/mod.rs clamp_height). */
export function clampHeight(h: number, d: Display): number {
  const max = Math.max(MIN_HEIGHT, ((d.work.h / d.unit) * 3) / 4);
  return Number.isFinite(h) ? clamp(h, MIN_HEIGHT, max) : max;
}

/** Docked to an edge: open (WIDTH by h) or hidden (the tab), kept inside the work area. */
export function edgeRect(d: Display, edge: Edge, along: number, h: number, hidden: boolean): Placed {
  const side = edge === 'left' || edge === 'right';
  const w = hidden ? (side ? TAB : TAB_LEN) : WIDTH;
  const hh = hidden ? (side ? TAB_LEN : TAB) : clampHeight(h, d);
  const [pw, ph] = [w * d.unit, hh * d.unit];
  const k = d.work;
  const a = share(along);
  if (side) return { x: edge === 'left' ? k.x : k.x + k.w - pw, y: clamp(k.y + a * k.h - ph / 2, k.y, k.y + k.h - ph), w, h: hh };
  return { x: clamp(k.x + a * k.w - pw / 2, k.x, k.x + k.w - pw), y: edge === 'top' ? k.y : k.y + k.h - ph, w, h: hh };
}

/** Free: at its saved shares of the work area (centred the first time). */
export function freeRect(d: Display, fx: number | undefined, fy: number | undefined, h: number): Placed {
  const hh = clampHeight(h, d);
  const k = d.work;
  return { x: k.x + share(fx ?? 0.5) * Math.max(0, k.w - WIDTH * d.unit), y: k.y + share(fy ?? 0.2) * Math.max(0, k.h - hh * d.unit), w: WIDTH, h: hh };
}

/**
 * The notch: the pill around it (hidden) or the panel that grows down from it
 * (open), centred on the screen's top edge, over the menu bar. A screen with no
 * notch gets a PILL_W pill as tall as its menu bar. `pill` is the hidden size,
 * for the shape the page animates from.
 */
export function notchRect(d: Display, open: boolean, h: number): Placed & { pill: { w: number; h: number }; notch?: { w: number; h: number } } {
  const notch = notchSize(d);
  const bar = (d.work.y - d.frame.y) / d.unit;
  const pill = notch ? { w: notch.w + 2 * EAR, h: notch.h } : { w: PILL_W, h: bar >= 20 && bar <= 60 ? bar : PILL_H };
  const w = open ? Math.max(WIDTH, pill.w) : pill.w;
  const hh = open ? Math.max(pill.h, clampHeight(h, d)) : pill.h;
  return { x: d.frame.x + d.frame.w / 2 - (w * d.unit) / 2, y: d.frame.y, w, h: hh, pill, notch };
}

/** The window's rect in desktop units from where it is and its CSS size on that display. */
export function windowRect(x: number, y: number, w: number, h: number, unit: number): Rect {
  return { x, y, w: w * unit, h: h * unit };
}

/**
 * After a drag ends: what to save. Edge mode snaps to the edge it is near and lets go
 * when dragged away (then it floats where it was dropped); free mode keeps where it was
 * dropped; the notch keeps its place (a drag there is put back).
 */
export function afterDrag(saved: Saved, displays: Display[], x: number, y: number, w: number, h: number): Saved {
  const guess = displayAt(displays, x, y);
  if (!guess) return saved;
  const win = windowRect(x, y, w, h, guess.unit);
  const d = displayAt(displays, win.x + win.w / 2, win.y + win.h / 2) ?? guess;
  if (saved.mode === 'notch') return saved;
  const free = { ...freeShares(win, d.work), display: d.id };
  if (saved.mode === 'free') return { ...saved, ...free, edge: undefined };
  const edge = snapEdge(win, d.work, d.unit);
  return edge ? { ...saved, display: d.id, edge, along: alongOf(win, d.work, edge) } : { ...saved, ...free, edge: undefined };
}

/** Where the window goes for the saved placement on display `d`. */
export function target(saved: Saved, d: Display, h: number, hidden: boolean): Placed {
  if (saved.mode === 'notch') return notchRect(d, !hidden, h);
  if (saved.mode === 'edge' && saved.edge) return edgeRect(d, saved.edge, saved.along, h, hidden);
  return freeRect(d, saved.fx, saved.fy, h);
}

/** A first visit: the notch on a Mac whose screen has one, else docking to edges; auto-hide on. */
export function defaults(displays: Display[], mac: boolean): Saved {
  const withNotch = displays.find((d) => notchSize(d));
  return mac && withNotch ? { mode: 'notch', autoHide: true, display: withNotch.id, along: 0.5 } : { mode: 'edge', autoHide: true, along: 0.5 };
}

/** A stored value read back: anything malformed falls back to `base`. */
export function readSaved(raw: string | null | undefined, base: Saved): Saved {
  try {
    const v = JSON.parse(raw ?? '') as Partial<Saved>;
    if (!v || typeof v !== 'object') return base;
    const mode: Mode = v.mode === 'free' || v.mode === 'edge' || v.mode === 'notch' ? v.mode : base.mode;
    const edge = v.edge === 'left' || v.edge === 'right' || v.edge === 'top' || v.edge === 'bottom' ? v.edge : undefined;
    const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? share(n) : undefined);
    return { mode, autoHide: typeof v.autoHide === 'boolean' ? v.autoHide : base.autoHide, display: typeof v.display === 'string' ? v.display : undefined, edge, along: num(v.along) ?? 0.5, fx: num(v.fx), fy: num(v.fy) };
  } catch {
    return base;
  }
}
