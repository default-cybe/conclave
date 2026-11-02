/**
 * Overlay placement math (src/overlay/place.ts): snapping to the work area,
 * scale factors, displays at negative coordinates, the display fallback, and
 * the notch from safe-area insets.
 *   cd packages/web && bun test test/overlay-place.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { afterDrag, defaults, displayAt, edgeRect, nextDisplay, notchRect, notchSize, pickDisplay, readSaved, snapEdge, TAB, TAB_LEN, WIDTH, type Display, type Saved } from '../src/overlay/place';

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
    const shut = notchRect(mac, false, 300);
    expect(shut.pill).toEqual({ w: 188 + 88, h: 38 });
    expect(shut).toMatchObject({ x: 756 - 138, y: 0, w: 276, h: 38 });
    const open = notchRect(mac, true, 300);
    expect(open).toMatchObject({ x: 756 - WIDTH / 2, y: 0, w: WIDTH, h: 300 });
  });

  test('no notch: a pill as tall as the menu bar at the top centre', () => {
    const ext: Display = { ...mac, id: 'LG', notch: undefined, frame: { x: 1512, y: -300, w: 2560, h: 1440 }, work: { x: 1512, y: -275, w: 2560, h: 1415 } };
    expect(notchRect(ext, false, 0)).toMatchObject({ x: 1512 + 1280 - 100, y: -300, w: 200, h: 25 });
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
    expect(edgeRect(laptop, 'right', 0.5, 300, true)).toEqual({ x: 2880 - TAB * 1.5, y: 864 - (TAB_LEN * 1.5) / 2, w: TAB, h: TAB_LEN });
    expect(edgeRect(mac, 'bottom', 1, 300, true)).toEqual({ x: 1512 - TAB_LEN, y: 38 + 874 - TAB, w: TAB_LEN, h: TAB });
    const open = edgeRect(left, 'left', 0, 5000, false);
    expect(open.x).toBe(-1920);
    expect(open.y).toBe(-200);
    expect(open.h).toBe((1032 * 3) / 4);
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
    const a = edgeRect(laptop, 'right', 0.25, 200, false);
    const b = edgeRect(left, 'right', 0.25, 200, false);
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
});
