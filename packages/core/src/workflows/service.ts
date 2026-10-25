/**
 * The workflow service (docs/WORKFLOWS.md): the library, starting runs,
 * their controls, crash recovery, the usage-limit park, and the runner
 * extension that gives workflow agents their StructuredOutput tool, their
 * step note and their limits.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { Engine } from '../engine/engine';
import { EngineError } from '../engine/errors';
import type { Machine } from '../machine/types';
import type { AgentResultRef, ContentBlock, Session } from '../types';
import type {
  FindingVerdict,
  StartWorkflowInput,
  WorkflowCall,
  WorkflowDetail,
  WorkflowFinding,
  WorkflowPreset,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunsQuery,
  WorkflowSource,
  WorkflowStatusAgent,
  WorkflowStatusView,
  WorkflowSummary,
  WorktreeAction,
  WorktreeActionResult,
} from '../client/workflows';
import type { Tool } from '../tools/types';
import { toolByName } from '../tools';
import { reminder } from '../session/transcript';
import { truncateMiddle, oneLine } from '../util/text';
import { newId } from '../util/ids';
import { logger } from '../util/log';
import { WorkflowStore, runDto, callDto, sha256, type CallRow, type RunRow } from './store';
import { WorkflowRegistry, loadMeta, readScriptFile, summaryOf, type RegistryDeps } from './registry';
import { LiveRun, SKIPPED_BY_OWNER } from './run';
import { DEFAULTS, Semaphore, SemaphoreMap, budgetWord, count, type RunCaps } from './limits';
import type { StepState } from './agents';
import { repoInfo, worktreeAction as runWorktreeAction, pruneWorktrees } from './worktrees';
import { setWorkflows } from './attached';
import { MAX_SCRIPT_BYTES, MINIMAL_WORKFLOW_EXAMPLE, WorkflowLoadError } from './meta';
import { OWNER_ID, currentAccount, isMember } from '../people/context';
import type { SANDBOX_LIMITS } from './sandbox';

const log = logger('workflows');

export const RESUME_JOB = 'workflow.resume';
/** args larger than this (as JSON) are refused. */
const MAX_ARGS_CHARS = 1_000_000;
/** More runs than this dying together looks like a crash loop: none auto-resume. */
const CRASH_LOOP = 3;

export interface StartOptions {
  /** The Workflow tool call that started it. */
  toolUseId?: string;
  /** The owner's message that started the run, for a +500k budget word. */
  ownerText?: string;
  /** Unattended: approvals are denied and lib.ask takes the first option. */
  unattended?: boolean;
  /** Where the script came from when the caller resolved it (the Workflow tool resolves before it asks). */
  source?: WorkflowSource;
  /** Whose run (docs/design/ACCOUNTS.md): the session must be theirs; a host session is made for them. */
  accountId?: string;
}

/** Workflows a member may run: the ones that ship, plugins, and their own project's or inline. Never the owner's library on the hub. */
function memberMay(source: WorkflowSource): boolean {
  return source !== 'user';
}

/**
 * meta.permissions.allow widens what the run's agents and lib.exec may do
 * without asking, so it counts only for a script the owner put in place: a
 * built-in, an installed plugin, one saved under ~/.conclave/workflows, or an
 * inline script the owner sent through the API. A script an agent wrote (the
 * Workflow tool) or one that came with a repository (project, .claude) keeps
 * its deny rules only.
 */
function trustedAllow(source: WorkflowSource, fromTool: boolean): boolean {
  if (source === 'builtin' || source === 'plugin' || source === 'user') return true;
  return source === 'inline' && !fromTool;
}

export interface ResolvedScript {
  name: string;
  source: WorkflowSource;
  script: string;
  scriptSha: string;
  body: string;
  meta: NonNullable<RunRow['meta']>;
  path?: string;
}

/** A description for the approval card: one sentence, cut at a word with an ellipsis when long. */
function cardText(description: string): string {
  const d = oneLine(description, 400).replace(/[.\s]+$/, '');
  if (d.length <= 140) return `${d}.`;
  const cut = d.slice(0, 140);
  const at = cut.lastIndexOf(' ');
  return `${(at > 60 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, '')}…`;
}

function workflowResultBlock(run: RunRow, text: string): ContentBlock {
  const safe = text.replace(/<(\/?)(workflow_result|system-reminder)/gi, '&lt;$1$2');
  return reminder(`A workflow you started has finished.\n<workflow_result run="${run.id}" name="${run.name.replace(/"/g, "'")}" status="${run.status}">\n${safe}\n</workflow_result>`);
}

/** WorkflowStatus goes wherever Workflow goes: added when the list has Workflow, taken away when it does not. */
function pairStatusTool(tools: Tool[], disallowed: string[] | undefined): Tool[] {
  const hasRun = tools.some((t) => t.name === 'Workflow');
  const hasStatus = tools.some((t) => t.name === 'WorkflowStatus');
  if (!hasRun) return hasStatus ? tools.filter((t) => t.name !== 'WorkflowStatus') : tools;
  if (hasStatus || disallowed?.includes('WorkflowStatus')) return tools;
  const status = toolByName('WorkflowStatus');
  return status ? [...tools, status] : tools;
}

/** Call states that are over. */
const CALL_ENDED = new Set<CallRow['state']>(['done', 'failed', 'skipped', 'cached']);
/** Run states that are over. */
const RUN_ENDED = new Set<RunRow['status']>(['done', 'failed', 'stopped', 'budget', 'interrupted']);
/** WorkflowStatus lists at most this many errors. */
const STATUS_ERRORS = 50;

/** The text of the owner's last message in a session (for a +500k budget word). */
function lastOwnerText(engine: Engine, sessionId: string): string | undefined {
  const msgs = engine.getMessages(sessionId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user' || m.kind !== 'normal' || m.meta?.auto) continue;
    const t = m.content.find((b) => b.type === 'text' && !(b as { text: string }).text.startsWith('<system-reminder>')) as { text: string } | undefined;
    if (t) return t.text;
  }
  return undefined;
}

export class WorkflowService {
  readonly store: WorkflowStore;
  readonly registry: WorkflowRegistry;
  readonly live = new Map<string, LiveRun>();
  /** Live workflow children by session id. */
  readonly steps = new Map<string, StepState>();
  readonly hubSemaphore: Semaphore;
  readonly providerSemaphores: SemaphoreMap;
  readonly worktreeSemaphores: SemaphoreMap;
  closed = false;
  /** Sandbox limits for every run (tests lower the CPU limit). */
  sandboxLimits: Partial<typeof SANDBOX_LIMITS> = {};
  /** Per-run caps on host calls, checks, findings and phases (tests lower them). */
  caps: RunCaps = {};
  private offBus?: () => void;
  private offExt?: () => void;
  private stallTimer?: ReturnType<typeof setInterval>;

  constructor(
    readonly engine: Engine,
    deps: Omit<RegistryDeps, 'home' | 'claudeCodeCompat'> & { home?: string },
  ) {
    this.store = new WorkflowStore(engine.repos.db);
    const home = deps.home ?? engine.config.paths.home;
    this.registry = new WorkflowRegistry({ ...deps, home, claudeCodeCompat: () => !!engine.config.get().compat?.claudeCode });
    const cfg = () => engine.config.get().workflows ?? {};
    this.hubSemaphore = new Semaphore(cfg().hubMax ?? DEFAULTS.hubMax);
    this.providerSemaphores = new SemaphoreMap(() => cfg().perProvider ?? DEFAULTS.perProvider);
    this.worktreeSemaphores = new SemaphoreMap(() => DEFAULTS.worktreesPerDevice);
    setWorkflows(engine, this);
  }

  // ----- lifecycle -----

  /** Boot: recover runs a crash or restart left, register the resume job and the runner extension. */
  start(opts: { resumeInterrupted?: boolean } = {}): void {
    this.engine.scheduler.handle(RESUME_JOB, (p) => this.onResumeJob(String(p.runId ?? '')));
    this.offExt = this.engine.runnerExtensions.register(this.extension());
    this.offBus = this.engine.bus.on((e) => {
      // an agent waiting on a tool approval shows as waiting in the run view
      if (e.type === 'approval.requested' || e.type === 'approval.resolved') {
        const sid = e.type === 'approval.requested' ? e.approval.sessionId : e.sessionId;
        const step = this.steps.get(sid);
        const call = step ? this.live.get(step.runId)?.calls.get(step.seq) : undefined;
        if (!step || !call) return;
        step.lastActivity = Date.now();
        const lastTool = e.type === 'approval.requested' ? oneLine(`needs approval: ${e.approval.summary}`, 120) : (call.lastTool ?? '').replace(/^needs approval: /, '');
        call.lastTool = lastTool;
        this.engine.bus.emit({ type: 'workflow.progress', runId: step.runId, callSeq: step.seq, lastTool, waiting: e.type === 'approval.requested' ? 'approval' : false });
        return;
      }
      if (e.type !== 'message.updated' && e.type !== 'message.created') return;
      const step = this.steps.get(e.message.sessionId);
      if (!step) return;
      step.lastActivity = Date.now();
      const uses = e.message.content.filter((b) => b.type === 'tool_use') as Array<{ name: string; input: Record<string, unknown> }>;
      const last = uses[uses.length - 1];
      if (!last) return;
      const tool = toolByName(last.name);
      let summary = last.name;
      try {
        summary = tool?.summarize?.(last.input as never) ?? last.name;
      } catch {
        summary = last.name;
      }
      const lastTool = oneLine(summary, 120);
      const run = this.live.get(step.runId);
      const call = run?.calls.get(step.seq);
      if (call) call.lastTool = lastTool;
      this.engine.bus.emit({ type: 'workflow.progress', runId: step.runId, callSeq: step.seq, lastTool });
    });
    this.stallTimer = setInterval(() => this.checkStalls(), 5000);
    (this.stallTimer as { unref?: () => void }).unref?.();

    // runs left going by a crash are interrupted; they resume once unless many died together.
    // A paused run stays paused: Resume runs it again from its journal
    const dead = this.store.listRuns({ statuses: ['running', 'queued', 'waiting_reset'], limit: 500 });
    for (const r of dead) this.store.updateRun({ ...r, status: 'interrupted', error: 'the hub stopped while the run was going' });
    const interrupted = this.store.listRuns({ status: 'interrupted', limit: 500 }).filter((r) => r.autoResumes < 1);
    if (opts.resumeInterrupted === false || !interrupted.length) return;
    if (interrupted.length > CRASH_LOOP) {
      log.warn(`${interrupted.length} workflow runs were interrupted together; none resume on their own (resume them from the run view)`);
      for (const r of interrupted) this.store.updateRun({ ...r, autoResumes: r.autoResumes + 1 });
      this.engine.notice(undefined, `${interrupted.length} workflow runs stopped when the hub went down. Resume them from Workflows, Runs.`, 'warning', 'Workflows');
      return;
    }
    for (const r of interrupted) {
      void this.resume(r.id, { auto: true }).catch((err) => log.warn(`auto resume of ${r.id} failed`, err));
    }
    // worktrees left by a crash
    void this.pruneAll().catch(() => {});
  }

  private async pruneAll(): Promise<void> {
    const seen = new Set<string>();
    for (const r of this.store.listRuns({ limit: 100 })) {
      const key = `${r.device}:${r.cwd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const machine = this.engine.devices.get(r.device);
      if (!machine) continue;
      const repo = await repoInfo(machine, r.cwd).catch(() => undefined);
      if (repo) await pruneWorktrees(machine, repo.root);
    }
  }

  /** Graceful shutdown: running runs are marked interrupted and resume at the next boot. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    for (const run of this.live.values()) {
      const paused = run.isPaused;
      run.stop('interrupted');
      // on the live row too, so a later write (the 2 s ticker, a call that ends) keeps it; a paused run waits for Resume
      if (paused) run.setStatus('paused');
      else run.setStatus('interrupted', { error: 'the hub stopped while the run was going' });
    }
    this.closed = true;
    await Promise.race([Promise.all([...this.live.values()].map((r) => r.done)), new Promise((r) => setTimeout(r, 3000))]);
    this.offBus?.();
    this.offExt?.();
    if (this.stallTimer) clearInterval(this.stallTimer);
  }

  private checkStalls(): void {
    const now = Date.now();
    for (const [, st] of this.steps) {
      if (!st.stallMs || now - st.lastActivity < st.stallMs) continue;
      const run = this.live.get(st.runId);
      if (!run) continue;
      run.log(`${run.calls.get(st.seq)?.label ?? `call ${st.seq}`} made no progress for ${Math.round(st.stallMs / 1000)} s and was stopped (stallMs)`);
      st.lastActivity = now;
      run.skip(st.seq, 'stall');
    }
  }

  // ----- the runner extension -----

  /** A session's tools as workflows change them: a workflow agent's list, and where the Workflow tool goes. undefined: unchanged. */
  private toolList(session: Session, tools: Tool[], depth: number): Tool[] | undefined {
    const wf = session.meta?.workflow as { runId?: string } | undefined;
    if (wf) {
      const step = this.steps.get(session.id);
      const agent = this.engine.agentFor(session);
      let out = tools.filter((t) => t.name !== 'AskUserQuestion' && t.name !== 'Workflow' && (t.name !== 'Task' || !!agent.tools?.includes('Task')));
      if (step?.tools?.length) {
        const allow = new Set(step.tools);
        out = out.filter((t) => allow.has(t.name));
      }
      if (step?.structured) out = [...out.filter((t) => t.name !== 'StructuredOutput'), step.structured.tool];
      return out;
    }
    const untrusted = session.meta?.untrusted === true || !!this.engine.agentFor(session).untrusted;
    if (depth > 0 || untrusted || session.kind === 'chat') return tools.some((t) => t.name === 'Workflow') ? tools.filter((t) => t.name !== 'Workflow') : undefined;
    // Ultra turns the Workflow tool on even for an agent whose tool list leaves it out
    if (session.ultra && !tools.some((t) => t.name === 'Workflow')) {
      const wfTool = toolByName('Workflow');
      if (wfTool) return [...tools, wfTool];
    }
    return undefined;
  }

  private extension() {
    return {
      name: 'workflows',
      tools: (session: Session, tools: Tool[], depth: number): Tool[] | undefined => {
        const out = this.toolList(session, tools, depth) ?? tools;
        // WorkflowStatus is offered exactly where Workflow is, unless the agent turns it off
        const paired = pairStatusTool(out, this.engine.agentFor(session).disallowedTools);
        return paired === tools ? undefined : paired;
      },
      beforeStep: (ctx: { session: Session; iter: number }) => {
        const wf = ctx.session.meta?.workflow as { runId?: string; seq?: number } | undefined;
        if (!wf?.runId) return undefined;
        const run = this.live.get(wf.runId);
        if (!run) return undefined;
        if (run.controller.signal.aborted) return { stop: 'The workflow run was stopped.' };
        // the run's budget is a node of the session limit tree (session/limit-tree.ts), checked there
        const step = this.steps.get(ctx.session.id);
        if (step?.maxSteps && ctx.iter >= step.maxSteps) return { stop: `This workflow step reached its limit of ${step.maxSteps} model calls.` };
        return undefined;
      },
    };
  }

  /**
   * A live run's budget as a node of the session limit tree: output tokens
   * and cost, counting what earlier attempts of the run spent.
   */
  budgetNode(runId: string): { limits: { tokens?: number; costUsd?: number }; used: () => { tokens: number; costUsd: number; turns: number; minutes: number } } | undefined {
    const run = this.live.get(runId);
    const b = run?.row.budget;
    if (!run || !b || (!b.tokens && !b.costUsd)) return undefined;
    return { limits: { ...(b.tokens ? { tokens: b.tokens } : {}), ...(b.costUsd ? { costUsd: b.costUsd } : {}) }, used: () => ({ tokens: run.spentTokens(), costUsd: run.spentCost(), turns: 0, minutes: 0 }) };
  }

  // ----- the library -----

  private projectFor(sessionId?: string): { machine: Machine; cwd: string } | undefined {
    const s = sessionId ? this.engine.getSession(sessionId) : undefined;
    if (!s || s.kind === 'chat') return undefined;
    return { machine: this.engine.machineFor(s), cwd: s.cwd };
  }

  async library(q: { sessionId?: string; accountId?: string } = {}): Promise<WorkflowSummary[]> {
    const acct = q.accountId ?? currentAccount() ?? OWNER_ID;
    const entries = (await this.registry.list(this.projectFor(q.sessionId))).filter((e) => !isMember(acct) || memberMay(e.source));
    const last = this.store.lastRuns(acct);
    return entries.map((e) => {
      const r = last.get(e.meta?.name ?? e.id);
      return summaryOf(e, r ? { id: r.id, status: r.status, createdAt: r.createdAt, ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}) } : undefined);
    });
  }

  async detail(id: string, sessionId?: string): Promise<WorkflowDetail> {
    const e = await this.registry.get(id, this.projectFor(sessionId));
    const acct = currentAccount() ?? OWNER_ID;
    if (!e || (isMember(acct) && !memberMay(e.source))) throw new EngineError(404, `workflow ${id} not found`);
    const last = this.store.lastRuns(acct).get(e.meta?.name ?? e.id);
    return { ...summaryOf(e, last ? { id: last.id, status: last.status, createdAt: last.createdAt, ...(last.finishedAt ? { finishedAt: last.finishedAt } : {}) } : undefined), script: e.script, ...(e.meta ? { meta: e.meta } : {}) };
  }

  /** A script by name, inline, or path; the meta checked. Throws EngineError 400 with the reason. */
  async resolveScript(input: Pick<StartWorkflowInput, 'name' | 'script' | 'scriptPath'>, session?: Session): Promise<ResolvedScript> {
    let script: string | undefined;
    let source: WorkflowSource = 'inline';
    let path: string | undefined;
    if (input.script) script = input.script;
    else if (input.scriptPath) {
      // a relative path or ~ is the session's: its folder, on its device
      path = session && !input.scriptPath.startsWith('/') ? this.engine.machineFor(session).resolve(input.scriptPath, session.cwd) : input.scriptPath;
      const hubPath = resolvePath(path);
      // only regular files up to the script cap: a pipe or a device behind the name would hang the read
      const read = async (m: Machine, p: string): Promise<string | undefined> => {
        const st = await m.stat(p).catch(() => null);
        if (!st || st.type !== 'file') return undefined;
        if (st.size > MAX_SCRIPT_BYTES) throw new EngineError(400, `the script at ${input.scriptPath} is larger than ${MAX_SCRIPT_BYTES / 1024} KB`);
        return m.readText(p).catch(() => undefined);
      };
      // the owner's library on the hub is the owner's: a member's session reads scripts on its own device only
      const memberSession = isMember(session?.accountId ?? currentAccount());
      const onHub = !memberSession && hubPath.startsWith(this.registry.userDir + '/') && existsSync(hubPath);
      if (onHub) {
        const r = readScriptFile(hubPath);
        if (r.error) throw new EngineError(400, `${input.scriptPath}: ${r.error}`);
        script = r.script;
      } else if (session) script = await read(this.engine.machineFor(session), path);
      if (script === undefined) throw new EngineError(400, `cannot read the script at ${input.scriptPath}`);
      // only the owner's library on the hub counts as theirs: a file anywhere else on the device is
      // one an agent could have written or a repository brought, so it is treated like a project script
      source = onHub ? (hubPath.startsWith(this.registry.runsDir + '/') ? 'inline' : 'user') : 'project';
    } else if (input.name) {
      const e = await this.registry.get(input.name, session && session.kind !== 'chat' ? { machine: this.engine.machineFor(session), cwd: session.cwd } : undefined);
      if (!e || (isMember(session?.accountId ?? currentAccount()) && !memberMay(e.source))) throw new EngineError(404, `workflow ${input.name} not found`);
      if (e.error) throw new EngineError(400, `workflow ${input.name} cannot run here: ${e.error}`);
      script = e.script;
      source = e.source;
      path = e.path?.startsWith('builtin:') ? undefined : e.path;
    }
    if (!script) throw new EngineError(400, 'name, script or scriptPath is required');
    try {
      const { meta, body } = await loadMeta(script);
      return { name: meta.name, source, script, scriptSha: sha256(script), body, meta, ...(path ? { path } : {}) };
    } catch (err) {
      if (err instanceof WorkflowLoadError) throw new EngineError(400, err.message);
      throw err;
    }
  }

  /** workflow() inside a script: a name or { scriptPath }. */
  async resolveRef(ref: unknown, parent: RunRow): Promise<ResolvedScript> {
    const session = parent.sessionId ? this.engine.getSession(parent.sessionId) : undefined;
    try {
      if (typeof ref === 'string') return await this.resolveScript({ name: ref }, session);
      if (ref && typeof ref === 'object' && typeof (ref as { scriptPath?: unknown }).scriptPath === 'string') return await this.resolveScript({ scriptPath: (ref as { scriptPath: string }).scriptPath }, session);
    } catch (err) {
      throw new Error((err as Error).message);
    }
    throw new Error('workflow() takes a name or { scriptPath }');
  }

  /** Project setting worktreeSetup from <repo>/.conclave/settings.json on the device. */
  async worktreeSetup(machine: Machine, root: string): Promise<string | undefined> {
    try {
      const text = await machine.readText(join(root, '.conclave', 'settings.json'));
      const v = JSON.parse(text) as { worktreeSetup?: unknown };
      return typeof v.worktreeSetup === 'string' && v.worktreeSetup.trim() ? v.worktreeSetup.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  // ----- saved launch presets -----

  /** A preset belongs to a workflow in the caller's library: same existence and memberMay rule as startRun. */
  private async presetWorkflow(id: string, accountId: string): Promise<void> {
    const e = await this.registry.get(id);
    if (!e || (isMember(accountId) && !memberMay(e.source))) throw new EngineError(404, `workflow ${id} not found`);
  }

  /** Saved args presets for one workflow, this account's. */
  async listPresets(workflow: string, accountId = currentAccount() ?? OWNER_ID): Promise<WorkflowPreset[]> {
    await this.presetWorkflow(workflow, accountId);
    return this.store.presets(workflow, accountId);
  }

  /** Save (or replace by name) an args preset for a workflow. */
  async savePreset(workflow: string, name: string, args: unknown, accountId = currentAccount() ?? OWNER_ID): Promise<WorkflowPreset> {
    await this.presetWorkflow(workflow, accountId);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) throw new EngineError(400, 'a preset name is required, at most 200 characters');
    let size = 0;
    try {
      size = JSON.stringify(args ?? null)?.length ?? 0;
    } catch {
      throw new EngineError(400, 'args must be plain JSON');
    }
    if (args !== undefined && size > MAX_ARGS_CHARS) throw new EngineError(400, `args are larger than ${MAX_ARGS_CHARS / 1_000_000} MB of JSON; pass a file path and let the agents read it`);
    const preset: WorkflowPreset = { id: newId('wfp'), workflow, name: trimmed, args: args ?? null, createdAt: Date.now() };
    this.store.savePreset({ ...preset, accountId });
    return preset;
  }

  async deletePreset(workflow: string, id: string, accountId = currentAccount() ?? OWNER_ID): Promise<void> {
    await this.presetWorkflow(workflow, accountId);
    this.store.deletePreset(workflow, id, accountId);
  }

  // ----- runs -----

  private saveScript(runId: string, script: string): string | undefined {
    try {
      mkdirSync(this.registry.runsDir, { recursive: true });
      const p = join(this.registry.runsDir, `${runId}.js`);
      writeFileSync(p, script, { mode: 0o600 });
      return p;
    } catch (err) {
      log.warn('could not save the run script', err);
      return undefined;
    }
  }

  /** Start a run. Returns as soon as it is going; wait() waits for its end. */
  async startRun(input: StartWorkflowInput, opts: StartOptions = {}): Promise<WorkflowRun> {
    if (this.closed) throw new EngineError(503, 'the hub is shutting down');
    let session = input.sessionId ? this.engine.getSession(input.sessionId) : undefined;
    // the run's account: the caller's, else the session's, else whoever the work runs for
    const acct = opts.accountId ?? session?.accountId ?? currentAccount() ?? OWNER_ID;
    if (input.sessionId && (!session || (session.accountId ?? OWNER_ID) !== acct)) throw new EngineError(404, `session ${input.sessionId} not found`);
    if (session?.kind === 'chat') throw new EngineError(400, 'workflows run in sessions, not chats');
    // args go into the sandbox and into the run row, which is written on every status change
    if (input.args !== undefined) {
      let size = 0;
      try {
        size = JSON.stringify(input.args)?.length ?? 0;
      } catch {
        throw new EngineError(400, 'args must be plain JSON');
      }
      if (size > MAX_ARGS_CHARS) throw new EngineError(400, `args are larger than ${MAX_ARGS_CHARS / 1_000_000} MB of JSON; pass a file path and let the agents read it`);
    }

    const old = input.resumeFromRunId ? this.store.getRun(input.resumeFromRunId) : undefined;
    if (input.resumeFromRunId && (!old || this.runAccount(old) !== acct)) throw new EngineError(404, `run ${input.resumeFromRunId} not found`);
    const resolved = !input.name && !input.script && !input.scriptPath && old ? await this.resolveScript({ script: old.script }, session) : await this.resolveScript(input, session);

    const device = input.device ?? session?.device ?? old?.device ?? 'local';
    if (device !== 'local' && this.engine.repos.devices.accountOf(device) !== acct) throw new EngineError(404, `Device ${device} not found`);
    const machine = this.engine.machineFor({ device, accountId: acct } as Session);
    const deviceHome = await this.engine.machineHome(machine);
    let cwd = input.cwd ?? session?.cwd ?? old?.cwd;
    // "~/code/x" from the Run sheet: the device's own path, so citations, checks and worktrees all find it
    cwd = cwd ? machine.resolve(cwd, deviceHome ?? '/') : (deviceHome ?? process.cwd());

    let hostSession = false;
    if (!session) {
      session = await this.engine.createSession({ title: `Workflow: ${resolved.name}`, tags: ['workflow'], device, cwd }, acct);
      hostSession = true;
    }

    const id = newId('wfr');
    const source = opts.source ?? resolved.source;
    let meta = resolved.meta;
    let allowDropped: string[] = [];
    const perms = meta.permissions;
    if (perms && Array.isArray(perms.allow) && perms.allow.length && !trustedAllow(source, !!opts.toolUseId)) {
      allowDropped = perms.allow.filter((r): r is string => typeof r === 'string');
      meta = { ...meta, permissions: { ...(Array.isArray(perms.deny) ? { deny: perms.deny } : {}) } };
    }
    const tokens = input.budget?.tokens ?? (opts.ownerText ? budgetWord(opts.ownerText) : undefined);
    const budget = tokens || input.budget?.costUsd ? { ...(tokens ? { tokens } : {}), ...(input.budget?.costUsd ? { costUsd: input.budget.costUsd } : {}) } : undefined;
    const now = Date.now();
    const row: RunRow = {
      id,
      name: resolved.name,
      description: resolved.meta.description,
      source,
      script: resolved.script,
      scriptSha: resolved.scriptSha,
      scriptPath: this.saveScript(id, resolved.script),
      meta,
      args: input.args,
      sessionId: session.id,
      hostSession,
      device,
      cwd,
      status: 'queued',
      phaseIndex: -1,
      phases: (resolved.meta.phases ?? []).map((p) => ({ title: p.title, ...(p.detail ? { detail: p.detail } : {}), ...(p.model ? { model: p.model } : {}) })),
      ...(budget ? { budget } : {}),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      agentCount: 0,
      background: !!input.background,
      unattended: !!opts.unattended,
      ...(trustedAllow(source, !!opts.toolUseId) ? {} : { scoped: true }),
      ...(opts.toolUseId ? { toolUseId: opts.toolUseId } : {}),
      ...(old ? { resumedFrom: old.id } : {}),
      autoResumes: 0,
      createdAt: now,
    };
    this.store.insertRun(row);
    const cache = old ? this.cacheOf(this.store.calls(old.id)) : undefined;
    this.engine.audit(session.id, 'workflow.start', `${resolved.name} (${id})${old ? ` resuming ${old.id}` : ''}`);
    const live = new LiveRun(this, row, cache ? { cache } : {});
    if (allowDropped.length) live.log(`meta.permissions.allow was not applied (${allowDropped.join(', ')}): a script an agent wrote or a repository brought cannot widen its own permissions; its agents ask as usual.`);
    this.launch(live);
    return runDto(row, []);
  }

  private cacheOf(calls: CallRow[], fromSeq?: number): Map<string, CallRow> {
    const m = new Map<string, CallRow>();
    for (const c of calls) {
      if (fromSeq !== undefined && c.seq >= fromSeq) continue;
      // a call the owner skipped stays skipped (one stopped for no progress runs again)
      if (c.kind === 'agent' && c.state === 'skipped' && c.error?.startsWith(SKIPPED_BY_OWNER)) {
        m.set(`${c.key}#${c.occurrence}`, c);
        continue;
      }
      if (!c.hasResult || (c.state !== 'done' && c.state !== 'cached')) continue;
      m.set(`${c.key}#${c.occurrence}`, c);
    }
    return m;
  }

  private launch(run: LiveRun): void {
    this.live.set(run.id, run);
    void run
      .execute()
      .catch((err) => {
        log.warn(`run ${run.id} crashed`, err);
        run.setStatus('failed', { error: (err as Error)?.message ?? String(err), finishedAt: Date.now() });
      })
      .finally(() => {
        this.live.delete(run.id);
        for (const [sid, st] of this.steps) if (st.runId === run.id) this.steps.delete(sid);
        if (!this.closed) this.deliver(this.store.getRun(run.id) ?? run.row);
      });
  }

  /**
   * The Workflow tool: check the script, ask for approval when needed, start
   * the run, and wait for it unless it runs in the background.
   *
   * Approval: it asks unless a permission rule allows Workflow, the session
   * is in bypass mode, or the session is in Ultra, the estimate is under
   * workflows.autoApproveTokens and the owner already approved one run in
   * this session (or gave a +Nk budget). Bypass skips only the card: the
   * run's budget, its agent and host call caps and the hub's concurrency
   * limits hold as in any other mode, and a deny or ask rule on Workflow is
   * judged by the runner before the tool runs.
   */
  async runFromTool(
    input: StartWorkflowInput & { sessionId: string },
    ctx: { toolUseId: string; signal: AbortSignal; estimate?: { agents?: number; tokens?: number } },
  ): Promise<{ text: string; runId?: string; scriptPath?: string; isError?: boolean }> {
    const session = this.engine.requireSession(input.sessionId);
    const ownerText = lastOwnerText(this.engine, session.id);
    const old = input.resumeFromRunId ? this.store.getRun(input.resumeFromRunId) : undefined;
    let resolved: ResolvedScript;
    try {
      resolved = !input.name && !input.script && !input.scriptPath && old ? await this.resolveScript({ script: old.script }, session) : await this.resolveScript(input, session);
    } catch (err) {
      // a script the model wrote: show one that loads (load errors arrive here as EngineError, see resolveScript)
      const example = input.script || input.scriptPath ? `\n\nA minimal script that works:\n${MINIMAL_WORKFLOW_EXAMPLE}` : '';
      return { text: `The workflow did not load: ${(err as Error).message}${example}`, isError: true };
    }
    const cfg = this.engine.config.get().workflows ?? {};
    const threshold = cfg.autoApproveTokens ?? DEFAULTS.autoApproveTokens;
    const tokens = ctx.estimate?.tokens;
    const agents = ctx.estimate?.agents;
    const ruleAllows = this.engine.permissionRulesFor(session).allow.some((r) => r.trim() === 'Workflow' || r.trim() === 'Workflow(*)');
    const budgetGiven = !!(ownerText && budgetWord(ownerText));
    // Ultra skips the card only for an estimate under the threshold: a call with no estimate asks
    const estimated = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0;
    const ultraOk = !!session.ultra && estimated && tokens < threshold && (session.meta?.ultraApproved === true || budgetGiven);
    // bypass mode runs every other call without asking (session/permissions.ts), so a run starts without the card too;
    // an untrusted session never has the tool, and would ask here if it did
    const bypass = session.permissionMode === 'bypass' && !this.engine.isUntrusted(session);
    if (!ruleAllows && !ultraOk && !bypass) {
      const phases = (resolved.meta.phases ?? []).map((p) => p.title).join(', ');
      const est = tokens || agents ? ` Estimate: ${agents ? count(agents, 'agent') : ''}${agents && tokens ? ', ' : ''}${tokens ? `${Math.round(tokens / 1000)}k tokens` : ''}.` : '';
      const big = (agents ?? 0) > 25 || (tokens ?? 0) > 1_500_000 ? ' This is a large run.' : '';
      const res = await this.engine.requestApproval(
        session.id,
        {
          toolUseId: ctx.toolUseId,
          tool: 'Workflow',
          input: { name: resolved.name, description: resolved.meta.description, phases: resolved.meta.phases ?? [], ...(ctx.estimate ? { estimate: ctx.estimate } : {}) },
          summary: `Run workflow ${resolved.name}${(resolved.source === 'project' || resolved.source === 'claude-code') && resolved.path ? ` (from ${resolved.path})` : ''}: ${cardText(resolved.meta.description)}${phases ? ` Phases: ${phases}.` : ''}${est}${big}`,
          suggestedRule: 'Workflow',
        },
        ctx.signal,
      );
      if (res.decision !== 'allow') return { text: `The owner did not approve the workflow ${resolved.name}${res.decision === 'deny' && res.message && res.message !== 'aborted' ? `: ${res.message}` : ''}.`, isError: true };
      if (session.ultra) this.engine.patchMeta(session.id, { ultraApproved: true });
    }
    const run = await this.startRun({ ...input, script: resolved.script, name: undefined, scriptPath: undefined }, { toolUseId: ctx.toolUseId, source: resolved.source, ...(ownerText ? { ownerText } : {}) });
    if (bypass && !ruleAllows && !ultraOk) this.live.get(run.id)?.log('Started without an approval card: the session is in bypass mode.');
    if (input.background) {
      return {
        text: `Workflow ${resolved.name} started in the background (run ${run.id}; script saved at ${run.scriptPath ?? 'n/a'}). Its result arrives later in a <workflow_result> block, so you need not wait for it. To check progress before then (phases, agents, errors, the last log lines), call WorkflowStatus with runId ${run.id}; do not call it in a loop.`,
        runId: run.id,
        ...(run.scriptPath ? { scriptPath: run.scriptPath } : {}),
      };
    }
    const onAbort = () => this.live.get(run.id)?.stop('stopped');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const done = await this.wait(run.id, ctx.signal);
      return { text: this.resultText(done), runId: run.id, ...(done.scriptPath ? { scriptPath: done.scriptPath } : {}), ...(done.status === 'failed' ? { isError: true } : {}) };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Wait for a run to end. */
  async wait(runId: string, signal?: AbortSignal): Promise<RunRow> {
    const run = this.live.get(runId);
    if (run) {
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        signal?.addEventListener('abort', onAbort, { once: true });
        void run.done.then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
    const row = this.store.getRun(runId);
    if (!row) throw new EngineError(404, `run ${runId} not found`);
    return row;
  }

  /** The text a run's result reads as, cut for the main agent's context. */
  resultText(row: RunRow, max = DEFAULTS.resultChars): string {
    const calls = this.store.calls(row.id).filter((c) => c.kind === 'agent');
    const n = (s: CallRow['state']) => calls.filter((c) => c.state === s).length;
    const head = `Workflow ${row.name} ${row.status}. Run ${row.id}${row.scriptPath ? `; script saved at ${row.scriptPath}` : ''}.`;
    const counts = `${count(calls.length, 'agent')} (${n('done')} done, ${n('cached')} cached, ${n('failed')} failed, ${n('skipped')} skipped), ${row.inputTokens + row.outputTokens} tokens, $${row.costUsd.toFixed(2)}.`;
    const body = row.result === undefined || row.result === null ? (row.error ? `Error: ${row.error}` : '(no result)') : typeof row.result === 'string' ? row.result : JSON.stringify(row.result, null, 2);
    const cut = truncateMiddle(body, max, 'omitted');
    return `${head} ${counts}\n\n${cut.text}${cut.truncated ? `\n\n[The result was ${body.length} chars and was cut; the full result is in run ${row.id}.]` : ''}`;
  }

  /** A background run's result reaches its session; a run the app started posts it in its own session. */
  private deliver(row: RunRow): void {
    if (!row.sessionId || !['done', 'failed', 'stopped', 'budget'].includes(row.status)) return;
    const session = this.engine.getSession(row.sessionId);
    if (!session || session.archived) return;
    const text = this.resultText(row);
    if (row.hostSession) {
      this.engine.addMessage(row.sessionId, { role: 'assistant', kind: 'aside', author: `Workflow ${row.name}`, content: [{ type: 'text', text }], meta: { workflowRunId: row.id } });
    } else if (row.background) {
      const result: AgentResultRef = { type: 'workflow', id: row.id, label: row.name, state: row.status === 'done' ? 'completed' : row.status === 'stopped' ? 'stopped' : 'failed' };
      this.engine.runnerFor(row.sessionId).deliver({ block: workflowResultBlock(row, text), source: row.id, wake: !session.meta?.subagent, result });
      // the line the apps draw as the run's row ("Message from workflow ..."), its report from the message that carries it;
      // stored as a notice message only, since notifyEvent below already tells the owner's devices
      const words = row.status === 'done' ? 'finished' : row.status === 'stopped' ? 'stopped' : row.status === 'budget' ? 'stopped at its budget' : 'failed';
      this.engine.addMessage(row.sessionId, { role: 'assistant', kind: 'notice', content: [{ type: 'text', text: `Workflow ${words}: ${row.name}` }], meta: { level: row.status === 'done' ? 'info' : 'warning', kind: 'agent-result', agentResult: result } });
    }
    const level = row.status === 'done' ? 'success' : row.status === 'stopped' ? 'info' : 'warning';
    this.engine.notifyEvent(row.status === 'done' ? 'sessionDone' : 'errors', { title: `Workflow ${row.name}`, body: `${row.status === 'done' ? 'Finished' : row.status === 'budget' ? 'Stopped at its budget' : row.status === 'stopped' ? 'Stopped' : 'Failed'}: ${oneLine(row.error ?? (typeof row.result === 'string' ? row.result : ''), 120)}`, level, sessionId: row.sessionId, link: `/workflows/runs/${row.id}` });
  }

  /** The account of a run: its host session's (a run always has one). */
  runAccount(r: Pick<RunRow, 'sessionId'>): string {
    return (r.sessionId ? this.engine.sessionAccount(r.sessionId) : undefined) ?? OWNER_ID;
  }

  /** One account's runs (the caller's when left out). */
  runs(q: WorkflowRunsQuery & { accountId?: string } = {}): WorkflowRun[] {
    return this.store.listRuns({ ...q, accountId: q.accountId ?? currentAccount() ?? OWNER_ID }).map((r) => {
      const live = this.live.get(r.id);
      return live ? runDto(live.row, [...live.calls.values()]) : runDto(r, this.store.calls(r.id));
    });
  }

  run(id: string): WorkflowRunDetail {
    const live = this.live.get(id);
    const row = live?.row ?? this.store.getRun(id);
    if (!row) throw new EngineError(404, `run ${id} not found`);
    const calls = live ? [...live.calls.values()].sort((a, b) => a.seq - b.seq) : this.store.calls(id);
    const votes = live?.votes;
    return {
      run: runDto(row, calls),
      ...(row.meta ? { meta: row.meta } : {}),
      calls: calls.map((c) => this.callView(c)),
      logs: this.store.logs(id),
      ...(row.result !== undefined ? { result: row.result } : {}),
      findings: this.store.findings(id),
      ...(votes && votes.panels ? { refutedRate: votes.refuted / votes.panels } : {}),
    };
  }

  /**
   * The WorkflowStatus tool: a run as it stands. Without runId, the newest
   * run the session started. A run of another account reads as not found
   * (undefined), as does an unknown id.
   */
  status(q: { runId?: string; sessionId: string; accountId: string; logLines?: number }): WorkflowStatusView | undefined {
    const id = q.runId?.trim() || this.store.listRuns({ sessionId: q.sessionId, limit: 1 })[0]?.id;
    if (!id) return undefined;
    const live = this.live.get(id);
    const stored = live ? undefined : this.store.getRun(id);
    const owner = live?.row ?? stored;
    if (!owner || this.runAccount(owner) !== q.accountId) return undefined;
    // running calls' tokens come from their child sessions
    live?.refreshTotals();
    const row = live?.row ?? stored!;
    const calls = live ? [...live.calls.values()].sort((a, b) => a.seq - b.seq) : this.store.calls(id);
    const now = Date.now();
    const span = (start?: number, end?: number) => (start ? Math.max(0, (end ?? now) - start) : undefined);
    const agentView = (c: CallRow): WorkflowStatusAgent => {
      const view = this.callView(c);
      const elapsedMs = c.state === 'queued' ? undefined : span(c.startedAt, CALL_ENDED.has(c.state) ? (c.finishedAt ?? c.startedAt) : undefined);
      return {
        seq: c.seq,
        label: c.label ?? `call ${c.seq}`,
        state: c.state,
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        ...(c.state === 'running' && c.lastTool ? { lastTool: c.lastTool } : {}),
        ...(view.waiting ? { waiting: view.waiting } : {}),
        ...(c.error ? { error: c.error } : {}),
      };
    };
    const ended = RUN_ENDED.has(row.status);
    const listed = row.phases.map((p) => p.title);
    const phases: WorkflowStatusView['phases'] = listed.map((title, i) => ({ title, state: i < row.phaseIndex ? 'done' : i === row.phaseIndex ? 'current' : 'pending', agents: [] }));
    const byTitle = new Map(phases.map((p) => [p.title, p]));
    const NONE = '(no phase)';
    for (const c of calls) {
      if (c.kind !== 'agent') continue;
      const title = c.phase ?? NONE;
      let group = byTitle.get(title);
      if (!group) {
        // a phase a call named that the meta did not list, or agents outside every phase
        group = { title, state: 'pending', agents: [] };
        byTitle.set(title, group);
        phases.push(group);
      }
      group.agents.push(agentView(c));
    }
    for (const g of phases.slice(listed.length)) g.state = !ended && g.agents.some((a) => !CALL_ENDED.has(a.state)) ? 'current' : 'done';
    const errors: WorkflowStatusView['errors'] = [];
    if (row.error) errors.push({ error: row.error });
    for (const c of calls) {
      if ((c.state === 'failed' || c.state === 'skipped') && c.error) errors.push({ seq: c.seq, label: c.label ?? c.kind, error: c.error });
    }
    const dto = runDto(row, calls);
    const started = row.startedAt ?? row.createdAt;
    return {
      runId: row.id,
      name: row.name,
      status: row.status,
      live: !!live,
      background: row.background,
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      phaseIndex: row.phaseIndex,
      phases,
      counts: dto.counts,
      tokens: { input: row.inputTokens, output: row.outputTokens },
      costUsd: row.costUsd,
      ...(dto.budget ? { budget: dto.budget } : {}),
      // the run's own error and the newest call errors when there are many
      errors: errors.length > STATUS_ERRORS ? [...(row.error ? [errors[0]] : []), ...errors.slice(-(STATUS_ERRORS - (row.error ? 1 : 0)))] : errors,
      errorCount: errors.length,
      logs: this.store.lastLogs(row.id, Math.min(50, Math.max(0, q.logLines ?? 10))),
      createdAt: row.createdAt,
      ...(row.startedAt ? { startedAt: row.startedAt } : {}),
      ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
      ...(row.status === 'queued' || (ended && !row.finishedAt) ? {} : { elapsedMs: span(started, ended ? row.finishedAt : undefined) }),
      ...(row.resumeAt ? { resumeAt: row.resumeAt } : {}),
    };
  }

  /** A call as the run view shows it: waiting when its agent waits on an approval. */
  private callView(c: CallRow): WorkflowCall {
    const dto = callDto(c);
    if (c.state === 'running' && c.childSessionId && this.engine.getSession(c.childSessionId)?.status === 'waiting_approval') dto.waiting = 'approval';
    return dto;
  }

  private requireRun(id: string): RunRow {
    const r = this.live.get(id)?.row ?? this.store.getRun(id);
    if (!r) throw new EngineError(404, `run ${id} not found`);
    return r;
  }

  pause(id: string): WorkflowRun {
    const live = this.live.get(id);
    if (!live) throw new EngineError(409, `run ${id} is not running`);
    live.pause();
    return runDto(live.row, [...live.calls.values()]);
  }

  /**
   * Resume from one paused agent's session: a paused run resumes whole, else
   * that call goes on. A run that is not live (a restart) resumes from its
   * journal when it was paused; the old agent is let go either way.
   */
  async resumeAgent(runId: string, sessionId: string): Promise<boolean> {
    const live = this.live.get(runId);
    if (live) {
      if (live.isPaused) {
        await this.resume(runId);
        return true;
      }
      const seq = (this.engine.getSession(sessionId)?.meta?.workflow as { seq?: number } | undefined)?.seq;
      return typeof seq === 'number' && live.resumeCall(seq);
    }
    this.engine.runnerFor(sessionId).unpause();
    if (this.store.getRun(runId)?.status === 'paused') await this.resume(runId);
    return true;
  }

  /** Resume: a paused run goes on; an ended run runs again with its journal. */
  async resume(id: string, opts: { auto?: boolean; fromSeq?: number } = {}): Promise<WorkflowRun> {
    const live = this.live.get(id);
    if (live) {
      if (opts.fromSeq !== undefined) throw new EngineError(409, 'stop the run before you rerun it');
      live.resume();
      live.wakeParked();
      return runDto(live.row, [...live.calls.values()]);
    }
    const row = this.store.getRun(id);
    if (!row) throw new EngineError(404, `run ${id} not found`);
    const calls = this.store.calls(id);
    // agents paused when the hub stopped are let go: their calls run again
    for (const c of calls) if (c.childSessionId && this.engine.getSession(c.childSessionId)?.status === 'paused') this.engine.runnerFor(c.childSessionId).unpause();
    const cache = this.cacheOf(calls, opts.fromSeq);
    // what this run spent so far stays spent: a restart or a resume never starts the budget over.
    // The owner resuming a run that stopped at its budget gives it one more budget's worth.
    const pastBudget = !opts.auto && row.status === 'budget';
    const liveCalls = calls.filter((c) => c.state !== 'cached');
    const priorTokens = pastBudget ? 0 : (row.budget?.priorTokens ?? 0) + liveCalls.reduce((n, c) => n + c.outputTokens, 0);
    const priorCostUsd = pastBudget ? 0 : (row.budget?.priorCostUsd ?? 0) + liveCalls.reduce((n, c) => n + c.costUsd, 0);
    const { priorTokens: _pt, priorCostUsd: _pc, ...limits } = row.budget ?? {};
    const budget = { ...limits, ...(priorTokens ? { priorTokens } : {}), ...(priorCostUsd ? { priorCostUsd: Math.round(priorCostUsd * 1e6) / 1e6 } : {}) };
    this.store.deleteCalls(id);
    const next: RunRow = {
      ...row,
      budget: Object.keys(budget).length ? budget : undefined,
      status: 'queued',
      phaseIndex: -1,
      phases: (row.meta?.phases ?? []).map((p) => ({ title: p.title, ...(p.detail ? { detail: p.detail } : {}), ...(p.model ? { model: p.model } : {}) })),
      result: undefined,
      error: undefined,
      finishedAt: undefined,
      resumeAt: undefined,
      autoResumes: row.autoResumes + (opts.auto ? 1 : 0),
      // a resumed run's result reaches its session as a reminder (the Workflow tool call that waited is gone)
      background: row.background || opts.auto === true,
    };
    this.store.updateRun(next);
    const run = new LiveRun(this, next, { cache });
    const answers = `${cache.size} ${cache.size === 1 ? 'answer' : 'answers'}`;
    run.log(opts.fromSeq !== undefined ? `Rerun from call ${opts.fromSeq}: ${answers} replay from the journal.` : `Resumed${opts.auto ? ' after a restart' : ''}: ${answers} in the journal.`);
    if (pastBudget) run.log('Resumed past its budget: the budget counts again from here.');
    else if (priorTokens && row.budget?.tokens) run.log(`The budget counts the ${priorTokens} output tokens earlier attempts spent.`);
    if (next.sessionId) this.engine.audit(next.sessionId, 'workflow.resume', `${next.name} (${id})${opts.fromSeq !== undefined ? ` from call ${opts.fromSeq}` : ''}`);
    this.launch(run);
    return runDto(next, []);
  }

  stop(id: string): WorkflowRun {
    const live = this.live.get(id);
    if (live) {
      live.stop('stopped');
      if (live.row.sessionId) this.engine.audit(live.row.sessionId, 'workflow.stop', `${live.row.name} (${id})`);
      return runDto(live.row, [...live.calls.values()]);
    }
    const row = this.requireRun(id);
    if (row.status === 'interrupted' || row.status === 'waiting_reset' || row.status === 'paused' || row.status === 'queued') {
      const next = { ...row, status: 'stopped' as const, finishedAt: Date.now() };
      this.store.updateRun(next);
      this.engine.bus.emit({ type: 'workflow.run', run: runDto(next, this.store.calls(id)) });
      return runDto(next, this.store.calls(id));
    }
    return runDto(row, this.store.calls(id));
  }

  rerun(id: string, fromSeq: number): Promise<WorkflowRun> {
    if (!Number.isInteger(fromSeq) || fromSeq < 1) throw new EngineError(400, 'fromSeq must be a call number');
    return this.resume(id, { fromSeq });
  }

  skip(id: string, seq: number): WorkflowRun {
    const live = this.live.get(id);
    if (!live) throw new EngineError(409, `run ${id} is not running`);
    if (!live.skip(seq)) throw new EngineError(409, `call ${seq} is not waiting or running`);
    live.log(`Skipped call ${seq} (${live.calls.get(seq)?.label ?? ''}); it returns null.`);
    return runDto(live.row, [...live.calls.values()]);
  }

  /** The owner's Diff, Merge, Cherry-pick and Discard on a call's kept branch. */
  async worktree(id: string, seq: number, action: WorktreeAction): Promise<WorktreeActionResult> {
    const row = this.requireRun(id);
    const call = this.live.get(id)?.calls.get(seq) ?? this.store.getCall(id, seq);
    if (!call?.worktreeBranch || !call.worktreeCommit || !call.worktreeBase) throw new EngineError(409, `call ${seq} kept no worktree branch`);
    if (call.worktreeState !== 'kept' && action !== 'diff') throw new EngineError(409, `the branch is ${call.worktreeState ?? 'gone'}`);
    const machine = this.engine.devices.get(row.device);
    if (!machine) throw new EngineError(409, `device ${row.device} is not connected`);
    const repo = await repoInfo(machine, row.cwd);
    if (!repo) throw new EngineError(409, `${row.cwd} is not a git repository`);
    const res = await runWorktreeAction(machine, { root: repo.root, branch: call.worktreeBranch, base: call.worktreeBase, commit: call.worktreeCommit }, action);
    const state = res.state ?? call.worktreeState ?? 'kept';
    if (res.state && res.state !== call.worktreeState) {
      const next = { ...call, worktreeState: res.state };
      this.store.updateCall(next);
      this.live.get(id)?.calls.set(seq, next);
      this.engine.bus.emit({ type: 'workflow.agent', runId: id, call: callDto(next) });
    }
    if (row.sessionId && action !== 'diff') this.engine.audit(row.sessionId, `workflow.worktree.${action}`, `${call.worktreeBranch} (${res.ok ? 'ok' : 'failed'})`);
    return { ok: res.ok, state, output: res.output };
  }

  judgeFinding(runId: string, findingId: string, verdict: FindingVerdict, reason?: string): WorkflowFinding {
    const f = this.store.getFinding(findingId);
    if (!f || f.runId !== runId) throw new EngineError(404, `finding ${findingId} not found`);
    if (verdict === 'dismissed' && !reason?.trim()) throw new EngineError(400, 'a dismissal needs a reason');
    const at = Date.now();
    this.store.setVerdict(findingId, verdict, reason?.trim() || undefined, at);
    const row = this.store.getRun(runId);
    if (row?.sessionId) this.engine.audit(row.sessionId, 'workflow.finding', `${verdict} ${oneLine(f.title, 80)}${reason ? `: ${oneLine(reason, 80)}` : ''}`);
    return { ...f, verdict, ...(reason ? { reason } : {}), decidedAt: at };
  }

  // ----- usage limits -----

  /** A call hit a usage limit: the run waits for the reset, durably. */
  parkRun(run: LiveRun, until: number): void {
    run.setStatus('waiting_reset', { resumeAt: until });
    run.log(`Usage limit reached. Parked calls run again at ${new Date(until).toISOString()}.`);
    this.engine.scheduler.enqueue(RESUME_JOB, until + 1000, { runId: run.id }, `wf-resume:${run.id}`);
  }

  private async onResumeJob(runId: string): Promise<void> {
    if (!runId) return;
    const live = this.live.get(runId);
    if (live) {
      live.wakeParked();
      return;
    }
    const row = this.store.getRun(runId);
    if (row && (row.status === 'interrupted' || row.status === 'waiting_reset')) await this.resume(runId, { auto: true });
  }
}
