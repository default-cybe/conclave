/**
 * Watches on the Routines page: their own rows above the other routines. A
 * row has the newest photo, the name, how many items are listed and how
 * many are new since the last run, what the last run changed and when, the
 * next run, and the routine's menu (Run now, Pause, Delete). Phones get the
 * same in a two line row with a smaller photo.
 */
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import type { Routine, RoutineRun } from '@conclave/core/types';
import type { WatchSummaryDto } from '@conclave/core/client';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { dayStart, describeSchedule } from '@/lib/schedule';
import { SectionHeading } from '@/components/ui/Section';
import { nextRun, nextWords } from '../routines/words';
import { useWatchSummaries } from './data';
import { Photo } from './Photo';
import { countWords, dayWords, rowWords } from './words';

function lastWords(s: WatchSummaryDto | undefined, runs: RoutineRun[] | undefined, now: number): { text: string; tone: 'fg' | 'dim' | 'fault' | 'signal' } {
  const latest = [...(runs ?? [])].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (latest?.status === 'running') return { text: 'Running now', tone: 'signal' };
  if (latest?.status === 'error') return { text: `Failed ${when(latest.startedAt, now)}`, tone: 'fault' };
  if (!s?.last) return { text: 'No run yet', tone: 'dim' };
  const words = countWords(s.last.counts);
  return { text: `${words}, ${when(s.last.at, now)}`, tone: words === 'No change' ? 'dim' : 'fg' };
}

function when(ts: number, now: number): string {
  return ts >= dayStart(now) ? `today ${hhmm(ts)}` : `${dayWords(ts, now)} ${hhmm(ts)}`;
}

export function WatchRows({ watches, now, menu }: { watches: Routine[]; now: number; menu: (r: Routine) => ReactNode }) {
  const summaries = useWatchSummaries(watches.map((w) => w.id));
  const runs = useHub((s) => s.runs);
  const phone = useIsMobile();
  if (!watches.length) return null;
  return (
    <section aria-labelledby="watches-h" className="mt-9 phone:mt-8">
      <SectionHeading id="watches-h" count={watches.length}>
        Watches
      </SectionHeading>
      <ul className="m-0 list-none divide-y divide-rule border-t border-rule-2 p-0" aria-label="Watches">
        {watches.map((r) => {
          const s = summaries?.[r.id];
          const last = lastWords(s, runs[r.id], now);
          const next = r.enabled ? nextWords(nextRun(r, now), now) : 'Paused';
          return (
            <li key={r.id} className={cn('group relative grid items-center gap-x-4 py-3', phone ? 'grid-cols-[64px_minmax(0,1fr)_auto]' : 'grid-cols-[80px_minmax(0,1.4fr)_minmax(0,1.2fr)_120px_32px]')} data-watch-row={r.id}>
              <Photo source={s?.cover ? { routineId: r.id, itemId: s.cover.itemId } : undefined} alt={s?.cover?.title ?? r.name} className="rounded-[var(--r-1)]" dim={!r.enabled} />
              <div className="min-w-0">
                <Link href={`/routines/${r.id}`} className={cn('block truncate t-row font-medium after:absolute after:inset-0', r.enabled ? 'text-fg' : 'text-fg-2')}>
                  {r.name}
                </Link>
                <span className="mt-0.5 block truncate text-[12px] text-fg-3 phone:text-[13px]">
                  {s?.count && s.newCount ? (
                    <>
                      {s.count} listed, <span className="text-signal">{s.newCount} new</span>
                    </>
                  ) : (
                    rowWords(s)
                  )}
                  {phone ? `, ${last.tone === 'fault' || last.tone === 'signal' || !s?.last ? last.text.toLowerCase() : `ran ${when(s.last.at, now)}`}` : `, ${describeSchedule(r.schedule).toLowerCase()}`}
                </span>
              </div>
              {!phone && <span className={cn('truncate text-[13px]', last.tone === 'fault' ? 'text-fault' : last.tone === 'signal' ? 'text-signal' : last.tone === 'dim' ? 'text-fg-3' : 'text-fg-2')}>{last.text}</span>}
              <span className={cn('num text-right text-[12px] whitespace-nowrap phone:text-[13px]', r.enabled ? 'text-fg-3' : 'text-fg-3')}>{phone ? next : r.enabled ? next : 'paused'}</span>
              {!phone && <span className="relative z-[1]">{menu(r)}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
