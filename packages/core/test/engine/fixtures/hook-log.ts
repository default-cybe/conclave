#!/usr/bin/env bun
/**
 * Hook script for the engine tests. Appends {mode, input} as one JSON line to
 * $HOOK_LOG, then answers according to the mode:
 *
 *   log      nothing
 *   context  additionalContext "ctx for <event> <source>"
 *   allow    PermissionRequest decision allow
 *   deny     PermissionRequest decision deny
 *   substop  block the first stop (stop_hook_active false) with "Say PEAR too."
 *   replace  PostToolUse updatedToolOutput "replaced output"
 */
import { appendFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'log';
const raw = await Bun.stdin.text();
let input: Record<string, any> = {};
try {
  input = JSON.parse(raw);
} catch {
  input = { _raw: raw };
}
if (process.env.HOOK_LOG) appendFileSync(process.env.HOOK_LOG, JSON.stringify({ mode, input }) + '\n');

const out = (v: unknown) => {
  process.stdout.write(JSON.stringify(v));
  process.exit(0);
};
const event = String(input.hook_event_name ?? '');

switch (mode) {
  case 'context':
    out({ hookSpecificOutput: { hookEventName: event, additionalContext: `ctx for ${event} ${input.source ?? input.agent_type ?? ''}`.trim() } });
  case 'allow':
    out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  case 'deny':
    out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'denied by test hook' } } });
  case 'substop':
    if (!input.stop_hook_active) out({ decision: 'block', reason: 'Say PEAR too.' });
    process.exit(0);
  case 'replace':
    out({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'replaced output' } });
  default:
    process.exit(0);
}
