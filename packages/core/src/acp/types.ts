import type { ApprovalRequest, ApprovalResponse, ContentBlock, LimitWindow, Usage } from '../types';
import type { Machine } from '../machine/types';
import type { McpServerConfig } from '../config/schema';
import type { Effort, EffortSetting } from '../providers/effort';

/**
 * External agent harnesses (Claude Code, Codex, Gemini CLI, OpenCode, Goose...)
 * driven over the Agent Client Protocol. The harness runs its own loop and
 * tools; Conclave shows its stream, answers its permission prompts (from your
 * phone if you like) and stores the transcript next to native turns.
 */
export interface HarnessTurnOptions {
  /** Provider id from config (e.g. "claude-code"). */
  harness: string;
  /** Model hint for the harness ("default" means let the harness pick). */
  model?: string;
  /**
   * Effort for the turn (the session's switch or the agent's). Set through the
   * harness's own Effort option (an ACP select of category thought_level) when
   * it has one, at the nearest level it offers; unset leaves the harness's default.
   */
  effort?: EffortSetting;
  machine: Machine;
  /** The account the turn runs for. A pooled harness process serves one account only (docs/design/ACCOUNTS.md 5). */
  owner?: string;
  cwd: string;
  /** The user prompt for this turn. */
  prompt: ContentBlock[];
  /** Earlier conversation rendered as text when the harness has no session yet (handoff or second opinion). */
  priorContext?: string;
  /** Existing harness session id to continue. */
  resumeId?: string;
  /** Extra env (gateway base URLs, keys). */
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  /** readonly: deny every edit/execute request automatically. */
  permission: 'ask' | 'readonly' | 'auto';
  signal: AbortSignal;
  /** Route harness permission prompts into Conclave approvals. */
  requestApproval(req: Omit<ApprovalRequest, 'id' | 'createdAt' | 'sessionId'>): Promise<ApprovalResponse>;
}

export type HarnessEvent =
  | { type: 'session'; id: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; title: string; kind?: string; input: Record<string, unknown> }
  | { type: 'tool_update'; id: string; status: 'pending' | 'in_progress' | 'completed' | 'failed'; output?: string; diff?: { path: string; oldText?: string; newText: string } }
  | { type: 'plan'; entries: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: string }> }
  | { type: 'usage'; usage: Partial<Usage>; model?: string }
  /** The Effort levels the harness offers for the turn's model (none: it has no Effort option). */
  | { type: 'effort'; levels: Effort[] }
  /** The models the harness offers on its account (its model option, or the older session models list). */
  | { type: 'models'; models: HarnessModel[] }
  | { type: 'rate_limit'; windows: LimitWindow[] }
  | { type: 'done'; stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error'; error?: string };

/** A model a harness offers, as its ACP agent reports it: the id it takes, and its name. */
export interface HarnessModel {
  id: string;
  name?: string;
}

export interface HarnessAdapter {
  /** Check that the harness can start on a machine. */
  probe(harness: string, machine: Machine): Promise<{ ok: boolean; version?: string; detail?: string }>;
  /**
   * Ask the harness which models its account offers: start it, open a
   * session in the home folder, read its model option, end it. For Refresh
   * models; a turn reports the same list on its own.
   */
  listModels?(harness: string, machine: Machine): Promise<HarnessModel[]>;
  runTurn(opts: HarnessTurnOptions): AsyncIterable<HarnessEvent>;
  /** Close idle harness processes. */
  shutdown(): Promise<void>;
  /** End idle processes on one machine that hold these harness sessions (a session moved away). */
  endSessions?(machineId: string, harnessSessionIds: string[]): number;
}
