/**
 * Replay on the Map: a line over the last 24 hours with a handle. Drag it or
 * use the arrow keys to see the hub at an earlier time; Live comes back.
 */
import { useRef, useState } from 'react';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { clockWords, replayTicks } from './model';

const STEP = 5 * 60_000;

export function Scrubber({ from, now, at, onChange, phone }: { from: number; now: number; at: number | undefined; onChange: (at: number | undefined) => void; phone?: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number>();
  // a quick click goes down and up before React draws: the pointer's state lives in a ref
  const down = useRef(false);
  const live = at === undefined && drag === undefined;
  const shown = drag ?? at ?? now;
  const span = Math.max(1, now - from);
  const pct = ((shown - from) / span) * 100;
  const ticks = replayTicks(from, now, phone ? 6 : 3);

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    return from + f * span;
  };
  /** Near the right end is live. */
  const settle = (t: number) => (now - t < span * 0.01 ? undefined : Math.round(t));

  return (
    <div className={cn('flex items-center gap-3', phone ? 'gap-2' : 'gap-4')}>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Replay the last 24 hours"
        aria-valuemin={from}
        aria-valuemax={now}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={live ? 'Live' : clockWords(shown, now)}
        className="group relative h-9 min-w-0 flex-1 cursor-pointer touch-none outline-none"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          down.current = true;
          setDrag(timeAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (!down.current) return;
          setDrag(timeAt(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!down.current) return;
          down.current = false;
          setDrag(undefined);
          onChange(settle(timeAt(e.clientX)));
        }}
        onPointerCancel={() => {
          down.current = false;
          setDrag(undefined);
        }}
        onKeyDown={(e) => {
          const cur = at ?? now;
          const big = e.shiftKey ? 12 : 1;
          let next: number | undefined | null = null;
          if (e.key === 'ArrowLeft') next = Math.max(from, cur - STEP * big);
          else if (e.key === 'ArrowRight') next = settle(Math.min(now, cur + STEP * big));
          else if (e.key === 'Home') next = from;
          else if (e.key === 'End') next = undefined;
          if (next === null) return;
          e.preventDefault();
          onChange(next);
        }}
      >
        {/* the day, as a hairline with an hour tick every few hours */}
        <div aria-hidden className="absolute inset-x-0 top-[22px] h-px bg-rule-2" />
        {ticks.map((t) => {
          const x = ((t - from) / span) * 100;
          return (
            <div key={t} aria-hidden className="absolute top-[18px]" style={{ left: `${x}%` }}>
              <div className="h-[9px] w-px bg-rule-2" />
              <div className="absolute top-[11px] left-0 -translate-x-1/2 text-[11px] leading-none text-fg-4 num">{hhmm(t)}</div>
            </div>
          );
        })}
        {/* what has been shown: the part of the day before the handle */}
        <div aria-hidden className="absolute top-[21.5px] left-0 h-[2px] bg-fg-3" style={{ width: `${pct}%`, opacity: live ? 0 : 1 }} />
        <div aria-hidden className="absolute top-[13px]" style={{ left: `${pct}%` }}>
          <div className={cn('h-[19px] w-[3px] -translate-x-1/2 rounded-full', live ? 'bg-signal' : 'bg-fg', 'group-focus-visible:shadow-[0_0_0_2px_var(--bg),0_0_0_3.5px_var(--signal)]')} />
          {!live && <div className="absolute -top-[15px] left-0 -translate-x-1/2 rounded-[3px] bg-bg px-1 text-[11.5px] leading-none font-medium text-fg num whitespace-nowrap">{clockWords(shown, now)}</div>}
        </div>
      </div>
      {/* one width for both words, so the line never moves under a finger */}
      <div className={cn('flex shrink-0 justify-end', phone ? 'w-[92px]' : 'w-[96px]')}>
        {live ? (
          <span className="px-2 py-1 text-[13px] font-medium text-signal phone:text-[14px]" aria-live="polite">
            Live
          </span>
        ) : (
          <button type="button" onClick={() => onChange(undefined)} className="rounded-[var(--r-1)] px-2 py-1 text-[13px] font-medium whitespace-nowrap text-fg hov:bg-hover phone:text-[14px]">
            Back to live
          </button>
        )}
      </div>
    </div>
  );
}
