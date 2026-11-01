import { describe, test, expect } from 'bun:test';
import { Hooks, matcherMatches, mergeOutcomes } from '../../src/extensions/hooks';
import type { HookInput } from '../../src/extensions/types';
import type { HooksConfig } from '../../src/config/schema';

function input(over: Partial<HookInput> = {}): HookInput {
  return { session_id: 's1', cwd: process.cwd(), hook_event_name: 'PreToolUse', ...over };
}

describe('matcherMatches', () => {
  test('star and empty match all', () => {
    expect(matcherMatches('*', 'Bash')).toBe(true);
    expect(matcherMatches('', 'Bash')).toBe(true);
    expect(matcherMatches(undefined, 'Bash')).toBe(true);
  });
  test('exact and pipe/comma lists', () => {
    expect(matcherMatches('Bash', 'Bash')).toBe(true);
    expect(matcherMatches('Bash', 'Edit')).toBe(false);
    expect(matcherMatches('Edit|Write', 'Write')).toBe(true);
    expect(matcherMatches('Edit, Write', 'Edit')).toBe(true);
  });
  test('regex for other characters', () => {
    expect(matcherMatches('mcp__github__.*', 'mcp__github__search')).toBe(true);
    expect(matcherMatches('^Edit$', 'NotebookEdit')).toBe(false);
    expect(matcherMatches('Edit.*', 'NotebookEdit')).toBe(true);
  });
  test('no value means every hook fires', () => {
    expect(matcherMatches('Bash', undefined)).toBe(true);
  });
});

describe('mergeOutcomes precedence', () => {
  test('deny beats ask beats allow and blocks', () => {
    const merged = mergeOutcomes([
      { blocked: false, additionalContext: ['a'], systemMessages: [], permissionDecision: 'allow' },
      { blocked: false, additionalContext: [], systemMessages: [], permissionDecision: 'ask' },
      { blocked: false, additionalContext: ['b'], systemMessages: [], permissionDecision: 'deny' },
    ]);
    expect(merged.permissionDecision).toBe('deny');
    expect(merged.blocked).toBe(true);
    expect(merged.additionalContext).toEqual(['a', 'b']);
  });
});

describe('command hook exit codes', () => {
  const hooks = new Hooks();

  function cfg(command: string, event = 'PreToolUse'): HooksConfig {
    return { [event]: [{ hooks: [{ type: 'command', command }] }] } as HooksConfig;
  }

  test('exit 0 with plain stdout is context only for UserPromptSubmit', async () => {
    const out = await hooks.run('UserPromptSubmit', input({ hook_event_name: 'UserPromptSubmit' }), {
      hooks: cfg('echo hello there', 'UserPromptSubmit'),
    });
    expect(out.additionalContext).toEqual(['hello there']);
    expect(out.blocked).toBe(false);
  });

  test('exit 0 plain stdout ignored for PreToolUse', async () => {
    const out = await hooks.run('PreToolUse', input(), { hooks: cfg('echo noise') });
    expect(out.additionalContext).toEqual([]);
  });

  test('exit 2 blocks with stderr as reason', async () => {
    const out = await hooks.run('PreToolUse', input(), { hooks: cfg('echo nope 1>&2; exit 2') });
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe('nope');
  });

  test('other exit codes are non-blocking errors', async () => {
    const out = await hooks.run('PreToolUse', input(), { hooks: cfg('echo bad 1>&2; exit 1') });
    expect(out.blocked).toBe(false);
    expect(out.systemMessages.join(' ')).toContain('bad');
  });

  test('JSON permissionDecision deny', async () => {
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked by policy' } });
    const out = await hooks.run('PreToolUse', input(), { hooks: cfg(`echo '${json}'`) });
    expect(out.permissionDecision).toBe('deny');
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe('blocked by policy');
  });

  test('JSON updatedInput and additionalContext', async () => {
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'ls -a' }, additionalContext: 'extra note' } });
    const out = await hooks.run('PreToolUse', input(), { hooks: cfg(`echo '${json}'`) });
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput).toEqual({ command: 'ls -a' });
    expect(out.additionalContext).toEqual(['extra note']);
  });

  test('legacy decision approve/block and continue false', async () => {
    const block = await hooks.run('Stop', input({ hook_event_name: 'Stop' }), { hooks: cfg(`echo '${JSON.stringify({ decision: 'block', reason: 'keep going' })}'`, 'Stop') });
    expect(block.blocked).toBe(true);
    expect(block.reason).toBe('keep going');
    const stop = await hooks.run('Stop', input({ hook_event_name: 'Stop' }), { hooks: cfg(`echo '${JSON.stringify({ continue: false, stopReason: 'done' })}'`, 'Stop') });
    expect(stop.stop?.reason).toBe('done');
  });

  test('top-level additional_context snake_case is read', async () => {
    const json = JSON.stringify({ additional_context: 'snake note' });
    const out = await hooks.run('SessionStart', input({ hook_event_name: 'SessionStart' }), { hooks: cfg(`echo '${json}'`, 'SessionStart') });
    expect(out.additionalContext).toEqual(['snake note']);
  });

  test('matcher filters which command runs', async () => {
    const config: HooksConfig = {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } })}'` }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })}'` }] },
      ],
    };
    const out = await hooks.run('PreToolUse', input({ tool_name: 'Edit' }), { matcherValue: 'Edit', hooks: config });
    expect(out.permissionDecision).toBe('allow');
    expect(out.blocked).toBe(false);
  });
});

describe('prompt hooks', () => {
  test('uses injected complete and parses decision', async () => {
    const hooks = new Hooks({ complete: async () => JSON.stringify({ decision: 'block', reason: 'nope' }) });
    const out = await hooks.run('PreToolUse', input(), { hooks: { PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'judge this' }] }] } });
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe('nope');
  });
});

describe('in-process register', () => {
  test('registered fn contributes to the outcome', async () => {
    const hooks = new Hooks();
    const off = hooks.register('PreToolUse', () => ({ additionalContext: ['injected'] }));
    const out = await hooks.run('PreToolUse', input(), { hooks: {} });
    expect(out.additionalContext).toEqual(['injected']);
    off();
    const after = await hooks.run('PreToolUse', input(), { hooks: {} });
    expect(after.additionalContext).toEqual([]);
  });
});
