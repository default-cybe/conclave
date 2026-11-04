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
import { Controls, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeChange } from '@xyflow/react';
import type { FlowBlockSpec, FlowNodeLive, NodeRun, WorkflowGraph } from '@conclave/core/client';
import { useIsMobile } from '@/lib/hooks';
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
  /** Set on a workflow you own: a double-click on empty canvas, or a wire dropped there, opens the node search. */
  onInsert?: (kind: string, after?: string) => void;
  /** What the node search offers; the workflow nodes by default. */
  inserts?: InsertItem[];
  /** A program flow: block nodes, a value label on each wire from the last run, and wires drawn to an input. */
  flow?: { blocks: Map<string, FlowBlockSpec>; live?: Record<string, FlowNodeLive>; onConnect?: (from: string, to: string, input: string) => void };
}

export interface InsertItem {
  kind: string;
  word: string;
  help: string;
}
const INSERTS: InsertItem[] = [
  { kind: 'agent', word: 'Agent', help: 'One agent call' },
  { kind: 'parallel', word: 'Parallel', help: 'Two agents at once' },
  { kind: 'check', word: 'Check', help: 'Run a command' },
  { kind: 'approve', word: 'Approve', help: 'Wait for your yes' },
  { kind: 'ask', word: 'Ask', help: 'A question for you' },
];

/** The node search: type to filter, arrows and Enter pick, Escape closes. */
function NodeSearch({ at, after, items, onPick, onClose }: { at: { x: number; y: number }; after?: string; items: InsertItem[]; onPick: (k: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = items.filter((x) => `${x.word} ${x.help}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="absolute z-10 w-[240px] rounded-[var(--r-2)] border border-rule-2 bg-raise p-1.5" style={{ left: at.x, top: at.y }} role="dialog" aria-label="Add a node">
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
      <ul role="listbox" className="pt-1">
        {list.map((x, n) => (
          <li key={x.kind} role="option" aria-selected={n === i}>
            <button type="button" className={`flex w-full items-baseline justify-between gap-2 rounded-[var(--r-1)] px-2 py-1.5 text-left text-[13px] ${n === i ? 'bg-hover text-fg' : 'text-fg-2'}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(x.kind)}>
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

function Canvas({ graph, runs, stale, selected, currentPhase, onSelect, className, positions, onMove, onInsert, inserts = INSERTS, flow: program }: GraphCanvasProps) {
  const [search, setSearch] = useState<{ x: number; y: number; after?: string }>();
  const openSearch = (clientX: number, clientY: number, after?: string) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setSearch({ x: Math.max(8, Math.min(clientX - r.left, r.width - 248)), y: Math.max(8, Math.min(clientY - r.top, r.height - 240)), after });
  };
  const flow = useReactFlow();
  const vertical = useIsMobile();
  const box = useRef<HTMLDivElement>(null);
  // the node under the pointer while it drags; it is saved only on drop
  const [drag, setDrag] = useState<{ id: string; x: number; y: number }>();
  const last = useRef<{ id: string; x: number; y: number }>(undefined);
  const draggable = !!onMove && !vertical;
  const onNodesChange = (changes: NodeChange[]) => {
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
  const { nodes, edges } = useMemo(() => {
    const { pos, bands } = placedGraph(graph, vertical, drag ? { ...positions, [drag.id]: { x: drag.x, y: drag.y } } : positions);
    const staleSet = new Set(stale);
    const bandNodes: Node[] = bands.map((b, i) => ({
      id: `band-${i}`,
      type: 'band',
      position: { x: b.x, y: b.y },
      data: { title: b.title, current: b.title === currentPhase, w: b.w, h: b.h } satisfies BandData,
      selectable: false,
      focusable: false,
      zIndex: -1,
    }));
    const connectable = !!program?.onConnect && !vertical;
    const wf: Node[] = graph.nodes.map((n) => {
      const live = program?.live?.[n.id];
      return {
        id: n.id,
        type: program ? 'flow' : 'wf',
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        data: { node: n, run: runs?.get(n.id), stale: staleSet.has(n.id), selected: n.id === selected, vertical, ...(program ? { spec: n.block ? program.blocks.get(n.block) : undefined, live, connectable } : {}) } satisfies FlowNodeData,
        ariaLabel: program ? `${n.label}, ${n.kind === 'block' ? (program.blocks.get(n.block ?? '')?.title ?? n.block) : 'code'}${live ? (live.ok ? `, ${live.summary ?? 'done'}` : ', failed') : ''}` : `${n.label}, ${n.kind}${runs?.get(n.id) ? `, ${runs.get(n.id)!.state}` : ''}`,
        draggable,
      };
    });
    const es: Edge[] = graph.edges.map((e) => {
      if (program) {
        // a block's wire lands on its input's handle; the label is the value that went through it last run
        const to = graph.nodes.find((n) => n.id === e.to);
        const label = program.live?.[e.from]?.summary;
        return { id: `${e.from}>${e.to}.${e.name}`, source: e.from, target: e.to, ...(to?.kind === 'block' && e.name ? { targetHandle: e.name } : {}), type: 'smoothstep', focusable: false, ...(label ? { label, className: 'cv-wire-value' } : {}) };
      }
      const live = runs?.get(e.to)?.state === 'running';
      return { id: `${e.from}>${e.to}`, source: e.from, target: e.to, type: 'smoothstep', className: live ? 'cv-wire-live' : undefined, focusable: false };
    });
    return { nodes: [...bandNodes, ...wf], edges: es };
  }, [graph, runs, stale, selected, currentPhase, vertical, positions, drag, draggable, program]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) void flow.fitView({ padding: 0.12, duration: 200 });
      if (e.key === 'Escape') onSelect(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flow, onSelect]);

  // the inspector opens over the canvas: once it has slid in, pan so the tapped node sits in the part it leaves free
  useEffect(() => {
    if (!selected) return;
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
  }, [selected, flow]);

  return (
    <div className={className} ref={box} style={{ position: 'relative' }}>
      <ReactFlow
        className="cv-graph"
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={draggable}
        onNodesChange={draggable ? onNodesChange : undefined}
        nodesConnectable={!!onInsert && !vertical}
        zoomOnDoubleClick={!onInsert}
        onDoubleClick={onInsert ? (e) => (e.target as HTMLElement).classList.contains('react-flow__pane') && openSearch(e.clientX, e.clientY) : undefined}
        // a wire let go on empty canvas: the new node goes after the one it came from
        onConnect={program?.onConnect ? (c) => c.source && c.target && c.targetHandle && program.onConnect!(c.source, c.target, c.targetHandle) : undefined}
        onConnectEnd={
          onInsert
            ? (e, s) => {
                if (s.isValid || !s.fromNode) return;
                const p = 'changedTouches' in e ? e.changedTouches[0] : e;
                openSearch(p.clientX, p.clientY, s.fromNode.id);
              }
            : undefined
        }
        elementsSelectable
        zoomOnPinch
        panOnDrag
        minZoom={0.2}
        maxZoom={1.6}
        // open on the first band at a readable size, top left: a centred fit clipped the first band and shrank the text
        defaultViewport={{ x: 16, y: 16, zoom: vertical ? 1 : 0.9 }}
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
        {/* a phone pinches; the buttons covered the column's nodes */}
        {!vertical && <Controls showInteractive={false} position="bottom-right" />}
      </ReactFlow>
      {search && onInsert && (
        <NodeSearch
          at={search}
          after={search.after}
          items={inserts}
          onClose={() => setSearch(undefined)}
          onPick={(k) => {
            setSearch(undefined);
            onInsert(k, search.after);
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
