import { useRef } from 'react';
import { cn } from '@/lib/text';
import { GLYPH_MOTION, GLYPH_PATHS, glyphKind, type GlyphKind, type GlyphState } from './agentGlyphs';
import { useOnscreen, usePageVisible, useReducedMotion } from './useReducedMotion';

/**
 * What kind of agent works, in one stroke on a 16 grid (docs/design/
 * CHAT-AND-MOTION.md 1.11). Running, a violet light travels the stroke
 * (--loop-knot-tool); done, the stroke is fg-3 and still; failed, the light
 * stops in --fault; waiting, it holds in amber. It takes the slot the still
 * Knot had in a row, so it is a mark, not an icon. In a list only the first
 * three running rows move (`still` on the rest, stillRows()).
 */
export interface AgentGlyphProps {
  /** An agent type ("explore", "web-searcher"); unknown types draw general-purpose. */
  type?: GlyphKind | string;
  state?: GlyphState;
  /** Box size in px (square). */
  size?: number;
  still?: boolean;
  label?: string;
  className?: string;
}

export function AgentGlyph({ type, state = 'running', size = 14, still, label, className }: AgentGlyphProps) {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const onscreen = useOnscreen(ref);
  const visible = usePageVisible();
  const kind = glyphKind(type);
  const d = GLYPH_PATHS[kind];
  return (
    <svg
      ref={ref}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn('cv-glyph', className)}
      data-kind={kind}
      data-state={state}
      data-motion={GLYPH_MOTION[kind]}
      data-still={reduced || still ? '' : undefined}
      data-paused={!onscreen || !visible ? '' : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path className="g-base" d={d} />
      {state !== 'done' && <path className="g-light" d={d} pathLength={100} />}
    </svg>
  );
}
