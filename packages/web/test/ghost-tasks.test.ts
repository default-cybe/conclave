/**
 * The Background tasks card counts only what still runs on the hub
 * (ContextPanel.tsx TasksCard): a shell the transcript started but the hub
 * no longer holds (a restart ended it) is over, and so is a subagent whose
 * session the hub marked lost or done.
 */
import { describe, expect, test } from 'bun:test';
import type { ContentBlock, Message, Session, ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { backgroundShells, type HubShell } from '../src/features/chat/panel';
import { runningSubagents, subagentOf, taskCalls } from '../src/features/chat/liveTasks';

const NOW = 1_800_000_000_000;
let seq = 0;
const msg = (role: 'user' | 'assistant', content: ContentBlock[], at = NOW - 10 * 86_400_000): Message => ({ id: `m${++seq}`, sessionId: 's1', seq, role, kind: 'normal', content, createdAt: at }) as Message;
const use = (id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({ type: 'tool_use', id, name, input });
const res = (id: string, content: string, meta?: Record<string, unknown>, isError?: boolean): ToolResultBlock => ({ type: 'tool_result', toolUseId: id, content, ...(meta ? { meta } : {}), ...(isError ? { isError } : {}) });

const started = [
  msg('assistant', [use('b29', 'Bash', { command: 'bun test loader', run_in_background: true, description: 'Verify loader preservation' }), use('b7', 'Bash', { command: 'gh run watch', run_in_background: true, description: 'Watch release build' })]),
  msg('user', [res('b29', 'Command running in background with id bash_29.', { shellId: 'bash_29', background: true }), res('b7', 'Command running in background with id bash_7.', { shellId: 'bash_7', background: true })]),
];
const running = (list: ReturnType<typeof backgroundShells>) => list.filter((s) => s.state === 'running').map((s) => s.id);

describe('background shells against the hub', () => {
  test('the transcript says running but the hub holds none (a restart ended them): not running, gone', () => {
    const list = backgroundShells(started, []);
    expect(running(list)).toEqual([]);
    expect(list.map((s) => s.state)).toEqual(['gone', 'gone']);
  });

  test('a new bash_7 after a restart does not make the old one run: matched by the call that started it', () => {
    const hub: HubShell[] = [{ id: 'bash_7', command: 'sleep 100', toolUseId: 'new', status: 'running', startedAt: NOW }];
    const list = backgroundShells(started, hub);
    expect(list.find((s) => s.toolUseId === 'b7')?.state).toBe('gone');
    // the hub's own shell is listed, though the transcript (compacted) has no call for it
    expect(list.find((s) => s.toolUseId === 'new')).toMatchObject({ id: 'bash_7', state: 'running' });
  });

  test('the hub says how each one is', () => {
    const hub: HubShell[] = [
      { id: 'bash_29', command: 'bun test loader', toolUseId: 'b29', status: 'running', startedAt: NOW },
      { id: 'bash_7', command: 'gh run watch', toolUseId: 'b7', status: 'completed', startedAt: NOW },
    ];
    const list = backgroundShells(started, hub);
    expect(running(list)).toEqual(['bash_29']);
    expect(list.find((s) => s.id === 'bash_7')?.state).toBe('completed');
  });

  test('BashOutput answering "No background shell" ends it, even without the hub list', () => {
    const list = backgroundShells([
      ...started,
      msg('assistant', [use('o', 'BashOutput', { bash_id: 'bash_7' })]),
      msg('user', [res('o', 'No background shell "bash_7" in this session. No background shells have been started.', undefined, true)]),
    ]);
    expect(running(list)).toEqual(['bash_29']);
    expect(list.find((s) => s.id === 'bash_7')?.state).toBe('gone');
  });
});

describe('subagents against the hub', () => {
  const session = (p: Partial<Session> & { id: string }): Session => ({ title: '', agent: 'builder', model: 'm', mode: 'agent', permissionMode: 'default', cwd: '~', device: 'local', status: 'idle', tags: [], pinned: false, archived: false, createdAt: NOW - 5 * 86_400_000, updatedAt: NOW, stats: { messages: 4, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, ...p }) as Session;
  const task = use('t1', 'Task', { description: 'Fix main failing test shard', subagent_type: 'builder', run_in_background: true });
  const bgResult = res('t1', 'Started background subagent c1.', { sessionId: 'c1', agent: 'builder', background: true });

  test('a background child the hub marked lost is not running, whatever its status says', () => {
    const child = session({ id: 'c1', parentId: 's1', title: 'Fix main failing test shard', status: 'paused', meta: { background: { parentId: 's1', state: 'lost' } } });
    expect(subagentOf({ tool: task, result: bgResult }, { sessionId: 's1', status: 'idle', sessions: { c1: child } }).state).toBe('done');
    const calls = taskCalls([msg('assistant', [task]), msg('user', [bgResult])]);
    expect(runningSubagents({ sessionId: 's1', status: 'running', calls, tools: {}, sessions: { c1: child } })).toEqual([]);
  });

  test('a call a restart cut (no result) whose child has ended is not running while the parent works on', () => {
    const fg = use('t2', 'Task', { description: 'Finish PR 162 imported chats', subagent_type: 'builder' });
    const child = session({ id: 'c2', parentId: 's1', title: 'Finish PR 162 imported chats', status: 'idle' });
    const calls = taskCalls([msg('assistant', [fg])]);
    expect(runningSubagents({ sessionId: 's1', status: 'running', calls, tools: {}, sessions: { c2: child } })).toEqual([]);
    // its child made but not started yet: the parent's turn still runs it
    const fresh = { ...child, stats: { ...child.stats, messages: 0 } };
    expect(runningSubagents({ sessionId: 's1', status: 'running', calls, tools: {}, sessions: { c2: fresh } }).length).toBe(1);
  });

  test('a background child still running on the hub counts', () => {
    const child = session({ id: 'c1', parentId: 's1', title: 'Fix main failing test shard', status: 'running', meta: { background: { parentId: 's1', state: 'running' } } });
    expect(subagentOf({ tool: task, result: bgResult }, { sessionId: 's1', status: 'idle', sessions: { c1: child } }).state).toBe('running');
  });
});
