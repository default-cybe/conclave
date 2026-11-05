/**
 * One workflow graph node (docs/design/VISUAL-PROGRAMMING.md 7.5, spec 1.2):
 * the label, the kind and its settings on the meta line, and the state as a
 * word at the right with a 1px outline in the state's token. No ticks,
 * triangles, badges or pulsing: words in fixed places.
 */
import { memo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowBlockSpec, FlowNodeLive, GraphNode, NodeRun, NodeRunState } from '@conclave/core/client';
import { Elapsed } from '@/components/motion/Elapsed';
import { compact, usd } from '@/lib/format';
import { cn } from '@/lib/text';
import { NODE_H, NODE_W } from './layout';

export interface FlowNodeData extends Record<string, unknown> {
  node: GraphNode;
  run?: NodeRun;
  stale?: boolean;
  selected?: boolean;
  /** Wires enter at the top and leave at the bottom (the phone's vertical layout). */
  vertical?: boolean;
  /** A program flow's block: its catalog entry, its last value or error, and whether wires may be drawn to its inputs. */
  spec?: FlowBlockSpec;
  live?: FlowNodeLive;
  connectable?: boolean;
  /** Canvas mode: a double-click on the title edits it in place; Enter or leaving the field saves, Escape keeps the old one. */
  onRename?: (id: string, name: string) => void;
}

/** A node's title, or the field that renames it. nodrag: typing and selecting text must not move the node. */
function Title({ id, text, mono, onRename }: { id: string; text: string; mono?: boolean; onRename?: (id: string, name: string) => void }) {
  const [draft, setDraft] = useState<string>();
  const closed = useRef(false);
  const cls = cn('min-w-0 truncate text-[13px] font-medium text-fg', mono && 'mono');
  if (draft === undefined)
    return (
      <span className={cls} onDoubleClick={onRename ? (e) => (e.stopPropagation(), (closed.current = false), setDraft(text)) : undefined} title={onRename ? 'Double-click to rename' : undefined}>
        {text}
      </span>
    );
  const done = (save: boolean) => {
    // Enter closes the field, and the field going away blurs it: save once
    if (closed.current) return;
    closed.current = true;
    const next = draft.trim();
    setDraft(undefined);
    if (save && next && next !== text) onRename?.(id, next);
  };
  return (
    <input
      autoFocus
      value={draft}
      aria-label="New name"
      className={cn(cls, 'nodrag nopan w-full rounded-[var(--r-1)] bg-sunk px-1 outline-none')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      }}
    />
  );
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
  block: 'Block',
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

/**
 * A node's title in words: the parser's label is code (`const OPUS`,
 * `function rules`, `parallel`), so a code node says what it sets and a
 * call with no label of its own says its kind.
 */
export function nodeTitle(node: GraphNode): string {
  if (node.kind === 'code') {
    if (node.fn) return `Helper ${node.declares[0] ?? ''}`.trim();
    if (node.declares.length) return `Sets ${node.declares.slice(0, 3).join(', ')}${node.declares.length > 3 ? ` +${node.declares.length - 3}` : ''}`;
    return node.label;
  }
  if (node.label === node.kind || node.kind === 'return' || node.kind === 'log') return KIND_WORD[node.kind];
  return node.label;
}

/** Where it is in the file, for a tooltip: the face of a node is words. */
export const linesOf = (node: GraphNode) => (node.span.start === node.span.end ? `line ${node.span.start}` : `lines ${node.span.start} to ${node.span.end}`);

/** The meta line: what the node is set to, then what it spent. */
export function metaLine(node: GraphNode, run?: NodeRun): string {
  const o = node.opts ?? {};
  // the calls that ran, once there is a run: a parallel over a list has one agent() in its text and many lanes
  const inner = run?.total ?? node.calls.filter((c) => c.name === 'agent').length;
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
  const { node, run, stale, selected, vertical, onRename } = data as FlowNodeData;
  const tone = stateTone(run?.state);
  return (
    <div
      className={cn('cv-graph-node flex flex-col justify-between rounded-[var(--r-2)] border bg-raise px-3 py-2.5 text-left', tone.outline, selected && 'cv-graph-selected')}
      style={{ width: NODE_W, height: NODE_H }}
      data-state={run?.state ?? 'idle'}
      title={linesOf(node)}
    >
      <Handle type="target" position={vertical ? Position.Top : Position.Left} isConnectable={false} />
      <div className="flex items-baseline justify-between gap-2">
        <Title id={node.id} text={nodeTitle(node)} onRename={onRename} />
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
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} isConnectable={false} />
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

/** A block's settings in one line: literal inputs as `key value`, wires left out (the wire shows them). */
export function blockLine(node: GraphNode, spec?: FlowBlockSpec): string {
  if (node.kind !== 'block') return `Code, ${node.declares.length ? `sets ${node.declares.join(', ')}` : 'runs a statement'}`;
  const lits = Object.entries(node.args ?? {})
    .filter(([, a]) => !a.ref)
    .map(([k, a]) => (a.locked ? `${k} computed` : node.block === 'value' ? JSON.stringify(a.value) : `${k} ${typeof a.value === 'string' ? JSON.stringify(a.value) : String(a.value)}`));
  return [spec?.title ?? node.block, ...lits].join(', ');
}

/** The state of a flow node in its last run: failed, done or nothing. */
export const liveState = (live?: FlowNodeLive): NodeRunState | undefined => (live ? (live.ok ? 'done' : 'failed') : undefined);

/**
 * One block of a program flow (docs/design/VISUAL-PROGRAMMING.md 4.2): the
 * variable name, the block and its settings, and the last run's value or
 * error. One input handle per input, so a wire lands on its input.
 */
export const FlowBlockNode = memo(function FlowBlockNode({ data }: NodeProps) {
  const { node, selected, vertical, spec, live, connectable, onRename } = data as FlowNodeData;
  const state = liveState(live);
  const tone = stateTone(state);
  const inputs = node.kind === 'block' && node.block !== 'value' ? (spec?.inputs.map((i) => i.name) ?? Object.keys(node.args ?? {})) : node.kind === 'code' ? [''] : [];
  const out = live ? (live.ok ? `${live.summary ?? 'done'}${live.ms !== undefined ? `, ${live.ms} ms` : ''}` : (live.error ?? 'failed').split('\n')[0]) : '';
  return (
    <div
      className={cn('cv-graph-node flex flex-col justify-between rounded-[var(--r-2)] border bg-raise px-3 py-2.5 text-left', tone.outline, selected && 'cv-graph-selected', node.kind === 'code' && 'border-dashed')}
      style={{ width: NODE_W, height: NODE_H }}
      data-state={state ?? 'idle'}
      title={linesOf(node)}
    >
      {inputs.map((name, i) => (
        <Handle
          key={name || 'in'}
          type="target"
          id={name || undefined}
          position={vertical ? Position.Top : Position.Left}
          isConnectable={!!connectable && !!name}
          title={name || undefined}
          style={vertical ? { left: `${((i + 1) * 100) / (inputs.length + 1)}%` } : { top: `${((i + 1) * 100) / (inputs.length + 1)}%` }}
        />
      ))}
      <div className="flex items-baseline justify-between gap-2">
        <Title id={node.id} text={node.kind === 'code' ? nodeTitle(node) : node.label} mono onRename={onRename} />
      </div>
      <div className="truncate text-[12px] text-fg-3">{blockLine(node, spec)}</div>
      <div className={cn('cv-state truncate text-[12px]', tone.text)}>{state === 'failed' ? `failed: ${out}` : out}</div>
      {(node.declares.length > 0 || node.kind === 'code') && <Handle type="source" position={vertical ? Position.Bottom : Position.Right} isConnectable={!!connectable} />}
    </div>
  );
});

export const NODE_TYPES = { wf: WorkflowNode, band: PhaseBand, flow: FlowBlockNode };
