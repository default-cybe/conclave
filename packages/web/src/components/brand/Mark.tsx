import { useRef } from 'react';
import { cn } from '@/lib/text';
import { knotBrand } from '../motion/knotMath';
import { KnotSvg, useKnotSurface } from './KnotSvg';

/** The knot's box next to text: this many times the height the old wave mark had, so it keeps its weight. */
const BOX_PER_HEIGHT = 1.5;

/**
 * The Conclave mark (spec 9.6, docs/design/brand/README.md): the trefoil
 * knot as a ribbon with real crossings, in the foreground color, with one
 * violet light at home on its right lobe. Square. `size` is the box in px;
 * `height` (the old wave mark's height) still works and gives a box 1.5
 * times it. `mono` draws it all in currentColor, for one color contexts.
 * The halos at the crossings take the color behind it, or `surface`.
 */
export function Mark({ size, height = 14, mono, className, label, surface }: { size?: number; height?: number; mono?: boolean; className?: string; label?: string; surface?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useKnotSurface(ref, surface);
  return <KnotSvg ref={ref} size={size ?? Math.round(height * BOX_PER_HEIGHT)} tone="brand" pose={knotBrand()} mono={mono} label={label} className={cn('shrink-0', className)} />;
}

/**
 * Mark plus the "Conclave" wordmark: Mona Sans 600, width 110%; 14px in the
 * sidebar's header with a 20px knot 8px before it.
 */
export function Brand({ size = 15, className, mark = true }: { size?: number; className?: string; mark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap text-fg', className)} style={{ gap: Math.round(size * 0.6) }}>
      {mark && <Mark size={Math.round(size * 1.4)} />}
      <span style={{ fontSize: size, fontWeight: 600, fontStretch: '110%', letterSpacing: '-0.01em', lineHeight: 1 }}>Conclave</span>
    </span>
  );
}
