/**
 * How see-through the overlay panel is (overlay.css --ov-opacity), 60 to 100 %,
 * 80 % by default. Kept in this window's localStorage, so each device has its own.
 */
export const OPACITY_MIN = 60;
export const OPACITY_MAX = 100;
export const OPACITY_DEFAULT = 80;
const KEY = 'conclave.overlay.opacity';

/** A stored value outside 60..100 (or none, or no storage) reads as the default. */
export function readOpacity(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): number {
  try {
    const n = Number(storage?.getItem(KEY) ?? NaN);
    return Number.isFinite(n) && n >= OPACITY_MIN && n <= OPACITY_MAX ? n : OPACITY_DEFAULT;
  } catch {
    return OPACITY_DEFAULT;
  }
}

export function applyOpacity(n: number): void {
  document.documentElement.style.setProperty('--ov-opacity', `${n}%`);
}

export function saveOpacity(n: number): void {
  applyOpacity(n);
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    /* no storage: this window only */
  }
}
