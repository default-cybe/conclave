import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPermission } from '../../src/session/permissions';
import { toolByName } from '../../src/tools';
import { startTestEngine, toolResults, until, type Block } from './harness';

/**
 * Hook events fired by the real engine at their call sites: SessionStart,
 * SessionEnd, PermissionRequest, Notification, SubagentStart, SubagentStop,
 * PreCompact and PostToolUse fields, plus where hooks come from (Claude user
 * settings, trusted project files).
 */

const bash = (command: string): Block => ({ tool: 'Bash', input: { command, description: 'test' } });
const ECHO_SERVER = join(import.meta.dir, '..', 'extensions', 'fixtures', 'mcp-echo-server.ts');

describe('session lifecycle hooks', () => {
  test('SessionStart fires once with startup, again after /clear; SessionEnd on clear and delete; Notification after a turn', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'one' }], [{ text: 'two' }], [{ text: 'three' }]],
      hooks: ({ hook }) => ({
        SessionStart: [{ hooks: [hook('context')] }],
        SessionEnd: [{ hooks: [hook('log')] }],
        Notification: [{ hooks: [hook('log')] }],
      }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'hi');
      expect(t.requests[0]).toContain('ctx for SessionStart startup');
      await t.run(s.id, 'again');
      const starts = () => t.hookLog().filter((l) => l.input.hook_event_name === 'SessionStart');
      expect(starts().map((l) => l.input.source)).toEqual(['startup']);
      expect(starts()[0].input.model).toBe('mock/claude-sonnet-5-5');

      await t.engine.command(s.id, '/clear');
      const ends = () => t.hookLog().filter((l) => l.input.hook_event_name === 'SessionEnd');
      expect(ends().map((l) => l.input.reason)).toEqual(['clear']);

      await t.run(s.id, 'after clear');
      expect(starts().map((l) => l.input.source)).toEqual(['startup', 'clear']);
      expect(t.requests[2]).toContain('ctx for SessionStart clear');

      // Notification is fire and forget
      expect(await until(() => t.hookLog().some((l) => l.input.hook_event_name === 'Notification' && l.input.notification_type === 'idle_prompt'))).toBe(true);

      await t.engine.deleteSession(s.id);
      expect(ends().map((l) => l.input.reason)).toEqual(['clear', 'other']);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a session on an existing conversation starts with source resume', async () => {
    const t = await startTestEngine({ script: [[{ text: 'one' }]], hooks: ({ hook }) => ({ SessionStart: [{ hooks: [hook('log')] }] }) });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'from before a restart' }] });
      await t.run(s.id, 'hi');
      expect(t.hookLog().map((l) => l.input.source)).toEqual(['resume']);
    } finally {
      await t.close();
    }
  }, 30_000);
});

describe('tool hooks', () => {
  test('PermissionRequest can allow or deny instead of the user; PostToolUse gets duration_ms and can replace the output', async () => {
    const t = await startTestEngine({
      script: [[bash('touch allow.txt')], [bash('touch deny.txt')], [bash('touch asked.txt')], [{ text: 'done' }]],
      hooks: ({ hook }) => ({
        PermissionRequest: [
          {
            matcher: 'Bash',
            hooks: [
              { ...hook('allow'), if: 'Bash(touch allow*)' } as never,
              { ...hook('deny'), if: 'Bash(touch deny*)' } as never,
            ],
          },
        ],
        PostToolUse: [{ matcher: 'Bash', hooks: [hook('replace')] }],
      }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'go');
      expect(existsSync(join(t.cwd, 'allow.txt'))).toBe(true);
      expect(existsSync(join(t.cwd, 'deny.txt'))).toBe(false);
      // only the call no hook answered reached the user
      expect(t.approvals).toHaveLength(1);
      expect(t.approvals[0]).toContain('asked.txt');

      const results = toolResults(t.engine, s.id);
      expect(results[0].content).toBe('replaced output');
      expect(results[1].content).toContain('denied by test hook');
      const post = t.hookLog().find((l) => l.input.hook_event_name === 'PostToolUse')!;
      expect(typeof post.input.duration_ms).toBe('number');
      const perm = t.hookLog().find((l) => l.input.hook_event_name === 'PermissionRequest')!;
      expect(perm.input.tool_name).toBe('Bash');
      expect(perm.input.tool_input.command).toBe('touch allow.txt');
    } finally {
      await t.close();
    }
  }, 60_000);

  test('PreCompact matches on its trigger and the next turn gets SessionStart compact', async () => {
    const big = 'x'.repeat(30_000);
    const t = await startTestEngine({
      // a 200k window keeps a 10k-token tail, so the first two turns get compacted
      modelOverrides: { 'claude-sonnet-5-5': { contextWindow: 200_000 } },
      script: [[{ text: 'a' }], [{ text: 'b' }], [{ text: 'c' }], [{ text: 'd' }]],
      hooks: ({ hook }) => ({
        PreCompact: [
          { matcher: 'manual', hooks: [hook('log')] },
          { matcher: 'auto', hooks: [hook('substop')] },
        ],
        SessionStart: [{ hooks: [hook('log')] }],
      }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      for (const p of [big, big, big]) await t.run(s.id, p);
      await t.engine.compact(s.id);
      const pre = t.hookLog().filter((l) => l.input.hook_event_name === 'PreCompact');
      expect(pre.map((l) => l.mode)).toEqual(['log']);
      expect(pre[0].input.trigger).toBe('manual');
      expect(t.engine.getMessages(s.id).some((m) => m.kind === 'summary')).toBe(true);
      await t.run(s.id, 'next');
      expect(t.hookLog().filter((l) => l.input.hook_event_name === 'SessionStart').map((l) => l.input.source)).toEqual(['startup', 'compact']);
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('subagent hooks', () => {
  test('SubagentStart adds context, hooks inside get agent_id, SubagentStop can send the subagent back once', async () => {
    const t = await startTestEngine({
      approve: 'allow',
      script: [
        [{ tool: 'Task', input: { subagent_type: 'explore', description: 'look around', prompt: 'list the folder' } }],
        [{ tool: 'LS', input: { path: '.' } }],
        [{ text: 'sub first' }],
        [{ text: 'PEAR' }],
        [{ text: 'final' }],
      ],
      hooks: ({ hook }) => ({
        SubagentStart: [{ matcher: 'explore', hooks: [hook('context')] }],
        SubagentStop: [{ matcher: 'explore', hooks: [hook('substop')] }],
        PreToolUse: [{ matcher: 'LS', hooks: [hook('log')] }],
        Stop: [{ hooks: [hook('log')] }],
      }),
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'go');
      const log = t.hookLog();
      const start = log.find((l) => l.input.hook_event_name === 'SubagentStart')!;
      expect(start.input.agent_type).toBe('explore');
      expect(start.input.session_id).toBe(s.id);
      const subId = start.input.agent_id as string;
      expect(subId).toStartWith('ses');
      expect(t.requests[1]).toContain('ctx for SubagentStart explore');

      const pre = log.find((l) => l.input.hook_event_name === 'PreToolUse')!;
      expect(pre.input.agent_id).toBe(subId);
      expect(pre.input.agent_type).toBe('explore');

      const stops = log.filter((l) => l.input.hook_event_name === 'SubagentStop');
      expect(stops.map((l) => [l.input.stop_hook_active, l.input.last_assistant_message])).toEqual([
        [false, 'sub first'],
        [true, 'PEAR'],
      ]);
      // the main agent saw the subagent's final answer; Stop fired only for the main agent
      expect(toolResults(t.engine, s.id).find((r) => r.name === 'Task')!.content).toContain('PEAR');
      const mainStops = log.filter((l) => l.input.hook_event_name === 'Stop');
      expect(mainStops).toHaveLength(1);
      expect(mainStops[0].input.session_id).toBe(s.id);
      expect(mainStops[0].input.last_assistant_message).toBe('final');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('hook sources and project trust', () => {
  test('~/.claude/settings.json hooks run; project hooks wait for trust and the user is told', async () => {
    const t = await startTestEngine({ script: [[{ text: 'one' }], [{ text: 'two' }]] });
    try {
      writeFileSync(join(t.claudeDir, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [t.hook('claude-user')] }] } }));
      mkdirSync(join(t.cwd, '.claude'), { recursive: true });
      writeFileSync(
        join(t.cwd, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [t.hook('project')] }] }, permissions: { allow: ['Bash(touch *)'] } }),
      );

      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'hi');
      expect(t.hookLog().map((l) => l.mode)).toEqual(['claude-user']);
      const notice = t.engine.getMessages(s.id).find((m) => m.kind === 'notice');
      expect(JSON.stringify(notice?.content)).toContain('1 hook and 1 allow rule');

      // allow rules from the untrusted folder do not count yet
      const before = await t.engine.checkTool({ tool: 'Bash', input: { command: 'touch a' }, cwd: t.cwd });
      expect(before.decision).toBe('ask');

      const overview = t.engine.hooksOverview(t.cwd);
      const groups = overview.events.find((e) => e.event === 'UserPromptSubmit')!.groups;
      expect(groups.map((g) => [g.source, g.active])).toEqual([
        ['claude-user', true],
        ['claude-project', false],
      ]);
      expect(overview.trust?.trusted).toBe(false);

      t.engine.setProjectTrust(t.cwd, true);
      await t.run(s.id, 'again');
      // handlers of one event run in parallel, so compare without order
      expect(t.hookLog().map((l) => l.mode).sort()).toEqual(['claude-user', 'claude-user', 'project']);
      const after = await t.engine.checkTool({ tool: 'Bash', input: { command: 'touch a' }, cwd: t.cwd });
      expect(after.decision).toBe('allow');
      expect(after.rule).toBe('Bash(touch *)');
      expect(after.ruleSource).toBe(join(t.cwd, '.claude', 'settings.json'));
    } finally {
      await t.close();
    }
  }, 60_000);

  test('permission rules written for Agent match the Task tool', () => {
    const task = toolByName('Task')!;
    const base = { tool: task, input: { subagent_type: 'explore', description: 'd', prompt: 'p' }, mode: 'default' as const, sessionAllow: [], cwd: '/tmp', home: '/root', workspaceRoots: ['/tmp'] };
    expect(checkPermission({ ...base, rules: { allow: [], deny: ['Agent'], ask: [] } }).decision).toBe('deny');
  });
});

describe('MCP tools in sessions', () => {
  test('tools from configured MCP servers reach the model and run', async () => {
    const t = await startTestEngine({
      script: [[{ tool: 'mcp__echo__echo', input: { text: 'hi' } }], [{ text: 'done' }]],
      overrides: { mcpServers: { echo: { command: 'bun', args: [ECHO_SERVER] } } },
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'use the echo tool');
      const tools = (JSON.parse(t.requests[0]).tools as Array<{ name: string }>).map((x) => x.name);
      expect(tools).toContain('mcp__echo__echo');
      expect(toolResults(t.engine, s.id)[0].content).toBe('echo: hi');
      expect(t.engine.listTools().some((x) => x.name === 'mcp__echo__write_note' && x.source === 'mcp' && x.server === 'echo')).toBe(true);
      const detail = await t.engine.toolsDetail({ cwd: t.cwd });
      const echo = detail.find((x) => x.name === 'mcp__echo__echo')!;
      expect(echo.kind).toBe('mcp');
      expect(echo.group).toBe('echo');
      expect(echo.permission.decision).toBe('allow');
      expect(detail.find((x) => x.name === 'mcp__echo__write_note')!.permission.decision).toBe('ask');
      // explore lists its tools, so MCP tools are not in it
      expect(echo.agents.find((a) => a.name === 'explore')).toEqual({ name: 'explore', visible: false, why: 'not in its tools list' });
      expect(echo.agents.find((a) => a.name === 'coder')?.visible).toBe(true);
    } finally {
      await t.close();
    }
  }, 60_000);
});
