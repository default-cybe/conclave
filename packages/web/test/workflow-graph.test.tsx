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
import { WorkflowNode, metaLine, nodeTitle, stateWord } from '../src/features/graph/nodes';
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

  test('idle: no state word; the label and model show, the line range is a tooltip', () => {
    const html = render();
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('review');
    expect(html).toContain('title="lines 4 to 6"');
    expect(html).not.toContain('L4-6');
    expect(html).toContain('Agent, deep');
  });

  test('titles are words: code says what it sets, a bare call says its kind', () => {
    const code = { ...node, kind: 'code' as const, label: 'const OPUS', declares: ['OPUS', 'WT'], opts: undefined };
    expect(nodeTitle(code)).toBe('Sets OPUS, WT');
    expect(nodeTitle({ ...code, fn: true, declares: ['rules'], label: 'function rules' })).toBe('Helper rules');
    expect(nodeTitle({ ...node, kind: 'parallel', label: 'parallel' })).toBe('Parallel');
    expect(nodeTitle(node)).toBe('review');
    // a parallel over a list counts the agents that ran, not the one agent() in its text
    expect(metaLine({ ...node, kind: 'parallel', opts: undefined, calls: [{ name: 'agent', line: 5 }] }, run('done', { total: 8 }))).toStartWith('Parallel, 8 agents');
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
    const { pos, bands } = placedGraph(g, false, { n1: { x: 24, y: 600 } });
    expect(pos.get('n1')).toEqual({ x: 24, y: 600 });
    expect(pos.get('n0')).toEqual(auto.pos.get('n0')!);
    expect(pos.get('n2')).toEqual(auto.pos.get('n2')!);
    expect(bands[0].y + bands[0].h).toBeGreaterThanOrEqual(600 + 92);
    expect(bands[1]).toEqual(auto.bands[1]);
    expect(placedGraph(g, true, { n1: { x: 40, y: 600 } })).toEqual(layoutGraph(g, true));
  });

  test('inside a band a wired node sits one column right of its source, so wires run forward', () => {
    const g: WorkflowGraph = { name: 'x', phases: [], edges: [{ from: 'n0', to: 'n1', name: 'a' }, { from: 'n1', to: 'n2', name: 'b' }, { from: 'n0', to: 'n3', name: 'a' }], nodes: [0, 1, 2, 3].map((i) => ({ ...node, id: `n${i}`, phase: undefined })) };
    const { pos } = layoutGraph(g);
    for (const e of g.edges) expect(pos.get(e.to)!.x).toBeGreaterThan(pos.get(e.from)!.x + 248);
    // n1 and n3 both read n0 only: one column, stacked
    expect(pos.get('n3')!.x).toBe(pos.get('n1')!.x);
    expect(pos.get('n3')!.y).toBeGreaterThan(pos.get('n1')!.y);
  });

  test('one phase or none draws no band: the blocks sit on the bare grid, where they were dropped', () => {
    const wired: WorkflowGraph = { name: 'x', phases: [], edges: [{ from: 'n0', to: 'n1', name: 'a' }], nodes: [0, 1].map((i) => ({ ...node, id: `n${i}`, phase: undefined })) };
    expect(layoutGraph(wired).bands).toEqual([]);
    expect(layoutGraph(wired, true).bands).toEqual([]);
    expect(layoutGraph({ ...wired, nodes: [], edges: [] }).bands).toEqual([]);
    const one: WorkflowGraph = { name: 'x', phases: ['A'], edges: [], nodes: ['A', 'A'].map((p, i) => ({ ...node, id: `n${i}`, phase: p })) };
    expect(layoutGraph(one).bands).toEqual([]);
    const dropped = placedGraph(wired, false, { n0: { x: 0, y: 4 } });
    expect(dropped.bands).toEqual([]);
    expect(dropped.pos.get('n0')).toEqual({ x: 0, y: 4 });
  });

  test('a node dragged out of its band stays in it, and one dropped on another moves clear', () => {
    const g: WorkflowGraph = { name: 'x', phases: ['A', 'B'], edges: [], nodes: ['A', 'A', 'B'].map((p, i) => ({ ...node, id: `n${i}`, phase: p })) };
    const auto = layoutGraph(g);
    // dragged right into band B: held at the right edge of band A, which does not grow over B
    const out = placedGraph(g, false, { n1: { x: 2000, y: 40 } });
    expect(out.pos.get('n1')!.x + 248).toBeLessThanOrEqual(out.bands[0].x + out.bands[0].w);
    expect(out.bands[0].x + out.bands[0].w).toBeLessThan(out.bands[1].x);
    // dropped on n0: moved below it
    const on = placedGraph(g, false, { n1: { ...auto.pos.get('n0')! } });
    expect(on.pos.get('n1')!.y).toBeGreaterThanOrEqual(auto.pos.get('n0')!.y + 92);
  });
});
