import { useRef, type CSSProperties } from 'react';
import { cn } from '@/lib/text';
import { PET_BODY, PET_CURL, PET_EYES, PET_EYE_Y, PET_SHOULDER, type PetState } from './agentGlyphs';
import { useOnscreen, usePageVisible, useReducedMotion } from './useReducedMotion';

/**
 * The pet (docs/design/CHAT-AND-MOTION.md 1.11): a soft dome with a curl of
 * the Knot's rope on top, two dot eyes, a mouth, one stubby arm for a prop,
 * sitting on its own shadow. The face and posture say the state; the prop
 * says the job. CSS and SVG only (styles/pet.css): breath, blink and each
 * state's loop are keyframes, so nothing runs in JS. Never in a chat reply;
 * the Knot owns that space.
 *
 * idle         breath, a smile and a blink (a double one every third)
 * thinking     eyes up and right, lips pursed; the violet light laps the body
 * researching  a magnifier sweeps, the eyes follow it
 * building     a hammer taps; a block stacks per tap, up to 3
 * testing      3 ticks draw one after another, in --ok; eyes on them
 * reviewing    round glasses; the eyes scan inside them
 * waiting      eyes up, mouth open, an amber hand waves
 * parked       asleep: eyes shut, slumped, the curl droops, 3 z's
 * done         a hop, ^^ eyes, a wide smile, two --ok sparkles pop
 * failed       a droop, sad brows, a --fault frown, a sweat drop
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

const [SX, SY] = PET_SHOULDER;
const Y = PET_EYE_Y;
const both = (f: (x: number) => string) => PET_EYES.map(f).join('');

function Eyes({ state }: { state: PetState }) {
  // shut, happy and sad eyes are strokes; the rest are dots with a highlight
  if (state === 'parked') return <path className="p-face" d={both((x) => `M${x - 1.4} ${Y}Q${x} ${Y + 1.2} ${x + 1.4} ${Y}`)} />;
  if (state === 'done') return <path className="p-face" d={both((x) => `M${x - 1.4} ${Y + 0.7}L${x} ${Y - 0.8}L${x + 1.4} ${Y + 0.7}`)} />;
  return (
    <g className="p-look">
      <g className="p-blink">
        {PET_EYES.map((x) => (
          <g key={x}>
            <circle className="p-eye" cx={x} cy={Y} r={1.45} />
            <circle className="p-glint" cx={x + 0.5} cy={Y - 0.55} r={0.45} />
          </g>
        ))}
      </g>
    </g>
  );
}

const MOUTH: Partial<Record<PetState, string>> = {
  idle: 'M13 15.7Q14 16.6 15 15.7',
  thinking: 'M13.5 16.1H14.5',
  researching: 'M13.2 15.9Q14 16.4 14.8 15.9',
  building: 'M13.1 16H14.9',
  testing: 'M13.2 15.9Q14 16.4 14.8 15.9',
  reviewing: 'M13.3 16.1H14.7',
  parked: 'M13.6 16.2H14.4',
  done: 'M12.3 15.4Q14 17.6 15.7 15.4',
  failed: 'M12.7 16.9Q14 15.7 15.3 16.9',
};

function Mouth({ state }: { state: PetState }) {
  if (state === 'waiting') return <circle className="p-face" cx={14} cy={16.2} r={0.75} />;
  return <path className={cn('p-face', state === 'failed' && 'p-fault')} d={MOUTH[state]} />;
}

function Prop({ state }: { state: PetState }) {
  switch (state) {
    case 'researching':
      return (
        <g className="p-swing">
          <path d={`M${SX} ${SY}L25.7 12.3`} />
          <circle className="p-thin" cx={27.5} cy={10.4} r={2.3} />
        </g>
      );
    case 'building':
      return (
        <>
          <g className="p-swing">
            <path d={`M${SX} ${SY}L26.2 11.6`} />
            <path className="p-thin" d="M25 10.3L27.6 12.9" />
          </g>
          {[17.8, 15, 12.2].map((y, i) => (
            <rect key={y} className="p-block" style={{ '--i': i } as CSSProperties} x={27.5} y={y} width={2.6} height={2.6} rx={0.4} />
          ))}
        </>
      );
    case 'testing':
      return (
        <>
          {[5.5, 10, 14.5].map((y, i) => (
            <path key={y} className="p-tick" pathLength={1} style={{ '--i': i } as CSSProperties} d={`M26.6 ${y}l1.2 1.2 2.3-2.7`} />
          ))}
        </>
      );
    case 'reviewing':
      return <path className="p-thin" d={`${both((x) => `M${x + 2.5} ${Y}A2.5 2.5 0 1 1 ${x - 2.5} ${Y}A2.5 2.5 0 1 1 ${x + 2.5} ${Y}`)}M13.5 ${Y}Q14 ${Y - 0.6} 14.5 ${Y}`} />;
    case 'waiting':
      return (
        <g className="p-swing p-warn">
          <path d={`M${SX} ${SY}C25.2 13.4 26.3 11 26.2 8.2`} />
          <circle className="p-hand" cx={26.2} cy={7} r={1.1} />
        </g>
      );
    case 'parked':
      return (
        <>
          {[
            [25, 7.5],
            [27.2, 4.4],
            [29.4, 1.3],
          ].map(([x, y], i) => (
            <path key={x} className="p-z" style={{ '--i': i } as CSSProperties} d={`M${x} ${y}h1.8l-1.8 1.8h1.8`} />
          ))}
        </>
      );
    case 'done':
      return (
        <>
          {[
            [27.4, 5.6, 2],
            [4.4, 4.4, 1.4],
          ].map(([x, y, r], i) => (
            <path key={x} className="p-spark" style={{ '--i': i, transformOrigin: `${x}px ${y}px` } as CSSProperties} d={`M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`} />
          ))}
        </>
      );
    case 'failed':
      return (
        <>
          <path className="p-thin p-fault" d={`M8.9 ${Y - 2.4}L12.3 ${Y - 3.3}M19.1 ${Y - 2.4}L15.7 ${Y - 3.3}`} />
          <path className="p-drop" d="M25.6 6.2C24.9 7.3 24.6 7.9 24.6 8.4A1 1 0 0 0 26.6 8.4C26.6 7.9 26.3 7.3 25.6 6.2Z" />
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
      <path className="p-shadow" d="M6.5 23H21.5" />
      <g className="p-all">
        <g className="p-body">
          <path className="p-curl" d={PET_CURL} />
          <path className="p-loop" d={PET_BODY} />
          {state === 'thinking' && <path className="p-light" d={PET_BODY} pathLength={100} />}
          <path className="p-feet" d="M9.2 21.7H11.4M16.6 21.7H18.8" />
          <Eyes state={state} />
          <Mouth state={state} />
        </g>
        <Prop state={state} />
      </g>
    </svg>
  );
}
