/**
 * Canvas mode, PR 1 (docs/design/CANVAS-MODE.md): the shell and a read-only
 * canvas over the graph views that ship (features/graph).
 *
 *   /canvas                      the files: programs and workflows
 *   /canvas/program/<name>       flows/<name>.flow.ts, ?device=&cwd= say whose folder
 *   /canvas/workflow/<id or run> a workflow (lit by its last run) or one run (wfr_...)
 *
 * A computer gets the spec's layout: a top bar, the node library (read
 * only) at the left, the canvas with a faint dot grid and a minimap, the
 * inspector in its own column at the right (it never covers the canvas)
 * and Output, Logs and Queue under it. The app sidebar folds to its strip
 * while a file is open. A phone gets the canvas full screen under its bar,
 * with Nodes and Output as floating buttons that open sheets, and opens on
 * the running or failed block. Edits, Run and the agent come in later PRs.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { nodeRuns, type FlowBlockSpec, type FlowRunView, type FlowView, type GraphNode, type WorkflowGraphView, type WorkflowRunDetail } from '@conclave/core/client';
import { Elapsed } from '@/components/motion/Elapsed';
import { CodeBlock } from '@/components/ui/Code';
import { LoadingRows } from '@/components/ui/EmptyState';
import { ListRow } from '@/components/ui/List';
import { Menu, Sheet } from '@/components/ui/Overlay';
import { Page, PageHeader } from '@/components/ui/Page';
import { Notice, Section } from '@/components/ui/Section';
import { Tabs } from '@/components/ui/Tags';
import { PhoneBar } from '@/components/PhoneFrame';
import { setRailOpen, useChatUi } from '@/features/conversation/state';
import { setStartMode } from '@/features/home/start';
import { api } from '@/lib/api';
import { hhmm } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { GraphCanvas, INSERTS } from '../graph/GraphCanvas';
import { runWords } from '../graph/FlowView';
import { Inspector } from '../graph/Inspector';
import { blockLine, liveState, stateTone } from '../graph/nodes';
import { useRunDetail, useRuns } from '../workflows/data';
import { isLive, RUN_WORD } from '../workflows/words';
import { useCanvasFiles } from './files';
import { fileGroups, fileHref, fileTitle, focusNode, isRunId, rememberFile, sessionFor } from './model';

type Tab = 'output' | 'logs' | 'queue';
const POLL_MS = 700;
const flowLive = (r?: FlowRunView) => r?.status === 'running' || r?.status === 'approval';

export default function CanvasPage() {
  const { kind, name } = useParams<{ kind?: string; name?: string }>();
  const [loc] = useLocation();
  const search = useSearch();
  // the mode follows the page, and the file open is the one Canvas comes back to
  useEffect(() => setStartMode('canvas'), []);
  useEffect(() => {
    if (kind && name) rememberFile(`${loc}${search ? `?${search}` : ''}`);
  }, [kind, name, loc, search]);
  if (kind === 'program' && name) return <ProgramFile key={`${name}?${search}`} name={name} />;
  if (kind === 'workflow' && name) return isRunId(name) ? <RunFile key={name} runId={name} /> : <WorkflowFile key={name} id={name} />;
  return <CanvasStart />;
}

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

function CanvasStart() {
  const phone = useIsMobile();
  const { files, loading, folderLabel } = useCanvasFiles();
  const groups = fileGroups(files, folderLabel);
  return (
    <>
      {phone && <PhoneBar title="Canvas" />}
      <Page width="column">
        <PageHeader title="Canvas" sub="Programs and workflows as blocks, with their runs. Open one to see it as a graph." />
        {loading && !files.length && <LoadingRows loading rows={4} />}
        {!loading && !files.length && <Notice>No programs or workflows yet. A program is flows/&lt;name&gt;.flow.ts in a Code session's folder; ask the agent there for one.</Notice>}
        {groups.map((g) => (
          <Section key={g.label} title={g.label} className="mt-6">
            {g.files.map((f) => (
              <ListRow key={fileHref(f)} href={fileHref(f)} title={fileTitle(f)} state={f.kind === 'workflow' ? (f.live ? 'running' : f.failed ? 'failed' : undefined) : undefined} stateTone={f.kind === 'workflow' && f.live ? 'signal' : 'fault'} />
            ))}
          </Section>
        ))}
      </Page>
    </>
  );
}

// ---------------------------------------------------------------------------
// One file of each kind: they load, then hand the shell what to show
// ---------------------------------------------------------------------------

function ProgramFile({ name }: { name: string }) {
  const q = new URLSearchParams(useSearch());
  const device = q.get('device') ?? '';
  const cwd = q.get('cwd') ?? '';
  const booted = useHub((s) => s.booted);
  const session = useHub((s) => sessionFor(Object.values(s.sessions), device, cwd));
  const sid = session?.id;
  const [view, setView] = useState<FlowView>();
  const [run, setRun] = useState<FlowRunView>();
  const [blocks, setBlocks] = useState<FlowBlockSpec[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => void api().flowBlocks().then(setBlocks).catch(() => {}), []);
  useEffect(() => {
    if (!sid) return;
    let alive = true;
    api()
      .flowGraph(sid, name)
      .then((v) => alive && (setView(v), setRun((r) => (flowLive(r) ? r : v.lastRun))))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [sid, name]);
  // a run goes on in the background: ask for it until it ends
  useEffect(() => {
    if (!sid || !flowLive(run)) return;
    const t = setInterval(() => void api().flowRun(sid, name).then((r) => r && setRun(r)).catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [sid, name, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const bySpec = useMemo(() => new Map(blocks.map((b) => [b.block, b])), [blocks]);
  const flow = useMemo(() => ({ blocks: bySpec, live: run?.nodes }), [bySpec, run?.nodes]);
  const title = `${name}.flow.ts`;
  const where = [cwd, device && `on ${device}`].filter(Boolean).join(' ');
  if (booted && !session) return <Missing title={title}>No Code session works in {where || 'that folder'}, so the hub cannot read its flows. Start one there, then open the file again.</Missing>;
  if (error) return <Missing title={title}>The program did not load. {error}</Missing>;
  if (!view) return <Loading title={title} />;
  const failed = Object.entries(run?.nodes ?? {}).filter(([, n]) => !n.ok);
  const status = run ? { word: run.status === 'running' ? 'Running' : run.status === 'done' ? 'Done' : run.status === 'failed' ? 'Failed' : runWords(run), tone: run.status === 'running' ? 'text-signal' : run.status === 'failed' ? 'text-fault' : run.status === 'done' ? 'text-ok' : 'text-fg-2', rest: run.status === 'failed' ? (failed.length ? `at ${failed.map(([id]) => view.graph.nodes.find((n) => n.id === id)?.label ?? id).join(', ')}` : (run.error ?? '')) : run.status === 'running' ? `${Object.keys(run.nodes).length} blocks done` : '', since: run.status === 'running' ? run.startedAt : undefined } : { word: 'Not run yet', tone: 'text-fg-3', rest: '' };
  return (
    <Shell
      title={title}
      meta={['Program', where].filter(Boolean).join(', ')}
      status={status}
      graph={view.graph}
      focus={focusNode(view.graph.nodes.map((n) => ({ id: n.id, state: liveState(run?.nodes[n.id]) })))}
      canvas={(sel, onSelect, phone) => <GraphCanvas graph={view.graph} positions={view.layout} selected={sel} onSelect={onSelect} flow={flow} full={{ focus: phone ? focusNode(view.graph.nodes.map((n) => ({ id: n.id, state: liveState(run?.nodes[n.id]) }))) : undefined }} className="min-h-0 flex-1" />}
      library={blocks.map((b) => ({ word: b.title, help: b.help, group: b.family }))}
      inspector={(node) => <BlockFacts node={node} spec={node.block ? bySpec.get(node.block) : undefined} run={run} />}
      output={run?.output || run?.error || ''}
      logs={[]}
    />
  );
}

function RunFile({ runId }: { runId: string }) {
  const { data, error } = useRunDetail(runId);
  const [view, setView] = useState<WorkflowGraphView>();
  const [gErr, setGErr] = useState<string>();
  useEffect(() => {
    let alive = true;
    api()
      .workflowRunGraph(runId)
      .then((v) => alive && setView(v))
      .catch((e) => alive && setGErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [runId]);
  const title = data?.run.name ?? runId;
  if (error || gErr) return <Missing title={title}>The run did not load. {error ?? gErr}</Missing>;
  if (!data || !view) return <Loading title={title} />;
  return <WorkflowShell view={view} detail={data} title={title} meta={`Run of ${data.run.name}, ${hhmm(data.run.createdAt)}, read only`} />;
}

function WorkflowFile({ id }: { id: string }) {
  const [view, setView] = useState<WorkflowGraphView>();
  const [lastRun, setLastRun] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    Promise.all([api().workflowGraph(id), api().workflow(id)])
      .then(([v, d]) => alive && (setView(v), setLastRun(d.lastRun?.id)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id]);
  const { data } = useRunDetail(lastRun);
  if (error) return <Missing title={id}>The workflow did not load. {error}</Missing>;
  if (!view) return <Loading title={id} />;
  return <WorkflowShell view={view} detail={data} title={view.graph.name || id} meta={['Workflow', view.source === 'builtin' || view.source === 'plugin' ? 'library' : 'yours', 'read only'].join(', ')} />;
}

function WorkflowShell({ view, detail, title, meta }: { view: WorkflowGraphView; detail?: WorkflowRunDetail; title: string; meta: string }) {
  const runs = useMemo(() => (detail ? nodeRuns(view.graph, detail.calls) : undefined), [view.graph, detail]);
  const r = detail?.run;
  const live = !!r && isLive(r.status);
  const states = view.graph.nodes.map((n) => ({ id: n.id, state: runs?.byNode.get(n.id)?.state }));
  const focus = focusNode(states);
  const failed = states.filter((s) => s.state === 'failed');
  const status = r ? { word: RUN_WORD[r.status].replace(/^./, (c) => c.toUpperCase()), tone: live ? 'text-signal' : r.status === 'failed' ? 'text-fault' : r.status === 'done' ? 'text-ok' : 'text-fg-2', rest: [r.phaseTitle && live ? `in ${r.phaseTitle}` : '', failed.length ? `${failed.length} failed` : ''].filter(Boolean).join(', '), since: live ? (r.startedAt ?? r.createdAt) : undefined } : { word: 'Not run yet', tone: 'text-fg-3', rest: '' };
  return (
    <Shell
      title={title}
      meta={meta}
      status={status}
      graph={view.graph}
      focus={focus}
      links={r ? [{ label: 'Open the run', href: `/workflows/runs/${r.id}` }] : []}
      canvas={(sel, onSelect, phone) => <GraphCanvas graph={view.graph} runs={runs?.byNode} stale={view.stale} positions={view.layout} selected={sel} currentPhase={live ? r?.phaseTitle : undefined} onSelect={onSelect} full={{ focus: phone ? focus : undefined }} className="min-h-0 flex-1" />}
      library={INSERTS.map((i) => ({ word: i.word, help: i.help, group: 'Workflow' }))}
      inspector={(node) => {
        const nr = runs?.byNode.get(node.id);
        const calls = nr && detail ? detail.calls.filter((c) => nr.seqs.includes(c.seq)) : [];
        return <Inspector node={node} run={nr} calls={calls} runCtx={r ? { id: r.id, name: r.name, sessionId: r.sessionId, live } : undefined} />;
      }}
      output={r?.error ?? (detail?.result !== undefined ? JSON.stringify(detail.result, null, 2) : '')}
      logs={(detail?.logs ?? []).map((l) => [hhmm(l.ts), l.text] as const)}
    />
  );
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

interface ShellProps {
  title: string;
  meta: string;
  status: { word: string; tone: string; rest: string; since?: number };
  graph: { nodes: GraphNode[] };
  focus?: string;
  links?: Array<{ label: string; href: string }>;
  canvas: (sel: string | undefined, onSelect: (id: string | undefined) => void, phone: boolean) => ReactNode;
  library: Array<{ word: string; help: string; group: string }>;
  inspector: (node: GraphNode) => ReactNode;
  output: string;
  logs: ReadonlyArray<readonly [string, string]>;
}

/** Full screen on a computer: the sidebar folds to its strip while a file is open, and comes back after. */
function useFullScreen(phone: boolean) {
  useEffect(() => {
    if (phone) return;
    const was = useChatUi.getState().railOpen;
    setRailOpen(false);
    return () => setRailOpen(was);
  }, [phone]);
}

function Shell(p: ShellProps) {
  const phone = useIsMobile();
  // a computer opens with the running or failed node in the inspector; a phone with nothing over the canvas
  const [sel, setSel] = useState<string | undefined>(phone ? undefined : p.focus);
  const [tab, setTab] = useState<Tab>(p.logs.length ? 'logs' : 'output');
  const [panel, setPanel] = useState(true);
  const [sheet, setSheet] = useState<'library' | 'output'>();
  useFullScreen(phone);
  const node = p.graph.nodes.find((n) => n.id === sel);
  const statusLine = (
    <span className="min-w-0 truncate" aria-live="polite">
      <span className={cn('cv-state font-medium', p.status.tone)}>{p.status.word}</span>
      {p.status.since && (
        <>
          {' '}
          <Elapsed since={p.status.since} className="num text-fg-2" />
        </>
      )}
      {p.status.rest && <span className="text-fg-3">, {p.status.rest}</span>}
    </span>
  );
  const bottom = <BottomPanel tab={tab} setTab={setTab} output={p.output} logs={p.logs} phone={phone} />;
  const library = <Library items={p.library} />;
  const facts = (
    <div className="space-y-3 px-5 py-4">
      <div className="t-title mono text-fg">{p.title}</div>
      <p className="m-0 text-[13px] text-fg-2">{p.graph.nodes.length} blocks. Pick one to see its settings, its calls and its last value.</p>
      <p className="m-0 text-[12px] text-fg-3">{p.meta}.</p>
    </div>
  );

  if (phone)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PhoneBar title={p.title} />
        <div className="flex h-9 shrink-0 items-center border-b border-rule px-4 text-[13px]">{statusLine}</div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {p.canvas(sel, setSel, true)}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-2 px-3 pb-[calc(12px+var(--safe-b,0px))]">
            {(['library', 'output'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSheet(s)} className="pointer-events-auto h-11 rounded-[var(--r-2)] border border-rule-2 bg-raise px-4 text-[15px] text-fg shadow-[var(--shadow-pop)]">
                {s === 'library' ? 'Nodes' : 'Output'}
              </button>
            ))}
          </div>
        </div>
        <Sheet open={sheet === 'library'} onClose={() => setSheet(undefined)} title="Nodes">
          <div className="px-3 pb-3">{library}</div>
        </Sheet>
        <Sheet open={sheet === 'output'} onClose={() => setSheet(undefined)} title="Run">
          <div className="px-4 pb-4">{bottom}</div>
        </Sheet>
        <Sheet open={!!node} onClose={() => setSel(undefined)} label={node?.label ?? 'Node'} className="cv-inspector">
          {node && p.inspector(node)}
        </Sheet>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule px-4">
        <FileMenu title={p.title} />
        <span className="shrink-0 truncate text-[12px] text-fg-3">{p.meta}</span>
        <span className="mx-2 h-4 w-px shrink-0 bg-rule" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px]">{statusLine}</span>
        {p.links?.map((l) => (
          <Link key={l.href} href={l.href} className="shrink-0 text-[13px] text-fg-2 underline underline-offset-2 hov:text-fg">
            {l.label}
          </Link>
        ))}
      </header>
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Node library" className="flex w-[216px] shrink-0 flex-col border-r border-rule">
          <div className="flex h-10 shrink-0 items-center px-3 text-[12px] font-medium text-fg-3">Nodes</div>
          <div className="scroll-y min-h-0 flex-1 px-2 pb-2">{library}</div>
          <p className="m-0 border-t border-rule px-3 py-2 text-[12px] leading-[1.45] text-fg-3">Read only for now: adding and wiring blocks comes next.</p>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {p.canvas(sel, setSel, false)}
          <div className={cn('shrink-0 border-t border-rule', panel ? 'h-[208px]' : 'h-9')}>
            <div className="flex h-9 items-center gap-3 px-3">
              <button type="button" aria-expanded={panel} aria-label={panel ? 'Fold the run panel' : 'Show the run panel'} onClick={() => setPanel(!panel)} className="grid size-6 place-items-center rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg">
                {panel ? <ChevronDown className="size-3.5" strokeWidth={1.75} /> : <ChevronRight className="size-3.5" strokeWidth={1.75} />}
              </button>
              <PanelTabs tab={tab} setTab={(t) => (setTab(t), setPanel(true))} logs={p.logs.length} />
            </div>
            {panel && <div className="scroll-y h-[172px] px-3 pb-2">{bottom}</div>}
          </div>
        </div>
        {/* its own column: the inspector never covers the canvas */}
        <aside aria-label="Inspector" className="cv-inspector scroll-y w-[320px] shrink-0 border-l border-rule">
          {node ? p.inspector(node) : facts}
        </aside>
      </div>
    </div>
  );
}

function FileMenu({ title }: { title: string }) {
  const [, navigate] = useLocation();
  const { files } = useCanvasFiles();
  return (
    <Menu
      label="Open a file"
      placement="bottom-start"
      width={300}
      items={[
        { group: true, label: 'Programs and workflows' },
        ...files.slice(0, 20).map((f) => ({ label: fileTitle(f), detail: f.kind === 'program' ? f.cwd : f.group === 'runs' ? 'run' : f.group, checked: fileTitle(f) === title, onSelect: () => navigate(fileHref(f)) })),
        { separator: true, label: '' },
        { label: 'All of Canvas', onSelect: () => navigate('/canvas') },
      ]}
      trigger={({ ref, props }) => (
        <button ref={ref} type="button" {...props} className="flex h-8 min-w-0 items-center gap-1.5 rounded-[var(--r-1)] px-1.5 hov:bg-hover">
          <span className="mono truncate text-[13px] font-medium text-fg">{title}</span>
          <ChevronDown className="size-3 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden />
        </button>
      )}
    />
  );
}

/** The blocks this kind of file can hold, by family. Read only in PR 1. */
function Library({ items }: { items: ShellProps['library'] }) {
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g}>
          <div className="px-1 pb-1 text-[12px] font-medium text-fg-3">{g}</div>
          {items
            .filter((i) => i.group === g)
            .map((i) => (
              <div key={i.word} className="rounded-[var(--r-1)] px-2 py-1.5 phone:py-2">
                <div className="text-[13px] text-fg phone:text-[15px]">{i.word}</div>
                <div className="truncate text-[12px] text-fg-3 phone:text-[13px]">{i.help}</div>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function PanelTabs({ tab, setTab, logs }: { tab: Tab; setTab: (t: Tab) => void; logs: number }) {
  return <Tabs<Tab> value={tab} onChange={setTab} label="Run panel" options={[{ value: 'output', label: 'Output' }, { value: 'logs', label: 'Logs', count: logs || undefined }, { value: 'queue', label: 'Queue' }]} />;
}

function BottomPanel({ tab, setTab, output, logs, phone }: { tab: Tab; setTab: (t: Tab) => void; output: string; logs: ShellProps['logs']; phone: boolean }) {
  return (
    <>
      {phone && (
        <div className="pb-3">
          <PanelTabs tab={tab} setTab={setTab} logs={logs.length} />
        </div>
      )}
      {tab === 'output' && (output ? <CodeBlock code={output} wrap /> : <p className="m-0 py-1 text-[13px] text-fg-3">Nothing printed yet.</p>)}
      {tab === 'logs' && (
        <div className="text-[12.5px] phone:text-[13px]">
          {!logs.length && <p className="m-0 py-1 text-fg-3">No log lines for this run.</p>}
          {logs.map(([t, line], i) => (
            <div key={i} className="grid grid-cols-[56px_minmax(0,1fr)] gap-2 border-b border-rule py-1 last:border-0">
              <span className="num text-fg-4">{t}</span>
              <span className="truncate text-fg-2">{line}</span>
            </div>
          ))}
        </div>
      )}
      {tab === 'queue' && <Queue />}
    </>
  );
}

/** Workflow runs going now, newest first. */
function Queue() {
  const { data } = useRuns({ limit: 20 });
  const live = (data ?? []).filter((r) => isLive(r.status));
  if (!live.length) return <p className="m-0 py-1 text-[13px] text-fg-3">Nothing running or queued.</p>;
  return (
    <>
      {live.map((r) => (
        <Link key={r.id} href={fileHref({ kind: 'workflow', id: r.name, name: r.name, group: 'runs', runId: r.id })} className="flex items-baseline gap-3 border-b border-rule py-1.5 text-[13px] last:border-0 hov:text-fg">
          <span className="mono min-w-0 flex-1 truncate text-fg">{r.name}</span>
          <span className={cn('shrink-0 text-[12px]', r.status === 'running' ? 'text-signal' : 'text-fg-3')}>{r.status === 'running' ? <Elapsed since={r.startedAt ?? r.createdAt} /> : RUN_WORD[r.status]}</span>
        </Link>
      ))}
    </>
  );
}

/** A program block: what it is, its last value or error, its code. Read only. */
function BlockFacts({ node, spec, run }: { node: GraphNode; spec?: FlowBlockSpec; run?: FlowRunView }) {
  const lv = run?.nodes[node.id];
  const tone = stateTone(liveState(lv));
  return (
    <div className="flex flex-col">
      <div className="border-b border-rule px-5 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="t-title mono min-w-0 truncate text-fg">{node.label}</div>
          {lv && <span className={cn('cv-state shrink-0 text-[13px]', tone.text)}>{lv.ok ? 'done' : 'failed'}</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-fg-3">
          {blockLine(node, spec)}. Lines {node.span.start} to {node.span.end}.
        </div>
      </div>
      <div className="space-y-5 px-5 py-4">
        {lv && !lv.ok && <Notice tone="fault">{lv.error ?? 'Failed.'}</Notice>}
        {lv?.ok && lv.value !== undefined && (
          <div>
            <div className="pb-1.5 text-[12px] font-medium text-fg-2">Value, last run{lv.ms !== undefined ? `, ${lv.ms} ms` : ''}</div>
            <CodeBlock code={lv.value} wrap maxLines={14} />
          </div>
        )}
        <div>
          <div className="pb-1.5 text-[12px] font-medium text-fg-2">Code</div>
          <CodeBlock code={node.source} lang="ts" wrap maxLines={16} />
        </div>
      </div>
    </div>
  );
}

function Loading({ title }: { title: string }) {
  const phone = useIsMobile();
  return (
    <>
      {phone && <PhoneBar title={title} />}
      <Page width="column">
        <LoadingRows loading rows={4} />
      </Page>
    </>
  );
}

function Missing({ title, children }: { title: string; children: ReactNode }) {
  const phone = useIsMobile();
  return (
    <>
      {phone && <PhoneBar title={title} />}
      <Page width="column">
        <PageHeader title={title} />
        <Notice tone="fault">{children}</Notice>
        <p className="mt-4 text-[13px]">
          <Link href="/canvas" className="link">
            All programs and workflows
          </Link>
        </p>
      </Page>
    </>
  );
}
