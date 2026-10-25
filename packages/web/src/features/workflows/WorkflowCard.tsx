/**
 * A Workflow tool call in a session (spec 3.18), as the Claude app shows
 * one: ONE compact row that stands alone (toolGroups.ts ALONE) and follows
 * its run live from the hub's workflow.* events. "Workflow deep-research,
 * 3 of 6 agents running" with the still Knot and the running time; paused
 * or waiting for a limit, the state word in amber; once the run ended, the
 * first line of its result ("Workflow deep-research: Use Caddy.") and "done
 * in 4m". A click opens the detail under it: where the run is, each phase
 * with its counts, the phase it is in (or one where an agent failed or waits
 * on you) listing its agents with what each does now, its state and time,
 * then the spend and Open run. It opens closed, also while the run goes:
 * the live state is in the row and in the running tasks above the composer
 * (features/chat/RunningTasks.tsx), which opens the same detail.
 *
 * The same row on desktop (ToolRows.tsx, the log's grid) and on a phone
 * (PhoneTranscript.tsx, one line of 15px).
 */
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { ChevronRight } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import type { WorkflowCall, WorkflowRun } from '@conclave/core/client';
import { Elapsed } from '@/components/motion';
import { StateWord } from '@/components/ui/List';
import { cn } from '@/lib/text';
import { compact, durationShort, usd } from '@/lib/format';
import { agentDoing } from '@/lib/toolLine';
import { resultText } from '@/features/chat/util';
import { api } from '@/lib/api';
import { attempt } from '@/store/store';
import { runIdFor } from '@/features/chat/liveTasks';
import { Chevron, ROW, ROW_BTN, RESULT, RunningTime, verbClass } from '@/features/chat/rowParts';
import { callWord, cardPhases, isLive, phaseWords, resultLine, shownCalls, taskLine, workflowName, workflowRowState, type CardPhase } from './words';
import { useRunDetail, useSessionRuns } from './data';

export { workflowName };

/** The run a Workflow call started, live: its run, its calls, each running agent's last tool and the run's result. */
export function useWorkflowRun(tool: ToolUseBlock, result: ToolResultBlock | undefined, sessionId: string) {
  const runs = useSessionRuns(sessionId);
  const found = runIdFor(tool, result, runs);
  // a run found by its name (an older hub) is found while it is live: the call keeps it once it ends
  const kept = useRef<string | undefined>(undefined);
  if (found) kept.current = found;
  const id = found ?? kept.current;
  const { data, progress } = useRunDetail(id);
  const detail = data && data.run.id === id ? data : undefined;
  // the session's list follows workflow.run as the detail does: it has the run before the detail loads
  const run = detail?.run ?? (id ? runs.find((r) => r.id === id) : undefined);
  return { run, calls: detail?.calls, progress, runResult: detail?.result };
}

/** A Workflow call's row in a session, live. */
export function WorkflowRow({ tool, result, sessionId, startedAt, layout = 'log' }: { tool: ToolUseBlock; result?: ToolResultBlock; sessionId: string; /** When the call started (the tool run), for the time before the run is known. */ startedAt?: number; layout?: 'log' | 'phone' }) {
  const { run, calls, progress, runResult } = useWorkflowRun(tool, result, sessionId);
  return <WorkflowRowView toolId={tool.id} name={workflowName(tool.input)} run={run} calls={calls} progress={progress} runResult={runResult} result={result} startedAt={startedAt} layout={layout} />;
}

/** The row from what is known of the run; WorkflowRow keeps it live. */
export function WorkflowRowView({
  toolId,
  name,
  run,
  calls,
  progress,
  runResult,
  result,
  startedAt,
  layout = 'log',
  defaultOpen = false,
}: {
  toolId?: string;
  name: string;
  run?: WorkflowRun;
  calls?: WorkflowCall[];
  /** The last tool of each running call, by seq (workflow.progress). */
  progress?: Record<number, string>;
  /** The run's own result (the run detail), once it ended. */
  runResult?: unknown;
  /** The Workflow call's result in the session. */
  result?: ToolResultBlock;
  startedAt?: number;
  layout?: 'log' | 'phone';
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toolText = result ? resultText(result) : undefined;
  const st = workflowRowState({ run, result, runResult, toolText });
  const expandable = !!run || !!toolText?.trim();
  const shown = open && expandable;
  const since = run ? (run.startedAt ?? run.createdAt) : startedAt;
  const detail = st.detail && <span className={st.fault ? 'text-fault' : 'text-fg-3'}>{`${st.sep}${st.detail}`}</span>;
  const body = shown && <WorkflowDetail name={name} run={run} calls={calls} progress={progress} runResult={runResult} result={result} />;
  const attrs = { id: toolId ? `tool-${toolId}` : undefined, 'data-workflow-row': '', 'data-state': run?.status ?? (st.live ? 'starting' : 'ended') };

  if (layout === 'phone') {
    const stat = st.running ? <Elapsed since={since} format="short" className="text-signal" /> : st.word ? <StateWord tone={st.tone}>{st.word}</StateWord> : null;
    return (
      <div {...attrs}>
        <button type="button" disabled={!expandable} aria-expanded={expandable ? shown : undefined} onClick={() => setOpen(!shown)} className="flex min-h-11 w-full items-center gap-3 text-left tx-15 active:bg-hover disabled:active:bg-transparent">
          <span className={cn('shrink-0', st.running ? 'text-signal' : 'text-fg-2')}>Workflow</span>
          <span title={st.detail ? `${name}${st.sep}${st.detail}` : name} className="min-w-0 flex-1 truncate text-fg-2">
            {name}
            {detail}
          </span>
          {stat && <span className="num shrink-0 tx-14 text-fg-3">{stat}</span>}
          {expandable && <ChevronRight aria-hidden strokeWidth={2} className={cn('size-4 shrink-0 text-fg-4 transition-transform duration-[var(--dur-1)]', shown && 'rotate-90')} />}
        </button>
        {body && <div className="mb-2 ml-1 border-l border-rule pl-3 anim-fade">{body}</div>}
      </div>
    );
  }

  let stat: ReactNode = null;
  if (st.running) stat = <RunningTime since={since} />;
  else if (st.word) stat = <StateWord tone={st.tone}>{st.word}</StateWord>;
  const head = (
    <>
      <span className={verbClass(st.running)}>Workflow</span>
      <span title={st.detail ? `${name}${st.sep}${st.detail}` : name} className="min-w-0 truncate tx-13.5 text-fg-2 phone:tx-15">
        {name}
        {detail}
      </span>
      <span className={RESULT}>{stat}</span>
      <Chevron open={shown} hidden={!expandable} />
    </>
  );
  return (
    <div {...attrs}>
      {expandable ? (
        <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)} className={ROW_BTN}>
          {head}
        </button>
      ) : (
        <div className={ROW}>{head}</div>
      )}
      {body && <div className="mb-2 ml-4 border-l border-rule pl-4 anim-fade">{body}</div>}
    </div>
  );
}

/**
 * What a Workflow row and a workflow in the running tasks open to: where the
 * run is (or the first line of its result), each phase with its counts and
 * the busy phase's agents, then the spend and Open run. `summary` and
 * `footer` off: the running tasks list says those in its own lines.
 */
export function WorkflowDetail({
  name,
  run,
  calls = [],
  progress = {},
  runResult,
  result,
  summary = true,
  footer = true,
}: {
  name: string;
  run?: WorkflowRun;
  calls?: WorkflowCall[];
  progress?: Record<number, string>;
  runResult?: unknown;
  result?: ToolResultBlock;
  summary?: boolean;
  footer?: boolean;
}) {
  if (!run) {
    const text = result ? resultText(result).trim() : '';
    return <p className={cn('m-0 py-1.5 text-[12.5px] whitespace-pre-wrap phone:text-[14px]', result?.isError ? 'text-fault' : 'text-fg-2')}>{text || 'Waiting for approval or starting.'}</p>;
  }
  const live = isLive(run.status);
  const line = summary ? (live ? taskLine(run) : resultLine(runResult, result ? resultText(result) : undefined, run.error)) : undefined;
  const phases = cardPhases(run, calls);
  return (
    <div data-workflow-detail="">
      {line && <p className={cn('m-0 pt-1.5 text-[12.5px] phone:text-[14px]', live ? 'text-fg-3' : 'text-fg-2')}>{line}</p>}
      <ol className="m-0 list-none p-0 py-1" aria-label={`Phases of ${name}`}>
        {phases.map((p, i) => (
          <PhaseRow key={`${p.title}${i}`} phase={p} index={i} count={run.phases.length} progress={progress} runId={run.id} />
        ))}
        {phases.length === 0 && <li className="py-1 text-[12px] text-fg-3 phone:text-[13px]">No phases yet.</li>}
      </ol>
      {footer && (
        <div className="flex items-center gap-3 border-t border-rule py-1.5 text-[12px] phone:text-[13px]">
          <span className="num min-w-0 truncate text-fg-3">{spendWords(run)}</span>
          {(run.status === 'running' || run.status === 'paused') && (
            <button type="button" className="link ml-auto shrink-0" onClick={() => void attempt(() => (run.status === 'paused' ? api().resumeWorkflow(run.id) : api().pauseWorkflow(run.id)))}>
              {run.status === 'paused' ? 'Resume' : 'Pause'}
            </button>
          )}
          <Link href={`/workflows/runs/${run.id}`} className={cn('link shrink-0', run.status !== 'running' && run.status !== 'paused' && 'ml-auto')}>
            Open run
          </Link>
        </div>
      )}
    </div>
  );
}

/** "14 agents, 412k tokens, $3.10". */
function spendWords(run: WorkflowRun): string {
  const c = run.counts;
  return [`${c.agents} ${c.agents === 1 ? 'agent' : 'agents'}`, run.inputTokens + run.outputTokens ? `${compact(run.inputTokens + run.outputTokens)} tokens` : '', run.costUsd ? usd(run.costUsd) : ''].filter(Boolean).join(', ');
}

/**
 * A phase: its title and counts; the phase the run is in, and one where an
 * agent failed or waits on you, lists its agents. A tap on another phase
 * lists its agents too.
 */
function PhaseRow({ phase, index, count, progress, runId }: { phase: CardPhase; index: number; count: number; progress: Record<number, string>; runId: string }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const busy = phase.state === 'current' || phase.failed > 0 || phase.waiting > 0;
  const open = phase.calls.length > 0 && (chosen ?? busy);
  const { shown, more } = shownCalls(phase.calls);
  const words = phaseWords(phase);
  const named = index < count;
  return (
    <li className="py-1">
      <button type="button" disabled={!phase.calls.length} aria-expanded={phase.calls.length ? open : undefined} onClick={() => setChosen(!open)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-left disabled:cursor-default">
        <span className={cn('min-w-0 truncate text-[13px] phone:text-[14px]', phase.state === 'current' ? 'font-medium text-signal' : phase.state === 'done' ? 'text-fg-2' : 'text-fg-3')}>
          {named && <span className="num mr-1.5 text-fg-3">{index + 1}</span>}
          {phase.title}
        </span>
        <span className={cn('num text-[12px] whitespace-nowrap phone:text-[13px]', phase.failed ? 'text-fault' : 'text-fg-3')}>{words}</span>
      </button>
      {open && (
        <ul className="m-0 mt-0.5 mb-0.5 ml-1 list-none border-l border-rule p-0 pl-3">
          {shown.map((c) => (
            <AgentRow key={c.seq} call={c} lastTool={progress[c.seq] ?? c.lastTool} />
          ))}
          {more > 0 && (
            <li className="py-0.5 text-[12px] phone:text-[13px]">
              <Link href={`/workflows/runs/${runId}`} className="text-fg-3 hov:text-fg">
                and {more} more in the run
              </Link>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** An agent: its label, what it does now while it runs ("Searching for jwt"), and its state with its time at the right. */
function AgentRow({ call, lastTool }: { call: WorkflowCall; lastTool?: string }) {
  const { word, tone } = callWord(call);
  const running = call.state === 'running';
  const label = call.label ?? (call.kind === 'workflow' ? 'workflow' : `call ${call.seq}`);
  const failure = call.state === 'failed' && call.error && call.error !== 'the run was stopped' ? call.error : undefined;
  const detail = running || call.state === 'parked' ? agentDoing(lastTool)?.text : failure;
  return (
    <li data-agent-state={call.state} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-0.5 text-[12.5px] phone:text-[13.5px]">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={cn('shrink-0 truncate', running ? 'text-fg' : 'text-fg-2')}>{label}</span>
        {detail && (
          <span title={detail} className={cn('min-w-0 truncate text-[12px] phone:text-[13px]', failure ? 'text-fault' : 'text-fg-3')}>
            {detail}
          </span>
        )}
      </span>
      <span className="flex items-baseline gap-1.5 text-[12px] whitespace-nowrap phone:text-[13px]">
        <StateWord tone={tone}>{word}</StateWord>
        {running && call.startedAt ? (
          <Elapsed since={call.startedAt} format="short" className="text-signal" />
        ) : call.startedAt && call.finishedAt ? (
          <span className="num text-fg-3">{durationShort(call.finishedAt - call.startedAt)}</span>
        ) : null}
      </span>
    </li>
  );
}
