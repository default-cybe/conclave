/**
 * One flush per animation frame (docs/design/MEETING-MODE.md 3.4, 4.5).
 * Events pushed between two frames are handed over together on the next
 * frame, so 500 deltas in one frame cost one render. Nothing is scheduled
 * while nothing arrives: the page stays idle between deltas.
 */
export interface FrameBuffer<T> {
  push(item: T): void;
  /** Drop what waits and stop. */
  cancel(): void;
}

type Raf = (cb: () => void) => number;
type Caf = (id: number) => void;

/** Channel levels: the previous object when neither moved by 0.02 or more, so React skips the render. */
export function levelsOrSame<L extends { me: number; them: number }>(prev: L, next: L): L {
  return Math.abs(prev.me - next.me) < 0.02 && Math.abs(prev.them - next.them) < 0.02 ? prev : next;
}

export type Levels = { me: number; them: number };

/** Channel levels outside React: the meters subscribe and paint themselves, so a level never renders the overlay. */
export interface LevelSource {
  get(): Levels;
  subscribe(fn: (l: Levels) => void): () => void;
}

export function levelSource(): LevelSource & { set(l: Levels): void } {
  let cur: Levels = { me: 0, them: 0 };
  const subs = new Set<(l: Levels) => void>();
  return {
    get: () => cur,
    subscribe: (fn) => (subs.add(fn), () => void subs.delete(fn)),
    set(l) {
      const next = levelsOrSame(cur, l);
      if (next === cur) return;
      cur = next;
      for (const fn of subs) fn(cur);
    },
  };
}

/** The same status as before keeps the old object: the app sends it 4 times a second, mostly unchanged. */
export function statusOrSame<S>(prev: S | undefined, next: S): S {
  return prev !== undefined && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

export function frameBuffer<T>(flush: (items: T[]) => void, raf: Raf = requestAnimationFrame, caf: Caf = cancelAnimationFrame): FrameBuffer<T> {
  let items: T[] = [];
  let id: number | undefined;
  const run = () => {
    id = undefined;
    const batch = items;
    items = [];
    if (batch.length) flush(batch);
  };
  return {
    push(item) {
      items.push(item);
      if (id === undefined) id = raf(run);
    },
    cancel() {
      if (id !== undefined) caf(id);
      id = undefined;
      items = [];
    },
  };
}
