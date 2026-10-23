/**
 * Workflow engine DTOs (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.17,
 * docs/WORKFLOWS.md). The hub side is packages/core/src/workflows.
 */

export type WorkflowRunStatus = 'queued' | 'running' | 'paused' | 'waiting_reset' | 'interrupted' | 'done' | 'failed' | 'stopped' | 'budget';
export type WorkflowCallState = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'cached' | 'parked';
export type WorkflowCallKind = 'agent' | 'check' | 'citation' | 'workflow' | 'ask';
/** Where a workflow came from. inline: a script the Workflow tool or the API sent. */
export type WorkflowSource = 'builtin' | 'plugin' | 'user' | 'project' | 'claude-code' | 'inline';
export type WorktreeState = 'live' | 'kept' | 'removed' | 'merged' | 'discarded';

export interface WorkflowPhaseDto {
  title: string;
  detail?: string;
  model?: string;
}

/** The script's `export const meta`. Unknown keys are kept. */
export interface WorkflowMetaDto {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhaseDto[];
  /** 'conclave': the script uses the Conclave layer (opts.conclave, lib, meta.permissions) and does not run in Claude Code. */
  runtime?: string;
  permissions?: { allow?: string[]; deny?: string[] };
  [key: string]: unknown;
}

/** GET /api/workflows: one row of the library. */
export interface WorkflowSummary {
  /** The name, or plugin:name for plugin workflows. */
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  phases: WorkflowPhaseDto[];
  source: WorkflowSource;
  path?: string;
  /** False when the script uses the Conclave layer. */
  portable: boolean;
  /** False when the script cannot load here; error says why. */
  runnable: boolean;
  error?: string;
  lastRun?: { id: string; status: WorkflowRunStatus; createdAt: number; finishedAt?: number };
}

export interface WorkflowDetail extends WorkflowSummary {
  script: string;
  meta?: WorkflowMetaDto;
}

export interface WorkflowCall {
  seq: number;
  kind: WorkflowCallKind;
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  effort?: string;
  state: WorkflowCallState;
  attempt: number;
  childSessionId?: string;
  /** The workflow() call this call ran under. */
  parentSeq?: number;
  lastTool?: string;
  /** A running call whose agent waits on the owner (a tool approval). */
  waiting?: 'approval';
  promptPreview?: string;
  resultPreview?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  worktree?: { branch: string; path?: string; commit?: string; state: WorktreeState; files?: number };
  /** Why it failed or was skipped. */
  error?: string;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowCounts {
  agents: number;
  queued: number;
  running: number;
  done: number;
  cached: number;
  failed: number;
  skipped: number;
  parked: number;
}

export interface WorkflowRun {
  id: string;
  name: string;
  description?: string;
  source: WorkflowSource;
  status: WorkflowRunStatus;
  /** The session that started it (the Workflow tool's session), if any. */
  sessionId?: string;
  device: string;
  cwd: string;
  phases: WorkflowPhaseDto[];
  /** Index into phases of the current phase, -1 before the first phase() call. */
  phaseIndex: number;
  phaseTitle?: string;
  budget?: { tokens?: number; costUsd?: number };
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  counts: WorkflowCounts;
  /** Path of the saved script on the hub, for scriptPath reruns. */
  scriptPath?: string;
  portable: boolean;
  background?: boolean;
  /**
   * The Workflow tool call (tool_use id) that started the run, when an agent
   * started it. A session's live card matches its tool call to the run with
   * it on the first workflow.run event, before the call returns.
   */
  toolUseId?: string;
  parentRunId?: string;
  resumedFrom?: string;
  /** waiting_reset: when the parked calls run again. */
  resumeAt?: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowLogLine {
  n: number;
  ts: number;
  text: string;
}

export type FindingVerdict = 'fixed' | 'dismissed' | 'ignored';

export interface WorkflowFinding {
  id: string;
  runId: string;
  workflow: string;
  project?: string;
  findingKey: string;
  file?: string;
  line?: number;
  title: string;
  priority?: string;
  proven: boolean;
  votes?: unknown;
  verdict?: FindingVerdict;
  reason?: string;
  data?: Record<string, unknown>;
  createdAt: number;
  decidedAt?: number;
}

export interface WorkflowRunDetail {
  run: WorkflowRun;
  meta?: WorkflowMetaDto;
  calls: WorkflowCall[];
  logs: WorkflowLogLine[];
  result?: unknown;
  findings: WorkflowFinding[];
  /** Findings refuted by verifiers divided by findings checked, when the run had a panel. */
  refutedRate?: number;
}

/** One agent in a WorkflowStatus answer. */
export interface WorkflowStatusAgent {
  seq: number;
  label: string;
  state: WorkflowCallState;
  /** Time it ran: to now while running, start to finish once it ended. Absent while queued. */
  elapsedMs?: number;
  /** The tool it called last, while running. */
  lastTool?: string;
  /** It waits on the owner (a tool approval). */
  waiting?: 'approval';
  error?: string;
}

/**
 * A run as it stands, for the WorkflowStatus tool (tools/workflow-status.ts),
 * which renders it as text for the model. The run's own account only.
 */
export interface WorkflowStatusView {
  runId: string;
  name: string;
  status: WorkflowRunStatus;
  /** Going in this hub process now. */
  live: boolean;
  background: boolean;
  /** The session that started it. */
  sessionId?: string;
  /** -1 before the first phase() call. */
  phaseIndex: number;
  /**
   * The script's phases in order, then any a call named that the meta did
   * not list, then "(no phase)" for agents that ran outside every phase.
   * state is by position: phases before the current one are done.
   */
  phases: Array<{ title: string; state: 'done' | 'current' | 'pending'; agents: WorkflowStatusAgent[] }>;
  counts: WorkflowCounts;
  tokens: { input: number; output: number };
  costUsd: number;
  budget?: { tokens?: number; costUsd?: number };
  /** The run's own error, then each failed or skipped call's (the newest 50 when there are more). */
  errors: Array<{ seq?: number; label?: string; error: string }>;
  /** All errors, including those left out of errors. */
  errorCount: number;
  /** The last log lines, oldest first. */
  logs: WorkflowLogLine[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Time it ran: to now while going, start to finish once it ended. */
  elapsedMs?: number;
  /** waiting_reset: when parked calls run again. */
  resumeAt?: number;
}

export interface StartWorkflowInput {
  /** A library workflow by id. */
  name?: string;
  /** An inline script. */
  script?: string;
  /** A script saved on the hub (a run's scriptPath, or under ~/.conclave/workflows). */
  scriptPath?: string;
  args?: unknown;
  sessionId?: string;
  device?: string;
  cwd?: string;
  budget?: { tokens?: number; costUsd?: number };
  resumeFromRunId?: string;
  /** Return at once; the result reaches the session as a <workflow_result> reminder. */
  background?: boolean;
}

export interface WorkflowRunsQuery {
  sessionId?: string;
  status?: WorkflowRunStatus;
  name?: string;
  limit?: number;
}

export type WorktreeAction = 'diff' | 'merge' | 'cherry-pick' | 'discard';

export interface WorktreeActionResult {
  ok: boolean;
  state: WorktreeState;
  /** The diff for 'diff', or the command output. */
  output: string;
}
