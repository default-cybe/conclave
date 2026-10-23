/**
 * Hover groups without :hover on the group. A turn's quiet actions and a
 * code block's Copy show while the pointer is over the turn or the block
 * (index.css, .reveal-turn and .reveal-code). One listener marks the
 * elements with data-hover under the pointer with data-hot, so a turn or
 * block changes once as the pointer crosses into it and only its controls
 * restyle. With Tailwind's group-hover each crossing restyled the whole
 * turn left and the one entered, and wheel scrolling moves turns under a
 * still pointer all the time.
 */

/** The data-hover elements holding `target`, innermost first. */
export function hoverGroups(target: EventTarget | null): Element[] {
  const out: Element[] = [];
  let el = target instanceof Element ? target.closest('[data-hover]') : null;
  while (el) {
    out.push(el);
    el = el.parentElement?.closest('[data-hover]') ?? null;
  }
  return out;
}

let hot: Element[] = [];

function mark(next: Element[]) {
  for (const el of hot) if (!next.includes(el)) el.removeAttribute('data-hot');
  for (const el of next) if (!hot.includes(el)) el.setAttribute('data-hot', '');
  hot = next;
}

let installed = false;

/** Start marking (once, from main.tsx). Touch is left out: there the controls always show. */
export function installHoverGroups(doc: Document = document) {
  if (installed) return;
  installed = true;
  doc.addEventListener('pointerover', (e) => e.pointerType !== 'touch' && mark(hoverGroups(e.target)), { capture: true, passive: true });
  // the pointer left the window
  doc.addEventListener('pointerout', (e) => !e.relatedTarget && mark([]), { capture: true, passive: true });
}
