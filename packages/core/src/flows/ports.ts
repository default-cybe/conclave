/**
 * Typed ports for program flows (docs/design/CANVAS-MODE.md 6.2): whether a
 * wire from one block's output into another block's input can run, and the
 * short reason when it cannot. Types come from the block catalog
 * (plugins.ts `type`, `gives`, `givesBy`); where one side has none, the wire
 * is allowed. The canvas checks while you drag and the hub checks the
 * connect op again, so a hand-made request cannot skip it.
 */
import type { FlowPortType } from '../client/flows';
import type { GraphNode, WorkflowGraph } from '../client/graph';
import { BLOCK_BY_NAME } from './plugins';

const WORD: Record<FlowPortType, string> = { text: 'text', list: 'a list', record: 'a record', any: 'anything' };

/** What a node's output carries: a block's catalog type (or the setting that decides it), else anything. */
export function givesType(n: GraphNode): FlowPortType {
  if (n.kind !== 'block' || !n.block) return 'any';
  const spec = BLOCK_BY_NAME.get(n.block);
  if (!spec) return 'any';
  if (spec.givesBy) {
    const a = n.args?.[spec.givesBy.input];
    const def = spec.inputs.find((i) => i.name === spec.givesBy!.input)?.default;
    // a wired or computed setting decides at run time: not checked
    const v = a ? (a.ref || a.locked ? undefined : a.value) : def;
    return v === undefined ? 'any' : (spec.givesBy.types[String(v)] ?? 'any');
  }
  return spec.gives ?? 'any';
}

/** The type an input of a block kind takes, else anything. */
export function takesType(block: string | undefined, input: string): FlowPortType {
  return (block && BLOCK_BY_NAME.get(block)?.inputs.find((i) => i.name === input)?.type) || 'any';
}

/**
 * Why `from`'s output cannot go into `input` of `to`, by type, or undefined
 * when it fits. A wire to a field (`data.items`) is not checked: the field's
 * type is known only at run time.
 */
export function typeRefusal(from: GraphNode, to: GraphNode, input: string, field?: string): string | undefined {
  if (field) return undefined;
  const want = takesType(to.block, input);
  const got = givesType(from);
  if (want === 'any' || got === 'any' || want === got) return undefined;
  const name = from.declares[0] ?? from.label;
  const hint = got === 'list' && want === 'text' ? ' Join text makes a list one text.' : got === 'record' ? ' Pick field takes one field of it.' : '';
  return `${input} takes ${WORD[want]}; ${name} gives ${WORD[got]}.${hint}`;
}

/**
 * Everything the canvas checks before it sends a connect op, with the
 * reason it refuses: the input is one a wire can feed, the source is an
 * earlier block with one name, and the types fit.
 */
export function wireRefusal(graph: WorkflowGraph, fromId: string, toId: string, input: string): string | undefined {
  const from = graph.nodes.find((n) => n.id === fromId);
  const to = graph.nodes.find((n) => n.id === toId);
  if (!from || !to) return 'That block is gone; the canvas reloads.';
  if (from === to) return 'A block cannot read its own value.';
  if (to.kind !== 'block' || to.block === 'value') return `${to.label} takes no wires; edit it in the code.`;
  const spec = BLOCK_BY_NAME.get(to.block ?? '')?.inputs.find((i) => i.name === input);
  if (!spec) return `${to.label} has no input ${input}.`;
  if (spec.widget !== 'text') return `${input} is a setting; pick it on the block.`;
  if (to.args?.[input]?.locked) return `${input} is computed; edit it in the code.`;
  if (!from.declares.length) return `${from.label} gives no value.`;
  if (from.declares.length > 1) return `${from.label} sets several names; wire it in the code.`;
  if (graph.nodes.indexOf(from) > graph.nodes.indexOf(to)) return `${from.declares[0]} comes after ${to.label}; a wire runs from an earlier block.`;
  return typeRefusal(from, to, input);
}
