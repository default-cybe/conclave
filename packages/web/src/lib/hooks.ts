import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

// one subscribe function per query: a new one each render makes React drop and add the listener on every render
const subscribers = new Map<string, (cb: () => void) => () => void>();

function mq(query: string) {
  let sub = subscribers.get(query);
  if (!sub) {
    sub = (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    };
    subscribers.set(query, sub);
  }
  return sub;
}

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    mq(query),
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Breakpoints (spec 5.2): phone < 768, tablet 768 to 1023, desktop 1024 to 1279, wide >= 1280. */
export const useIsMobile = () => useMedia('(max-width: 767px)');
export const useIsTablet = () => useMedia('(min-width: 768px) and (max-width: 1023px)');
export const useIsDesktop = () => useMedia('(min-width: 1024px)');
export const useIsWide = () => useMedia('(min-width: 1280px)');
export type Breakpoint = 'phone' | 'tablet' | 'desktop' | 'wide';
export function useBreakpoint(): Breakpoint {
  const phone = useIsMobile();
  const tablet = useIsTablet();
  const wide = useIsWide();
  return phone ? 'phone' : tablet ? 'tablet' : wide ? 'wide' : 'desktop';
}
export const useCoarsePointer = () => useMedia('(pointer: coarse)');
/** System reduced motion or Appearance > Reduce motion (one hook for both; see components/motion). */
export { useReducedMotion } from '@/components/motion/useReducedMotion';

// One shared ticker per interval, aligned to the interval boundary, so a page
// full of counters runs one timer and they all tick together.
const tickers = new Map<number, { subs: Set<() => void>; timer?: ReturnType<typeof setTimeout> }>();

function ticker(ms: number) {
  let t = tickers.get(ms);
  if (!t) {
    t = { subs: new Set() };
    tickers.set(ms, t);
  }
  return t;
}

/** Re-render every `ms` (countdowns, elapsed counters, relative times). Returns now, quantized to `ms`. */
export function useNow(ms = 1000): number {
  const t = ticker(ms);
  return useSyncExternalStore(
    (cb) => {
      t.subs.add(cb);
      if (!t.timer) {
        const step = () => {
          t.timer = setTimeout(
            () => {
              for (const s of t.subs) s();
              if (t.subs.size) step();
              else t.timer = undefined;
            },
            ms - (Date.now() % ms) + 4,
          );
        };
        step();
      }
      return () => {
        t.subs.delete(cb);
        if (!t.subs.size && t.timer) {
          clearTimeout(t.timer);
          t.timer = undefined;
        }
      };
    },
    () => Math.floor(Date.now() / ms) * ms,
    // rendered to a string (tests of a running row): the time now
    () => Math.floor(Date.now() / ms) * ms,
  );
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    },
  ];
}

/** Fetch helper with refetch on deps; keeps last data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; error?: string; reload: () => void } {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(undefined);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}

/** True only after `ms` of a pending state, so quick loads never flash a skeleton (spec 2: 300ms). */
export function useDelayed(pending: boolean, ms = 300): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), ms);
    return () => clearTimeout(t);
  }, [pending, ms]);
  return show;
}
