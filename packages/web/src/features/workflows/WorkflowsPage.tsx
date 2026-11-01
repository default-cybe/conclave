/**
 * Workflows (docs/WORKFLOWS.md, spec 3.18): /workflows is the library,
 * /workflows/runs every run newest first, /workflows/runs/:id one run.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import type { WorkflowRun, WorkflowSummary } from '@conclave/core/client';
import { Page, PageHeader } from '@/components/ui/Page';
import { Tabs } from '@/components/ui/Tags';
import { ListRow, MetaLine, StateWord } from '@/components/ui/List';
import { SectionHeading } from '@/components/ui/Section';
import { Table } from '@/components/ui/Table';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Section';
import { Elapsed } from '@/components/motion';
import { useHub } from '@/store/store';
import { compact, relTime, usd } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { useLibrary, useRuns } from './data';
import { RunSheet } from './RunSheet';
import { RunView } from './RunView';
import { RUN_TONE, RUN_WORD, SOURCE_WORD, isLive } from './words';

export default function WorkflowsPage() {
  const params = useParams<{ id?: string }>();
  const [loc] = useLocation();
  // a new id starts a new view: the last run must not stay on screen, or Stop act on it, while this one loads
  if (loc.startsWith('/workflows/runs/') && params.id) return <RunView key={params.id} id={params.id} />;
  if (loc.startsWith('/workflows/runs')) return <RunsList />;
  return <Library />;
}

function Header({ tab, sub }: { tab: 'library' | 'runs'; sub?: React.ReactNode }) {
  return (
    <PageHeader title="Workflows" sub={sub}>
      <Tabs
        label="Workflows"
        className="mt-3"
        value={tab}
        options={[
          { value: 'library', label: 'Library', href: '/workflows' },
          { value: 'runs', label: 'Runs', href: '/workflows/runs' },
        ]}
      />
    </PageHeader>
  );
}

const SOURCE_ORDER = ['builtin', 'project', 'user', 'plugin', 'claude-code', 'inline'] as const;
const SOURCE_HEADING: Record<string, string> = { builtin: 'Built in', project: 'This project', user: 'Yours', plugin: 'From plugins', 'claude-code': 'From Claude Code', inline: 'Scripts' };

function Library() {
  const { data, error } = useLibrary();
  const runs = useRuns({ limit: 20 });
  const [picked, setPicked] = useState<WorkflowSummary>();
  // ?run=<name> (the palette's Run a workflow) opens its run sheet once the library is in
  const run = new URLSearchParams(useSearch()).get('run');
  const [, navigate] = useLocation();
  useEffect(() => {
    const w = run ? data?.find((x) => x.name === run) : undefined;
    if (!w) return;
    setPicked(w);
    navigate('/workflows', { replace: true });
  }, [run, data, navigate]);
  const running = (runs.data ?? []).filter((r) => isLive(r.status)).length;
  const groups = useMemo(() => SOURCE_ORDER.map((s) => ({ source: s, items: (data ?? []).filter((w) => w.source === s) })).filter((g) => g.items.length), [data]);
  const now = useNow(60_000);

  return (
    <Page>
      <Header
        tab="library"
        sub={
          data ? (
            <>
              {data.length} in the library
              {running > 0 && (
                <span className="text-signal">
                  , {running} running
                </span>
              )}
            </>
          ) : undefined
        }
      />
      {error && <Notice tone="fault">Failed. {error}</Notice>}
      <LoadingRows loading={!data && !error} rows={6} />
      <div className="max-w-[960px] space-y-9 phone:space-y-8">
        {groups.map((g) => (
          <section key={g.source} aria-labelledby={`wf-${g.source}`}>
            <SectionHeading id={`wf-${g.source}`} count={g.items.length}>
              {SOURCE_HEADING[g.source]}
            </SectionHeading>
            <div className="rows">
              {g.items.map((w) => (
                <ListRow
                  key={w.id}
                  inset={false}
                  title={w.name}
                  onClick={() => setPicked(w)}
                  meta={<MetaLine parts={[w.description, SOURCE_WORD[w.source], !w.portable && w.source !== 'builtin' ? 'Conclave only' : null, !w.runnable ? <span className="text-fault">cannot load</span> : null]} />}
                  time={w.lastRun ? relTime(w.lastRun.finishedAt ?? w.lastRun.createdAt, now) : undefined}
                  state={w.lastRun ? <StateWord tone={RUN_TONE[w.lastRun.status]}>{RUN_WORD[w.lastRun.status]}</StateWord> : <span className="text-fg-3">never run</span>}
                />
              ))}
            </div>
          </section>
        ))}
        {data && !data.length && <EmptyState>Workflows saved in ~/.conclave/workflows or a project's .conclave/workflows show up here.</EmptyState>}
      </div>
      <RunSheet workflow={picked} onClose={() => setPicked(undefined)} />
    </Page>
  );
}

function RunsList() {
  const { data, error } = useRuns({ limit: 100 });
  const sessions = useHub((s) => s.sessions);
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const now = useNow(30_000);
  const live = (data ?? []).filter((r) => isLive(r.status)).length;
  const sessionTitle = (r: WorkflowRun) => (r.sessionId ? (sessions[r.sessionId]?.title ?? r.sessionId) : '');

  return (
    <Page>
      <Header
        tab="runs"
        sub={
          data ? (
            <>
              {data.length} {data.length === 1 ? 'run' : 'runs'}
              {live > 0 && <span className="text-signal">, {live} running</span>}
            </>
          ) : undefined
        }
      />
      {error && <Notice tone="fault">Failed. {error}</Notice>}
      <LoadingRows loading={!data && !error} rows={6} />
      {data && !data.length && <EmptyState pet action={{ label: 'Open the library', onClick: () => navigate('/workflows') }}>Runs show up here with their state, agents and cost.</EmptyState>}
      {data && data.length > 0 &&
        (phone ? (
          <div className="rows border-t border-rule-2">
            {data.map((r) => (
              <ListRow
                key={r.id}
                inset={false}
                href={`/workflows/runs/${r.id}`}
                title={r.name}
                meta={<MetaLine parts={[sessionTitle(r), `${r.counts.agents} agents`, usd(r.costUsd)]} />}
                time={relTime(r.createdAt, now)}
                state={r.status === 'running' ? <Elapsed since={r.startedAt ?? r.createdAt} format="short" className="text-signal" /> : <StateWord tone={RUN_TONE[r.status]}>{RUN_WORD[r.status]}</StateWord>}
              />
            ))}
          </div>
        ) : (
          <Table
            rowKey={(r: WorkflowRun) => r.id}
            onRowClick={(r: WorkflowRun) => navigate(`/workflows/runs/${r.id}`)}
            rows={data}
            columns={[
              { key: 'state', header: 'State', width: '150px', render: (r: WorkflowRun) => <StateWord tone={RUN_TONE[r.status]}>{RUN_WORD[r.status]}</StateWord> },
              { key: 'name', header: 'Workflow', title: true, render: (r: WorkflowRun) => r.name },
              {
                key: 'session',
                header: 'Session',
                dim: true,
                render: (r: WorkflowRun) =>
                  r.sessionId ? (
                    <Link href={`/s/${r.sessionId}`} onClick={(e) => e.stopPropagation()} className="hov:text-fg">
                      {sessionTitle(r)}
                    </Link>
                  ) : (
                    ''
                  ),
              },
              { key: 'agents', header: 'Agents', numeric: true, render: (r: WorkflowRun) => r.counts.agents, sort: (a: WorkflowRun, b: WorkflowRun) => a.counts.agents - b.counts.agents },
              { key: 'tokens', header: 'Tokens', numeric: true, render: (r: WorkflowRun) => compact(r.inputTokens + r.outputTokens), sort: (a: WorkflowRun, b: WorkflowRun) => a.inputTokens + a.outputTokens - (b.inputTokens + b.outputTokens) },
              { key: 'cost', header: 'Cost', numeric: true, render: (r: WorkflowRun) => usd(r.costUsd), sort: (a: WorkflowRun, b: WorkflowRun) => a.costUsd - b.costUsd },
              { key: 'started', header: 'Started', numeric: true, render: (r: WorkflowRun) => relTime(r.createdAt, now), sort: (a: WorkflowRun, b: WorkflowRun) => a.createdAt - b.createdAt },
            ]}
          />
        ))}
    </Page>
  );
}
