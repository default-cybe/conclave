import { useRef, type CSSProperties } from 'react';
import { cn } from '@/lib/text';
import { PET_BODY, type PetState } from './agentGlyphs';
import { useOnscreen, usePageVisible, useReducedMotion } from './useReducedMotion';

/**
 * The pet (docs/design/CHAT-AND-MOTION.md 1.11): a squat trefoil bean drawn
 * from the Knot's loop, four legs with knees, two eyes, and one prop per
 * state. CSS and SVG only (styles/pet.css): breath, blink and each state's
 * loop are keyframes, so nothing runs in JS. Never in a chat reply; the Knot
 * owns that space.
 *
 * idle         breath and a blink (a double one every third)
 * thinking     eyes up and right; the violet light runs round the body
 * researching  a magnifier sweeps 4px each way
 * building     one arm taps; a block steps in per tap, up to 3
 * testing      3 ticks draw one after another, in --ok
 * reviewing    2 lens rings; the eyes scan 2px
 * waiting      eyes up at a raised hand, in amber
 * parked       eyes shut; 3 z's fade in one at a time
 * done         one 4px rise and settle; arc eyes
 * failed       the shoulders tilt once; flat eyes in --fault
 *
 * Off screen or in a background tab it pauses; reduced motion (or `still`)
 * draws each state's key pose.
 */
export interface PetProps {
  state?: PetState;
  /** Width in px, 24 to 64 (the height is 3/4 of it). */
  size?: number;
  /** Draw the key pose and never move. */
  still?: boolean;
  /** Accessible name. Without it the pet is decorative; say the state in words next to it. */
  label?: string;
  className?: string;
}

const EYES = [14.3, 17.7];

function Eyes({ state }: { state: PetState }) {
  if (state === 'parked') return <path d={EYES.map((x) => `M${x - 0.9} 5.8H${x + 0.9}`).join('')} />;
  if (state === 'done') return <path d={EYES.map((x) => `M${x - 1} 6Q${x} 4.2 ${x + 1} 6`).join('')} />;
  if (state === 'failed') return <path className="p-fault" d={EYES.map((x) => `M${x - 0.9} 5.5H${x + 0.9}`).join('')} />;
  return (
    <g className="p-look">
      <path className="p-blink" d={EYES.map((x) => `M${x} 4.7V6.3`).join('')} />
    </g>
  );
}

function Prop({ state }: { state: PetState }) {
  switch (state) {
    case 'researching':
      return (
        <g className="p-lens">
          <circle cx="29" cy="5" r="2" />
          <path d="M30.5 6.5L32 8" />
        </g>
      );
    case 'building':
      return (
        <>
          <path className="p-arm" d="M26 11L30 7.5" />
          {[19.5, 16, 12.5].map((y, i) => (
            <rect key={y} className="p-block" style={{ '--i': i } as CSSProperties} x="28.5" y={y} width="3" height="3" />
          ))}
        </>
      );
    case 'testing':
      return (
        <>
          {[4, 9.5, 15].map((y, i) => (
            <path key={y} className="p-tick" pathLength={1} style={{ '--i': i } as CSSProperties} d={`M28.3 ${y}l1.2 1.2 2.3-2.7`} />
          ))}
        </>
      );
    case 'reviewing':
      return <path className="p-rings" d={EYES.map((x) => `M${x + 1.7} 5.5A1.7 1.7 0 1 1 ${x - 1.7} 5.5A1.7 1.7 0 1 1 ${x + 1.7} 5.5`).join('')} />;
    case 'waiting':
      return <path className="p-hand" d="M26 11L28.8 6L28.5 3" />;
    case 'parked':
      return (
        <>
          {[
            [27, 9],
            [28.7, 5.6],
            [30.4, 2.2],
          ].map(([x, y], i) => (
            <path key={x} className="p-z" style={{ '--i': i } as CSSProperties} d={`M${x} ${y}h1.8l-1.8 1.8h1.8`} />
          ))}
        </>
      );
    default:
      return null;
  }
}

export function Pet({ state = 'idle', size = 32, still, label, className }: PetProps) {
  const ref = useRef<SVGSVGElement>(null);
  const reduced = useReducedMotion();
  const onscreen = useOnscreen(ref);
  const visible = usePageVisible();
  const w = Math.round(Math.max(24, Math.min(64, size)));
  return (
    <svg
      ref={ref}
      viewBox="0 0 32 24"
      width={w}
      height={(w * 3) / 4}
      className={cn('cv-pet', className)}
      data-state={state}
      data-still={reduced || still ? '' : undefined}
      data-paused={!onscreen || !visible ? '' : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g className="p-all">
        <path className="p-legs" d="M7 15.5L5 19L4.5 22.5M11 17L10 19.8L10.8 22.5M21 17L22 19.8L21.2 22.5M25 15.5L27 19L27.5 22.5" />
        <g className="p-body">
          <path className="p-loop" d={PET_BODY} />
          {state === 'thinking' && <path className="p-light" d={PET_BODY} pathLength={100} />}
          <Eyes state={state} />
        </g>
        <Prop state={state} />
      </g>
    </svg>
  );
}
