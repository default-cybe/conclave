/**
 * TaskList, TaskWait, TaskResult and TaskContinue over the background
 * subagents a session started with Task (HARNESS-REVIEW item 21). They are
 * offered once the session has started one (engine.toolsFor), so sessions
 * that never use background tasks do not pay for their schemas.
 */
import type { Tool } from './types';
import type { TaskInfo } from '../engine/background';
import { fail } from './util';

/** What the tools need from the engine (engine/background.ts). */
export interface TaskHost {
  list(parentId: string): TaskInfo[];
  wait(parentId: string, ids: string[] | undefined, timeoutSec: number, signal?: AbortSignal): Promise<{ tasks: TaskInfo[]; finished: string[] }>;
  result(parentId: string, id: string): { task: TaskInfo; text: string } | undefined;
  continue(parentId: string, id: string, text: string): TaskInfo | string;
}

function line(t: TaskInfo): string {
  const took = t.finishedAt && t.startedAt ? `, ${Math.max(1, Math.round((t.finishedAt - t.startedAt) / 1000))} s` : '';
  return `- ${t.id} ${t.state} (${t.agent}: ${t.description}${took})`;
}

const none = () => fail('This session has no background tasks. Start one with Task and run_in_background.');

export const TaskListTool: Tool<Record<string, never>> = {
  name: 'TaskList',
  description: 'List the background tasks (subagents started with Task and run_in_background) of this session: id, state (running, paused, completed, failed, lost) and what each one does.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  summarize: () => 'TaskList',
  async run(_input, ctx) {
    const tasks = ctx.host.tasks?.list(ctx.sessionId) ?? [];
    if (!tasks.length) return none();
    return { content: `${tasks.length} background tasks:\n${tasks.map(line).join('\n')}` };
  },
};

export interface TaskWaitInput {
  ids?: string[];
  timeoutSec?: number;
}

export const TaskWaitTool: Tool<TaskWaitInput> = {
  name: 'TaskWait',
  description:
    'Wait until one of your running background tasks finishes or is paused by the owner, then return the state of each. A paused task continues only when the owner resumes it. ids limits it to those tasks. timeoutSec is at most 300; 0 returns the states at once. A finished task\'s report arrives in a <subagent_result> block; TaskResult reads it again.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Task ids (session ids) to wait for; default all running ones' },
      timeoutSec: { type: 'number', description: 'Seconds to wait, at most 300 (default 60); 0 for a snapshot' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (input) => `TaskWait${input.ids?.length ? ` ${input.ids.join(', ')}` : ''}`,
  async run(input, ctx) {
    const host = ctx.host.tasks;
    if (!host?.list(ctx.sessionId).length) return none();
    const { tasks, finished } = await host.wait(ctx.sessionId, input.ids, input.timeoutSec ?? 60, ctx.signal);
    if (!tasks.length) return fail(`No background task with id ${input.ids?.join(', ')} in this session.`);
    const head = finished.length ? `Finished while waiting: ${finished.join(', ')}.` : tasks.some((t) => t.state === 'running') ? 'Nothing finished yet.' : 'None of them is running.';
    return { content: `${head}\n${tasks.map(line).join('\n')}` };
  },
};

export const TaskResultTool: Tool<{ id: string }> = {
  name: 'TaskResult',
  description: 'Read the final report of a background task by its id. A running task has no report yet.',
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Task id (session id)' } }, required: ['id'], additionalProperties: false },
  readOnly: true,
  summarize: (input) => `TaskResult ${input.id}`,
  async run(input, ctx) {
    const r = ctx.host.tasks?.result(ctx.sessionId, String(input.id ?? '').trim());
    if (!r) return fail(`No background task ${input.id} in this session. TaskList shows yours.`);
    if (r.task.state === 'running') return { content: `Task ${r.task.id} is still running. Wait for it with TaskWait.` };
    if (r.task.state === 'paused') return { content: `Task ${r.task.id} is paused by the owner and has no report yet. It reports after the owner resumes it.` };
    return { content: `${line(r.task)}\n\n${r.text || '(no final message)'}` };
  },
};

export const TaskContinueTool: Tool<{ id: string; text: string }> = {
  name: 'TaskContinue',
  description: 'Send a finished background task a follow-up message. It keeps its own context, runs in the background again and reports like before.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Task id (session id)' }, text: { type: 'string', description: 'The follow-up instruction' } },
    required: ['id', 'text'],
    additionalProperties: false,
  },
  readOnly: false,
  summarize: (input) => `TaskContinue ${input.id}`,
  async run(input, ctx) {
    const host = ctx.host.tasks;
    if (!host) return none();
    if (typeof input.text !== 'string' || !input.text.trim()) return fail('text is required.');
    const r = host.continue(ctx.sessionId, String(input.id ?? '').trim(), input.text);
    if (typeof r === 'string') return fail(r);
    return { content: `Task ${r.id} continues in the background. Its report arrives in a <subagent_result> block.` };
  },
};

/** In a stable order, appended after the other tools when a session has background tasks. */
export const TASK_TOOLS: Tool[] = [TaskListTool, TaskWaitTool, TaskResultTool, TaskContinueTool] as Tool[];
