/**
 * One routine (spec 11.5): the name with its schedule and next run, Run now,
 * Pause or Resume, then two text tabs. Runs is a timeline grouped by day
 * with the result of each run and a link to its session; a details column
 * beside it says how the routine runs. Settings is the editor.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { MoreHorizontal } from 'lucide-react';
import type { Routine, RoutineRun, Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { agentByName, loadRuns, toast, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm, inTime, usd } from '@/lib/format';
import { useCopy, useIsMobile, useNow } from '@/lib/hooks';
import { dayStart, describeSchedule } from '@/lib/schedule';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Button, IconButton } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Overlay';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { Tabs } from '@/components/ui/Tags';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { ModelName } from '@/components/logo';
import { LiveStatus } from '@/components/motion';
import { RoutineEditor, dayDate, webhookUrl } from './RoutineEditor';
import { ON_BASELINE, SectionIndex } from './form';
import { NOTIFY_WORD, TRIGGER_WORD, dayHeading, nextRun, nextWords, otherZone, runState, tookWords, upcoming, withoutStatus } from './words';
import { useRoutineActions } from './actions';
import { isWatchRoutine } from '../watches/data';
import { FiltersDialog, WatchItemsTab } from '../watches/WatchPage';

export function RoutineDetail({ id }: { id: string }) {
  const routine = useHub((s) => s.routines[id]);
  const booted = useHub((s) => s.booted);
  const runs = useHub((s) => s.runs[id]);
  const search = useSearch();
  const [, navigate] = useLocation();
  // a watch opens on its items (features/watches); Runs and Settings are tabs beside them
  const watch = isWatchRoutine(routine);
  const asked = new URLSearchParams(search).get('tab');
  const tab = asked === 'settings' ? 'settings' : watch && asked !== 'runs' ? 'items' : 'runs';
  const [editing, setEditing] = useState(false);
  usePageHeader(routine?.name ?? 'Routine', '/routines');

  useEffect(() => {
    void loadRuns(id);
  }, [id]);

  if (!routine) {
    return (
      <Page width="column">
        <PageHeader title="Routine not found" />
        {booted && (
          <EmptyState wave={false} action={{ label: 'All routines', onClick: () => navigate('/routines') }}>
            This routine was deleted, or the link is wrong.
          </EmptyState>
        )}
      </Page>
    );
  }

  return (
    <Page key={id}>
      <Header routine={routine} runs={runs} onEditFilters={watch ? () => setEditing(true) : undefined} />
      <Tabs
        label="Routine"
        value={tab}
        className="mb-6 border-b border-rule pb-3"
        options={[
          ...(watch ? [{ value: 'items' as const, label: 'Items', href: `/routines/${id}` }] : []),
          { value: 'runs' as const, label: 'Runs', count: runs?.length, href: watch ? `/routines/${id}?tab=runs` : `/routines/${id}` },
          { value: 'settings' as const, label: 'Settings', href: `/routines/${id}?tab=settings` },
        ]}
      />
      {watch && <FiltersDialog key={JSON.stringify(routine.watch)} routine={routine} open={editing} onClose={() => setEditing(false)} />}
      {tab === 'items' ? (
        <WatchItemsTab routine={routine} onEdit={() => setEditing(true)} />
      ) : tab === 'settings' ? (
        <div className="grid grid-cols-[minmax(0,720px)_minmax(0,1fr)] gap-x-12 max-xl:grid-cols-1">
          <RoutineEditor initial={routine} routine={routine} onCancel={() => navigate(`/routines/${id}`)} />
          <SectionIndex items={SECTIONS} />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-x-0 max-lg:grid-cols-1">
          <div className="min-w-0 pr-7 max-lg:pr-0">
            <RunTimeline routine={routine} runs={runs} />
          </div>
          <div className="min-w-0 border-l border-rule pl-7 max-lg:mt-10 max-lg:border-l-0 max-lg:pl-0">
            <Details routine={routine} />
          </div>
        </div>
      )}
    </Page>
  );
}

function Header({ routine, runs, onEditFilters }: { routine: Routine; runs: RoutineRun[] | undefined; onEditFilters?: () => void }) {
  const now = useNow(30_000);
  const size = useIsMobile() ? 'touch' : 'md';
  const act = useRoutineActions(routine, { afterDelete: '/routines' });
  const running = runs?.some((r) => r.status === 'running');
  const zone = otherZone(routine.timezone);
  const sub = (
    <>
      {describeSchedule(routine.schedule)}
      {zone && ` ${zone} time`}
      {routine.enabled ? (
        nextRun(routine, now) ? (
          <>
            , next <span className="text-fg-2">{nextWords(nextRun(routine, now), now)}</span>
            {zone && ' your time'}
          </>
        ) : null
      ) : (
        <>, paused</>
      )}
    </>
  );
  return (
    <>
      <nav aria-label="Breadcrumb" className="pt-6 text-[12px] phone:hidden">
        <Link href="/routines" className="text-fg-3 hover:text-fg">
          Routines
        </Link>
      </nav>
      <PageHeader
        className="pt-1 phone:pt-4"
        title={<span className="phone:sr-only">{routine.name}</span>}
        sub={sub}
        actions={
          <>
            <Button variant="outline" size={size} onClick={act.runNow} disabled={running} title={running ? 'A run is in progress' : undefined}>
              Run now
            </Button>
            <Button variant="quiet" size={size} onClick={act.toggle}>
              {routine.enabled ? 'Pause' : 'Resume'}
            </Button>
            {onEditFilters && (
              <Button variant="quiet" size={size} onClick={onEditFilters}>
                Edit filters
              </Button>
            )}
            <Menu
              label={`${routine.name} actions`}
              items={[
                { label: 'Duplicate', onSelect: act.duplicate },
                { label: 'Copy webhook address', onSelect: () => void navigator.clipboard?.writeText(webhookUrl(routine)).then(() => toast({ title: 'Copied the webhook address.' })) },
                { separator: true, label: '' },
                { label: 'Delete', danger: true, onSelect: act.askDelete },
              ]}
              trigger={({ ref, props }) => (
                <IconButton ref={ref} label="More actions" size={size} {...props}>
                  <MoreHorizontal />
                </IconButton>
              )}
            />
          </>
        }
      />
      {act.dialogs}
    </>
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function RunTimeline({ routine, runs }: { routine: Routine; runs: RoutineRun[] | undefined }) {
  const sessions = useHub((s) => s.sessions);
  const act = useRoutineActions(routine);
  const now = useNow(60_000);
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => [...(runs ?? [])].sort((a, b) => b.startedAt - a.startedAt), [runs]);
  const shown = all ? sorted : sorted.slice(0, 30);
  const groups = useMemo(() => {
    const out: Array<{ day: string; runs: RoutineRun[] }> = [];
    for (const r of shown) {
      const day = r.status === 'running' ? 'Now' : dayHeading(r.startedAt, now);
      const g = out[out.length - 1];
      if (g?.day === day) g.runs.push(r);
      else out.push({ day, runs: [r] });
    }
    return out;
  }, [shown, now]);

  if (!runs) return <LoadingRows loading rows={5} />;
  if (!runs.length)
    return (
      <EmptyState action={{ label: 'Run now', onClick: act.runNow }}>
        No runs yet. {routine.enabled && nextRun(routine, now) ? `The first one is ${nextWords(nextRun(routine, now), now)}, or run it now to see what it does.` : 'Run it now to see what it does.'}
      </EmptyState>
    );

  const failed = sorted.filter((r) => r.status === 'error').length;
  return (
    <section aria-labelledby="runs-h">
      <SectionHeading
        id="runs-h"
        count={sorted.length}
        right={
          <span className="text-[12px] text-fg-3 phone:text-[13px]">
            {failed ? <span className="text-fault">{failed} failed</span> : 'none failed'}
            {sorted.length > 1 && ` since ${sinceWords(sorted[sorted.length - 1].startedAt)}`}
          </span>
        }
      >
        History
      </SectionHeading>
      {groups.map((g) => (
        <Fragment key={g.day}>
          <h3 className={cn('pt-5 pb-1.5 text-[12px] font-semibold phone:text-[13px]', g.day !== 'Now' ? 'text-fg-3' : g.runs.some((r) => runState(r, r.sessionId ? sessions[r.sessionId] : undefined).word === 'running') ? 'text-signal' : 'text-warn')}>{g.day}</h3>
          <ol className="rows border-t border-rule">
            {g.runs.map((r) => (
              <RunRow key={r.id} run={r} session={r.sessionId ? sessions[r.sessionId] : undefined} />
            ))}
          </ol>
        </Fragment>
      ))}
      {!all && sorted.length > shown.length && (
        <div className="mt-3">
          <TextAction label={`Show all ${sorted.length} runs`} onClick={() => setAll(true)} />
        </div>
      )}
    </section>
  );
}

function sinceWords(ts: number): string {
  if (ts >= dayStart(Date.now())) return hhmm(ts);
  const d = new Date(ts);
  return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`;
}

function RunRow({ run, session }: { run: RoutineRun; session?: Session }) {
  const st = runState(run, session);
  const href = run.sessionId ? `/s/${run.sessionId}` : undefined;
  const cost = session?.stats.costUsd;
  const meta = [TRIGGER_WORD[run.trigger], tookWords(run), cost ? usd(cost) : undefined].filter(Boolean).join(', ');

  let result;
  if (st.word === 'running')
    result = (
      <span className="flex min-h-5 items-center">
        <LiveStatus state="tool" label="Running" startedAt={run.startedAt} />
      </span>
    );
  else if (st.word === 'waiting on you')
    result = (
      <span className="text-warn">
        Waiting on you. The session needs {session?.status === 'waiting_input' ? 'an answer' : 'an approval'}.
      </span>
    );
  else if (run.status === 'error')
    result = (
      <span className="text-fg">
        <span className="text-fault">Failed.</span> {run.error ?? 'No detail from the hub.'}
      </span>
    );
  else if (run.status === 'skipped')
    result = (
      <span className="text-fg-2">
        Skipped.{run.summary ? ` ${run.summary}.` : run.error ? ` ${run.error}.` : ''}
      </span>
    );
  else {
    const text = withoutStatus(run.summary);
    result = (
      <span className="text-fg">
        {st.word === 'problem' && <span className="text-fault">Problem. </span>}
        {st.word === 'needs a look' && <span className="text-warn">Needs a look. </span>}
        {text ?? (run.outcome === 'ok' ? 'All good.' : 'Finished.')}
      </span>
    );
  }
  const denied = run.denied ?? [];

  return (
    <li className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2.5 phone:grid-cols-[46px_minmax(0,1fr)] phone:py-3">
      <time dateTime={new Date(run.startedAt).toISOString()} className="font-mono text-[12px] text-fg-3 phone:text-[13px]">
        {hhmm(run.startedAt)}
      </time>
      <div className="min-w-0">
        <p className="text-[14px] leading-[1.45] phone:text-[15px]">{result}</p>
        {denied.length > 0 && (
          <p className="mt-1 text-[12.5px] leading-[1.45] text-fg-2 phone:text-[13.5px]">
            <span className="text-warn">
              {denied.length === 1 ? '1 call was' : `${denied.length} calls were`} refused while you were away:
            </span>{' '}
            <span className="font-mono text-[12px] [overflow-wrap:anywhere]">{denied[0].input || denied[0].tool}</span>
            {denied.length > 1 && <span className="text-fg-3">, and {denied.length - 1} more in the session</span>}
          </p>
        )}
        <p className="mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">
          {meta}
          {href && (
            <span className="lg:hidden">
              {meta && ', '}
              <Link href={href} className="link text-fg-3">
                open session
              </Link>
            </span>
          )}
        </p>
      </div>
      <span className="text-right max-lg:hidden">{href && <TextAction label="Open session" href={href} />}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Details column
// ---------------------------------------------------------------------------

function Details({ routine }: { routine: Routine }) {
  const devices = useHub((s) => s.devices);
  const [copied, copy] = useCopy();
  const [next, setNext] = useState<number[] | null>(null);
  const agent = agentByName(routine.agent);
  const model = routine.model ?? agent?.model;
  const device = routine.device ?? agent?.device;
  useNow(60_000);

  const local = upcoming(routine);
  useEffect(() => {
    if (local) return;
    let live = true;
    api()
      .previewSchedule(routine.schedule, routine.timezone)
      .then((r) => live && setNext(r.next))
      .catch(() => live && setNext([]));
    return () => {
      live = false;
    };
  }, [routine.schedule, routine.timezone, routine.nextRunAt]);

  const settings = `/routines/${routine.id}?tab=settings`;
  return (
    <div className="space-y-7">
      <section aria-labelledby="next-h">
        <SectionHeading id="next-h" action={{ label: 'Change', href: `${settings}#when` }}>
          Next runs
        </SectionHeading>
        {!routine.enabled ? (
          <p className="py-2.5 text-[13px] text-fg-3">Paused. Resume it to schedule runs again.</p>
        ) : !local && next === null ? (
          <p className="py-2.5 text-[13px] text-fg-3">Asking the hub</p>
        ) : !(local ?? next)?.length ? (
          <p className="py-2.5 text-[13px] text-fg-3">Nothing scheduled.</p>
        ) : (
          <ol className="pt-1.5">
            {(local ?? next ?? []).slice(0, 5).map((t) => (
              <li key={t} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-[5px] text-[13px] phone:text-[14px]">
                <span className="grid grid-cols-[88px_auto] items-baseline text-fg-2">
                  <span>{dayDate(t)}</span>
                  <span className="font-mono text-[12.5px] font-normal text-fg">{hhmm(t)}</span>
                </span>
                <span className="num text-[12px] text-fg-3">{inTime(t)}</span>
              </li>
            ))}
          </ol>
        )}
        {routine.enabled && <ZoneNote tz={routine.timezone} />}
      </section>

      <section aria-labelledby="how-h">
        <SectionHeading id="how-h" action={{ label: 'Edit', href: settings }}>
          How it runs
        </SectionHeading>
        <dl className="pt-1.5">
          <Fact k="Schedule">
            {describeSchedule(routine.schedule)}
            {routine.timezone && <span className="text-fg-3">, {routine.timezone}</span>}
          </Fact>
          <Fact k="Agent">
            <Link href={`/agents/${encodeURIComponent(routine.agent)}`} className="hover:underline">
              {routine.agent}
            </Link>
          </Fact>
          {model && (
            <Fact k="Model">
              <ModelName model={model} size={14} className={ON_BASELINE} />
              {!routine.model && <span className="ml-1 text-fg-3">from the agent</span>}
            </Fact>
          )}
          <Fact k="Device">{device ? (devices[device]?.name ?? device) : 'Agent default'}</Fact>
          <Fact k="Folder" mono={!!routine.cwd}>
            {routine.cwd ?? <span className="text-fg-3">home</span>}
          </Fact>
          <Fact k="Sessions">
            {routine.sessionPolicy === 'reuse' ? (
              routine.sessionId ? (
                <>
                  Keeps{' '}
                  <Link href={`/s/${routine.sessionId}`} className="link">
                    one session
                  </Link>
                </>
              ) : (
                'Keeps one session'
              )
            ) : (
              'New each run'
            )}
          </Fact>
          <Fact k="Notify">{NOTIFY_WORD[routine.notify] ?? 'On failure'}</Fact>
          <Fact k="Away">
            {routine.onApproval === 'wait' ? 'Waits for your approval' : 'Refuses calls that need approval'}
            {routine.allow?.length ? (
              <span className="text-fg-3">
                , {routine.allow.length} {routine.allow.length === 1 ? 'rule allows' : 'rules allow'} calls
              </span>
            ) : null}
          </Fact>
          {routine.precheck && (
            <Fact k="Precheck" mono>
              {routine.precheck}
            </Fact>
          )}
        </dl>
      </section>

      <section aria-labelledby="hook-h">
        <SectionHeading id="hook-h" action={{ label: copied ? 'Copied' : 'Copy', onClick: () => copy(webhookUrl(routine)) }}>
          Webhook
        </SectionHeading>
        <p className="pt-2.5 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">A POST to this address runs it now.</p>
        <p className="mt-1 font-mono text-[12px] leading-[1.5] [overflow-wrap:anywhere] text-fg-2">{breakable(webhookUrl(routine))}</p>
      </section>
    </div>
  );
}

/** A URL with break points after each slash and before the query string. */
function breakable(url: string): React.ReactNode {
  return url.split(/(?<=\/)|(?=\?)/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

function Fact({ k, children, mono }: { k: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-baseline gap-x-3 py-[5px]">
      <dt className="text-[12px] text-fg-3 phone:text-[13px]">{k}</dt>
      <dd className={cn('m-0 min-w-0 text-[13px] text-fg phone:text-[14px]', mono && 'font-mono text-[12.5px] break-all')}>{children}</dd>
    </div>
  );
}

const SECTIONS: Array<[string, string]> = [
  ['what', 'What'],
  ['when', 'When'],
  ['who', 'Who and where'],
  ['after', 'After a run'],
  ['away', 'While you are away'],
  ['webhook', 'Webhook'],
  ['danger', 'Delete'],
];

/** Says whose clock the times are in when the routine runs on another zone's clock. */
function ZoneNote({ tz, className }: { tz?: string; className?: string }) {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!tz || tz === here) return null;
  return <p className={cn('pt-1.5 text-[12px] text-fg-3 phone:text-[13px]', className)}>Times shown in this device's zone, {here}.</p>;
}
