/**
 * One workflow graph node (docs/design/VISUAL-PROGRAMMING.md 7.5, spec 1.2):
 * the label, the kind and its settings on the meta line, and the state as a
 * word at the right with a 1px outline in the state's token. No ticks,
 * triangles, badges or pulsing: words in fixed places.
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { GraphNode, NodeRun, NodeRunState } from '@conclave/core/client';
import { Elapsed } from '@/components/motion/Elapsed';
import { compact, usd } from '@/lib/format';
import { cn } from '@/lib/text';
import { NODE_H, NODE_W } from './layout';

export interface FlowNodeData extends Record<string, unknown> {
  node: GraphNode;
  run?: NodeRun;
  stale?: boolean;
  selected?: boolean;
}

export interface BandData extends Record<string, unknown> {
  title: string;
  current?: boolean;
  w: number;
  h: number;
}

const KIND_WORD: Record<GraphNode['kind'], string> = {
  agent: 'Agent',
  parallel: 'Parallel',
  pipeline: 'Pipeline',
  check: 'Check',
  approve: 'Approval',
  ask: 'Question',
  workflow: 'Workflow',
  return: 'Result',
  log: 'Log',
  code: 'Code',
};

const STATE_WORD: Record<NodeRunState, string> = {
  idle: '',
  queued: 'queued',
  running: 'running',
  waiting: 'waiting for you',
  done: 'done',
  cached: 'cached',
  failed: 'failed',
  skipped: 'skipped',
  parked: 'waiting for a limit',
};

/** The state's word color and outline (spec 1.3: violet live, amber waits on you, green passed, red failed). */
export function stateTone(s: NodeRunState | undefined): { text: string; outline: string } {
  switch (s) {
    case 'running':
      return { text: 'text-signal', outline: 'border-signal' };
    case 'waiting':
    case 'parked':
      return { text: 'text-warn', outline: 'border-warn' };
    case 'failed':
      return { text: 'text-fault', outline: 'border-fault' };
    case 'done':
      return { text: 'text-ok', outline: 'border-rule-2' };
    default:
      return { text: 'text-fg-3', outline: 'border-rule-2' };
  }
}

/** The meta line: what the node is set to, then what it spent. */
export function metaLine(node: GraphNode, run?: NodeRun): string {
  const o = node.opts ?? {};
  const inner = node.calls.filter((c) => c.name === 'agent').length;
  const parts = [
    KIND_WORD[node.kind],
    typeof o.agentType?.value === 'string' ? o.agentType.value : '',
    typeof o.model?.value === 'string' ? o.model.value : '',
    node.kind !== 'agent' && inner ? `${inner} ${inner === 1 ? 'agent' : 'agents'}` : '',
  ].filter(Boolean);
  if (run && run.inputTokens + run.outputTokens > 0) parts.push(`${compact(run.inputTokens + run.outputTokens)} tokens`);
  if (run && run.costUsd > 0) parts.push(usd(run.costUsd));
  return parts.join(', ');
}

/** The state word, with "3 of 5 done" for a node with several calls. */
export function stateWord(run?: NodeRun): string {
  if (!run) return '';
  const word = STATE_WORD[run.state];
  if (run.total > 1 && run.state !== 'done' && run.state !== 'cached') return `${run.done + run.cached} of ${run.total} done, ${word}`;
  if (run.total > 1) return `${run.total} ${word}`;
  return word;
}

export const WorkflowNode = memo(function WorkflowNode({ data }: NodeProps) {
  const { node, run, stale, selected } = data as FlowNodeData;
  const tone = stateTone(run?.state);
  return (
    <div
      className={cn('cv-graph-node flex flex-col justify-between rounded-[var(--r-2)] border bg-raise px-3 py-2.5 text-left', tone.outline, selected && 'cv-graph-selected')}
      style={{ width: NODE_W, height: NODE_H }}
      data-state={run?.state ?? 'idle'}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-fg">{node.label}</span>
        <span className="mono shrink-0 text-[11px] text-fg-4">{node.span.start === node.span.end ? `L${node.span.start}` : `L${node.span.start}-${node.span.end}`}</span>
      </div>
      <div className="truncate text-[12px] text-fg-3">{metaLine(node, run)}</div>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className={cn('cv-state truncate', tone.text)}>
          {stateWord(run)}
          {run?.state === 'running' && run.startedAt ? (
            <>
              {' '}
              <Elapsed since={run.startedAt} />
            </>
          ) : null}
        </span>
        {stale && <span className="shrink-0 text-fg-3">changed since</span>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

export const PhaseBand = memo(function PhaseBand({ data }: NodeProps) {
  const { title, current, w, h } = data as BandData;
  return (
    <div className="cv-graph-band rounded-[var(--r-3)] border border-rule" style={{ width: w, height: h }}>
      <div className={cn('cv-state px-4 pt-2.5 text-[13px] font-medium', current ? 'text-signal' : 'text-fg-2')}>{title}</div>
    </div>
  );
});

export const NODE_TYPES = { wf: WorkflowNode, band: PhaseBand };
