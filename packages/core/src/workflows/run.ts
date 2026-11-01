/**
 * One workflow run in memory: the sandbox, the journal, budgets, caps,
 * pause, stop and skip (docs/WORKFLOWS.md). The service (service.ts) makes
 * runs, keeps them in a map and restarts them after a crash; this file runs
 * one script to its end.
 *
 * Journal and resume. Each call's answer is stored under its key and
 * occurrence (store.ts callKey). A resumed run looks answers up by key only:
 * the same script and args replay every call, and the first edited or new
 * call, and everything that depends on its answer, runs live. Worktree calls
 * are the exception, because repository state is not in the key: once one
 * worktree call runs live, later ones run live too, and a kept branch is
 * checked before its answer is replayed.
 */
import { posix } from 'node:path';
import type { Engine } from '../engine/engine';
import type { Session } from '../types';
import type { Tool } from '../tools/types';
import type { WorkflowCallKind, WorkflowFinding, WorkflowRunStatus } from '../client/workflows';
import { checkPermission, dangerousCommand } from '../session/permissions';
import { BashTool } from '../tools/bash';
import { suggestBashRule } from '../tools/bash-rules';
import { newId } from '../util/ids';
import { oneLine } from '../util/text';
import { logger } from '../util/log';
import { failingTest } from '../util/test-run';
import { Sandbox, SandboxError } from './sandbox';
import { preludeSource } from './prelude';
import { callDto, callKey, runDto, sha256, type CallRow, type RunRow } from './store';
import { keyParts, readAgentSpec, runStep, type AgentSpec, type StepState } from './agents';
import { DEFAULTS, Semaphore, count } from './limits';
import { branchCommit, codeFingerprint, createWorktree, finishWorktree, repoInfo, shq, syncthingMarkerAbove, withDetached, worktreePath, type Worktree } from './worktrees';
import type { WorkflowService } from './service';
import { loadMeta } from './registry';
import { captureUrl, hubCapture, type CaptureOptions } from '../browser/capture';
import type { BrowserManager } from '../browser/manager';
import { outputsDir } from '../files/share';
import { ledgerFence, ledgerId, mergeLedger } from './ledger';

const log = logger('workflow-run');

export interface RunStartOptions {
  /** Answers from an earlier attempt, by key#occurrence. */
  cache?: Map<string, CallRow>;
}

/** Thrown when a per-run cap ends the run: a script that catches it and loops still stops. */
class RunCapError extends Error {}

/** The error a call the owner skipped keeps; a resumed run replays such a call as null (service.ts cacheOf). */
export const SKIPPED_BY_OWNER = 'skipped by the owner';

/** Nested workflow() calls that run at once in one run (each holds its own sandbox). */
const NESTED_AT_ONCE = 2;

/** lib.checkCitation reads at most this much of a file. */
const CITATION_MAX_BYTES = 5_000_000;

function shortError(err: unknown): string {
  return oneLine((err as Error)?.message ?? String(err), 600);
}

/** First line, cut, for previews and labels. */
function firstLine(s: string, n = 80): string {
  return oneLine(s.split('\n').find((l) => l.trim()) ?? s, n);
}

export class LiveRun {
  readonly controller = new AbortController();
  readonly calls = new Map<number, CallRow>();
  private cache: Map<string, CallRow>;
  private occurrences = new Map<string, number>();
  private seq = 0;
  private agentCount = 0;
  private logN = 0;
  private logCapped = false;
  private paused = false;
  private pauseWaiters: Array<() => void> = [];
  /** Calls whose agent the owner paused, by seq: each waits for Resume, then its cut turn goes on. */
  private pausedCalls = new Map<number, () => void>();
  private parkWaiters = new Map<number, () => void>();
  private callControllers = new Map<number, AbortController>();
  /** Calls skipped by the owner or stopped for no progress, with the text their row keeps. */
  private skipped = new Map<number, string>();
  private semaphore: Semaphore;
  private capsLogged = new Set<string>();
  /** Harness models a tier word picked that did not start (workflows/agents.ts falls back to the session model). */
  readonly failedHarnesses = new Set<string>();
  private worktreeLive = false;
  private budgetHit = false;
  private stopReason?: 'stopped' | 'interrupted';
  private ticker?: ReturnType<typeof setInterval>;
  /** Panel votes seen, for the refuted rate. */
  readonly votes = { panels: 0, refuted: 0 };
  private findingsRecorded = false;
  /** Host calls (timers, lib calls, agent calls) and checks this attempt made, and findings it kept. */
  private hostCalls = 0;
  private checks = 0;
  /** Finding keys recorded for this run, in any attempt (loaded on first use). */
  private findingKeys?: Set<string>;
  /** Set when a cap ended the run; the run fails with this text. */
  private capError?: string;
  done: Promise<void>;
  private resolveDone!: () => void;

  constructor(
    readonly svc: WorkflowService,
    public row: RunRow,
    opts: RunStartOptions = {},
  ) {
    this.cache = opts.cache ?? new Map();
    const cfg = svc.engine.config.get().workflows ?? {};
    this.semaphore = new Semaphore(Math.min(DEFAULTS.maxConcurrency, Math.max(1, cfg.concurrency ?? DEFAULTS.concurrency)));
    this.done = new Promise((r) => (this.resolveDone = r));
    this.logN = svc.store.logCount(row.id);
  }

  get engine(): Engine {
    return this.svc.engine;
  }

  get id(): string {
    return this.row.id;
  }

  private get maxAgents(): number {
    return this.engine.config.get().workflows?.maxAgents ?? DEFAULTS.maxAgents;
  }

  private cap(name: 'hostCalls' | 'checks' | 'findings' | 'phases'): number {
    return this.svc.caps[name] ?? DEFAULTS[name];
  }

  /**
   * A cap that ends the run: the call throws, and the run stops, so a script
   * that catches the error and loops cannot keep the hub busy.
   */
  private endAtCap(text: string): never {
    if (!this.capError) {
      this.capError = text;
      this.log(text);
      this.controller.abort();
    }
    throw new RunCapError(text);
  }

  /** Count one host call; past the cap the run ends. Agent calls count too, so a loop that catches the agent cap error ends as well. */
  private countHost(): void {
    this.hostCalls++;
    const max = this.cap('hostCalls') + this.maxAgents;
    if (this.hostCalls > max) this.endAtCap(`Workflow host call cap reached (${max} timer, lib and agent calls in this run)`);
  }

  private countCheck(): void {
    this.checks++;
    if (this.checks > this.cap('checks')) this.endAtCap(`Workflow check cap reached (${this.cap('checks')} lib.exec and lib.runCheck calls in this run)`);
  }

  // ----- status and events -----

  setStatus(status: WorkflowRunStatus, extra: Partial<RunRow> = {}): void {
    this.row = { ...this.row, status, ...extra };
    this.refreshTotals();
    this.svc.store.updateRun(this.row);
    this.emitRun();
  }

  emitRun(): void {
    this.engine.bus.emit({ type: 'workflow.run', run: runDto(this.row, [...this.calls.values()]) });
  }

  private emitCall(c: CallRow): void {
    this.engine.bus.emit({ type: 'workflow.agent', runId: this.id, call: callDto(c) });
  }

  private saveCall(c: CallRow): void {
    this.calls.set(c.seq, c);
    this.svc.store.updateCall(c);
    this.emitCall(c);
  }

  /** Totals from the calls: finished ones from their rows, running ones from their child session. */
  refreshTotals(): void {
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const c of this.calls.values()) {
      if (c.state === 'running' && c.childSessionId) {
        const s = this.engine.getSession(c.childSessionId);
        if (s) {
          c.inputTokens = s.stats.inputTokens;
          c.outputTokens = s.stats.outputTokens;
          c.costUsd = s.stats.costUsd;
        }
      }
      input += c.inputTokens;
      output += c.outputTokens;
      cost += c.costUsd;
    }
    this.row.inputTokens = input;
    this.row.outputTokens = output;
    this.row.costUsd = Math.round(cost * 1e6) / 1e6;
    this.row.agentCount = this.agentCount;
  }

  /**
   * Output tokens this run spent: this attempt's live calls (cached calls cost
   * nothing now) plus what earlier attempts of the same run spent, so a
   * restart or a resume never starts the budget over.
   */
  spentTokens(): number {
    this.refreshTotals();
    let out = this.row.budget?.priorTokens ?? 0;
    for (const c of this.calls.values()) if (c.state !== 'cached') out += c.outputTokens;
    return out;
  }

  spentCost(): number {
    let out = this.row.budget?.priorCostUsd ?? 0;
    for (const c of this.calls.values()) if (c.state !== 'cached') out += c.costUsd;
    return out;
  }

  /** True when the run's token or cost budget is used up. */
  overBudget(): boolean {
    const b = this.row.budget;
    if (!b) return false;
    if (b.tokens && this.spentTokens() >= b.tokens) return true;
    if (b.costUsd && this.spentCost() >= b.costUsd) return true;
    return false;
  }

  log(text: string): void {
    if (this.logCapped) return;
    const ts = Date.now();
    if (this.logN >= DEFAULTS.logLines) {
      this.logCapped = true;
      this.logN++;
      this.svc.store.addLog(this.id, this.logN, ts, 'log cap reached: later log lines were dropped');
      this.engine.bus.emit({ type: 'workflow.log', runId: this.id, ts, text: 'log cap reached: later log lines were dropped' });
      return;
    }
    this.logN++;
    const line = text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
    this.svc.store.addLog(this.id, this.logN, ts, line);
    this.engine.bus.emit({ type: 'workflow.log', runId: this.id, ts, text: line });
  }

  private logCap(kind: string, text: string): void {
    if (this.capsLogged.has(kind)) return;
    this.capsLogged.add(kind);
    this.log(text);
  }

  private setPhase(full: string): void {
    // cut first, as agent() cuts opts.phase, so a long title finds the phase it added before
    const title = full.slice(0, 200);
    let index = this.row.phases.findIndex((p) => p.title === title);
    if (index < 0) {
      // a script that makes up a new title each time would grow every run event without end
      if (this.row.phases.length >= this.cap('phases')) {
        this.logCap('phases', `phase cap: the run has ${this.row.phases.length} phases; later new titles are not added`);
        return;
      }
      this.row.phases = [...this.row.phases, { title }];
      index = this.row.phases.length - 1;
    }
    this.row.phaseIndex = index;
    this.svc.store.updateRun(this.row);
    this.engine.bus.emit({ type: 'workflow.phase', runId: this.id, index, title });
    this.emitRun();
  }

  // ----- controls -----

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.row.status === 'running') this.setStatus('paused');
    // running agents stop after their current tool call; one created from now on pauses at its first step (register)
    for (const c of this.calls.values()) if (c.state === 'running' && c.childSessionId) this.pauseAgent(c.childSessionId);
    this.log('Paused: running agents stop after their current tool call, new ones wait.');
  }

  private pauseAgent(sessionId: string): void {
    try {
      this.engine.runnerFor(sessionId).pause();
    } catch (err) {
      this.log(`could not pause ${sessionId}: ${shortError(err)}`);
    }
  }

  /** Resume one paused agent (its session's Resume). False when that call is not paused. */
  resumeCall(seq: number): boolean {
    const w = this.pausedCalls.get(seq);
    w?.();
    return !!w;
  }

  resume(): void {
    for (const w of [...this.pausedCalls.values()]) w();
    if (!this.paused) return;
    this.paused = false;
    for (const w of this.pauseWaiters.splice(0)) w();
    if (this.row.status === 'paused') this.setStatus('running');
    this.log('Resumed.');
  }

  stop(reason: 'stopped' | 'interrupted' = 'stopped'): void {
    if (this.controller.signal.aborted) return;
    this.stopReason = reason;
    this.controller.abort();
    for (const w of this.pauseWaiters.splice(0)) w();
    for (const w of this.parkWaiters.values()) w();
    for (const w of this.pausedCalls.values()) w();
  }

  skip(seq: number, reason: 'owner' | 'stall' = 'owner'): boolean {
    const c = this.calls.get(seq);
    if (!c || !['queued', 'running', 'parked'].includes(c.state)) return false;
    this.skipped.set(seq, reason === 'owner' ? SKIPPED_BY_OWNER : 'stopped after no progress (stallMs)');
    this.callControllers.get(seq)?.abort();
    this.parkWaiters.get(seq)?.();
    this.pausedCalls.get(seq)?.();
    return true;
  }

  /** Parked calls run again now (the usage limit reset job). */
  wakeParked(): void {
    for (const w of [...this.parkWaiters.values()]) w();
  }

  private async gate(signal: AbortSignal): Promise<void> {
    while (this.paused && !signal.aborted) await new Promise<void>((r) => this.pauseWaiters.push(r));
    if (signal.aborted) throw new Error('aborted');
  }

  // ----- journal -----

  private nextOccurrence(key: string): number {
    const n = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, n);
    return n;
  }

  private newCall(kind: WorkflowCallKind, key: string, extra: Partial<CallRow>): CallRow {
    const occurrence = this.nextOccurrence(key);
    const c: CallRow = {
      runId: this.id,
      seq: ++this.seq,
      key,
      occurrence,
      kind,
      state: 'queued',
      attempt: 0,
      hasResult: false,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      queuedAt: Date.now(),
      ...extra,
    };
    this.saveCall(c);
    return c;
  }

  private cached(c: CallRow): CallRow | undefined {
    const hit = this.cache.get(`${c.key}#${c.occurrence}`);
    if (hit?.state === 'skipped') return hit;
    return hit && hit.hasResult && (hit.state === 'done' || hit.state === 'cached') ? hit : undefined;
  }

  /**
   * A host call that is journaled (lib.exec, lib.runCheck, lib.ask,
   * lib.approve): replayed by key, else run and stored.
   */
  private async hostCall<T>(kind: WorkflowCallKind, label: string, parts: Record<string, unknown>, parentSeq: number | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = callKey({ host: kind, ...parts });
    const c = this.newCall(kind, key, { label, ...(parentSeq !== undefined ? { parentSeq } : {}), prompt: label });
    const hit = this.cached(c);
    if (hit) {
      this.saveCall({ ...c, state: 'cached', result: hit.result, hasResult: true, finishedAt: Date.now() });
      return hit.result as T;
    }
    this.saveCall({ ...c, state: 'running', startedAt: Date.now() });
    try {
      const value = await fn(this.controller.signal);
      this.saveCall({ ...this.calls.get(c.seq)!, state: 'done', result: value, hasResult: true, finishedAt: Date.now() });
      return value;
    } catch (err) {
      this.saveCall({ ...this.calls.get(c.seq)!, state: 'failed', error: shortError(err), finishedAt: Date.now() });
      throw err;
    }
  }

  // ----- agent() -----

  async agentCall(prompt: unknown, rawOpts: unknown, parentSeq?: number): Promise<unknown> {
    if (this.controller.signal.aborted) throw new Error('the run was stopped');
    const spec = readAgentSpec(prompt, rawOpts);
    if (this.agentCount >= this.maxAgents) throw new Error(`Workflow agent() call cap reached (${this.maxAgents} agents in this run)`);
    // a relative or ~ folder is the run's, on its device
    if (spec.conclave?.cwd) spec.conclave.cwd = posix.normalize(this.machineFor(spec).resolve(spec.conclave.cwd, this.row.cwd));
    if (this.row.scoped && spec.conclave) await this.scopeOf(spec.conclave);
    if (this.overBudget()) {
      this.budgetHit = true;
      throw new Error(`Workflow budget reached: ${this.spentTokens()} output tokens spent of ${this.row.budget?.tokens ?? 'no token limit'}${this.row.budget?.costUsd ? `, $${this.spentCost().toFixed(2)} of $${this.row.budget.costUsd}` : ''}`);
    }
    this.agentCount++;
    const key = callKey(keyParts(spec));
    const c = this.newCall('agent', key, {
      label: spec.label ?? firstLine(spec.prompt, 60),
      ...(spec.phase ? { phase: spec.phase } : {}),
      ...(spec.agentType ? { agentType: spec.agentType } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(parentSeq !== undefined ? { parentSeq } : {}),
      prompt: spec.prompt.slice(0, 4000),
    });

    // a script that only labels its agents with opts.phase (scan.js) still moves the run's phase forward
    if (spec.phase) {
      const i = this.row.phases.findIndex((p) => p.title === spec.phase);
      if (i > this.row.phaseIndex) this.setPhase(spec.phase);
    }
    const hit = this.cached(c);
    if (hit?.state === 'skipped') {
      // the owner skipped this call in an earlier attempt: it stays null, it does not run again
      this.saveCall({ ...c, state: 'skipped', error: 'skipped by the owner in an earlier attempt', finishedAt: Date.now() });
      return this.withMeta(spec, c.seq, null);
    }
    if (hit && (await this.replayable(spec, hit))) {
      this.saveCall({
        ...c,
        state: 'cached',
        result: hit.result,
        hasResult: true,
        childSessionId: hit.childSessionId,
        model: hit.model ?? c.model,
        inputTokens: hit.inputTokens,
        outputTokens: hit.outputTokens,
        costUsd: hit.costUsd,
        lastTool: hit.lastTool,
        ...(hit.worktreeBranch
          ? { worktreeBranch: hit.worktreeBranch, worktreeBase: hit.worktreeBase, worktreeCommit: hit.worktreeCommit, worktreeState: hit.worktreeState, worktreeFiles: hit.worktreeFiles, worktreePath: hit.worktreePath }
          : {}),
        finishedAt: Date.now(),
      });
      return this.withMeta(spec, c.seq, hit.result);
    }
    if (spec.isolation) this.worktreeLive = true;
    return this.withMeta(spec, c.seq, await this.runLive(c, spec));
  }

  /**
   * A scoped run (an agent wrote the script, or a repository brought it) keeps
   * its agents where the owner started it: on the run's device, and in its
   * repository or one of this run's own worktrees and checkouts. An agent
   * inherits the session's permission mode, and acceptEdits allows edits in
   * the agent's own folder, so a script that picked ~/.ssh or another device
   * would widen what runs without asking. Throws with the reason.
   */
  private async scopeOf(c: NonNullable<AgentSpec['conclave']>): Promise<void> {
    if (c.device && c.device !== this.row.device) {
      const here = this.machineFor().name || this.row.device;
      throw new Error(`this workflow came from an agent or a repository, so its agents run on ${here}; conclave.device ${c.device} is not allowed`);
    }
    if (!c.cwd) return;
    const machine = this.machineFor();
    const home = (await this.engine.machineHome(machine)) ?? '/';
    const want = c.cwd;
    const repo = await repoInfo(machine, this.row.cwd).catch(() => undefined);
    const roots = [repo?.root ?? this.row.cwd, ...this.views.values()];
    for (const call of this.calls.values()) if (call.worktreePath) roots.push(call.worktreePath);
    const inside = (root: string) => want === root || want.startsWith(root.endsWith('/') ? root : `${root}/`);
    if (roots.some(inside)) return;
    const shown = want.startsWith(`${home}/`) ? `~/${want.slice(home.length + 1)}` : want;
    throw new Error(`this workflow came from an agent or a repository, so its agents work in ${repo?.root ?? this.row.cwd} or this run's worktrees; conclave.cwd ${shown} is outside them`);
  }

  /** opts.conclave.withMeta: the answer plus the call's seq, worktree, tokens and time, for scripts that check a worktree later. */
  private withMeta(spec: AgentSpec, seq: number, value: unknown): unknown {
    if (!spec.conclave?.withMeta) return value;
    const c = this.calls.get(seq);
    return {
      value,
      seq,
      state: c?.state,
      model: c?.model,
      inputTokens: c?.inputTokens ?? 0,
      outputTokens: c?.outputTokens ?? 0,
      costUsd: c?.costUsd ?? 0,
      durationMs: c?.startedAt && c?.finishedAt ? c.finishedAt - c.startedAt : 0,
      ...(c?.worktreeBranch ? { worktree: { branch: c.worktreeBranch, base: c.worktreeBase, commit: c.worktreeCommit, state: c.worktreeState, files: c.worktreeFiles ?? 0 } } : {}),
    };
  }

  /** Detached checkouts of kept commits that agents read (lib.checkout), removed when the run ends. */
  private views = new Map<number, string>();

  private async checkout(seq: number): Promise<string> {
    const have = this.views.get(seq);
    if (have) return have;
    const call = this.calls.get(seq);
    if (!call?.worktreeCommit) throw new Error(`call ${seq} kept no worktree commit to check out`);
    const machine = this.machineFor();
    const repo = await repoInfo(machine, this.row.cwd);
    if (!repo) throw new Error(`${this.row.cwd} is not a git repository`);
    const home = (await this.engine.machineHome(machine)) ?? '/tmp';
    const path = posix.join(posix.dirname(worktreePath(home, repo.root, this.id, seq)), `${this.id}-view-${seq}`);
    if (await syncthingMarkerAbove(machine, posix.dirname(path))) throw new Error('refusing to check out under a Syncthing folder');
    await machine.exec(`git worktree remove --force ${shq(path)} 2>/dev/null; git worktree add --detach ${shq(path)} ${shq(call.worktreeCommit)}`, { cwd: repo.root, timeoutMs: 120_000 });
    if (!(await machine.stat(path))) throw new Error(`could not check out ${call.worktreeCommit}`);
    this.views.set(seq, path);
    const rel = posix.relative(repo.root, this.row.cwd);
    return rel && !rel.startsWith('..') ? posix.join(path, rel) : path;
  }

  private async diffOf(seq: number): Promise<string> {
    const call = this.calls.get(seq);
    if (!call?.worktreeCommit || !call.worktreeBase) return '';
    const machine = this.machineFor();
    const repo = await repoInfo(machine, this.row.cwd);
    if (!repo) return '';
    const r = await machine.exec(`git diff ${shq(call.worktreeBase)} ${shq(call.worktreeCommit)}`, { cwd: repo.root, timeoutMs: 60_000, maxOutputBytes: 400_000 });
    return r.stdout.length > 200_000 ? `${r.stdout.slice(0, 200_000)}\n[diff cut at 200,000 chars]` : r.stdout;
  }

  private async removeViews(): Promise<void> {
    if (!this.views.size) return;
    const machine = this.machineFor();
    const repo = await repoInfo(machine, this.row.cwd).catch(() => undefined);
    for (const path of this.views.values()) {
      await machine.exec(`git worktree remove --force ${shq(path)}`, { cwd: repo?.root ?? this.row.cwd, timeoutMs: 60_000 }).catch(() => undefined);
    }
    this.views.clear();
  }

  /** A cached worktree answer replays only while its branch still points at its commit. */
  private async replayable(spec: AgentSpec, hit: CallRow): Promise<boolean> {
    if (!spec.isolation) return true;
    if (this.worktreeLive) return false;
    if (hit.worktreeState !== 'kept' || !hit.worktreeBranch || !hit.worktreeCommit) return hit.worktreeState === 'removed';
    const repo = await repoInfo(this.machineFor(spec), this.cwdFor(spec)).catch(() => undefined);
    const now = repo ? await branchCommit(this.machineFor(spec), repo.root, hit.worktreeBranch) : undefined;
    if (now === hit.worktreeCommit) return true;
    this.log(`worktree branch ${hit.worktreeBranch} is gone or moved; ${hit.label ?? 'the call'} runs again`);
    return false;
  }

  private machineFor(spec?: AgentSpec) {
    const device = spec?.conclave?.device ?? this.row.device;
    return this.engine.machineFor({ device } as Session);
  }

  private cwdFor(spec?: AgentSpec): string {
    return spec?.conclave?.cwd ?? this.row.cwd;
  }

  private async runLive(c: CallRow, spec: AgentSpec): Promise<unknown> {
    const callController = new AbortController();
    this.callControllers.set(c.seq, callController);
    const onRunAbort = () => callController.abort();
    this.controller.signal.addEventListener('abort', onRunAbort, { once: true });
    const releases: Array<() => void> = [];
    let worktree: Worktree | undefined;
    let wtRelease: (() => void) | undefined;
    try {
      await this.gate(callController.signal);
      // caps: per run, across the hub, per provider; each logs once when it makes a call wait
      if (this.semaphore.full) this.logCap('run', `concurrency cap: ${this.semaphore.inUse} calls in flight, more wait (workflows.concurrency)`);
      releases.push(await this.semaphore.acquire(callController.signal));
      const hub = this.svc.hubSemaphore;
      if (hub.full) this.logCap('hub', 'hub cap: 16 workflow calls in flight across the hub, more wait (workflows.hubMax)');
      releases.push(await hub.acquire(callController.signal));
      const provider = this.providerOf(spec);
      const ps = this.svc.providerSemaphores.get(provider);
      if (ps.full) this.logCap(`provider:${provider}`, `provider cap: ${provider} has the most calls in flight it may have, more wait (workflows.perProvider)`);
      releases.push(await ps.acquire(callController.signal));
      await this.gate(callController.signal);

      let device = spec.conclave?.device ?? this.row.device;
      let cwd = spec.conclave?.cwd ?? this.row.cwd;
      if (spec.isolation) {
        const machine = this.machineFor(spec);
        const repo = await repoInfo(machine, cwd);
        if (!repo) throw new Error(`isolation: 'worktree' needs a git repository; ${cwd} on ${device} is not one`);
        const home = (await this.engine.machineHome(machine)) ?? '/tmp';
        const ds = this.svc.worktreeSemaphores.get(machine.id);
        if (ds.full) this.logCap(`wt:${machine.id}`, `worktree cap: ${DEFAULTS.worktreesPerDevice} live worktrees on ${machine.name}, more wait`);
        wtRelease = await ds.acquire(callController.signal);
        let base = repo.head;
        const from = spec.conclave?.worktreeFrom;
        if (from !== undefined) {
          const prev = this.calls.get(from);
          if (prev?.worktreeCommit) base = prev.worktreeCommit;
          else this.log(`worktreeFrom ${from}: that call kept no commit; starting from HEAD`);
        }
        worktree = await createWorktree(machine, { home, root: repo.root, base, runId: this.id, seq: c.seq });
        const rel = posix.relative(repo.root, cwd);
        cwd = rel && !rel.startsWith('..') ? posix.join(worktree.path, rel) : worktree.path;
        this.saveCall({ ...this.calls.get(c.seq)!, worktreePath: worktree.path, worktreeBranch: worktree.branch, worktreeBase: base, worktreeState: 'live' });
        const fromScript = spec.conclave?.worktreeSetup;
        const setup = fromScript ?? (await this.svc.worktreeSetup(machine, repo.root));
        if (setup) {
          // the command is a shell command like lib.exec: one from an agent's script, or from the settings of a
          // folder the owner has not trusted, goes through the same permission check before it runs
          const ownerSet = fromScript ? !this.row.scoped : this.engine.trust.isTrusted(repo.root) || this.engine.trust.isTrusted(this.row.cwd);
          if (!ownerSet) await this.permitExec(setup, worktree.path, callController.signal, 'worktree setup');
          const r = await machine.exec(setup, { cwd: worktree.path, timeoutMs: 15 * 60_000, signal: callController.signal, maxOutputBytes: 200_000 });
          if (r.exitCode !== 0) this.log(`worktree setup "${oneLine(setup, 80)}" exited ${r.exitCode}: ${oneLine(r.stderr || r.stdout, 200)}`);
        }
        device = machine.id;
      }

      const parentSessionId = this.row.sessionId!;
      const phaseModel = this.row.phases.find((p) => p.title === spec.phase)?.model;
      let continueChild: string | undefined;
      let resumeOnly = false;
      for (let attempt = 1; ; attempt++) {
        this.saveCall({ ...this.calls.get(c.seq)!, state: 'running', attempt, startedAt: this.calls.get(c.seq)!.startedAt ?? Date.now() });
        const out = await runStep({
          engine: this.engine,
          parentSessionId,
          spec,
          runId: this.id,
          seq: c.seq,
          workflowName: this.row.name,
          device,
          cwd,
          ...(phaseModel ? { phaseModel } : {}),
          signal: callController.signal,
          register: (sid: string, st: StepState) => {
            this.svc.steps.set(sid, st);
            // made while the run is paused: it stops at its first step
            if (this.paused && sid !== continueChild) this.pauseAgent(sid);
            const cur = this.calls.get(c.seq);
            if (cur && cur.childSessionId !== sid) this.saveCall({ ...cur, childSessionId: sid });
          },
          ...(continueChild ? { continueChild, ...(resumeOnly ? { resumeOnly } : {}) } : {}),
          ...(this.row.meta?.permissions ? { rules: this.row.meta.permissions } : {}),
          failedHarnesses: this.failedHarnesses,
        });
        for (const n of out.notes) this.logCap(`note:${n}`, n);
        const child = out.childSessionId ? this.engine.getSession(out.childSessionId) : undefined;
        const cur = { ...this.calls.get(c.seq)!, ...(out.childSessionId ? { childSessionId: out.childSessionId } : {}) };
        if (child) {
          cur.inputTokens = child.stats.inputTokens;
          cur.outputTokens = child.stats.outputTokens;
          cur.costUsd = child.stats.costUsd;
          cur.model = child.model;
        }
        if (this.skipped.has(c.seq)) {
          this.saveCall({ ...cur, state: 'skipped', error: this.skipped.get(c.seq) ?? SKIPPED_BY_OWNER, finishedAt: Date.now() });
          return null;
        }
        if (this.controller.signal.aborted) {
          this.saveCall({ ...cur, state: 'failed', error: 'the run was stopped', finishedAt: Date.now() });
          throw new Error('the run was stopped');
        }
        if (out.parkedUntil) {
          // a usage limit: the call waits for the reset, the run shows waiting_reset
          this.saveCall({ ...cur, state: 'parked', error: `usage limit; runs again at ${new Date(out.parkedUntil).toISOString()}` });
          this.svc.parkRun(this, out.parkedUntil);
          await new Promise<void>((resolve) => this.parkWaiters.set(c.seq, resolve));
          this.parkWaiters.delete(c.seq);
          if (!this.parkWaiters.size && (this.row.status === 'waiting_reset')) this.setStatus(this.paused ? 'paused' : 'running', { resumeAt: undefined });
          if (this.skipped.has(c.seq)) {
            this.saveCall({ ...this.calls.get(c.seq)!, state: 'skipped', error: this.skipped.get(c.seq) ?? SKIPPED_BY_OWNER, finishedAt: Date.now() });
            return null;
          }
          if (this.controller.signal.aborted) throw new Error('the run was stopped');
          continueChild = out.childSessionId;
          resumeOnly = false;
          continue;
        }
        if (out.paused && out.childSessionId) {
          // the owner paused the run or this agent: the call waits for Resume, then the agent's cut turn goes on
          this.saveCall({ ...cur, state: 'parked', error: 'paused; it goes on after Resume' });
          await new Promise<void>((resolve) => this.pausedCalls.set(c.seq, resolve));
          this.pausedCalls.delete(c.seq);
          if (this.skipped.has(c.seq) || this.controller.signal.aborted) this.engine.runnerFor(out.childSessionId).unpause();
          if (this.skipped.has(c.seq)) {
            this.saveCall({ ...this.calls.get(c.seq)!, state: 'skipped', error: this.skipped.get(c.seq) ?? SKIPPED_BY_OWNER, finishedAt: Date.now() });
            return null;
          }
          if (this.controller.signal.aborted) throw new Error('the run was stopped');
          continueChild = out.childSessionId;
          resumeOnly = true;
          continue;
        }
        let value = out.value;
        if (worktree) {
          try {
            const fin = await finishWorktree(this.machineFor(spec), worktree, `wf ${this.id} ${cur.label ?? c.seq}`, cur.model);
            Object.assign(cur, { worktreeState: fin.state, worktreeCommit: fin.commit, worktreeFiles: fin.files });
            worktree = undefined;
          } catch (err) {
            this.log(`worktree for ${cur.label}: ${shortError(err)}`);
          }
        }
        if (out.error && value === null) {
          this.log(`${cur.label}: ${oneLine(out.error, 300)}`);
          this.saveCall({ ...cur, state: 'failed', error: oneLine(out.error, 1000), result: null, hasResult: false, finishedAt: Date.now() });
          return null;
        }
        if (value === undefined) value = null;
        this.saveCall({ ...cur, state: 'done', result: value, hasResult: true, finishedAt: Date.now() });
        return value;
      }
    } catch (err) {
      const cur = this.calls.get(c.seq)!;
      if (this.skipped.has(c.seq)) {
        this.saveCall({ ...cur, state: 'skipped', error: this.skipped.get(c.seq) ?? SKIPPED_BY_OWNER, finishedAt: Date.now() });
        return null;
      }
      if (cur.state !== 'failed') this.saveCall({ ...cur, state: 'failed', error: shortError(err), finishedAt: Date.now() });
      if (this.controller.signal.aborted) throw new Error('the run was stopped');
      // a worktree that could not be made, or a cap wait that failed: the call is null, the script goes on
      this.log(`${cur.label}: ${shortError(err)}`);
      return null;
    } finally {
      this.controller.signal.removeEventListener('abort', onRunAbort);
      this.callControllers.delete(c.seq);
      for (const r of releases.reverse()) r();
      if (worktree) {
        // the call failed before cleanup: keep what it wrote
        await finishWorktree(this.machineFor(spec), worktree, `wf ${this.id} ${c.label ?? c.seq}`, this.calls.get(c.seq)?.model)
          .then((fin) => this.saveCall({ ...this.calls.get(c.seq)!, worktreeState: fin.state, worktreeCommit: fin.commit, worktreeFiles: fin.files }))
          .catch(() => {});
      }
      wtRelease?.();
      const sid = this.calls.get(c.seq)?.childSessionId;
      if (sid) this.svc.steps.delete(sid);
    }
  }

  private providerOf(spec: AgentSpec): string {
    try {
      const parent = this.row.sessionId ? this.engine.getSession(this.row.sessionId) : undefined;
      const ref = spec.model && this.engine.isUsable(spec.model) ? spec.model : (parent?.model ?? this.engine.config.get().defaultModel);
      return this.engine.providers.resolve(ref).provider;
    } catch {
      return 'default';
    }
  }

  // ----- lib host calls -----

  private sessionOf(): Session | undefined {
    return this.row.sessionId ? this.engine.getSession(this.row.sessionId) : undefined;
  }

  /** True when nobody can answer: a routine run, or a run marked unattended. */
  unattended(): boolean {
    if (this.row.unattended) return true;
    let id = this.row.sessionId;
    for (let i = 0; id && i < 6; i++) {
      if (this.engine.unattended.has(id)) return true;
      id = this.engine.getSession(id)?.parentId;
    }
    return false;
  }

  private async checkCitation(p: { file?: unknown; line?: unknown; quote?: unknown; worktree?: unknown }): Promise<{ ok: boolean; line?: number; reason?: string }> {
    const file = typeof p.file === 'string' ? p.file : '';
    const line = typeof p.line === 'number' ? Math.floor(p.line) : Number(p.line);
    const quote = typeof p.quote === 'string' ? p.quote : '';
    if (!file || !Number.isFinite(line) || line < 1) return { ok: false, reason: 'no file or line' };
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const q = norm(quote);
    if (q.length < 3) return { ok: false, reason: 'no quote' };
    const machine = this.machineFor();
    let text: string;
    try {
      const seq = typeof p.worktree === 'number' ? p.worktree : undefined;
      const commit = seq !== undefined ? this.calls.get(seq)?.worktreeCommit : undefined;
      const repo = await repoInfo(machine, this.row.cwd).catch(() => undefined);
      if (commit) {
        const r = await machine.exec(`git show ${shq(`${commit}:${file.replace(/^\.\//, '')}`)}`, { cwd: repo?.root ?? this.row.cwd, timeoutMs: 20_000, maxOutputBytes: CITATION_MAX_BYTES });
        if (r.exitCode !== 0) return { ok: false, reason: 'file not in the worktree commit' };
        text = r.stdout;
      } else {
        // a finding cites a file of the project: inside the repository (or the run folder outside git), at most 5 MB
        const root = repo?.root ?? this.row.cwd;
        const candidates = file.startsWith('/') ? [posix.normalize(file)] : [...new Set([posix.join(this.row.cwd, file), posix.join(root, file)])];
        const inside = candidates.filter((c) => c === root || c.startsWith(root.endsWith('/') ? root : `${root}/`));
        if (!inside.length) return { ok: false, reason: `the file is outside ${root}` };
        let found: string | undefined;
        for (const c of inside) {
          const st = await machine.stat(c).catch(() => null);
          if (!st) continue;
          if (st.type !== 'file') return { ok: false, reason: 'not a regular file' };
          if (st.size > CITATION_MAX_BYTES) return { ok: false, reason: `the file is too large to check (${Math.round(st.size / 1024 / 1024)} MB)` };
          found = c;
          break;
        }
        if (!found) return { ok: false, reason: 'file not found' };
        text = await machine.readText(found);
      }
    } catch {
      return { ok: false, reason: 'file not found' };
    }
    const lines = text.split('\n');
    for (let d = 0; d <= 3; d++) {
      for (const at of d === 0 ? [line] : [line - d, line + d]) {
        const l = lines[at - 1];
        if (l !== undefined && (norm(l).includes(q) || (q.length > 20 && q.includes(norm(l)) && norm(l).length > 10))) return { ok: true, line: at };
      }
    }
    // a multi-line quote: its first line is enough
    const firstQ = norm(quote.split('\n')[0] ?? '');
    if (firstQ.length >= 3 && firstQ !== q) {
      for (let at = Math.max(1, line - 3); at <= line + 3; at++) if (lines[at - 1] !== undefined && norm(lines[at - 1]).includes(firstQ)) return { ok: true, line: at };
    }
    return { ok: false, reason: 'quote not within 3 lines of the cited line' };
  }

  private async permitExec(command: string, cwd: string, signal: AbortSignal, what = 'lib.exec'): Promise<void> {
    const session = this.sessionOf();
    if (!session) throw new Error(`${what}: the session that started the run is gone`);
    const machine = this.machineFor();
    const home = (await this.engine.machineHome(machine)) ?? '/';
    const scoped = { ...session, cwd, meta: { ...session.meta, workflowRules: this.row.meta?.permissions } } as Session;
    let decision = checkPermission({
      tool: BashTool as unknown as Tool,
      input: { command },
      content: command,
      mode: session.permissionMode,
      rules: this.engine.permissionRulesFor(scoped),
      sessionAllow: [],
      cwd,
      home,
      workspaceRoots: [cwd],
    });
    if (dangerousCommand(command) && decision.decision === 'allow') decision = { decision: 'ask', reason: 'Potentially destructive command' };
    if (decision.decision === 'allow') return;
    if (decision.decision === 'deny') throw new Error(`${what} denied: ${decision.reason}`);
    if (this.unattended()) throw new Error(`${what} needs approval and nobody is there to approve it: ${command}`);
    const res = await this.engine.requestApproval(
      session.id,
      { toolUseId: `wf_${this.id}_${this.seq}`, tool: 'Bash', input: { command }, summary: `${this.row.name} / ${what}: ${oneLine(command, 160)}`, suggestedRule: suggestBashRule(command) },
      signal,
    );
    if (res.decision !== 'allow') throw new Error(`${what} was not approved: ${command}`);
  }

  private async execOn(command: string, opts: { cwd?: string; timeoutMs?: number; worktree?: number }, signal: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const machine = this.machineFor();
    const timeoutMs = Math.min(Math.max(1000, opts.timeoutMs ?? 10 * 60_000), 60 * 60_000);
    const run = async (cwd: string) => {
      await this.permitExec(command, cwd, signal);
      const r = await machine.exec(command, { cwd, timeoutMs, signal, maxOutputBytes: 400_000 });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    };
    if (opts.worktree !== undefined) {
      const call = this.calls.get(opts.worktree);
      if (!call?.worktreeCommit) throw new Error(`call ${opts.worktree} kept no worktree commit`);
      const repo = await repoInfo(machine, this.row.cwd);
      if (!repo) throw new Error('not a git repository');
      const home = (await this.engine.machineHome(machine)) ?? '/tmp';
      return withDetached(machine, { home, root: repo.root, commit: call.worktreeCommit, tag: `${this.id}-${opts.worktree}-${sha256(command).slice(0, 8)}` }, (path) => {
        const rel = posix.relative(repo.root, this.row.cwd);
        return run(rel && !rel.startsWith('..') ? posix.join(path, rel) : path);
      });
    }
    // through machine.resolve, as agent cwds are: ~ expands, relative paths join the run's folder
    const cwd = opts.cwd ? posix.normalize(machine.resolve(opts.cwd, this.row.cwd)) : this.row.cwd;
    return run(cwd);
  }

  private async fingerprintFor(worktree: number | undefined, cwd: string): Promise<string> {
    if (worktree !== undefined) return `wt:${this.calls.get(worktree)?.worktreeCommit ?? 'none'}`;
    return (await codeFingerprint(this.machineFor(), cwd)) ?? `live:${this.id}:${this.seq}`;
  }

  private projectKey(): string | undefined {
    const s = this.sessionOf();
    return s?.projectId ?? this.row.cwd;
  }

  /** Similar to a dismissed finding: Jaccard over the words of file, title and quote. */
  private dropDismissed(list: unknown[]): unknown[] {
    const dismissed = this.svc.store.dismissed(this.row.name, this.projectKey(), this.svc.runAccount(this.row));
    if (!dismissed.length) return list;
    const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2));
    const sets = dismissed.map((d) => words(`${d.file ?? ''} ${d.title} ${(d.data?.quote as string) ?? ''}`));
    const sim = (a: Set<string>, b: Set<string>) => {
      let inter = 0;
      for (const w of a) if (b.has(w)) inter++;
      return inter / Math.max(1, a.size + b.size - inter);
    };
    let dropped = 0;
    const out = list.filter((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      const w = words(`${o.file ?? ''} ${o.title ?? ''} ${o.quote ?? ''}`);
      const similar = sets.filter((s) => sim(w, s) >= 0.5).length;
      if (similar >= 3) {
        dropped++;
        return false;
      }
      return true;
    });
    if (dropped) this.log(`dropped ${count(dropped, 'finding')} similar to 3 or more that the owner dismissed before`);
    return out;
  }

  recordFindings(list: unknown[]): number {
    this.findingsRecorded = true;
    let n = 0;
    const max = this.cap('findings');
    // an earlier attempt of this run (resume, rerun) may have recorded the same findings, with the owner's verdicts
    this.findingKeys ??= this.svc.store.findingKeys(this.id);
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      if (this.findingKeys.size >= max) {
        this.logCap('findings', `findings cap: ${max} findings are recorded for this run; later ones are not`);
        break;
      }
      const o = f as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title : typeof o.claim === 'string' ? o.claim : undefined;
      if (!title) continue;
      const file = typeof o.file === 'string' ? o.file : undefined;
      const line = typeof o.line === 'number' ? o.line : undefined;
      const findingKey = typeof o.id === 'string' && o.id ? o.id : sha256(`${file ?? ''}|${line ?? ''}|${(o.class as string) ?? ''}|${title}`).slice(0, 16);
      if (this.findingKeys.has(findingKey)) continue;
      const finding: WorkflowFinding = {
        id: newId('wff'),
        runId: this.id,
        workflow: this.row.name,
        ...(this.projectKey() ? { project: this.projectKey() } : {}),
        findingKey,
        ...(file ? { file } : {}),
        ...(line ? { line } : {}),
        title: oneLine(title, 300),
        ...(typeof o.priority === 'string' ? { priority: o.priority } : {}),
        proven: o.proven === true,
        ...(o.votes !== undefined ? { votes: o.votes } : {}),
        data: o,
        createdAt: Date.now(),
      };
      this.svc.store.addFinding(finding);
      this.findingKeys.add(findingKey);
      n++;
    }
    return n;
  }

  /** lib.ledger's folder: absolute on the run's device, the run folder by default; a scoped run stays in its repository. */
  private async ledgerFolder(project: unknown): Promise<string> {
    const machine = this.machineFor();
    const resolved = posix.normalize(machine.resolve(typeof project === 'string' && project.trim() ? project : '.', this.row.cwd));
    const folder = resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
    if (this.row.scoped) {
      const root = (await repoInfo(machine, this.row.cwd).catch(() => undefined))?.root ?? this.row.cwd;
      if (folder !== root && !folder.startsWith(root.endsWith('/') ? root : `${root}/`)) throw new Error(`this workflow came from an agent or a repository, so its ledger stays in ${root}; ${folder} is outside it`);
    }
    return folder;
  }

  private writeLedger(folder: string, list: unknown[]) {
    const { merged, changed, dropped } = mergeLedger(this.svc.store.ledger(this.row.device, folder), list, Date.now());
    this.svc.store.upsertLedger(this.row.device, folder, changed);
    if (dropped) this.log(`ledger: ${count(dropped, 'entry', 'entries')} not written (at most 200 per write and 500 per folder)`);
    return merged;
  }

  private async ask(question: string, options: string[], signal: AbortSignal): Promise<string> {
    const opts = options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 6);
    if (this.unattended() || !this.sessionOf()) {
      const pick = opts[0] ?? '';
      this.log(`lib.ask in an unattended run: "${oneLine(question, 120)}" took the first option (${pick || 'none'})`);
      return pick;
    }
    const answers = await this.engine.askUser(this.row.sessionId!, [{ question: `${this.row.name}: ${question}`, header: 'Workflow', options: opts.map((label) => ({ label })) }], signal);
    return Object.values(answers)[0] ?? opts[0] ?? '';
  }

  private async approve(text: string, signal: AbortSignal): Promise<boolean> {
    const args = (this.row.args ?? {}) as Record<string, unknown>;
    if (this.unattended() || !this.sessionOf()) {
      if (args && typeof args === 'object' && args.autoApprove === true) {
        this.log('lib.approve in an unattended run: approved by args.autoApprove');
        return true;
      }
      this.log('lib.approve in an unattended run: stopping with the plan as the result');
      this.endWith({ approved: false, plan: text, note: 'Unattended run: the plan needs the owner. Run again with args.autoApprove to go on without asking.' });
      throw new Error('the run ended: the plan needs the owner');
    }
    const res = await this.engine.requestApproval(
      this.row.sessionId!,
      { toolUseId: `wf_${this.id}_plan_${this.seq}`, tool: 'ExitPlanMode', input: { plan: text }, summary: `${this.row.name}: approve the plan to go on` },
      signal,
    );
    return res.decision === 'allow';
  }

  // ----- the sandbox -----

  private hostFns(parentSeq: number | undefined, nested: boolean) {
    const sync = {
      log: (p: unknown) => this.log(typeof p === 'string' ? p : JSON.stringify(p)),
      phase: (p: unknown) => this.setPhase(String(p ?? '')),
      budget: () => ({ total: this.row.budget?.tokens ?? null, spent: this.spentTokens(), costUsd: Math.round(this.spentCost() * 1e4) / 1e4 }),
      panel: (p: unknown) => {
        const votes = ((p as { votes?: unknown[] })?.votes ?? []) as Array<string | null>;
        this.votes.panels++;
        if (votes.filter((v) => v === 'confirmed').length < 2) this.votes.refuted++;
        return null;
      },
      // lib.failingTest: the rules are shared with the regression gate and the bench (util/test-run.ts)
      failingTest: (p: unknown) => {
        const o = (p ?? {}) as { check?: unknown; testFile?: unknown; diff?: unknown };
        return failingTest(o.check, { testFile: o.testFile, diff: o.diff });
      },
      ledgerFence: (p: unknown) => ledgerFence(Array.isArray((p as { entries?: unknown })?.entries) ? (p as { entries: unknown[] }).entries : []),
      ledgerId: (p: unknown) => ledgerId(String((p as { text?: unknown })?.text ?? '')),
    };
    const async = {
      agent: (p: unknown) => {
        const o = (p ?? {}) as { prompt?: unknown; opts?: unknown };
        return this.agentCall(o.prompt, o.opts, parentSeq);
      },
      sleep: async (p: unknown) => {
        const ms = Math.min(Math.max(0, Number((p as { ms?: unknown })?.ms) || 0), DEFAULTS.sleepMaxMs);
        const signal = this.controller.signal;
        if (signal.aborted) return null;
        await new Promise<void>((resolve) => {
          // the abort listener goes when the timer fires, so a script that sleeps in a loop leaves none behind
          const onAbort = () => {
            clearTimeout(t);
            resolve();
          };
          const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        return null;
      },
      workflow: (p: unknown) => {
        if (nested) throw new Error('workflow() nesting is one level only');
        const o = (p ?? {}) as { ref?: unknown; args?: unknown };
        return this.nested(o.ref, o.args);
      },
      checkCitation: (p: unknown) => this.checkCitation((p ?? {}) as Record<string, unknown>),
      exec: (p: unknown) => {
        const o = (p ?? {}) as { command?: unknown; cwd?: unknown; timeoutMs?: unknown; worktree?: unknown };
        const command = typeof o.command === 'string' ? o.command : '';
        if (!command.trim()) throw new Error('lib.exec needs a command');
        this.countCheck();
        const worktree = typeof o.worktree === 'number' ? o.worktree : undefined;
        const cwd = typeof o.cwd === 'string' ? o.cwd : undefined;
        return this.fingerprintFor(worktree, this.row.cwd).then((fp) =>
          this.hostCall('check', `exec: ${oneLine(command, 80)}`, { command, cwd, worktree, fp }, parentSeq, (signal) => this.execOn(command, { cwd, timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : undefined, worktree }, signal)),
        );
      },
      runCheck: (p: unknown) => {
        const o = (p ?? {}) as { command?: unknown; worktree?: unknown; timeoutMs?: unknown };
        const command = typeof o.command === 'string' ? o.command : '';
        if (!command.trim()) throw new Error('lib.runCheck needs a command');
        this.countCheck();
        const worktree = typeof o.worktree === 'number' ? o.worktree : undefined;
        return this.fingerprintFor(worktree, this.row.cwd).then((fp) =>
          this.hostCall('check', `check: ${oneLine(command, 80)}`, { check: command, worktree, fp }, parentSeq, async (signal) => {
            const r = await this.execOn(command, { timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : undefined, worktree }, signal);
            const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-40).join('\n');
            return { ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, tail, timedOut: r.timedOut };
          }),
        );
      },
      // lib.capture: the Capture tool's code (browser/capture.ts); files in the run's session outputs folder on the hub
      capture: (p: unknown) => {
        const o = (p ?? {}) as { url?: unknown; opts?: unknown };
        const url = typeof o.url === 'string' ? o.url : '';
        const u = captureUrl(url);
        if ('error' in u) throw new Error(`lib.capture: ${u.error}`);
        // a member's capture reaches only public addresses and fits their disk cap (docs/design/ACCOUNTS.md 5), as for the Capture tool
        const acct = this.svc.runAccount(this.row);
        const full = this.engine.diskRefusal(acct);
        if (full) throw new Error(`lib.capture: ${full}`);
        const opts = (o.opts && typeof o.opts === 'object' ? o.opts : {}) as CaptureOptions;
        return this.hostCall('check', `capture: ${oneLine(u.href, 80)}`, { capture: u.href, opts }, parentSeq, (signal) => {
          const out = outputsDir(this.engine.config.paths.home, this.row.sessionId ?? this.id);
          return hubCapture((this.engine as unknown as { browser?: BrowserManager }).browser, this.engine.config.paths.home, out, u.href, opts, signal, acct);
        });
      },
      dropDismissed: (p: unknown) => this.dropDismissed(Array.isArray((p as { findings?: unknown })?.findings) ? ((p as { findings: unknown[] }).findings) : []),
      checkout: (p: unknown) => this.checkout(Number((p as { seq?: unknown })?.seq)),
      diff: (p: unknown) => this.diffOf(Number((p as { seq?: unknown })?.seq)),
      // the read is journaled, so a resumed run sees the ledger its first attempt saw
      ledgerRead: async (p: unknown) => {
        const folder = await this.ledgerFolder((p as { project?: unknown })?.project);
        return this.hostCall('check', `ledger: read ${oneLine(folder, 80)}`, { ledger: folder }, parentSeq, async () => this.svc.store.ledger(this.row.device, folder));
      },
      ledgerWrite: async (p: unknown) => {
        const o = (p ?? {}) as { project?: unknown; entries?: unknown };
        return this.writeLedger(await this.ledgerFolder(o.project), Array.isArray(o.entries) ? o.entries : []);
      },
      recordFindings: (p: unknown) => this.recordFindings(Array.isArray((p as { findings?: unknown })?.findings) ? ((p as { findings: unknown[] }).findings) : []),
      ask: (p: unknown) => {
        const o = (p ?? {}) as { question?: unknown; options?: unknown };
        const question = String(o.question ?? '');
        const options = Array.isArray(o.options) ? o.options.map(String) : [];
        return this.hostCall('ask', `ask: ${oneLine(question, 80)}`, { question, options }, parentSeq, (signal) => this.ask(question, options, signal));
      },
      approve: (p: unknown) => {
        const text = String((p as { text?: unknown })?.text ?? '');
        return this.hostCall('ask', 'approve the plan', { approve: text }, parentSeq, (signal) => this.approve(text, signal));
      },
    };
    // every async host call counts toward the run's host call cap
    const counted: Record<string, (p: unknown) => unknown> = {};
    for (const [name, fn] of Object.entries(async)) {
      counted[name] = (p: unknown) => {
        if (this.capError) throw new RunCapError(this.capError);
        this.countHost();
        return (fn as (p: unknown) => unknown)(p);
      };
    }
    return { sync, async: counted };
  }

  /**
   * Nested workflow() sandboxes alive at once. Each one may use the full
   * sandbox memory, so parallel() over many workflow() calls would otherwise
   * hold that much memory per call in the hub process at the same time.
   */
  private nestedSlots = new Semaphore(NESTED_AT_ONCE);

  private async nested(ref: unknown, args: unknown): Promise<unknown> {
    const loaded = await this.svc.resolveRef(ref, this.row);
    const key = callKey({ workflow: loaded.scriptSha, args });
    const c = this.newCall('workflow', key, { label: `${loaded.name}`, prompt: `workflow ${loaded.name}` });
    if (this.nestedSlots.full) this.logCap('nested', `nested workflow cap: ${NESTED_AT_ONCE} workflow() calls run at once in a run, more wait`);
    let release: () => void;
    try {
      release = await this.nestedSlots.acquire(this.controller.signal);
    } catch {
      this.saveCall({ ...this.calls.get(c.seq)!, state: 'failed', error: 'the run was stopped', finishedAt: Date.now() });
      throw new Error('the run was stopped');
    }
    this.saveCall({ ...this.calls.get(c.seq)!, state: 'running', startedAt: Date.now() });
    try {
      const value = await this.evaluate(loaded.body, args, c.seq, true);
      this.saveCall({ ...this.calls.get(c.seq)!, state: 'done', result: value, hasResult: true, finishedAt: Date.now() });
      return value;
    } catch (err) {
      this.saveCall({ ...this.calls.get(c.seq)!, state: 'failed', error: shortError(err), finishedAt: Date.now() });
      throw err;
    } finally {
      release();
    }
  }

  private async evaluate(body: string, args: unknown, parentSeq: number | undefined, nested: boolean): Promise<unknown> {
    const fns = this.hostFns(parentSeq, nested);
    const sb = await Sandbox.create({ sync: fns.sync, async: fns.async, signal: this.controller.signal, limits: this.svc.sandboxLimits });
    try {
      sb.evalGlobal(preludeSource({ argsJson: args === undefined ? 'undefined' : JSON.stringify(args), nested }), 'prelude.js');
      return await sb.runAsync(body, 'workflow.js');
    } finally {
      sb.dispose();
    }
  }

  /** Run the script to its end and record the outcome. */
  async execute(): Promise<void> {
    const started = Date.now();
    this.setStatus(this.paused ? 'paused' : 'running', { startedAt: this.row.startedAt ?? started, finishedAt: undefined, error: undefined });
    this.ticker = setInterval(() => {
      if (this.row.status === 'running' || this.row.status === 'paused' || this.row.status === 'waiting_reset') {
        this.refreshTotals();
        this.svc.store.updateRun(this.row);
        this.emitRun();
      }
    }, 2000);
    let result: unknown;
    let status: WorkflowRunStatus = 'done';
    let error: string | undefined;
    try {
      const { body } = await loadMeta(this.row.script);
      result = await this.evaluate(body, this.row.args, undefined, false);
      if (this.budgetHit) status = 'budget';
    } catch (err) {
      if (this.capError) {
        status = 'failed';
        error = this.capError;
      } else if (this.endResult !== undefined) {
        result = this.endResult;
      } else if (this.controller.signal.aborted) {
        status = this.stopReason === 'interrupted' ? 'interrupted' : 'stopped';
        error = this.stopReason === 'interrupted' ? 'the hub stopped while the run was going' : 'stopped by the owner';
      } else {
        status = this.budgetHit ? 'budget' : 'failed';
        error = err instanceof SandboxError ? err.message : shortError(err);
      }
    } finally {
      if (this.ticker) clearInterval(this.ticker);
      await this.removeViews().catch(() => {});
    }
    if (this.svc.closed) {
      this.resolveDone();
      return;
    }
    // findings in the result are recorded when the script did not record them itself
    if (!this.findingsRecorded && result && typeof result === 'object' && Array.isArray((result as { findings?: unknown }).findings)) {
      const n = this.recordFindings((result as { findings: unknown[] }).findings);
      if (n) this.log(`recorded ${count(n, 'finding')} from the result`);
    }
    if (status === 'budget') this.log('Stopped at the budget: agent() calls after it threw.');
    this.refreshTotals();
    this.setStatus(status, { result, ...(error ? { error } : {}), finishedAt: Date.now(), resumeAt: undefined });
    log.info(`workflow ${this.row.name} (${this.id}) ${status} after ${Math.round((Date.now() - started) / 1000)}s, ${count(this.agentCount, 'agent')}`);
    this.resolveDone();
  }

  private endResult: unknown;

  /** End the run early with a result (an unattended run whose plan needs the owner). */
  endWith(result: unknown): void {
    this.endResult = result;
    this.controller.abort();
  }
}
