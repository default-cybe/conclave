import type { Session } from '../types';
import type { Tool } from './types';
import { fail } from './util';

export interface ExitPlanModeInput {
  plan: string;
}

const DESCRIPTION = `Present your implementation plan to the user for approval and leave plan mode.

Usage:
- Call this in plan mode once you have a complete plan for a task that requires writing code. The user approves or rejects it; on approval you can start implementing.
- plan is markdown: the goal, the files to change and how, the order of steps, and how you will verify the result. Be specific and concise.
- Do not use it for research-only tasks (gathering information, explaining code); just answer those.
- If something is still unclear, resolve it first (AskUserQuestion), then call this. Do not ask "is this plan okay?" in plain text; this tool is how you ask.`;

export const ExitPlanModeTool: Tool<ExitPlanModeInput> = {
  name: 'ExitPlanMode',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The plan to show the user, in markdown' },
    },
    required: ['plan'],
    additionalProperties: false,
  },
  // Not read-only on purpose: the normal approval flow is how the user accepts the plan.
  readOnly: false,
  summarize: (input) => `Plan ready for approval: ${String(input.plan ?? '').split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 80) ?? ''}`,
  async run(input, ctx) {
    if (typeof input.plan !== 'string' || !input.plan.trim()) return fail('plan is required.');
    const configured = ctx.host.config().permissions?.mode;
    const next: Session['permissionMode'] = configured && configured !== 'plan' ? configured : 'default';
    ctx.host.setPermissionMode(ctx.sessionId, next);
    return {
      content: `The user approved the plan. Plan mode is off; start implementing now. Track the steps with TodoWrite if there are several.\n\nApproved plan:\n${input.plan.trim()}`,
      meta: { permissionMode: next, plan: input.plan },
    };
  },
};
