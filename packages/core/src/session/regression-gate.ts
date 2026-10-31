/**
 * The regression gate (docs/research/2026-10-20-next-features.md section 3,
 * item 1). When a turn changed both test files and source files, the changed
 * tests run on the code from before the turn when the agent stops. A test
 * that passes there does not show that the change fixed or added anything.
 *
 * - The old tree comes from the shadow checkpoint the runner takes at the
 *   start of each turn (session/checkpoints.ts). The changed test files, and
 *   changed test helpers next to them, go over it in a temp folder on the
 *   session's device, and the narrowest test command runs there for at most
 *   30 s. The temp folder is removed after.
 * - The run is read with the shared rules (util/test-run.ts):
 *   - the tests fail on the old code: proven. No message; an audit row
 *     `regression.gate` and a `regression.checked` event the bench counts;
 *   - they pass on the old code: one short reminder per user turn;
 *   - the run says nothing (a timeout, a test file that does not load, no
 *     test ran): no message, the audit row and event only.
 * - It runs in the onStop chain after the verify gate. While the verify gate
 *   sends the agent back, it waits for the next stop, and both share the
 *   runner's cap on continuations (session/runner.ts STOP_BLOCK_CAP).
 * - The runner starts the checkpoint without waiting for it. The gate waits
 *   for it at stop, and skips the turn when a tool that can change files ran
 *   before the snapshot was done, since the snapshot may hold its edits.
 * - A run resumed after a usage limit (session/limits.ts) continues the parked
 *   user turn: the runner keeps that turn's checkpoint, in memory or, after a
 *   hub restart, from session meta. So the tests run on the code from before
 *   the user turn, not on the partial edits, and the per-turn state (one
 *   reminder) lives on that checkpoint object.
 * - On for agents whose profile lists the `regression-gate` recipe (coder,
 *   builder, tester). It runs project code, so it follows the verify gate's
 *   rule: a trusted folder, or a test command the Bash rules already allow.
 * - Python (unittest or pytest) and Bun projects only. Go and Rust are left
 *   out: Go tests share a package with the code they test and Rust unit tests
 *   sit inside the source files, so new tests often do not build against the
 *   old code at all (a build error proves nothing), and their builds rarely
 *   fit in 30 s.
 * - Main sessions only. A subagent's turn has no checkpoint of its own; its
 *   edits are part of its parent's turn, which the parent's gate checks.
 */
import type { Engine } from '../engine/engine';
import type { Session } from '../types';
import type { Machine } from '../machine/types';
import type { RunnerExtension } from './runner-ext';
import { wantsRegressionGate } from '../extensions/agent-hooks';
import { changesSince, removeTree, treeAt, type ChangedFile, type TurnCheckpoint } from './checkpoints';
import { detectTestCommand } from './project';
import { mayRunProjectCommand } from './verify-gate';
import { testOutcome } from '../util/test-run';
import { logger } from '../util/log';

const log = logger('regression-gate');

/** Longest test run on the old code. */
export const REGRESSION_TIMEOUT_MS = 30_000;
/** Longest wait at stop for the turn's checkpoint. */
const CHECKPOINT_WAIT_MS = 30_000;
/** Lines of output the shared rules read. */
const TAIL_LINES = 60;

export const REGRESSION_REMINDER = 'Your changed tests pass without your change. If this fixes a bug or adds behavior, make one fail without it. If it is a refactor, say so.';

export type RegressionOutcome = 'proven' | 'passes' | 'not_run' | 'skipped';

/** Code files the gate sorts: Python, and JavaScript or TypeScript. */
const CODE = /\.(py|[cm]?[jt]sx?)$/;
/** Test file names the runners pick up: unittest and pytest, and bun test. */
const PY_TEST = /^test_[^/]*\.py$|^tests?\.py$|_test\.py$/;
const JS_TEST = /[._](test|spec)\.[cm]?[jt]sx?$/;
/** Folders that hold tests and their helpers. */
const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//;
const PY_MODULE = /^[A-Za-z_]\w*(\/[A-Za-z_]\w*)*\.py$/;

/** What a turn changed, by role. Paths are relative to the session folder. */
export interface TurnChanges {
  /** Test files added or changed: the ones to run. */
  tests: string[];
  /** Other code under a test folder, and conftest.py: laid over the old tree with the tests, not run. */
  helpers: string[];
  /** Code outside the tests, added, changed or deleted. */
  sources: string[];
}

export function splitChanges(files: ChangedFile[]): TurnChanges {
  const out: TurnChanges = { tests: [], helpers: [], sources: [] };
  for (const f of files) {
    if (!CODE.test(f.path)) continue;
    const name = f.path.slice(f.path.lastIndexOf('/') + 1);
    const isTest = PY_TEST.test(name) || JS_TEST.test(name);
    if (!isTest && !TEST_DIR.test(f.path) && name !== 'conftest.py') out.sources.push(f.path);
    // a deleted test runs nowhere
    else if (f.status === 'D') continue;
    else (isTest ? out.tests : out.helpers).push(f.path);
  }
  return out;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function tailLines(text: string, n: number): string {
  return text.replace(/\s+$/, '').split('\n').slice(-n).join('\n');
}

export interface TestRunPlan {
  command: string;
  env: Record<string, string>;
}

/**
 * The narrowest command that runs these test files with the project's own
 * runner, read from the folder as it is now. Undefined for a runner the gate
 * does not know (jest, vitest, a mix of languages, a name unittest cannot
 * import).
 */
export async function planTestRun(machine: Machine, cwd: string, tests: string[]): Promise<TestRunPlan | undefined> {
  if (!tests.length) return undefined;
  if (tests.every((t) => t.endsWith('.py'))) return pythonPlan(machine, cwd, tests);
  if (tests.every((t) => JS_TEST.test(t))) return bunPlan(machine, cwd, tests);
  return undefined;
}

async function pythonPlan(machine: Machine, cwd: string, tests: string[]): Promise<TestRunPlan | undefined> {
  const detected = await detectTestCommand(machine, cwd).catch(() => undefined);
  const env: Record<string, string> = { PYTHONDONTWRITEBYTECODE: '1' };
  if (detected === 'python3 -m pytest') return { command: `python3 -m pytest -q -p no:cacheprovider ${tests.map(shq).join(' ')}`, env };
  // unittest loads by module name; `discover -s <dir>` puts that folder first on the path, so it goes in PYTHONPATH
  const start = /^python3 -m unittest discover -s (\S+)$/.exec(detected ?? '')?.[1];
  const modules: string[] = [];
  for (const t of tests) {
    const rel = start && t.startsWith(`${start}/`) ? t.slice(start.length + 1) : t;
    if (!PY_MODULE.test(rel)) return undefined;
    modules.push(rel.slice(0, -3).replaceAll('/', '.'));
  }
  return { command: `python3 -m unittest ${modules.join(' ')}`, env: start ? { ...env, PYTHONPATH: start } : env };
}

async function bunPlan(machine: Machine, cwd: string, tests: string[]): Promise<TestRunPlan | undefined> {
  const root = cwd.replace(/\/+$/, '');
  let script = '';
  try {
    const test = JSON.parse(await machine.readText(`${root}/package.json`))?.scripts?.test;
    script = typeof test === 'string' ? test.trim() : '';
  } catch {
    return undefined;
  }
  const bunLock = !!(await machine.stat(`${root}/bun.lock`).catch(() => null)) || !!(await machine.stat(`${root}/bun.lockb`).catch(() => null));
  if (!/^bun test\b/.test(script) && !(script === '' && bunLock)) return undefined;
  return { command: `bun test ${tests.map((t) => shq(`./${t}`)).join(' ')}`, env: {} };
}

/** The promise's value, or undefined after ms. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Per user turn; a run resumed after a usage limit keeps its turn's checkpoint object, and so this. */
interface GateState {
  /** The agent got the reminder this user turn. */
  reminded: boolean;
  /** The changes the gate last looked at this turn, so the same ones are not run again. */
  lastKey?: string;
}

export class RegressionGate {
  private states = new WeakMap<TurnCheckpoint, GateState>();

  /** `timeoutMs` and `checkpointWaitMs` are shorter in tests. */
  constructor(
    private engine: Engine,
    private opts: { timeoutMs?: number; checkpointWaitMs?: number } = {},
  ) {}

  private state(turn: TurnCheckpoint): GateState {
    let s = this.states.get(turn);
    if (!s) {
      s = { reminded: false };
      this.states.set(turn, s);
    }
    return s;
  }

  /** Whether the gate is on for this session's agent. */
  enabled(session: Session): boolean {
    if (session.kind === 'chat') return false;
    return wantsRegressionGate(this.engine.agentNamed(session.agent, session.cwd, this.engine.accountOf(session)));
  }

  /** A tool that can change files ran in the turn. */
  noteWrite(turn: TurnCheckpoint): void {
    turn.firstWriteAt ??= Date.now();
  }

  /** A tool ran in this session or one of its subagents; one that can change files counts toward the main session's turn. */
  noteTool(session: Session, readOnly: boolean): void {
    if (readOnly) return;
    let root = session;
    for (let i = 0; i < 8 && root.parentId; i++) {
      const up = this.engine.getSession(root.parentId);
      if (!up) break;
      root = up;
    }
    const turn = this.engine.runnerFor(root.id).turnCheckpoint;
    if (turn) this.noteWrite(turn);
  }

  /**
   * The turn wants to end. Returns the reminder when the changed tests pass
   * on the code from before the turn, once per user turn; otherwise undefined.
   */
  async check(session: Session, turn: TurnCheckpoint | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (!turn || !this.enabled(session)) return undefined;
    const s = this.state(turn);
    // nothing this turn could have changed a file
    const firstWriteAt = turn.firstWriteAt;
    if (firstWriteAt === undefined) return undefined;
    const ckpt = await within(turn.done, this.opts.checkpointWaitMs ?? CHECKPOINT_WAIT_MS);
    if (!ckpt) return undefined;
    // a checkpoint is one folder on one device: after a move there is nothing to compare with
    if ((ckpt.device ?? 'local') !== (session.device || 'local') || (ckpt.root ?? session.cwd) !== session.cwd) return undefined;
    const machine = this.engine.machineFor(session);
    const changed = await changesSince(this.engine, session, machine, ckpt, signal);
    if (!changed) return undefined;
    const split = splitChanges(changed);
    // the snapshot was still running when the turn changed files, so it may hold part of the change
    // (the source edit, say): the list above is not the whole turn, and the old tree is not the old code
    const raced = turn.settledAt === undefined || firstWriteAt < turn.settledAt;
    if (!split.tests.length || (!split.sources.length && !raced)) return undefined;
    const blob = new Map(changed.map((f) => [f.path, `${f.status} ${f.blob}`]));
    const key = [...split.tests, ...split.helpers, ...split.sources].sort().map((p) => `${p} ${blob.get(p)}`).join('\n');
    if (key === s.lastKey) return undefined;
    s.lastKey = key;
    const tests = split.tests;
    if (raced) return this.record(session, s, 'skipped', { tests, why: 'the checkpoint finished after the turn first changed files' });
    const plan = await planTestRun(machine, session.cwd, tests).catch(() => undefined);
    if (!plan) return this.record(session, s, 'skipped', { tests, why: 'no test runner the gate knows for these files' });
    if (!(await mayRunProjectCommand(this.engine, session, plan.command))) {
      return this.record(session, s, 'skipped', { command: plan.command, tests, why: 'the folder is not trusted and the Bash rules do not allow the command' });
    }
    const dir = await treeAt(this.engine, session, machine, ckpt, [...tests, ...split.helpers], signal);
    if (!dir) return this.record(session, s, 'not_run', { command: plan.command, tests, why: 'the tree from before the turn could not be rebuilt' });
    let result: { outcome: string; why: string };
    try {
      const r = await machine.exec(plan.command, { cwd: dir, env: plan.env, timeoutMs: this.opts.timeoutMs ?? REGRESSION_TIMEOUT_MS, signal, maxOutputBytes: 200_000 });
      const out = [r.stdout, r.stderr].filter((x) => x && x.trim()).join('\n');
      result = testOutcome({ ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, timedOut: r.timedOut, tail: tailLines(out, TAIL_LINES) });
    } catch (err) {
      log.warn(`regression gate could not run ${plan.command}`, err);
      result = { outcome: 'not_run', why: 'the test command did not start' };
    } finally {
      await removeTree(machine, dir);
    }
    const outcome: RegressionOutcome = result.outcome === 'failed' ? 'proven' : result.outcome === 'passed' ? 'passes' : 'not_run';
    const why = outcome === 'proven' ? 'the tests fail on the code from before the turn' : outcome === 'passes' ? 'the tests pass on the code from before the turn' : result.why;
    return this.record(session, s, outcome, { command: plan.command, tests, why });
  }

  /** Audit row and event for every look that got as far as the tests; the reminder once per turn. */
  private record(session: Session, s: GateState, outcome: RegressionOutcome, d: { command?: string; tests: string[]; why: string }): string | undefined {
    const remind = outcome === 'passes' && !s.reminded;
    if (remind) s.reminded = true;
    this.engine.audit(session.id, 'regression.gate', `${outcome}${remind ? ', reminded' : ''}${d.command ? `: ${d.command}` : ''} (${d.why})`);
    this.engine.bus.emit({ type: 'regression.checked', sessionId: session.id, outcome, command: d.command ?? null, tests: d.tests, why: d.why, reminded: remind });
    return remind ? REGRESSION_REMINDER : undefined;
  }

  /** The runner extension for main sessions. */
  extension(): RunnerExtension {
    return {
      name: 'regression-gate',
      beforeTool: (ctx) => {
        this.noteTool(ctx.session, ctx.readOnly);
      },
      // after the verify gate: while it sends the agent back, wait for the next stop
      onStop: (ctx) => (ctx.depth === 0 && !ctx.pending.length ? this.check(ctx.session, this.engine.runnerFor(ctx.sessionId).turnCheckpoint, ctx.signal) : undefined),
    };
  }
}

/** Make the gate and register it with the runner, after the verify gate. */
export function attachRegressionGate(engine: Engine): RegressionGate {
  const gate = new RegressionGate(engine);
  engine.runnerExtensions.register(gate.extension());
  return gate;
}
