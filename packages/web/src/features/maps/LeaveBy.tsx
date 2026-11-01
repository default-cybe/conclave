/**
 * Leave-by times on Home's Today: today's calendar events with a place and
 * when to leave home for them ("17:36  Leave for Dentist at 18:00, 24 min
 * by transit"). Nothing shows without a calendar, a home or such events.
 */
import { useEffect, useState } from 'react';
import type { LeaveByDto } from '@conclave/core/client';
import { durationWords, MODE_BY } from '@conclave/core/maps/words';
import { api } from '@/lib/api';

/** "Leave for Dentist at 18:00, 24 min by transit". */
export function leaveWords(i: LeaveByDto['items'][number]): string {
  if (!i.leaveByText) return `${i.title} at ${i.startText}: no travel time. ${i.error ?? ''}`.trim();
  return `Leave for ${i.title} at ${i.startText}, ${durationWords(i.durationSec ?? 0)} ${MODE_BY[i.mode]}`;
}

export function LeaveByRows() {
  const [data, setData] = useState<LeaveByDto>();
  useEffect(() => {
    let alive = true;
    const load = () =>
      api()
        .leaveBy()
        .then((d) => alive && setData(d))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 10 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!data || (!data.items.length && !data.reason)) return null;
  return (
    <div className="mt-4" data-maps="leave-by">
      <p className="m-0 text-[12px] font-medium text-fg-3 phone:text-[13px]">Travel</p>
      {data.items.length ? (
        <ol className="rows m-0 mt-1 list-none p-0">
          {data.items.map((i) => (
            <li key={`${i.title}${i.start}`} className="grid grid-cols-[44px_minmax(0,1fr)] items-baseline gap-x-3 py-2 phone:grid-cols-[48px_minmax(0,1fr)]">
              <span className="num text-[12px] font-medium text-fg phone:text-[13px]">{i.leaveByText ?? ''}</span>
              <span className="min-w-0 text-[13.5px] leading-[1.45] text-fg phone:text-[15px]">
                {leaveWords(i)}
                <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">{i.location}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 mt-1 text-[13px] text-fg-2 phone:text-[14px]">{data.reason}</p>
      )}
    </div>
  );
}
