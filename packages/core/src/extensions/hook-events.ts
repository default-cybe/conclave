/**
 * What each hook event is for and what a hook there can do, as the Hooks page
 * shows it. Only what Conclave really does: every event here is fired by the
 * engine (call sites below), and every stdout field is read by the runner
 * (extensions/hooks.ts) and then used by that event's caller.
 * test/extensions/hook-events.test.ts keeps this table and the code in step.
 *
 * Where each stdout field is read, in extensions/hooks.ts:
 *   continue, stopReason, systemMessage, decision, reason, additionalContext: applyJsonOutput (top level)
 *   hookSpecificOutput.permissionDecision, .permissionDecisionReason, .updatedInput,
 *   .updatedToolOutput, .updatedMCPToolOutput, .additionalContext: applyJsonOutput (hookSpecificOutput)
 *   hookSpecificOutput.decision.behavior, .message, .updatedInput: applyBehavior
 *   exit codes and plain stdout: Hooks.runCommand (STDOUT_IS_CONTEXT for plain stdout)
 * Pure data: the web app imports it.
 */
import type { HookEvent } from '../config/schema';

export type HookEventPhase = 'before' | 'after' | 'other';

export interface HookEventDoc {
  phase: HookEventPhase;
  /** When it fires, one line. */
  when: string;
  /** Main fields of the stdin JSON besides session_id, cwd, hook_event_name, permission_mode and conclave. */
  stdin: string[];
  /** What exit 2 does here. Exit 0 always lets things go on and reads stdout. */
  exit2: string;
  /** What plain (non-JSON) stdout does on exit 0, when it does anything. */
  plainStdout?: string;
  /** The stdout JSON fields this event's caller acts on, with what each does. */
  stdout: Array<{ field: string; does: string }>;
}

/** Fields every event's stdin holds (engine.ts runHook). */
export const HOOK_STDIN_COMMON = ['session_id', 'cwd', 'hook_event_name', 'permission_mode', 'conclave'] as const;

/** Any exit code other than 0 and 2 (Hooks.runCommand, failClosed). */
export const HOOK_OTHER_EXIT = 'A failure: the action goes on, and the run log shows the first line of stderr. With "onFailure": "block" the action is blocked instead.';

const TOOL_IN = ['tool_name', 'tool_input', 'tool_use_id'];

export const HOOK_EVENT_DOCS: Record<HookEvent, HookEventDoc> = {
  // session/runner.ts: before the first message of a run, after /clear and after a compaction
  SessionStart: {
    phase: 'before',
    when: 'When a session starts or resumes, and again after /clear or a compaction.',
    stdin: ['source (startup, resume, clear, compact)', 'model'],
    exit2: 'Nothing extra: the session starts anyway.',
    plainStdout: 'Added to the model context (12,000 chars across all SessionStart hooks).',
    stdout: [
      { field: 'additionalContext', does: 'Text added to the model context.' },
      { field: 'systemMessage', does: 'Shown to you in the session.' },
    ],
  },
  // session/runner.ts: before your message is sent (not for automatic turns)
  UserPromptSubmit: {
    phase: 'before',
    when: 'Before your message reaches the model.',
    stdin: ['prompt'],
    exit2: 'Blocks the message; stderr is shown to you as the reason.',
    plainStdout: 'Added to the model context (2,000 chars per hook).',
    stdout: [
      { field: 'decision', does: '"block" stops the message.' },
      { field: 'reason', does: 'Why it was blocked, shown to you.' },
      { field: 'additionalContext', does: 'Text added to the model context.' },
      { field: 'systemMessage', does: 'Shown to you in the session.' },
    ],
  },
  // session/runner.ts executeTool: before the permission check
  PreToolUse: {
    phase: 'before',
    when: 'Before a tool runs, before the permission check.',
    stdin: TOOL_IN,
    exit2: 'Blocks the call; stderr goes to the model as the reason.',
    stdout: [
      { field: 'decision', does: '"block" or "deny" blocks, "allow" skips the approval prompt, "ask" forces one.' },
      { field: 'reason', does: 'Why, sent to the model when blocked.' },
      { field: 'hookSpecificOutput.permissionDecision', does: '"allow", "deny" or "ask", as decision. A deny rule still wins over allow.' },
      { field: 'hookSpecificOutput.permissionDecisionReason', does: 'Why, sent to the model when denied.' },
      { field: 'hookSpecificOutput.updatedInput', does: 'Replaces the tool input. The call can only get stricter, never skip a rule.' },
      { field: 'additionalContext', does: 'Text sent to the model with the tool result.' },
    ],
  },
  // session/runner.ts executeTool: only when Conclave would ask you to approve
  PermissionRequest: {
    phase: 'before',
    when: 'When Conclave is about to ask you to approve a tool call.',
    stdin: TOOL_IN,
    exit2: 'Denies the call for you.',
    stdout: [
      { field: 'hookSpecificOutput.decision.behavior', does: '"allow" approves for you, "deny" refuses. In an untrusted folder only deny counts.' },
      { field: 'hookSpecificOutput.decision.message', does: 'Why it was denied, sent to the model.' },
      { field: 'hookSpecificOutput.decision.updatedInput', does: 'Replaces the tool input when it allows.' },
      { field: 'hookSpecificOutput.permissionDecision', does: '"allow" or "deny", same as behavior.' },
    ],
  },
  // engine/subagent.ts: in the parent session, before the subagent's first message
  SubagentStart: {
    phase: 'before',
    when: 'When a subagent starts, before its first message.',
    stdin: ['agent_id', 'agent_type'],
    exit2: 'Nothing extra: the subagent starts anyway.',
    stdout: [{ field: 'additionalContext', does: "Text added to the subagent's first message (12,000 chars across all hooks)." }],
  },
  // session/compaction.ts: before the summary is written
  PreCompact: {
    phase: 'before',
    when: 'Before old messages are summarized, by /compact or automatically.',
    stdin: ['trigger (manual, auto)', 'custom_instructions'],
    exit2: 'Skips this compaction.',
    stdout: [{ field: 'decision', does: '"block" skips this compaction.' }],
  },
  // session/runner.ts: after the tool ran without an error
  PostToolUse: {
    phase: 'after',
    when: 'After a tool succeeds, before the model sees the result.',
    stdin: [...TOOL_IN, 'tool_response', 'duration_ms', 'conclave.output_text'],
    exit2: 'stderr is added to the result as feedback for the model.',
    stdout: [
      { field: 'decision', does: '"block" adds the reason to the result as feedback.' },
      { field: 'reason', does: 'The feedback the model sees.' },
      { field: 'additionalContext', does: 'Text added to the result for the model.' },
      { field: 'hookSpecificOutput.updatedToolOutput', does: 'Replaces the result the model sees (updatedMCPToolOutput too).' },
      { field: 'continue', does: 'false ends the turn after this tool.' },
      { field: 'stopReason', does: 'Why the turn ended.' },
    ],
  },
  // session/runner.ts: after the tool ran with an error
  PostToolUseFailure: {
    phase: 'after',
    when: 'After a tool fails, before the model sees the error.',
    stdin: [...TOOL_IN, 'tool_response', 'error', 'duration_ms'],
    exit2: 'stderr is added to the error as feedback for the model.',
    stdout: [
      { field: 'decision', does: '"block" adds the reason to the error as feedback.' },
      { field: 'reason', does: 'The feedback the model sees.' },
      { field: 'additionalContext', does: 'Text added to the error for the model.' },
      { field: 'hookSpecificOutput.updatedToolOutput', does: 'Replaces the error text the model sees.' },
      { field: 'continue', does: 'false ends the turn after this tool.' },
      { field: 'stopReason', does: 'Why the turn ended.' },
    ],
  },
  // session/runner.ts: when the model answers without a tool call (top-level sessions only)
  Stop: {
    phase: 'after',
    when: 'When the agent is about to finish its turn.',
    stdin: ['stop_hook_active', 'last_assistant_message'],
    exit2: 'The agent keeps going with stderr as feedback, at most 3 times a turn.',
    stdout: [
      { field: 'decision', does: '"block" keeps the agent going, at most 3 times a turn.' },
      { field: 'reason', does: 'Needed with block: the feedback the agent gets.' },
    ],
  },
  // engine/subagent.ts: when a subagent's run ends, in the parent session
  SubagentStop: {
    phase: 'after',
    when: 'When a subagent is about to finish.',
    stdin: ['agent_id', 'agent_type', 'stop_hook_active', 'last_assistant_message'],
    exit2: 'The subagent keeps going with stderr as feedback, at most 3 times.',
    stdout: [
      { field: 'decision', does: '"block" keeps the subagent going, at most 3 times.' },
      { field: 'reason', does: 'Needed with block: the feedback the subagent gets.' },
    ],
  },
  // engine/commands.ts (/clear) and engine/engine.ts (delete, hub stop)
  SessionEnd: {
    phase: 'after',
    when: 'When a session is cleared or deleted, or the hub stops.',
    stdin: ['reason (clear, other)'],
    exit2: 'Nothing: the session ends anyway.',
    stdout: [],
  },
  // engine/engine.ts notifyEvent: whether or not a notification channel is on
  Notification: {
    phase: 'other',
    when: 'When Conclave notifies you: an approval waits, a session is done, an error.',
    stdin: ['notification_type (permission_prompt, idle_prompt, ...)', 'message', 'title'],
    exit2: 'Nothing: output is not read.',
    stdout: [],
  },
};

export const HOOK_PHASE_WORDS: Record<HookEventPhase, string> = {
  before: 'Before',
  after: 'After',
  other: 'Other',
};
