import { useMemo, type CSSProperties } from 'react';
import { cn } from '@/lib/text';
import { useReducedMotion } from './useReducedMotion';

export interface ShimmerProps {
  /** The label, a short state word: "Thinking", "Searching the web". */
  children: string;
  /** While true a dip in brightness passes through the letters every 2.2s. False shows plain text. */
  active?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * A live label. While the work runs, a dip in brightness passes through the
 * letters left to right, the way a packet rides the wave strip; then it rests.
 * Opacity per letter only (no gradient, no clipped background). Screen
 * readers get the plain word once. Reduced motion shows the word still.
 */
export function Shimmer({ children, active = true, className, style }: ShimmerProps) {
  const reduced = useReducedMotion();
  const glyphs = useMemo(() => split(children), [children]);
  if (!active || reduced) return <span className={className} style={style}>{children}</span>;
  return (
    <span className={cn('cv-shimmer whitespace-pre', className)} style={style}>
      <span className="sr-only">{children}</span>
      {glyphs.map((g, i) => (
        <span key={i} aria-hidden style={{ '--i': i } as CSSProperties}>
          {g}
        </span>
      ))}
    </span>
  );
}

/** Graphemes when the browser can tell, characters otherwise. */
function split(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  return Array.from(text);
}
