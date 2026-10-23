import type { Todo } from '../types';
import type { Tool } from './types';
import { fail } from './util';

export interface TodoWriteInput {
  todos: Array<{ content: string; activeForm?: string; status: Todo['status'] }>;
}

const STATUSES = ['pending', 'in_progress', 'completed'] as const;

const DESCRIPTION = `Create and update a structured task list for the current session. It shows the user your progress and keeps you on track in longer work.

When to use it:
- Work with three or more separate parts, or several things the user asked for at once (a numbered list, comma-separated requests).
- The user asks for a todo list. New requirements show up mid-task: add them.

When not to use it:
- A small or single-part task, even one that takes several tool calls. Pure questions or conversation.

How to use it:
- Each call replaces the whole list. Send every item, not only the changed ones.
- Every item has content (imperative, e.g. "Run the tests"), activeForm (present continuous, e.g. "Running the tests") and status: pending, in_progress or completed.
- Keep exactly one item in_progress while you work. Mark an item in_progress before starting it.
- Mark an item completed as soon as it is done; do not batch completions.
- Only mark an item completed when it is fully done. If tests fail, the work is partial, or you hit a blocker, keep it in_progress and add a new item for what blocks it.
- Remove items that are no longer relevant.`;

export const TodoWriteTool: Tool<TodoWriteInput> = {
  name: 'TodoWrite',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full, updated todo list',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What needs doing, imperative form', minLength: 1 },
            activeForm: { type: 'string', description: 'Present continuous form shown while in progress', minLength: 1 },
            status: { type: 'string', enum: [...STATUSES] },
          },
          required: ['content', 'activeForm', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  // Only changes the session's own todo list.
  readOnly: true,
  summarize: (input) => {
    const list = Array.isArray(input.todos) ? input.todos : [];
    const done = list.filter((t) => t.status === 'completed').length;
    return `Update todos (${done}/${list.length} done)`;
  },
  async run(input, ctx) {
    if (!Array.isArray(input.todos)) return fail('todos must be an array of {content, activeForm, status}.');
    const todos: Todo[] = [];
    for (const [i, t] of input.todos.entries()) {
      if (!t || typeof t.content !== 'string' || !t.content.trim()) return fail(`Todo ${i + 1} needs a non-empty content string.`);
      if (!STATUSES.includes(t.status as (typeof STATUSES)[number])) return fail(`Todo ${i + 1} has invalid status "${t.status}". Use pending, in_progress or completed.`);
      todos.push({ content: t.content.trim(), activeForm: (t.activeForm ?? '').trim() || t.content.trim(), status: t.status });
    }
    const active = todos.filter((t) => t.status === 'in_progress');
    if (active.length > 1) {
      return fail(`Only one todo can be in_progress at a time, but ${active.length} are: ${active.map((t) => `"${t.content}"`).join(', ')}. Keep one in_progress and set the others to pending or completed.`);
    }
    ctx.host.setTodos(ctx.sessionId, todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    const pending = todos.length - done - active.length;
    let text = `Todo list updated (${done} completed, ${active.length} in progress, ${pending} pending). Keep using the list to track progress, and continue with the current task.`;
    if (todos.length && done === todos.length) text = 'All todos are completed. Make sure the work is verified before you wrap up.';
    else if (!active.length && pending) text += ' Nothing is in_progress: mark the next item in_progress before you start it.';
    return { content: text, meta: { todos: todos.length, completed: done } };
  },
};
