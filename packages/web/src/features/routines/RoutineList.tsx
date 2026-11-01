/**
 * Routines list (spec 11.5): today's 24 hour axis across the top, then one
 * table row per routine with its schedule in words, next run, last outcome,
 * who runs it and its state word. No toggles in the list: Pause and Resume
 * live in the row menu.
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { MoreHorizontal } from 'lucide-react';
import type { Routine } from '@conclave/core/types';
import { agentByName, loadRuns, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { dayStart, describeSchedule } from '@/lib/schedule';
import { Page, PageHeader } from '@/components/ui/Page';
import { Button, IconButton } from '@/components/ui/Button';
import { Menu, type MenuItem } from '@/components/ui/Overlay';
import { SectionHeading } from '@/components/ui/Section';
import { ListRow, MetaLine } from '@/components/ui/List';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tooltip } from '@/components/ui/Tooltip';
import { ModelName } from '@/components/logo';
import { DayAxis, dayMarks } from '@/components/routines/DayAxis';
import { LastOutcome, firstLine, nextRun, nextWords, otherZone } from './words';
import { TemplatesDialog, TemplateRows } from './Templates';
import { useRoutineActions } from './actions';
import { SuggestedSection } from './Suggested';
import { AddSuggestionSheet } from './AddSuggestion';
import { useSuggestStore, whatWords } from './suggest';
import { isWatchRoutine } from '../watches/data';
import { WatchRows } from '../watches/WatchRows';

export function RoutineList() {
  const routineMap = useHub((s) => s.routines);
  const runs = useHub((s) => s.runs);
  const booted = useHub((s) => s.booted);
  const [, navigate] = useLocation();
  const now = useNow(30_000);
  const phone = useIsMobile();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // /routines?suggest=<id> opens the Add sheet (Discover links here)
  const suggest = new URLSearchParams(useSearch()).get('suggest');
  const openSuggest = (id: string) => navigate(`/routines?suggest=${encodeURIComponent(id)}`, { replace: true });
  const closeSuggest = () => navigate('/routines', { replace: true });

  const routines = useMemo(
    () =>
      Object.values(routineMap).sort(
        (a, b) => Number(b.enabled) - Number(a.enabled) || (nextRun(a) ?? Infinity) - (nextRun(b) ?? Infinity) || a.name.localeCompare(b.name),
      ),
    [routineMap],
  );

  useEffect(() => {
    for (const r of Object.values(routineMap)) if (!runs[r.id]) void loadRuns(r.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineMap]);

  const watches = useMemo(() => routines.filter(isWatchRoutine), [routines]);
  const plain = useMemo(() => routines.filter((r) => !isWatchRoutine(r)), [routines]);
  const marks = useMemo(() => dayMarks(routines, runs, Date.now()), [routines, runs, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = dayStart(now);
  const ranToday = Object.values(runs)
    .flat()
    .filter((r) => r && r.startedAt >= today && routineMap[r.routineId]);
  const failedToday = ranToday.filter((r) => r.status === 'error').length;
  const active = routines.filter((r) => r.enabled).length;
  const paused = routines.length - active;

  const sub = routines.length ? (
    <>
      {active} active{paused ? `, ${paused} paused` : ''}
      {failedToday > 0 && <span className="text-fault">, {failedToday} failed today</span>}
    </>
  ) : undefined;

  return (
    <Page>
      <PageHeader
        title="Routines"
        sub={sub}
        actions={
          <>
            <Button variant="quiet" size={phone ? 'touch' : 'md'} onClick={() => setTemplatesOpen(true)}>
              Templates
            </Button>
            <Button variant="solid" size={phone ? 'touch' : 'md'} onClick={() => navigate('/routines/new')}>
              New routine
            </Button>
          </>
        }
      />

      {booted && routines.length === 0 ? (
        <div className="max-w-[720px]">
          <EmptyState action={{ label: 'New routine', onClick: () => navigate('/routines/new') }}>Routines you schedule show up here with their next run.</EmptyState>
          <SuggestedSection className="mt-10" limit={3} heading="Suggested for your machines" onAdd={openSuggest} />
          <section className="mt-10" aria-labelledby="tpl-h">
            <SectionHeading id="tpl-h">Start from a template</SectionHeading>
            <TemplateRows onUse={(id) => navigate(`/routines/new?template=${id}`)} />
          </section>
        </div>
      ) : (
        <>
          <section aria-labelledby="today-h">
            <SectionHeading
              id="today-h"
              right={
                <span className="num text-[12px] text-fg-3 phone:text-[13px]">
                  {ranToday.length ? `${ranToday.length} ${ranToday.length === 1 ? 'run' : 'runs'} so far` : 'No runs yet today'}
                  {failedToday > 0 && <span className="text-fault">, {failedToday} failed</span>}
                </span>
              }
            >
              Today
            </SectionHeading>
            <NowLabel now={now} />
            <DayAxis marks={marks} className="mb-1" />
          </section>

          {/* watches (features/watches) have their own rows: what they keep and what changed */}
          <WatchRows watches={watches} now={now} menu={(r) => <RowMenu routine={r} />} />
          {plain.length > 0 && (
            <div className="mt-9 phone:mt-8">
              {watches.length > 0 && <SectionHeading id="plain-h">Routines</SectionHeading>}
              {phone ? <PhoneRows routines={plain} now={now} /> : <RoutineTable routines={plain} now={now} />}
            </div>
          )}

          <SuggestedSection className="mt-14 max-w-[880px] phone:mt-12" onAdd={openSuggest} />
        </>
      )}

      <TemplatesDialog open={templatesOpen} onClose={() => setTemplatesOpen(false)} />
      <AddSuggestionSheet id={suggest} onClose={closeSuggest} />
    </Page>
  );
}

function PhoneRows({ routines, now }: { routines: Routine[]; now: number }) {
  const runs = useHub((s) => s.runs);
  const sessions = useHub((s) => s.sessions);
  return (
    <div className="rows border-t border-rule-2">
      {routines.map((r) => (
          <ListRow
            key={r.id}
            inset={false}
            href={`/routines/${r.id}`}
            title={<span className={r.enabled ? 'text-fg' : 'text-fg-2'}>{r.name}</span>}
            meta={<MetaLine parts={[`${describeSchedule(r.schedule)}${otherZone(r.timezone) ? ` ${otherZone(r.timezone)} time` : ''}`, <LastOutcome key="o" routine={r} runs={runs[r.id]} sessions={sessions} now={now} />]} />}
            time={r.enabled ? nextWords(nextRun(r, now), now) : undefined}
            state={r.enabled ? undefined : 'paused'}
            stateTone="dim"
            className="py-3"
          />
      ))}
    </div>
  );
}

function RoutineTable({ routines, now }: { routines: Routine[]; now: number }) {
  const runs = useHub((s) => s.runs);
  const sessions = useHub((s) => s.sessions);
  const suggestions = useSuggestStore((s) => s.data?.suggestions);
  // a routine made from a suggestion starts its prompt with run rules, so its row shows what it does
  const summary = (r: Routine) => {
    const s = r.suggestion ? suggestions?.find((x) => x.id === r.suggestion) : undefined;
    return s ? whatWords(s.description) : firstLine(r.prompt);
  };
  // a routine from a suggestion that a newer one replaced keeps working and says so
  const replacedBy = (r: Routine) => {
    const s = r.suggestion ? suggestions?.find((x) => x.id === r.suggestion) : undefined;
    return s?.replacedBy ? suggestions?.find((x) => x.id === s.replacedBy)?.name : undefined;
  };
  const [, navigate] = useLocation();
  const open = (r: Routine) => navigate(`/routines/${r.id}`);
  return (
    <table className="tbl">
      <caption className="sr-only">Routines</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Schedule</th>
          <th scope="col" className="r">
            Next run
          </th>
          <th scope="col">Last run</th>
          <th scope="col" className="max-xl:hidden">
            Runs as
          </th>
          <th scope="col">State</th>
          <th scope="col" className="w-8">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {routines.map((r) => {
          const agent = agentByName(r.agent);
          const model = r.model ?? agent?.model;
          return (
            <tr
              key={r.id}
              data-click=""
              tabIndex={0}
              aria-label={`${r.name}, ${describeSchedule(r.schedule)}${r.enabled ? '' : ', paused'}`}
              onClick={() => open(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target === e.currentTarget) open(r);
              }}
              className="group focus-visible:-outline-offset-2 focus-visible:[&>td]:bg-hover"
            >
              <td className="w-full max-w-0">
                <Link href={`/routines/${r.id}`} tabIndex={-1} className={cn('block truncate text-[13.5px] font-medium', r.enabled ? 'text-fg' : 'text-fg-2')} onClick={(e) => e.stopPropagation()}>
                  {r.name}
                </Link>
                <span className="mt-0.5 block truncate text-[12px] text-fg-3">
                  {replacedBy(r) && <span className="text-fg-2">Replaced by {replacedBy(r)}. </span>}
                  {summary(r)}
                </span>
              </td>
              <td className="whitespace-nowrap text-fg-2">
                <Tooltip content={<span className="font-mono">{r.schedule}{r.timezone ? ` ${r.timezone}` : ''}</span>} delay={350}>
                  <span>
                    {describeSchedule(r.schedule)}
                    {otherZone(r.timezone) && <span className="text-fg-3">, {otherZone(r.timezone)}</span>}
                  </span>
                </Tooltip>
              </td>
              <td className="r whitespace-nowrap text-fg-2">{r.enabled ? nextWords(nextRun(r, now), now) : ''}</td>
              <td className="whitespace-nowrap">
                <LastOutcome routine={r} runs={runs[r.id]} sessions={sessions} now={now} />
              </td>
              <td className="whitespace-nowrap text-fg-2 max-xl:hidden">
                <span className="inline-flex items-center">
                  {r.agent}
                  {model && (
                    <>
                      ,&nbsp;
                      <ModelName model={model} size={14} />
                    </>
                  )}
                </span>
              </td>
              <td className={cn('whitespace-nowrap', r.enabled ? 'text-fg-2' : 'text-fg-3')}>{r.enabled ? 'active' : 'paused'}</td>
              <td className="py-0 align-middle">
                <RowMenu routine={r} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Run now, Pause or Resume, Duplicate, Delete. Clicks stay out of the row. */
export function RowMenu({ routine, size = 'sm' }: { routine: Routine; size?: 'sm' | 'md' }) {
  const act = useRoutineActions(routine);
  const items: MenuItem[] = [
    { label: 'Run now', onSelect: act.runNow },
    { label: routine.enabled ? 'Pause' : 'Resume', onSelect: act.toggle },
    { label: 'Duplicate', onSelect: act.duplicate },
    { separator: true, label: '' },
    { label: 'Delete', danger: true, onSelect: act.askDelete },
  ];
  const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();
  return (
    <span onClick={stop} onKeyDown={stop} className="inline-flex">
      <Menu
        label={`${routine.name} actions`}
        items={items}
        trigger={({ ref, props }) => (
          <IconButton ref={ref} label={`${routine.name} actions`} size={size} tooltip={false} {...props}>
            <MoreHorizontal />
          </IconButton>
        )}
      />
      {act.dialogs}
    </span>
  );
}

/** The current time above the axis' now line, so the line reads without hovering. */
function NowLabel({ now }: { now: number }) {
  const at = ((now - dayStart(now)) / 86_400_000) * 100;
  return (
    <div aria-hidden className="relative mt-4 h-4 font-mono text-[11px] leading-4 font-[450] text-signal">
      <span className="absolute" style={{ left: `${at}%`, transform: `translateX(${at < 4 ? '0' : at > 96 ? '-100%' : '-50%'})` }}>
        {hhmm(now)}
      </span>
    </div>
  );
}
