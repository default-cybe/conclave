/**
 * Moving what comes after a box that changed height, so nothing below it
 * jumps: every later sibling of the box, and of each of its ancestors up to
 * the scroll container, starts where it was and rides to its new place with
 * the `translate` property (which composes with any transform it already has).
 */

function scrolls(el: Element): boolean {
  const s = getComputedStyle(el);
  return /(auto|scroll)/.test(s.overflowY) || el === document.body || el === document.documentElement;
}

/** The elements after `el` in the flow, up to its scroll container. Fixed and absolute ones are left alone. */
export function followersOf(el: HTMLElement | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let n: HTMLElement | null = el; n && !scrolls(n); n = n.parentElement) {
    for (let s = n.nextElementSibling; s; s = s.nextElementSibling) {
      if (!(s instanceof HTMLElement)) continue;
      const pos = getComputedStyle(s).position;
      if (pos === 'fixed' || pos === 'absolute') continue;
      out.push(s);
    }
  }
  return out;
}

/** The element that scrolls `el`, or null when the page itself scrolls. */
export function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
  }
  return null;
}

/** The child of `scroller` that holds `el`: moving it moves everything that scrolls. */
export function contentOf(scroller: HTMLElement, el: HTMLElement): HTMLElement | null {
  let n: HTMLElement | null = el;
  while (n && n.parentElement !== scroller) n = n.parentElement;
  return n;
}
