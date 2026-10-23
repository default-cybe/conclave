/**
 * Cost over time (spec 11.8): one column per day (or per hour for Today),
 * 60% of the slot and never wider than 24px, meter-on fill with the current
 * day in fg, 1px square-ish tops. Three hairline gridlines with mono axis
 * labels. Hover or keyboard focus shows a menu styled readout; the same
 * numbers are in the table view.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/text';

export interface ColumnDatum {
  key: string;
  /** Axis label ("16 Oct", "Mon", "14"). */
  label: string;
  /** Full label for the readout and screen readers ("Friday 16 October"). */
  long: string;
  value: number;
  /** Extra lines in the readout. */
  detail?: ReactNode;
  /** Draw in fg (today, this hour). */
  current?: boolean;
  /** A future slot (later hours today): no bar, no readout. */
  future?: boolean;
}

/** Gridline step from {1, 2, 2.5, 5} x 10^k so the three lines read cleanly. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function money(n: number, step: number): string {
  if (n === 0) return '$0';
  if (step < 1) return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
  if (n >= 1000) return `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`;
  return `$${Math.round(n)}`;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const AXIS_W = 44;
const TOP = 18;
const BOTTOM = 24;
const MONO_CH = 6.6;

export function CostColumns({
  data,
  height = 180,
  label,
  labelAt = (i, n) => (n - 1 - i) % 7 === 0,
  dim,
  format,
}: {
  data: ColumnDatum[];
  height?: number;
  /** Accessible name of the chart ("Cost per day, last 30 days"). */
  label: string;
  /** Which slots get an axis label. Default: every 7th, counted back from the last. */
  labelAt?: (i: number, n: number) => boolean;
  /** Refetching: hold the last render at reduced opacity. */
  dim?: boolean;
  format: (n: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const n = data.length;
  const plotW = Math.max(0, width - AXIS_W);
  const plotH = height - TOP - BOTTOM;
  const peakValue = Math.max(0, ...data.map((d) => d.value));
  const step = niceStep(peakValue / 2 || 0.5);
  const max = step * 2;
  const slot = n ? plotW / n : 0;
  const bw = Math.max(2, Math.min(24, slot * 0.6));
  const y = (v: number) => TOP + plotH - (v / max) * plotH;
  const x = (i: number) => AXIS_W + i * slot + slot / 2;

  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);
  const current = data.findIndex((d) => d.current);
  // direct labels: the current slot and the peak, never every bar, and only
  // where no taller neighbour would run into the text
  const fits = (i: number) => {
    const w = format(data[i].value).length * 6.4;
    const top = y(data[i].value) - 18;
    return data.every((d, j) => j === i || d.future || Math.abs(x(j) - x(i)) > w / 2 + bw / 2 || y(d.value) > top + 16);
  };
  const labelled = new Set<number>([current, peak].filter((i) => i >= 0 && data[i] && data[i].value > 0 && fits(i)));

  const showLabel = (i: number) => labelAt(i, n);
  const clampX = (cx: number, text: string) => {
    const half = (text.length * MONO_CH) / 2;
    return Math.min(Math.max(cx, AXIS_W + half), width - half);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    const live = data.map((d, i) => (d.future ? -1 : i)).filter((i) => i >= 0);
    const at = active ?? live[live.length - 1];
    const pos = live.indexOf(at);
    let next: number | undefined;
    if (e.key === 'ArrowLeft') next = live[Math.max(0, pos - 1)];
    else if (e.key === 'ArrowRight') next = live[Math.min(live.length - 1, pos + 1)];
    else if (e.key === 'Home') next = live[0];
    else if (e.key === 'End') next = live[live.length - 1];
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    if (next !== undefined) {
      e.preventDefault();
      setActive(next);
    }
  };

  const shown = active !== null && data[active] && !data[active].future ? data[active] : null;
  // the readout sits beside the active column, never on top of it
  const TIP_W = 224;
  const tipRight = active !== null && x(active) < width / 2;
  const tipLeft = active === null ? 0 : tipRight ? Math.min(x(active) + slot / 2 + 10, width - TIP_W) : Math.max(0, x(active) - slot / 2 - 10 - TIP_W);

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Use the arrow keys to read each column.`}
      onKeyDown={onKey}
      onFocus={() => {
        setFocused(true);
        if (active === null) {
          const last = [...data.keys()].reverse().find((i) => !data[i].future);
          if (last !== undefined) setActive(last);
        }
      }}
      onBlur={() => {
        setFocused(false);
        setActive(null);
      }}
      onPointerLeave={() => !focused && setActive(null)}
      className={cn('relative w-full rounded-[var(--r-1)] select-none transition-opacity duration-[var(--dur-2)]', dim && 'opacity-60')}
      style={{ height }}
    >
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          {[0, step, max].map((t, i) => (
            <g key={i}>
              <line x1={AXIS_W} x2={width} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} stroke={i === 0 ? 'var(--rule-2)' : 'var(--rule)'} strokeWidth="1" />
              <text x={AXIS_W - 10} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--fg-3)] font-mono text-[11px] font-[450]" style={{ fontFeatureSettings: '"zero" 1' }}>
                {money(t, step)}
              </text>
            </g>
          ))}
          {active !== null && data[active] && !data[active].future && <rect x={AXIS_W + active * slot} y={TOP - 6} width={slot} height={plotH + 6} fill="var(--bg-hover)" />}
          {data.map((d, i) => {
            if (d.future) return null;
            const h = d.value > 0 ? Math.max(2, (d.value / max) * plotH) : 0;
            const bx = x(i) - bw / 2;
            const by = TOP + plotH - h;
            const r = Math.min(1, h);
            return (
              <g key={d.key}>
                {h > 0 && (
                  <path
                    d={`M${bx},${by + h} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + bw - r} Q${bx + bw},${by} ${bx + bw},${by + r} V${by + h} Z`}
                    fill={d.current || active === i ? 'var(--fg)' : 'color-mix(in oklab, var(--meter-on) 68%, var(--bg))'}
                  />
                )}
                {labelled.has(i) && active === null && (
                  <text
                    x={clampX(x(i), format(d.value))}
                    y={by - 6}
                    textAnchor="middle"
                    className={cn('text-[11px] font-[450]', d.current ? 'fill-[var(--fg)]' : 'fill-[var(--fg-2)]')}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {format(d.value)}
                  </text>
                )}
              </g>
            );
          })}
          {data.map((d, i) =>
            showLabel(i) ? (
              <text
                key={`l${d.key}`}
                x={clampX(x(i), d.label)}
                y={height - 6}
                textAnchor="middle"
                className={cn('font-mono text-[11px] font-[450]', d.current ? 'fill-[var(--fg-2)]' : 'fill-[var(--fg-3)]')}
                style={{ fontFeatureSettings: '"zero" 1' }}
              >
                {d.label}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {/* hit areas: the whole slot, full plot height */}
      {width > 0 && (
        <div className="absolute inset-y-0 flex" style={{ left: AXIS_W, right: 0, top: TOP - 6, bottom: BOTTOM }}>
          {data.map((d, i) => (
            <span key={d.key} className="h-full flex-1" onPointerEnter={() => !d.future && setActive(i)} onPointerDown={() => !d.future && setActive(i)} />
          ))}
        </div>
      )}
      {shown && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 rounded-[var(--r-2)] border border-rule-2 bg-raise px-3 py-2.5"
          style={{
            left: tipLeft,
            top: TOP - 6,
            width: TIP_W,
            boxShadow: 'var(--shadow-pop)',
          }}
        >
          <div className="text-[12px] text-fg-3">{shown.long}</div>
          <div className="num mt-0.5 text-[17px] font-[540] tracking-[-0.01em] text-fg">{format(shown.value)}</div>
          {shown.detail && <div className="mt-1.5 text-[12px] leading-[1.45] text-fg-2">{shown.detail}</div>}
        </div>
      )}
    </div>
  );
}
