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
import { layoutGraph } from '../src/features/graph/layout';

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

describe('layout', () => {
  test('phase bands run left to right in statement order', () => {
    const g: WorkflowGraph = { name: 'x', phases: ['A', 'B'], edges: [], nodes: ['A', 'A', 'B'].map((p, i) => ({ ...node, id: `n${i}`, phase: p })) };
    const { pos, bands } = layoutGraph(g);
    expect(bands.map((b) => b.title)).toEqual(['A', 'B']);
    expect(pos.get('n0')!.x).toBe(pos.get('n1')!.x);
    expect(pos.get('n1')!.y).toBeGreaterThan(pos.get('n0')!.y);
    expect(pos.get('n2')!.x).toBeGreaterThan(bands[0].x + bands[0].w);
  });
});
