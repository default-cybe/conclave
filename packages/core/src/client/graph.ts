/**
 * Workflow graphs (docs/design/VISUAL-PROGRAMMING.md 7): the node graph the
 * hub reads from a workflow script (workflows/graph.ts parseGraph), and the
 * pure functions the web app and the tests share to light it up from a run's
 * calls. The script stays the source of truth; a graph is a view of it.
 */
import type { WorkflowCall, WorkflowCallState } from './workflows';

/** block: one statement of a program flow that calls a flows/lib helper (docs/design/VISUAL-PROGRAMMING.md 4.2). */
export type GraphNodeKind = 'agent' | 'parallel' | 'pipeline' | 'check' | 'approve' | 'ask' | 'workflow' | 'return' | 'log' | 'code' | 'block';

/** One input of a flow block: a literal setting, a wire (`ref`, `ref.field`), or a value the canvas cannot edit (`locked`). Offsets of its value in the file. */
export interface FlowArg {
  start: number;
  end: number;
  value?: string | number | boolean;
  quote?: string;
  ref?: string;
  field?: string;
  /** Written as `{ url }`: the span is the key, so a new value is written `url: value`. */
  shorthand?: boolean;
  /** Why it cannot be edited on the canvas, when it is neither a literal nor a reference. */
  locked?: string;
}

/** A literal option value and where its token sits in the script (string offsets). */
export interface GraphLiteral {
  value: string | number | boolean;
  start: number;
  end: number;
  /** The quote character of a string token: ', " or `. */
  quote?: string;
}

/** A call found inside a node's text (a loop or a helper), for Code nodes. */
export interface GraphInnerCall {
  name: string;
  line: number;
  label?: string;
}

export interface GraphNode {
  /** Kind plus its ordinal among nodes of that kind ("agent-2"); stable across literal edits. */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** First and last line of the statement, 1-based. */
  span: { start: number; end: number };
  /** The last phase('...') above it at the top level. */
  phase?: string;
  /** Names the statement declares, the sources of its wires. */
  declares: string[];
  /** Literal options of the options object (agent), by key. */
  opts?: Record<string, GraphLiteral>;
  /** The options object literal's braces, for inserting a missing key. */
  optsObject?: { open: number; close: number };
  /** The string literals of the prompt (a string, or an array of parts joined). */
  promptParts?: GraphLiteral[];
  /** Why the prompt cannot be edited, when it cannot. */
  promptLocked?: string;
  /** The statement declares a function (a helper): its calls run from other nodes. */
  fn?: boolean;
  /** Calls inside the statement (loops, helpers, parallel bodies). */
  calls: GraphInnerCall[];
  /** Flow block: the catalog entry (flows/plugins.ts), e.g. fetchUrl. */
  block?: string;
  /** Flow block: its inputs by name. */
  args?: Record<string, FlowArg>;
  /** Flow block: the statement's offsets in the file. */
  range?: { start: number; end: number };
  /** The statement's exact text. */
  source: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** The name the wire carries. */
  name: string;
}

export interface WorkflowGraph {
  name: string;
  /** Phase titles in order: meta.phases, then any phase() title the script adds. */
  phases: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** GET /api/workflows/:id/graph and GET /api/workflows/runs/:id/graph. */
export interface WorkflowGraphView {
  graph: WorkflowGraph;
  /** sha256 of the script the graph came from: the baseSha of an edit. */
  sha: string;
  source: import('./workflows').WorkflowSource;
  /** True when the canvas may write the script back (the caller's own or the project's). */
  editable: boolean;
  /** Why it is read-only, when it is. */
  readOnly?: string;
  /** Run graph: nodes whose source changed since the run, and the nodes wired after them (an estimate). */
  stale?: string[];
  /** Run graph: the library workflow it came from, when it still exists. */
  workflowId?: string;
  /** Node positions the owner dragged, from `<name>.layout.json`; nodes not in it are laid out. */
  layout?: Record<string, { x: number; y: number }>;
}

export type GraphEditField = 'model' | 'agentType' | 'label' | 'prompt';

export interface GraphEditInput {
  nodeId: string;
  field: GraphEditField;
  value: string;
  /** prompt: which string part. */
  part?: number;
  baseSha: string;
}

/** POST /api/workflows/:id/graph/insert: a new node as a new statement. */
export interface GraphInsertInput {
  kind: 'agent' | 'parallel' | 'check' | 'approve' | 'ask';
  /** The node it goes after (a wire dropped from it); left out, before the script's last return. */
  after?: string;
  baseSha: string;
}

export interface GraphEditResult {
  sha: string;
  /** The changed lines, before and after. */
  diff: string;
  view: WorkflowGraphView;
}

/** What a node shows from its calls. */
export type NodeRunState = 'idle' | 'queued' | 'running' | 'waiting' | 'done' | 'cached' | 'failed' | 'skipped' | 'parked';

export interface NodeRun {
  state: NodeRunState;
  seqs: number[];
  total: number;
  done: number;
  cached: number;
  running: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Cost of cached calls: spent before, not now. */
  cachedCostUsd: number;
  /** Earliest start of a running call, for the elapsed counter. */
  startedAt?: number;
}

/** The node a call belongs to: by its call-site lines, else by label, else none. */
export function nodeOf(call: Pick<WorkflowCall, 'at' | 'label' | 'phase' | 'parentSeq'>, graph: WorkflowGraph, bySeq?: Map<number, Pick<WorkflowCall, 'at' | 'label' | 'phase' | 'parentSeq'>>): GraphNode | undefined {
  // a nested workflow()'s calls carry the child script's lines: they belong to the workflow() node
  if (call.parentSeq !== undefined && bySeq) {
    const parent = bySeq.get(call.parentSeq);
    if (parent && parent !== call) return nodeOf(parent, graph, bySeq);
  }
  if (call.at?.length) {
    const inside = (line: number, wantFn: boolean) => graph.nodes.find((n) => !!n.fn === wantFn && line >= n.span.start && line <= n.span.end);
    // a helper's own line comes first; the node that called it is the one that ran
    for (const line of call.at) {
      const hit = inside(line, false);
      if (hit) return hit;
    }
    for (const line of call.at) {
      const hit = inside(line, true);
      if (hit) return hit;
    }
  }
  // runs from before call-site lines were journaled
  if (call.label) {
    const byLabel = graph.nodes.find((n) => n.opts?.label?.value === call.label);
    if (byLabel) return byLabel;
    const byInner = graph.nodes.find((n) => n.calls.some((c) => c.label && call.label!.startsWith(c.label)));
    if (byInner) return byInner;
  }
  return undefined;
}

const RANK: NodeRunState[] = ['failed', 'waiting', 'running', 'parked', 'queued', 'done', 'cached', 'skipped', 'idle'];

function stateOf(c: WorkflowCall): NodeRunState {
  if (c.waiting || (c.kind === 'ask' && c.state === 'running')) return 'waiting';
  return c.state as WorkflowCallState;
}

/** Each node's calls rolled up: the worst state on the outline, counts, tokens and cost. */
export function nodeRuns(graph: WorkflowGraph, calls: WorkflowCall[]): { byNode: Map<string, NodeRun>; unplaced: WorkflowCall[] } {
  const bySeq = new Map(calls.map((c) => [c.seq, c]));
  const byNode = new Map<string, NodeRun>();
  const unplaced: WorkflowCall[] = [];
  for (const c of calls) {
    const n = nodeOf(c, graph, bySeq);
    if (!n) {
      unplaced.push(c);
      continue;
    }
    const r = byNode.get(n.id) ?? { state: 'idle', seqs: [], total: 0, done: 0, cached: 0, running: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, cachedCostUsd: 0 };
    const s = stateOf(c);
    r.seqs.push(c.seq);
    r.total++;
    if (s === 'done') r.done++;
    if (s === 'cached') r.cached++;
    if (s === 'running' || s === 'waiting') {
      r.running++;
      if (c.startedAt && (!r.startedAt || c.startedAt < r.startedAt)) r.startedAt = c.startedAt;
    }
    if (s === 'failed') r.failed++;
    r.inputTokens += c.inputTokens;
    r.outputTokens += c.outputTokens;
    if (s === 'cached') r.cachedCostUsd += c.costUsd;
    else r.costUsd += c.costUsd;
    // all cached stays cached; cached next to live answers reads as done
    if (RANK.indexOf(s) < RANK.indexOf(r.state)) r.state = s;
    if (r.state === 'cached' && r.done) r.state = 'done';
    byNode.set(n.id, r);
  }
  for (const r of byNode.values()) if (r.state === 'cached' && r.done) r.state = 'done';
  return { byNode, unplaced };
}

/**
 * Nodes whose source changed between the run's script and the current one,
 * plus every node wired after them. An estimate: the journal key decides what
 * really runs again.
 */
export function staleNodes(before: WorkflowGraph, after: WorkflowGraph): string[] {
  const old = new Map(before.nodes.map((n) => [n.id, n.source]));
  const out = new Set(after.nodes.filter((n) => old.get(n.id) !== n.source).map((n) => n.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of after.edges) {
      if (out.has(e.from) && !out.has(e.to)) {
        out.add(e.to);
        grew = true;
      }
    }
  }
  return after.nodes.filter((n) => out.has(n.id)).map((n) => n.id);
}
