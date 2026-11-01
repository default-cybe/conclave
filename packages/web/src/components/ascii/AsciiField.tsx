import { useEffect, useRef } from 'react';
import { cn } from '@/lib/text';
import { useOnscreen, usePageVisible, useReducedMotion } from '@/components/motion';
import { FPS, Pacer, RAMP, STILL_T, makeScene, renderFrame, type Frame } from './field';

/**
 * The conclave in ASCII (field.ts): decorative, so aria-hidden. Size it with
 * CSS; the grid follows the box. Glyphs in --fg-3, the hub's core and the
 * moving packet in --signal, read from the theme at run time. Runs at 20fps,
 * stops when the tab is hidden or the canvas is off screen, and draws one
 * still frame under reduced motion.
 */
export function AsciiField({
  className,
  align = 'center',
  seed = 7,
  size = 12,
  hub = true,
}: {
  className?: string;
  align?: 'start' | 'center';
  seed?: number;
  /** Font size px. */
  size?: number;
  /** Draw the hub; false when the page sets its mark in the middle. */
  hub?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const onscreen = useOnscreen(ref);
  // the clock lives across effect runs, so a paused field resumes where it stopped
  const clock = useRef(STILL_T);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const font = `${size}px ${getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace'}`;
    let ink = '';
    let hot = '';
    let W = 0;
    let H = 0;
    let cw = 0;
    let ch = 0;
    let scene: ReturnType<typeof makeScene> | undefined;
    let frame: Frame | undefined;

    const colors = () => {
      const cs = getComputedStyle(canvas);
      ink = cs.getPropertyValue('--fg-3').trim() || cs.color;
      hot = cs.getPropertyValue('--signal').trim() || ink;
    };
    const layout = () => {
      const r = canvas.getBoundingClientRect();
      // phones stop at 2x: the glyphs stay sharp and the fill costs less
      const dpr = Math.min(window.devicePixelRatio || 1, matchMedia('(pointer: coarse)').matches ? 2 : 3);
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = font;
      ctx.textBaseline = 'top';
      cw = ctx.measureText('M').width || size * 0.6;
      ch = Math.round(size * 1.25);
      scene = makeScene(Math.floor(W / cw), Math.floor(H / ch), ch / cw, seed, align, hub);
      frame = undefined;
    };
    const draw = () => {
      if (!scene) return;
      frame = renderFrame(scene, reduced ? STILL_T : clock.current, frame);
      ctx.clearRect(0, 0, W, H);
      const ox = (W - scene.cols * cw) / 2;
      const oy = (H - scene.rows * ch) / 2;
      // three passes: faint, mid and heavy glyphs in --fg-3, then the few --signal cells
      for (const [lo, hi, alpha, color, wantHot] of [
        [1, 2, 0.55, ink, 0],
        [3, 5, 0.8, ink, 0],
        [6, 9, 1, ink, 0],
        [1, 9, 1, hot, 1],
      ] as const) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        for (let i = 0; i < frame.level.length; i++) {
          const l = frame.level[i]!;
          if (l < lo || l > hi || frame.hot[i] !== wantHot) continue;
          ctx.fillText(RAMP[l]!, ox + (i % scene.cols) * cw, oy + Math.floor(i / scene.cols) * ch);
        }
      }
      ctx.globalAlpha = 1;
    };

    colors();
    layout();
    draw();
    const ro = new ResizeObserver(() => {
      layout();
      draw();
    });
    ro.observe(canvas);
    // a theme switch (html[data-theme]) or the system scheme changes the tokens
    const retheme = () => {
      colors();
      draw();
    };
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', retheme);

    let raf = 0;
    if (visible && onscreen) {
      // under reduced motion the pacer lets one frame through and the loop ends
      const pace = new Pacer(FPS, reduced);
      let last = 0;
      const loop = (now: number) => {
        if (pace.due(now)) {
          clock.current += last ? Math.min(0.1, (now - last) / 1000) : 0;
          last = now;
          draw();
        }
        if (!reduced) raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      scheme.removeEventListener('change', retheme);
    };
  }, [reduced, visible, onscreen, align, seed, size, hub]);

  return <canvas ref={ref} aria-hidden className={cn('block w-full', className)} />;
}
