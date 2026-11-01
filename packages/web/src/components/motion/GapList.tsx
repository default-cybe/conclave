import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/text';
import { DUR, SPRING } from './tokens';
import { springCss } from './ease';
import { usePresenceList } from './usePresence';
import { useReducedMotion } from './useReducedMotion';
import { contentOf, followersOf, scrollerOf } from './flip';

/** The slide out: 170ms on --ease-in. The rest start closing the gap 90ms in. */
export const GAP_OUT_MS = 170;
const GAP_CLOSE_DELAY = 90;
let springEase: string | null = null;
const easing = () => (springEase ??= springCss(SPRING.response, SPRING.damping));

/**
 * Close the gap: after each render, every child of `ref` with a
 * `data-gap-key` that moved (because one above it left, arrived or moved)
 * slides from where it was to its new place on the critically damped
 * spring. New children rise 4px and fade in. What comes after the list
 * (up to the scroll container) rides along, so nothing below it jumps.
 * Slides add to any still running, so a second change mid-flight never
 * jumps. When the list gets shorter at the foot of a view scrolled to the
 * bottom, the browser pulls the scroll back and everything above would
 * drop at once; the scrolled content then glides down into place instead.
 * Transform and opacity only.
 * GapList is the ready-made list; use this hook when you render the rows.
 */
export function useGapClose(ref: RefObject<HTMLElement | null>) {
  const reduced = useReducedMotion();
  const last = useRef<Map<string, number> | null>(null);
  const lastH = useRef<number | null>(null);
  const lastSpan = useRef<number | null>(null);
  const view = useRef<{ el: HTMLElement | null; top: number } | null>(null);
  const glides = useRef<Array<() => void>>([]);
  useEffect(() => () => glides.current.forEach((end) => end()), []);

  // where the view was scrolled before a change: kept current as it scrolls
  useLayoutEffect(() => {
    const el = scrollerOf(ref.current);
    view.current = { el, top: el?.scrollTop ?? 0 };
    if (!el) return;
    const onScroll = () => {
      if (view.current) view.current.top = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const h = root.offsetHeight;
    const prevH = lastH.current;
    lastH.current = h;
    const now = new Map<string, number>();
    const rows = [...root.querySelectorAll<HTMLElement>(':scope > [data-gap-key]')];
    const before = last.current;
    // a row that was in the flow and now leaves: the rest wait 90ms, so the slide out reads first
    const removed = !!before && rows.some((el) => el.dataset.gapLeaving !== undefined && before.has(el.dataset.gapKey!));
    const delay = removed ? GAP_CLOSE_DELAY : 0;
    const slide = (el: HTMLElement, dy: number) => {
      try {
        return el.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: SPRING.settle, easing: easing(), delay, fill: 'backwards', composite: 'add' });
      } catch {
        return el.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], { duration: 320, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', delay, fill: 'backwards', composite: 'add' });
      }
    };
    for (const el of rows) {
      const key = el.dataset.gapKey!;
      if (el.dataset.gapLeaving !== undefined) continue;
      const top = el.offsetTop;
      now.set(key, top);
      if (!before || reduced) continue;
      const was = before.get(key);
      if (was === undefined) {
        // an entrance, like every other: --dur-2 on --ease
        el.animate([{ opacity: 0, translate: '0 -4px' }, { opacity: 1, translate: '0 0' }], { duration: DUR.d2, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards', composite: 'add' });
        continue;
      }
      // where it was laid out minus where it is now; a slide still running adds on top
      if (Math.abs(was - top) >= 0.5) slide(el, was - top);
    }
    const v = view.current;
    // the list got shorter or taller: what follows starts where it was
    if (prevH !== null && prevH !== h && !reduced) for (const f of followersOf(root)) slide(f, prevH - h);
    // How far the list reaches, with the rows still sliding out (they are out of the flow but still
    // make the view scrollable). When it gets shorter at the foot of a view scrolled to the end, the
    // browser pulls the scroll back (once when a row leaves the flow, once more when it is gone) and
    // everything above would drop at once; the scrolled content starts where it was and glides down.
    let span = h;
    for (const el of rows) if (el.dataset.gapLeaving !== undefined) span = Math.max(span, el.offsetTop + el.offsetHeight);
    const prevSpan = lastSpan.current;
    lastSpan.current = span;
    // only when the browser did pull the scroll back in this change (a view not at its end never is)
    if (v?.el && !reduced && prevH !== null && prevSpan !== null && (h < prevH || span < prevSpan) && v.top - v.el.scrollTop > 0.5) {
      const content = contentOf(v.el, root);
      const end = content && glideDown(v.el, content, v.top, delay);
      if (end) glides.current.push(end);
    }
    if (v?.el) v.top = v.el.scrollTop;
    last.current = now;
  });
}

/**
 * How far content scrolled to `top` drops once the flow ends at `flowEnd`
 * (plus the scroller's end padding `pad`) in a view `viewport` px tall, and
 * how tall a spacer after the flow must be to hold the scroll where it is
 * until then. Pure, for tests.
 */
export function glideDrop(top: number, flowEnd: number, pad: number, viewport: number): { drop: number; hold: number } {
  const settle = Math.max(0, flowEnd + pad - viewport);
  const drop = Math.max(0, top - settle);
  return { drop, hold: Math.max(drop, top + viewport - flowEnd - pad) };
}

/**
 * The list got shorter at the foot of a view scrolled to (near) its end, so
 * the browser pulls the scroll back (once as a row leaves the flow, again
 * when it is gone) and everything above would drop at once. Instead: a
 * spacer keeps the scroll range where it was, so nothing moves yet, and the
 * content glides down (transform only) by as far as it will drop; when it
 * lands, the spacer goes and the glide ends in the same frame, so the layout
 * and the picture agree. Returns a function that ends it at once, or null
 * when nothing would drop.
 */
function glideDown(scroller: HTMLElement, content: HTMLElement, top: number, delay: number): (() => void) | null {
  const spacer = document.createElement('div');
  spacer.setAttribute('aria-hidden', 'true');
  spacer.style.cssText = 'height:0;pointer-events:none';
  scroller.appendChild(spacer);
  // where the flow ends now (a row sliding out is out of the flow), and where the scroll will settle
  const flowEnd = spacer.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop;
  const pad = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
  const { drop, hold } = glideDrop(top, flowEnd, pad, scroller.clientHeight);
  if (drop < 0.5) {
    spacer.remove();
    return null;
  }
  spacer.style.height = `${hold}px`;
  scroller.scrollTop = top;
  const frames = [{ translate: '0 0' }, { translate: `0 ${drop}px` }];
  let anim: Animation;
  try {
    anim = content.animate(frames, { duration: SPRING.settle, easing: easing(), delay, fill: 'forwards', composite: 'add' });
  } catch {
    anim = content.animate(frames, { duration: 320, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', delay, fill: 'forwards', composite: 'add' });
  }
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    anim.cancel();
    spacer.remove();
  };
  anim.finished.then(end, end);
  return end;
}

export interface GapListProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** One row. `leaving` is true for the 170ms a resolved row slides out. */
  children: (item: T, state: { leaving: boolean }) => ReactNode;
  className?: string;
  itemClassName?: string;
  /** How a row leaves: slide 34px to the right and fade (approvals), or just fade. */
  exit?: 'right' | 'fade';
}

/**
 * Approve and close the gap (ui.html approve-gap). When a row leaves the
 * list it slides out to the right and fades in 170ms; 90ms in, the rows
 * below spring up into the space, so the list never jumps. Rows that
 * arrive rise 4px and fade in while the rest make room. Let the row
 * confirm in place first (its label swaps, its side rule turns ok), then
 * remove it from `items`.
 */
export function GapList<T>({ items, keyOf, children, className, itemClassName, exit = 'right' }: GapListProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = usePresenceList(items, keyOf, GAP_OUT_MS);
  useGapClose(ref);
  const geom = useRef(new Map<string, { top: number; left: number; width: number }>());

  // remember where each row is, so a leaving row can stay exactly there out of the flow
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>(':scope > [data-gap-key]')) {
      if (el.dataset.gapLeaving !== undefined) continue;
      geom.current.set(el.dataset.gapKey!, { top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth });
    }
  });

  return (
    <div ref={ref} className={cn('cv-gap', className)}>
      {shown.map(({ item, key, leaving }) => {
        const g = leaving ? geom.current.get(key) : undefined;
        return (
          <div
            key={key}
            data-gap-key={key}
            data-gap-leaving={leaving ? '' : undefined}
            inert={leaving || undefined}
            className={cn(itemClassName, leaving && (exit === 'right' ? 'cv-gap-out-right' : 'cv-gap-out'))}
            style={g ? { position: 'absolute', top: g.top, left: g.left, width: g.width, margin: 0 } : undefined}
          >
            {children(item, { leaving })}
          </div>
        );
      })}
    </div>
  );
}
