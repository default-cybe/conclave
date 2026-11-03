/**
 * The node inspector (docs/design/VISUAL-PROGRAMMING.md 7.5): what the node
 * is, its calls with prompt, result, error and agent link, an approval or a
 * question it waits on, kept branches, Re-run this node, and the literal
 * settings an owned workflow lets you edit. On a phone it opens in a sheet.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import type { GraphEditField, GraphNode, NodeRun, WorkflowCall, WorkflowGraphView } from '@conclave/core/client';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { Notice } from '@/components/ui/Section';
import { QuestionCard } from '@/components/inbox/QuestionCard';
import { ApprovalCard } from '@/components/inbox/ApprovalCard';
import { api } from '@/lib/api';
import { compact, usd } from '@/lib/format';
import { modelName } from '@/lib/models';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { attempt, useHub } from '@/store/store';
import { callWord } from '../workflows/words';
import { Worktrees } from '../workflows/Worktrees';
import { metaLine, stateTone, stateWord } from './nodes';

export interface InspectorProps {
  node: GraphNode;
  run?: NodeRun;
  calls: WorkflowCall[];
  /** The run it shows, when it shows one. */
  runCtx?: { id: string; name: string; sessionId?: string; live: boolean };
  /** The workflow's graph view when the canvas may edit it (library graph). */
  view?: WorkflowGraphView;
  workflowId?: string;
  onRerun?: (seqs: number[]) => void;
  onEdited?: (view: WorkflowGraphView, diff: string) => void;
  onWorktree?: (seq: number, state: NonNullable<WorkflowCall['worktree']>['state']) => void;
}

export function Inspector({ node, run, calls, runCtx, view, workflowId, onRerun, onEdited, onWorktree }: InspectorProps) {
  const phone = useIsMobile();
  const questions = useHub((s) => s.questions);
  const approvals = useHub((s) => s.approvals);
  const childIds = new Set(calls.map((c) => c.childSessionId).filter(Boolean));
  const waitsOn = calls.some((c) => c.state === 'running');
  // what this node waits on: an agent's tool approval, or the run's own ask and approve
  const myApprovals = waitsOn ? Object.values(approvals).filter((a) => childIds.has(a.sessionId) || (node.kind === 'approve' && a.sessionId === runCtx?.sessionId)) : [];
  const myQuestions = waitsOn && node.kind === 'ask' ? Object.values(questions).filter((q) => q.sessionId === runCtx?.sessionId && q.questions.some((x) => x.question.startsWith(`${runCtx?.name}: `))) : [];
  const tone = stateTone(run?.state);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-rule px-5 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <div className="t-title min-w-0 truncate text-fg">{node.label}</div>
          {run && <span className={cn('cv-state shrink-0 text-[13px]', tone.text)}>{stateWord(run)}</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-fg-3">
          {metaLine(node, run)}. Lines {node.span.start} to {node.span.end}
          {node.phase ? `, in ${node.phase}` : ''}.
        </div>
      </div>
      <div className="scroll-y min-h-0 flex-1 space-y-6 px-5 py-4">
        {myApprovals.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
        {myQuestions.map((q) => (
          <QuestionCard key={q.id} question={q} />
        ))}

        {runCtx && run && run.seqs.length > 0 && onRerun && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" size={phone ? 'touch' : 'md'} disabled={runCtx.live} onClick={() => onRerun(run.seqs)}>
              Re-run this node
            </Button>
            <span className="text-[12px] text-fg-3">{runCtx.live ? 'Stop the run first.' : 'Calls that do not depend on it replay from the journal.'}</span>
          </div>
        )}

        {calls.length > 0 && (
          <div>
            <div className="t-section pb-1.5 text-fg">{calls.length === 1 ? 'Call' : `${calls.length} calls`}</div>
            <ol className="rows">
              {calls.map((c) => (
                <CallItem key={c.seq} call={c} />
              ))}
            </ol>
          </div>
        )}
        {runCtx && onWorktree && <Worktrees runId={runCtx.id} sessionId={runCtx.sessionId} calls={calls} onChange={onWorktree} />}

        {node.calls.length > 0 && node.kind === 'code' && (
          <div>
            <div className="t-section pb-1.5 text-fg">Calls inside</div>
            <ul className="rows text-[13px]">
              {node.calls.map((c, i) => (
                <li key={i} className="flex justify-between gap-3 py-1.5">
                  <span className="mono min-w-0 truncate text-fg-2">
                    {c.name}
                    {c.label ? ` ${c.label}` : ''}
                  </span>
                  <span className="num shrink-0 text-fg-3">line {c.line}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {view && <Edit node={node} view={view} workflowId={workflowId} onEdited={onEdited} />}

        <div>
          <div className="t-section pb-1.5 text-fg">Script</div>
          <CodeBlock code={node.source} lang="javascript" maxLines={phone ? 12 : 24} />
        </div>
      </div>
    </div>
  );
}

function CallItem({ call }: { call: WorkflowCall }) {
  return (
    <li className="space-y-1.5 py-2.5 text-[13px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-fg">{call.label ?? `Call ${call.seq}`}</span>
        <span className={cn('cv-state shrink-0', stateTone(call.waiting ? 'waiting' : call.state).text)}>{call.waiting ? 'waiting for you' : callWord(call).word}</span>
      </div>
      <div className="text-[12px] text-fg-3">
        {[`Call ${call.seq}`, call.agentType, call.model ? modelName(call.model) : '', `${compact(call.inputTokens + call.outputTokens)} tokens`, usd(call.costUsd)].filter(Boolean).join(', ')}
        {call.childSessionId && (
          <>
            {'. '}
            <Link href={`/s/${call.childSessionId}`} className="link">
              Open the agent
            </Link>
          </>
        )}
      </div>
      {call.promptPreview && <div className="max-h-[160px] overflow-y-auto rounded-[var(--r-2)] bg-sunk p-2.5 text-[12.5px] whitespace-pre-wrap text-fg-2">{call.promptPreview}</div>}
      {call.error ? <p className="text-fault">{call.error}</p> : call.resultPreview ? <CodeBlock code={call.resultPreview} wrap maxLines={12} /> : null}
    </li>
  );
}

const FIELDS: Array<{ field: GraphEditField; label: string; help: string }> = [
  { field: 'label', label: 'Label', help: 'The name the run shows for this call.' },
  { field: 'model', label: 'Model', help: 'A tier word (fast, smart, deep) or a model name.' },
  { field: 'agentType', label: 'Agent', help: 'An installed agent, such as explore or builder.' },
];

/** Edit fields for an agent node of a workflow the caller owns, or the read-only note with Copy. */
function Edit({ node, view, workflowId, onEdited }: { node: GraphNode; view: WorkflowGraphView; workflowId?: string; onEdited?: InspectorProps['onEdited'] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ field: GraphEditField; part?: number; value: string; label: string }>();
  if (!view.editable)
    return (
      <Notice
        action={workflowId ? { label: 'Copy to my workflows', onClick: () => void attempt(() => api().copyWorkflow(workflowId), 'Copied. The copy is yours to edit.').then((d) => d && onEdited && api().workflowGraph(workflowId).then((v) => onEdited(v, ''))) } : undefined}
      >
        {view.readOnly ?? 'Read only.'}
      </Notice>
    );
  if (node.kind !== 'agent') return <p className="text-[13px] text-fg-3">Only an agent node has settings to edit here. Edit the rest in the script.</p>;
  const key = (f: string, p?: number) => (p === undefined ? f : `${f}:${p}`);
  const current = (f: GraphEditField) => (f === 'prompt' ? '' : String(node.opts?.[f]?.value ?? ''));
  const save = async () => {
    if (!confirm || !workflowId) return;
    const c = confirm;
    setConfirm(undefined);
    const res = await attempt(() => api().editWorkflowGraph(workflowId, { nodeId: node.id, field: c.field, value: c.value, baseSha: view.sha, ...(c.part !== undefined ? { part: c.part } : {}) }), 'Saved to the script');
    if (res) {
      setValues({});
      onEdited?.(res.view, res.diff);
    }
  };
  return (
    <div className="space-y-4">
      <div className="t-section text-fg">Settings</div>
      {FIELDS.map(({ field, label, help }) => {
        const v = values[field] ?? current(field);
        const computed = !node.opts?.[field] && node.source.includes(`${field}:`);
        return (
          <Field key={field} label={label} help={computed ? `${label} is computed in the script; edit it there.` : help}>
            <div className="flex gap-2">
              <Input value={v} disabled={computed} onChange={(e) => setValues((s) => ({ ...s, [field]: e.target.value }))} className="min-w-0 flex-1" />
              <Button variant="outline" disabled={computed || v.trim() === current(field) || !v.trim()} onClick={() => setConfirm({ field, value: v, label })}>
                Save
              </Button>
            </div>
          </Field>
        );
      })}
      {node.promptLocked ? (
        <p className="text-[13px] text-fg-3">Prompt: {node.promptLocked}.</p>
      ) : (
        (node.promptParts ?? []).map((p, i) => {
          const k = key('prompt', i);
          const v = values[k] ?? String(p.value);
          return (
            <Field key={k} label={(node.promptParts?.length ?? 0) > 1 ? `Prompt, part ${i + 1}` : 'Prompt'}>
              <Textarea value={v} rows={4} onChange={(e) => setValues((s) => ({ ...s, [k]: e.target.value }))} />
              <div className="pt-2">
                <Button variant="outline" disabled={v === p.value || !v.trim()} onClick={() => setConfirm({ field: 'prompt', part: i, value: v, label: 'Prompt' })}>
                  Save
                </Button>
              </div>
            </Field>
          );
        })
      )}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(undefined)}
        onConfirm={save}
        title={`Save ${confirm?.label.toLowerCase() ?? ''} to the script?`}
        body={`Only this value changes in the file (lines ${node.span.start} to ${node.span.end}). Git is the undo. The next Re-run runs this node and what depends on it.`}
        confirm="Save"
        tone="neutral"
      />
    </div>
  );
}
