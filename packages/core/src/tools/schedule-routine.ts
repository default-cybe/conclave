import type { Tool } from './types';
import { fail } from './util';

export interface ScheduleRoutineInput {
  name: string;
  schedule: string;
  prompt: string;
  agent?: string;
}

const DESCRIPTION = `Create a routine: a prompt that runs automatically on a schedule in a fresh session, with results kept and the user notified.

Use it when the user asks for something recurring or later ("every morning summarize...", "check the deploy at 9pm", "remind me on Friday").

Fields:
- name: short, descriptive.
- schedule: a cron expression in the hub's local time ("0 8 * * 1-5" for weekdays at 8:00), "@every 30m" / "@every 6h", or "@once 2026-10-20T09:00" for a single run.
- prompt: the complete instruction for each run. The run starts with no memory of this conversation, so include every detail it needs (paths, URLs, what to report).
- agent: optional agent name to run it with.

The routine runs in the current working directory on the current device. Confirm the schedule with the user when the timing is ambiguous.

To keep an eye on listings on a site (new ones, gone ones, price drops), use WatchCreate instead when you have it: a watch remembers what earlier runs saw, and a routine does not.`;

export const ScheduleRoutineTool: Tool<ScheduleRoutineInput> = {
  name: 'ScheduleRoutine',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Routine name' },
      schedule: { type: 'string', description: 'Cron expression, "@every 30m", or "@once <ISO time>"' },
      prompt: { type: 'string', description: 'Self-contained instruction for each run' },
      agent: { type: 'string', description: 'Optional agent name' },
    },
    required: ['name', 'schedule', 'prompt'],
    additionalProperties: false,
  },
  readOnly: false,
  summarize: (input) => `Schedule "${input.name}" (${input.schedule})`,
  async run(input, ctx) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const schedule = typeof input.schedule === 'string' ? input.schedule.trim() : '';
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!name || !schedule || !prompt) return fail('name, schedule and prompt are all required.');
    try {
      const res = await ctx.host.createRoutine({
        name,
        schedule,
        prompt,
        agent: input.agent?.trim() || undefined,
        cwd: ctx.cwd,
        device: ctx.session?.device,
      });
      const next = res.nextRunAt ? ` Next run: ${new Date(res.nextRunAt).toISOString()}.` : '';
      return { content: `Created routine "${name}" (${res.id}) with schedule ${schedule}.${next}`, meta: { routineId: res.id } };
    } catch (err) {
      return fail(`Could not create the routine: ${(err as Error).message}. Check the schedule format (e.g. "0 9 * * *", "@every 1h", "@once 2026-10-20T09:00").`);
    }
  },
};
