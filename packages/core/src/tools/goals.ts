/**
 * Goal tools (docs/design/ROUND-LIFE-ASSISTANT.md 4). Reads are read-only;
 * writes ask in default mode like MemorySave, and routines list them in
 * allow. Untrusted agents never get them (UNTRUSTED_DENY).
 */
import type { Task } from '../types';
import type { AssistantService } from '../assistant/service';
import { GoalError } from '../assistant/goals';
import { goalGuide } from '../assistant/guides';
import { GOAL_AREA_LABEL, GOAL_AREAS, type Goal, type GoalArea, type GoalDetail, type GoalPatch, type GoalSummary } from '../assistant/types';
import { daysBetween } from '../assistant/time';
import type { Tool, ToolContext, ToolOutput } from './types';
import { fail } from './util';

function svc(ctx: ToolContext): AssistantService | undefined {
  return ctx.host.assistant;
}

const NO_GOALS = 'Goals are not available on this hub.';

function guarded(run: (s: AssistantService) => ToolOutput | Promise<ToolOutput>, ctx: ToolContext): Promise<ToolOutput> {
  const s = svc(ctx);
  if (!s) return Promise.resolve(fail(NO_GOALS));
  return Promise.resolve()
    .then(() => run(s))
    .catch((err) => fail(err instanceof GoalError ? err.message : `Could not do that: ${(err as Error).message}`));
}

function when(goal: Goal, today: string): string {
  if (!goal.targetDate) return '';
  const d = daysBetween(today, goal.targetDate);
  return `, target ${goal.targetDate} (${d < 0 ? `${-d} days ago` : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`})`;
}

function goalLine(g: GoalSummary, today: string): string[] {
  const out = [`- ${g.title} [${g.id}] ${g.status}${when(g, today)}${g.nextStep && g.status === 'active' ? `. Next: ${g.nextStep}` : ''}`];
  for (const s of g.subgoals) out.push(`  - subgoal ${s.title} [${s.id}] ${s.status}${when(s, today)}${s.nextStep && s.status === 'active' ? `. Next: ${s.nextStep}` : ''}`);
  const meta = [`${g.entryCount} progress ${g.entryCount === 1 ? 'entry' : 'entries'}`, g.lastEntry ? `last ${g.lastEntry.date}: ${g.lastEntry.text.replace(/\s+/g, ' ').slice(0, 160)}` : '', g.openTasks ? `${g.openTasks} open linked tasks` : ''].filter(Boolean);
  out.push(`  ${meta.join('; ')}`);
  return out;
}

function areaInput(v: unknown): GoalArea | undefined {
  return typeof v === 'string' && GOAL_AREAS.includes(v as GoalArea) ? (v as GoalArea) : undefined;
}

function taskLine(t: Task): string {
  return `- ${t.title} [${t.id}] ${t.status}${t.due ? `, due ${new Date(t.due).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`;
}

export function renderDetail(d: GoalDetail, today: string): string {
  const g = d.goal;
  const titleOf = new Map([g, ...d.subgoals].map((x) => [x.id, x.title]));
  const lines = [
    `${d.parent ? `Subgoal of ${d.parent.title} [${d.parent.id}]. ` : ''}${g.title} [${g.id}]`,
    `Area: ${GOAL_AREA_LABEL[g.area]}. Status: ${g.status}${g.completedAt ? ` since ${new Date(g.completedAt).toISOString().slice(0, 10)}` : ''}${when(g, today)}.`,
    ...(g.description ? [`Description: ${g.description}`] : []),
    ...(g.nextStep ? [`Next step: ${g.nextStep}`] : []),
  ];
  if (d.subgoals.length) lines.push('', 'Subgoals:', ...d.subgoals.map((s) => `- ${s.title} [${s.id}] ${s.status}${when(s, today)}${s.nextStep ? `. Next: ${s.nextStep}` : ''}`));
  lines.push('', `Progress (${d.entries.length}, newest first):`);
  if (!d.entries.length) lines.push('- None logged yet.');
  for (const e of d.entries.slice(0, 30)) lines.push(`- ${e.date}${e.goalId !== g.id ? ` (${titleOf.get(e.goalId) ?? 'subgoal'})` : ''}: ${e.text.replace(/\s+/g, ' ')} [${e.source}]`);
  if (d.entries.length > 30) lines.push(`- and ${d.entries.length - 30} older entries`);
  if (d.tasks.length) lines.push('', 'Linked tasks:', ...d.tasks.map(taskLine));
  return lines.join('\n');
}

function withGuide(text: string, area: GoalArea | undefined, guide: unknown): string {
  if (guide !== true) return text;
  if (!area) return `${text}\n\nPass an area to read its guide.`;
  return `${text}\n\nGuide for ${GOAL_AREA_LABEL[area].toLowerCase()} goals (how to work with the owner here):\n${goalGuide(area)}`;
}

const AREAS_DOC = `study, career, health, money, homelab (homelab and projects), relationships, interests, other (something else)`;

// ---------------------------------------------------------------------------

export interface GoalListInput {
  status?: 'active' | 'done' | 'all';
  area?: GoalArea;
  guide?: boolean;
}

export const GoalListTool: Tool<GoalListInput> = {
  name: 'GoalList',
  description: `List the owner's goals with subgoals, target dates, next steps and their latest progress. Goals also show up in recalled memories; use this for the full list.

Before goal intake, call it with the goal's area and guide: true. That shows the goals already in that area (update one of those instead of making a second) and the guide for that area.

- status: active (default), done or all.
- area: ${AREAS_DOC}.
- guide: true adds the area's guide.`,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'done', 'all'], description: 'active (default), done or all' },
      area: { type: 'string', enum: GOAL_AREAS, description: 'Only goals in this life area' },
      guide: { type: 'boolean', description: 'Add the guide for the area' },
    },
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (i) => `List goals${i.area ? ` in ${i.area}` : ''}`,
  run: (input, ctx) =>
    guarded((s) => {
      const area = areaInput(input.area);
      const status = input.status === 'done' || input.status === 'all' ? input.status : 'active';
      const list = s.goals.list({ status, area });
      const today = s.goals.today();
      const text = list.length
        ? GOAL_AREAS.filter((a) => list.some((g) => g.area === a))
            .flatMap((a) => [`${GOAL_AREA_LABEL[a]}:`, ...list.filter((g) => g.area === a).flatMap((g) => goalLine(g, today))])
            .join('\n')
        : `No ${status === 'all' ? '' : `${status} `}goals${area ? ` in ${area}` : ''} yet.`;
      return { content: withGuide(`Today is ${today}.\n${text}`, area, input.guide) };
    }, ctx),
};

export interface GoalGetInput {
  id: string;
  guide?: boolean;
}

export const GoalGetTool: Tool<GoalGetInput> = {
  name: 'GoalGet',
  description: `Read one goal: description, next step, target date, subgoals, the progress history and linked tasks. Set guide: true when you are helping with the goal, to read the guide for its life area.`,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Goal id (goal_...)' },
      guide: { type: 'boolean', description: 'Add the guide for its area' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  readOnly: true,
  summarize: (i) => `Read goal ${i.id}`,
  run: (input, ctx) =>
    guarded((s) => {
      const d = s.goals.detail(String(input.id ?? ''));
      if (!d) return fail(`There is no goal ${input.id}. GoalList shows the ids.`);
      return { content: withGuide(renderDetail(d, s.goals.today()), d.goal.area, input.guide) };
    }, ctx),
};

export interface GoalCreateInput {
  title: string;
  area: GoalArea;
  description?: string;
  nextStep?: string;
  targetDate?: string;
  parentId?: string;
  taskIds?: string[];
}

export const GoalCreateTool: Tool<GoalCreateInput> = {
  name: 'GoalCreate',
  description: `Create one goal for the owner, once intake is done (you know the goal in their words and how they will know it is reached) or they ask you to save it. Create it yourself, exactly once.

- title: in the owner's own words.
- area: ${AREAS_DOC}.
- description: two or three plain sentences on what done looks like and why it matters. No "I'll" and no labels like "Focus:".
- nextStep: one line, the first or next step.
- targetDate: YYYY-MM-DD, only when there is a real date.
- parentId: makes it a subgoal of that goal. Goals nest one level only.
- taskIds: task board ids to link.

When an active goal already covers the same thing, it is refused: update that one instead. Say the goal is saved only after this returns.`,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      area: { type: 'string', enum: GOAL_AREAS },
      description: { type: 'string' },
      nextStep: { type: 'string' },
      targetDate: { type: 'string', description: 'YYYY-MM-DD' },
      parentId: { type: 'string', description: 'Top goal id, for a subgoal' },
      taskIds: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'area'],
    additionalProperties: false,
  },
  readOnly: false,
  summarize: (i) => `Create goal: ${String(i.title ?? '').slice(0, 80)}`,
  run: (input, ctx) =>
    guarded((s) => {
      const g = s.goals.create({ ...input, sourceSessionId: ctx.sessionId });
      return { content: `Saved goal ${g.id}. It shows on the Goals page.\n${renderDetail(s.goals.detail(g.id)!, s.goals.today())}`, meta: { goalId: g.id } as never };
    }, ctx),
};

export interface GoalUpdateInput {
  id: string;
  title?: string;
  area?: GoalArea;
  description?: string;
  nextStep?: string;
  targetDate?: string;
  status?: 'active' | 'done';
  linkTasks?: string[];
  unlinkTasks?: string[];
  addTask?: { title: string; due?: string };
}

export const GoalUpdateTool: Tool<GoalUpdateInput> = {
  name: 'GoalUpdate',
  description: `Change a goal: title, area, description, next step, target date ("" clears it), or status. status "done" completes it and "active" reopens it; there is no pause (log a progress entry for a break). Link or unlink board tasks by id, or addTask to make a new task on the board linked to the goal (due as YYYY-MM-DD or YYYY-MM-DDTHH:MM local time). Ask before completing or reopening a goal the owner did not mention.`,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      area: { type: 'string', enum: GOAL_AREAS },
      description: { type: 'string' },
      nextStep: { type: 'string' },
      targetDate: { type: 'string', description: 'YYYY-MM-DD, or "" to clear' },
      status: { type: 'string', enum: ['active', 'done'] },
      linkTasks: { type: 'array', items: { type: 'string' } },
      unlinkTasks: { type: 'array', items: { type: 'string' } },
      addTask: { type: 'object', properties: { title: { type: 'string' }, due: { type: 'string' } }, required: ['title'] },
    },
    required: ['id'],
    additionalProperties: false,
  },
  readOnly: false,
  summarize: (i) => `Update goal ${i.id}${i.status ? `: ${i.status}` : ''}`,
  run: (input, ctx) =>
    guarded((s) => {
      const id = String(input.id ?? '');
      const cur = s.goals.get(id);
      if (!cur) return fail(`There is no goal ${id}. GoalList shows the ids.`);
      const patch: GoalPatch = {};
      for (const k of ['title', 'area', 'description', 'status'] as const) if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k];
      if (input.nextStep !== undefined) patch.nextStep = input.nextStep || null;
      if (input.targetDate !== undefined) patch.targetDate = input.targetDate || null;
      if (input.linkTasks || input.unlinkTasks) {
        const missing = (input.linkTasks ?? []).filter((t) => !s.task(t));
        if (missing.length) return fail(`No task with id ${missing.join(', ')} on the board.`);
        patch.taskIds = [...new Set([...cur.taskIds, ...(input.linkTasks ?? [])])].filter((t) => !(input.unlinkTasks ?? []).includes(t));
      }
      // check addTask before changing anything, so a bad due date leaves the goal as it was
      const due = input.addTask?.title ? s.dueAt(input.addTask.due) : undefined;
      if (input.addTask?.title && input.addTask.due && due === undefined) return fail('addTask.due must be a date like 2026-10-24 or 2026-10-24T09:00. Nothing was changed.');
      let note = '';
      if (Object.keys(patch).length) s.goals.update(id, patch);
      if (input.addTask?.title) {
        const { task } = s.goals.addTask(id, { title: input.addTask.title, due });
        note = `Added task ${task.id} "${task.title}" to the board and linked it.\n`;
      }
      if (!note && !Object.keys(patch).length) return fail('Nothing to change. Pass at least one field.');
      return { content: `${note}Updated goal ${id}.\n${renderDetail(s.goals.detail(id)!, s.goals.today())}` };
    }, ctx),
};

export interface GoalLogInput {
  id: string;
  text: string;
  date?: string;
}

export const GoalLogTool: Tool<GoalLogInput> = {
  name: 'GoalLog',
  description: `Log a progress entry on a goal: one plain sentence of what happened, dated (today by default, YYYY-MM-DD). Entries build the goal's history, so log what actually happened, never plans or guesses. Also use it for commitments the owner makes toward the goal ("will write 500 words a day") and boundaries they set ("do not bring up calories").`,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Goal or subgoal id' },
      text: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD, default today' },
    },
    required: ['id', 'text'],
    additionalProperties: false,
  },
  readOnly: false,
  summarize: (i) => `Log progress on ${i.id}: ${String(i.text ?? '').slice(0, 70)}`,
  run: (input, ctx) =>
    guarded((s) => {
      const e = s.goals.addEntry(String(input.id ?? ''), { text: String(input.text ?? ''), date: input.date, source: ctx.session?.routineId ? 'routine' : 'assistant', sessionId: ctx.sessionId });
      const g = s.goals.get(e.goalId)!;
      return { content: `Logged on "${g.title}" for ${e.date}: ${e.text}` };
    }, ctx),
};
