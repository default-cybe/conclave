/**
 * The overlay's placement on this device (docs/design/MEETING-MODE.md 7.8):
 * free, docked to a screen edge, or the Mac notch; auto-hide to a slim tab or
 * pill; moving between displays. The math is place.ts; this keeps the state,
 * listens to the app (meeting://moved, display, peek, hover) and moves the
 * window (meeting_place). Outside the desktop app it does nothing.
 *
 * Showing a hidden overlay grows the window first and then slides or springs
 * the panel in (overlay.css); hiding plays the slide first and shrinks the
 * window after it (MOTION_MS), so nothing jumps. Reduced motion: no wait.
 */
import { useSyncExternalStore } from 'react';
import { desktop, ipc } from './desktop';
import { afterDrag, defaults, nextDisplay, pickDisplay, readSaved, displayAt, target, type Display, type Edge, type Mode, type Placed, type Saved } from './place';

export const KEY = 'conclave.overlay.place';
/** The slide or spring (overlay.css --ov-motion). */
export const MOTION_MS = 320;
/** A drag has settled when no move came for this long: the OS says nothing when a drag ends. */
const SETTLE_MS = 300;
/** After the answer is done, a docked overlay with auto-hide stays out this long. */
export const LINGER_MS = 6000;
/** A move this close to where it was put is the app's own, not a drag. */
const SAME = 3;

export interface DockView {
  /** No desktop (a browser): nothing to place. */
  active: boolean;
  mac: boolean;
  saved: Saved;
  /** The tab on an edge, or the pill at the notch. */
  hidden: boolean;
  /** The edge it is on (edge mode, snapped), for the slide direction and the tab. */
  edge?: Edge;
  mode: Mode;
  displays: number;
  /** Notch mode: the pill's and the notch's size, for the shape. */
  pill?: { w: number; h: number };
  notch?: { w: number; h: number };
}

interface State {
  view: DockView;
  displays: Display[];
  height: number;
  hover: boolean;
  peek: boolean;
  hold: boolean;
  /** The live screen: only it hides (setup, the brief and the end stay out). */
  live: boolean;
  lingerUntil: number;
  last?: Placed;
  lastAt: number;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const read = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

const base: Saved = { mode: 'free', autoHide: true, along: 0.5 };
const s: State = {
  view: { active: false, mac: false, saved: readSaved(read(), base), hidden: false, mode: 'free', displays: 0 },
  displays: [],
  height: 160,
  hover: false,
  peek: false,
  hold: false,
  live: false,
  lingerUntil: 0,
  lastAt: 0,
};
const subs = new Set<() => void>();
let shrink: ReturnType<typeof setTimeout> | undefined;
let linger: ReturnType<typeof setTimeout> | undefined;
let settle: ReturnType<typeof setTimeout> | undefined;

function save(next: Saved) {
  s.view = { ...s.view, saved: next };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* no storage: this window only */
  }
}

/** Docked (an edge it is snapped to, or the notch) with auto-hide, and nothing to show. */
function wantHidden(): boolean {
  const v = s.view.saved;
  const docked = v.mode === 'notch' || (v.mode === 'edge' && !!v.edge);
  return docked && v.autoHide && s.live && !s.hover && !s.peek && !s.hold && Date.now() >= s.lingerUntil;
}

function display(): Display | undefined {
  return pickDisplay(s.displays, s.view.saved.display);
}

/** Recompute the view and move the window: growing at once, shrinking after the motion. */
function apply() {
  const d = display();
  if (!s.view.active || !d) return;
  const v = s.view.saved;
  const hidden = wantHidden();
  const r = target(v, d, s.height, hidden);
  const wasHidden = s.view.hidden;
  s.view = {
    ...s.view,
    hidden,
    mode: v.mode,
    edge: v.mode === 'edge' ? v.edge : undefined,
    displays: s.displays.length,
    pill: 'pill' in r ? (r as { pill: { w: number; h: number } }).pill : undefined,
    notch: 'notch' in r ? (r as { notch?: { w: number; h: number } }).notch : undefined,
  };
  for (const fn of subs) fn();
  if (shrink) clearTimeout(shrink);
  shrink = undefined;
  const go = () => {
    s.last = r;
    s.lastAt = Date.now();
    void ipc.place(r, v.mode === 'notch', v.mode === 'free')?.catch(() => undefined);
  };
  // hiding: the page slides the panel out first, then the window becomes the tab
  if (hidden && !wasHidden && !reduced()) shrink = setTimeout(go, MOTION_MS);
  else go();
}

async function refresh() {
  const r = await ipc.displays()?.catch(() => undefined);
  if (!r?.displays.length) return;
  s.displays = r.displays;
  const first = !read();
  s.view = { ...s.view, active: true, mac: r.mac };
  if (first) save(defaults(r.displays, r.mac));
  // a free overlay the owner never moved stays on the display the app opened it on
  if (!s.view.saved.display && r.window) save({ ...s.view.saved, display: displayAt(r.displays, r.window.x, r.window.y)?.id });
  // the notch is a Mac's
  if (s.view.saved.mode === 'notch' && !r.mac) save({ ...s.view.saved, mode: 'edge' });
}

function moved(p: { x: number; y: number }) {
  const l = s.last;
  // the app's own move (and the OS settling it) is not a drag
  if (l && Math.abs(p.x - l.x) <= SAME && Math.abs(p.y - l.y) <= SAME) return;
  if (settle) clearTimeout(settle);
  settle = setTimeout(async () => {
    settle = undefined;
    await refresh();
    const l = s.last;
    save(afterDrag(s.view.saved, s.displays, p.x, p.y, l?.w ?? 380, l?.h ?? s.height));
    apply();
  }, SETTLE_MS);
}

let started = false;
/** Once per window: read the displays, listen to the app, place the window. */
export function startDock() {
  const d = desktop();
  if (started || !d) return;
  started = true;
  void refresh().then(apply);
  void d.listen<{ x: number; y: number }>('meeting://moved', (e) => moved(e.payload));
  void d.listen<number>('meeting://display', (e) => void moveDisplay(e.payload < 0 ? -1 : 1));
  void d.listen<null>('meeting://peek', () => {
    s.peek = !s.peek;
    apply();
  });
  void d.listen<boolean>('meeting://hover', (e) => setHover(e.payload));
  // Settings > Meetings in the main window writes the same key
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    s.view = { ...s.view, saved: readSaved(e.newValue, s.view.saved) };
    apply();
  });
}

export async function moveDisplay(dir: 1 | -1) {
  await refresh();
  const next = nextDisplay(s.displays, display()?.id, dir);
  if (!next) return;
  save({ ...s.view.saved, display: next.id });
  apply();
}

export function setPlacement(p: Partial<Pick<Saved, 'mode' | 'autoHide'>>) {
  const v = { ...s.view.saved, ...p };
  // docking to an edge from free: the nearest edge, not floating until the next drag
  if (p.mode === 'edge' && !v.edge) v.edge = 'right';
  save(v);
  apply();
}

/** The content's height (fit.ts): the window follows it, anchored to its edge or the notch. */
export function setDockHeight(h: number): boolean {
  if (!s.view.active) return false;
  if (Math.abs(h - s.height) < 1) return true;
  s.height = h;
  if (!s.view.hidden) apply();
  return true;
}

export function setLive(on: boolean) {
  if (s.live === on) return;
  s.live = on;
  apply();
}

export function setHover(on: boolean) {
  if (s.hover === on) return;
  s.hover = on;
  apply();
}

/**
 * An answer streams (on) or is done (off): a docked overlay slides out for it and,
 * with auto-hide, back in LINGER_MS after it is done unless the cursor is on it.
 */
export function holdOpen(on: boolean) {
  if (s.hold === on) return;
  s.hold = on;
  s.peek = false;
  if (linger) clearTimeout(linger);
  if (!on) {
    s.lingerUntil = Date.now() + LINGER_MS;
    linger = setTimeout(apply, LINGER_MS);
  }
  apply();
}

const getView = () => s.view;
export function useDock(): DockView {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    getView,
    getView,
  );
}

/** Settings > Meetings: the saved placement and a setter, for the main window (no app there to move). */
export function readPlacement(): Saved {
  return readSaved(read(), base);
}

export function writePlacement(p: Partial<Saved>) {
  const v = { ...readPlacement(), ...p };
  if (p.mode === 'edge' && !v.edge) v.edge = 'right';
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* no storage */
  }
}
