/**
 * Home's status sections (spec 11.1, 12.3), under the chat: what waits on
 * you, what runs, limits, routines today and devices. Rules, not boxes:
 * each section is a heading on a rule with rows under it. The approval card
 * is the only box.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { MoreHorizontal } from 'lucide-react';
import type { ApprovalRequest, Device, LimitState, QuestionRequest, Routine, RoutineRun, Session, Todo } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, upsertRoutine, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm, inTime } from '@/lib/format';
import { agoWords } from '@/features/settings/parts';
import { harnessId, providerName, splitRef } from '@/lib/models';
import { dayStart, describeSchedule, everyMs, occurrencesToday } from '@/lib/schedule';
import { askHome } from '@/lib/asks';
import { Section } from '@/components/ui/Section';
import { LimitGroup, limitPeak } from '@/components/ui/Meter';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Overlay';
import { ApprovalCard } from '@/components/inbox/ApprovalCard';
import { StableApprovalCard } from './cards';
import { QuestionCard } from '@/components/inbox/QuestionCard';
import { DayAxis, dayMarks } from '@/components/routines/DayAxis';
import { ModelName, companyLogo } from '@/components/logo';
import { Elapsed, GapList, Knot, Roll, arrived, useArrivals, usePresenceList } from '@/components/motion';
import { isChat } from '@/features/chat/util';
import { planStep } from './data';
import { homeWindows } from './status';
import { logResolved, useRetained } from './inbox';

/**
 * Rows stay flush with the section rule; the hover fill reaches 8px past the
 * text on a pseudo element so the rules between rows keep the heading's width.
 */
export const HOVER_ROW =
  'relative isolate before:pointer-events-none before:absolute before:inset-y-0 before:-inset-x-2 before:-z-10 before:rounded-[var(--r-1)] before:bg-hover before:opacity-0 before:transition-opacity before:duration-[var(--dur-1)] hover:before:opacity-100';

// ---------------------------------------------------------------------------
// Waiting on you
// ---------------------------------------------------------------------------

/** `open`: how many approval cards show whole; the rest are one line rows. */
export function WaitingSection({ phone, open: openMax = 2, className }: { phone?: boolean; open?: number; className?: string }) {
  const approvalMap = useHub((s) => s.approvals);
  const questionMap = useHub((s) => s.questions);
  const approvalsLive = useMemo(() => Object.values(approvalMap).sort((a, b) => a.createdAt - b.createdAt), [approvalMap]);
  const questionsLive = useMemo(() => Object.values(questionMap).sort((a, b) => a.createdAt - b.createdAt), [questionMap]);
  const approvals = useRetained(approvalsLive);
  const questions = useRetained(questionsLive);
  const [expanded, setExpanded] = useState<string[] | null>(null);
  const count = approvalsLive.length + questionsLive.length;
  if (!approvals.list.length && !questions.list.length) return null;

  // at most two cards open; the rest are one line rows (spec 11.1)
  const open = expanded ?? approvals.list.slice(0, openMax).map((a) => a.id);
  const openList = approvals.list.filter((a) => open.includes(a.id));
  const rest = approvals.list.filter((a) => !open.includes(a.id));

  type RowItem = { kind: 'approval'; id: string; a: ApprovalRequest } | { kind: 'question'; id: string; q: QuestionRequest };
  const rowItems: RowItem[] = [...rest.map((a) => ({ kind: 'approval' as const, id: a.id, a })), ...questions.list.map((q) => ({ kind: 'question' as const, id: q.id, q }))];

  // approve and close the gap (spec 1.4): a card confirms in place, then slides out and the rest ride up
  return (
    <Section title="Waiting on you" count={count || undefined} countTone="warn" action={phone ? undefined : { label: 'Open inbox', href: '/approvals' }} rows={false} id="home-waiting" className={className}>
      <GapList items={openList} keyOf={(a) => a.id} className={cn('space-y-2.5', openList.length > 0 && 'pt-3.5 pb-1')}>
        {(a) => (
          <div onPointerDownCapture={() => approvals.touch(a.id)} onKeyDownCapture={() => approvals.touch(a.id)}>
            <StableApprovalCard
              approval={a}
              onResolved={(d, at) => {
                logResolved({ kind: 'approval', id: a.id, at, decision: d, approval: a });
                approvals.release(a.id);
              }}
            />
          </div>
        )}
      </GapList>
      <GapList items={rowItems} keyOf={(it) => it.id} className="rows" exit="fade">
        {(it) =>
          it.kind === 'approval' ? (
            <ApprovalCard approval={it.a} collapsed onExpand={() => setExpanded([it.a.id, ...open].slice(0, 2))} />
          ) : questions.isHeld(it.q.id) ? (
            <AnsweredRow question={it.q} />
          ) : (
            <div onPointerDownCapture={() => questions.touch(it.q.id)} onKeyDownCapture={() => questions.touch(it.q.id)}>
              <QuestionCard question={it.q} />
            </div>
          )
        }
      </GapList>
    </Section>
  );
}

function AnsweredRow({ question }: { question: QuestionRequest }) {
  // a subagent's question is its chat's
  const title = useHub((s) => s.sessions[askHome(question)]?.title);
  const [at] = useState(Date.now);
  // log once, when the row first appears
  useEffect(() => logResolved({ kind: 'question', id: question.id, at, question }), [question, at]);
  return (
    <p role="status" className="py-3 text-[13px] text-fg-3 anim-fade">
      Answered {title ? <span className="text-fg-2">{title}</span> : 'the question'}, <span className="num">{hhmm(at)}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface RunningProps {
  sessions: Session[];
  todos: Record<string, Todo[] | undefined>;
  rates: Record<string, number>;
  now: number;
  phone?: boolean;
}

/** Live tokens per second, else the session's average output rate. */
export function sessionRate(s: Session, rates: Record<string, number>, now: number): number | undefined {
  if (rates[s.id]) return rates[s.id];
  const secs = (now - s.createdAt) / 1000;
  if (!s.stats.outputTokens || secs < 5) return undefined;
  return s.stats.outputTokens / secs;
}

const sessionKey = (s: Session) => s.id;

/**
 * Running now. A run that starts while Home is open fades in; one that ends
 * fades out in 120ms. Rows that were there when Home opened stay still.
 */
export function RunningSection({ sessions, todos, rates, now, phone }: RunningProps) {
  const devices = useHub((s) => s.devices);
  const booted = useHub((s) => s.booted);
  const running = sessions.filter((s) => s.status === 'running').length;
  const seen = useArrivals(() => sessions.map(sessionKey), booted);
  const rows = usePresenceList(sessions, sessionKey);
  return (
    <Section title="Running" count={sessions.length ? running : undefined} action={phone ? undefined : { label: 'All sessions', href: '/sessions' }} rows={false} id="home-running">
      {/* a container: in a narrow column the model moves from its own column into the meta line */}
      <div className="rows @container">
        {/* the status sentence already says "Nothing running.": say how to start something instead */}
        {rows.length === 0 && <p className="py-3 text-[13px] text-fg-3 phone:text-[14px]">Sessions you start show up here. Switch the box above to Session to start one.</p>}
        {rows.map(({ item: s, leaving }) => {
          const motion = leaving ? 'anim-out' : arrived(seen, s.id) ? 'anim-fade' : undefined;
          const deviceName = devices[s.device]?.name ?? s.device;
          const step = planStep(todos[s.id]);
          const parked = s.status === 'waiting_reset';
          const tps = parked ? undefined : sessionRate(s, rates, now);
          const harness = !!harnessId(s.model);
          const model = <ModelName model={s.model} size={14} tone={harness ? 'mono' : 'brand'} />;
          const right = parked ? (
            <span className="text-fg-3">
              resumes <span className="num text-fg-2">{s.resumeAt ? hhmm(s.resumeAt) : 'after reset'}</span>
            </span>
          ) : (
            // a row never animates a Knot (spec 1.9): the still tool knot, and the rate rolls
            <span className="inline-flex items-center gap-2">
              <Knot state="tool" size={14} still />
              <span className="w-[52px] text-right text-signal">{tps ? <Roll value={`${Math.round(tps)} t/s`} /> : 'running'}</span>
            </span>
          );

          if (phone)
            return (
              <Link key={s.id} href={`/s/${s.id}`} inert={leaving || undefined} className={cn('flex items-center gap-3 py-3 active:bg-hover', motion)}>
                <span className="min-w-0 flex-1">
                  <span className="t-row block truncate text-fg">{s.title}</span>
                  <span className="mt-0.5 flex min-w-0 items-center text-[13px] text-fg-3">
                    <ModelName model={s.model} size={13} className="text-fg-2" />
                    <span className="truncate">
                      &nbsp;on {deviceName},{' '}
                      {parked ? (
                        <>
                          resumes <span className="num">{s.resumeAt ? hhmm(s.resumeAt) : 'later'}</span>
                        </>
                      ) : (
                        <Elapsed since={s.createdAt} format="short" />
                      )}
                    </span>
                  </span>
                </span>
                {!parked && <Knot state="tool" size={16} still label="Running" />}
              </Link>
            );

          return (
            <Link
              key={s.id}
              href={`/s/${s.id}`}
              inert={leaving || undefined}
              className={cn(HOVER_ROW, 'grid grid-cols-[minmax(0,1fr)_40px_116px] items-center gap-x-4 py-[9px] @min-[540px]:grid-cols-[minmax(0,1fr)_minmax(0,124px)_40px_116px]', motion)}
            >
              <span className="min-w-0">
                <span className="t-row block truncate text-fg">{s.title}</span>
                {/* one text run so it truncates with an ellipsis instead of squeezing parts together */}
                <span className="mt-0.5 block truncate text-[12px] leading-[1.4] text-fg-3">
                  <span className="@min-[540px]:hidden">
                    <ModelName model={s.model} size={13} className="align-[-0.2em] text-fg-2" /> on{' '}
                  </span>
                  {deviceName}, {parked ? 'waiting for the limit to reset' : step ? `${step.index} of ${step.total}${step.text ? `, ${step.text}` : ''}` : s.cwd && s.cwd !== '~' ? <span className="mono">{s.cwd}</span> : s.agent}
                </span>
              </span>
              <span className="hidden min-w-0 text-[13px] text-fg-2 @min-[540px]:block">{model}</span>
              <span className="text-right text-[12px] text-fg-3">{!parked && <Elapsed since={s.createdAt} format="short" />}</span>
              <span className="flex justify-end text-[12px] whitespace-nowrap">{right}</span>
            </Link>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export function homeLimits(limits: Record<string, LimitState>): LimitState[] {
  return Object.values(limits)
    .filter((l) => homeWindows(l).length > 0)
    .sort((a, b) => limitPeak(b) - limitPeak(a));
}

/** Sessions parked until this limit resets. */
function parkedFor(l: LimitState, parked: Session[]): Session[] {
  const resets = l.windows.map((w) => w.resetsAt).filter(Boolean) as number[];
  const company = companyLogo(l.provider);
  return parked.filter((s) => (s.resumeAt && resets.some((r) => Math.abs(r - s.resumeAt!) < 3 * 60_000)) || (company && companyLogo(splitRef(s.model).provider) === company));
}

/** Why Limits is empty, in words that fit the hub: nothing close, keys that report none, or nothing connected yet. */
function noLimitsWords(reported: number, keys: string[]): string {
  if (reported > 0) return 'Nothing is close to a limit. API limits show up here past half.';
  if (keys.length === 1) return `${providerName(keys[0])} has reported no limits for this key yet.`;
  if (keys.length > 1) return 'Your providers have reported no limits yet.';
  return 'Limits show up here once a plan or key is connected.';
}

export function LimitsSection({ limits, parked }: { limits: LimitState[]; parked: Session[] }) {
  const reported = useHub((s) => Object.keys(s.limits).length);
  const keys = useHub((s) => s.secrets?.providers);
  return (
    <Section title="Limits" action={{ label: 'Usage', href: '/usage' }} id="home-limits">
      {limits.length === 0 && <p className="py-3 text-[13px] text-fg-3">{noLimitsWords(reported, keys ?? [])}</p>}
      {limits.map((l) => {
        const held = l.blocked ? parkedFor(l, parked) : [];
        return (
          <div key={l.provider}>
            <LimitGroup limit={l} compact />
            {held.length > 0 && (
              <p className="-mt-1.5 pb-3 pl-[84px] text-[12px] leading-[1.45] text-fg-3">
                Parked until <span className="num text-fg-2">{held[0].resumeAt ? hhmm(held[0].resumeAt) : 'the reset'}</span>:{' '}
                {held.map((s, i) => (
                  <Fragment key={s.id}>
                    {i > 0 && ', '}
                    <Link href={`${isChat(s) ? '/chat/' : '/s/'}${s.id}`} className="link">
                      {s.title}
                    </Link>
                  </Fragment>
                ))}
              </p>
            )}
          </div>
        );
      })}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Note text (the Inbox's session context)
// ---------------------------------------------------------------------------

const MONO_RE = /`([^`]+)`|(\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\d{1,2})?)|((?:^|(?<=\s))(?:~\/|\/)[\w.-]+(?:\/[\w.-]+)*)/g;

/** Note text with code spans, IPs and paths in mono (spec 11.1). */
export function NoteText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MONO_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push(
      <span key={i} className="mono">
        {m[1] ?? m[2] ?? m[3]}
      </span>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

// ---------------------------------------------------------------------------
// Routines today
// ---------------------------------------------------------------------------

interface TimeRow {
  key: string;
  at: number;
  past: boolean;
  /** A run is going now (running or waiting on you). */
  active?: boolean;
  routine: Routine;
  time: ReactNode;
  detail?: ReactNode;
  state: ReactNode;
}

function intervalWords(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = min / 60;
  if (!Number.isInteger(h)) return `${min} min`;
  return h === 1 ? 'hourly' : `${h} hours`;
}

/** "yesterday", "Tue", "9 Oct" for a run before today; nothing for today. */
function runDay(ts: number): string | undefined {
  const today = dayStart(Date.now());
  if (ts >= today) return undefined;
  if (ts >= today - 86_400_000) return 'yesterday';
  if (ts >= today - 6 * 86_400_000) return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short' });
  return `${new Date(ts).getDate()} ${new Date(ts).toLocaleDateString('en-GB', { month: 'short' })}`;
}

/** The last run's result line. A failure from an earlier day says when, so it does not read as today's. */
function lastResult(run: RoutineRun | undefined): ReactNode {
  if (!run) return undefined;
  if (run.status === 'error') {
    const day = runDay(run.startedAt);
    return <span className="text-fault">{day ? `Failed ${day}, ${run.error ?? 'no detail'}` : (run.error ?? 'Failed')}</span>;
  }
  return run.summary;
}

/** One row per enabled routine, placed before or after now (spec 11.1 column 3). */
function timetable(routines: Routine[], runs: Record<string, RoutineRun[] | undefined>, sessions: Record<string, Session>, now: number): TimeRow[] {
  const start = dayStart(now);
  const rows: TimeRow[] = [];
  for (const r of routines) {
    if (!r.enabled) continue;
    const list = runs[r.id] ?? [];
    // no upper bound: `now` is rounded down to the minute and a run started a second ago is still today
    const today = list.filter((x) => x.startedAt >= start).sort((a, b) => b.startedAt - a.startedAt);
    const latest = list.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
    const active = today.find((x) => x.status === 'running');
    const every = everyMs(r.schedule);
    const failedToday = today.filter((x) => x.status === 'error').length;
    const clock = (t: number) => <span className="font-mono">{hhmm(t)}</span>;
    // a run whose session waits on an approval or an answer is not working, it is waiting on you
    const running = (x: RoutineRun) => {
      const st = x.sessionId ? sessions[x.sessionId]?.status : undefined;
      if (st === 'waiting_approval' || st === 'waiting_input') return <span className="text-warn">waiting on you</span>;
      return (
        <span className="text-signal">
          running <Elapsed since={x.startedAt} format="short" />
        </span>
      );
    };

    if (active) {
      const before = list.filter((x) => x !== active).sort((a, b) => b.startedAt - a.startedAt)[0];
      rows.push({ key: r.id, at: active.startedAt, past: true, active: true, routine: r, time: every ? intervalWords(every) : clock(active.startedAt), detail: lastResult(before) ?? describeSchedule(r.schedule), state: running(active) });
      continue;
    }
    if (every) {
      const last = today[0] ?? latest;
      // a failure today matters more than the last good run, so it goes first
      const detail = last ? (
        <>
          {failedToday > 0 && last.status !== 'error' && <span className="text-fault">{failedToday} failed today, </span>}
          {failedToday > 0 && last.status !== 'error' ? 'last run ' : 'Last run '}
          <span className="num">{hhmm(last.startedAt)}</span>
          {last.status === 'error' ? <span className="text-fault"> failed</span> : last.summary ? `, ${last.summary.charAt(0).toLowerCase()}${last.summary.slice(1)}` : ''}
        </>
      ) : (
        describeSchedule(r.schedule)
      );
      rows.push({
        key: r.id,
        at: r.nextRunAt ?? now + every,
        past: false,
        routine: r,
        time: intervalWords(every),
        detail,
        state: r.nextRunAt ? (
          <span className="text-fg-3">
            next <span className="num text-fg-2">{hhmm(r.nextRunAt)}</span>
          </span>
        ) : null,
      });
      continue;
    }
    const occ = occurrencesToday(r.schedule, now, r.nextRunAt);
    const future = occ.find((t) => t > now);
    if (future) {
      rows.push({ key: r.id, at: future, past: false, routine: r, time: clock(future), detail: lastResult(latest) ?? describeSchedule(r.schedule), state: <span className="num text-fg-2">{inTime(future, now)}</span> });
      continue;
    }
    if (today[0]) {
      const x = today[0];
      const word = x.status === 'error' ? <span className="text-fault">failed</span> : <span className="text-fg-3">{x.status === 'skipped' ? 'skipped' : 'done'}</span>;
      rows.push({ key: r.id, at: x.startedAt, past: true, routine: r, time: clock(x.startedAt), detail: lastResult(x), state: word });
      continue;
    }
    const missed = occ.filter((t) => t <= now).pop();
    if (missed) {
      rows.push({ key: r.id, at: missed, past: true, routine: r, time: clock(missed), detail: describeSchedule(r.schedule), state: <span className="text-fg-3">missed</span> });
      continue;
    }
    if (r.nextRunAt)
      rows.push({
        key: r.id,
        at: r.nextRunAt,
        past: false,
        routine: r,
        time: <span className="text-fg-3">{new Date(r.nextRunAt).toLocaleDateString('en-GB', { weekday: 'short' })}</span>,
        detail: lastResult(latest) ?? describeSchedule(r.schedule),
        state: <span className="num text-fg-2">{hhmm(r.nextRunAt)}</span>,
      });
  }
  return rows.sort((a, b) => Number(b.past) - Number(a.past) || a.at - b.at);
}

export function RoutinesSection({ now, max }: { now: number; max?: number }) {
  const [, navigate] = useLocation();
  const routinesMap = useHub((s) => s.routines);
  const runs = useHub((s) => s.runs);
  const sessions = useHub((s) => s.sessions);
  const routines = useMemo(() => Object.values(routinesMap), [routinesMap]);
  // real time, not the minute: a run started seconds ago must count
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const marks = useMemo(() => dayMarks(routines, runs, Date.now()), [routines, runs, now]);
  const rows = useMemo(() => timetable(routines, runs, sessions, now), [routines, runs, sessions, now]);
  const shown = max ? rows.slice(0, max) : rows;
  const nowAt = shown.findIndex((r) => !r.past);
  // When the clock passes a routine it moves above the now line: that row and the line fade in
  // at their new places, so the move reads as "this came due", not a jump. Only a minute tick
  // counts; rows settling while Home loads its data do not move anything.
  const pastKeys = shown.filter((r) => r.past).map((r) => r.key);
  const nowKey = `now:${pastKeys[pastKeys.length - 1] ?? ''}`;
  // (kept in a ref that only grows, so a second render of the same frame reads the same answer)
  const track = useRef<{ now: number; past: Set<string>; key: string; moved: string; passed: Set<string> }>({ now, past: new Set(pastKeys), key: nowKey, moved: '', passed: new Set() });
  const t = track.current;
  if (t.now !== now) {
    for (const k of pastKeys) if (!t.past.has(k)) t.passed.add(k);
    if (t.key !== nowKey) t.moved = nowKey;
  }
  track.current = { now, past: new Set(pastKeys), key: nowKey, moved: t.moved, passed: t.passed };
  const lineMoved = t.moved === nowKey;
  const passed = t.passed;
  return (
    <Section title="Routines today" action={{ label: 'Edit', href: '/routines' }} rows={false} id="home-routines">
      {rows.length === 0 ? (
        <EmptyState wave={false} className="pb-0" action={{ label: 'New routine', onClick: () => navigate('/routines/new') }}>
          Routines you schedule show up here with their next run.
        </EmptyState>
      ) : (
        <>
          <DayAxis marks={marks} className="mt-4 mb-3" />
          <div className="rows">
            {shown.map((row, i) => (
              <Fragment key={row.key}>
                {i === nowAt && <NowRow key={nowKey} now={now} moved={lineMoved} />}
                <RoutineRow row={row} enter={passed.has(row.key)} />
              </Fragment>
            ))}
            {nowAt < 0 && <NowRow key={nowKey} now={now} moved={lineMoved} />}
          </div>
        </>
      )}
    </Section>
  );
}

/** The now line between what ran and what comes next. It fades in when it moves past a routine. */
function NowRow({ now, moved }: { now: number; moved?: boolean }) {
  const [enter] = useState(!!moved);
  return (
    <div className={cn('flex items-center gap-3 py-1.5', enter && 'anim-fade')} aria-label={`Now, ${hhmm(now)}`}>
      <span className="w-12 shrink-0 font-mono text-[12px] text-signal">{hhmm(now)}</span>
      <span aria-hidden className="h-px flex-1 bg-signal" />
    </div>
  );
}

function RoutineRow({ row, enter }: { row: TimeRow; /** It just moved above the now line: fade in there. */ enter?: boolean }) {
  const [, navigate] = useLocation();
  const r = row.routine;
  const runNow = async () => {
    await attempt(() => api().runRoutine(r.id));
  };
  const pause = async () => {
    const next = await attempt(() => api().updateRoutine(r.id, { enabled: false }));
    if (next) upsertRoutine(next);
  };
  // the actions button takes the state word's place on hover and focus, so the right edge stays aligned
  const reveal = 'group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[aria-expanded=true]]:opacity-100';
  return (
    <div className={cn(HOVER_ROW, 'group', enter && 'anim-fade')}>
      <Link href={`/routines/${r.id}`} className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-[9px] text-[13px] coarse:pr-8">
        <span className="text-[12px] text-fg-3">{row.time}</span>
        <span className="min-w-0">
          <span className={cn('block truncate font-medium', row.past && !row.active ? 'text-fg-2' : 'text-fg')}>{r.name}</span>
          {row.detail && <span className="mt-0.5 block truncate text-[12px] text-fg-3">{row.detail}</span>}
        </span>
        <span className="text-right text-[12px] whitespace-nowrap transition-opacity duration-[var(--dur-1)] group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 group-has-[[aria-expanded=true]]:opacity-0 coarse:opacity-100">{row.state}</span>
      </Link>
      <span className={cn('absolute top-[7px] right-0 opacity-0 transition-opacity duration-[var(--dur-1)] coarse:opacity-100', reveal)}>
        <Menu
          label={`${r.name} actions`}
          items={[
            { label: 'Run now', onSelect: () => void runNow() },
            { label: 'Open routine', onSelect: () => navigate(`/routines/${r.id}`) },
            { separator: true, label: '' },
            { label: 'Pause', onSelect: () => void pause() },
          ]}
          trigger={({ ref, props }) => (
            <IconButton ref={ref} label={`${r.name} actions`} size="sm" tooltip={false} {...props}>
              <MoreHorizontal />
            </IconButton>
          )}
        />
      </span>
    </div>
  );
}

/** Phone: the next routine as one row (spec 12.3). */
// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

const CLI_NAMES: Array<[string, string]> = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
  ['gemini', 'Gemini CLI'],
];

const PLATFORM_WORDS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', ios: 'iOS', android: 'Android', win32: 'Windows' };

function deviceDetail(d: Device, running: number, now: number): string {
  const parts: string[] = [];
  if (d.id === 'local') parts.push('Hub');
  if (!d.online) parts.push(d.lastSeenAt ? `last seen ${agoWords(d.lastSeenAt, now)}` : 'not seen yet');
  else if (running) parts.push(`${running} ${running === 1 ? 'session' : 'sessions'} running`);
  else {
    const clis = CLI_NAMES.filter(([k]) => d.info?.clis?.[k]).map(([, v]) => v);
    if (clis.length) parts.push(clis.join(', '));
    else if (!parts.length && d.info) parts.push(PLATFORM_WORDS[d.info.platform] ?? d.info.platform);
  }
  const s = parts.join(', ');
  return /^(macOS|iOS)/.test(s) ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function useDeviceList() {
  const devicesMap = useHub((s) => s.devices);
  const sessions = useHub((s) => s.sessions);
  return useMemo(() => {
    const running: Record<string, number> = {};
    for (const s of Object.values(sessions)) if (s.status === 'running') running[s.device] = (running[s.device] ?? 0) + 1;
    const list = Object.values(devicesMap).sort((a, b) => Number(b.id === 'local') - Number(a.id === 'local') || Number(b.online) - Number(a.online) || (running[b.id] ?? 0) - (running[a.id] ?? 0) || a.name.localeCompare(b.name));
    return { list, running };
  }, [devicesMap, sessions]);
}

export function DevicesSection({ now }: { now: number }) {
  const { list, running } = useDeviceList();
  return (
    <Section title="Devices" action={{ label: 'Pair a device', href: '/devices?pair=1' }} id="home-devices">
      {list.map((d) => (
        <Link key={d.id} href="/devices" className={cn(HOVER_ROW, 'grid grid-cols-[minmax(0,108px)_minmax(0,1fr)_auto] items-baseline gap-x-3 py-[9px] text-[13px]')}>
          <span className="truncate font-medium text-fg">{d.name}</span>
          <span className="truncate text-[12px] text-fg-3">{deviceDetail(d, running[d.id] ?? 0, now)}</span>
          <span className={cn('text-[12px]', d.online ? 'text-ok' : 'text-fg-3')}>{d.online ? 'online' : 'offline'}</span>
        </Link>
      ))}
    </Section>
  );
}

/** Phone: devices as one sentence (spec 12.3). */
// ---------------------------------------------------------------------------
// First day
// ---------------------------------------------------------------------------

export function FirstDay() {
  const [, navigate] = useLocation();
  return (
    <section aria-label="Get started">
      <EmptyState pet action={{ label: 'Import sessions', onClick: () => navigate('/setup/import?again=1') }}>
        Sessions you start show up here. Switch the box above from Chat to Session to start one, or import past sessions from Claude Code and Codex.
      </EmptyState>
    </section>
  );
}
