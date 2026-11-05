/**
 * Programs from blocks (docs/design/VISUAL-PROGRAMMING.md 4 to 6): a flow is
 * flows/<name>.flow.ts in a Code session's folder. Each top-level statement
 * is a block, a wire is a variable reference. The hub parses the file each
 * time (flows/graph.ts); these are the shapes the web app gets.
 */
import type { WorkflowGraph } from './graph';

export type FlowWidget = 'text' | 'number' | 'toggle' | 'combo';

/** One input of a block kind: its widget when it holds a setting, and the default a new block or a cut wire gets. */
export interface FlowInputSpec {
  name: string;
  widget: FlowWidget;
  default: string | number | boolean;
  options?: string[];
  help?: string;
}

/** A block kind of the catalog (GET /api/graph/nodes?use=program). */
export interface FlowBlockSpec {
  block: string;
  /** The flows/lib helper it calls; '' for Value. */
  helper: string;
  title: string;
  help: string;
  family: 'Inputs' | 'Data' | 'Outputs' | 'Libraries' | 'AI';
  inputs: FlowInputSpec[];
  /** False for blocks with no result (Log): written without `const`. */
  output: boolean;
  /** Owner only (Call AI bills a gateway key). */
  ownerOnly?: boolean;
}

/** The last value or error a node had in a run. */
export interface FlowNodeLive {
  ok: boolean;
  ms?: number;
  /** A short label for the wire: "30 items", "200 chars", the value itself when short. */
  summary?: string;
  /** The value, cut to 2 KB. */
  value?: string;
  error?: string;
}

export type FlowRunStatus = 'approval' | 'running' | 'done' | 'failed' | 'stopped' | 'refused';

export interface FlowRunView {
  runId: string;
  flow: string;
  status: FlowRunStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  /** stdout and stderr with trace lines cut out, .env values masked; the last 64 KB. */
  output: string;
  /** By node id. */
  nodes: Record<string, FlowNodeLive>;
  /** Why it did not run or failed, in a sentence. */
  error?: string;
}

/** GET /api/sessions/:id/flows/:name/graph */
export interface FlowView {
  name: string;
  /** flows/<name>.flow.ts, relative to the session folder. */
  path: string;
  graph: WorkflowGraph & { error?: string };
  sha: string;
  layout?: Record<string, { x: number; y: number }>;
  lastRun?: FlowRunView;
}

export interface FlowSummary {
  name: string;
  path: string;
}

export type FlowOp =
  | { op: 'set'; nodeId: string; input: string; value: string | number | boolean }
  | { op: 'connect'; nodeId: string; input: string; from: string; field?: string }
  | { op: 'disconnect'; nodeId: string; input: string }
  | { op: 'insert'; block: string; after?: string }
  | { op: 'remove'; nodeId: string }
  /** A block's variable name, at its declaration and everywhere it is read. */
  | { op: 'rename'; nodeId: string; name: string };

export interface FlowEditResult {
  sha: string;
  diff: string;
  view: FlowView;
  /** insert: the new node's id; rename: the block's new id (its name). */
  nodeId?: string;
}
