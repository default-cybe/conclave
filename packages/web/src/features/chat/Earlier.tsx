/**
 * What the Inbox offers at every width: the filter (All, Approvals,
 * Questions, Alerts, Results) kept in the address, and Earlier today: sessions that
 * finished or failed today and what was decided on this device, newest
 * first, until Clear done. Each row is the subject, then its state as the
 * first word of the line under it ("Failed, coder, arch-desktop, 10:20").
 */
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { dayStart } from '@/lib/schedule';
import { approvalSubject } from '@/components/inbox/ApprovalCard';
import { askHome } from '@/lib/asks';
import { clearResolved, DECISION_WORDS, finishedSince, readCleared, saveCleared, useResolvedLog } from '@/features/home/inbox';

export type InboxFilter = 'all' | 'approvals' | 'questions' | 'alerts' | 'friends' | 'results';
const FILTERS: InboxFilter[] = ['all', 'approvals', 'questions', 'alerts', 'friends', 'results'];

/** The filter lives in the address (?show=approvals), so back and a shared link keep it. */
export function useInboxFilter(): [InboxFilter, (f: InboxFilter) => void] {
  const search = useSearch();
  const [loc, navigate] = useLocation();
  const shown = new URLSearchParams(search).get('show') as InboxFilter | null;
  const filter: InboxFilter = shown && FILTERS.includes(shown) ? shown : 'all';
  return [filter, (f) => navigate(f === 'all' ? loc : `${loc}?show=${f}`, { replace: true })];
}

export interface Result {
  id: string;
  at: number;
  /** The state, in a fixed place: the start of the line under the title. */
  word: string;
  /** fault: failed. strong: denied, which the owner did on purpose and may want to find. */
  tone?: 'fault' | 'strong';
  title: string;
  meta: string;
  href: string;
}

/** Earlier today's rows, and Clear done (it empties them on this device). */
export function useEarlierToday(): { results: Result[]; clear: () => void } {
  const now = useNow(60_000);
  const sessions = useHub((s) => s.sessions);
  const devices = useHub((s) => s.devices);
  const resolved = useResolvedLog();
  const [cleared, setCleared] = useState(readCleared);
  const results = useMemo(() => {
    const since = Math.max(dayStart(now), cleared);
    const device = (id: string) => devices[id]?.name ?? id;
    const where = (sessionId: string) => {
      const s = sessions[sessionId];
      return s ? [s.agent, device(s.device)].join(', ') : '';
    };
    const done: Result[] = finishedSince(Object.values(sessions), since).map((s) => ({
      id: s.id,
      at: s.updatedAt,
      word: s.status === 'error' ? 'Failed' : 'Finished',
      tone: s.status === 'error' ? 'fault' : undefined,
      title: s.title,
      meta: [s.agent, device(s.device), hhmm(s.updatedAt)].join(', '),
      href: `/s/${s.id}`,
    }));
    const decided: Result[] = resolved
      .filter((e) => e.at >= since)
      .map((e) =>
        e.kind === 'approval'
          ? {
              id: e.id,
              at: e.at,
              word: DECISION_WORDS[e.decision],
              tone: e.decision === 'deny' ? 'strong' : undefined,
              title: approvalSubject(e.approval).text,
              meta: [where(askHome(e.approval)), hhmm(e.at)].filter(Boolean).join(', '),
              href: `/s/${askHome(e.approval)}`,
            }
          : {
              id: e.id,
              at: e.at,
              word: 'Answered',
              title: e.question.questions[0]?.question ?? 'A question',
              meta: [where(askHome(e.question)), hhmm(e.at)].filter(Boolean).join(', '),
              href: `/s/${askHome(e.question)}`,
            },
      );
    return [...decided, ...done].sort((a, b) => b.at - a.at);
  }, [sessions, devices, resolved, cleared, now]);
  const clear = () => {
    const at = Date.now();
    saveCleared(at);
    setCleared(at);
    clearResolved();
  };
  return { results, clear };
}

/** One row. `inset`: under the wide Inbox's list, so titles line up with the rows above (they keep a checkbox gutter). */
export function EarlierRow({ r, inset }: { r: Result; inset?: boolean }) {
  return (
    <Link href={r.href} className={cn('block py-[10px] transition-colors duration-[var(--dur-1)] hover:bg-hover active:bg-hover phone:flex phone:min-h-[58px] phone:flex-col phone:justify-center phone:py-2', inset && 'pr-3 pl-9')}>
      <span className="t-row block truncate text-fg phone:text-[15px]">{r.title}</span>
      <span className="mt-0.5 block truncate text-[12px] text-fg-3 phone:text-[13px]">
        <span className={cn(r.tone === 'fault' && 'text-fault', r.tone === 'strong' && 'text-fg-2')}>{r.word}</span>
        {r.meta && `, ${r.meta}`}
      </span>
    </Link>
  );
}
