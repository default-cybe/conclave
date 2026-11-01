/**
 * Today on a 24 hour axis (spec 11.1 column 3, 11.5): ticks every three hours,
 * labels at 00 06 12 18 24 (mono micro fg-3), finished runs as filled 6px
 * circles (fault if failed), scheduled runs hollow, interval routines as a
 * quiet row of 2px dots under the line, and the now line in signal. Hover a
 * mark for name, time and result.
 */
import type { Routine, RoutineRun } from '@conclave/core/types';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { dayStart, everyMs, occurrencesToday } from '@/lib/schedule';
import { Tooltip } from '../ui/Tooltip';

export type DayMarkKind = 'done' | 'failed' | 'running' | 'scheduled' | 'tick';

export interface DayMark {
  id: string;
  at: number;
  kind: DayMarkKind;
  name: string;
  /** Result line for the tooltip ("Filed 6 notes, merged 2 duplicates"). */
  detail?: string;
}

/** Interval routines at or under this many minutes are drawn as ticks. */
const TICK_MAX_MIN = 180;

/**
 * Marks for today from routines and their runs (store.runs, filled by
 * loadRuns): today's runs as filled marks, the rest of today's schedule
 * hollow, interval routines as ticks.
 */
export function dayMarks(routines: Routine[], runs: Record<string, RoutineRun[] | undefined>, now = Date.now()): DayMark[] {
  const start = dayStart(now);
  const out: DayMark[] = [];
  for (const r of routines) {
    if (!r.enabled) continue;
    const every = everyMs(r.schedule);
    const list = (runs[r.id] ?? []).filter((x) => x.startedAt >= start && x.startedAt <= now);
    if (every && every <= TICK_MAX_MIN * 60_000) {
      for (const t of occurrencesToday(r.schedule, now, r.nextRunAt ?? r.lastRunAt)) out.push({ id: `${r.id}:${t}`, at: t, kind: 'tick', name: r.name });
      for (const run of list.filter((x) => x.status === 'error')) out.push({ id: run.id, at: run.startedAt, kind: 'failed', name: r.name, detail: run.error ?? run.summary });
      continue;
    }
    for (const run of list) out.push({ id: run.id, at: run.startedAt, kind: run.status === 'error' ? 'failed' : run.status === 'running' ? 'running' : 'done', name: r.name, detail: run.error ?? run.summary });
    // runs not loaded yet: the last run still shows if it was today
    if (!runs[r.id] && r.lastRunAt && r.lastRunAt >= start && r.lastRunAt <= now) out.push({ id: `${r.id}:last`, at: r.lastRunAt, kind: 'done', name: r.name });
    for (const t of occurrencesToday(r.schedule, now, r.nextRunAt)) if (t > now) out.push({ id: `${r.id}:${t}`, at: t, kind: 'scheduled', name: r.name });
  }
  return out.sort((a, b) => a.at - b.at);
}

const KIND_WORD: Record<DayMarkKind, string> = { done: 'done', failed: 'failed', running: 'running', scheduled: 'next', tick: 'every few minutes' };

export function DayAxis({ marks, className, label = 'Routines today' }: { marks: DayMark[]; className?: string; label?: string }) {
  const now = useNow(60_000);
  const start = dayStart(now);
  const pos = (t: number) => `${Math.max(0, Math.min(100, ((t - start) / 86_400_000) * 100))}%`;
  return (
    <div className={cn('relative select-none', className)} role="img" aria-label={`${label}: ${marks.filter((m) => m.kind !== 'tick').length} runs, now ${hhmm(Date.now())}`}>
      {/* marks row */}
      <div className="relative h-4">
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-rule" />
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} aria-hidden className={cn('absolute top-1/2 w-px -translate-x-1/2 bg-rule-2', i % 2 ? 'h-[3px]' : 'h-[5px]')} style={{ left: `${(i / 8) * 100}%`, marginTop: 1 }} />
        ))}
        {marks.map((m) =>
          m.kind === 'tick' ? (
            <span key={m.id} aria-hidden className="absolute top-1/2 size-[2px] -translate-x-1/2 bg-fg-4" style={{ left: pos(m.at), marginTop: -5 }} />
          ) : (
            <Tooltip
              key={m.id}
              delay={150}
              content={
                <span>
                  <span className="text-fg">{m.name}</span> <span className="num">{hhmm(m.at)}</span>, {m.kind === 'failed' ? <span className="text-fault">failed</span> : KIND_WORD[m.kind]}
                  {m.detail && <span className="block text-fg-3">{m.detail}</span>}
                </span>
              }
            >
              <span
                className={cn(
                  'absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full',
                  m.kind === 'done' && 'bg-fg-2',
                  m.kind === 'failed' && 'bg-fault',
                  m.kind === 'running' && 'bg-signal',
                  m.kind === 'scheduled' && 'border border-fg-3 bg-bg',
                )}
                style={{ left: pos(m.at) }}
              />
            </Tooltip>
          ),
        )}
        <span aria-hidden className="absolute inset-y-0 w-px -translate-x-1/2 bg-signal" style={{ left: pos(now) }} />
      </div>
      {/* labels */}
      <div aria-hidden className="relative mt-1.5 h-3.5 font-mono text-[11px] leading-none font-[450] text-fg-3">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} className={cn('absolute', h === 0 ? 'left-0' : h === 24 ? 'right-0' : '-translate-x-1/2')} style={h > 0 && h < 24 ? { left: `${(h / 24) * 100}%` } : undefined}>
            {String(h).padStart(2, '0')}
          </span>
        ))}
      </div>
    </div>
  );
}
