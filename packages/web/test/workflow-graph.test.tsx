/**
 * The workflow graph node (features/graph/nodes.tsx): each run state is a
 * word in its token color with the outline (spec 1.2), a node with several
 * calls counts them, and the layout puts phases left to right.
 *
 *   bun test packages/web/test/workflow-graph.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import type { GraphNode, NodeRun, NodeRunState, WorkflowGraph } from '@conclave/core/client';
import { WorkflowNode, metaLine, stateWord } from '../src/features/graph/nodes';
import { clearOf, layoutGraph, placedGraph } from '../src/features/graph/layout';

const node: GraphNode = { id: 'agent-1', kind: 'agent', label: 'review', span: { start: 4, end: 6 }, declares: ['r'], calls: [], source: "await agent('x')", opts: { model: { value: 'deep', start: 0, end: 1, quote: "'" } } };
const run = (state: NodeRunState, o: Partial<NodeRun> = {}): NodeRun => ({ state, seqs: [1], total: 1, done: state === 'done' ? 1 : 0, cached: state === 'cached' ? 1 : 0, running: state === 'running' ? 1 : 0, failed: state === 'failed' ? 1 : 0, inputTokens: 1200, outputTokens: 300, costUsd: 0.04, cachedCostUsd: 0, ...o });

function render(r?: NodeRun): string {
  const props = { id: 'agent-1', data: { node, run: r }, type: 'wf', selected: false, dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0, selectable: true, deletable: false, draggable: false } as never;
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <WorkflowNode {...props} />
    </ReactFlowProvider>,
  );
}

describe('graph node states', () => {
  test.each([
    ['queued', 'queued', 'text-fg-3', 'border-rule-2'],
    ['running', 'running', 'text-signal', 'border-signal'],
    ['cached', 'cached', 'text-fg-3', 'border-rule-2'],
    ['done', 'done', 'text-ok', 'border-rule-2'],
    ['failed', 'failed', 'text-fault', 'border-fault'],
    ['waiting', 'waiting for you', 'text-warn', 'border-warn'],
  ] as const)('%s shows the word %s in its token', (state, word, text, outline) => {
    const html = render(run(state, state === 'running' ? { startedAt: Date.now() - 5000 } : {}));
    expect(html).toContain(`data-state="${state}"`);
    expect(html).toContain(outline);
    expect(html).toMatch(new RegExp(`${text}[^>]*>${word}`));
  });

  test('idle: no state word; the label, line range and model show', () => {
    const html = render();
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('review');
    expect(html).toContain('L4-6');
    expect(html).toContain('Agent, deep');
  });

  test('several calls count, tokens and cost on the meta line', () => {
    expect(stateWord(run('running', { total: 5, done: 2, cached: 1 }))).toBe('3 of 5 done, running');
    expect(stateWord(run('done', { total: 4 }))).toBe('4 done');
    expect(metaLine(node, run('done'))).toBe('Agent, deep, 1.5K tokens, $0.04');
  });
});

describe('the inspector never covers the tapped node', () => {
  const canvas = { left: 0, top: 100, right: 1400, bottom: 800 };
  const node = { x: 1000, y: 100, w: 248, h: 92 };
  test('a side panel: the node pans left of it, the zoom stays', () => {
    const panel = { left: 960, top: 0, right: 1440, bottom: 900 };
    const vp = clearOf(node, { x: 0, y: 0, zoom: 1 }, canvas, panel)!;
    expect(vp.zoom).toBe(1);
    expect(vp.y).toBe(0);
    // the node's right edge ends a margin left of the panel
    expect(canvas.left + vp.x + node.x + node.w).toBe(960 - 24);
  });
  test('a bottom sheet: the node pans above it', () => {
    const sheet = { left: 0, top: 500, right: 390, bottom: 844 };
    const n = { x: 16, y: 400, w: 248, h: 92 };
    const vp = clearOf(n, { x: 0, y: 0, zoom: 1 }, { left: 0, top: 56, right: 390, bottom: 844 }, sheet)!;
    expect(vp.x).toBe(0);
    expect(56 + vp.y + n.y + n.h).toBe(500 - 24);
  });
  test('a node clear of the panel does not move', () => {
    expect(clearOf({ x: 40, y: 40, w: 248, h: 92 }, { x: 0, y: 0, zoom: 1 }, canvas, { left: 960, top: 0, right: 1440, bottom: 900 })).toBeUndefined();
  });
});

describe('layout', () => {
  test('phase bands run left to right in statement order', () => {
    const g: WorkflowGraph = { name: 'x', phases: ['A', 'B'], edges: [], nodes: ['A', 'A', 'B'].map((p, i) => ({ ...node, id: `n${i}`, phase: p })) };
    const { pos, bands } = layoutGraph(g);
    expect(bands.map((b) => b.title)).toEqual(['A', 'B']);
    expect(pos.get('n0')!.x).toBe(pos.get('n1')!.x);
    expect(pos.get('n1')!.y).toBeGreaterThan(pos.get('n0')!.y);
    expect(pos.get('n2')!.x).toBeGreaterThan(bands[0].x + bands[0].w);
  });

  test('a dragged node keeps its place, its band wraps it, the others stay laid out; a phone keeps its column', () => {
    const g: WorkflowGraph = { name: 'x', phases: ['A', 'B'], edges: [], nodes: ['A', 'A', 'B'].map((p, i) => ({ ...node, id: `n${i}`, phase: p })) };
    const auto = layoutGraph(g);
    const { pos, bands } = placedGraph(g, false, { n1: { x: 40, y: 600 } });
    expect(pos.get('n1')).toEqual({ x: 40, y: 600 });
    expect(pos.get('n0')).toEqual(auto.pos.get('n0')!);
    expect(pos.get('n2')).toEqual(auto.pos.get('n2')!);
    expect(bands[0].y + bands[0].h).toBeGreaterThanOrEqual(600 + 92);
    expect(bands[1]).toEqual(auto.bands[1]);
    expect(placedGraph(g, true, { n1: { x: 40, y: 600 } })).toEqual(layoutGraph(g, true));
  });
});
