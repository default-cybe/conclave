import { useEffect, useRef, type CSSProperties } from 'react';
import { cn } from '@/lib/text';
import { mountWave, type WaveHandle, type WaveTone, type WaveVariant } from './engine';

export interface WaveProps {
  variant: WaveVariant;
  /** The canvas fills its box: size it with CSS (h-[72px], w-16 ...). */
  className?: string;
  style?: CSSProperties;
  /** Dot pitch px. Defaults: hero 7, scope 4, strip 3, ambient 6. */
  gap?: number;
  /** Brightest dot radius px. Defaults: hero 1.25, scope 1.1, strip 0.9, ambient 1. */
  radius?: number;
  /** Time multiplier. Default 1. */
  speed?: number;
  /** Trace height multiplier. Default 1. */
  amplitude?: number;
  /** 0..1 activity level for strip and scope ripple. Default 0.6. */
  rate?: number;
  /** Scope only: values 0..1, oldest first. */
  series?: number[];
  /** signal sets both wave colors to --signal. Strip defaults to signal, others to ink. */
  tone?: WaveTone;
  /** Draw one frame and stop (a finished run, screenshots). */
  static?: boolean;
  /** When set the canvas is role="img" with this label; otherwise aria-hidden. */
  label?: string;
  /** Alias for gap, from the first brief. */
  density?: number;
  /** Alias for rate, from the first brief. */
  intensity?: number;
}

/**
 * The signature dot-matrix wave. One per screen as hero or scope; strips for
 * live work (at least 64px wide); ambient bands in empty states. Never behind
 * text and never as a background texture (spec 2, 9.3).
 */
export function Wave({ variant, className, style, gap, radius, speed, amplitude, rate, series, tone, static: still, label, density, intensity }: WaveProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<WaveHandle | null>(null);
  const opts = { gap: gap ?? density, radius, speed, amplitude, rate: rate ?? intensity, series, tone, static: still };
  const seriesKey = series ? series.join(',') : '';

  useEffect(() => {
    if (!ref.current) return;
    handle.current = mountWave(ref.current, { variant, ...opts });
    return () => {
      handle.current?.destroy();
      handle.current = null;
    };
    // remount only when the variant changes; other props go through set()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  useEffect(() => {
    handle.current?.set(opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.gap, radius, speed, amplitude, opts.rate, seriesKey, tone, still]);

  return (
    <canvas
      ref={ref}
      className={cn('block w-full', className)}
      style={style}
      data-wave={variant}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}
