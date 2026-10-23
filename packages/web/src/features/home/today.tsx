/**
 * Today on Home (docs/design/ROUND-LIFE-ASSISTANT.md 6): the plan the
 * morning brief saved (its sentence, the items in time order, the focus
 * block and at most one question with tappable options), and the next step
 * of the nearest goals. A section with rows, not a box. While the morning
 * run works the line shows the Knot; without a plan there is one line and
 * a way to ask for one. With a calendar connected (docs/DESIGN.md, Calendar
 * and mail) it lists today's events, and the proposals waiting for the owner
 * as cards to approve or decline.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { TodayDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, toast, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { Section } from '@/components/ui/Section';
import { Button } from '@/components/ui/Button';
import { LiveStatus, Swap } from '@/components/motion';
import { areaLabel, dayWords } from '@/features/goals/words';
import { LeaveByRows } from '@/features/maps/LeaveBy';
import { ProposalCard } from './proposals';
import { eventRange } from './proposalWords';

export function useToday(): { data?: TodayDto; reload: () => void } {
  const [data, setData] = useState<TodayDto>();
  const reload = useCallback(() => {
    api()
      .today()
      .then(setData)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 5 * 60_000);
    return () => clearInterval(t);
  }, [reload]);
  // the morning run finished or saved a plan: fetch again
  const runKey = useHub((s) => {
    const id = data?.planRoutine?.id;
    const r = id ? s.runs[id]?.[0] : undefined;
    return r ? `${r.id}:${r.status}` : '';
  });
  useEffect(() => {
    if (runKey) reload();
  }, [runKey, reload]);
  // a new proposal from a chat or a routine: show its card
  const proposalKey = useHub((s) => s.toasts.filter((n) => n.title === 'Calendar proposal' || n.title === 'Draft to save' || n.title === 'Message to send').map((n) => n.id).join(','));
  useEffect(() => {
    if (proposalKey) reload();
  }, [proposalKey, reload]);
  return { data, reload };
}

export function TodaySection({ phone, title = 'Today' }: { phone?: boolean; title?: string }) {
  const { data, reload } = useToday();
  const [, navigate] = useLocation();
  const [answering, setAnswering] = useState<string>();
  const live = useHub((s) => {
    const id = data?.planRoutine?.id;
    const r = id ? s.runs[id]?.[0] : undefined;
    return r?.status === 'running' ? r : undefined;
  });
  if (!data) return null;
  const plan = data.plan;
  const size = phone ? 'touch' : 'sm';

  const askForPlan = async () => {
    const s = await attempt(() => api().createSession({ agent: 'assistant', title: 'Plan my day', prompt: 'Plan my day.' }));
    if (s) navigate(`/s/${s.id}`);
  };
  const answer = async (option: string) => {
    setAnswering(option);
    try {
      const r = await api().answerToday(option);
      reload();
      toast({ title: 'Sent to the plan.', level: 'info', link: r.sessionId ? `/s/${r.sessionId}` : undefined });
    } catch (e) {
      toast({ title: `Could not send it. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
    }
    setAnswering(undefined);
  };

  const due = [data.tasks.dueToday ? `${data.tasks.dueToday} ${data.tasks.dueToday === 1 ? 'task' : 'tasks'} due today` : '', data.tasks.overdue ? `${data.tasks.overdue} overdue` : ''].filter(Boolean);

  return (
    <Section title={title} action={phone ? undefined : { label: 'Goals', href: '/goals' }} rows={false} id="home-today">
      {live && (
        <div className="pt-3">
          <LiveStatus state="tool" label="Planning your day" startedAt={live.startedAt} size={14} />
        </div>
      )}

      {plan ? (
        <div className="pt-3">
          <p className="m-0 max-w-[60ch] text-[14px] leading-[1.5] text-fg phone:text-[15px]">{plan.summary}</p>
          {due.length > 0 && (
            <p className="m-0 mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">
              {data.tasks.dueToday ? <span className="text-warn">{due[0]}</span> : null}
              {data.tasks.dueToday && data.tasks.overdue ? ', ' : null}
              {data.tasks.overdue ? <span className="text-fault">{`${data.tasks.overdue} overdue`}</span> : null}
            </p>
          )}
          {plan.items.length > 0 && (
            <ol className="rows m-0 mt-2.5 list-none p-0">
              {plan.items.map((i, n) => (
                <li key={n} className="grid grid-cols-[44px_minmax(0,1fr)] items-baseline gap-x-3 py-2 phone:grid-cols-[48px_minmax(0,1fr)]">
                  <span className="num text-[12px] text-fg-3 phone:text-[13px]">{i.time ?? ''}</span>
                  <span className="min-w-0 text-[13.5px] leading-[1.45] text-fg phone:text-[15px]">
                    {i.text}
                    {i.kind === 'focus' && <span className="text-fg-3">, focus</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {plan.focus && !plan.items.some((i) => i.kind === 'focus') && (
            <p className="m-0 mt-2 text-[13px] text-fg-2 phone:text-[14px]">
              <span className="text-fg-3">Focus </span>
              <span className="num">
                {plan.focus.start} to {plan.focus.end}
              </span>
              : {plan.focus.text}
            </p>
          )}
          {plan.question && (
            <div className="mt-3 border-t border-rule pt-3">
              <p className="m-0 text-[13.5px] leading-[1.45] text-fg phone:text-[15px]">{plan.question.text}</p>
              <div className={cn('mt-2 flex gap-2', phone ? 'flex-col' : 'flex-wrap')}>
                {plan.question.options.map((o) => {
                  const picked = plan.question!.answer === o;
                  return (
                    <Button key={o} variant={picked ? 'solid' : 'outline'} size={size} disabled={!!plan.question!.answer || !!answering} busy={answering === o ? 'Sending' : false} onClick={() => void answer(o)} aria-pressed={picked}>
                      <Swap on={picked} off={<span>{o}</span>}>
                        <span>{o}, picked</span>
                      </Swap>
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
          <p className="m-0 mt-2 text-[12px] text-fg-3 phone:text-[13px]">
            Planned at {hhmm(plan.savedAt)}
            {plan.sessionId && (
              <>
                ,{' '}
                <Link href={`/s/${plan.sessionId}`} className="underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
                  open the plan
                </Link>
              </>
            )}
          </p>
        </div>
      ) : (
        !live && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">
            <p className="m-0 min-w-0 flex-1 text-[13px] text-fg-2 phone:text-[14px]">
              {data.planRoutine?.enabled && data.planRoutine.nextRunAt ? `No plan yet. The morning brief writes one at ${hhmm(data.planRoutine.nextRunAt)}.` : 'No plan for today yet.'}
              {due.length ? ` ${due.join(', ')}.` : ''}
            </p>
            <Button variant="outline" size={size} onClick={() => void askForPlan()}>
              Plan my day
            </Button>
          </div>
        )
      )}

      {data.events && data.events.length > 0 && (
        <div className="mt-4">
          <p className="m-0 text-[12px] font-medium text-fg-3 phone:text-[13px]">Calendar</p>
          <ol className="rows m-0 mt-1 list-none p-0" aria-label="Today's events">
            {data.events.map((e) => (
              <li key={e.id} className="grid grid-cols-[minmax(92px,auto)_minmax(0,1fr)] items-baseline gap-x-3 py-2 phone:grid-cols-[minmax(104px,auto)_minmax(0,1fr)]">
                <span className="num text-[12px] text-fg-3 phone:text-[13px]">{eventRange(e, data.timezone)}</span>
                <span className="min-w-0 text-[13.5px] leading-[1.45] text-fg phone:text-[15px]">
                  {e.color && <span aria-hidden className="mr-2 inline-block size-2 rounded-full align-middle" style={{ background: e.color }} />}
                  {e.title}
                  <span className="text-fg-3">, {e.calendar}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {data.events && data.events.length === 0 && !plan && <p className="m-0 mt-3 text-[13px] text-fg-3 phone:text-[14px]">Nothing in the calendar today.</p>}
      {data.calendarError && <p className="m-0 mt-2 text-[12px] text-fg-3 phone:text-[13px]">Could not read a calendar: {data.calendarError}</p>}

      {data.proposals && data.proposals.length > 0 && (
        <div className="mt-4" id="home-proposals">
          <p className="m-0 text-[12px] font-medium text-warn phone:text-[13px]">
            {data.proposals.length} {data.proposals.length === 1 ? 'proposal waits' : 'proposals wait'} for you
          </p>
          <div className="mt-2 space-y-3">
            {data.proposals.map((p) => (
              <ProposalCard key={p.id} p={p} zone={data.timezone} phone={phone} onDone={() => setTimeout(reload, 900)} />
            ))}
          </div>
        </div>
      )}

      {/* when to leave home for today's events with a place (maps) */}
      <LeaveByRows />

      {data.goals.length > 0 && (
        <div className="mt-4">
          <p className="m-0 text-[12px] font-medium text-fg-3 phone:text-[13px]">Next steps</p>
          <div className="rows mt-1">
            {data.goals.map((g) => (
              <Link key={g.id} href={`/goals/${g.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-2 hover:text-fg">
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{g.title}</span>
                  {g.nextStep && <span className="block truncate text-[12.5px] text-fg-2 phone:text-[13px]">{g.nextStep}</span>}
                </span>
                <span className={cn('text-[12px] whitespace-nowrap phone:text-[13px]', g.daysLeft !== undefined && g.daysLeft < 0 ? 'text-fault' : g.daysLeft !== undefined && g.daysLeft <= 3 ? 'text-warn' : 'text-fg-3')}>
                  {g.targetDate ? (g.daysLeft! < 0 ? `${-g.daysLeft!}d past` : g.daysLeft === 0 ? 'today' : g.daysLeft! <= 14 ? `in ${g.daysLeft}d` : dayWords(g.targetDate)) : areaLabel(g.area)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
