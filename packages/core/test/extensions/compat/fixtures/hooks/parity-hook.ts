#!/usr/bin/env bun
/**
 * One hook script for the hook parity runs. The same file runs under real
 * Claude Code and under Conclave's Hooks runner, so the two can be compared.
 *
 *   bun parity-hook.ts <mode>
 *
 * Every call appends {mode, input, env} as one JSON line to $HOOK_LOG when set.
 */
import { appendFileSync } from 'node:fs';

const mode = process.argv[2] ?? '';
const raw = await Bun.stdin.text();
let input: Record<string, any> = {};
try {
  input = JSON.parse(raw);
} catch {
  input = { _raw: raw };
}

const log = process.env.HOOK_LOG;
if (log) {
  const env = {
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
    CLAUDE_ENV_FILE: process.env.CLAUDE_ENV_FILE ? 'set' : null,
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null,
  };
  appendFileSync(log, JSON.stringify({ mode, input, env }) + '\n');
}

const out = (v: unknown) => {
  process.stdout.write(JSON.stringify(v));
  process.exit(0);
};
const pre = (fields: Record<string, unknown>) => out({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } });

switch (mode) {
  case 'pretool': {
    const cmd = String(input.tool_input?.command ?? '');
    if (cmd.includes('cg-exit2')) {
      process.stderr.write('cg-exit2 is not allowed here');
      process.exit(2);
    }
    if (cmd.includes('cg-deny')) pre({ permissionDecision: 'deny', permissionDecisionReason: 'cg-deny refused by policy' });
    if (cmd.includes('cg-ask')) pre({ permissionDecision: 'ask', permissionDecisionReason: 'cg-ask needs a human' });
    if (cmd.includes('cg-allow')) pre({ permissionDecision: 'allow', permissionDecisionReason: 'cg-allow pre-approved' });
    if (cmd.includes('cg-rewrite')) pre({ updatedInput: { ...input.tool_input, command: 'echo cg-rewritten-by-hook' } });
    process.exit(0);
  }
  case 'posttool': {
    const cmd = String(input.tool_input?.command ?? '');
    if (cmd.includes('cg-post2')) {
      process.stderr.write('cg-post2 output looked wrong');
      process.exit(2);
    }
    if (cmd.includes('cg-postctx')) out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Note from hook: the post codeword is FIG.' } });
    process.exit(0);
  }
  case 'block-always':
    process.stderr.write('blocked by the if-filtered hook');
    process.exit(2);
  case 'prompt-json':
    out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'The second codeword is KIWI.' } });
  case 'prompt-plain':
    process.stdout.write('The second codeword is KIWI.\n');
    process.exit(0);
  case 'session-json':
    out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'The first codeword is PLUM.' } });
  case 'session-plain':
    process.stdout.write('The first codeword is PLUM.\n');
    process.exit(0);
  case 'stop':
    if (!input.stop_hook_active) out({ decision: 'block', reason: 'Before finishing, write the word MANGO on its own line.' });
    process.exit(0);
  default:
    process.exit(0);
}
