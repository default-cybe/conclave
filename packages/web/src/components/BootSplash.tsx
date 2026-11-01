/**
 * The launch on a cold start (docs/design/KNOT-MOTION.md 3): a straight rope
 * ties itself into the knot over the app's ground, once per start of the
 * app (web, the desktop app, the iPhone app). A tap or a key skips it.
 * When the app is ready sooner, the rope still finishes its tie, then the
 * splash fades into the app; where the app shows the mark as a hero (Home,
 * a new chat), the tied knot flies into it, so one knot is ever on screen.
 * When the app is not ready by the end, the knot runs (waiting on the hub)
 * until it is. The first run before Connect plays the long launch with the
 * name.
 */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/text';
import { ROPE } from './brand/knotGeometry';
import { DUR, KnotRope, useReducedMotion } from './motion';

const LONG_SEEN = 'conclave.launch.long';
/** The flight into the hero mark. */
const FLY_MS = 520;
const FLY_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

let started = false;
let showing = false;

/** The launch to play on this cold start: the long one on the first run before Connect, else the short one; null once played. */
export function bootLaunch(firstRun: boolean): 'launch' | 'launchLong' | null {
  if (started) return null;
  started = true;
  if (!firstRun) return 'launch';
  try {
    return localStorage.getItem(LONG_SEEN) ? 'launch' : 'launchLong';
  } catch {
    return 'launchLong';
  }
}

/** True while the launch is on screen: a hero mounted under it starts as the still mark (the launch tied it already). */
export const bootSplashShowing = () => showing;

/** The knot's box for the launch: as big as fits twice across the screen, at most 200. */
const boxFor = (width: number) => Math.round(Math.max(120, Math.min(200, (width - 48) / 2)));

/** The hero mark on screen, if there is one: an svg inside [data-hero-mark], fully in view. */
function heroMark(): SVGSVGElement | null {
  const el = document.querySelector<SVGSVGElement>('[data-hero-mark] svg');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight ? el : null;
}

export function BootSplash({ moment, ready, onGone }: { moment: 'launch' | 'launchLong'; ready: boolean; onGone: () => void }) {
  const reduced = useReducedMotion();
  const [tied, setTied] = useState(false);
  const [played, setPlayed] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [leaving, setLeaving] = useState<false | 'fade' | 'fly'>(false);
  const [size] = useState(() => boxFor(typeof window === 'undefined' ? 800 : window.innerWidth));
  const knot = useRef<HTMLDivElement>(null);
  const gone = useRef(onGone);
  gone.current = onGone;

  useEffect(() => {
    showing = true;
    return () => {
      showing = false;
    };
  }, []);

  const long = moment === 'launchLong';
  // played through and still waiting on the hub: the knot runs where it was tied
  const running = (played || skipped) && !ready;

  // ready and tied (the long launch: ready and played through, so the name shows): into the app
  const out = ready && (skipped || (long ? played : tied));
  useEffect(() => {
    if (!out || leaving) return;
    setLeaving(!long && !skipped && !reduced && heroMark() ? 'fly' : 'fade');
    if (long && played) {
      try {
        localStorage.setItem(LONG_SEEN, '1');
      } catch {
        // private mode: it plays again next time
      }
    }
  }, [out, leaving, long, played, skipped, reduced]);

  useEffect(() => {
    if (!leaving) return;
    const hero = leaving === 'fly' ? heroMark() : null;
    const from = knot.current?.querySelector('svg')?.getBoundingClientRect();
    if (hero && from && knot.current) {
      // the tied knot is the launch view's middle square; it moves onto the hero and becomes it
      const box = { x: from.left + (from.width - from.height) / 2, y: from.top, s: from.height };
      const to = hero.getBoundingClientRect();
      const wrap = knot.current.getBoundingClientRect();
      knot.current.style.transformOrigin = `${box.x + box.s / 2 - wrap.left}px ${box.y + box.s / 2 - wrap.top}px`;
      const dx = to.left + to.width / 2 - (box.x + box.s / 2);
      const dy = to.top + to.height / 2 - (box.y + box.s / 2);
      hero.style.visibility = 'hidden';
      const flight = knot.current.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${to.height / box.s})` }], { duration: FLY_MS, easing: FLY_EASE, fill: 'forwards' });
      const land = () => {
        hero.style.visibility = '';
        gone.current();
      };
      flight.finished.then(land, land);
      return () => {
        flight.cancel();
        hero.style.visibility = '';
      };
    }
    const t = setTimeout(() => gone.current(), reduced ? DUR.d1 : DUR.d4);
    return () => clearTimeout(t);
  }, [leaving, reduced]);

  // a key skips it too
  useEffect(() => {
    const skip = () => setSkipped(true);
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
  }, []);

  const fade = { transitionDuration: `${reduced ? DUR.d1 : DUR.d4}ms` };
  // flying, the knot holds its tied pose: the light at home, as the hero has it
  const hold = leaving === 'fly' && !played ? ROPE.launch.straight + ROPE.launch.move : undefined;
  return (
    <div
      className={cn('fixed inset-0 z-[100] grid place-items-center', leaving && 'pointer-events-none', leaving === 'fade' && 'opacity-0 transition-opacity ease-out')}
      style={leaving === 'fade' ? fade : undefined}
      role="status"
      aria-label="Starting Conclave"
      data-boot-splash={moment}
      onPointerDown={() => setSkipped(true)}
    >
      {/* flying, the ground goes as the knot lands, so the knot never crosses the page's words on its way */}
      <div
        className={cn('absolute inset-0 bg-bg transition-opacity', leaving === 'fly' && 'opacity-0')}
        style={leaving === 'fly' ? { transitionDuration: `${FLY_MS}ms`, transitionTimingFunction: 'cubic-bezier(0.5, 0, 1, 1)' } : undefined}
      />
      <div className="relative grid place-items-center [grid-template-areas:'stack'] [&>*]:[grid-area:stack]">
        <div ref={knot} className={cn('transition-opacity', running && 'opacity-0')} style={{ transitionDuration: `${DUR.d4}ms` }}>
          {!skipped && <KnotRope moment={moment} size={size} word={long ? 'Conclave' : undefined} at={hold} onTied={() => setTied(true)} onDone={() => setPlayed(true)} />}
        </div>
        {running && <KnotRope moment="run" size={size} className="anim-fade" />}
      </div>
    </div>
  );
}
