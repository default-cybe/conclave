import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/text';
import { EASE, clamp, lerp, seg } from './ease';
import { dprNow, onFrame, rgbaOf, tokenRGB, useColorVersion } from './frame';
import { useReducedMotion } from './useReducedMotion';

// The arrow and the square as nine points each in a 30 x 30 box. The square's points sit on its
// edges in an order that lets the notches under the arrow's wings close without crossing.
const ARROW: Array<[number, number]> = [
  [15, 7.6],
  [20.4, 13],
  [19.1, 14.3],
  [16, 11.3],
  [16, 22],
  [14, 22],
  [14, 11.3],
  [10.9, 14.3],
  [9.6, 13],
];
const SQUARE: Array<[number, number]> = [
  [15, 10.8],
  [19.2, 10.8],
  [19.2, 14.6],
  [19.2, 12.6],
  [19.2, 19.2],
  [10.8, 19.2],
  [10.8, 12.6],
  [10.8, 14.6],
  [10.8, 10.8],
];
const MORPH_MS = 230;
const RING_MS = 460;

/** The glyph at morph m (0 arrow, 1 square), in the 30 x 30 box. It dips a little mid-change so the in-between poses stay small. */
export function sendStopPoints(m: number): Array<[number, number]> {
  const dip = 1 - 0.22 * Math.sin(Math.PI * clamp(m));
  return ARROW.map(([x, y], i) => {
    const px = lerp(x, SQUARE[i][0], m);
    const py = lerp(y, SQUARE[i][1], m);
    return [15 + (px - 15) * dip, 15 + (py - 15) * dip];
  });
}

/**
 * The send arrow that folds into a stop square while a reply runs, and opens
 * back into the arrow at the end (ui.html Send to stop). A small canvas in
 * currentColor; 230ms on --ease-emph. With `ring` (the button's size in px),
 * a thin violet outline draws once round the button, 3px out (460ms), and
 * rests faint while the reply runs; it never turns. Reduced motion: the
 * glyph swaps at once and the outline is still.
 */
export function SendStopIcon({ stop, size = 16, ring, radius = 3, className }: { stop: boolean; size?: number; ring?: number; radius?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const colorV = useColorVersion();
  const st = useRef({ m: stop ? 1 : 0, from: stop ? 1 : 0, at: -1e9, ringAt: stop ? -1e9 : -1, ringFrom: stop ? 1 : 0 });
  // the canvas covers the button and the outline round it when it carries the ring
  const box = ring ? ring + 12 : size;

  useEffect(() => {
    const el = ref.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const s = st.current;
    const now0 = performance.now();
    const target = stop ? 1 : 0;
    if (s.m !== target || s.from !== target) {
      s.from = s.m;
      s.at = now0;
    }
    if (stop) {
      if (s.ringAt < 0 || s.ringFrom === 0) {
        s.ringAt = now0;
        s.ringFrom = 1;
      }
    } else if (s.ringFrom === 1) {
      s.ringFrom = 0;
      s.ringAt = now0;
    }
    const paint = (now: number) => {
      const dpr = dprNow();
      const px = Math.round(box * dpr);
      if (el.width !== px) el.width = el.height = px;
      const k = reduced ? 1 : EASE.emph(seg(now, s.at, s.at + MORPH_MS));
      s.m = lerp(s.from, target, k);
      const color = getComputedStyle(el).color;
      const [r, g, b] = rgbaOf(color);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, px, px);
      // the glyph: drawn in the 30 box; the arrow is about 0.8 of `size` tall
      const unit = (size / 18) * dpr;
      ctx.setTransform(unit, 0, 0, unit, px / 2 - 15 * unit, px / 2 - 15 * unit);
      const pts = sendStopPoints(s.m);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 1.6;
      ctx.fill();
      ctx.stroke();
      if (ring) {
        const sig = tokenRGB(el, '--signal');
        const c = (al: number) => `rgba(${sig[0]},${sig[1]},${sig[2]},${al})`;
        ctx.setTransform(dpr, 0, 0, dpr, px / 2, px / 2);
        const half = ring / 2 + 3;
        const r = radius + 3;
        // the outline, traced clockwise from the middle of the top edge
        const trace = () => {
          ctx.beginPath();
          ctx.moveTo(0, -half);
          ctx.arcTo(half, -half, half, half, r);
          ctx.arcTo(half, half, -half, half, r);
          ctx.arcTo(-half, half, -half, -half, r);
          ctx.arcTo(-half, -half, half, -half, r);
          ctx.closePath();
        };
        const len = 8 * half - 2 * r * (4 - Math.PI);
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        if (reduced) {
          if (stop) {
            ctx.strokeStyle = c(0.28);
            trace();
            ctx.stroke();
          }
        } else if (s.ringFrom === 1) {
          const d = EASE.std(seg(now, s.ringAt + 60, s.ringAt + 60 + RING_MS));
          const rest = EASE.out(seg(now, s.ringAt + 60 + RING_MS, s.ringAt + 60 + RING_MS + 600));
          ctx.strokeStyle = c(0.28 * d);
          trace();
          ctx.stroke();
          if (d > 0 && rest < 1) {
            ctx.strokeStyle = c(0.95 * (1 - rest));
            ctx.setLineDash([len * d, len]);
            trace();
            ctx.stroke();
            ctx.setLineDash([]);
          }
        } else {
          const out = 1 - EASE.in(seg(now, s.ringAt, s.ringAt + 200));
          if (out > 0) {
            ctx.strokeStyle = c(0.28 * out);
            trace();
            ctx.stroke();
          }
        }
      }
    };
    paint(now0);
    if (reduced) return;
    // run through the morph, the ring, and the button's own 120ms color change
    const until = now0 + Math.max(MORPH_MS, 300, ring ? 60 + RING_MS + 650 : 0);
    let stopLoop: (() => void) | null = onFrame((now) => {
      paint(now);
      if (now > until) {
        stopLoop?.();
        stopLoop = null;
      }
    });
    return () => stopLoop?.();
  }, [stop, size, ring, radius, reduced, colorV, box]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn('cv-sendstop', ring && 'cv-sendstop-ring', className)}
      style={{ width: box, height: box, margin: ring ? -(box - size) / 2 : undefined }}
    />
  );
}

export interface SendStopButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** A reply runs and the box is empty: the button is Stop. */
  running: boolean;
  /** There is something to send: the button is solid. */
  ready: boolean;
  /** Glyph size in px. 16 on desktop (30px button), 18 on phones (44px). */
  size?: number;
  /** Draw a violet outline once round the button while the reply runs. */
  ring?: boolean;
  /** The words for send, "Send" by default. Stop reads "Stop". */
  sendLabel?: string;
  /** ink: the solid button (neutral). accent: violet when there is something to send or to stop, an fg-4 outline when empty (phones). */
  tone?: 'ink' | 'accent';
}

/**
 * The composer's Send button with the fold into Stop. Solid while there is
 * something to send or a reply runs, quiet otherwise. It keeps its own
 * size, so nothing around it moves. The parent decides what a click does.
 */
export const SendStopButton = forwardRef<HTMLButtonElement, SendStopButtonProps>(function SendStopButton(
  { running, ready, size = 16, ring, sendLabel = 'Send', tone = 'ink', className, ...rest },
  ref,
) {
  const solid = running || ready;
  const own = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => own.current!);
  const [box, setBox] = useState(0);
  const [rad, setRad] = useState(3);
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || !ring) return;
    setBox(el.offsetWidth);
    setRad(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
  }, [ring]);
  return (
    <button
      ref={own}
      type="button"
      aria-label={running ? 'Stop' : sendLabel}
      aria-disabled={!solid || undefined}
      {...rest}
      className={cn(
        'cv-sendstop-btn grid shrink-0 place-items-center rounded-[var(--r-1)] border transition-[color,background-color,border-color,filter] duration-[var(--dur-1)]',
        tone === 'accent'
          ? solid
            ? 'border-signal bg-signal text-bg hov:brightness-[0.94]'
            : 'border-fg-4 bg-transparent text-fg-4'
          : solid
            ? 'border-solid bg-solid text-solid-fg hov:brightness-[0.94]'
            : 'border-rule bg-hover text-fg-4',
        className,
      )}
    >
      <SendStopIcon stop={running} size={size} ring={ring && box ? box : undefined} radius={rad} />
    </button>
  );
});
