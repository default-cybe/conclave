/**
 * The answer's text size (overlay.css --ov-text), 16 to 26 px, 19 by default:
 * A- and A+ in the overlay's menu. Kept in this window's localStorage, so each
 * device has its own, as opacity.ts.
 */
export const TEXT_MIN = 16;
export const TEXT_MAX = 26;
export const TEXT_DEFAULT = 19;
const KEY = 'conclave.overlay.text';

/** A stored value outside 16..26 (or none, or no storage) reads as the default. */
export function readTextSize(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): number {
  try {
    const n = Number(storage?.getItem(KEY) ?? NaN);
    return Number.isInteger(n) && n >= TEXT_MIN && n <= TEXT_MAX ? n : TEXT_DEFAULT;
  } catch {
    return TEXT_DEFAULT;
  }
}

export function applyTextSize(n: number): void {
  document.documentElement.style.setProperty('--ov-text', `${n}px`);
}

/** One step up or down from `n`, kept in range, applied and saved; returns the new size. */
export function stepTextSize(n: number, dir: -1 | 1, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): number {
  const next = Math.min(TEXT_MAX, Math.max(TEXT_MIN, n + dir));
  if (typeof document !== 'undefined') applyTextSize(next);
  try {
    storage?.setItem(KEY, String(next));
  } catch {
    /* no storage: this window only */
  }
  return next;
}
