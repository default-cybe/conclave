/** Words for tasks: columns, priority, due dates, and the state of linked sessions. */
import type { ReactNode } from 'react';
import type { Session, Task, TaskStatus } from '@conclave/core/types';
import { hhmm } from '@/lib/format';
import { dayStart } from '@/lib/schedule';
import type { StateTone } from '@/components/ui/List';
import { Elapsed } from '@/components/motion';

export const COLUMNS: Array<{ id: TaskStatus; label: string; empty: string }> = [
  { id: 'inbox', label: 'Inbox', empty: 'Ideas and requests land here.' },
  { id: 'todo', label: 'To do', empty: 'Nothing planned.' },
  { id: 'doing', label: 'Doing', empty: 'Nothing in progress.' },
  { id: 'review', label: 'Review', empty: 'Nothing waiting for review.' },
  { id: 'done', label: 'Done', empty: 'Nothing finished yet.' },
];

export const STATUS_LABEL: Record<TaskStatus, string> = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label])) as Record<TaskStatus, string>;

/** Task priority runs 0 none, 1 low, 2 high, 3 urgent. Only the top two get a word in lists. */
export const PRIORITY: Array<{ value: Task['priority']; label: string }> = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Low' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Urgent' },
];
export function priorityWord(p: Task['priority']): string | undefined {
  return p === 3 ? 'urgent' : p === 2 ? 'high' : undefined;
}

const DAY = 86_400_000;

/** "due 18:00", "due tomorrow", "due Mon", "due 23 Oct", "overdue 2d", with a tone. */
export function dueWords(due: number | undefined, done: boolean, now = Date.now()): { text: string; tone: StateTone } | undefined {
  if (!due) return undefined;
  const today = dayStart(now);
  if (done) return { text: `was due ${dateWord(due, now)}`, tone: 'dim' };
  if (due < now) {
    const late = now - due;
    return { text: late < DAY ? 'overdue' : `overdue ${Math.floor(late / DAY)}d`, tone: 'fault' };
  }
  const tone: StateTone = due - now < DAY ? 'warn' : 'dim';
  if (due < today + DAY) return { text: `due ${hhmm(due)}`, tone };
  return { text: `due ${dateWord(due, now)}`, tone };
}

function dateWord(ts: number, now: number): string {
  const today = dayStart(now);
  if (ts >= today + DAY && ts < today + 2 * DAY) return 'tomorrow';
  if (ts >= today - DAY && ts < today) return 'yesterday';
  if (Math.abs(ts - today) < 6 * DAY) return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short' });
  return `${new Date(ts).getDate()} ${new Date(ts).toLocaleDateString('en-GB', { month: 'short' })}`;
}

/** The most important linked session first: waiting on you, then running, then the rest by recency. */
export function liveSession(list: Session[] | undefined): Session | undefined {
  if (!list?.length) return undefined;
  const rank = (s: Session) => (s.status === 'waiting_approval' || s.status === 'waiting_input' ? 0 : s.status === 'running' ? 1 : s.status === 'waiting_reset' ? 2 : s.status === 'error' ? 3 : 4);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)[0];
}

/** A session's state as the word lists use (spec 10.2). */
export function sessionState(s: Session): ReactNode {
  switch (s.status) {
    case 'running':
      return (
        <span className="text-signal">
          running <Elapsed since={s.createdAt} format="short" />
        </span>
      );
    case 'waiting_approval':
      return <span className="text-warn">approve</span>;
    case 'waiting_input':
      return <span className="text-warn">answer</span>;
    case 'waiting_reset':
      return <span className="text-fg-3">resumes {s.resumeAt ? hhmm(s.resumeAt) : 'soon'}</span>;
    case 'error':
      return <span className="text-fault">failed</span>;
    default:
      return null;
  }
}

/** Projects and labels as one list of words to filter by, most used first. */
export function areas(tasks: Task[]): Array<{ value: string; count: number }> {
  const n = new Map<string, number>();
  for (const t of tasks) for (const a of new Set([...(t.project ? [t.project] : []), ...t.labels])) n.set(a, (n.get(a) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
}

export function inArea(t: Task, area: string): boolean {
  return area === 'all' || t.project === area || t.labels.includes(area);
}

/** Words for the meta line: project or labels, without repeating the project. */
export function tagWords(t: Task, max = 2): string[] {
  const words = [...(t.project ? [t.project] : []), ...t.labels.filter((l) => l !== t.project)];
  return words.slice(0, max);
}
