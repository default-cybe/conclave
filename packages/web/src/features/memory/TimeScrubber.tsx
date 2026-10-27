/**
 * Time on the memory map: the Map's scrubber (features/map/Scrubber.tsx)
 * over the months memory spans instead of the last day. Items changed after
 * the handle step back; nothing moves. The right end is everything.
 */
import { useRef, useState } from 'react';
import { cn } from '@/lib/text';

const DAY = 86_400_000;
const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function monthTicks(from: number, to: number, max: number): number[] {
  const out: number[] = [];
  const d = new Date(from);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  for (d.setMonth(d.getMonth() + 1); d.getTime() < to; d.setMonth(d.getMonth() + 1)) out.push(d.getTime());
  const step = Math.ceil(out.length / max);
  return out.filter((_, i) => i % step === 0);
}

export function TimeScrubber({ from, to, at, onChange, phone, shown }: { from: number; to: number; at: number | undefined; onChange: (at: number | undefined) => void; phone?: boolean; shown: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number>();
  const down = useRef(false);
  const all = at === undefined && drag === undefined;
  const cur = drag ?? at ?? to;
  const span = Math.max(1, to - from);
  const pct = ((cur - from) / span) * 100;
  const ticks = monthTicks(from, to, phone ? 4 : 8);
  const timeAt = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    return from + Math.min(1, Math.max(0, (x - r.left) / Math.max(1, r.width))) * span;
  };
  const settle = (t: number) => (to - t < span * 0.01 ? undefined : Math.round(t));
  return (
    <div className="flex items-center gap-3">
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Show memory as it was on a day"
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={Math.round(cur)}
        aria-valuetext={all ? 'Everything' : `Up to ${day(cur)}`}
        className="group relative h-9 min-w-0 flex-1 cursor-pointer touch-none outline-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          down.current = true;
          setDrag(timeAt(e.clientX));
        }}
        onPointerMove={(e) => down.current && setDrag(timeAt(e.clientX))}
        onPointerUp={(e) => {
          if (!down.current) return;
          down.current = false;
          setDrag(undefined);
          onChange(settle(timeAt(e.clientX)));
        }}
        onPointerCancel={() => ((down.current = false), setDrag(undefined))}
        onKeyDown={(e) => {
          const c = at ?? to;
          const step = (e.shiftKey ? 30 : 7) * DAY;
          let next: number | undefined | null = null;
          if (e.key === 'ArrowLeft') next = Math.max(from, c - step);
          else if (e.key === 'ArrowRight') next = settle(Math.min(to, c + step));
          else if (e.key === 'Home') next = from;
          else if (e.key === 'End') next = undefined;
          if (next === null) return;
          e.preventDefault();
          e.stopPropagation();
          onChange(next);
        }}
      >
        <div aria-hidden className="absolute inset-x-0 top-[22px] h-px bg-rule-2" />
        {ticks.map((t) => (
          <div key={t} aria-hidden className="absolute top-[18px]" style={{ left: `${((t - from) / span) * 100}%` }}>
            <div className="h-[9px] w-px bg-rule-2" />
            <div className="num absolute top-[11px] left-0 -translate-x-1/2 text-[11px] leading-none text-fg-4 phone:text-[12px]">{new Date(t).toLocaleDateString('en-US', { month: 'short' })}</div>
          </div>
        ))}
        <div aria-hidden className="absolute top-[21.5px] left-0 h-[2px] bg-fg-3" style={{ width: `${pct}%`, opacity: all ? 0 : 1 }} />
        <div aria-hidden className="absolute top-[13px]" style={{ left: `${pct}%` }}>
          <div className={cn('h-[19px] w-[3px] -translate-x-1/2 rounded-full', all ? 'bg-fg-3' : 'bg-fg', 'group-focus-visible:shadow-[0_0_0_2px_var(--bg),0_0_0_3.5px_var(--signal)]')} />
          {!all && <div className="num absolute -top-[15px] left-0 -translate-x-1/2 rounded-[3px] bg-bg px-1 text-[11.5px] leading-none font-medium whitespace-nowrap text-fg">{day(cur)}</div>}
        </div>
      </div>
      <div className={cn('flex shrink-0 items-baseline justify-end gap-2', phone ? 'w-[86px]' : 'w-[200px]')}>
        {!all && !phone && <span className="num text-[12px] whitespace-nowrap text-fg-3">{shown}</span>}
        {all ? (
          <span className="px-2 py-1 text-[13px] text-fg-3 phone:text-[14px]">All time</span>
        ) : (
          <button type="button" onClick={() => onChange(undefined)} className="rounded-[var(--r-1)] px-2 py-1 text-right text-[13px] font-medium whitespace-nowrap text-fg hov:bg-hover phone:text-[14px]">
            Show all
          </button>
        )}
      </div>
    </div>
  );
}
