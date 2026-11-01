/**
 * WorkflowStatus: how a workflow run is going, for the agent that started
 * it, without waiting for its <workflow_result>. Read only. It is offered
 * exactly where the Workflow tool is (workflows/service.ts extension), and it
 * shows only runs of the session's own account (service.status).
 */
import type { Tool } from './types';
import type { WorkflowStatusAgent, WorkflowStatusView } from '../client/workflows';
import { fail } from './util';
import { oneLine } from '../util/text';
import { OWNER_ID } from '../people/context';
import { count } from '../workflows/limits';

export interface WorkflowStatusInput {
  runId?: string;
  logLines?: number;
}

const DESCRIPTION = `Show how a workflow run is going: its state, each phase with its agents (label, state, time so far), agent counts, tokens and cost, the errors so far, and the last log lines.

runId is the run id (wfr_...) the Workflow tool returned; leave it out for the newest run this session started. Use it when the owner asks how a run is going, or when you need a background run's progress before its <workflow_result> arrives. A finished run shows its final state; its result is in the <workflow_result> block or the Workflow call's own result. Do not call it in a loop to wait for a run.`;

/** Agents listed per phase before the rest are summed up. */
const AGENTS_SHOWN = 30;
/** Errors listed in the text. */
const ERRORS_SHOWN = 20;

/** 42s, 3m 05s, 1h 02m. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function agentLine(a: WorkflowStatusAgent): string {
  const parts = [a.waiting === 'approval' ? `${a.state}, waiting for the owner's approval` : a.state];
  if (a.elapsedMs !== undefined) parts.push(duration(a.elapsedMs));
  if (a.lastTool && a.waiting !== 'approval') parts.push(`last tool: ${oneLine(a.lastTool, 100)}`);
  const err = a.error && (a.state === 'failed' || a.state === 'skipped') ? `: ${oneLine(a.error, 160)}` : '';
  return `  - #${a.seq} ${oneLine(a.label, 80)}: ${parts.join(', ')}${err}`;
}

/** The view as text for the model. */
export function statusText(v: WorkflowStatusView): string {
  const lines: string[] = [];
  const going = v.status === 'running' || v.status === 'paused' || v.status === 'queued' || v.status === 'waiting_reset';
  const time = v.elapsedMs !== undefined ? ` ${going ? 'for' : 'after'} ${duration(v.elapsedMs)}` : '';
  const current = v.phaseIndex >= 0 ? v.phases[v.phaseIndex] : undefined;
  const listed = v.phases.filter((p) => p.title !== '(no phase)');
  const where = current ? ` Phase ${v.phaseIndex + 1} of ${listed.length}: ${current.title}.` : '';
  const reset = v.status === 'waiting_reset' && v.resumeAt ? ` Parked calls run again at ${new Date(v.resumeAt).toISOString()}.` : '';
  lines.push(`Workflow ${v.name}, run ${v.runId}: ${v.status}${time}${v.background ? ' (background)' : ''}.${where}${reset}`);

  const c = v.counts;
  const states = (['running', 'queued', 'parked', 'done', 'cached', 'failed', 'skipped'] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`);
  const budget = v.budget ? ` Budget: ${[v.budget.tokens ? `${v.budget.tokens} output tokens` : '', v.budget.costUsd ? `$${v.budget.costUsd}` : ''].filter(Boolean).join(', ')}.` : '';
  lines.push(`Agents: ${c.agents}${states.length ? ` (${states.join(', ')})` : ''}. Tokens: ${v.tokens.input} in, ${v.tokens.output} out; $${v.costUsd.toFixed(2)}.${budget}`);

  if (v.phases.length) {
    lines.push('', 'Phases:');
    for (const p of v.phases) {
      lines.push(`[${p.state}] ${p.title}${p.agents.length ? '' : ' (no agents yet)'}`);
      const shown = p.agents.length <= AGENTS_SHOWN ? p.agents : p.agents.filter((a) => a.state !== 'done' && a.state !== 'cached').slice(0, AGENTS_SHOWN);
      for (const a of shown) lines.push(agentLine(a));
      if (shown.length < p.agents.length) lines.push(`  - and ${p.agents.length - shown.length} more`);
    }
  }

  if (v.errorCount) {
    const shown = v.errors.slice(-ERRORS_SHOWN);
    lines.push('', `Errors (${v.errorCount}${v.errorCount > shown.length ? `, the last ${shown.length}` : ''}):`);
    for (const e of shown) lines.push(`- ${e.seq !== undefined ? `#${e.seq} ${oneLine(e.label ?? '', 60)}: ` : 'run: '}${oneLine(e.error, 300)}`);
  } else lines.push('', 'Errors: none so far.');

  if (v.logs.length) {
    const start = v.startedAt ?? v.createdAt;
    lines.push('', `Last ${count(v.logs.length, 'log line')}:`);
    for (const l of v.logs) lines.push(`[+${duration(l.ts - start)}] ${oneLine(l.text, 300)}`);
  }
  if (!going) lines.push('', v.status === 'done' ? 'The run is over; its result is in its <workflow_result> block or the Workflow call result.' : `The run is over (${v.status}).`);
  return lines.join('\n');
}

export const WorkflowStatusTool: Tool<WorkflowStatusInput> = {
  name: 'WorkflowStatus',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: 'The run id (wfr_...); default the newest run this session started' },
      logLines: { type: 'number', description: 'How many of the last log lines to show, 0 to 50 (default 10)' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => `WorkflowStatus${input.runId ? ` ${oneLine(input.runId, 40)}` : ''}`,
  async run(input, ctx) {
    const svc = ctx.host.workflows;
    if (!svc) return fail('Workflows are not available on this hub.');
    const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
    const view = svc.status({
      ...(runId ? { runId } : {}),
      sessionId: ctx.sessionId,
      accountId: ctx.session.accountId ?? OWNER_ID,
      ...(typeof input.logLines === 'number' && Number.isFinite(input.logLines) ? { logLines: input.logLines } : {}),
    });
    if (!view) return fail(runId ? `No workflow run ${runId} found.` : 'This session has not started a workflow run. Pass runId to look at another run of yours.');
    return { content: statusText(view), meta: { workflowRunId: view.runId } };
  },
};
