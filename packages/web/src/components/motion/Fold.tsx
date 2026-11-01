import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/text';
import { EASE } from './ease';
import { useReducedMotion } from './useReducedMotion';
import { followersOf } from './flip';

export interface FoldProps {
  /** True while the model thinks: the row reads `liveLabel` in violet and the reasoning shows. */
  live: boolean;
  /** The row once thinking ends: "Thought for 6s". */
  label: string;
  /** The row while live. Default "Thinking". */
  liveLabel?: string;
  /** Controlled open state. Leave it out and the fold opens while live and closes when live ends. */
  open?: boolean;
  /** Uncontrolled: open at mount when not live. Default false. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The reasoning. Each direct child (a paragraph) fades in turn. */
  children: ReactNode;
  className?: string;
}

const CLOSE_MS = 320;
const OPEN_MS = 360;
type Phase = 'open' | 'closed' | 'opening' | 'closing';

/** Keyframes for a wrapper that clips by scaleY and an inner that undoes it, so the text never squashes. */
function clipFrames(from: number, to: number, ease: (x: number) => number, steps = 14) {
  const outer: Keyframe[] = [];
  const inner: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = Math.max(0.002, from + (to - from) * ease(i / steps));
    outer.push({ transform: `scaleY(${k})`, offset: i / steps });
    inner.push({ transform: `scaleY(${1 / k})`, offset: i / steps });
  }
  return { outer, inner };
}

/**
 * The "Thought for 6s" row (type.html Fold). While thinking, the row reads
 * "Thinking" in violet over the streaming reasoning. When thinking ends, in
 * the same frame the answer starts, "Thinking" turns into "Thought for 6s"
 * (the shared "Th" stays, the rest trades letters) and the reasoning folds
 * up: its paragraphs fade bottom first while its box closes from the bottom
 * and what follows rises into the space. A click opens it again: the box
 * opens, the rule draws down and the paragraphs come in top first.
 * Transform and opacity only: the box clips with scaleY and its content is
 * counter-scaled, and what follows moves with `translate` until the layout
 * catches up in one frame. Reduced motion: words swap, the reasoning shows
 * or hides at once.
 */
export function Fold({ live, label, liveLabel = 'Thinking', open: openProp, defaultOpen = false, onOpenChange, children, className }: FoldProps) {
  const reduced = useReducedMotion();
  const [inner, setInner] = useState(live || defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : inner;
  const wasLive = useRef(live);
  useEffect(() => {
    if (controlled || wasLive.current === live) return;
    wasLive.current = live;
    setInner(live);
  }, [live, controlled]);

  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed');
  const root = useRef<HTMLDivElement>(null);
  const well = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const rule = useRef<HTMLDivElement>(null);
  const anims = useRef<Animation[]>([]);
  const id = useId();

  const stopAll = () => {
    for (const a of anims.current) a.cancel();
    anims.current = [];
  };

  // open or close when asked
  useLayoutEffect(() => {
    if (open && (phase === 'closed' || phase === 'closing')) setPhase(reduced ? 'open' : 'opening');
    if (!open && (phase === 'open' || phase === 'opening')) setPhase(reduced ? 'closed' : 'closing');
  }, [open, phase, reduced]);

  // run the motion for the phase
  useLayoutEffect(() => {
    if (phase === 'closed' || phase === 'open') {
      // the layout now matches what the motion showed: drop the transforms in the same frame
      stopAll();
      return;
    }
    const w = well.current;
    const b = body.current;
    if (!w || !b) return;
    stopAll();
    const H = w.offsetHeight;
    const blocks = [...b.children].filter((n): n is HTMLElement => n instanceof HTMLElement && !n.classList.contains('cv-fold-rule'));
    const list: Animation[] = [];
    if (phase === 'closing') {
      const { outer, inner: inn } = clipFrames(1, 0, EASE.out);
      const opts: KeyframeAnimationOptions = { duration: CLOSE_MS, delay: 40, fill: 'both' };
      list.push(w.animate(outer, opts), b.animate(inn, opts));
      for (const f of followersOf(root.current)) list.push(f.animate([{ translate: '0 0' }, { translate: `0 ${-H}px` }], { ...opts, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }));
      blocks.forEach((el, i) => {
        list.push(el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-3px)' }], { duration: 150, delay: (blocks.length - 1 - i) * 26, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' }));
      });
      if (rule.current) list.push(rule.current.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(0)' }], { duration: 260, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' }));
      list[0].onfinish = () => setPhase('closed');
    } else {
      const { outer, inner: inn } = clipFrames(0, 1, EASE.std);
      const opts: KeyframeAnimationOptions = { duration: OPEN_MS, fill: 'both' };
      list.push(w.animate(outer, opts), b.animate(inn, opts));
      // what follows was pushed down by the layout; start it where it was and let it ride down with the box
      for (const f of followersOf(root.current)) list.push(f.animate([{ translate: `0 ${-H}px` }, { translate: '0 0' }], { ...opts, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }));
      blocks.forEach((el, i) => {
        list.push(el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: 70 + i * 38, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'both' }));
      });
      if (rule.current) list.push(rule.current.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 300, delay: 30, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'both' }));
      list[0].onfinish = () => setPhase('open');
    }
    anims.current = list;
  }, [phase]);

  useEffect(() => () => stopAll(), []);

  const toggle = () => {
    const next = !open;
    if (!controlled) setInner(next);
    onOpenChange?.(next);
  };

  const mounted = phase !== 'closed';
  return (
    <div ref={root} className={cn('cv-fold', className)}>
      <button type="button" className="cv-fold-row" aria-expanded={open} aria-controls={id} onClick={toggle} data-live={live || undefined}>
        <MorphLabel text={live ? liveLabel : label} live={live} />
        <ChevronRight className="cv-fold-chev" data-open={open || undefined} strokeWidth={1.75} aria-hidden />
      </button>
      {mounted && (
        <div ref={well} id={id} className="cv-fold-well">
          <div ref={body} className="cv-fold-body">
            <div ref={rule} className="cv-fold-rule" aria-hidden />
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

/** The pieces of a label turning from `from` into `to`, and when each part of the motion is over. */
export interface MorphPlan {
  /** The start both share; it stays. */
  pre: string;
  /** The letters that leave, right to left. */
  old: string;
  /** The letters that arrive, left to right. */
  fresh: string;
  /** When the new letters start arriving (ms). */
  at: number;
  /** When the old letters are gone and only the new word is laid out. */
  leaveMs: number;
  /** When the last new letter has landed: the label is one word again. */
  doneMs: number;
}

/** Pure, for tests: the old letters leave in 110ms each, 12ms apart; the new ones arrive in 220ms each, 16ms apart. */
export function morphPlan(from: string, to: string): MorphPlan {
  let n = 0;
  while (n < from.length && n < to.length && from[n] === to[n]) n++;
  const old = from.slice(n);
  const fresh = to.slice(n);
  const at = old.length ? 120 + 12 * (old.length - 1) : 0;
  const leaveMs = 260 + old.length * 12;
  return { pre: to.slice(0, n), old, fresh, at, leaveMs, doneMs: Math.max(leaveMs, at + Math.max(0, fresh.length - 1) * 16 + 220) };
}

/**
 * A label that turns into another and keeps what they share at the start:
 * "Thinking" to "Thought for 6s" keeps "Th"; the old letters leave right to
 * left (110ms each, 12ms apart), and once they are gone the new ones arrive
 * left to right (220ms each, 16ms apart). What follows the label
 * slides to its new place instead of jumping.
 *
 * Only while it turns is the label in pieces (the shared start twice, for
 * the tone, and a letter per span); before and after, it is the one word,
 * so a copy, find in page or a screen reader reads it once, never
 * "Thought for 15sThought for 1Thought for 15s".
 */
export function MorphLabel({ text, live, className }: { text: string; live?: boolean; className?: string }) {
  const state = useRef<{ text: string; plan: MorphPlan | null; v: number }>({ text, plan: null, v: 0 });
  if (state.current.text !== text) state.current = { text, plan: morphPlan(state.current.text, text), v: state.current.v + 1 };
  const { plan, v } = state.current;
  const ref = useRef<HTMLSpanElement>(null);
  // the old letters are gone (`settled`), then the new ones have landed (`done`)
  const [settled, setSettled] = useState(v);
  const [done, setDone] = useState(v);
  // the label is turning (its version), or -1 at rest: for the observer below
  const turning = useRef(-1);

  useEffect(() => {
    if (done === v || !plan) return;
    const leave = setTimeout(() => setSettled(v), plan.leaveMs);
    const end = setTimeout(() => {
      setSettled(v);
      setDone(v);
    }, plan.doneMs);
    return () => {
      clearTimeout(leave);
      clearTimeout(end);
    };
  }, [v, done, plan]);

  // what follows the label (the chevron) slides from where it was, while the label turns. The width comes
  // from a ResizeObserver, after the browser laid the label out anyway: reading it in a layout effect laid
  // out every turn of a long transcript as it mounted, though it sat skipped off screen (.log-unit)
  useLayoutEffect(() => {
    turning.current = done === v || !plan ? -1 : v;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let was = 0;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      const from = was;
      was = w;
      const next = el.nextElementSibling as HTMLElement | null;
      // only while a label turns (a turn coming into view or a font loading is no reason to slide)
      if (turning.current < 0 || !from || !w || from === w || !next) return;
      next.animate([{ translate: `${from - w}px 0` }, { translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (done === v || !plan)
    return (
      <span ref={ref} className={cn('cv-morph', className)} data-live={live || undefined}>
        <span className="cv-morph-word">{text}</span>
      </span>
    );

  const { pre, old, fresh, at } = plan;
  const leaving = settled !== v && old.length > 0;
  return (
    <span ref={ref} className={cn('cv-morph', className)} data-live={live || undefined}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="cv-morph-pre">
        <span data-tone="live">{pre}</span>
        <span data-tone="done">{pre}</span>
      </span>
      <span aria-hidden className="cv-morph-suf">
        {leaving && (
          <span key={`o${v}`} className="cv-morph-old">
            {Array.from(old).map((c, i, all) => (
              <span key={i} style={{ '--i': all.length - 1 - i } as CSSProperties}>
                {c}
              </span>
            ))}
          </span>
        )}
        <span key={`n${v}`} className="cv-morph-new" style={{ '--at': `${at}ms` } as CSSProperties}>
          {Array.from(fresh).map((c, i) => (
            <span key={i} style={{ '--i': i } as CSSProperties}>
              {c}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
