import type { Tool } from './types';

const DESCRIPTION = `Switch this session into plan mode before starting a non-trivial implementation.

In plan mode you explore and design without changing anything: only read-only tools work (Read, Grep, Glob, LS, read-only Bash, WebFetch, WebSearch, Task...). When the plan is ready, call ExitPlanMode with it so the user can approve it.

Use it when:
- The task touches several files or has more than one reasonable approach.
- Requirements are unclear and you need to investigate first.
- The change is risky (data migrations, deletions, wide refactors).

Skip it for small, clear tasks such as a one-line fix or a question.`;

export const EnterPlanModeTool: Tool<Record<string, never>> = {
  name: 'EnterPlanMode',
  description: DESCRIPTION,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  summarize: () => 'Enter plan mode',
  async run(_input, ctx) {
    if (ctx.session?.permissionMode === 'plan') {
      return { content: 'Already in plan mode. Keep exploring with read-only tools, then call ExitPlanMode with your plan.' };
    }
    ctx.host.setPermissionMode(ctx.sessionId, 'plan');
    return {
      content: `Plan mode is on. Do not edit files, run commands that change state, or make commits.
1. Explore the code with read-only tools to understand the current behavior.
2. Consider the approaches and their trade-offs; ask the user with AskUserQuestion if a choice is theirs to make.
3. Write a concrete plan: the files to change, what changes in each, and how you will verify it.
4. Call ExitPlanMode with the plan. Implementation starts only after the user approves it.`,
      meta: { permissionMode: 'plan' },
    };
  },
};
