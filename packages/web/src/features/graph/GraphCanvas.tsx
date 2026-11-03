/**
 * The workflow canvas (docs/design/VISUAL-PROGRAMMING.md 7.5) on React Flow:
 * phase bands, one node per statement, wires from a name's declaration to
 * where it is read. Read-only layout: no dragging, no wiring by hand; pinch
 * or wheel zooms, one finger or drag pans, a tap or Enter opens the
 * inspector. F fits the view.
 */
import '@xyflow/react/dist/base.css';
import './graph.css';
import { useEffect, useMemo, useRef } from 'react';
import { Controls, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node } from '@xyflow/react';
import type { NodeRun, WorkflowGraph } from '@conclave/core/client';
import { useIsMobile } from '@/lib/hooks';
import { NODE_H, NODE_W, clearOf, layoutGraph } from './layout';
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
}

function Canvas({ graph, runs, stale, selected, currentPhase, onSelect, className }: GraphCanvasProps) {
  const flow = useReactFlow();
  const vertical = useIsMobile();
  const box = useRef<HTMLDivElement>(null);
  const { nodes, edges } = useMemo(() => {
    const { pos, bands } = layoutGraph(graph, vertical);
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
    const wf: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'wf',
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: { node: n, run: runs?.get(n.id), stale: staleSet.has(n.id), selected: n.id === selected, vertical } satisfies FlowNodeData,
      ariaLabel: `${n.label}, ${n.kind}${runs?.get(n.id) ? `, ${runs.get(n.id)!.state}` : ''}`,
    }));
    const es: Edge[] = graph.edges.map((e) => {
      const live = runs?.get(e.to)?.state === 'running';
      return { id: `${e.from}>${e.to}`, source: e.from, target: e.to, type: 'smoothstep', className: live ? 'cv-wire-live' : undefined, focusable: false };
    });
    return { nodes: [...bandNodes, ...wf], edges: es };
  }, [graph, runs, stale, selected, currentPhase, vertical]);

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
    <div className={className} ref={box}>
      <ReactFlow
        className="cv-graph"
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        zoomOnPinch
        panOnDrag
        minZoom={0.2}
        maxZoom={1.6}
        // open on the first band at a readable size, top left: a centred fit clipped the first band and shrank the text
        defaultViewport={{ x: 16, y: 16, zoom: vertical ? 1 : 0.9 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => n.type === 'wf' && onSelect(n.id)}
        onPaneClick={() => onSelect(undefined)}
        onKeyDown={(e) => {
          const id = (e.target as HTMLElement).closest('.react-flow__node-wf')?.getAttribute('data-id');
          if (id && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onSelect(id);
          }
        }}
      >
        {/* a phone pinches; the buttons covered the column's nodes */}
        {!vertical && <Controls showInteractive={false} position="bottom-right" />}
      </ReactFlow>
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
