/**
 * A program flow on the canvas (features/graph/nodes.tsx FlowBlockNode,
 * FlowInspector runWords): a block shows its settings and last value, a failed
 * block shows its error in fault, wires carry the value as a label, and the
 * status line says what the run did.
 *
 *   bun test packages/web/test/flow-graph.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import type { FlowNodeLive, GraphNode } from '@conclave/core/client';
import { parseFlow } from '@conclave/core/flows/graph';
import { BLOCK_BY_NAME } from '@conclave/core/flows/plugins';
import { FlowBlockNode, blockLine } from '../src/features/graph/nodes';
import { runWords } from '../src/features/graph/FlowInspector';
import { rankInserts } from '../src/features/graph/GraphCanvas';
import { SCRAPER_FLOW, SCRAPER_RUN } from '../src/mock/flows';

const graph = parseFlow(SCRAPER_FLOW);
const byId = (id: string) => graph.nodes.find((n) => n.id === id)!;

function render(node: GraphNode, live?: FlowNodeLive): string {
  const data = { node, live, spec: node.block ? BLOCK_BY_NAME.get(node.block) : undefined, connectable: true };
  const props = { id: node.id, data, type: 'flow', selected: false, dragging: false, zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0, selectable: true, deletable: false, draggable: false } as never;
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <FlowBlockNode {...props} />
    </ReactFlowProvider>,
  );
}

describe('flow blocks', () => {
  test('the mock scraper parses into blocks and one code node', () => {
    expect(graph.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual(['url:block', 'data:block', 'posts:block', 'bun:block', 'csv:block', 'code-1:code', 'log-1:block']);
    expect(graph.edges).toContainEqual({ from: 'bun', to: 'code-1', name: 'bun' });
  });

  test('idle: the name, the block and its literal settings; one input handle per input', () => {
    const html = render(byId('bun'));
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('>bun<');
    expect(blockLine(byId('bun'), BLOCK_BY_NAME.get('filter'))).toBe('Filter, field "title", op "contains", value "bun"');
    expect(html.match(/react-flow__handle-left/g)?.length).toBe(4);
    expect(html).toContain('data-handleid="items"');
  });

  test('done: the value summary and time; failed: the error in fault with a dashed code outline', () => {
    const done = render(byId('posts'), SCRAPER_RUN.nodes.posts);
    expect(done).toContain('data-state="done"');
    expect(done).toMatch(/text-ok[^>]*>30 items, 0 ms/);
    const failed = render(byId('code-1'), SCRAPER_RUN.nodes['code-1']);
    expect(failed).toContain('data-state="failed"');
    expect(failed).toContain('border-fault');
    expect(failed).toContain('border-dashed');
    expect(failed).toMatch(/text-fault[^>]*>failed: TypeError/);
  });

  test('block search ranks a name that starts with the text first', () => {
    const items = [
      { kind: 'readFile', word: 'Read file', help: 'Read a file in the project' },
      { kind: 'filter', word: 'Filter', help: 'Keep the items whose field matches' },
      { kind: 'writeFile', word: 'Write file', help: 'Save text to a file' },
      { kind: 'log', word: 'Log', help: 'Print a value' },
    ];
    expect(rankInserts(items, 'fil').map((x) => x.kind)).toEqual(['filter', 'readFile', 'writeFile']);
    expect(rankInserts(items, 'print').map((x) => x.kind)).toEqual(['log']);
    expect(rankInserts(items, ' ')).toEqual(items);
  });

  test('the status line says what the run did', () => {
    expect(runWords(undefined)).toBe('Not run yet.');
    expect(runWords({ ...SCRAPER_RUN, status: 'approval' })).toBe('Waiting for your approval to run.');
    expect(runWords({ ...SCRAPER_RUN, status: 'running', nodes: { a: { ok: true } } })).toBe('Running, 1 blocks done.');
    expect(runWords(SCRAPER_RUN)).toStartWith('Failed at one block. TypeError');
    expect(runWords({ ...SCRAPER_RUN, status: 'done', nodes: {}, startedAt: 0, finishedAt: 1300 })).toBe('Ran in 1.3 s.');
  });
});
