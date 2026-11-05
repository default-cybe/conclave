/**
 * The workflow canvas (docs/design/VISUAL-PROGRAMMING.md 7.5) on React Flow:
 * phase bands, one node per statement, wires from a name's declaration to
 * where it is read. No wiring by hand; pinch or wheel zooms, one finger or
 * drag pans, a tap or Enter opens the inspector. F fits the view. With
 * onMove (a workflow you own, wide screens) nodes drag, and the page saves
 * where they land in the layout side file.
 */
import '@xyflow/react/dist/base.css';
import './graph.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useConnection, useReactFlow, type Edge, type Node, type NodeChange } from '@xyflow/react';
import type { FlowBlockSpec, FlowNodeLive, GraphNode, NodeRun, NodeRunState, WorkflowGraph } from '@conclave/core/client';
import { useIsMobile, useMedia } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { deskViewport, focusViewport } from '../canvas/model';
import { NODE_H, NODE_W, clearOf, placedGraph } from './layout';
import { NODE_TYPES, type BandData, type FlowNodeData } from './nodes';

export interface GraphCanvasProps {
  graph: WorkflowGraph;
  runs?: Map<string, NodeRun>;
  stale?: string[];
  selected?: string;
  /** The phase the run is in now: its band title is in signal. */
  currentPhase?: string;
  onSelect: (id: string | undefined) => void;
  className?: string;
  /** Positions the owner dragged (the layout side file); the rest are laid out. */
  positions?: Record<string, { x: number; y: number }>;
  /** Nodes drag when set; called once where a node is dropped. */
  onMove?: (id: string, at: { x: number; y: number }) => void;
  /** Set on a workflow you own: the Add button, a double-click on empty canvas, or a wire dropped there, opens the node search. at: where the new node goes, in flow coordinates. */
  onInsert?: (kind: string, after?: string, at?: { x: number; y: number }) => void;
  /** Delete or Backspace on the selected nodes (all of a multi-selection). */
  onRemove?: (ids: string[]) => void;
  /** Canvas mode: shift-click and shift-drag select several nodes; the parent keeps the set. */
  selection?: string[];
  onSelection?: (ids: string[]) => void;
  /** Ctrl/Cmd+C on the selection, Ctrl/Cmd+V at the pointer (flow coordinates). */
  onCopy?: (ids: string[]) => void;
  onPaste?: (at: { x: number; y: number }) => void;
  /** A double-click on a node's title edits it in place; `renamable` says which nodes allow it. */
  onRename?: (id: string, name: string) => void;
  renamable?: (n: GraphNode) => boolean;
  /** What the node search offers; the workflow nodes by default. */
  inserts?: InsertItem[];
  /** A program flow: block nodes, a value label on each wire from the last run, and wires drawn to an input. */
  flow?: { blocks: Map<string, FlowBlockSpec>; live?: Record<string, FlowNodeLive>; states?: Record<string, NodeRunState>; onConnect?: (from: string, to: string, input: string) => void; check?: (from: string, to: string, input: string) => string | undefined };
  /** Canvas mode (docs/design/CANVAS-MODE.md): the whole pane, a faint dot grid, a minimap; it opens readable on `focus` (the running or failed node) with the start of the graph (canvas/model deskViewport, focusViewport on a phone). */
  full?: { focus?: string };
}

export interface InsertItem {
  kind: string;
  word: string;
  help: string;
}
export const INSERTS: InsertItem[] = [
  { kind: 'agent', word: 'Agent', help: 'One agent call' },
  { kind: 'parallel', word: 'Parallel', help: 'Two agents at once' },
  { kind: 'check', word: 'Check', help: 'Run a command' },
  { kind: 'approve', word: 'Approve', help: 'Wait for your yes' },
  { kind: 'ask', word: 'Ask', help: 'A question for you' },
];

/**
 * The search's matches, best first: a name that starts with the text, then a
 * word of the name that does, then the name containing it, then the help.
 * Ties keep catalog order.
 */
export function rankInserts(items: InsertItem[], query: string): InsertItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const score = (x: InsertItem) => {
    const w = x.word.toLowerCase();
    if (w.startsWith(q)) return 0;
    if (w.split(/[\s-]+/).some((p) => p.startsWith(q))) return 1;
    if (w.includes(q)) return 2;
    return x.help.toLowerCase().includes(q) ? 3 : -1;
  };
  return items
    .map((x, i) => ({ x, i, s: score(x) }))
    .filter((e) => e.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((e) => e.x);
}

/** The node search: type to filter, arrows and Enter pick, Escape closes. */
function NodeSearch({ at, after, items, onPick, onClose }: { at: { x: number; y: number }; after?: string; items: InsertItem[]; onPick: (k: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = rankInserts(items, q);
  const opened = useRef(Date.now());
  return (
    <div
      className="absolute z-10 w-[240px] rounded-[var(--r-2)] border border-rule-2 bg-raise p-1.5"
      style={{ left: at.x, top: at.y }}
      role="dialog"
      aria-label="Add a node"
      // a long-press opens this under the finger: the lift's mouse events land on the box and must not blur the field
      onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && e.preventDefault()}
    >
      <input
        autoFocus
        value={q}
        placeholder={after ? 'Add a node after this one' : 'Add a node'}
        aria-label="Search nodes"
        className="w-full rounded-[var(--r-1)] bg-sunk px-2 py-1.5 text-[13px] text-fg outline-none"
        onChange={(e) => {
          setQ(e.target.value);
          setI(0);
        }}
        onBlur={() => setTimeout(onClose, 150)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowDown') setI((n) => Math.min(n + 1, list.length - 1));
          else if (e.key === 'ArrowUp') setI((n) => Math.max(n - 1, 0));
          else if (e.key === 'Enter' && list[i]) onPick(list[i].kind);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {/* the lift that opened it (a long-press near an edge) can land on an option: a click in the first 400 ms does not pick */}
      <ul role="listbox" className="pt-1">
        {list.map((x, n) => (
          <li key={x.kind} role="option" aria-selected={n === i}>
            <button type="button" className={`flex w-full items-baseline justify-between gap-2 rounded-[var(--r-1)] px-2 py-1.5 text-left text-[13px] ${n === i ? 'bg-hover text-fg' : 'text-fg-2'}`} onMouseDown={(e) => e.preventDefault()} onClick={() => Date.now() - opened.current > 400 && onPick(x.kind)}>
              <span>{x.word}</span>
              <span className="text-[12px] text-fg-3">{x.help}</span>
            </button>
          </li>
        ))}
        {!list.length && <li className="px-2 py-1.5 text-[12px] text-fg-3">No node by that name.</li>}
      </ul>
    </div>
  );
}

/** A minimap node in its state's token (graph.css), a band as a frame. */
function miniClass(n: Node): string {
  if (n.type === 'band') return 'cv-mini-band';
  const d = n.data as FlowNodeData;
  return `cv-mini cv-mini-${d.run?.state ?? (d.live ? (d.live.ok ? 'done' : 'failed') : (d.state ?? 'idle'))}`;
}

/** The library's drag payload (canvas/CanvasPage Library): a node kind dropped on the canvas lands where it is let go. */
export const DRAG_KIND = 'application/x-conclave-node';

/** While a wire is dragged over a port it cannot go into: the reason, at the pointer. */
function WireHint({ check }: { check: (from: string, to: string, input: string) => string | undefined }) {
  const c = useConnection();
  if (!c.inProgress || !c.toHandle || c.isValid !== false || !c.fromNode || !c.toNode) return null;
  // a wire can start at either end: the output is the source
  const [from, to, input] = c.fromHandle?.type === 'source' ? [c.fromNode.id, c.toNode.id, c.toHandle.id] : [c.toNode.id, c.fromNode.id, c.fromHandle?.id];
  const why = input ? check(from, to, input) : undefined;
  if (!why) return null;
  return (
    <div role="status" className="cv-wire-hint pointer-events-none absolute z-10 max-w-[280px] rounded-[var(--r-1)] border border-fault bg-raise px-2 py-1 text-[12px] text-fg" style={{ left: c.pointer.x + 14, top: c.pointer.y + 14 }}>
      {why}
    </div>
  );
}

function Canvas({ graph, runs, stale, selected, currentPhase, onSelect, className, positions, onMove, onInsert, onRemove, selection, onSelection, onCopy, onPaste, onRename, renamable, inserts = INSERTS, flow: program, full }: GraphCanvasProps) {
  // a refused wire's reason after it is let go, for a few seconds
  const [note, setNote] = useState<{ text: string; x: number; y: number }>();
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(undefined), 5000);
    return () => clearTimeout(t);
  }, [note]);
  const pointer = useRef<{ x: number; y: number }>(undefined);
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number }>(undefined);
  const coarse = useMedia('(pointer: coarse)');
  const [search, setSearch] = useState<{ x: number; y: number; after?: string; at?: { x: number; y: number } }>();
  // at: the flow point the new node goes to (a double-click); the Add button leaves it to the layout
  const openSearch = (clientX: number, clientY: number, after?: string, place = true) => {
    const r = box.current?.getBoundingClientRect();
    const at = place ? flow.screenToFlowPosition({ x: clientX, y: clientY }) : undefined;
    if (r) setSearch({ x: Math.max(8, Math.min(clientX - r.left, r.width - 248)), y: Math.max(8, Math.min(clientY - r.top, r.height - 240)), after, ...(at ? { at: { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 } } : {}) });
  };
  const flow = useReactFlow();
  const vertical = useIsMobile();
  const box = useRef<HTMLDivElement>(null);
  // the node under the pointer while it drags; it is saved only on drop
  const [drag, setDrag] = useState<{ id: string; x: number; y: number }>();
  const last = useRef<{ id: string; x: number; y: number }>(undefined);
  const draggable = !!onMove && !vertical;
  const onNodesChange = (changes: NodeChange[]) => {
    // clicks, shift-clicks and a shift-drag box arrive as select changes
    if (onSelection && changes.some((c) => c.type === 'select')) {
      const next = new Set(selection);
      for (const c of changes) if (c.type === 'select') c.selected ? next.add(c.id) : next.delete(c.id);
      onSelection([...next].filter((id) => graph.nodes.some((n) => n.id === id)));
    }
    for (const c of changes) {
      if (c.type !== 'position') continue;
      if (c.dragging && c.position) {
        last.current = { id: c.id, ...c.position };
        setDrag(last.current);
      } else if (!c.dragging) {
        const d = last.current;
        last.current = undefined;
        setDrag(undefined);
        if (d && d.id === c.id) onMove?.(d.id, { x: d.x, y: d.y });
      }
    }
  };
  const { nodes, edges, bounds } = useMemo(() => {
    const { pos, bands } = placedGraph(graph, vertical, drag ? { ...positions, [drag.id]: { x: drag.x, y: drag.y } } : positions);
    // the bands and the nodes: a program can have no bands
    const boxes = [...bands, ...[...pos.values()].map((p) => ({ ...p, w: NODE_W, h: NODE_H }))];
    const left = Math.min(0, ...boxes.map((b) => b.x));
    const bounds = { x: left, y: 0, w: Math.max(0, ...boxes.map((b) => b.x + b.w)) - left, h: Math.max(0, ...boxes.map((b) => b.y + b.h)) };
    const staleSet = new Set(stale);
    const bandNodes: Node[] = bands.map((b, i) => ({
      id: `band-${i}`,
      type: 'band',
      position: { x: b.x, y: b.y },
      data: { title: b.title, current: b.title === currentPhase, w: b.w, h: b.h } satisfies BandData,
      selectable: false,
      focusable: false,
      zIndex: -1,
      // the minimap draws a node only with a size on the node itself (these nodes are not fed back measured)
      initialWidth: b.w,
      initialHeight: b.h,
    }));
    // Canvas mode wires on touch too (CANVAS-MODE.md 4); the box in a session stays mouse only
    const connectable = !!program?.onConnect && (!vertical || !!full);
    const picked = new Set(selection);
    const wf: Node[] = graph.nodes.map((n) => {
      const live = program?.live?.[n.id];
      return {
        id: n.id,
        type: program ? 'flow' : 'wf',
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        initialWidth: NODE_W,
        initialHeight: NODE_H,
        selected: picked.has(n.id),
        data: { node: n, run: runs?.get(n.id), stale: staleSet.has(n.id), selected: n.id === selected || picked.has(n.id), vertical, ...(onRename && (renamable?.(n) ?? true) ? { onRename } : {}), ...(program ? { spec: n.block ? program.blocks.get(n.block) : undefined, live, connectable, ...(program.states?.[n.id] ? { state: program.states[n.id] } : {}) } : {}) } satisfies FlowNodeData,
        ariaLabel: program ? `${n.label}, ${n.kind === 'block' ? (program.blocks.get(n.block ?? '')?.title ?? n.block) : 'code'}${live ? (live.ok ? `, ${live.summary ?? 'done'}` : ', failed') : ''}` : `${n.label}, ${n.kind}${runs?.get(n.id) ? `, ${runs.get(n.id)!.state}` : ''}`,
        draggable,
      };
    });
    const es: Edge[] = graph.edges.map((e) => {
      if (program) {
        // a block's wire lands on its input's handle; the label is the value that went through it last run
        const to = graph.nodes.find((n) => n.id === e.to);
        const label = program.live?.[e.from]?.summary;
        // the value label sits near the input it feeds, in the gap before it, not on a node's edge
        return { id: `${e.from}>${e.to}.${e.name}`, source: e.from, target: e.to, ...(to?.kind === 'block' && e.name ? { targetHandle: e.name } : {}), focusable: false, ...(label ? { label, className: 'cv-wire-value', labelShowBg: true, labelBgPadding: [4, 2] as [number, number] } : {}) };
      }
      const live = runs?.get(e.to)?.state === 'running';
      // Canvas: a done node's short answer on its wires, as a program's wire shows its value
      const value = full ? runs?.get(e.from)?.value : undefined;
      return { id: `${e.from}>${e.to}`, source: e.from, target: e.to, className: live ? 'cv-wire-live' : value ? 'cv-wire-value' : undefined, focusable: false, ...(value ? { label: value, labelShowBg: true, labelBgPadding: [4, 2] as [number, number] } : {}) };
    });
    return { nodes: [...bandNodes, ...wf], edges: es, bounds };
  }, [graph, runs, stale, selected, selection, currentPhase, vertical, positions, drag, draggable, program, full, onRename, renamable]);

  // open fitted: the whole graph when it reads at 0.55 or more, else the start of it at 0.55; a phone centres its column
  const fitted = useRef(false);
  const fit = (duration = 0) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    // Canvas mode on a phone: the running or failed node with what feeds it above, never an empty half
    const at = full?.focus ? nodes.find((n) => n.id === full.focus) : undefined;
    if (full && vertical) return void flow.setViewport(focusViewport(at ? { ...at.position, w: NODE_W, h: NODE_H } : { x: 0, y: 0, w: NODE_W, h: NODE_H }, bounds, { w: r.width, h: r.height }), { duration });
    // Canvas mode on a computer: readable, with the start and the running or failed node on screen
    if (full) return void flow.setViewport(deskViewport(bounds, at ? { ...at.position, w: NODE_W, h: NODE_H } : undefined, { w: r.width, h: r.height }), { duration });
    if (vertical) return void flow.setViewport({ x: Math.max(8, (r.width - (NODE_W + 32)) / 2), y: 12, zoom: 1 }, { duration });
    void flow.fitView({ padding: 0.08, maxZoom: 1, duration }).then(() => {
      if (flow.getViewport().zoom < 0.55) void flow.setViewport({ x: 16, y: 16, zoom: 0.55 }, { duration });
    });
  };
  // once, after React Flow measured the nodes (useNodesInitialized stays false: the bands have no handles)
  const fitOnce = () => {
    if (fitted.current) return;
    fitted.current = true;
    setTimeout(() => fit(), 120);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (t?.closest('[role=dialog]:not(.cv-inspector)')) return;
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) fit(200);
      if (e.key === 'Escape') {
        onSelect(undefined);
        onSelection?.([]);
      }
      const ids = selection?.length ? selection : selected ? [selected] : [];
      if ((e.key === 'Delete' || e.key === 'Backspace') && ids.length && onRemove) {
        e.preventDefault();
        onRemove(ids);
      }
      // copy and paste: not while text is selected on the page (the inspector's code)
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (mod && e.key.toLowerCase() === 'c' && ids.length && onCopy && !window.getSelection()?.toString()) {
        e.preventDefault();
        onCopy(ids);
      }
      if (mod && e.key.toLowerCase() === 'v' && onPaste) {
        e.preventDefault();
        const r = box.current?.getBoundingClientRect();
        const p = pointer.current ?? (r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 });
        onPaste(flow.screenToFlowPosition(p));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const desk = !!full && !vertical;
  // the inspector opens over the canvas: once it has slid in, pan so the tapped node sits in the part it leaves free
  useEffect(() => {
    // Canvas mode on a computer: the inspector is a column of its own, and a pan would push the first blocks off the left
    if (!selected || desk) return;
    const t = setTimeout(() => {
      const cover = document.querySelector('.cv-inspector')?.getBoundingClientRect();
      const n = flow.getInternalNode(selected);
      const canvas = box.current?.getBoundingClientRect();
      if (!cover || !n || !canvas) return;
      const p = n.internals.positionAbsolute;
      const vp = clearOf({ x: p.x, y: p.y, w: n.measured.width ?? NODE_W, h: n.measured.height ?? NODE_H }, flow.getViewport(), canvas, cover);
      if (vp) void flow.setViewport(vp, { duration: 200 });
    }, 240);
    return () => clearTimeout(t);
  }, [selected, flow, desk]);

  return (
    <div
      className={className}
      ref={box}
      style={{ position: 'relative' }}
      onPointerMove={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY };
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
          clearTimeout(p.t);
          press.current = undefined;
        }
      }}
      // a phone: long-press on empty canvas opens the node search there (CANVAS-MODE.md 4)
      onPointerDown={(e) => {
        // shift-click picks nodes; without this the browser also extends a text selection across the inspector
        if (e.shiftKey && onSelection) window.getSelection()?.removeAllRanges();
        if (!onInsert || !full || e.pointerType !== 'touch' || !(e.target as HTMLElement).classList.contains('react-flow__pane')) return;
        const { clientX: x, clientY: y } = e;
        press.current = { x, y, t: setTimeout(() => ((press.current = undefined), openSearch(x, y)), 500) };
      }}
      onPointerUp={(e) => {
        if (e.shiftKey && onSelection) window.getSelection()?.removeAllRanges();
        if (press.current) (clearTimeout(press.current.t), (press.current = undefined));
      }}
      onPointerCancel={() => press.current && (clearTimeout(press.current.t), (press.current = undefined))}
      onDragOver={
        onInsert
          ? (e) => {
              if (!e.dataTransfer.types.includes(DRAG_KIND)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          : undefined
      }
      onDrop={
        onInsert
          ? (e) => {
              const kind = e.dataTransfer.getData(DRAG_KIND);
              if (!kind) return;
              e.preventDefault();
              const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
              onInsert(kind, undefined, { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 });
            }
          : undefined
      }
    >
      <ReactFlow
        className={cn('cv-graph', full && 'cv-full')}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={draggable}
        onNodesChange={draggable || onSelection ? onNodesChange : undefined}
        nodesConnectable={!!onInsert && (!vertical || !!full)}
        connectionRadius={coarse ? 36 : 20}
        isValidConnection={program?.check ? (c) => !c.targetHandle || !program.check!(c.source, c.target, c.targetHandle) : undefined}
        // ComfyUI: shift-click adds to the selection, Ctrl/Cmd-drag draws a box (a Shift box would cover the nodes and eat the clicks)
        multiSelectionKeyCode={onSelection ? 'Shift' : undefined}
        selectionKeyCode={onSelection ? ['Control', 'Meta'] : undefined}
        zoomOnDoubleClick={!onInsert}
        onDoubleClick={onInsert ? (e) => (e.target as HTMLElement).classList.contains('react-flow__pane') && openSearch(e.clientX, e.clientY) : undefined}
        deleteKeyCode={null}
        // a wire let go on empty canvas: the new node goes after the one it came from
        onConnect={program?.onConnect ? (c) => c.source && c.target && c.targetHandle && program.onConnect!(c.source, c.target, c.targetHandle) : undefined}
        onConnectEnd={
          onInsert
            ? (e, s) => {
                if (s.isValid || !s.fromNode) return;
                const p = 'changedTouches' in e ? e.changedTouches[0] : e;
                // let go on a port that does not fit: say why, and draw nothing
                if (s.toHandle && s.toNode) {
                  const out = s.fromHandle?.type === 'source';
                  const input = out ? s.toHandle.id : s.fromHandle?.id;
                  const why = input && program?.check ? program.check(out ? s.fromNode.id : s.toNode.id, out ? s.toNode.id : s.fromNode.id, input) : undefined;
                  const r = box.current?.getBoundingClientRect();
                  if (why && r) setNote({ text: why, x: p.clientX - r.left, y: p.clientY - r.top });
                  return;
                }
                openSearch(p.clientX, p.clientY, s.fromNode.id);
              }
            : undefined
        }
        elementsSelectable
        minZoom={full ? 0.1 : 0.2}
        maxZoom={1.6}
        defaultViewport={{ x: 16, y: 16, zoom: vertical ? 1 : 0.9 }}
        onInit={fitOnce}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => n.type !== 'band' && onSelect(n.id)}
        onPaneClick={() => onSelect(undefined)}
        onKeyDown={(e) => {
          const id = (e.target as HTMLElement).closest('.react-flow__node-wf, .react-flow__node-flow')?.getAttribute('data-id');
          if (id && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onSelect(id);
          }
        }}
      >
        {/* a phone pinches; the buttons covered the column's nodes. Top right: in a page the bottom edge can be below the window */}
        {!vertical && <Controls showInteractive={false} position={full ? 'bottom-left' : 'top-right'} fitViewOptions={{ padding: 0.08, maxZoom: 1 }} onFitView={() => fit(200)} />}
        {/* the faint dot grid is Canvas's alone: an exception to SPEC 2's no-grid rule (owner decision on PR #250) */}
        {full && <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />}
        {full && !vertical && <MiniMap position="bottom-right" pannable zoomable ariaLabel="Minimap" nodeClassName={miniClass} />}
        {program?.check && <WireHint check={program.check} />}
      </ReactFlow>
      {note && (
        <div role="status" className="cv-wire-hint absolute z-10 max-w-[280px] rounded-[var(--r-1)] border border-fault bg-raise px-2 py-1 text-[12px] text-fg" style={{ left: Math.min(note.x + 14, (box.current?.clientWidth ?? 300) - 290), top: note.y + 14 }}>
          Not wired: {note.text}
        </div>
      )}
      {/* Canvas mode adds from the library, a double-click or a long-press: a button over the canvas covered ports (#251) */}
      {onInsert && !search && !full && (
        <button
          type="button"
          className="absolute bottom-2 left-2 z-[5] flex h-[30px] items-center rounded-[var(--r-2)] border border-rule-2 bg-raise px-3 text-[13px] text-fg-2 hover:bg-hover hover:text-fg coarse:h-11 coarse:px-4 coarse:text-[15px]"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openSearch(r.left, r.bottom + 4, undefined, false);
          }}
        >
          {program ? 'Add block' : 'Add node'}
        </button>
      )}
      {search && onInsert && (
        <NodeSearch
          at={search}
          after={search.after}
          items={inserts}
          onClose={() => setSearch(undefined)}
          onPick={(k) => {
            setSearch(undefined);
            onInsert(k, search.after, search.at);
          }}
        />
      )}
    </div>
  );
}

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
