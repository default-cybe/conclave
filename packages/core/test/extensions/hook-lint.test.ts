import { describe, test, expect } from 'bun:test';
import type { HooksConfig } from '../../src/config/schema';
import { bareMcpMatcher, lintHooks, wrapFlatEntries } from '../../src/extensions/hook-lint';

/** Hook lint (ECOSYSTEM.md 4.3 item 5): what loads as nothing, and how to fix it. */

describe('lintHooks', () => {
  test('a flat entry is an error with a fix that wraps it', () => {
    const raw = { PreToolUse: [{ matcher: 'Bash', type: 'command', command: 'parry-guard hook', timeout: 5 }] };
    const { issues, fixed } = lintHooks(raw);
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatchObject({ level: 'error', event: 'PreToolUse', group: 0 });
    expect(issues[0].text).toMatch(/loads as nothing/);
    const want: HooksConfig = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'parry-guard hook', timeout: 5 }] }] };
    expect(issues[0].fix).toEqual(want);
    expect(fixed).toEqual(want);
  });

  test('a flat entry with no type gets type command', () => {
    const { hooks, wrapped } = wrapFlatEntries({ Stop: [{ command: 'say done' }] });
    expect(wrapped).toBe(1);
    expect(hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] });
  });

  test('a timeout that looks like milliseconds is a warning with the seconds fix', () => {
    const { issues } = lintHooks({ PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt', timeout: 5000 }] }] });
    expect(issues[0].level).toBe('warn');
    expect(issues[0].text).toMatch(/did you mean 5\?/);
    expect((issues[0].fix!.PostToolUse![0].hooks[0] as { timeout: number }).timeout).toBe(5);
  });

  test('a bare mcp__server matcher matches nothing; the fix is mcp__server__.*', () => {
    const { issues } = lintHooks({ PreToolUse: [{ matcher: 'mcp__github', hooks: [{ type: 'command', command: 'x' }] }] }, { mcpServers: ['github'] });
    expect(issues.map((i) => i.text).join('\n')).toMatch(/Use "mcp__github__\.\*"/);
    expect(issues[0].fix!.PreToolUse![0].matcher).toBe('mcp__github__.*');
    expect(bareMcpMatcher('mcp__')).toBe('mcp__.*');
    expect(bareMcpMatcher('mcp__basic-memory__')).toBe('mcp__basic-memory__.*');
    expect(bareMcpMatcher('mcp__github__search_issues')).toBeUndefined();
    expect(bareMcpMatcher('mcp__github__.*')).toBeUndefined();
  });

  test('servers that are not set up are flagged', () => {
    const { issues } = lintHooks(
      {
        PreToolUse: [{ matcher: 'mcp__notion__.*', hooks: [{ type: 'command', command: 'x' }] }],
        SessionStart: [{ hooks: [{ type: 'mcp_tool', server: 'basic-memory', tool: 'search_notes' }] }],
      },
      { mcpServers: ['github'] },
    );
    expect(issues.map((i) => i.text)).toEqual([expect.stringMatching(/notion, which is not set up/), expect.stringMatching(/server basic-memory, which is not set up/)]);
  });

  test('server names with underscores are read whole (basic_memory, plugin servers)', () => {
    const hooks = {
      PreToolUse: [
        { matcher: 'mcp__basic_memory__.*', hooks: [{ type: 'command', command: 'x' }] },
        { matcher: 'mcp__plugin_ponytail_docs__.*', hooks: [{ type: 'command', command: 'y' }] },
      ],
    };
    expect(lintHooks(hooks, { mcpServers: ['basic_memory', 'plugin_ponytail_docs'] }).issues).toEqual([]);
    expect(lintHooks(hooks, { mcpServers: [] }).issues.map((i) => i.text)).toEqual([expect.stringMatching(/server basic_memory,/), expect.stringMatching(/server plugin_ponytail_docs,/)]);
  });

  test('an if rule the matcher can never let through, and if on a non-tool event', () => {
    const { issues } = lintHooks({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x', if: 'Edit(src/**)' }, { type: 'command', command: 'y', if: 'Bash(git push *)' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'z', if: 'Bash(*)' }] }],
    });
    expect(issues.length).toBe(2);
    expect(issues[0]).toMatchObject({ event: 'PreToolUse', handler: 0 });
    expect(issues[0].text).toMatch(/can never match/);
    expect(issues[1].text).toMatch(/ignored on Stop/);
  });

  test('a matcher on an event that ignores matchers, a bad regex and other CLIs\' event names', () => {
    const { issues } = lintHooks({
      UserPromptSubmit: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
      PostToolUse: [{ matcher: 'Edit(', hooks: [{ type: 'command', command: 'x' }] }],
      BeforeTool: [{ hooks: [{ type: 'command', command: 'x' }] }],
    });
    const texts = issues.map((i) => i.text);
    expect(texts[0]).toMatch(/UserPromptSubmit ignores matchers/);
    expect(texts[1]).toMatch(/not a valid regex/);
    expect(texts[2]).toMatch(/BeforeTool is another CLI's name for PreToolUse/);
    expect(issues[2].fix).toEqual({ ...issues[2].fix, PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] });
  });

  test('a clean list has no issues, and what Claude Code accepts stays as it is', () => {
    const raw = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.conclave/hooks/recipes/git-work-saver.sh', timeout: 10, if: 'Bash(git *)' }] }],
      PostToolUse: [{ matcher: 'mcp__github__.*', hooks: [{ type: 'command', command: 'x', timeout: 10 }] }],
    };
    const r = lintHooks(raw, { mcpServers: ['github'] });
    expect(r.issues).toEqual([]);
    expect(r.fixed).toEqual(raw as never);
  });
});
