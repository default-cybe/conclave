/**
 * The Canvas mode's editor surface (design/canvas-mode SPEC.md 5 and 6), on
 * React Flow like features/graph/GraphCanvas.tsx. ComfyUI's feel: a node is
 * a box with its inputs at the left edge, outputs at the right edge and its
 * widgets inline; wires are curves from port to port; double-click or a
 * long press on empty canvas opens the node search; right click opens the
 * context menu; a wire let go on empty canvas opens the search and wires the
 * new node. The minimap sits bottom right. No background grid (SPEC 2)
 * unless ?grid=1, which exists only so the owner can compare.
 */
import '@xyflow/react/dist/base.css';
import './canvas.css';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { Elapsed } from '@/components/motion/Elapsed';
import { Meter } from '@/components/ui/Meter';
import { MenuList, type MenuItem } from '@/components/ui/Overlay';
import { MOD } from '@/components/ui/Kbd';
import { cn } from '@/lib/text';
import { stateTone } from '../graph/nodes';
import { FAMILIES, libraryItem, searchLibrary, type CEdge, type CGroup, type CNode, type FileKind, type Widget } from './fixture';

export const NODE_W = 240;

const STATE_WORD: Record<string, string> = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', skipped: 'skipped', waiting: 'waiting for you', cached: 'cached' };

interface NodeData extends Record<string, unknown> {
  node: CNode;
  selected: boolean;
  phone: boolean;
  onWidget: (id: string, name: string, value: Widget['value']) => void;
}

const WIDGET = 'nodrag h-6 w-full min-w-0 rounded-[var(--r-1)] border border-edge bg-sunk px-1.5 text-[12px] text-fg focus:border-signal focus:outline-none';

/** One widget inline on the node, as ComfyUI draws them; the inspector has the same fields at full size. */
function InlineWidget({ w, onChange }: { w: Widget; onChange: (v: Widget['value']) => void }) {
  if (w.kind === 'combo')
    return (
      <select aria-label={w.name} value={String(w.value)} onChange={(e) => onChange(e.target.value)} className={cn(WIDGET, 'appearance-none')}>
        {w.options?.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  if (w.kind === 'toggle')
    return (
      <button type="button" aria-pressed={!!w.value} onClick={() => onChange(!w.value)} className={cn(WIDGET, 'text-left')}>
        {w.value ? 'On' : 'Off'}
      </button>
    );
  return <input aria-label={w.name} value={String(w.value)} inputMode={w.kind === 'number' ? 'decimal' : undefined} onChange={(e) => onChange(w.kind === 'number' ? Number(e.target.value) : e.target.value)} className={WIDGET} />;
}

const CanvasNode = memo(function CanvasNode({ data }: NodeProps) {
  const { node, selected, onWidget } = data as NodeData;
  const item = libraryItem(node.kind);
  const tone = stateTone(node.state);
  const rows = Math.max(node.inputs.length, node.outputs.length);
  return (
    <div className={cn('cv-node rounded-[var(--r-2)] border bg-raise text-left', tone.outline, selected && 'cv-node-selected', node.kind === 'code' && 'border-dashed', node.state === 'skipped' && 'opacity-60')} style={{ width: NODE_W }} data-state={node.state ?? 'idle'}>
      <div className="flex items-baseline justify-between gap-2 px-3 pt-2">
        <span className="mono min-w-0 truncate text-[13px] font-medium text-fg">{node.id}</span>
        {node.state && <span className={cn('cv-state shrink-0 text-[12px]', tone.text)}>{STATE_WORD[node.state]}</span>}
      </div>
      <div className="flex items-baseline justify-between gap-2 px-3 pb-2 text-[12px] text-fg-3">
        <span className="truncate">{item?.title ?? node.kind}</span>
        {node.lines && <span className="mono shrink-0 text-[11px] text-fg-4">{node.lines}</span>}
      </div>
      {rows > 0 && (
        <div className="grid grid-cols-2 border-t border-rule py-1">
          <div>
            {node.inputs.map((p) => (
              <div key={p.name} className="relative flex h-[22px] items-center gap-1.5 pl-3 text-[12px]">
                <Handle type="target" id={p.name} position={Position.Left} className="cv-port" />
                <span className="truncate text-fg-2">{p.name}</span>
                <span className="shrink-0 text-fg-4">{p.type}</span>
              </div>
            ))}
          </div>
          <div>
            {node.outputs.map((p) => (
              <div key={p.name} className="relative flex h-[22px] items-center justify-end gap-1.5 pr-3 text-[12px]">
                <span className="shrink-0 text-fg-4">{p.type}</span>
                <span className="truncate text-fg-2">{p.name}</span>
                <Handle type="source" id={p.name} position={Position.Right} className="cv-port" />
              </div>
            ))}
          </div>
        </div>
      )}
      {node.widgets.length > 0 && (
        <div className="space-y-1 border-t border-rule px-3 py-2">
          {node.widgets.map((w) => (
            <label key={w.name} className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 text-[12px] text-fg-3">
              <span className="truncate">{w.name}</span>
              <InlineWidget w={w} onChange={(v) => onWidget(node.id, w.name, v)} />
            </label>
          ))}
        </div>
      )}
      {node.kind === 'code' && node.source && <pre className="mono m-0 truncate border-t border-rule px-3 py-2 text-[11.5px] text-fg-2">{node.source}</pre>}
      <NodeFoot node={node} />
    </div>
  );
});

/** The run's line at the foot: progress while it runs, what it spent once done, the error when it failed. */
function NodeFoot({ node }: { node: CNode }) {
  if (node.state === 'running')
    return (
      <div className="space-y-1.5 border-t border-rule px-3 py-2">
        <Meter value={(node.progress ?? 0) * 100} tone="signal" label={`${node.id}, ${Math.round((node.progress ?? 0) * 100)}%`} />
        <div className="flex justify-between text-[12px] text-fg-3">
          <span>{node.step ?? 'working'}</span>
          <Elapsed since={node.startedAt} className="num" />
        </div>
      </div>
    );
  if (node.state === 'failed') return <p className="m-0 line-clamp-3 border-t border-rule px-3 py-2 text-[12px] leading-[1.4] text-fault [overflow-wrap:anywhere]">{node.error}</p>;
  if (node.state === 'done')
    return (
      <div className="flex justify-between gap-2 border-t border-rule px-3 py-1.5 text-[12px] text-fg-3">
        <span className="min-w-0 truncate text-fg-2">{node.summary}</span>
        <span className="num shrink-0">{node.spent}</span>
      </div>
    );
  return null;
}

const GroupBox = memo(function GroupBox({ data }: NodeProps) {
  const g = data as unknown as CGroup;
  return (
    <div className="cv-group rounded-[var(--r-2)] border border-rule-2" style={{ width: g.w, height: g.h }}>
      <div className="px-3 pt-2 text-[13px] font-medium text-fg-2">{g.title}</div>
    </div>
  );
});

const NODE_TYPES = { c: CanvasNode, group: GroupBox };

/** The node search: type to filter, arrows and Enter pick, Escape closes. Families as group labels, like ComfyUI's. */
export function NodeSearch({ kind, onPick, onClose, className, style, autoFocus = true }: { kind: FileKind; onPick: (k: string) => void; onClose?: () => void; className?: string; style?: React.CSSProperties; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const term = q.trim().toLowerCase();
  const list = searchLibrary(kind, term);
  const groups = term ? [{ fam: 'Best match', rows: list }] : FAMILIES.map((fam) => ({ fam, rows: list.filter((x) => x.family === fam) }));
  return (
    <div className={className} style={style} role="dialog" aria-label="Add a node">
      <input
        autoFocus={autoFocus}
        value={q}
        placeholder="Search nodes"
        aria-label="Search nodes"
        className="w-full rounded-[var(--r-1)] border border-edge bg-sunk px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-signal phone:h-11 phone:text-[15px]"
        onChange={(e) => {
          setQ(e.target.value);
          setI(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose?.();
          else if (e.key === 'ArrowDown') setI((n) => Math.min(n + 1, list.length - 1));
          else if (e.key === 'ArrowUp') setI((n) => Math.max(n - 1, 0));
          else if (e.key === 'Enter' && list[i]) onPick(list[i].kind);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <div role="listbox" aria-label="Nodes" className="scroll-y min-h-0 flex-1 pt-1">
        {groups.map(({ fam, rows }) => {
          if (!rows.length) return null;
          return (
            <div key={fam} role="group" aria-label={fam}>
              <div className="px-2 pt-2 pb-1 text-[12px] text-fg-3">{fam}</div>
              {rows.map((x) => {
                const n = list.indexOf(x);
                return (
                  <button
                    key={x.kind}
                    type="button"
                    role="option"
                    aria-selected={n === i}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('application/x-conclave-node', x.kind)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(x.kind)}
                    className={cn('flex w-full items-baseline justify-between gap-2 rounded-[var(--r-1)] px-2 py-1.5 text-left text-[13px] phone:min-h-11 phone:items-center phone:text-[15px]', n === i ? 'bg-hover text-fg' : 'text-fg-2 hov:bg-hover')}
                  >
                    <span className="shrink-0">{x.title}</span>
                    <span className="min-w-0 truncate text-[12px] text-fg-3 phone:text-[13px]">{x.help}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {!list.length && <p className="m-0 px-2 py-1.5 text-[12px] text-fg-3">No node by that name.</p>}
      </div>
    </div>
  );
}

export interface CanvasGraphProps {
  kind: FileKind;
  nodes: CNode[];
  edges: CEdge[];
  groups: CGroup[];
  selected?: string;
  phone: boolean;
  readOnly?: boolean;
  onSelect: (id: string | undefined) => void;
  onMove: (id: string, x: number, y: number, done: boolean) => void;
  onWidget: NodeData['onWidget'];
  onConnect: (e: Omit<CEdge, 'id'>) => void;
  /** Add a node of a kind at a flow position; `wireFrom` wires the new node's first input from that output. */
  onAdd: (kind: string, at: { x: number; y: number }, wireFrom?: { node: string; out: string }) => void;
  onRemove: (id: string) => void;
  onCopy: (id: string) => void;
  onPaste: (at?: { x: number; y: number }) => void;
  onGroup: (id: string) => void;
  onRunFrom: (id: string) => void;
}

/**
 * Where the canvas opens: the running (else failed) node and its neighbours,
 * upstream only on a phone. The whole graph at 1440 (an ~800px pane between
 * library and inspector) is too small to read; F fits it all.
 */
function focusNodes(p: CanvasGraphProps): Array<{ id: string }> | undefined {
  const at = p.nodes.find((n) => n.state === 'running') ?? p.nodes.find((n) => n.state === 'failed');
  if (!at) return undefined;
  const near = p.edges.flatMap((e) => (e.to === at.id ? [e.from] : !p.phone && e.from === at.id ? [e.to] : []));
  return [at.id, ...near].map((id) => ({ id }));
}

function Graph(p: CanvasGraphProps) {
  const flow = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState<{ x: number; y: number; wireFrom?: { node: string; out: string } }>();
  const [menu, setMenu] = useState<{ x: number; y: number; node?: string }>();
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number }>(undefined);
  // controlled nodes lose React Flow's measured size each render; the minimap needs it
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});
  const grid = typeof location !== 'undefined' && new URLSearchParams(location.search).has('grid');

  const local = (clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top, w: r.width, h: r.height };
  };
  const openSearch = (clientX: number, clientY: number, wireFrom?: { node: string; out: string }) => {
    const l = local(clientX, clientY);
    setMenu(undefined);
    setSearch(p.phone ? { x: 0, y: 0, wireFrom } : { x: Math.max(8, Math.min(l.x, l.w - 300)), y: Math.max(8, Math.min(l.y, l.h - 360)), wireFrom });
    searchAt.current = flow.screenToFlowPosition({ x: clientX, y: clientY });
  };
  const searchAt = useRef({ x: 0, y: 0 });

  const rfNodes: Node[] = useMemo(
    () => [
      ...p.groups.map((g) => ({ id: g.id, type: 'group', position: { x: g.x, y: g.y }, measured: { width: g.w, height: g.h }, data: g as unknown as Record<string, unknown>, selectable: false, draggable: false, focusable: false, zIndex: -1 })),
      ...p.nodes.map((n) => ({
        id: n.id,
        type: 'c',
        position: { x: n.x, y: n.y },
        measured: dims[n.id],
        data: { node: n, selected: n.id === p.selected, phone: p.phone, onWidget: p.onWidget } satisfies NodeData,
        ariaLabel: `${n.id}, ${libraryItem(n.kind)?.title ?? n.kind}${n.state ? `, ${STATE_WORD[n.state]}` : ''}`,
        draggable: !p.readOnly,
      })),
    ],
    [p.nodes, p.groups, p.selected, p.phone, p.onWidget, p.readOnly, dims],
  );
  const rfEdges: Edge[] = useMemo(
    () =>
      p.edges.map((e) => {
        const src = p.nodes.find((n) => n.id === e.from);
        const dst = p.nodes.find((n) => n.id === e.to);
        // short values only: a long one covers the wire it labels
        const label = src?.state === 'done' && src.summary && src.summary.length <= 16 ? src.summary : undefined;
        return {
          id: e.id,
          source: e.from,
          sourceHandle: e.out,
          target: e.to,
          targetHandle: e.in,
          className: cn(dst?.state === 'running' && 'cv-wire-live', (e.from === p.selected || e.to === p.selected) && 'cv-wire-near', label && 'cv-wire-value'),
          ...(label && !p.phone ? { label } : {}),
        };
      }),
    [p.edges, p.nodes, p.selected, p.phone],
  );

  const onNodesChange = (changes: NodeChange[]) => {
    const sized = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : []));
    if (sized.length) setDims((d) => ({ ...d, ...Object.fromEntries(sized) }));
    for (const c of changes) {
      if (c.type !== 'position') continue;
      // the drop has no position: the node stays where the last drag frame put it
      const n = p.nodes.find((x) => x.id === c.id);
      const at = c.position ?? n;
      if (at) p.onMove(c.id, Math.round(at.x), Math.round(at.y), !c.dragging);
    }
  };

  // keys while the canvas is open (SPEC 6.5); not while typing in a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        setSearch(undefined);
        setMenu(undefined);
        p.onSelect(undefined);
      } else if (!mod && e.key === 'f') void flow.fitView({ padding: 0.1, duration: 200 });
      else if (!mod && e.key === '/') {
        e.preventDefault();
        const r = box.current!.getBoundingClientRect();
        openSearch(r.left + r.width / 2 - 140, r.top + 80);
      } else if (p.selected && (e.key === 'Delete' || e.key === 'Backspace') && !p.readOnly) p.onRemove(p.selected);
      else if (mod && e.key.toLowerCase() === 'c' && p.selected) p.onCopy(p.selected);
      else if (mod && e.key.toLowerCase() === 'v' && !p.readOnly) p.onPaste();
      else if (mod && e.key.toLowerCase() === 'g' && p.selected && !p.readOnly) {
        e.preventDefault();
        p.onGroup(p.selected);
      } else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const items: MenuItem[] = menu?.node
    ? [
        { group: true, label: menu.node },
        { label: 'Run from here', onSelect: () => p.onRunFrom(menu.node!) },
        { label: 'Copy', hint: `${MOD} C`, onSelect: () => p.onCopy(menu.node!) },
        { label: 'Group', hint: `${MOD} G`, disabled: p.readOnly, onSelect: () => p.onGroup(menu.node!) },
        { label: 'Edit as code', onSelect: () => {} },
        { separator: true, label: '' },
        { label: 'Remove', hint: 'Del', danger: true, disabled: p.readOnly, onSelect: () => p.onRemove(menu.node!) },
      ]
    : [
        { label: 'Add a node', hint: p.phone ? undefined : <span>double-click</span>, disabled: p.readOnly, onSelect: () => menu && openSearch(menu.x + box.current!.getBoundingClientRect().left, menu.y + box.current!.getBoundingClientRect().top) },
        { label: 'Paste', hint: `${MOD} V`, disabled: p.readOnly, onSelect: () => menu && p.onPaste(flow.screenToFlowPosition({ x: menu.x + box.current!.getBoundingClientRect().left, y: menu.y + box.current!.getBoundingClientRect().top })) },
        { label: 'Fit to screen', hint: 'F', onSelect: () => void flow.fitView({ padding: 0.1, duration: 200 }) },
      ];

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = undefined;
  };

  return (
    <div
      ref={box}
      className="relative min-h-0 flex-1"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const k = e.dataTransfer.getData('application/x-conclave-node');
        if (k && !p.readOnly) p.onAdd(k, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
      // long press on empty canvas: the search, as a double-click does with a mouse
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch' || !(e.target as HTMLElement).classList.contains('react-flow__pane') || p.readOnly) return;
        const { clientX: x, clientY: y } = e;
        press.current = { x, y, t: setTimeout(() => openSearch(x, y), 500) };
      }}
      onPointerMove={(e) => press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8 && cancelPress()}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
    >
      <ReactFlow
        className="cv-canvas"
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        nodesConnectable={!p.readOnly}
        zoomOnDoubleClick={false}
        onDoubleClick={(e) => !p.readOnly && (e.target as HTMLElement).classList.contains('react-flow__pane') && openSearch(e.clientX, e.clientY)}
        onConnect={(c) => c.source && c.target && c.sourceHandle && c.targetHandle && p.onConnect({ from: c.source, out: c.sourceHandle, to: c.target, in: c.targetHandle })}
        onConnectEnd={(e, s) => {
          if (s.isValid || !s.fromNode || !s.fromHandle?.id || s.fromHandle.type !== 'source') return;
          const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
          openSearch(pt.clientX, pt.clientY, { node: s.fromNode.id, out: s.fromHandle.id });
        }}
        onNodeClick={(_, n) => n.type === 'c' && p.onSelect(n.id)}
        onPaneClick={() => {
          p.onSelect(undefined);
          setMenu(undefined);
          setSearch(undefined);
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          const l = local(e.clientX, e.clientY);
          setMenu({ x: l.x, y: l.y });
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          if (n.type !== 'c') return;
          p.onSelect(n.id);
          const l = local(e.clientX, e.clientY);
          setMenu({ x: l.x, y: l.y, node: n.id });
        }}
        panOnDrag
        selectionOnDrag={false}
        zoomOnPinch
        minZoom={0.2}
        maxZoom={1.8}
        fitView
        // a phone opens on what runs now and what feeds it; the whole graph would be too small to read
        fitViewOptions={{ padding: p.phone ? 0.06 : 0.08, maxZoom: 1, nodes: focusNodes(p) }}
        proOptions={{ hideAttribution: true }}
      >
        {grid && <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--rule-2)" />}
        {!p.phone && <Controls showInteractive={false} position="bottom-left" />}
        {!p.phone && <MiniMap position="bottom-right" pannable zoomable ariaLabel="Minimap" nodeClassName={(n) => (n.type === 'group' ? 'cv-mini-group' : n.id === p.selected ? 'cv-mini-on' : 'cv-mini')} />}
      </ReactFlow>
      {search && (
        <NodeSearch
          kind={p.kind}
          className={cn('absolute z-20 flex flex-col rounded-[var(--r-2)] border border-rule-2 bg-raise p-1.5 shadow-[var(--shadow-pop)]', p.phone ? 'inset-x-2 top-2 max-h-[60%]' : 'max-h-[360px] w-[300px]')}
          style={p.phone ? undefined : { left: search.x, top: search.y }}
          onClose={() => setSearch(undefined)}
          onPick={(k) => {
            setSearch(undefined);
            p.onAdd(k, searchAt.current, search.wireFrom);
          }}
        />
      )}
      {menu && (
        <div className="absolute z-20 w-[220px] rounded-[var(--r-2)] border border-rule-2 bg-raise shadow-[var(--shadow-pop)]" style={{ left: Math.min(menu.x, (box.current?.clientWidth ?? 9999) - 228), top: Math.min(menu.y, (box.current?.clientHeight ?? 9999) - 240) }} onKeyDown={(e) => e.key === 'Escape' && setMenu(undefined)}>
          <MenuList items={items} onDone={() => setMenu(undefined)} label={menu.node ? `${menu.node} actions` : 'Canvas actions'} />
        </div>
      )}
    </div>
  );
}

export function CanvasGraph(props: CanvasGraphProps) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
