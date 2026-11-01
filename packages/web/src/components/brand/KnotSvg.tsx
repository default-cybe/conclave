import { useLayoutEffect, type CSSProperties, type Ref, type RefObject } from 'react';
import { cn } from '@/lib/text';
import { KNOT_BOX, KNOT_HALOS, KNOT_PIECES, KNOT_STROKE } from './knotGeometry';
import { knotDash, type KnotPose, type KnotState } from '../motion/knotMath';
import { surfaceOf, useColorVersion } from '../motion/frame';

/*
 * The knot in SVG (docs/design/brand/README.md), shared by the Mark (still)
 * and the Knot (its light moves). Six pieces from knotGeometry.ts in five
 * layers: the under pieces, the light on them, the halos (strokes in the
 * color behind the mark, around each crossing), the over pieces, the light
 * on them. So the light passes under a strand where the strand does.
 *
 * Colors are CSS (styles/motion.css, .cv-knot) by data-state: the base, the
 * light and the halo (--k-halo, the surface behind). The light's place is
 * dashes on its pieces (pathLength is each piece's share of the 100 long
 * path). The rope motions to come (tie, run, untie: a rope sliding along
 * the knot's path) are the same thing for the base: a span drawn as dashes
 * on these pieces.
 */

const UNDERS = [0, 2, 4];
const OVERS = [1, 3, 5];

export type KnotTone = 'brand' | KnotState;

/** Stroke and halo widths in box units for a knot drawn at s px: heavier at 32px and under. */
export const knotWidths = (s: number) => (s <= KNOT_STROKE.smallUpTo ? { w: KNOT_STROKE.smallWidth, h: KNOT_STROKE.smallHalo } : { w: KNOT_STROKE.width, h: KNOT_STROKE.halo });

/** Puts the pose's light on a drawn knot: the Knot calls it on every frame it moves. */
export function paintKnot(svg: SVGSVGElement, pose: KnotPose) {
  svg.style.setProperty('--k-lit', String(Math.round(pose.light * 1000) / 1000));
  for (const el of svg.querySelectorAll<SVGPathElement>('.k-lt')) {
    const d = knotDash(KNOT_PIECES[Number(el.dataset.i)], pose);
    if (!d) {
      el.setAttribute('visibility', 'hidden');
      continue;
    }
    el.removeAttribute('visibility');
    el.setAttribute('stroke-dasharray', d.array);
    el.setAttribute('stroke-dashoffset', String(d.offset));
  }
}

/**
 * Sets the halo color: `surface` when given (any CSS color), else the color
 * painted behind the mark, read again when the theme changes.
 */
export function useKnotSurface(ref: RefObject<SVGSVGElement | null>, surface?: string) {
  const colorV = useColorVersion();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (surface) {
      el.style.setProperty('--k-halo', surface);
      return;
    }
    const [r, g, b] = surfaceOf(el.parentElement);
    el.style.setProperty('--k-halo', `rgb(${r} ${g} ${b})`);
  }, [ref, surface, colorV]);
}

export interface KnotSvgProps {
  ref?: Ref<SVGSVGElement>;
  /** Box in px (square). */
  size: number;
  tone: KnotTone;
  /** A still light. Without it the caller paints the light (paintKnot) before the first frame. */
  pose?: KnotPose;
  /** Everything in currentColor (dim states draw the base at 30%). */
  mono?: boolean;
  label?: string;
  className?: string;
}

export function KnotSvg({ ref, size, tone, pose, mono, label, className }: KnotSvgProps) {
  const { w, h } = knotWidths(size);
  const base = (i: number) => <path key={i} className="k-base" d={KNOT_PIECES[i].d} />;
  const light = (i: number) => {
    const p = KNOT_PIECES[i];
    const d = pose && knotDash(p, pose);
    const still = pose ? (d ? { strokeDasharray: d.array, strokeDashoffset: d.offset } : { visibility: 'hidden' as const }) : {};
    return <path key={`l${i}`} className="k-lt" data-i={i} d={p.d} pathLength={p.length} {...still} />;
  };
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${KNOT_BOX} ${KNOT_BOX}`}
      width={size}
      height={size}
      className={cn('cv-knot', className)}
      data-state={tone}
      data-mono={mono ? '' : undefined}
      style={pose ? ({ '--k-lit': pose.light } as CSSProperties) : undefined}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <g fill="none" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
        {UNDERS.map(base)}
        {UNDERS.map(light)}
        <g className="k-halo" strokeWidth={h} strokeLinecap="butt">
          {KNOT_HALOS.map((x) => (
            <path key={x.over} d={x.d} />
          ))}
        </g>
        {/* flat ends: the under pieces' round ends fill the joins below, and a round end here would ring a lit join */}
        <g strokeLinecap="butt">{OVERS.map(base)}</g>
        {OVERS.map(light)}
      </g>
    </svg>
  );
}
