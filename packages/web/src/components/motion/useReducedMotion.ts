import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function reducedNow(): boolean {
  if (typeof window === 'undefined') return true;
  return window.matchMedia(QUERY).matches || document.documentElement.dataset.motion === 'reduce';
}

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  // Appearance > Reduce motion sets html[data-motion="reduce"]
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  return () => {
    mq.removeEventListener('change', cb);
    mo.disconnect();
  };
}

/**
 * True when motion should stop: the system asks for reduced motion, or the
 * owner turned on Appearance > Reduce motion. Draw a still frame instead.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reducedNow, () => true);
}

function subscribeVisible(cb: () => void): () => void {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}

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
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) setOn(e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}
