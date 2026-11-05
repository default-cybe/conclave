/**
 * Canvas mode (design/canvas-mode SPEC.md): a full-screen node editor for
 * programs (flows/<name>.flow.ts) and workflows, laid out like ComfyUI.
 *
 *   /canvas               the start page: describe a flow, or open a file
 *   /canvas/:kind/:name   the editor: top bar, node library, canvas with
 *                         minimap, inspector, bottom panel (output, logs, queue)
 *
 * Opening a file folds the app sidebar to its strip on a computer, so the
 * canvas gets the width; leaving puts it back. On a phone the canvas is the
 * whole screen under the bar; library, inspector and output are bottom
 * sheets, and Run floats. This is the clickable mock: data comes from
 * ./fixture and Run plays a fake run.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { ChevronDown, ChevronRight, Square } from 'lucide-react';
import { Elapsed } from '@/components/motion/Elapsed';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { Field, Input, OnOff, Select, Textarea } from '@/components/ui/Field';
import { ListRow, StateWord } from '@/components/ui/List';
import { Meter } from '@/components/ui/Meter';
import { Menu, Sheet } from '@/components/ui/Overlay';
import { Page, PageHeader } from '@/components/ui/Page';
import { Notice, Section } from '@/components/ui/Section';
import { Tabs } from '@/components/ui/Tags';
import { PhoneBar } from '@/components/PhoneFrame';
import { setRailOpen, useChatUi } from '@/features/conversation/state';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { toast } from '@/store/store';
import { stateTone } from '../graph/nodes';
import { useHistory } from '../graph/history';
import { CanvasGraph, NodeSearch } from './CanvasGraph';
import { FILES, LOGS, QUEUE, SCRAPER_LOGS, fileHref, findFile, libraryItem, type CEdge, type CGroup, type CNode, type CanvasFile, type Widget } from './fixture';

type Doc = { nodes: CNode[]; edges: CEdge[]; groups: CGroup[] };
type Tab = 'output' | 'logs' | 'queue';

const KIND_WORD = { program: 'Program', workflow: 'Workflow' } as const;
const fileTitle = (f: CanvasFile) => (f.kind === 'program' ? `${f.name}.flow.ts` : f.name);

export default function CanvasPage() {
  const { kind, name } = useParams<{ kind?: string; name?: string }>();
  const file = findFile(kind, name);
  if (!file) return <CanvasStart />;
  return <Editor key={fileHref(file)} file={file} />;
}

// ---------------------------------------------------------------------------
// The start page
// ---------------------------------------------------------------------------

function CanvasStart() {
  const phone = useIsMobile();
  const [what, setWhat] = useState('');
  return (
    <>
      {phone && <PhoneBar title="Canvas" />}
      <Page width="column">
        <PageHeader title="Canvas" sub="Programs and workflows as blocks. Open one, or describe a new one and an agent drafts it." />
        <div className="space-y-3">
          <Textarea value={what} onChange={(e) => setWhat(e.target.value)} rows={3} placeholder="Fetch the Hacker News front page, keep posts about Bun, write them to a CSV" aria-label="Describe a flow" />
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Where it lives" className="w-[260px] phone:w-full">
              <option>Program in conclave, arch-desktop</option>
              <option>Program in homelab, madx</option>
              <option>Workflow, yours</option>
            </Select>
            <span className="flex-1" />
            <Button variant="outline" size={phone ? 'touch' : 'md'} onClick={() => toast({ title: 'Mock: an empty flow would open here.' })}>
              Start empty
            </Button>
            <Button variant="solid" size={phone ? 'touch' : 'md'} disabled={!what.trim()} onClick={() => toast({ title: 'Mock: a Code session would draft flows/hn-bun.flow.ts and open it here.' })}>
              Draft it
            </Button>
          </div>
        </div>
        <Section title="Programs and workflows" className="mt-10">
          {FILES.map((f) => {
            const live = f.nodes.some((n) => n.state === 'running');
            const failed = f.nodes.some((n) => n.state === 'failed');
            return (
              <ListRow
                key={fileHref(f)}
                href={fileHref(f)}
                title={fileTitle(f)}
                meta={[KIND_WORD[f.kind], f.where, f.device].filter(Boolean).join(', ')}
                state={live ? 'running' : failed ? 'last run failed' : f.readOnly ? 'library' : f.nodes.length ? `${f.nodes.length} nodes` : 'empty'}
                stateTone={live ? 'signal' : failed ? 'fault' : 'dim'}
              />
            );
          })}
        </Section>
      </Page>
    </>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/** What the status line says about the run on screen. */
function runWords(nodes: CNode[]): { word: string; tone: string; rest: string; since?: number } {
  const done = nodes.filter((n) => n.state === 'done').length;
  const running = nodes.find((n) => n.state === 'running');
  const failed = nodes.filter((n) => n.state === 'failed');
  const of = `${done} of ${nodes.length} done`;
  if (running) return { word: 'Running', tone: 'text-signal', rest: `${of}${failed.length ? `, ${failed.length} failed` : ''}`, since: (running.startedAt ?? Date.now()) - 44_000 };
  if (nodes.some((n) => n.state === 'queued')) return { word: 'Queued', tone: 'text-fg-2', rest: of };
  if (failed.length) return { word: 'Failed', tone: 'text-fault', rest: `at ${failed.map((n) => n.id).join(', ')}` };
  if (done) return { word: 'Done', tone: 'text-ok', rest: of };
  return { word: 'Not run yet', tone: 'text-fg-3', rest: '' };
}

function Editor({ file }: { file: CanvasFile }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const [doc, setDoc] = useState<Doc>({ nodes: file.nodes, edges: file.edges, groups: file.groups });
  const [sel, setSel] = useState<string | undefined>(phone ? undefined : file.nodes.find((n) => n.state === 'running')?.id);
  const [tab, setTab] = useState<Tab>('logs');
  const [panel, setPanel] = useState(true);
  const [sheet, setSheet] = useState<'library' | 'output'>();
  const [sim, setSim] = useState(false);
  const clip = useRef<CNode>(undefined);
  const history = useHistory(true);
  const docRef = useRef(doc);
  docRef.current = doc;

  // full screen on a computer: the sidebar folds to its strip while a file is open
  useEffect(() => {
    if (phone) return;
    const was = useChatUi.getState().railOpen;
    setRailOpen(false);
    return () => setRailOpen(was);
  }, [phone]);

  /** One edit, undoable (features/graph/history.ts, the same stack the flow view uses). */
  const edit = (label: string, next: (d: Doc) => Doc) => {
    const before = docRef.current;
    const after = next(before);
    setDoc(after);
    history.push({ label, undo: async () => setDoc(before), redo: async () => setDoc(after) });
  };
  const moving = useRef<Doc>(undefined);
  const onMove = (id: string, x: number, y: number, done: boolean) => {
    moving.current ??= docRef.current;
    setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) }));
    if (!done) return;
    const before = moving.current;
    moving.current = undefined;
    const after = { ...docRef.current, nodes: docRef.current.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) };
    history.push({ label: 'move', undo: async () => setDoc(before), redo: async () => setDoc(after) });
  };
  const onWidget = useCallback((id: string, name: string, value: Widget['value']) => setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, widgets: n.widgets.map((w) => (w.name === name ? { ...w, value } : w)) } : n)) })), []);

  const freshId = (base: string) => {
    let i = 1;
    while (docRef.current.nodes.some((n) => n.id === `${base}${i === 1 ? '' : i}`)) i++;
    return `${base}${i === 1 ? '' : i}`;
  };
  const add = (kind: string, at: { x: number; y: number }, wireFrom?: { node: string; out: string }) => {
    const item = libraryItem(kind);
    if (!item) return;
    const id = freshId(kind);
    const node: CNode = { id, kind, x: Math.round(at.x), y: Math.round(at.y), inputs: item.inputs, outputs: item.outputs, widgets: item.widgets.map((w) => ({ ...w })) };
    edit('new node', (d) => ({ ...d, nodes: [...d.nodes, node], edges: wireFrom && item.inputs[0] ? [...d.edges, { id: `e${Date.now()}`, from: wireFrom.node, out: wireFrom.out, to: id, in: item.inputs[0].name }] : d.edges }));
    setSel(id);
    setSheet(undefined);
  };
  const addNear = (kind: string) => {
    const s = doc.nodes.find((n) => n.id === sel) ?? doc.nodes[doc.nodes.length - 1];
    add(kind, s ? { x: s.x + 300, y: s.y + 40 } : { x: 80, y: 80 });
  };

  // the fake run: one node at a time in file order, agents fill their meter first
  useEffect(() => {
    if (!sim) return;
    const t = setInterval(() => {
      const d = docRef.current;
      const nodes = d.nodes.map((n) => ({ ...n }));
      const run = nodes.find((n) => n.state === 'running');
      const next = nodes.find((n) => n.state === 'queued');
      if (run) {
        if (run.kind === 'agent' && (run.progress ?? 0) < 0.99) {
          run.progress = Math.min(1, (run.progress ?? 0) + 0.34);
          run.step = `${Math.round(run.progress * 5)} of 5 steps`;
        } else Object.assign(run, { state: 'done', spent: run.kind === 'agent' ? '3 s, 2.1K tokens, $0.03' : '120 ms', summary: run.summary ?? 'done' });
      } else if (!next) return setSim(false);
      else if (next.kind === 'fetchUrl' && file.kind === 'workflow') Object.assign(next, { state: 'failed', error: 'HTTP 404 from github.com/panva/jose/docs/README.md' });
      else Object.assign(next, { state: 'running', progress: 0, step: 'starting', startedAt: Date.now() });
      setDoc({ ...d, nodes });
    }, 700);
    return () => clearInterval(t);
  }, [sim, file.kind]);

  const live = doc.nodes.some((n) => n.state === 'running' || n.state === 'queued');
  const run = () => {
    if (live) return void toast({ title: `Queued. ${fileTitle(file)} runs again after this run.` });
    setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => ({ ...n, state: 'queued', progress: undefined, error: undefined })) }));
    setSim(true);
  };
  const stop = () => {
    setSim(false);
    setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.state === 'running' || n.state === 'queued' ? { ...n, state: 'skipped' } : n)) }));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const graph = (
    <CanvasGraph
      kind={file.kind}
      nodes={doc.nodes}
      edges={doc.edges}
      groups={doc.groups}
      selected={sel}
      phone={phone}
      readOnly={!!file.readOnly}
      onSelect={setSel}
      onMove={onMove}
      onWidget={onWidget}
      onConnect={(c) => edit('wire', (d) => ({ ...d, edges: [...d.edges.filter((e) => !(e.to === c.to && e.in === c.in)), { id: `e${Date.now()}`, ...c }] }))}
      onAdd={add}
      onRemove={(id) => {
        edit('remove', (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id), edges: d.edges.filter((e) => e.from !== id && e.to !== id) }));
        setSel(undefined);
      }}
      onCopy={(id) => {
        clip.current = doc.nodes.find((n) => n.id === id);
        toast({ title: `Copied ${id}.` });
      }}
      onPaste={(at) => {
        const c = clip.current;
        if (!c) return;
        const id = freshId(c.id);
        edit('paste', (d) => ({ ...d, nodes: [...d.nodes, { ...c, id, x: at?.x ?? c.x + 40, y: at?.y ?? c.y + 40, state: undefined, progress: undefined, error: undefined, summary: undefined, spent: undefined }] }));
        setSel(id);
      }}
      onGroup={(id) => {
        const n = doc.nodes.find((x) => x.id === id);
        if (n) edit('group', (d) => ({ ...d, groups: [...d.groups, { id: `g${Date.now()}`, title: 'Group', x: n.x - 20, y: n.y - 40, w: 280, h: 260 }] }));
      }}
      onRunFrom={(id) => toast({ title: `Mock: runs ${id} and what reads it; the rest comes from the cache.` })}
    />
  );
  const node = doc.nodes.find((n) => n.id === sel);
  const status = runWords(doc.nodes);
  const statusLine = (
    <span className="min-w-0 truncate" aria-live="polite">
      <span className={cn('cv-state font-medium', status.tone)}>{status.word}</span>
      {status.since && (
        <>
          {' '}
          <Elapsed since={status.since} className="num text-fg-2" />
        </>
      )}
      {status.rest && <span className="text-fg-3">, {status.rest}</span>}
    </span>
  );
  const inspector = node ? <Inspector node={node} doc={doc} file={file} onWidget={onWidget} onClose={() => setSel(undefined)} /> : <FileFacts file={file} doc={doc} />;
  const logs = file.name === 'review-and-fix' ? LOGS : file.name === 'scraper' ? SCRAPER_LOGS : [];
  const bottom = <BottomPanel tab={tab} setTab={setTab} doc={doc} logs={logs} />;

  if (phone)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PhoneBar title={fileTitle(file)} />
        <div className="flex h-9 shrink-0 items-center border-b border-rule px-4 text-[13px]">{statusLine}</div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {graph}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-2 px-3 pb-[calc(12px+var(--safe-b,0px))]">
            <Button variant="outline" size="touch" className="pointer-events-auto bg-raise shadow-[var(--shadow-pop)]" onClick={() => setSheet('library')}>
              Nodes
            </Button>
            <Button variant="outline" size="touch" className="pointer-events-auto bg-raise shadow-[var(--shadow-pop)]" onClick={() => setSheet('output')}>
              Output
            </Button>
            <span className="flex-1" />
            {live ? (
              <Button variant="outline" size="touch" className="pointer-events-auto bg-raise shadow-[var(--shadow-pop)]" onClick={stop}>
                <Square className="size-2.5 fill-current" aria-hidden /> Stop
              </Button>
            ) : (
              <Button variant="solid" size="touch" className="pointer-events-auto shadow-[var(--shadow-pop)]" onClick={run} disabled={!!file.readOnly}>
                Run
              </Button>
            )}
          </div>
        </div>
        <Sheet open={sheet === 'library'} onClose={() => setSheet(undefined)} title="Add a node">
          <NodeSearch kind={file.kind} onPick={addNear} autoFocus={false} className="flex flex-col px-3 pb-3" />
        </Sheet>
        <Sheet open={sheet === 'output'} onClose={() => setSheet(undefined)} title="Run">
          <div className="px-4 pb-4">{bottom}</div>
        </Sheet>
        <Sheet open={!!node} onClose={() => setSel(undefined)} label={node?.id ?? 'Node'}>
          {inspector}
        </Sheet>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule px-4">
        <Menu
          label="Open a file"
          placement="bottom-start"
          width={280}
          items={[
            { group: true, label: 'Programs and workflows' },
            ...FILES.map((f) => ({ label: fileTitle(f), detail: [KIND_WORD[f.kind], f.where, f.device].filter(Boolean).join(', '), checked: f === file, onSelect: () => navigate(fileHref(f)) })),
            { separator: true, label: '' },
            { label: 'All of Canvas', onSelect: () => navigate('/canvas') },
          ]}
          trigger={({ ref, props }) => (
            <button ref={ref} type="button" {...props} className="flex h-8 min-w-0 items-center gap-1.5 rounded-[var(--r-1)] px-1.5 hov:bg-hover">
              <span className="mono truncate text-[13px] font-medium text-fg">{fileTitle(file)}</span>
              <ChevronDown className="size-3 shrink-0 text-fg-4" strokeWidth={1.75} aria-hidden />
            </button>
          )}
        />
        <span className="shrink-0 truncate text-[12px] text-fg-3">{[KIND_WORD[file.kind], file.where, file.device && `on ${file.device}`, file.readOnly ? 'read only' : 'saved'].filter(Boolean).join(', ')}</span>
        <span className="mx-2 h-4 w-px shrink-0 bg-rule" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px]">{statusLine}</span>
        <Button variant="ghost" disabled={!history.canUndo} title={history.nextUndo ? `Undo ${history.nextUndo}` : 'Nothing to undo'} onClick={history.undo}>
          Undo
        </Button>
        <Button variant="ghost" disabled={!history.canRedo} title={history.nextRedo ? `Redo ${history.nextRedo}` : 'Nothing to redo'} onClick={history.redo}>
          Redo
        </Button>
        {live && (
          <Button variant="outline" onClick={stop}>
            <Square className="size-2.5 fill-current" aria-hidden /> Stop
          </Button>
        )}
        <Button variant="solid" onClick={run} disabled={!!file.readOnly} title={live ? 'Runs after the one going now' : 'Ctrl Enter'}>
          {live ? 'Queue run' : 'Run'}
        </Button>
      </header>
      {file.readOnly && (
        <Notice className="border-b border-rule px-4 py-2" action={{ label: 'Copy to yours', onClick: () => toast({ title: 'Mock: copied to your workflows.' }) }}>
          {file.readOnly}
        </Notice>
      )}
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Node library" className="flex w-[248px] shrink-0 flex-col border-r border-rule">
          <div className="flex h-10 shrink-0 items-center px-3 text-[12px] font-medium text-fg-3">Nodes</div>
          <NodeSearch kind={file.kind} onPick={addNear} autoFocus={false} className="flex min-h-0 flex-1 flex-col px-2 pb-2" />
          <p className="m-0 border-t border-rule px-3 py-2 text-[12px] leading-[1.45] text-fg-3">Drag one onto the canvas, or double-click the canvas to search.</p>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {graph}
          <div className={cn('shrink-0 border-t border-rule', panel ? 'h-[208px]' : 'h-9')}>
            <div className="flex h-9 items-center gap-3 px-3">
              <button type="button" aria-expanded={panel} aria-label={panel ? 'Fold the run panel' : 'Show the run panel'} onClick={() => setPanel(!panel)} className="grid size-6 place-items-center rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg">
                {panel ? <ChevronDown className="size-3.5" strokeWidth={1.75} /> : <ChevronRight className="size-3.5" strokeWidth={1.75} />}
              </button>
              <Tabs<Tab>
                value={tab}
                onChange={(t) => {
                  setTab(t);
                  setPanel(true);
                }}
                label="Run panel"
                options={[
                  { value: 'output', label: 'Output' },
                  { value: 'logs', label: 'Logs', count: logs.length },
                  { value: 'queue', label: 'Queue', count: QUEUE.filter((q) => q.state === 'queued').length },
                ]}
              />
            </div>
            {panel && <div className="scroll-y h-[172px] px-3 pb-2">{bottom}</div>}
          </div>
        </div>
        <aside aria-label="Inspector" className="scroll-y w-[340px] shrink-0 border-l border-rule">
          {inspector}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function BottomPanel({ tab, setTab, doc, logs }: { tab: Tab; setTab: (t: Tab) => void; doc: Doc; logs: ReadonlyArray<readonly [string, string, string]> }) {
  const phone = useIsMobile();
  const failed = doc.nodes.filter((n) => n.state === 'failed');
  return (
    <>
      {phone && <Tabs<Tab> value={tab} onChange={setTab} label="Run panel" className="pb-3" options={[{ value: 'output', label: 'Output' }, { value: 'logs', label: 'Logs' }, { value: 'queue', label: 'Queue' }]} />}
      {tab === 'output' && <CodeBlock code={failed.length ? failed.map((n) => `${n.id}: ${n.error}`).join('\n') : 'Nothing printed yet.'} />}
      {tab === 'logs' && (
        <div className="text-[12.5px] phone:text-[13px]">
          {!logs.length && <p className="m-0 py-1 text-fg-3">No run yet. Run writes each node's lines here.</p>}
          {logs.map(([t, n, line], i) => (
            <div key={i} className="grid grid-cols-[64px_88px_minmax(0,1fr)] gap-2 border-b border-rule py-1 last:border-0 phone:grid-cols-[72px_minmax(0,1fr)]">
              <span className="num text-fg-4">{t}</span>
              <span className="mono truncate text-fg-2 phone:hidden">{n}</span>
              <span className={cn('truncate', line.startsWith('Failed') ? 'text-fault' : 'text-fg-2')}>{line}</span>
            </div>
          ))}
        </div>
      )}
      {tab === 'queue' &&
        QUEUE.map((q, i) => (
          <div key={i} className="flex items-baseline gap-3 border-b border-rule py-1.5 text-[13px] last:border-0">
            <span className="mono min-w-0 flex-1 truncate text-fg">{q.name}</span>
            <span className="truncate text-[12px] text-fg-3">{q.words}</span>
            <StateWord tone={q.state === 'running' ? 'signal' : q.state === 'failed' ? 'fault' : q.state === 'done' ? 'ok' : 'dim'} className="shrink-0">
              {q.state === 'running' ? <Elapsed since={q.since} /> : q.state}
            </StateWord>
          </div>
        ))}
    </>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="pb-1.5 text-[12px] font-medium text-fg-2">{title}</div>
      {children}
    </div>
  );
}

/** Nothing selected: what the file is. */
function FileFacts({ file, doc }: { file: CanvasFile; doc: Doc }) {
  return (
    <div className="space-y-4 px-5 py-4">
      <div>
        <div className="t-title mono text-fg">{fileTitle(file)}</div>
        <div className="mt-0.5 text-[12px] text-fg-3">{[KIND_WORD[file.kind], file.path, file.device].filter(Boolean).join(', ')}</div>
      </div>
      <p className="m-0 text-[13px] text-fg-2">{doc.nodes.length ? `${doc.nodes.length} nodes, ${doc.edges.length} wires. Pick a node to see its settings, its inputs and its last value.` : 'No nodes yet. Double-click the canvas, or drag one from the library.'}</p>
      <Link href="/canvas" className="text-[13px] text-fg-2 underline underline-offset-2 hov:text-fg">
        All programs and workflows
      </Link>
    </div>
  );
}

/** The selected node: state, settings at full size, wires, last value, code. */
function Inspector({ node, doc, file, onWidget, onClose }: { node: CNode; doc: Doc; file: CanvasFile; onWidget: (id: string, name: string, v: Widget['value']) => void; onClose: () => void }) {
  const phone = useIsMobile();
  const item = libraryItem(node.kind);
  const tone = stateTone(node.state);
  const size = phone ? 'touch' : 'md';
  return (
    <div className="flex flex-col">
      <div className="border-b border-rule px-5 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="t-title mono min-w-0 truncate text-fg">{node.id}</div>
          {node.state && <span className={cn('cv-state shrink-0 text-[13px]', tone.text)}>{node.state}</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-fg-3">
          {item?.title}: {item?.help}. {node.lines ? `${node.lines} of ${file.path}.` : ''}
        </div>
      </div>
      <div className="space-y-5 px-5 py-4">
        {node.state === 'running' && (
          <div className="space-y-1.5">
            <Meter value={(node.progress ?? 0) * 100} tone="signal" label={`${node.id} progress`} />
            <div className="flex justify-between text-[12px] text-fg-3">
              <span>{node.step}</span>
              <Elapsed since={node.startedAt} className="num" />
            </div>
          </div>
        )}
        {node.state === 'failed' && (
          <div className="space-y-2">
            <Notice tone="fault">{node.error}</Notice>
            <div className="flex gap-2">
              <Button variant="outline" size={size} onClick={() => toast({ title: `Mock: runs ${node.id} again.` })}>
                Re-run this node
              </Button>
              <Button variant="ghost" size={size} onClick={() => toast({ title: 'Mock: a Code session opens with the error and the node.' })}>
                Ask the agent
              </Button>
            </div>
          </div>
        )}
        {node.widgets.map((w) => (
          <Field key={w.name} label={w.name}>
            {w.kind === 'combo' ? (
              <Select value={String(w.value)} onChange={(e) => onWidget(node.id, w.name, e.target.value)}>
                {w.options?.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : w.kind === 'toggle' ? (
              <OnOff checked={!!w.value} onChange={(v) => onWidget(node.id, w.name, v)} label={w.name} size={phone ? 'touch' : 'sm'} />
            ) : (
              <Input value={String(w.value)} onChange={(e) => onWidget(node.id, w.name, w.kind === 'number' ? Number(e.target.value) : e.target.value)} />
            )}
          </Field>
        ))}
        <Block title="Inputs and outputs">
          <div className="text-[13px]">
            {[...node.inputs.map((p) => ({ p, dir: 'in' as const })), ...node.outputs.map((p) => ({ p, dir: 'out' as const }))].map(({ p, dir }) => {
              const wires = doc.edges.filter((e) => (dir === 'in' ? e.to === node.id && e.in === p.name : e.from === node.id && e.out === p.name));
              const words = wires.length ? (dir === 'in' ? `from ${wires.map((e) => `${e.from}.${e.out}`).join(', ')}` : `to ${wires.map((e) => e.to).join(', ')}`) : p.optional ? 'not wired, optional' : 'not wired';
              return (
                <div key={dir + p.name} className="flex items-baseline gap-2 border-b border-rule py-1.5 last:border-0">
                  <span className="w-8 shrink-0 text-[12px] text-fg-4">{dir}</span>
                  <span className="text-fg">{p.name}</span>
                  <span className="text-[12px] text-fg-3">{p.type}</span>
                  <span className={cn('ml-auto min-w-0 truncate text-[12px]', wires.length ? 'text-fg-2' : 'text-fg-3')}>{words}</span>
                </div>
              );
            })}
          </div>
        </Block>
        {node.state === 'done' && node.summary && (
          <Block title={`Value, last run, ${node.spent}`}>
            <CodeBlock code={node.summary} />
          </Block>
        )}
        <Block title="Code">
          <CodeBlock code={node.source ?? `// ${node.lines ?? ''} of ${file.path}`} lang="ts" />
        </Block>
        <div className="flex gap-2">
          <Button variant="ghost" size={size} onClick={() => toast({ title: `Mock: opens ${file.path} at ${node.lines}.` })}>
            Edit as code
          </Button>
          <Button variant="ghost" size={size} onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
