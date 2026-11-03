/**
 * The graph views (docs/design/VISUAL-PROGRAMMING.md 7.5), lazy-loaded so
 * React Flow stays out of the main chunk:
 * - RunGraph: a run's own script as a graph, lit from the same run detail the
 *   list shows (useRunDetail), with the inspector and Re-run this node.
 * - WorkflowGraphPage (/workflows/graph/:id): a library workflow's graph with
 *   Run, Re-run of the last run, the inspector and literal edits.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { nodeRuns, type WorkflowCall, type WorkflowGraphView, type WorkflowRunDetail } from '@conclave/core/client';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Button } from '@/components/ui/Button';
import { Sheet, SideSheet } from '@/components/ui/Overlay';
import { CodeBlock } from "@/components/ui/Code";
import { Notice } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { attempt } from '@/store/store';
import { isLive } from '../workflows/words';
import { GraphCanvas } from './GraphCanvas';
import { Inspector, type InspectorProps } from './Inspector';

function InspectorPanel({ open, onClose, props }: { open: boolean; onClose: () => void; props?: InspectorProps }) {
  const phone = useIsMobile();
  if (phone)
    return (
      <Sheet open={open} onClose={onClose} label={props?.node.label ?? 'Node'}>
        {props && <Inspector {...props} />}
      </Sheet>
    );
  return (
    <SideSheet open={open} onClose={onClose} width={480} modal={false} label={props?.node.label ?? 'Node'}>
      {props && <Inspector {...props} />}
    </SideSheet>
  );
}

export function RunGraph({ detail, onRerun, onWorktree }: { detail: WorkflowRunDetail; onRerun: (seqs: number[]) => void; onWorktree: InspectorProps['onWorktree'] }) {
  const [view, setView] = useState<WorkflowGraphView>();
  const [error, setError] = useState<string>();
  const [sel, setSel] = useState<string>();
  const run = detail.run;
  useEffect(() => {
    let alive = true;
    api()
      .workflowRunGraph(run.id)
      .then((v) => alive && setView(v))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
    // a resume or a re-run keeps the script; only a new run id needs a new graph
  }, [run.id]);
  const runs = useMemo(() => (view ? nodeRuns(view.graph, detail.calls) : undefined), [view, detail.calls]);
  if (error) return <Notice tone="fault">The graph did not load. {error}</Notice>;
  if (!view || !runs) return <LoadingRows loading rows={4} />;
  const node = view.graph.nodes.find((n) => n.id === sel);
  const nr = node ? runs.byNode.get(node.id) : undefined;
  const calls = nr ? detail.calls.filter((c) => nr.seqs.includes(c.seq)) : [];
  return (
    <>
      {view.stale?.length ? <p className="pb-2 text-[12px] text-fg-3">The workflow changed since this run: {view.stale.length} {view.stale.length === 1 ? 'node reads' : 'nodes read'} "changed since". An estimate; Re-run decides what runs again.</p> : null}
      <GraphCanvas graph={view.graph} runs={runs.byNode} stale={view.stale} selected={sel} currentPhase={isLive(run.status) ? run.phaseTitle : undefined} onSelect={setSel} className="h-[min(70vh,720px)] rounded-[var(--r-2)] border border-rule phone:h-[62vh]" />
      {runs.unplaced.length > 0 && <p className="pt-2 text-[12px] text-fg-3">{runs.unplaced.length} calls ran from code the graph does not show; the list has them.</p>}
      <InspectorPanel
        open={!!node}
        onClose={() => setSel(undefined)}
        props={node ? { node, run: nr, calls, runCtx: { id: run.id, name: run.name, sessionId: run.sessionId, live: isLive(run.status) }, onRerun, onWorktree } : undefined}
      />
    </>
  );
}

export default function WorkflowGraphPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [, go] = useLocation();
  const [view, setView] = useState<WorkflowGraphView>();
  const [lastRun, setLastRun] = useState<string>();
  const [diff, setDiff] = useState<string>();
  const [error, setError] = useState<string>();
  const [sel, setSel] = useState<string>();
  const [runDetail, setRunDetail] = useState<WorkflowRunDetail>();
  const phone = useIsMobile();
  usePageHeader(view?.graph.name || id, '/workflows');
  useEffect(() => {
    let alive = true;
    Promise.all([api().workflowGraph(id), api().workflow(id)])
      .then(([v, d]) => {
        if (!alive) return;
        setView(v);
        setLastRun(d.lastRun?.id);
        if (d.lastRun) void api().workflowRun(d.lastRun.id).then((r) => alive && setRunDetail(r)).catch(() => {});
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id]);
  const runs = useMemo(() => (view && runDetail ? nodeRuns(view.graph, runDetail.calls).byNode : undefined), [view, runDetail]);
  const start = (resume?: string) => void attempt(() => api().startWorkflow({ name: id, ...(resume ? { resumeFromRunId: resume } : {}) })).then((r) => r && go(`/workflows/runs/${r.id}?view=graph`));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start(lastRun);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (error)
    return (
      <Page>
        <PageHeader title="Workflow" />
        <Notice tone="fault">Failed. {error}</Notice>
      </Page>
    );
  if (!view)
    return (
      <Page>
        <LoadingRows loading rows={6} />
      </Page>
    );
  const node = view.graph.nodes.find((n) => n.id === sel);
  const nr = node && runs ? runs.get(node.id) : undefined;
  const calls: WorkflowCall[] = nr && runDetail ? runDetail.calls.filter((c) => nr.seqs.includes(c.seq)) : [];
  return (
    <Page>
      <nav aria-label="Breadcrumb" className="pt-6 text-[12px] phone:hidden">
        <Link href="/workflows" className="text-fg-3 hover:text-fg">
          Workflows
        </Link>
      </nav>
      <PageHeader
        title={<span className="phone:sr-only">{view.graph.name || id}</span>}
        className="pt-1 phone:pt-2 phone:pb-0"
        actions={
          <>
            {lastRun && (
              <Button variant="outline" size={phone ? 'touch' : 'md'} onClick={() => start(lastRun)}>
                Re-run
              </Button>
            )}
            <Button variant="solid" size={phone ? 'touch' : 'md'} onClick={() => start()}>
              Run
            </Button>
          </>
        }
      />
      <p className="pb-3 text-[12px] text-fg-3 phone:text-[13px]">
        {view.graph.nodes.length} nodes in {view.graph.phases.length || 1} {view.graph.phases.length === 1 ? 'phase' : 'phases'}. {view.editable ? 'Yours: settings save to the script.' : view.readOnly}
        {lastRun ? ' Re-run replays unchanged nodes from the last run.' : ''}
      </p>
      {diff && <CodeBlock code={diff} lang="diff" className="mb-3" />}
      <GraphCanvas graph={view.graph} runs={runs} selected={sel} onSelect={setSel} className="h-[min(74vh,780px)] rounded-[var(--r-2)] border border-rule phone:h-[66vh]" />
      <InspectorPanel
        open={!!node}
        onClose={() => setSel(undefined)}
        props={
          node
            ? {
                node,
                run: nr,
                calls,
                view,
                workflowId: id,
                onEdited: (v, d) => {
                  setView(v);
                  setDiff(d || undefined);
                },
              }
            : undefined
        }
      />
    </Page>
  );
}
