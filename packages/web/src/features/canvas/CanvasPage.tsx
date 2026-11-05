/**
 * Canvas mode, PR 1 (docs/design/CANVAS-MODE.md): the shell and a read-only
 * canvas over the graph views that ship (features/graph).
 *
 *   /canvas                      the files: programs and workflows
 *   /canvas/program/<name>       flows/<name>.flow.ts, ?device=&cwd= say whose folder
 *   /canvas/workflow/<id or run> a workflow (lit by its last run) or one run (wfr_...)
 *
 * A computer gets the spec's layout: a top bar, the node library (read
 * only, foldable from the top bar) at the left, the canvas with a faint dot grid and a minimap, the
 * inspector in its own column at the right (it never covers the canvas)
 * and Output, Logs and Queue under it. The app sidebar folds to its strip
 * while a file is open. A phone gets the canvas full screen under its bar,
 * with Nodes and Output as floating buttons that open sheets, and opens on
 * the running or failed block.
 *
 * PR 2 edits (editor.ts): a program in a session's folder and a workflow of
 * your own save every change to the file at once, with Undo and Redo in the
 * top bar and a Saved, Saving or Not saved status. Library workflows and
 * runs stay read only; a library workflow offers Duplicate to edit.
 *
 * PR 3 runs (run.ts): Run, Queue run while one goes on, Stop, the live run
 * in place on the nodes, Output, Logs and Queue under the canvas, a failed
 * node's Re-run and Ask the agent, and the Agent tab next to the inspector:
 * a Code session in the file's folder whose finished turn reloads the canvas.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { nodeRuns, type CanvasQueuedRun, type CanvasQueueInput, type WorkflowArgFieldDto, type FlowBlockSpec, type FlowOp, type FlowRunView, type FlowView, type GraphEditField, type GraphNode, type WorkflowGraphView, type WorkflowRunDetail } from '@conclave/core/client';
import { wireRefusal } from '@conclave/core/flows/ports';
import { Button } from '@/components/ui/Button';
import { Elapsed } from '@/components/motion/Elapsed';
import { CodeBlock } from '@/components/ui/Code';
import { LoadingRows } from '@/components/ui/EmptyState';
import { ListRow } from '@/components/ui/List';
import { Menu, Sheet } from '@/components/ui/Overlay';
import { Page, PageHeader } from '@/components/ui/Page';
import { Notice, Section } from '@/components/ui/Section';
import { Dialog } from '@/components/ui/Overlay';
import { Textarea } from '@/components/ui/Field';
import { isTyping } from '@/components/Shell';
import { MessageList } from '@/features/chat/MessageList';
import { ArgsForm, argsFromValues, type ArgValues } from '../workflows/args-form';
import { agentMessage, agentSessionOf, folderOf, headLeft, programStates, queueFile, rememberAgentSession, startGuard, workflowLive } from './run';
import { Tabs } from '@/components/ui/Tags';
import { Tooltip } from '@/components/ui/Tooltip';
import { PhoneBar } from '@/components/PhoneFrame';
import { useChatUi } from '@/features/conversation/state';
import { setStartMode } from '@/features/home/start';
import { api } from '@/lib/api';
import { hhmm } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { attempt, retainTranscript, sendQueued, toast, upsertSession, useHub } from '@/store/store';
import { DRAG_KIND, GraphCanvas, INSERTS } from '../graph/GraphCanvas';
import { FlowInspector, runWords } from '../graph/FlowView';
import { Inspector } from '../graph/Inspector';
import { liveState, stateTone } from '../graph/nodes';
import { useRunDetail, useRuns } from '../workflows/data';
import { isLive, RUN_WORD } from '../workflows/words';
import { useCanvasFiles } from './files';
import { fileGroups, fileHref, fileTitle, focusNode, isRunId, libraryOpen, rememberFile, saveLibraryOpen, sessionFor } from './model';
import { copyClip, pasteClip, programRenamable, removeOps, saveWords, useEditor, workflowRenamable, type Clip } from './editor';

type Positions = Record<string, { x: number; y: number }>;
const snap = (p: { x: number; y: number }) => ({ x: Math.round(p.x / 8) * 8, y: Math.round(p.y / 8) * 8 });

/** Ctrl/Cmd+C holds blocks of one file; a paste into another file is refused. Kept for the tab, not across reloads. */
let clipboard: Clip | undefined;

type Tab = 'output' | 'logs' | 'queue';
const POLL_MS = 700;
/** How often the Queue reads the hub's queue while the file runs or has runs waiting. */
const QUEUE_POLL_MS = 2000;
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
  const [positions, setPositions] = useState<Positions>({});
  const [selection, setSelection] = useState<string[]>([]);
  const take = useCallback((v: FlowView) => (setView(v), v.layout && setPositions(v.layout)), []);
  const ed = useEditor<FlowView>({
    view,
    setView: take,
    restore: (sha, base) => api().restoreFlow(sid!, name, sha, base).then((r) => r.view),
    reload: () => api().flowGraph(sid!, name),
  });
  useEffect(() => void api().flowBlocks().then(setBlocks).catch(() => {}), []);
  useEffect(() => {
    if (!sid) return;
    let alive = true;
    api()
      .flowGraph(sid, name)
      .then((v) => alive && (take(v), setRun((r) => (flowLive(r) ? r : v.lastRun))))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [sid, name, take]);
  // a run goes on in the background: ask for it until it ends
  useEffect(() => {
    if (!sid || !flowLive(run)) return;
    const t = setInterval(() => void api().flowRun(sid, name).then((r) => r && setRun(r)).catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [sid, name, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const bySpec = useMemo(() => new Map(blocks.map((b) => [b.block, b])), [blocks]);
  const graph = view?.graph;
  const title = `${name}.flow.ts`;
  const fileKey = `${device}:${cwd}:${name}`;
  const start = () => attempt(() => api().runFlow(sid!, name)).then((r) => r && setRun(r));
  // the hub started the next queued run: read it, so the canvas follows it
  const runner = useRunner(sid ? { sessionId: sid, flow: name } : undefined, flowLive(run), start, () => void api().flowRun(sid!, name).then((r) => r && setRun(r)).catch(() => {}));
  const saveLayout = async (next: Positions) => {
    setPositions(next);
    await api().saveFlowLayout(sid!, name, next);
  };
  /** One step of ops; each is sent on the version the last one wrote. */
  const ops = (label: string, list: FlowOp[] | ((send: (op: FlowOp) => Promise<{ nodeId?: string }>) => Promise<unknown>), after?: (ids: string[]) => void) =>
    ed.edit(label, async (base, took) => {
      const made: string[] = [];
      const send = async (op: FlowOp) => {
        const r = await api().flowOp(sid!, name, op, base());
        took(r.view);
        if (r.nodeId) made.push(r.nodeId);
        return r;
      };
      if (typeof list === 'function') await list(send);
      else for (const op of list) await send(op);
      after?.(made);
      return made;
    });
  const insert = (block: string, afterId?: string, at?: { x: number; y: number }) =>
    void ops('new block', [{ op: 'insert', block, ...(afterId ? { after: afterId } : {}) }], ([id]) => {
      if (!id) return;
      setSelection([id]);
      // where it was dropped, not at the end of the layout
      if (at) void attempt(() => saveLayout({ ...positions, [id]: snap(at) }));
    });
  const flow = useMemo(
    () => ({
      blocks: bySpec,
      live: run?.nodes,
      states: graph ? programStates(graph.nodes, run) : undefined,
      check: (from: string, to: string, input: string) => (graph ? wireRefusal(graph, from, to, input) : undefined),
      onConnect: (from: string, to: string, input: string) => {
        const src = graph?.nodes.find((n) => n.id === from)?.declares[0];
        if (src) void ops('wire', [{ op: 'connect', nodeId: to, input, from: src }]);
      },
    }),
    [bySpec, run?.nodes, run?.status, graph], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const where = [cwd, device && `on ${device}`].filter(Boolean).join(' ');
  if (booted && !session) return <Missing title={title}>No Code session works in {where || 'that folder'}, so the hub cannot read its flows. Start one there, then open the file again.</Missing>;
  if (error) return <Missing title={title}>The program did not load. {error}</Missing>;
  if (!view) return <Loading title={title} />;
  const failed = Object.entries(run?.nodes ?? {}).filter(([, n]) => !n.ok);
  const focus = focusNode(view.graph.nodes.map((n) => ({ id: n.id, state: liveState(run?.nodes[n.id]) })));
  const status = run ? { word: run.status === 'running' ? 'Running' : run.status === 'done' ? 'Done' : run.status === 'failed' ? 'Failed' : runWords(run), tone: run.status === 'running' ? 'text-signal' : run.status === 'failed' ? 'text-fault' : run.status === 'done' ? 'text-ok' : 'text-fg-2', rest: run.status === 'failed' ? (failed.length ? `at ${failed.map(([id]) => view.graph.nodes.find((n) => n.id === id)?.label ?? id).join(', ')}` : (run.error ?? '')) : run.status === 'running' ? `${Object.keys(run.nodes).length} blocks done` : '', since: run.status === 'running' ? run.startedAt : undefined } : { word: 'Not run yet', tone: 'text-fg-3', rest: '' };
  return (
    <Shell
      title={title}
      meta={['Program', where].filter(Boolean).join(', ')}
      status={status}
      graph={view.graph}
      focus={focus}
      edit={{ ...ed, onAdd: (kind) => insert(kind) }}
      canvas={(sel, onSelect) => (
        <GraphCanvas
          graph={view.graph}
          positions={positions}
          selected={sel}
          // the selection follows React Flow's select changes (onSelection), so a shift-click adds instead of replacing
          onSelect={onSelect}
          selection={selection}
          onSelection={(ids) => (setSelection(ids), ids.length <= 1 && onSelect(ids[0]))}
          flow={flow}
          full={{ focus }}
          inserts={blocks.map((b) => ({ kind: b.block, word: b.title, help: b.help }))}
          onInsert={insert}
          onMove={(id, at) => {
            const prev = positions;
            const next = { ...positions, [id]: snap(at) };
            void attempt(() => saveLayout(next));
            ed.push('move', () => saveLayout(prev), () => saveLayout(next));
          }}
          onRemove={(ids) => {
            onSelect(undefined);
            setSelection([]);
            void ops(ids.length > 1 ? `remove ${ids.length} blocks` : 'remove', removeOps(view.graph, ids));
          }}
          onCopy={(ids) => {
            clipboard = copyClip(fileKey, view.graph, ids);
            const n = clipboard.blocks.length;
            toast({ title: n ? `Copied ${n} ${n === 1 ? 'block' : 'blocks'}` : 'Nothing to copy', ...(clipboard.skipped ? { body: `${clipboard.skipped} code ${clipboard.skipped === 1 ? 'node stays' : 'nodes stay'} behind: copy code in the file.` } : {}), level: n ? 'success' : 'info' });
          }}
          onPaste={(at) => {
            const clip = clipboard;
            if (!clip?.blocks.length) return;
            if (clip.file !== fileKey) return void toast({ title: 'Paste works within one file', body: 'Copy blocks in this file, then paste them here.', level: 'info' });
            void ops(
              'paste',
              (send) => pasteClip(clip, send, (b, i) => bySpec.get(b)?.inputs.find((x) => x.name === i)?.default),
              (ids) => {
                setSelection(ids);
                const p = snap(at);
                void attempt(() => saveLayout({ ...positions, ...Object.fromEntries(ids.map((id, i) => [id, { x: p.x + i * 24, y: p.y + i * 24 }])) }));
              },
            );
          }}
          onRename={(id, next) =>
            void ops('rename', [{ op: 'rename', nodeId: id, name: next }], ([nid]) => nid && positions[id] && void attempt(() => saveLayout({ ...positions, [nid]: positions[id] })))
          }
          renamable={programRenamable}
          className="min-h-0 flex-1"
        />
      )}
      library={blocks.map((b) => ({ kind: b.block, word: b.title, help: b.help, group: b.family }))}
      inspector={(node) => <FlowInspector node={node} nodes={view.graph.nodes} spec={node.block ? bySpec.get(node.block) : undefined} live={run?.nodes[node.id]} onOp={(op, label) => ops(label, [op])} />}
      // a program has no resume: Re-run runs the whole file
      failedOf={(node) => (run?.nodes[node.id]?.ok === false ? { error: run.nodes[node.id].error ?? run.error ?? 'failed', rerun: { label: 'Re-run', go: runner.onRun } } : undefined)}
      runner={{ ...runner, onStop: flowLive(run) ? () => void attempt(() => api().stopFlow(sid!, name)).then((r) => r && setRun(r)) : undefined }}
      agent={{ file: `flows/${title}`, device, cwd, sessionId: sid, error: run?.status === 'failed' ? run.error : undefined, onTurnEnd: () => void api().flowGraph(sid!, name).then(take).catch(() => {}) }}
      output={run?.output || run?.error || ''}
      logs={Object.entries(run?.nodes ?? {}).map(([id, n]) => [n.ms !== undefined ? `${n.ms} ms` : '', `${id}: ${n.ok ? (n.summary ?? 'done') : `failed, ${(n.error ?? '').split('\n')[0]}`}`] as const)}
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
  return <WorkflowShell view={view} detail={data} title={title} meta={`Run of ${data.run.name}, ${hhmm(data.run.createdAt)}, read only`} run />;
}

function WorkflowFile({ id }: { id: string }) {
  const [view, setView] = useState<WorkflowGraphView>();
  const [lastRun, setLastRun] = useState<string>();
  const [error, setError] = useState<string>();
  const [schema, setSchema] = useState<Record<string, WorkflowArgFieldDto>>();
  const [path, setPath] = useState<string>();
  const [asking, setAsking] = useState<'now' | 'queue'>();
  useEffect(() => {
    let alive = true;
    // the latest run of this workflow (the hub's, per account): a reload shows it live again
    Promise.all([api().workflowGraph(id), api().workflow(id)])
      .then(([v, d]) => alive && (setView(v), setLastRun(d.lastRun?.id), setSchema(d.argsSchema), setPath(d.path)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id]);
  const { data, error: runError } = useRunDetail(lastRun);
  const [started, setStarted] = useState<string>();
  const current = data?.run.id === lastRun ? data : undefined;
  const live = workflowLive(started, lastRun, data, !!runError);
  const began = (r: { id: string } | undefined) => r && (setStarted(r.id), setLastRun(r.id));
  const go = (args?: Record<string, unknown>) => attempt(() => api().startWorkflow({ name: id, ...(args ? { args } : {}) })).then(began);
  const declares = !!schema && Object.keys(schema).length > 0;
  const runner = useRunner({ workflow: id }, live, () => go(), () => void api().workflow(id).then((d) => setLastRun(d.lastRun?.id)).catch(() => {}));
  const runFlow: ShellRun = {
    ...runner,
    // the args form first when the workflow declares args; Queue run keeps them with the queued run
    onRun: () => (declares ? setAsking(live ? 'queue' : 'now') : runner.onRun()),
    onStop: current && isLive(current.run.status) ? () => void attempt(() => api().stopWorkflow(current.run.id)) : undefined,
  };
  const argsDialog = schema && asking && (
    <RunArgs
      schema={schema}
      queue={asking === 'queue'}
      onClose={() => setAsking(undefined)}
      onRun={(args) => {
        setAsking(undefined);
        if (asking === 'queue') runner.enqueue(args);
        else runner.begin(() => go(args));
      }}
    />
  );
  const rerun = (seqs: number[]) => current && runner.begin(() => attempt(() => api().rerunWorkflow(current.run.id, { seqs })).then(began));
  const agent = view?.editable ? { file: path ?? id, cwd: folderOf(path), error: data?.run.status === 'failed' ? (data.run.error ?? data.calls.find((c) => c.state === 'failed')?.error) : undefined, onTurnEnd: () => void api().workflowGraph(id).then(take).catch(() => {}) } : undefined;
  const [positions, setPositions] = useState<Positions>({});
  const take = useCallback((v: WorkflowGraphView) => setView((old) => ({ ...v, layout: v.layout ?? old?.layout })), []);
  useEffect(() => setPositions((p) => view?.layout ?? p), [view?.layout]);
  const ed = useEditor<WorkflowGraphView>({ view, setView: take, restore: (sha, base) => api().restoreWorkflowGraph(id, sha, base).then((r) => r.view), reload: () => api().workflowGraph(id) });
  if (error) return <Missing title={id}>The workflow did not load. {error}</Missing>;
  if (!view) return <Loading title={id} />;
  const library = view.source === 'builtin' || view.source === 'plugin';
  if (!view.editable)
    return (
      <WorkflowShell
        view={view}
        detail={data}
        runner={runFlow}
        onRerun={rerun}
        dialog={argsDialog}
        title={view.graph.name || id}
        meta={['Workflow', library ? 'library' : 'yours', 'read only'].join(', ')}
        duplicate={library ? () => void attempt(() => api().copyWorkflow(id), 'Duplicated. The copy is yours to edit.').then((d) => d && api().workflowGraph(id).then(take)) : undefined}
      />
    );
  const saveLayout = async (next: Positions) => {
    setPositions(next);
    await api().saveWorkflowLayout(id, next);
  };
  const insert = (kind: string, after?: string, at?: { x: number; y: number }) => {
    // the hub renumbers saved positions for an insert (shiftLayout): undo puts the old ones back, redo the shifted
    const prev = positions;
    let shifted: Positions | undefined;
    void ed
      .edit(
        'new node',
        async (base, took) => {
          const r = await api().insertWorkflowNode(id, { kind: kind as 'agent', baseSha: base(), ...(after ? { after } : {}) });
          shifted = r.view.layout;
          took(r.view);
          return r.nodeId;
        },
        { undo: () => saveLayout(prev), redo: async () => shifted && saveLayout(shifted) },
      )
      .then((nid) => nid && at && void attempt(() => saveLayout({ ...(shifted ?? positions), [nid]: snap(at) })));
  };
  const remove = (ids: string[]) => {
    // later nodes of a kind renumber (dropLayout): undo puts the old positions back
    const prev = positions;
    let after: Positions | undefined;
    const at = (nid: string) => view.graph.nodes.findIndex((n) => n.id === nid);
    void ed.edit(
      ids.length > 1 ? `remove ${ids.length} nodes` : 'remove',
      async (base, took) => {
        // last first, so the ids still to go do not move
        for (const nid of [...ids].sort((a, b) => at(b) - at(a))) {
          const r = await api().removeWorkflowNode(id, { nodeId: nid, baseSha: base() });
          after = r.view.layout;
          took(r.view);
        }
      },
      { undo: () => saveLayout(prev), redo: async () => after && saveLayout(after) },
    );
  };
  const setting = (nodeId: string, e: { field: GraphEditField; value: string; part?: number }) =>
    ed.edit(e.field === 'label' ? 'rename' : e.field, async (base, took) => took((await api().editWorkflowGraph(id, { nodeId, ...e, baseSha: base() })).view));
  return (
    <WorkflowShell
      view={view}
      detail={data}
      title={view.graph.name || id}
      meta="Workflow, yours"
      positions={positions}
      runner={runFlow}
      onRerun={rerun}
      agent={agent}
      dialog={argsDialog}
      edit={{
        ...ed,
        onAdd: (k) => insert(k),
        insert,
        remove,
        setting,
        move: (nid, at) => {
          const prev = positions;
          const next = { ...positions, [nid]: snap(at) };
          void attempt(() => saveLayout(next));
          ed.push('move', () => saveLayout(prev), () => saveLayout(next));
        },
      }}
    />
  );
}

type WorkflowEdit = ShellEdit & {
  insert: (kind: string, after?: string, at?: { x: number; y: number }) => void;
  remove: (ids: string[]) => void;
  setting: (nodeId: string, e: { field: GraphEditField; value: string; part?: number }) => Promise<unknown>;
  move: (id: string, at: { x: number; y: number }) => void;
};

function WorkflowShell({ view, detail, title, meta, run, duplicate, edit, positions, runner, onRerun, agent, dialog }: { view: WorkflowGraphView; detail?: WorkflowRunDetail; title: string; meta: string; run?: boolean; duplicate?: () => void; edit?: WorkflowEdit; positions?: Positions; runner?: ShellRun; onRerun?: (seqs: number[]) => void; agent?: ShellAgent; dialog?: ReactNode }) {
  const [selection, setSelection] = useState<string[]>([]);
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
      run={run}
      status={status}
      graph={view.graph}
      focus={focus}
      links={r ? [{ label: 'Open the run', href: `/workflows/runs/${r.id}` }] : []}
      duplicate={duplicate}
      edit={edit}
      runner={runner}
      agent={agent}
      dialog={dialog}
      // a workflow replays from its journal: Re-run from here runs this node and what depends on it
      failedOf={(node) => {
        const nr = runs?.byNode.get(node.id);
        return nr?.state === 'failed' ? { error: nr.error ?? r?.error ?? 'failed', ...(onRerun && nr.seqs.length ? { rerun: { label: 'Re-run from here', go: () => onRerun(nr.seqs) } } : {}) } : undefined;
      }}
      canvas={(sel, onSelect) => (
        <GraphCanvas
          graph={view.graph}
          runs={runs?.byNode}
          stale={view.stale}
          positions={positions ?? view.layout}
          selected={sel}
          currentPhase={live ? r?.phaseTitle : undefined}
          onSelect={onSelect}
          full={{ focus }}
          className="min-h-0 flex-1"
          {...(edit
            ? {
                onInsert: edit.insert,
                onMove: edit.move,
                selection,
                onSelection: (ids: string[]) => (setSelection(ids), ids.length <= 1 && onSelect(ids[0])),
                onRemove: (ids: string[]) => (onSelect(undefined), setSelection([]), edit.remove(ids)),
                onRename: (nid: string, name: string) => void edit.setting(nid, { field: 'label', value: name }),
                renamable: workflowRenamable,
              }
            : {})}
        />
      )}
      library={INSERTS.map((i) => ({ kind: i.kind, word: i.word, help: i.help, group: 'Workflow' }))}
      inspector={(node) => {
        const nr = runs?.byNode.get(node.id);
        const calls = nr && detail ? detail.calls.filter((c) => nr.seqs.includes(c.seq)) : [];
        return <Inspector node={node} run={nr} calls={calls} runCtx={r ? { id: r.id, name: r.name, sessionId: r.sessionId, live } : undefined} onRerun={onRerun} {...(edit ? { view, saveNow: (e: { field: GraphEditField; value: string; part?: number }) => edit.setting(node.id, e) } : {})} />;
      }}
      output={r?.error ?? (detail?.result !== undefined ? JSON.stringify(detail.result, null, 2) : '')}
      logs={(detail?.logs ?? []).map((l) => [hhmm(l.ts), l.text] as const)}
    />
  );
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/** What an editable file hands the shell: the save status, undo and redo, and a library item tapped or dropped. */
interface ShellEdit {
  state: ReturnType<typeof useEditor>['state'];
  history: ReturnType<typeof useEditor>['history'];
  onAdd: (kind: string) => void;
}

/** Run, Queue run and Stop for one file (useRunner), and its queued runs. */
interface ShellRun {
  live: boolean;
  onRun: () => void;
  onStop?: () => void;
  /** This file's runs waiting on the hub, oldest first. */
  queue: CanvasQueuedRun[];
  enqueue: (args?: Record<string, unknown>) => void;
  onCancel: (id: string) => void;
  /** Start something that makes a run (Run, Re-run); a second call while one is on its way does nothing. */
  begin: (fn: () => Promise<unknown>) => void;
}

/** Where Ask the agent works: the file, its folder, the session it continues, the last error. */
interface ShellAgent {
  file: string;
  device?: string;
  cwd?: string;
  sessionId?: string;
  error?: string;
  onTurnEnd: () => void;
}

/**
 * One run per file: Run starts one, or queues one on the hub while a run goes
 * on. The hub starts the next queued run when the live one ends, with or
 * without this page open; the page reads the queue while something runs or
 * waits, and onHubStart reads the file's run again when the hub took one.
 */
function useRunner(input: CanvasQueueInput | undefined, live: boolean, start: () => Promise<unknown>, onHubStart: () => void): ShellRun {
  const file = input ? queueFile(input) : undefined;
  const [queue, setQueueState] = useState<CanvasQueuedRun[]>([]);
  const [guard] = useState(startGuard);
  const [starting, setStarting] = useState(false);
  const begin = (fn: () => Promise<unknown>) => void (guard.run(fn, () => setStarting(false)) && setStarting(true));
  const last = useRef<CanvasQueuedRun[]>([]);
  const hubStart = useRef(onHubStart);
  hubStart.current = onHubStart;
  const setQueue = useCallback((next: CanvasQueuedRun[]) => {
    if (headLeft(last.current, next)) hubStart.current();
    last.current = next;
    setQueueState(next);
  }, []);
  const read = useCallback(() => (file ? api().canvasQueue(file).then(setQueue).catch(() => {}) : Promise.resolve()), [file, setQueue]);
  useEffect(() => void read(), [read]);
  useEffect(() => {
    if (!live && !queue.length) return;
    const t = setInterval(() => void read(), QUEUE_POLL_MS);
    return () => clearInterval(t);
  }, [live, queue.length, read]);
  const enqueue = (args?: Record<string, unknown>) => input && void attempt(() => api().queueCanvasRun('workflow' in input ? { ...input, ...(args ? { args } : {}) } : input), 'Queued: it starts when this run ends').then(read);
  const onCancel = (id: string) => void attempt(() => api().cancelCanvasRun(id)).then(() => (last.current = last.current.filter((q) => q.id !== id), read()));
  return { live: live || starting, queue, enqueue, begin, onRun: () => (guard.busy() ? undefined : live ? enqueue() : begin(start)), onCancel };
}

interface ShellProps {
  title: string;
  meta: string;
  edit?: ShellEdit;
  runner?: ShellRun;
  agent?: ShellAgent;
  /** A failed node's error, and how it runs again (Re-run from here when the hub can replay, else Re-run). */
  failedOf?: (node: GraphNode) => { error: string; rerun?: { label: string; go: () => void } } | undefined;
  /** The args form a Run opens. */
  dialog?: ReactNode;
  /** A library workflow: copy it to your own workflows, where it is editable. */
  duplicate?: () => void;
  /** One run, read only: the node library starts folded unless this account opened it. */
  run?: boolean;
  status: { word: string; tone: string; rest: string; since?: number };
  graph: { nodes: GraphNode[] };
  focus?: string;
  links?: Array<{ label: string; href: string }>;
  canvas: (sel: string | undefined, onSelect: (id: string | undefined) => void) => ReactNode;
  library: Array<{ kind: string; word: string; help: string; group: string }>;
  inspector: (node: GraphNode) => ReactNode;
  output: string;
  logs: ReadonlyArray<readonly [string, string]>;
}

/** Full screen on a computer: the sidebar folds to its strip while a file is open, and comes back after. */
function useFullScreen(phone: boolean) {
  useEffect(() => {
    if (phone) return;
    const was = useChatUi.getState().railOpen;
    // not saved (setRailOpen saves): a reload here must not fold the sidebar for good
    useChatUi.setState({ railOpen: false });
    return () => useChatUi.setState({ railOpen: was });
  }, [phone]);
}

function Shell(p: ShellProps) {
  const phone = useIsMobile();
  // a computer opens with the running or failed node in the inspector; a phone with nothing over the canvas
  const [sel, setSel] = useState<string | undefined>(phone ? undefined : p.focus);
  const [tab, setTab] = useState<Tab>(p.logs.length ? 'logs' : 'output');
  const [panel, setPanel] = useState(true);
  const [lib, setLib] = useState(() => libraryOpen(!!p.run));
  const [sheet, setSheet] = useState<'library' | 'output' | 'agent'>();
  const [side, setSide] = useState<'inspector' | 'agent'>('inspector');
  useFullScreen(phone);
  const node = p.graph.nodes.find((n) => n.id === sel);
  const ask = () => (phone ? setSheet('agent') : setSide('agent'));
  const failed = node && p.failedOf?.(node);
  const inspector = (n: GraphNode) => (
    <>
      {failed && (
        <div className="space-y-3 border-b border-rule px-5 py-4">
          <Notice tone="fault">{failed.error}</Notice>
          <div className="flex flex-wrap gap-2">
            {failed.rerun && p.runner && (
              <Button variant="outline" size={phone ? 'touch' : 'sm'} disabled={p.runner.live} onClick={failed.rerun.go}>
                {failed.rerun.label}
              </Button>
            )}
            {p.agent && (
              <Button variant="outline" size={phone ? 'touch' : 'sm'} onClick={ask}>
                Ask the agent
              </Button>
            )}
          </div>
        </div>
      )}
      {p.inspector(n)}
    </>
  );
  const runRef = useRef(p.runner);
  runRef.current = p.runner;
  // Ctrl/Cmd+Enter: Run, or Queue run while one goes on
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || isTyping(e) || !runRef.current) return;
      e.preventDefault();
      runRef.current.onRun();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const agentPanel = p.agent && <AgentPanel ctx={p.agent} selection={node ? [{ label: node.label, lines: `lines ${node.span.start} to ${node.span.end}` }] : []} />;
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
  const bottom = <BottomPanel tab={tab} setTab={setTab} output={p.output} logs={p.logs} phone={phone} runner={p.runner} title={p.title} />;
  // a phone taps a node in the sheet to add it; a computer drags it onto the canvas (or clicks it)
  const library = <Library items={p.library} onAdd={p.edit ? (k) => (setSheet(undefined), p.edit!.onAdd(k)) : undefined} />;
  const save = p.edit && saveWords(p.edit.state);
  const h = p.edit?.history;
  const tools = (
    <>
      {save && (
        <span role="status" aria-live="polite" className={cn('min-w-0 shrink truncate text-[12px] phone:text-[13px]', save.tone)} title={save.word}>
          {save.word}
        </span>
      )}
      {h && (
        <>
          <Button variant="ghost" size={phone ? 'touch' : 'sm'} disabled={!h.canUndo} title={h.nextUndo ? `Undo ${h.nextUndo} (Ctrl+Z)` : 'Nothing to undo'} onClick={h.undo}>
            Undo
          </Button>
          <Button variant="ghost" size={phone ? 'touch' : 'sm'} disabled={!h.canRedo} title={h.nextRedo ? `Redo ${h.nextRedo} (Ctrl+Shift+Z)` : 'Nothing to redo'} onClick={h.redo}>
            Redo
          </Button>
        </>
      )}
      {p.duplicate && (
        <Button variant="outline" size={phone ? 'touch' : 'sm'} onClick={p.duplicate}>
          Duplicate to edit
        </Button>
      )}
      {!phone && p.runner?.onStop && (
        <Button variant="outline" size="sm" onClick={p.runner.onStop}>
          Stop
        </Button>
      )}
      {!phone && p.runner && (
        <Button variant="primary" size="sm" onClick={p.runner.onRun} title={p.runner.live ? 'Queue run: it starts when this one ends (Ctrl+Enter)' : 'Run (Ctrl+Enter)'}>
          {p.runner.live ? 'Queue run' : 'Run'}
        </Button>
      )}
    </>
  );
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
        <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-rule px-4 text-[13px]">
          <span className="min-w-0 flex-1 truncate">{statusLine}</span>
          {tools}
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {p.canvas(sel, setSel)}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-2 px-3 pb-[calc(12px+var(--safe-b,0px))]">
            {(p.agent ? (['library', 'output', 'agent'] as const) : (['library', 'output'] as const)).map((s) => (
              <button key={s} type="button" onClick={() => setSheet(s)} className="pointer-events-auto h-11 rounded-[var(--r-2)] border border-rule-2 bg-raise px-4 text-[15px] text-fg shadow-[var(--shadow-pop)]">
                {s === 'library' ? 'Nodes' : s === 'output' ? 'Output' : 'Agent'}
              </button>
            ))}
            {p.runner && (
              <button type="button" onClick={p.runner.onStop ?? p.runner.onRun} className="pointer-events-auto ml-auto h-11 rounded-[var(--r-2)] border border-rule-2 bg-raise px-5 text-[15px] font-medium text-fg shadow-[var(--shadow-pop)]">
                {p.runner.onStop ? 'Stop' : 'Run'}
              </button>
            )}
          </div>
        </div>
        <Sheet open={sheet === 'library'} onClose={() => setSheet(undefined)} title="Nodes">
          <div className="px-3 pb-3">{library}</div>
        </Sheet>
        <Sheet open={sheet === 'output'} onClose={() => setSheet(undefined)} title="Run">
          <div className="px-4 pb-4">{bottom}</div>
        </Sheet>
        <Sheet open={sheet === 'agent'} onClose={() => setSheet(undefined)} title="Ask the agent">
          <div className="flex h-[70dvh] flex-col">{agentPanel}</div>
        </Sheet>
        <Sheet open={!!node && sheet !== 'agent'} onClose={() => setSel(undefined)} label={node?.label ?? 'Node'} className="cv-inspector">
          {node && inspector(node)}
        </Sheet>
        {p.dialog}
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule px-4">
        <Tooltip content={lib ? 'Hide the nodes' : 'Show the nodes'} side="bottom">
          <button type="button" aria-expanded={lib} aria-label={lib ? 'Hide the node library' : 'Show the node library'} onClick={() => (setLib(!lib), saveLibraryOpen(!lib))} className="-ml-1.5 grid size-7 shrink-0 place-items-center rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg">
            {lib ? <PanelLeftClose className="size-4" strokeWidth={1.75} aria-hidden /> : <PanelLeftOpen className="size-4" strokeWidth={1.75} aria-hidden />}
          </button>
        </Tooltip>
        <FileMenu title={p.title} />
        <span className="shrink-0 truncate text-[12px] text-fg-3">{p.meta}</span>
        <span className="mx-2 h-4 w-px shrink-0 bg-rule" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px]">{statusLine}</span>
        {tools}
        {p.links?.map((l) => (
          <Link key={l.href} href={l.href} className="shrink-0 text-[13px] text-fg-2 underline underline-offset-2 hov:text-fg">
            {l.label}
          </Link>
        ))}
      </header>
      <div className="flex min-h-0 flex-1">
        {lib && (
          <aside aria-label="Node library" className="flex w-[216px] shrink-0 flex-col border-r border-rule">
            <div className="flex h-10 shrink-0 items-center px-3 text-[12px] font-medium text-fg-3">Nodes</div>
            <div className="scroll-y min-h-0 flex-1 px-2 pb-2">{library}</div>
            <p className="m-0 border-t border-rule px-3 py-2 text-[12px] leading-[1.45] text-fg-3">{p.edit ? 'Drag a node onto the canvas, or double-click the canvas to search.' : 'Read only.'}</p>
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {p.canvas(sel, setSel)}
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
        <aside aria-label={side === 'agent' ? 'Agent' : 'Inspector'} className={cn('cv-inspector flex shrink-0 flex-col border-l border-rule', side === 'agent' && agentPanel ? 'w-[420px]' : 'w-[320px]')}>
          {p.agent && (
            <div className="flex h-10 shrink-0 items-center border-b border-rule px-3">
              <Tabs<'inspector' | 'agent'> value={side} onChange={setSide} label="Right column" options={[{ value: 'inspector', label: 'Inspector' }, { value: 'agent', label: 'Agent' }]} />
            </div>
          )}
          {side === 'agent' && agentPanel ? <div className="flex min-h-0 flex-1 flex-col">{agentPanel}</div> : <div className="scroll-y min-h-0 flex-1">{node ? inspector(node) : facts}</div>}
        </aside>
      </div>
      {p.dialog}
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

/** The blocks this kind of file can hold, by family. With onAdd, an item drags onto the canvas (DRAG_KIND) or adds on a click. */
function Library({ items, onAdd }: { items: ShellProps['library']; onAdd?: (kind: string) => void }) {
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g}>
          <div className="px-1 pb-1 text-[12px] font-medium text-fg-3">{g}</div>
          {items
            .filter((i) => i.group === g)
            .map((i) =>
              onAdd ? (
                <button
                  key={i.word}
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_KIND, i.kind);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => onAdd(i.kind)}
                  title="Drag onto the canvas, or click to add at the end"
                  className="block w-full cursor-grab rounded-[var(--r-1)] px-2 py-1.5 text-left hov:bg-hover phone:py-2"
                >
                  <div className="text-[13px] text-fg phone:text-[15px]">{i.word}</div>
                  <div className="truncate text-[12px] text-fg-3 phone:text-[13px]">{i.help}</div>
                </button>
              ) : (
                <div key={i.word} className="rounded-[var(--r-1)] px-2 py-1.5 phone:py-2">
                  <div className="text-[13px] text-fg phone:text-[15px]">{i.word}</div>
                  <div className="truncate text-[12px] text-fg-3 phone:text-[13px]">{i.help}</div>
                </div>
              ),
            )}
        </div>
      ))}
    </div>
  );
}

function PanelTabs({ tab, setTab, logs }: { tab: Tab; setTab: (t: Tab) => void; logs: number }) {
  return <Tabs<Tab> value={tab} onChange={setTab} label="Run panel" options={[{ value: 'output', label: 'Output' }, { value: 'logs', label: 'Logs', count: logs || undefined }, { value: 'queue', label: 'Queue' }]} />;
}

function BottomPanel({ tab, setTab, output, logs, phone, runner, title }: { tab: Tab; setTab: (t: Tab) => void; output: string; logs: ShellProps['logs']; phone: boolean; runner?: ShellRun; title: string }) {
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
      {tab === 'queue' && <Queue runner={runner} title={title} phone={phone} />}
    </>
  );
}

/** This file's queued runs (Cancel each), then the workflow runs going now on this hub, newest first. */
function Queue({ runner, title, phone }: { runner?: ShellRun; title: string; phone: boolean }) {
  const { data } = useRuns({ limit: 20 });
  const live = (data ?? []).filter((r) => isLive(r.status));
  const mine = runner?.queue ?? [];
  if (!live.length && !mine.length) return <p className="m-0 py-1 text-[13px] text-fg-3">Nothing running or queued.</p>;
  return (
    <>
      {mine.map((q, i) => (
        <div key={q.id} className="flex items-center gap-3 border-b border-rule py-1 text-[13px]">
          <span className="mono min-w-0 flex-1 truncate text-fg">{title}</span>
          <span className="shrink-0 text-[12px] text-fg-3">
            queued{mine.length > 1 ? `, ${i + 1} of ${mine.length}` : ''}, {hhmm(q.createdAt)}
          </span>
          <Button variant="ghost" size={phone ? 'touch' : 'sm'} onClick={() => runner!.onCancel(q.id)}>
            Cancel
          </Button>
        </div>
      ))}
      {live.map((r) => (
        <Link key={r.id} href={fileHref({ kind: 'workflow', id: r.name, name: r.name, group: 'runs', runId: r.id })} className="flex items-baseline gap-3 border-b border-rule py-1.5 text-[13px] last:border-0 hov:text-fg">
          <span className="mono min-w-0 flex-1 truncate text-fg">{r.name}</span>
          <span className={cn('shrink-0 text-[12px]', r.status === 'running' ? 'text-signal' : 'text-fg-3')}>{r.status === 'running' ? <Elapsed since={r.startedAt ?? r.createdAt} /> : RUN_WORD[r.status]}</span>
        </Link>
      ))}
    </>
  );
}

/** The args form for a workflow that declares them (the run sheet's ArgsForm). */
function RunArgs({ schema, queue, onClose, onRun }: { schema: Record<string, WorkflowArgFieldDto>; queue: boolean; onClose: () => void; onRun: (args: Record<string, unknown>) => void }) {
  const [values, setValues] = useState<ArgValues>({});
  const [err, setErr] = useState<string>();
  const submit = () => {
    const { args, error } = argsFromValues(schema, values);
    if (error) return setErr(error);
    onRun(args ?? {});
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={queue ? 'Queue a run' : 'Run'}
      description="The workflow's declared args. Empty fields are left out."
      footer={
        <Button variant="primary" onClick={submit}>
          {queue ? 'Queue run' : 'Run'}
        </Button>
      }
    >
      <ArgsForm schema={schema} values={values} set={(k, v) => (setValues((s) => ({ ...s, [k]: v })), setErr(undefined))} />
      {err && <p className="mt-3 text-[13px] text-fault">{err}</p>}
    </Dialog>
  );
}

/**
 * Ask the agent: a Code session in the file's folder (the folder's session for
 * a program, one started for a workflow and kept per file), its transcript,
 * and a box whose message carries the file, the selection and the last error.
 * The canvas reloads the file when the agent's turn ends.
 */
function AgentPanel({ ctx, selection }: { ctx: ShellAgent; selection: Array<{ label: string; lines: string }> }) {
  const [sid, setSid] = useState(() => ctx.sessionId ?? agentSessionOf(ctx.file));
  const session = useHub((s) => (sid ? s.sessions[sid] : undefined));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => (sid ? retainTranscript(sid) : undefined), [sid]);
  const was = useRef(session?.status);
  const turnEnd = useRef(ctx.onTurnEnd);
  turnEnd.current = ctx.onTurnEnd;
  useEffect(() => {
    if (was.current && was.current !== 'idle' && session?.status === 'idle') turnEnd.current();
    was.current = session?.status;
  }, [session?.status]);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      let id = sid;
      if (!id || !useHub.getState().sessions[id]) {
        const s = await attempt(() => api().createSession({ ...(ctx.device ? { device: ctx.device } : {}), ...(ctx.cwd ? { cwd: ctx.cwd } : {}), title: `Canvas: ${ctx.file.split('/').pop()}` }));
        if (!s) return;
        upsertSession(s);
        id = s.id;
        rememberAgentSession(ctx.file, id);
        setSid(id);
      }
      const msg = agentMessage(text, { file: ctx.file, selection, ...(ctx.error ? { error: ctx.error } : {}) });
      setText('');
      await sendQueued(id, { text: msg, whenBusy: 'queue' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {session ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageList session={session} />
        </div>
      ) : (
        <p className="m-0 flex-1 px-4 py-3 text-[13px] text-fg-3">Say what to change, such as &ldquo;add a step that summarises the results&rdquo;. The agent edits {ctx.file} in a Code session there, and the canvas shows the new file when it is done.</p>
      )}
      <div className="shrink-0 space-y-2 border-t border-rule p-3">
        <p className="m-0 truncate text-[12px] text-fg-3">With {[ctx.file, selection[0]?.label, ctx.error ? 'the last error' : ''].filter(Boolean).join(', ')}</p>
        <Textarea value={text} rows={3} aria-label="Ask the agent" placeholder="Ask the agent to change this file" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), void send())} />
        <div className="flex items-center justify-between gap-2">
          {session ? (
            <Link href={`/s/${session.id}`} className="text-[12px] text-fg-3 underline underline-offset-2">
              Open the session
            </Link>
          ) : (
            <span />
          )}
          <Button variant="primary" size="sm" disabled={!text.trim() || busy} onClick={() => void send()}>
            Send
          </Button>
        </div>
      </div>
    </>
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
