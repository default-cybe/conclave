/**
 * Words for workflow state (spec 1.2: state is a word in a fixed place) and
 * the status sentence a run opens with.
 */
import type { WorkflowCall, WorkflowCallState, WorkflowRun, WorkflowRunStatus, WorkflowSource } from '@conclave/core/client';
import type { StateTone } from '@/components/ui/List';
import type { MarkState } from '@/components/motion';
import { busiestKind, petState, type PetState } from '@/components/motion/agentGlyphs';
import { compact, durationShort, usd } from '@/lib/format';

export const RUN_WORD: Record<WorkflowRunStatus, string> = {
  queued: 'queued',
  running: 'running',
  paused: 'paused',
  waiting_reset: 'waiting for the limit',
  interrupted: 'interrupted',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  budget: 'stopped at budget',
};

export const RUN_TONE: Record<WorkflowRunStatus, StateTone> = {
  queued: 'dim',
  running: 'signal',
  paused: 'warn',
  waiting_reset: 'warn',
  interrupted: 'warn',
  done: 'dim',
  failed: 'fault',
  stopped: 'dim',
  budget: 'warn',
};

export const CALL_WORD: Record<WorkflowCallState, string> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
  cached: 'cached',
  parked: 'waiting',
};

export const CALL_TONE: Record<WorkflowCallState, StateTone> = {
  queued: 'dim',
  running: 'signal',
  done: 'dim',
  failed: 'fault',
  skipped: 'dim',
  cached: 'dim',
  parked: 'warn',
};

export const SOURCE_WORD: Record<WorkflowSource, string> = {
  builtin: 'built in',
  plugin: 'plugin',
  user: 'yours',
  project: 'project',
  'claude-code': 'Claude Code',
  inline: 'script',
  account: 'yours',
};

const LIVE: WorkflowRunStatus[] = ['queued', 'running', 'paused', 'waiting_reset'];

export const isLive = (s: WorkflowRunStatus) => LIVE.includes(s);

/** The Knot state for a run's header. */
export function knotFor(run: WorkflowRun): MarkState {
  if (run.status === 'running' || run.status === 'queued') return run.counts.running ? 'tool' : 'thinking';
  if (run.status === 'paused' || run.status === 'interrupted') return 'waiting';
  if (run.status === 'waiting_reset') return 'paused';
  if (run.status === 'failed') return 'failed';
  return 'done';
}

/** The pet's pose for a run's header: what most of its running agents do, or the run's state. */
export function petFor(run: WorkflowRun, calls: readonly WorkflowCall[]): PetState {
  if (run.status === 'waiting_reset') return 'parked';
  if (run.status === 'paused' || run.status === 'interrupted') return 'waiting';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'done') return 'done';
  if (!isLive(run.status)) return 'idle';
  if (calls.some((c) => c.state === 'running' && c.waiting)) return 'waiting';
  return petState(busiestKind(calls.filter((c) => c.state === 'running' && c.kind === 'agent').map((c) => c.agentType)));
}

export const tokens = (n: number) => `${compact(n)} tokens`;

/**
 * "Running. Phase 2 of 4, Verify. 14 agents: 9 done, 1 failed. 412k tokens, $3.10."
 * The parts are returned separately so the counts can roll.
 */
export function statusParts(run: WorkflowRun): { lead: string; phase?: string; agents: string; spend: string } {
  const c = run.counts;
  const lead = RUN_WORD[run.status].charAt(0).toUpperCase() + RUN_WORD[run.status].slice(1);
  const phase = run.phaseIndex >= 0 && run.phases.length ? `Phase ${run.phaseIndex + 1} of ${run.phases.length}, ${run.phases[run.phaseIndex]?.title ?? run.phaseTitle ?? ''}` : undefined;
  const bits = [c.done + c.cached ? `${c.done + c.cached} done` : '', c.running ? `${c.running} running` : '', c.failed ? `${c.failed} failed` : '', c.parked ? `${c.parked} waiting` : '', c.skipped ? `${c.skipped} skipped` : ''].filter(Boolean);
  const agents = `${c.agents} ${c.agents === 1 ? 'agent' : 'agents'}${bits.length ? `: ${bits.join(', ')}` : ''}`;
  const spend = `${compact(run.inputTokens + run.outputTokens)} tokens, ${usd(run.costUsd)}`;
  return { lead, phase, agents, spend };
}

export function statusSentence(run: WorkflowRun): string {
  const p = statusParts(run);
  return [p.lead, p.phase, p.agents, p.spend].filter(Boolean).join('. ') + '.';
}

/** Calls grouped by phase in meta.phases order; calls in phases meta does not name come after. */
export function byPhase(run: WorkflowRun, calls: WorkflowCall[]): Array<{ title: string; detail?: string; calls: WorkflowCall[] }> {
  const groups = run.phases.map((p) => ({ title: p.title, detail: p.detail, calls: [] as WorkflowCall[] }));
  const other = { title: 'Other calls', detail: undefined as string | undefined, calls: [] as WorkflowCall[] };
  for (const c of calls) {
    const g = groups.find((x) => x.title === c.phase);
    (g ?? other).calls.push(c);
  }
  return [...groups, ...(other.calls.length ? [other] : [])];
}

// ---------------------------------------------------------------------------
// A workflow in a session: its row, its detail and the running tasks list
// (WorkflowCard.tsx, features/chat/RunningTasks.tsx)
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** The workflow a call runs: its library name, else the name in its script's meta. */
export function workflowName(input: Record<string, unknown> | undefined): string {
  return str(input?.name) ?? (str(input?.script) ? /name:\s*['"]([^'"]+)/.exec(String(input?.script))?.[1] : undefined) ?? 'workflow';
}

/** "3 of 6 agents running": the same words on the web and on Android. */
export function agentsRunning(run: Pick<WorkflowRun, 'counts'>): string {
  const c = run.counts;
  return `${c.running} of ${c.agents} ${c.agents === 1 ? 'agent' : 'agents'} running`;
}

/** "Phase 2 of 5, Search"; undefined before the first phase. */
export function phaseLine(run: Pick<WorkflowRun, 'phases' | 'phaseIndex' | 'phaseTitle'>): string | undefined {
  if (run.phaseIndex < 0 || !run.phases.length) return undefined;
  const title = run.phases[run.phaseIndex]?.title ?? run.phaseTitle;
  return `Phase ${run.phaseIndex + 1} of ${run.phases.length}${title ? `, ${title}` : ''}`;
}

/** Where a live run is: "Phase 2 of 5, Search. 3 of 6 agents running". "Starting" before its first agent. */
export function taskLine(run: WorkflowRun): string {
  return [phaseLine(run), run.counts.agents ? agentsRunning(run) : 'Starting'].filter(Boolean).join('. ');
}

/** What a Workflow call's row says: the words after its name and the state at its right. */
export interface WorkflowRowState {
  /** After the name: "3 of 6 agents running", the first line of the result, why it did not start. */
  detail?: string;
  /** How the detail joins the name: ", 3 of 6 agents running" for a state, ": Use Caddy." for a result. */
  sep: ', ' | ': ';
  /** At the right, when the run does not run now (the time runs there then). */
  word?: string;
  tone: StateTone;
  /** The run runs now: the still Knot and its time at the right. */
  running: boolean;
  /** The run is not over (queued, running, paused, waiting for a limit), or the call has not started one yet. */
  live: boolean;
  /** The detail is why it failed to start. */
  fault?: boolean;
}

/**
 * A Workflow call's row from what is known: its run (live from the hub's
 * workflow.* events), the run's result and the call's own result text.
 * "Workflow deep-research, 3 of 6 agents running" with the time while it
 * runs; "Workflow deep-research: Use Caddy for the homelab." and "done in
 * 4m" once it ended.
 */
export function workflowRowState({ run, result, runResult, toolText }: { run?: WorkflowRun; result?: { isError?: boolean; meta?: Record<string, unknown> }; runResult?: unknown; toolText?: string }): WorkflowRowState {
  if (run && isLive(run.status)) {
    const detail = run.counts.agents ? agentsRunning(run) : 'starting';
    if (run.status === 'running') return { detail, sep: ', ', tone: 'signal', running: true, live: true };
    return { detail, sep: ', ', word: RUN_WORD[run.status], tone: RUN_TONE[run.status], running: false, live: true };
  }
  if (run) {
    const took = run.finishedAt ? durationShort(run.finishedAt - (run.startedAt ?? run.createdAt)) : undefined;
    const line = resultLine(runResult, toolText, run.error);
    return {
      detail: line ?? `${run.counts.agents} ${run.counts.agents === 1 ? 'agent' : 'agents'}`,
      sep: line ? ': ' : ', ',
      word: run.status === 'done' && took ? `done in ${took}` : RUN_WORD[run.status],
      tone: RUN_TONE[run.status],
      running: false,
      live: false,
    };
  }
  // the call names its run, which is still loading
  if (str(result?.meta?.workflowRunId)) return { sep: ', ', tone: 'dim', running: false, live: false };
  if (!result) return { sep: ', ', word: 'starting', tone: 'dim', running: false, live: true };
  if (result.isError) return { detail: resultLine(toolText) ?? 'Did not start.', sep: ': ', word: 'did not start', tone: 'fault', running: false, live: false, fault: true };
  // a run the hub does not have (a harness's own workflow): the tool's text is all there is
  const line = toolText ? (resultLine(undefined, toolText) ?? resultLine(toolText)) : undefined;
  return { detail: line, sep: ': ', word: 'done', tone: 'dim', running: false, live: false };
}

/** A phase on the card: its calls and where the run is. */
export interface CardPhase {
  title: string;
  /** done: the run is past it (or ended in or after it). current: the run is in it. next: not reached. */
  state: 'done' | 'current' | 'next';
  calls: WorkflowCall[];
  done: number;
  running: number;
  waiting: number;
  failed: number;
}

const settled = (c: WorkflowCall) => c.state === 'done' || c.state === 'cached' || c.state === 'skipped';

/**
 * The run's phases with their top level calls (a nested workflow's own calls
 * are in the run view), in meta.phases order, then calls in phases meta does
 * not name. A finished run has no current phase.
 */
export function cardPhases(run: WorkflowRun, calls: WorkflowCall[]): CardPhase[] {
  const top = calls.filter((c) => c.parentSeq === undefined || !calls.some((p) => p.seq === c.parentSeq));
  const live = isLive(run.status);
  return byPhase(run, top).map((g, i) => {
    let state: CardPhase['state'];
    if (i >= run.phases.length) state = live && g.calls.some((c) => !settled(c) && c.state !== 'failed') ? 'current' : 'done';
    else if (i < run.phaseIndex) state = 'done';
    else if (i === run.phaseIndex) state = live ? 'current' : 'done';
    else state = !live && g.calls.length ? 'done' : 'next';
    return {
      title: g.title,
      state,
      calls: g.calls,
      done: g.calls.filter(settled).length,
      running: g.calls.filter((c) => c.state === 'running' && !c.waiting).length,
      waiting: g.calls.filter((c) => c.state === 'parked' || (c.state === 'running' && !!c.waiting)).length,
      failed: g.calls.filter((c) => c.state === 'failed').length,
    };
  });
}

/** "3 of 8 done, 2 running, 1 failed"; "" for a phase with no calls. */
export function phaseWords(p: Pick<CardPhase, 'calls' | 'done' | 'running' | 'waiting' | 'failed'>): string {
  if (!p.calls.length) return '';
  return [`${p.done} of ${p.calls.length} done`, p.running ? `${p.running} running` : '', p.waiting ? `${p.waiting} waiting` : '', p.failed ? `${p.failed} failed` : ''].filter(Boolean).join(', ');
}

/** A call's state word on the card: waiting when its agent waits on you. */
export function callWord(c: WorkflowCall): { word: string; tone: StateTone } {
  if (c.state === 'running' && c.waiting) return { word: 'waiting', tone: 'warn' };
  return { word: CALL_WORD[c.state], tone: CALL_TONE[c.state] };
}

/**
 * The calls a phase shows on the card: all of them up to `max`; past that,
 * the ones still to finish and the failed ones, in their order so rows do
 * not jump, and how many more the run view has.
 */
export function shownCalls(calls: WorkflowCall[], max = 8): { shown: WorkflowCall[]; more: number } {
  if (calls.length <= max) return { shown: calls, more: 0 };
  const shown = calls.filter((c) => !settled(c)).slice(0, max);
  return { shown, more: calls.length - shown.length };
}

function pickText(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of ['summary', 'report', 'answer', 'result', 'text', 'message', 'verdict']) {
      const t = pickText((v as Record<string, unknown>)[k]);
      if (t) return t;
    }
  }
  return undefined;
}

/**
 * A finished run's result in one line, for the closed card: the first line
 * of its report (a string result, or the summary, report or text of an
 * object), else of the body of the tool's result, else the error. Markdown
 * marks at the start of a line go; a long line is cut at 200 characters.
 */
export function resultLine(result: unknown, toolText?: string, error?: string): string | undefined {
  let text = pickText(result);
  if (!text && toolText) {
    // the Workflow tool's text: a head ("Workflow x done. Run wfr_1 ..."), a blank line, then the result
    const body = toolText.split(/\n\s*\n/).slice(1).join('\n\n').trim();
    if (body && body !== '(no result)') {
      try {
        text = pickText(JSON.parse(body)) ?? body;
      } catch {
        text = body;
      }
    }
  }
  text = text || error;
  const line = text
    ?.split('\n')
    .map((l) => l.replace(/^\s*(#+\s+|[-*]\s+|>\s+)/, '').replace(/\*\*/g, '').trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
