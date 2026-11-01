/**
 * DayPlan: the owner's day or week from the hub (tasks, goals, sessions,
 * routine runs, the saved plan), and saving today's plan for Home. Reading
 * is read-only; saving is a write, so routines list it in allow.
 */
import { AssistantError } from '../assistant/service';
import { flowGuide, type FlowGuide } from '../assistant/guides';
import type { DayPlanItem } from '../assistant/types';
import type { Tool } from './types';
import { fail } from './util';

export interface DayPlanInput {
  date?: string;
  days?: number;
  guide?: FlowGuide;
  save?: {
    summary: string;
    items?: DayPlanItem[];
    focus?: { text: string; start: string; end: string; goalId?: string };
    question?: { text: string; options: string[] };
  };
}

export const DayPlanTool: Tool<DayPlanInput> = {
  name: 'DayPlan',
  description: `The owner's day from the hub, in their timezone: local time and message hours, tasks overdue, due and in progress, tasks finished, active goals with next steps and target dates, progress logged, the sessions and chats of the day with their summaries, routine runs (the run history: answer "did it run" from this, not from the schedule), and the plan saved for the day.

- date: YYYY-MM-DD, default today.
- days: 1 to 14 days ending on date, for "this week" (7).
- guide: plan-week, meal-plan, meeting or time-booking returns how to run that flow, with the day. Read it first when the owner asks to plan their week or workouts, plan meals, schedule a meeting, or log or plan hours on a project.
- save: store today's plan so Home shows it. summary is one sentence; items are { time "HH:MM" optional, text, kind event|task|goal|focus|reminder, ref optional task or goal id } in time order; focus is the one suggested block { text, start, end, goalId }; question is at most one question with two or three short options the owner can tap.

With a calendar connected (Settings > Calendar and mail) the day's events are in here too, with ids, and the calendar proposals still waiting for the owner. CalendarList reads more; CalendarFreeBusy finds free time.`,
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      days: { type: 'number', description: '1 to 14' },
      guide: { type: 'string', enum: ['plan-week', 'meal-plan', 'meeting', 'time-booking'] },
      save: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          items: { type: 'array', items: { type: 'object', properties: { time: { type: 'string' }, text: { type: 'string' }, kind: { type: 'string', enum: ['event', 'task', 'goal', 'focus', 'reminder'] }, ref: { type: 'string' } }, required: ['text'] } },
          focus: { type: 'object', properties: { text: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, goalId: { type: 'string' } }, required: ['text', 'start', 'end'] },
          question: { type: 'object', properties: { text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['text', 'options'] },
        },
        required: ['summary'],
      },
    },
    additionalProperties: false,
  },
  readOnly: (input) => !input?.save,
  summarize: (i) => (i.save ? `Save today's plan: ${String(i.save.summary ?? '').slice(0, 70)}` : `Read the day${i.days && i.days > 1 ? ` (${i.days} days)` : ''}${i.guide ? ` and the ${i.guide} guide` : ''}`),
  async run(input, ctx) {
    const s = ctx.host.assistant;
    if (!s) return fail('Day plans are not available on this hub.');
    if (input.date !== undefined && (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date))) return fail('date must look like 2026-10-17.');
    const guide = input.guide !== undefined ? flowGuide(String(input.guide)) : undefined;
    if (input.guide !== undefined && !guide) return fail('guide must be plan-week, meal-plan, meeting or time-booking.');
    try {
      if (input.save) {
        const plan = s.savePlan(input.save, ctx.sessionId);
        return { content: `Saved the plan for ${plan.date}. Home shows it${plan.question ? ', with the question and its options' : ''}.` };
      }
      const days = typeof input.days === 'number' ? Math.max(1, Math.min(14, Math.floor(input.days))) : 1;
      const text = s.dayText({ date: input.date, days });
      // the owner's calendars, when connected: a failure there must not lose the rest of the day
      const cal = await ctx.host.pim?.dayText(input.date ?? s.today(), days).catch((err: Error) => `Calendar: could not read it (${err.message}).`);
      // leave-by times for the day's events with a place (maps/service.ts); a maps failure never costs the day
      const travel = days <= 1 ? await ctx.host.maps?.travelText(input.date).catch(() => '') : '';
      const body = [text, cal, travel].filter(Boolean).join('\n\n');
      return { content: guide ? `${body}\n\nGuide for this flow:\n${guide}` : body };
    } catch (err) {
      return fail(err instanceof AssistantError ? err.message : `Could not read the day: ${(err as Error).message}`);
    }
  },
};
