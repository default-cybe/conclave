/**
 * Overlay placement math (src/overlay/place.ts): snapping to the work area,
 * scale factors, displays at negative coordinates, the display fallback, and
 * the notch from safe-area insets.
 *   cd packages/web && bun test test/overlay-place.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { afterDrag, defaults, displayAt, edgeRect, nextDisplay, notchRect, notchSize, pickDisplay, readSaved, sizeOn, snapEdge, target, DEFAULT_H, DEFAULT_W, MIN_H, MIN_W, TAB, TAB_LEN, type Display, type Saved } from '../src/overlay/place';

const SIZE = { w: DEFAULT_W, h: DEFAULT_H };
const WIDTH = DEFAULT_W;

// a MacBook (points): 1512x982, menu bar 38 with the notch, Dock 70 at the bottom
const mac: Display = { id: 'Built-in', frame: { x: 0, y: 0, w: 1512, h: 982 }, work: { x: 0, y: 38, w: 1512, h: 874 }, unit: 1, scale: 2, primary: true, notch: { top: 38, left: 662, right: 662 } };
// Windows (physical px): a 150 % laptop as primary and a 100 % monitor to its left, taskbar 48 px at the bottom
const laptop: Display = { id: 'Laptop', frame: { x: 0, y: 0, w: 2880, h: 1800 }, work: { x: 0, y: 0, w: 2880, h: 1728 }, unit: 1.5, scale: 1.5, primary: true };
const left: Display = { id: 'DELL', frame: { x: -1920, y: -200, w: 1920, h: 1080 }, work: { x: -1920, y: -200, w: 1920, h: 1032 }, unit: 1, scale: 1, primary: false };
const edge = (s: Partial<Saved> = {}): Saved => ({ mode: 'edge', autoHide: true, along: 0.5, ...s });

describe('notch', () => {
  test('size from the insets, as DynamicNotchKit: frame width less both top areas, top inset tall', () => {
    expect(notchSize(mac)).toEqual({ w: 188, h: 38 });
    expect(notchSize({ ...mac, notch: { top: 0, left: 0, right: 0 } })).toBeUndefined();
    expect(notchSize(laptop)).toBeUndefined();
  });

  test('the pill wraps the notch at the top centre over the menu bar, and opens down', () => {
    const shut = notchRect(mac, false, SIZE);
    expect(shut.pill).toEqual({ w: 188 + 88, h: 38 });
    expect(shut).toMatchObject({ x: 756 - 138, y: 0, w: 276, h: 38 });
    // open: the same size as a free overlay, under the pill
    const open = notchRect(mac, true, SIZE);
    expect(open).toMatchObject({ x: 756 - WIDTH / 2, y: 0, w: WIDTH, h: DEFAULT_H + 38 });
  });

  test('no notch: a pill as tall as the menu bar at the top centre', () => {
    const ext: Display = { ...mac, id: 'LG', notch: undefined, frame: { x: 1512, y: -300, w: 2560, h: 1440 }, work: { x: 1512, y: -275, w: 2560, h: 1415 } };
    expect(notchRect(ext, false, SIZE)).toMatchObject({ x: 1512 + 1280 - 100, y: -300, w: 200, h: 25 });
  });
});

describe('snapping', () => {
  test('within 24 px of the work area, scaled; the Dock and taskbar are outside it', () => {
    expect(snapEdge({ x: 10, y: 300, w: 380, h: 200 }, mac.work, 1)).toBe('left');
    expect(snapEdge({ x: 100, y: 300, w: 380, h: 200 }, mac.work, 1)).toBeUndefined();
    // 30 physical px at 150 % is 20 CSS px: it snaps
    expect(snapEdge({ x: 2880 - 570 - 30, y: 600, w: 570, h: 300 }, laptop.work, 1.5)).toBe('right');
    // dropped on the taskbar: bottom of the work area
    expect(snapEdge({ x: 900, y: 1500, w: 570, h: 240 }, laptop.work, 1.5)).toBe('bottom');
    // under the menu bar counts as top
    expect(snapEdge({ x: 500, y: 40, w: 380, h: 200 }, mac.work, 1)).toBe('top');
  });

  test('a drag near an edge on a display at negative coordinates snaps there; away from it floats', () => {
    const s = afterDrag(edge(), [laptop, left], -1910, 100, WIDTH, 200);
    expect(s).toMatchObject({ display: 'DELL', edge: 'left' });
    // centre y 200 on a work area from -200, 1032 tall
    expect(s.along).toBeCloseTo(400 / 1032, 6);
    const free = afterDrag(s, [laptop, left], -1200, 200, WIDTH, 200);
    expect(free.edge).toBeUndefined();
    expect(free.display).toBe('DELL');
  });

  test('the tab sits on its edge inside the work area, scaled to physical px', () => {
    expect(edgeRect(laptop, 'right', 0.5, SIZE, true)).toEqual({ x: 2880 - TAB * 1.5, y: 864 - (TAB_LEN * 1.5) / 2, w: TAB, h: TAB_LEN });
    expect(edgeRect(mac, 'bottom', 1, SIZE, true)).toEqual({ x: 1512 - TAB_LEN, y: 38 + 874 - TAB, w: TAB_LEN, h: TAB });
    const open = edgeRect(left, 'left', 0, SIZE, false);
    expect(open).toEqual({ x: -1920, y: -200, w: DEFAULT_W, h: DEFAULT_H });
  });
});

describe('displays', () => {
  test('the saved display, else the primary when it is gone', () => {
    expect(pickDisplay([laptop, left], 'DELL')!.id).toBe('DELL');
    expect(pickDisplay([left, laptop], 'Unplugged')!.id).toBe('Laptop');
    expect(pickDisplay([], 'x')).toBeUndefined();
  });

  test('next goes left to right and wraps; the point picks the nearest display', () => {
    expect(nextDisplay([laptop, left], 'DELL', 1)!.id).toBe('Laptop');
    expect(nextDisplay([laptop, left], 'Laptop', 1)!.id).toBe('DELL');
    expect(nextDisplay([laptop, left], 'Laptop', -1)!.id).toBe('DELL');
    expect(displayAt([laptop, left], -5, 50)!.id).toBe('DELL');
    expect(displayAt([laptop, left], 4000, 50)!.id).toBe('Laptop');
  });

  test('the same edge and along on another display with another scale', () => {
    const a = edgeRect(laptop, 'right', 0.25, SIZE, false);
    const b = edgeRect(left, 'right', 0.25, SIZE, false);
    expect(a.x + WIDTH * 1.5).toBe(2880);
    expect(b.x + WIDTH).toBe(0);
    expect(b.w).toBe(a.w);
  });
});

describe('saved', () => {
  test('a Mac with a notch starts in the notch, else docked; garbage reads as the default', () => {
    expect(defaults([mac], true).mode).toBe('notch');
    expect(defaults([laptop], false).mode).toBe('edge');
    expect(readSaved('{"mode":"weird","along":7}', edge()).mode).toBe('edge');
    expect(readSaved('{"mode":"free","along":7}', edge()).along).toBe(1);
    expect(readSaved('not json', edge({ along: 0.3 })).along).toBe(0.3);
  });

  test('the size is kept, and garbage in it is dropped', () => {
    expect(readSaved('{"mode":"free","w":900.4,"h":600}', edge())).toMatchObject({ w: 900, h: 600 });
    const bad = readSaved('{"mode":"free","w":-1,"h":"big"}', edge());
    expect([bad.w, bad.h]).toEqual([undefined, undefined]);
  });
});

describe('size', () => {
  test('760 by 460 at first, at least 520 by 320, at most the work area', () => {
    expect(sizeOn({}, mac)).toEqual({ w: 760, h: 460 });
    expect(sizeOn({ w: 100, h: 100 }, mac)).toEqual({ w: MIN_W, h: MIN_H });
    expect(sizeOn({ w: 5000, h: 5000 }, mac)).toEqual({ w: 1512, h: 874 });
    // physical px at 150 %: the work area is 1920 by 1152 CSS px
    expect(sizeOn({ w: 5000, h: 5000 }, laptop)).toEqual({ w: 1920, h: 1152 });
    // a screen smaller than the minimum: the screen wins
    const tiny: Display = { ...left, work: { x: 0, y: 0, w: 480, h: 300 } };
    expect(sizeOn({}, tiny)).toEqual({ w: 480, h: 300 });
  });

  test('free, edge and notch all open at the saved size', () => {
    const s = { w: 900, h: 560 };
    expect(target({ mode: 'free', autoHide: false, along: 0.5, ...s }, laptop, false)).toMatchObject(s);
    expect(target(edge({ edge: 'right', ...s }), laptop, false)).toMatchObject(s);
    expect(target({ mode: 'notch', autoHide: true, along: 0.5, ...s }, mac, false)).toMatchObject({ w: 900, h: 560 + 38 });
  });
});
