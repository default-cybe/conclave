import type { Routine, RoutineRun } from '../types';

export interface RoutineInput {
  name: string;
  schedule: string;
  prompt: string;
  agent?: string;
  model?: string;
  mode?: Routine['mode'];
  cwd?: string;
  device?: string;
  timezone?: string;
  enabled?: boolean;
  sessionPolicy?: Routine['sessionPolicy'];
  notify?: Routine['notify'];
  /** Permission rules for this routine's sessions only. */
  allow?: string[];
  deny?: string[];
  /** Scheduled and webhook runs: "deny" (default) refuses calls that need approval and goes on; "wait" waits for the owner. */
  onApproval?: Routine['onApproval'];
  precheck?: string;
  env?: Record<string, string>;
  timeoutMin?: number;
  maxCostUsd?: number;
  /** Suggestion id this routine was made from. */
  suggestion?: string;
  /** Template id this routine was made from (templates.ts). Upgrades follow it. */
  template?: string;
  /** Run in code by the hub instead of an agent session (memory/digest.ts). */
  builtin?: Routine['builtin'];
  /** Make it a watch (watches/spec.ts checks it). null on update makes it a plain routine again. */
  watch?: Routine['watch'] | null;
}

/** Options for runNow. */
export interface RunNowOptions {
  /** Called once with the run as soon as it has started (with its session when the runner reports one), or with the finished or skipped run if it never got that far. */
  onStart?: (run: RoutineRun) => void;
}

export interface RoutineService {
  /** One account's routines; every account's when left out. */
  list(accountId?: string): Routine[];
  get(id: string): Routine | undefined;
  /** accountId: whose routine (docs/design/ACCOUNTS.md); left out, the account the work runs for. */
  create(input: RoutineInput, accountId?: string): Routine;
  update(id: string, patch: Partial<RoutineInput>): Routine;
  remove(id: string): void;
  runNow(id: string, trigger?: RoutineRun['trigger'], extra?: string, opts?: RunNowOptions): Promise<RoutineRun>;
  runs(id: string, limit?: number): RoutineRun[];
  /** Routines with a run going in this process now. */
  running?(): Routine[];
  /** Next N fire times for a schedule string (for the UI preview). */
  preview(schedule: string, timezone?: string, count?: number): number[];
  /** Built-in templates (morning brief, nightly librarian, watchdog...). */
  templates(): Array<RoutineInput & { id: string; description: string }>;
  /** Give a routine its template's current prompt and rules, also when its prompt was edited. */
  upgrade?(id: string): Routine;
}

/**
 * Durable job runner. Jobs survive restarts (stored in SQLite).
 * Kinds used by the engine: "session.resume" (after limit reset), "routine.fire".
 */
export interface Scheduler {
  start(): void;
  stop(): void;
  enqueue(kind: string, runAt: number, payload?: Record<string, unknown>, dedupeKey?: string): string;
  cancel(dedupeKey: string): void;
  handle(kind: string, fn: (payload: Record<string, unknown>) => Promise<void>): void;
  /** Wake the loop (after enqueueing something due soon). */
  poke(): void;
}
