/**
 * The verify gate (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 4.2 item 6,
 * HARNESS-REVIEW item 15): when a turn edited files, the project's quick
 * check runs on the session's own device before the turn may end. A failure
 * sends the agent back with the last 40 lines, at most 3 times per user turn
 * (the runner's cap on continuations); the third time also posts a notice.
 * When the agent stops without further edits while the check fails, a
 * notice says so.
 *
 * It replaces the stop-verify hook for coding agents: hook commands run on
 * the hub, so a session on arch-desktop would type-check the hub's copy.
 * This runs through engine.machineFor(session).
 *
 * - On for agents whose profile lists the `verify-gate` recipe or sets
 *   `verifyCommand` (coder, builder, refactorer and designer ship with it).
 * - The command: the profile's verifyCommand, else `verifyCommand` in the
 *   folder's .conclave/settings.json (trusted folders only), else detected:
 *   a package.json `typecheck` script (run with the folder's package
 *   manager), `cargo check`, `go build ./...`, or `py_compile` on the edited
 *   Python files.
 * - It runs project code without a prompt, so it runs only in a trusted
 *   folder, or when the permission rules already allow that Bash command
 *   (an allow rule, bypass mode). Otherwise the session gets one notice.
 * - A check that cannot run to the end (it timed out, or exit 126 or 127:
 *   the command or a tool it needs is missing on the device) says nothing
 *   about the edits, so it does not send the agent back: one notice instead.
 * - In a package of a monorepo, the lockfile that picks the package manager
 *   can sit in a parent folder, up to the repository root.
 * - Main sessions are checked through the runner's onStop point. Subagents
 *   end through SubagentStop (engine/subagent.ts), so the gate is also a
 *   SubagentStop function hook there.
 */
import type { Engine } from '../engine/engine';
import type { Hooks } from '../extensions/hooks';
import type { HookInput, HookOutcome } from '../extensions/types';
import type { Session } from '../types';
import type { Machine } from '../machine/types';
import type { RunnerExtension } from './runner-ext';
import { wantsVerifyGate, agentHooksAllowed } from '../extensions/agent-hooks';
import { checkPermission } from './permissions';
import { BashTool } from '../tools/bash';
import { logger } from '../util/log';

const log = logger('verify-gate');

/** Reminders per user turn before the gate gives up with a notice. */
export const VERIFY_GATE_MAX = 3;
/** Lines of output that go back to the agent. */
export const VERIFY_GATE_TAIL = 40;
const TIMEOUT_MS = 120_000;

interface GateState {
  /** A file tool changed something since the last check. */
  dirty: boolean;
  /** Python files edited since the last check (for py_compile). */
  pyFiles: Set<string>;
  /** Failures in this user turn. */
  failures: number;
  last?: { command: string; ok: boolean };
  /** The give-up notice went out this turn. */
  noticed: boolean;
  /** The "needs trust" notice went out (once per session). */
  skippedNoticed: boolean;
  /** The "could not run" notice went out (once per session). */
  unrunNoticed?: boolean;
}

export interface VerifyResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut?: boolean;
  tail: string;
}

function tailLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function readJson(machine: Machine, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const v = JSON.parse(await machine.readText(path));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function exists(machine: Machine, path: string): Promise<boolean> {
  try {
    return !!(await machine.stat(path));
  } catch {
    return false;
  }
}

/** Folders a monorepo package's lockfile may sit in: the folder, then its parents up to the repository root. */
const LOCK_LEVELS = 6;

/** The package manager the lockfile in `cwd` or a parent (up to the folder with .git) names. */
async function packageManager(machine: Machine, cwd: string): Promise<'bun' | 'pnpm' | 'yarn' | 'npm'> {
  let dir = cwd.replace(/\/+$/, '');
  for (let i = 0; i < LOCK_LEVELS && dir; i++) {
    const at = (f: string) => `${dir}/${f}`;
    if ((await exists(machine, at('bun.lock'))) || (await exists(machine, at('bun.lockb')))) return 'bun';
    if (await exists(machine, at('pnpm-lock.yaml'))) return 'pnpm';
    if (await exists(machine, at('yarn.lock'))) return 'yarn';
    if ((await exists(machine, at('package-lock.json'))) || (await exists(machine, at('.git')))) break;
    dir = dir.slice(0, dir.lastIndexOf('/'));
  }
  return 'npm';
}

/** The check for a folder when nothing names one. undefined when the project has none the gate knows. */
export async function detectVerifyCommand(machine: Machine, cwd: string, pyFiles: string[] = []): Promise<string | undefined> {
  const at = (f: string) => `${cwd.replace(/\/+$/, '')}/${f}`;
  const pkg = await readJson(machine, at('package.json'));
  const scripts = pkg?.scripts as Record<string, unknown> | undefined;
  if (scripts && typeof scripts.typecheck === 'string') {
    const pm = await packageManager(machine, cwd);
    return pm === 'npm' ? 'npm run --silent typecheck' : `${pm} run typecheck`;
  }
  if (await exists(machine, at('Cargo.toml'))) return 'cargo check --quiet';
  if (await exists(machine, at('go.mod'))) return 'go build ./...';
  if (pyFiles.length) return `python3 -m py_compile ${pyFiles.map(shq).join(' ')}`;
  return undefined;
}

/**
 * The check the gate runs for a session: the profile's verifyCommand, else
 * the folder's .conclave/settings.json (trusted folders only), else detected.
 * Also read once per session for the Environment block (session/project.ts).
 */
export async function verifyCommandFor(engine: Engine, session: Session, pyFiles: string[]): Promise<string | undefined> {
  const def = engine.extensions.agent(session.agent, session.cwd);
  const trusted = engine.trust.isTrusted(session.cwd);
  if (def?.verifyCommand && agentHooksAllowed(def, session.cwd, { trusted: () => trusted, pluginHooksOn: () => true })) return def.verifyCommand;
  const machine = engine.machineFor(session);
  if (trusted) {
    const settings = await readJson(machine, `${session.cwd.replace(/\/+$/, '')}/.conclave/settings.json`);
    if (typeof settings?.verifyCommand === 'string' && settings.verifyCommand.trim()) return settings.verifyCommand.trim();
  }
  return detectVerifyCommand(machine, session.cwd, pyFiles);
}

/**
 * Whether a gate may run project code without a prompt: in a trusted folder,
 * or when the permission rules already allow that Bash command (an allow
 * rule, bypass mode). The regression gate follows the same rule.
 */
export async function mayRunProjectCommand(engine: Engine, session: Session, command: string): Promise<boolean> {
  if (engine.trust.isTrusted(session.cwd)) return true;
  try {
    const machine = engine.machineFor(session);
    const home = (await engine.machineHome(machine)) ?? '/';
    const verdict = checkPermission({
      tool: BashTool as never,
      input: { command },
      content: command,
      mode: session.permissionMode,
      rules: engine.permissionRulesFor(session),
      sessionAllow: [],
      cwd: session.cwd,
      home,
      workspaceRoots: [session.cwd],
    });
    return verdict.decision === 'allow';
  } catch {
    return false;
  }
}

export class VerifyGate {
  private states = new Map<string, GateState>();

  constructor(private engine: Engine) {}

  private state(id: string): GateState {
    let s = this.states.get(id);
    if (!s) {
      s = { dirty: false, pyFiles: new Set(), failures: 0, noticed: false, skippedNoticed: false };
      this.states.set(id, s);
      if (this.states.size > 2_000) this.states.delete(this.states.keys().next().value as string);
    }
    return s;
  }

  /** Whether the gate is on for this session's agent. */
  enabled(session: Session): boolean {
    if (session.kind === 'chat') return false;
    return wantsVerifyGate(this.engine.extensions.agent(session.agent, session.cwd));
  }

  /** The command for a session, or undefined when there is nothing to run. */
  commandFor(session: Session, pyFiles: string[]): Promise<string | undefined> {
    return verifyCommandFor(this.engine, session, pyFiles);
  }

  /** Whether the command may run without a prompt: a trusted folder, or the Bash rules allow it. */
  private mayRun(session: Session, command: string): Promise<boolean> {
    return mayRunProjectCommand(this.engine, session, command);
  }

  /** Run the check on the session's device. */
  async run(session: Session, command: string, signal?: AbortSignal): Promise<VerifyResult> {
    const r = await this.engine.machineFor(session).exec(command, { cwd: session.cwd, timeoutMs: TIMEOUT_MS, signal, maxOutputBytes: 200_000 });
    const out = [r.stdout, r.stderr].filter((s) => s && s.trim()).join('\n');
    const ok = r.exitCode === 0 && !r.timedOut;
    return { command, ok, exitCode: r.exitCode, ...(r.timedOut ? { timedOut: true } : {}), tail: tailLines(r.timedOut ? `${out}\n(timed out after ${TIMEOUT_MS / 1000} s)` : out, VERIFY_GATE_TAIL) };
  }

  /** A file tool changed something in this session. */
  noteEdit(sessionId: string, path?: string): void {
    const s = this.state(sessionId);
    s.dirty = true;
    if (path && /\.pyi?$/.test(path)) s.pyFiles.add(path);
  }

  /** A new user turn: the per-turn counters start again. */
  newTurn(sessionId: string): void {
    const s = this.states.get(sessionId);
    if (!s) return;
    s.failures = 0;
    s.noticed = false;
    // a failure from an earlier turn says nothing about this one
    s.last = undefined;
  }

  /**
   * The turn wants to end. Returns the reminder that sends the agent back, or
   * undefined to let it end.
   */
  async check(session: Session, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.enabled(session)) return undefined;
    const s = this.state(session.id);
    if (!s.dirty) {
      // the agent stopped without touching files after a failed check
      if (s.last && !s.last.ok && !s.noticed) {
        s.noticed = true;
        this.engine.notice(session.id, `The check \`${s.last.command}\` still fails.`, 'warning');
      }
      return undefined;
    }
    // the cap's notice went out with the last reminder
    if (s.failures >= VERIFY_GATE_MAX) return undefined;
    const py = [...s.pyFiles];
    let command: string | undefined;
    try {
      command = await this.commandFor(session, py);
    } catch (err) {
      log.warn('verify command lookup failed', err);
    }
    s.dirty = false;
    s.pyFiles.clear();
    if (!command) return undefined;
    if (!(await this.mayRun(session, command))) {
      if (!s.skippedNoticed) {
        s.skippedNoticed = true;
        this.engine.notice(session.id, `The verify gate did not run \`${command}\`: trust this folder, or allow that command, to check edits before the turn ends.`, 'info');
      }
      return undefined;
    }
    let res: VerifyResult;
    try {
      res = await this.run(session, command, signal);
    } catch (err) {
      // an offline device or a missing shell: nothing to say to the agent
      log.warn(`verify gate could not run ${command}`, err);
      return undefined;
    }
    this.engine.audit(session.id, 'verify.gate', `${command}: ${res.ok ? 'ok' : res.timedOut ? 'timed out' : `exit ${res.exitCode}`}`);
    // a check that could not run to the end says nothing about the edits: tell the owner once, do not send the agent back
    if (!res.ok && (res.timedOut || res.exitCode === 126 || res.exitCode === 127)) {
      if (!s.unrunNoticed) {
        s.unrunNoticed = true;
        const why = res.timedOut ? `it did not finish in ${TIMEOUT_MS / 1000} s` : `exit ${res.exitCode}: the command or a tool it needs is not on this device`;
        const fix = res.timedOut ? 'a quicker check' : 'a check this device can run';
        this.engine.notice(session.id, `The verify gate could not run \`${command}\` (${why}), so these edits were not checked. Set verifyCommand in .conclave/settings.json or the agent profile to ${fix}.`, 'warning');
      }
      return undefined;
    }
    s.last = { command, ok: res.ok };
    if (res.ok) return undefined;
    s.failures++;
    if (s.failures >= VERIFY_GATE_MAX && !s.noticed) {
      // the runner allows 3 continuations per turn, so this is the last time the gate can send it back
      s.noticed = true;
      this.engine.notice(session.id, `The verify gate sent the agent back ${VERIFY_GATE_MAX} times this turn because \`${command}\` failed. It checks again after your next message.`, 'warning');
    }
    return `The check \`${command}\` failed (exit ${res.exitCode ?? 'none'}) after your edits. Fix it before you finish, or say why it cannot pass. Last lines:\n${res.tail}`;
  }

  /** The runner extension for main sessions. */
  extension(): RunnerExtension {
    return {
      name: 'verify-gate',
      beforeStep: (ctx) => {
        if (ctx.iter === 0 && ctx.depth === 0) this.newTurn(ctx.sessionId);
      },
      afterTool: (ctx, _toolCtx, output) => {
        if (!ctx.tool.editsFiles || output.isError) return;
        // the path the tool wrote: an old path from before a move is mapped to the current folder
        const path = [output.meta?.path, ctx.input.file_path, ctx.input.notebook_path].find((p): p is string => typeof p === 'string');
        this.noteEdit(ctx.sessionId, path);
      },
      onStop: (ctx) => (ctx.depth === 0 ? this.check(ctx.session, ctx.signal) : undefined),
    };
  }

  /** The SubagentStop function hook for subagents. */
  async onSubagentStop(input: HookInput): Promise<Partial<HookOutcome> | undefined> {
    const child = input.agent_id ? this.engine.getSession(input.agent_id) : undefined;
    if (!child) return undefined;
    const reason = await this.check(child);
    return reason ? { blocked: true, reason } : undefined;
  }
}

/** Make the gate and register it with the runner and the hook runner. */
export function attachVerifyGate(engine: Engine, hooks?: Hooks): VerifyGate {
  const gate = new VerifyGate(engine);
  engine.runnerExtensions.register(gate.extension());
  hooks?.register('SubagentStop', (input) => gate.onSubagentStop(input), undefined, 'verify gate');
  return gate;
}
