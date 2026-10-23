import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/text';
import { useFocusTrap } from '../ui/Overlay';
import { EASE } from './ease';
import { useReducedMotion } from './useReducedMotion';

export interface CardToPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The card, shown in place. It is rendered inside a button that opens the panel, so keep it free of other controls. */
  card: ReactNode;
  cardClassName?: string;
  /** The panel's content, mounted while open. */
  children: ReactNode;
  /** The panel's accessible name: the card's title. */
  label: string;
  /** Size of the panel. Default: 640px wide, up to 80% of the screen tall, centered. */
  panelClassName?: string;
}

const OPEN_MS = 420;
const CLOSE_MS = 320;
type Phase = 'closed' | 'opening' | 'open' | 'closing';

/** Keyframes of a box that grows from rect a to rect b, and of its content counter-scaled so it never stretches. */
export function growFrames(a: DOMRect, b: DOMRect, ease: (x: number) => number, reverse: boolean, steps = 16) {
  const outer: Keyframe[] = [];
  const inner: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = ease(i / steps);
    const p = reverse ? 1 - k : k;
    const sx = (a.width + (b.width - a.width) * p) / b.width;
    const sy = (a.height + (b.height - a.height) * p) / b.height;
    const x = (a.left - b.left) * (1 - p);
    const y = (a.top - b.top) * (1 - p);
    outer.push({ transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})`, offset: i / steps });
    inner.push({ transform: `scale(${1 / sx}, ${1 / sy})`, offset: i / steps });
  }
  return { outer, inner };
}

/**
 * Card to panel (ui.html card-panel): the card itself grows into its panel
 * (a container transform) while the page dims; closing shrinks it back into
 * the card. The panel is a modal dialog: focus moves into it, Tab stays in
 * it, Esc or a click outside closes it, and focus returns to the card.
 * Transform and opacity only; the panel's content is counter-scaled, so
 * text never stretches. Open 420ms on --ease-emph, close 320ms on
 * --ease-std. Reduced motion: the panel opens and closes in place.
 */
export function CardToPanel({ open, onOpenChange, card, cardClassName, children, label, panelClassName }: CardToPanelProps) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed');
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const from = useRef<DOMRect | null>(null);
  const anims = useRef<Animation[]>([]);
  const shown = useRef(children);
  if (open) shown.current = children;

  useLayoutEffect(() => {
    if (open && (phase === 'closed' || phase === 'closing')) {
      from.current = trigger.current?.getBoundingClientRect() ?? null;
      setPhase(reduced ? 'open' : 'opening');
    }
    if (!open && (phase === 'open' || phase === 'opening')) {
      from.current = trigger.current?.getBoundingClientRect() ?? null;
      setPhase(reduced ? 'closed' : 'closing');
    }
  }, [open, phase, reduced]);

  useLayoutEffect(() => {
    for (const a of anims.current) a.cancel();
    anims.current = [];
    if (phase !== 'opening' && phase !== 'closing') return;
    const p = panel.current;
    const c = inner.current;
    const a = from.current;
    if (!p || !c || !a) {
      setPhase(phase === 'opening' ? 'open' : 'closed');
      return;
    }
    const b = p.getBoundingClientRect();
    const list: Animation[] = [];
    const g = ghost.current;
    if (phase === 'opening') {
      const { outer, inner: inn } = growFrames(a, b, EASE.emph, false);
      list.push(p.animate(outer, { duration: OPEN_MS, fill: 'both' }), c.animate(inn, { duration: OPEN_MS, fill: 'both' }));
      list.push(c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 230, delay: 110, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'both' }));
      if (g) {
        // the card's own face rides the top left corner of the growing box and fades out first
        const moves: Keyframe[] = [];
        for (let i = 0; i <= 16; i++) {
          const k = EASE.emph(i / 16);
          moves.push({ transform: `translate(${(b.left - a.left) * k}px, ${(b.top - a.top) * k}px)`, offset: i / 16 });
        }
        list.push(g.animate(moves, { duration: OPEN_MS, fill: 'both' }));
        list.push(g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' }));
      }
      if (scrim.current) list.push(scrim.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'both' }));
      list[0].onfinish = () => setPhase('open');
    } else {
      const { outer, inner: inn } = growFrames(a, b, EASE.std, true);
      list.push(p.animate(outer, { duration: CLOSE_MS, fill: 'both' }), c.animate(inn, { duration: CLOSE_MS, fill: 'both' }));
      list.push(c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' }));
      if (g) {
        const moves: Keyframe[] = [];
        for (let i = 0; i <= 16; i++) {
          const k = 1 - EASE.std(i / 16);
          moves.push({ transform: `translate(${(b.left - a.left) * k}px, ${(b.top - a.top) * k}px)`, offset: i / 16 });
        }
        list.push(g.animate(moves, { duration: CLOSE_MS, fill: 'both' }));
        // the card's face comes back while the box is still shrinking, so the box is never blank
        list.push(g.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: 60, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'both' }));
      }
      if (scrim.current) list.push(scrim.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' }));
      list[0].onfinish = () => setPhase('closed');
    }
    anims.current = list;
  }, [phase]);

  useEffect(() => () => anims.current.forEach((a) => a.cancel()), []);

  const mounted = phase !== 'closed';
  const modal = open && phase !== 'closing';
  useFocusTrap(panel, modal);
  // give focus back to the card, even when the click never focused it (Safari, a script)
  const wasModal = useRef(modal);
  useEffect(() => {
    if (wasModal.current && !modal) {
      const a = document.activeElement;
      if (!a || a === document.body || panel.current?.contains(a)) trigger.current?.focus({ preventScroll: true });
    }
    wasModal.current = modal;
  }, [modal]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onOpenChange(false);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(true)}
        className={cn('cv-card', cardClassName)}
        // hidden under the panel but still focusable, so focus can come back to it
        style={{ opacity: mounted ? 0 : undefined }}
      >
        {card}
      </button>
      {mounted &&
        createPortal(
          <div className="cv-panel-layer" data-closing={phase === 'closing' || undefined}>
            <div ref={scrim} className="cv-panel-scrim" onClick={() => onOpenChange(false)} />
            <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKey} inert={phase === 'closing' || undefined} className={cn('cv-panel', panelClassName)}>
              <div ref={inner} className="cv-panel-inner">
                {shown.current}
              </div>
            </div>
            {from.current && (phase === 'opening' || phase === 'closing') && (
              <div ref={ghost} aria-hidden inert className={cn('cv-panel-ghost', cardClassName)} style={{ left: from.current.left, top: from.current.top, width: from.current.width, height: from.current.height }}>
                {card}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
