import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { LIVE_ROWS } from './agentGlyphs';

/** One source for every subscriber: `start` runs for the first, its cleanup after the last leaves. */
export function shared(start: (emit: () => void) => () => void): (cb: () => void) => () => void {
  const subs = new Set<() => void>();
  let stop: (() => void) | undefined;
  const emit = () => {
    for (const cb of subs) cb();
  };
  return (cb) => {
    subs.add(cb);
    if (subs.size === 1) stop = start(emit);
    return () => {
      subs.delete(cb);
      if (subs.size) return;
      stop?.();
      stop = undefined;
    };
  };
}

const QUERY = '(prefers-reduced-motion: reduce)';

function reducedNow(): boolean {
  if (typeof window === 'undefined') return true;
  return window.matchMedia(QUERY).matches || document.documentElement.dataset.motion === 'reduce';
}

// one media listener and one MutationObserver for every glyph, pet and knot on the page
const subscribe = shared((cb) => {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  // Appearance > Reduce motion sets html[data-motion="reduce"]
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  return () => {
    mq.removeEventListener('change', cb);
    mo.disconnect();
  };
});

/**
 * True when motion should stop: the system asks for reduced motion, or the
 * owner turned on Appearance > Reduce motion. Draw a still frame instead.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reducedNow, () => true);
}

const subscribeVisible = shared((cb) => {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
});

/** False while the tab is in the background. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisible, () => document.visibilityState === 'visible', () => true);
}

/**
 * True while the element is on screen (any part of it). Loops pause when this
 * is false so a long transcript of finished turns costs nothing.
 */
export function useOnscreen(ref: RefObject<Element | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    return watch(el, setOn);
  }, [ref]);
  return on;
}

// one IntersectionObserver for every element that asks (useOnscreen)
const watched = new Map<Element, (on: boolean) => void>();
let io: IntersectionObserver | undefined;
function watch(el: Element, cb: (on: boolean) => void): () => void {
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) watched.get(e.target)?.(e.isIntersecting);
  });
  watched.set(el, cb);
  io.observe(el);
  return () => {
    watched.delete(el);
    io?.unobserve(el);
  };
}

// the rows that asked to move, in the order they asked (useLiveSlot)
const slots: object[] = [];
const slotSubs = new Set<() => void>();
const subscribeSlots = (cb: () => void) => {
  slotSubs.add(cb);
  return () => slotSubs.delete(cb);
};
const slotsChanged = () => {
  for (const cb of slotSubs) cb();
};

/**
 * For a live row outside a list that can count them (a Delegate line in a
 * reply): true when it should draw its still frame, because LIVE_ROWS rows
 * that went live before it still move (CHAT-AND-MOTION 1.9).
 * shortcut: counts in mount order across the app, not screen order; upgrade if old live rows hold slots off screen.
 */
export function useLiveSlot(live: boolean): boolean {
  const me = useRef({}).current;
  useEffect(() => {
    if (!live) return;
    slots.push(me);
    slotsChanged();
    return () => {
      slots.splice(slots.indexOf(me), 1);
      slotsChanged();
    };
  }, [live, me]);
  const at = useSyncExternalStore(subscribeSlots, () => slots.indexOf(me), () => -1);
  return live && at >= LIVE_ROWS;
}
