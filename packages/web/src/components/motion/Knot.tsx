import { useEffect, useLayoutEffect, useRef } from 'react';
import { KnotSvg, paintKnot, useKnotSurface } from '../brand/KnotSvg';
import { onFrame } from './frame';
import { KnotMotion, knotStill, type KnotState } from './knotMath';
import { useOnscreen, usePageVisible, useReducedMotion } from './useReducedMotion';

/**
 * What the model is doing, said by the Knot: the Conclave mark, its light
 * moving (docs/design/CHAT-AND-MOTION.md 1.3, docs/design/brand/README.md).
 *
 * thinking  the knot dims; one violet light writes it, then lets go from the tail (3s)
 * tool      the knot dims; a short violet light travels it, over and under (2s a lap)
 * waiting   the light turns amber and holds where it is (waiting on you); resumes from there
 * paused    a limit: the light holds in fg-3; thinking writes on from it when the limit resets
 * failed    the light stops and turns the fault color (put Retry next to it)
 * done      the light fades and the knot turns fg-3, still
 *
 * Older names still work: working = tool, resuming = paused, idle = done.
 */
export type MarkState = KnotState | 'working' | 'resuming' | 'idle';

export const knotState = (s: MarkState): KnotState => (s === 'working' ? 'tool' : s === 'resuming' ? 'paused' : s === 'idle' ? 'done' : s);

export interface KnotProps {
  state?: MarkState;
  /** Box size in px, 12 to 160 (square). 14 or 16 in a status line, 112 to 160 as the empty chat hero. */
  size?: number;
  /** One color: the knot and its light in currentColor (the knot at 30% while it works). */
  mono?: boolean;
  /** Draw the state's still pose and never animate (rows in lists, spec 1.9). */
  still?: boolean;
  /**
   * For waiting and failed: the working state the reply was in at that moment, when it may not
   * have been drawn yet. An approval arrives in the same update as the tool call it is for, so
   * the Knot passes through the tool pose and holds that (a short light, amber), not a
   * thinking stroke.
   */
  via?: 'thinking' | 'tool';
  /** Accessible name. Without it the mark is decorative (aria-hidden); say the state in words next to it. */
  label?: string;
  /** The color behind the mark, when it is not the nearest background (the halos at the crossings take it). */
  surface?: string;
  className?: string;
}

/**
 * The Conclave knot with a moving light. SVG; the light's place comes from
 * KnotMotion on the shared frame loop, only while something changes, and
 * pauses offscreen and in background tabs. Colors change by CSS transition.
 * Reduced motion draws one still, clear pose per state.
 */
export function Knot({ state = 'thinking', size = 16, mono, still, via, label, surface, className }: KnotProps) {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const onscreen = useOnscreen(ref);
  const visible = usePageVisible();
  const s = Math.round(Math.max(12, Math.min(160, size)));
  const target = knotState(state);
  const motion = useRef<KnotMotion | null>(null);
  if (!motion.current) motion.current = new KnotMotion(target, performance.now(), via);
  useKnotSurface(ref, surface);

  // follow the state
  useLayoutEffect(() => {
    const m = motion.current!;
    const now = performance.now();
    if (via && (target === 'waiting' || target === 'failed') && m.state !== target && m.live !== via) m.set(via, now);
    m.set(target, now);
  }, [target, via]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced || still) {
      paintKnot(el, knotStill(target, via));
      return;
    }
    const m = motion.current!;
    paintKnot(el, m.pose(performance.now()));
  }, [reduced, still, target, via]);

  useEffect(() => {
    const el = ref.current;
    const m = motion.current!;
    if (!el || reduced || still || !onscreen || !visible || !m.moving(performance.now())) return;
    let stop: (() => void) | null = onFrame((now) => {
      paintKnot(el, m.pose(now));
      if (!m.moving(now)) {
        stop?.();
        stop = null;
      }
    });
    return () => stop?.();
  }, [reduced, still, onscreen, visible, target]);

  return <KnotSvg ref={ref} size={s} tone={target} mono={mono} label={label} className={className} />;
}
