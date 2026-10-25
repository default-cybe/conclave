import type { AgentResultRef, ContentBlock, Message, Session } from '../types';
import type { Engine } from './engine';
import type { AgentDef } from '../extensions/types';
import type { SessionRunner } from '../session/runner';
import { newId } from '../util/ids';
import { lastAssistantText, reminder, renderTranscript } from '../session/transcript';
import { truncateMiddle } from '../util/text';
import { logger } from '../util/log';
import { defuseFrameworkTags } from '../session/untrusted';
import { markModelDead, subagentModel } from '../extensions/agent-model';
import { ProviderError } from '../providers/types';

const log = logger('subagent');

/**
 * What a workflow agent() call changes about its child (workflows/agents.ts):
 * where it runs, its title and tags, and meta.workflow, which the runner
 * extensions read (StructuredOutput, the step note, budgets).
 */
export interface SubagentWorkflowOptions {
  cwd?: string;
  device?: string;
  title?: string;
  /** Tags added after 'subagent'. */
  tags?: string[];
  /** Merged into the child's meta. */
  meta?: Record<string, unknown>;
  /** Called with the child's id before its first turn. */
  onCreated?: (sessionId: string) => void;
}

/**
 * What a Delegate call sets for its child (engine/delegate.ts): it runs on
 * the device and in the folder it was sent to, on the model a new session of
 * its agent gets, in the parent's permission mode.
 */
export interface SubagentDelegateOptions extends SubagentWorkflowOptions {
  cwd: string;
  device: string;
  title: string;
  model: string;
  permissionMode: Session['permissionMode'];
  /** A read-only job: no file-editing tools (engine.ts toolsFor), and on a harness the profile counts as read-only. */
  readOnly?: boolean;
  /** Set as the child's chat switches (the parent chat's memory off goes with it). */
  chat?: Session['chat'];
}

export interface SubagentResult {
  sessionId: string;
  text: string;
  /** The loop threw (a terminal API error after retries, or an abort). */
  error?: string;
  /** How the child's last turn ended (SessionRunner.lastStop). */
  stop?: SessionRunner['lastStop'];
  /** Set when a usage limit stopped it: when the limit resets. */
  resumeAt?: number;
}

/** Tools that change files. A profile with none of them is read-only. */
export const FILE_WRITE_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

function isHarnessModel(engine: Engine, ref: string): boolean {
  try {
    return !!engine.providers.resolve(ref).acp;
  } catch {
    return false;
  }
}

/**
 * A child on an ACP harness (Claude Code, Codex) gets no Conclave system
 * prompt and no tool list (session/harness.ts), so a specialist would run as
 * the plain harness: a verifier without its refute rule, able to edit. Its
 * profile goes in front of the brief, and a profile without file tools never
 * runs the harness in auto: with no shell it runs read-only (reads only),
 * with a shell (a verifier's one test) every edit and command is asked.
 */
function forHarness(def: AgentDef, prompt: string, permissionMode: Session['permissionMode'], readOnly = false): { prompt: string; permissionMode: Session['permissionMode'] } {
  const body = def.prompt?.trim();
  const withRole = body
    ? `<agent-profile name="${def.name.replace(/[^\w:.-]/g, '')}">\nYou are running as this agent. Follow these instructions for the task after this block.\n\n${body.replace(/<\/?agent-profile[^>]*>/gi, '')}\n</agent-profile>\n\n${prompt}`
    : prompt;
  const allowed = (t: string) => !(readOnly && FILE_WRITE_TOOLS.includes(t)) && (!def.tools?.length || def.tools.includes(t)) && !def.disallowedTools?.includes(t);
  if (permissionMode === 'plan' || FILE_WRITE_TOOLS.some(allowed)) return { prompt: withRole, permissionMode };
  if (!allowed('Bash')) return { prompt: withRole, permissionMode: 'plan' };
  return { prompt: withRole, permissionMode: permissionMode === 'bypass' ? 'default' : permissionMode };
}

/**
 * Run a subagent: a fresh session with its own empty context, the given agent
 * and prompt, inheriting the parent's device, cwd and permission mode. Only its
 * final text returns to the parent, so the parent's context stays clean.
 */
export async function runSubagent(
  engine: Engine,
  opts: { parentSessionId: string; agent: string; prompt: string; description: string; model?: string; background?: boolean; signal?: AbortSignal; workflow?: SubagentWorkflowOptions; delegate?: SubagentDelegateOptions },
): Promise<SubagentResult> {
  const parent = engine.getSession(opts.parentSessionId);
  if (!parent) throw new Error('Parent session gone');
  // the agent as the parent's account sees it: a member's Task never gets the owner's own agent files (docs/design/ACCOUNTS.md 2)
  const acct = engine.accountOf(parent);
  const def = engine.agentNamed(opts.agent, parent.cwd, acct) ?? engine.agentNamed('general-purpose', undefined, acct) ?? engine.agentFor(parent);
  // a subagent of an untrusted agent (email, web) stays untrusted whatever agent it runs, so Task never hands it tools its parent lacks
  const untrusted = !!engine.agentFor(parent).untrusted || parent.meta?.untrusted === true;
  const now = Date.now();
  const dlg = opts.delegate;
  const wf = opts.workflow ?? dlg;
  // tier words (fast, smart, deep) in the call or the profile resolve here (extensions/agent-model.ts); a delegated job's model was picked for it
  const model = dlg?.model ?? subagentModel(engine, opts.model, def.model, parent.model);
  const mode = dlg?.permissionMode ?? parent.permissionMode;
  // on a harness the profile rides with the brief, and a read-only profile stays read-only
  // an untrusted parent writes the brief from what it read: its framework tags are defused (session/untrusted.ts)
  const brief = untrusted ? defuseFrameworkTags(opts.prompt) : opts.prompt;
  const harness = isHarnessModel(engine, model) ? forHarness(def, brief, mode, dlg?.readOnly) : undefined;
  const prompt = harness?.prompt ?? brief;
  /** The report goes back into the parent: an untrusted child relays what it read. */
  const report = (text: string) => (untrusted || def.untrusted ? defuseFrameworkTags(text) : text);
  const sub: Session = {
    id: newId('ses'),
    // a subagent is its parent's account's (docs/design/ACCOUNTS.md)
    accountId: parent.accountId ?? 'owner',
    title: (wf?.title ?? opts.description).slice(0, wf?.title ? 120 : 60),
    agent: def.name,
    model,
    mode: def.mode === 'plan' ? 'plan' : 'agent',
    permissionMode: harness?.permissionMode ?? mode,
    cwd: wf?.cwd ?? parent.cwd,
    device: wf?.device ?? parent.device,
    status: 'idle',
    parentId: parent.id,
    tags: ['subagent', ...(wf?.tags ?? [])],
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    meta: { subagent: true, ...(untrusted ? { untrusted: true } : {}), ...(wf?.meta ?? {}) },
    ...(dlg?.chat ? { chat: dlg.chat } : {}),
  };
  engine.repos.sessions.insert(sub);
  engine.bus.emit({ type: 'session.created', session: sub });
  wf?.onCreated?.(sub.id);

  const runner = engine.runnerFor(sub.id);
  runner.depth = (runnerDepthOf(engine, parent) ?? 0) + 1;

  if (opts.background) {
    engine.patchMeta(sub.id, { background: { parentId: parent.id, state: 'running', startedAt: now } });
    // the parent gets the TaskList, TaskWait, TaskResult and TaskContinue tools from now on (engine/background.ts)
    if (!parent.meta?.backgroundTasks) engine.patchMeta(parent.id, { backgroundTasks: true });
    void driveSubagent(engine, sub.id, prompt, runner.depth)
      .then((r) => (r.resumeAt && !opts.workflow ? waitForReset(engine, parent.id, sub.id, r.resumeAt) : deliverSubagentResult(engine, parent.id, sub.id, subagentEndState(r), r.error ? `${r.text}\n\nError: ${r.error}` : r.text)))
      .catch((err) => {
        log.warn('background subagent failed', err);
        deliverSubagentResult(engine, parent.id, sub.id, 'error', `Error: ${(err as Error)?.message ?? String(err)}`);
      });
    return { sessionId: sub.id, text: `Started background subagent ${sub.id}. It will report when done.` };
  }

  const { text, error, stop, resumeAt } = await driveSubagent(engine, sub.id, prompt, runner.depth, opts.signal);
  // a workflow parks the call itself (workflows/agents.ts); a Task or Delegate child waits for the reset and reports then
  if (resumeAt && !opts.workflow) {
    waitForReset(engine, parent.id, sub.id, resumeAt);
    return {
      sessionId: sub.id,
      text: `Subagent ${sub.id} hit a usage limit and no other plan or model could take over. It continues on its own when the limit resets (${new Date(resumeAt).toISOString()}); its report then arrives in a <subagent_result> block, like a background task's. TaskList shows its state.`,
      stop,
      resumeAt,
    };
  }
  return { sessionId: sub.id, text: report(text), ...(error ? { error } : {}), ...(stop ? { stop } : {}), ...(resumeAt ? { resumeAt } : {}) };
}

/**
 * Send a subagent another message and drive it to the end of that turn: a
 * workflow's StructuredOutput nudge, or a parked call that runs again after a
 * usage limit reset.
 */
export async function continueSubagent(engine: Engine, sessionId: string, text: string, signal?: AbortSignal): Promise<SubagentResult> {
  const session = engine.getSession(sessionId);
  if (!session) throw new Error('Subagent session gone');
  const parent = session.parentId ? engine.getSession(session.parentId) : undefined;
  const depth = parent ? engine.runnerFor(parent.id).depth + 1 : 1;
  const r = await driveSubagent(engine, sessionId, text, depth, signal, true);
  return { sessionId, text: r.text, ...(r.error ? { error: r.error } : {}), ...(r.stop ? { stop: r.stop } : {}), ...(r.resumeAt ? { resumeAt: r.resumeAt } : {}) };
}

/**
 * A Task or Delegate child a usage limit stopped with nothing left to fall
 * back to: it stays parked, so the durable session.resume job continues it
 * (session/limits.ts resumeAfterReset, resumeParkedSubagent), and the parent
 * tracks it as a background task.
 */
function waitForReset(engine: Engine, parentId: string, childId: string, resumeAt: number): void {
  const child = engine.getSession(childId);
  engine.parkForReset(childId, resumeAt);
  engine.patchMeta(childId, { background: { ...((child?.meta?.background as Record<string, unknown>) ?? {}), parentId, state: 'running', startedAt: child?.createdAt ?? Date.now(), waitingReset: true } });
  if (!engine.getSession(parentId)?.meta?.backgroundTasks) engine.patchMeta(parentId, { backgroundTasks: true });
}

/** Whether a parked session is a Task or Delegate child waiting for its limit to reset (waitForReset). */
export function waitsForParent(session: Session): boolean {
  return !!session.parentId && (session.meta?.background as { waitingReset?: boolean } | undefined)?.waitingReset === true;
}

/** The limit reset: the child runs on, and its report goes to the parent, or it parks again. */
export async function resumeParkedSubagent(engine: Engine, child: Session): Promise<void> {
  const parentId = child.parentId!;
  engine.setStatus(child.id, 'idle');
  let r: SubagentResult;
  try {
    r = await continueSubagent(engine, child.id, engine.config.get().limits.resumePrompt);
  } catch (err) {
    r = { sessionId: child.id, text: '', error: (err as Error)?.message ?? String(err) };
  }
  if (r.resumeAt) return waitForReset(engine, parentId, child.id, r.resumeAt);
  const bg = (engine.getSession(child.id)?.meta?.background as Record<string, unknown>) ?? {};
  engine.patchMeta(child.id, { background: { ...bg, waitingReset: false } });
  deliverSubagentResult(engine, parentId, child.id, subagentEndState(r), r.error ? `${r.text}\n\nError: ${r.error}` : r.text);
}

/** How a subagent ended, for its <subagent_result>: an error is error, a usage limit that stopped it before it finished is limited, never completed. */
export type SubagentEnd = 'completed' | 'error' | 'limited';

export function subagentEndState(r: Pick<SubagentResult, 'error' | 'stop'>): SubagentEnd {
  return r.error ? 'error' : r.stop === 'rate_limit' ? 'limited' : 'completed';
}

/** Longest part of a background result that goes into the parent; the full text stays in the child session. */
export const SUBAGENT_RESULT_MAX_CHARS = 12_000;

function attr(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").replace(/</g, '(').replace(/>/g, ')');
}

/**
 * The report is the child's text, which may quote web pages or files. Its
 * own copies of the wrapping tags, and every other framework tag, are
 * defused, so it cannot close the block and pass the rest off as the harness
 * or the user.
 */
function defuseTags(text: string): string {
  return defuseFrameworkTags(text);
}

/** The note a parent session gets when a background subagent ends. */
export function subagentResultBlock(child: Pick<Session, 'id' | 'agent' | 'title'>, state: SubagentEnd, text: string): ContentBlock {
  const cut = truncateMiddle(defuseTags(text), SUBAGENT_RESULT_MAX_CHARS, 'omitted');
  const body = cut.truncated ? `${cut.text}\n\n[The report was ${text.length} chars and was cut; the full text is in session ${child.id}.]` : cut.text;
  return reminder(
    `A background subagent you started has finished. Its final report:\n<subagent_result session="${child.id}" agent="${attr(child.agent)}" state="${state}" description="${attr(child.title)}">\n${body}\n</subagent_result>`,
  );
}

/**
 * Post a background subagent's result to its parent: the note joins the
 * parent's next tool-results message while it works, or wakes it with an
 * auto turn when idle. A subagent parent is not woken (its caller already has
 * its answer); the note waits for its next step. Deleted and archived parents
 * get nothing.
 */
export function deliverSubagentResult(engine: Engine, parentId: string, childId: string, state: SubagentEnd, text: string): void {
  const child = engine.getSession(childId);
  if (child) engine.patchMeta(childId, { background: { ...((child.meta?.background as Record<string, unknown>) ?? {}), parentId, state, finishedAt: Date.now() } });
  const parent = engine.getSession(parentId);
  if (!parent || parent.archived || !child) return;
  const runner = engine.runnerFor(parentId);
  // the apps draw one row for the notice and the report ("Message from subagent ..."), not a notice and an empty bubble
  const result: AgentResultRef = { type: 'subagent', id: childId, label: child.title, agent: child.agent, state: state === 'error' ? 'failed' : state };
  runner.deliver({ block: subagentResultBlock(child, state, text), source: childId, wake: !parent.meta?.subagent, result });
  engine.notice(parentId, `Background task ${state === 'completed' ? 'finished' : state === 'limited' ? 'stopped at a usage limit' : 'failed'}: ${child.title}`, state === 'completed' ? 'info' : 'warning', undefined, { kind: 'agent-result', agentResult: result });
}

function runnerDepthOf(engine: Engine, session: Session): number {
  const r = engine.runnerFor(session.id);
  return r.depth;
}

/** How many times SubagentStop hooks may send a subagent back to work. */
const MAX_SUBAGENT_STOP_CONTINUES = 3;

async function driveSubagent(
  engine: Engine,
  sessionId: string,
  prompt: string,
  depth: number,
  signal?: AbortSignal,
  followUp = false,
): Promise<{ text: string; error?: string; stop?: SessionRunner['lastStop']; resumeAt?: number }> {
  const runner = engine.runnerFor(sessionId);
  runner.depth = depth;
  const session = engine.getSession(sessionId)!;
  const parent = session.parentId ? engine.getSession(session.parentId) : undefined;
  const ids = { agent_id: session.id, agent_type: session.agent };

  // SubagentStart runs in the parent's context; its additionalContext joins the subagent's first message
  const content: ContentBlock[] = [{ type: 'text', text: prompt }];
  if (parent && !followUp) {
    const start = await engine.runHook(parent, 'SubagentStart', ids, session.agent);
    for (const ctx of start.additionalContext) content.push(reminder(ctx));
  }
  engine.addMessage(sessionId, { role: 'user', kind: 'normal', content });
  // running while it works, so its working time counts (session/limit-tree.ts) and the app shows it
  engine.setStatus(sessionId, 'running');

  const controller = new AbortController();
  // a caller's signal (a workflow run that stops, a skipped call) aborts the child's turn
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  let stopHookActive = false;
  let error: string | undefined;
  let model = session.model;
  let fellBack = false;
  for (let round = 0; ; round++) {
    try {
      await runner.agentLoop(model, 'agent', controller.signal);
    } catch (err) {
      const fallback = fellBack || controller.signal.aborted ? undefined : modelFallback(engine, model, parent, err);
      if (fallback) {
        // the profile's or tier's model is one the provider cannot serve: run on the parent's (or the hub default) instead of failing
        fellBack = true;
        log.warn(`subagent ${sessionId}: ${model} not found, falling back to ${fallback}`);
        engine.updateSession(sessionId, { model: fallback }, { quiet: true });
        engine.notice(sessionId, `${model} is not available (${oneLine((err as Error).message)}), so this ran on ${fallback}.`, 'warning');
        model = fallback;
        round--;
        continue;
      }
      log.warn('subagent loop error', err);
      error = (err as Error)?.message ?? String(err);
      break;
    }
    if (!parent) break;
    const text = lastAssistantText(engine.repos.messages.list(sessionId));
    const stop = await engine.runHook(parent, 'SubagentStop', { ...ids, last_assistant_message: text, stop_hook_active: stopHookActive }, session.agent);
    if (!(stop.blocked && stop.reason) || round >= MAX_SUBAGENT_STOP_CONTINUES) break;
    stopHookActive = true;
    engine.addMessage(sessionId, { role: 'user', kind: 'normal', content: [reminder(`SubagentStop hook feedback:\n${stop.reason}`)], meta: { auto: true } });
  }
  signal?.removeEventListener('abort', onAbort);
  const text = lastAssistantText(engine.repos.messages.list(sessionId)) || '(the subagent produced no final answer)';
  // idle also when a usage limit parked it: the caller decides (a workflow parks the call, workflows/agents.ts)
  const parked = engine.getSession(sessionId);
  const resumeAt = parked?.status === 'waiting_reset' ? parked.resumeAt : undefined;
  engine.setStatus(sessionId, 'idle');
  // tell the caller how the subagent ended when it did not finish on its own
  const how = runner.lastStop ? STOP_NOTES[runner.lastStop] : undefined;
  return { text: how ? `${text}\n\n${how}` : text, error, stop: runner.lastStop, ...(resumeAt ? { resumeAt } : {}) };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * The model to retry on when the call failed because the provider does not know the model
 * (a 404 naming the model, as `cliproxy 404 not_found_error: model: claude-fable-5-1`): the
 * parent's model, else the hub default. Undefined for any other error, or when that is the
 * same model, or a harness where the child was not set up for one (or the other way round).
 */
export function modelFallback(engine: Engine, model: string, parent: Session | undefined, err: unknown): string | undefined {
  if (!(err instanceof ProviderError) || err.status !== 404 || !/model/i.test(err.message)) return undefined;
  // tier picks skip it for a while, so the next Task, workflow agent or delegated job does not spend a failed call on it
  markModelDead(engine, model);
  const to = parent?.model ?? engine.config.get().defaultModel;
  if (!to || to === model || isHarnessModel(engine, to) !== isHarnessModel(engine, model)) return undefined;
  return to;
}

const STOP_NOTES: Partial<Record<NonNullable<SessionRunner['lastStop']>, string>> = {
  step_limit: '(the subagent stopped at its step limit)',
  loop_capped: '(the subagent was stopped by the loop guard because it kept repeating the same calls)',
  output_limit: '(the subagent stopped because its replies hit the output token limit)',
  refusal: '(the subagent stopped because the model refused)',
  empty_reply: '(the subagent stopped because the model returned an empty reply)',
  rate_limit: '(the subagent stopped at a usage limit before it finished)',
};

/**
 * Review a message with another agent (second opinion delegated to an agent
 * rather than a bare model). The agent runs read-only and its summary lands as
 * an aside.
 */
export async function runReviewAgent(
  engine: Engine,
  session: Session,
  agentName: string,
  target: Message,
  instructions: string | undefined,
  diff: string,
  signal: AbortSignal,
): Promise<void> {
  const context = renderTranscript(
    engine.repos.messages.list(session.id).filter((m) => m.seq <= target.seq),
    { maxChars: 30_000 },
  );
  const prompt = `Review the last assistant answer in this conversation. ${instructions ?? ''}\n\n${context}${diff}`;
  const { text } = await runSubagent(engine, {
    parentSessionId: session.id,
    agent: agentName,
    prompt,
    description: `Review by ${agentName}`,
    signal,
  });
  engine.addMessage(session.id, {
    role: 'assistant',
    kind: 'aside',
    content: [{ type: 'text', text }],
    author: `Review (${agentName})`,
    group: newId('review'),
    meta: { messageId: target.id },
  });
}
