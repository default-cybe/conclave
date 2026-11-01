import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/text';
import { ROPE, ROPE_HALOS, ROPE_PATHS } from '../brand/knotGeometry';
import { knotWidths, useKnotSurface } from '../brand/KnotSvg';
import { onFrame } from './frame';
import { ropeCamera, ropeCaps, ropeDash, ropeDuration, ropeHead, ropeLap, ropePoint, ropePose, ropeRest, ropeRing, ropeSpan, type RopeMoment, type RopePose } from './knotMath';
import { useOnscreen, usePageVisible, useReducedMotion } from './useReducedMotion';

/**
 * The knot as a rope that ties itself (docs/design/KNOT-MOTION.md). One
 * rope slides along its own path, over and under at each crossing; nothing
 * morphs. Every frame comes from the rope math in knotMath.ts, on the
 * shared frame loop.
 *
 * launch      a straight rope, its tip lit, ties itself; cinch; one light lap (cold start)
 * launchLong  the same, slower, then the word fades in (the first run, before Connect)
 * run         a short piece with a light at its head runs the dim knot (waiting on the hub)
 * success     the light runs two laps from home and slows into place; cinch (paired, back online)
 * receive     a rope slides in from the right and ties; cinch; one lap (a friend's share arrives)
 * send        the rope pulls out through the knot to the left, the light leading (sent to a friend)
 *
 * launch, receive and send draw a view twice as wide as the knot's box, so
 * the rope has room; the view clips it. Run and success are the knot's box.
 * Every moment but run plays once and calls onDone. Reduced motion draws
 * the tied knot with the light at rest and calls onDone at once.
 */
export interface KnotRopeProps {
  moment: RopeMoment;
  /** The knot's box in px when tied (square). launch, receive and send are twice as wide. */
  size?: number;
  /** Called once when the moment has played (never for run). */
  onDone?: () => void;
  /** Called once when a tie is done (launch, receive), before the cinch and the lap. */
  onTied?: () => void;
  /** The color behind the mark, when it is not the nearest background (the halos at the crossings take it). */
  surface?: string;
  /** launchLong: the word that fades in under the knot ("Conclave"). */
  word?: string;
  /** Draw this frame (ms into the moment) and hold it: a scrubber, a still. */
  at?: number;
  /** Accessible name. Without it the rope is decorative (aria-hidden). */
  label?: string;
  className?: string;
}

type Kind = 'dim' | 'base' | 'trail' | 'head' | 'lap' | 'run';

const ids = (k: 'under' | 'over') => ROPE_PATHS.flatMap((p, i) => (p.kind === k ? [i] : []));
const UNDER = ids('under');
const OVER = ids('over');
const IN = ROPE_PATHS.findIndex((p) => p.id === 'in');
const OUT = ROPE_PATHS.findIndex((p) => p.id === 'out');

/** Where k6 meets k0: the rope's start, the bottom of the right lobe. */
const ROPE_JOIN = ropePoint(ROPE.knot);

const wideOf = (m: RopeMoment) => m !== 'run' && m !== 'success';
const cameraOf = (m: RopeMoment) => m === 'launch' || m === 'launchLong';

/** The path elements a moment needs, in drawing order (docs/design/KNOT-MOTION.md 2). */
function layers(m: RopeMoment): { under: Kind[]; over: Kind[]; leadIn: boolean; leadOut: boolean } {
  const lights: Kind[] = m === 'run' ? ['run', 'lap'] : m === 'success' ? ['trail', 'lap'] : ['head', 'lap'];
  return {
    under: [...(m === 'run' ? (['dim'] as Kind[]) : []), 'base', ...lights],
    over: [...(m === 'run' ? (['dim'] as Kind[]) : []), 'base', ...lights],
    leadIn: wideOf(m),
    leadOut: m === 'receive' || m === 'send',
  };
}

interface Els {
  paths: Array<{ el: SVGPathElement; kind: Kind; i: number }>;
  halos: Array<{ el: SVGPathElement; i: number }>;
  caps: SVGCircleElement[];
  camera: SVGGElement | null;
  cinch: SVGGElement | null;
  fade: SVGGElement | null;
  word: HTMLElement | null;
}

const one = (x: [number, number] | null): Array<[number, number]> => (x ? [x] : []);

function dash(el: Element, parts: Array<[number, number]>, length: number) {
  const d = ropeDash(parts, length);
  if (!d) {
    el.setAttribute('visibility', 'hidden');
    return;
  }
  el.removeAttribute('visibility');
  // all of it: no dashes, so it draws exactly as the still mark does
  if (parts.length === 1 && parts[0][0] <= 1e-3 && parts[0][1] >= length - 1e-3) {
    el.removeAttribute('stroke-dasharray');
    el.removeAttribute('stroke-dashoffset');
    return;
  }
  el.setAttribute('stroke-dasharray', d.array);
  el.setAttribute('stroke-dashoffset', String(d.offset));
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Puts a pose on a drawn rope. */
function paintRope(els: Els, m: RopeMoment, pose: RopePose, view: { vw: number; vh: number; stroke: number; t: number }) {
  const R = ROPE;
  for (const { el, kind, i } of els.paths) {
    const p = ROPE_PATHS[i];
    if (kind === 'base') dash(el, pose.light === 'run' ? ropeRing(p, pose.run, pose.run + R.run.length) : one(ropeSpan(p, pose.w, pose.w + 100)), p.length);
    // the dim over strands lie above the under base: they go only where the base does not, so no join shows a seam
    else if (kind === 'dim') dash(el, pose.light === 'run' ? ropeRing(p, pose.run + R.run.length, pose.run + 100) : [], p.length);
    else if (kind === 'head') dash(el, pose.light === 'head' ? one(ropeSpan(p, ...ropeHead(pose.w))) : [], p.length);
    else if (kind === 'lap') dash(el, pose.light === 'lap' ? ropeRing(p, ...ropeLap(pose.lap)) : [], p.length);
    else if (kind === 'run') dash(el, pose.light === 'run' ? ropeRing(p, pose.run + R.run.length - R.run.light, pose.run + R.run.length) : [], p.length);
    else if (kind === 'trail') {
      const a = pose.lap - R.success.trail.back;
      dash(el, pose.trail > 0 ? ropeRing(p, a, a + R.success.trail.length) : [], p.length);
      el.style.opacity = String(r3(pose.trail * R.success.trail.opacity));
    }
  }
  for (const { el, i } of els.halos) dash(el, one(ropeSpan(ROPE_HALOS[i], pose.w, pose.w + 100)), ROPE_HALOS[i].length);
  const caps = ropeCaps(pose);
  els.caps.forEach((c, k) => {
    if (k >= caps.length) {
      c.setAttribute('visibility', 'hidden');
      return;
    }
    const [x, y] = ropePoint(caps[k]);
    c.removeAttribute('visibility');
    c.setAttribute('cx', String(r3(x)));
    c.setAttribute('cy', String(r3(y)));
  });
  if (els.camera) {
    const tm = m === 'launch' || m === 'launchLong' ? R[m] : null;
    const c = tm ? ropeCamera(tm, view.t, view.vw, view.vh, view.stroke) : { s: 1, x: 32, y: 32 };
    els.camera.setAttribute('transform', `translate(${view.vw / 2} ${view.vh / 2}) scale(${r3(c.s)}) translate(${r3(-c.x)} ${r3(-c.y)})`);
  }
  els.cinch?.setAttribute('transform', pose.cinch === 1 ? '' : `translate(32 32) scale(${r3(pose.cinch)}) translate(-32 -32)`);
  els.fade?.setAttribute('opacity', String(r3(pose.fade)));
  if (els.word) {
    els.word.style.opacity = String(r3(pose.word));
    els.word.style.transform = `translateY(${r3((1 - pose.word) * R.word.rise)}px)`;
  }
}

/**
 * A knot that waits with you and then says it worked: run() while waiting
 * on the hub, `await succeed()` before moving on (it resolves when success
 * has played, at once under reduced motion), clear() on a failure. Draw
 * `moment` with a KnotRope and pass it `onDone`.
 */
export function useRopeMoment() {
  const [moment, setMoment] = useState<'run' | 'success' | null>(null);
  const settle = useRef<(() => void) | null>(null);
  const done = () => {
    settle.current?.();
    settle.current = null;
  };
  return {
    moment,
    run: () => setMoment('run'),
    clear: () => {
      done();
      setMoment(null);
    },
    succeed: () =>
      new Promise<void>((resolve) => {
        settle.current = resolve;
        // a tab in the background draws no frames: never wait longer than the moment
        setTimeout(resolve, ropeDuration('success') + 1000);
        setMoment('success');
      }),
    onDone: done,
  };
}

export function KnotRope({ moment, size = 64, onDone, onTied, surface, word, at, label, className }: KnotRopeProps) {
  const ref = useRef<SVGSVGElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  const onscreen = useOnscreen(ref);
  const visible = usePageVisible();
  // a held frame wins over a frame the loop draws before its effect is cleaned up
  const held = useRef(at);
  held.current = at;
  const done = useRef({ done: onDone, tied: onTied });
  done.current = { done: onDone, tied: onTied };
  useKnotSurface(ref, surface);

  const wide = wideOf(moment);
  const { w, h } = knotWidths(size);
  const vw = wide ? 128 : 64;
  const vh = 64;
  const viewX = moment === 'receive' || moment === 'send' ? -32 : 0;
  const L = layers(moment);

  const els = useRef<Els | null>(null);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    els.current = {
      paths: [...svg.querySelectorAll<SVGPathElement>('[data-k]')].map((el) => ({ el, kind: el.dataset.k as Kind, i: Number(el.dataset.i) })),
      halos: [...svg.querySelectorAll<SVGPathElement>('[data-halo]')].map((el) => ({ el, i: Number(el.dataset.halo) })),
      caps: [...svg.querySelectorAll<SVGCircleElement>('[data-cap]')],
      camera: cameraOf(moment) ? svg.querySelector<SVGGElement>('[data-camera]') : null,
      cinch: svg.querySelector<SVGGElement>('[data-cinch]'),
      fade: svg.querySelector<SVGGElement>('[data-fade]'),
      word: wordRef.current,
    };
  }, [moment, word]);

  // the clock: from the first frame after the moment starts; each moment ties and ends once
  const start = useRef<number | null>(null);
  const played = useRef({ tied: false, done: false });
  useLayoutEffect(() => {
    start.current = null;
    played.current = { tied: false, done: false };
  }, [moment]);

  useLayoutEffect(() => {
    const e = els.current;
    if (!e) return;
    const view = { vw, vh, stroke: w, t: 0 };
    if (reduced) {
      paintRope(e, moment, { ...ropeRest(), word: word ? 1 : 0 }, { ...view, t: Infinity });
      return;
    }
    if (at !== undefined) {
      paintRope(e, moment, ropePose(moment, at), { ...view, t: at });
      return;
    }
    const t = start.current === null ? 0 : performance.now() - start.current;
    paintRope(e, moment, ropePose(moment, t), { ...view, t });
  }, [moment, reduced, at, vw, vh, w, word]);

  // reduced motion: the tied knot at rest, done at once
  useEffect(() => {
    if (!reduced || at !== undefined) return;
    done.current.tied?.();
    done.current.done?.();
  }, [reduced, moment, at]);

  useEffect(() => {
    const e = els.current;
    const p = played.current;
    if (!e || reduced || at !== undefined || p.done) return;
    // run loops: only while it shows. The others play once, through to the end.
    if (moment === 'run' && (!onscreen || !visible)) return;
    const total = ropeDuration(moment);
    const times = moment === 'run' || moment === 'success' ? null : ROPE[moment];
    const tiedAt = times && times.to === ROPE.knot ? times.straight + times.move : Infinity;
    let stop: (() => void) | null = onFrame((now) => {
      if (held.current !== undefined) return;
      if (start.current === null) start.current = now;
      const t = now - start.current;
      const end = t >= total;
      paintRope(e, moment, ropePose(moment, end ? total : t), { vw, vh, stroke: w, t: end ? total : t });
      if (!p.tied && t >= tiedAt) {
        p.tied = true;
        done.current.tied?.();
      }
      if (end) {
        stop?.();
        stop = null;
        p.done = true;
        done.current.done?.();
      }
    });
    return () => stop?.();
  }, [moment, reduced, at, onscreen, visible, vw, vh, w]);

  const path = (i: number, kind: Kind) => {
    const p = ROPE_PATHS[i];
    const cls = kind === 'dim' ? 'r-dim' : kind === 'base' ? 'r-base' : kind === 'trail' ? 'r-trail' : 'r-lt';
    // the over paths' base and the dim knot's over paths end flat, as the still mark: the under ends fill the joins below
    const flat = (kind === 'base' || kind === 'dim') && p.kind === 'over';
    const still = kind === 'dim' && p.kind === 'under';
    return <path key={`${kind}${i}`} className={cls} data-k={still ? undefined : kind} data-i={i} d={p.d} pathLength={p.length} strokeLinecap={flat ? 'butt' : undefined} visibility={still ? undefined : 'hidden'} />;
  };
  const leadKinds: Kind[] = ['base', 'head'];
  const svg = (
    <svg
      ref={ref}
      viewBox={`${viewX} 0 ${vw} ${vh}`}
      width={wide ? size * 2 : size}
      height={size}
      className={cn('cv-rope', !word && className)}
      data-moment={moment}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <g data-fade>
        <g data-camera>
          <g data-cinch>
            <g fill="none" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
              {L.leadIn && leadKinds.map((k) => path(IN, k))}
              {L.under.map((k) => UNDER.map((i) => path(i, k)))}
              <g className="r-halo" strokeWidth={h} strokeLinecap="butt">
                {ROPE_HALOS.map((x, i) => (
                  <path key={i} data-halo={i} d={x.d} pathLength={x.length} />
                ))}
              </g>
              {L.leadOut && leadKinds.map((k) => path(OUT, k))}
              {L.over.flatMap((k) => [
                ...OVER.map((i) => path(i, k)),
                // round dots where the flat over ends need one (ropeCaps); the dim knot's join of k6 and k0
                ...(k === 'base' ? [0, 1, 2].map((c) => <circle key={`cap${c}`} data-cap className="r-cap" r={w / 2} visibility="hidden" />) : []),
                ...(k === 'dim' ? [<circle key="dimjoin" className="r-dim-cap" r={w / 2} cx={ROPE_JOIN[0]} cy={ROPE_JOIN[1]} />] : []),
              ])}
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
  if (!word) return svg;
  return (
    <span className={cn('inline-flex flex-col items-center', className)} style={{ gap: 10 } as CSSProperties}>
      {svg}
      <span ref={wordRef} className="cv-rope-word" style={{ opacity: 0 }}>
        {word}
      </span>
    </span>
  );
}
