/**
 * Mock routes for the life assistant (docs/design/ROUND-LIFE-ASSISTANT.md):
 * goals with subgoals and progress, proactive preferences, the heartbeat and
 * nightly reflection switches, and Home's Today. The busy hub has the
 * owner's goals for this term and a plan for today; a first-run hub has
 * none. Also answers GET /api/routines/templates with the hub's own list.
 */
import type { Task } from '@conclave/core/types';
import type { AssistantRoutineDto, AssistantSettingsDto, DayPlan, Goal, GoalArea, GoalDetail, GoalEntry, GoalSummary, ProactivePrefs, ReflectDto, ReflectNowDto, ReflectRunDto, TodayDto } from '@conclave/core/client';
import type { MemoryEntry } from '@conclave/core/types';
import { DEFAULT_PREFS, GOAL_AREAS } from '@conclave/core/assistant/types';
import { ROUTINE_TEMPLATES } from '@conclave/core/scheduler/templates';
import type { MockCtx } from './index';
import { pimTodayExtras } from './pim';

const DAY = 86_400_000;
const ZONE = 'Europe/Berlin';

function localDate(ts: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

function minutes(ts: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

export function registerAssistant(ctx: MockCtx) {
  const { on, db, uid, fail } = ctx;
  const now = Date.now();
  const today = localDate(now);
  const goals = new Map<string, Goal>();
  const entries: GoalEntry[] = [];
  let prefs: ProactivePrefs = { ...DEFAULT_PREFS };
  let checklist = `Heartbeat checklist
- A task due in the next 2 hours that is not started yet.
- A goal whose target date is today or tomorrow, or has passed.
- A uni deadline, exam or registration within 3 days that has no task yet.
- Something I asked to be reminded about today.`;
  const routine = { heartbeat: { enabled: false } as { enabled: boolean; id?: string }, reflection: { enabled: true, id: 'r_reflect' } as { enabled: boolean; id?: string; schedule?: string; model?: string } };
  // Settings > Reflect: the last run (saved 2, retired 1 at 02:40) and the notes it keeps, in the mock's memory
  const lastNight = (() => {
    const d = new Date();
    d.setHours(2, 40, 0, 0);
    return d.getTime() > now ? d.getTime() - DAY : d.getTime();
  })();
  let reflectRun: ReflectRunDto | undefined = ctx.FRESH ? undefined : { id: 'rr_reflect', status: 'ok', trigger: 'schedule', startedAt: lastNight, finishedAt: lastNight + 70_000, sessionId: 's_brief', saved: 2, retired: 1 };
  if (!ctx.FRESH) {
    const note = (id: string, content: string, ago: number): MemoryEntry => ({ id, scope: 'agent', scopeKey: 'assistant', kind: 'procedure', content, tags: ['reflection'], importance: 0.6, createdAt: now - ago, updatedAt: now - ago, useCount: 4 });
    for (const m of [
      note('mm_r1', 'The owner wants the command first, then one line on what it does.', 9 * DAY),
      note('mm_r2', 'The owner reads replies on a phone at night: keep them to a few lines and put links last.', now - lastNight - 60_000),
      note('mm_r3', 'When the owner says "just do it", they want the change made, not a plan for it.', now - lastNight - 50_000),
    ])
      db.memories.set(m.id, m);
  }
  const reflectNotes = () => [...db.memories.values()].filter((m) => m.scope === 'agent' && m.scopeKey === 'assistant' && m.kind === 'procedure' && m.tags.includes('reflection')).sort((a, b) => b.updatedAt - a.updatedAt);
  const reflectDto = (): ReflectDto => {
    const schedule = routine.reflection.schedule ?? '40 2 * * *';
    const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule);
    const time = m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : undefined;
    const next = (() => {
      if (!time) return undefined;
      const d = new Date();
      d.setHours(Number(time.slice(0, 2)), Number(time.slice(3)), 0, 0);
      return d.getTime() > Date.now() ? d.getTime() : d.getTime() + DAY;
    })();
    return {
      enabled: routine.reflection.enabled,
      ...(time ? { time } : {}),
      schedule,
      timezone: prefs.timezone ?? ZONE,
      ...(routine.reflection.model ? { model: routine.reflection.model } : {}),
      ...(routine.reflection.id ? { routineId: routine.reflection.id } : {}),
      ...(routine.reflection.enabled && next ? { nextRunAt: next } : {}),
      ...(reflectRun ? { last: reflectRun } : {}),
      notes: reflectNotes(),
    };
  };
  let plan: DayPlan | undefined;

  const goal = (g: Partial<Goal> & Pick<Goal, 'title' | 'area'>): Goal => {
    const out: Goal = { id: uid('goal'), description: '', status: 'active', taskIds: [], createdAt: now - 20 * DAY, updatedAt: now - DAY, ...g };
    goals.set(out.id, out);
    return out;
  };
  const entry = (goalId: string, daysAgo: number, text: string, source: GoalEntry['source'] = 'assistant') => {
    entries.push({ id: uid('gent'), goalId, date: addDays(today, -daysAgo), text, source, createdAt: now - daysAgo * DAY - entries.length * 60_000 });
  };

  if (!ctx.FRESH) {
    prefs = { tell: ['uni deadlines within 3 days', 'homelab outages and failed backups', 'CTFs on this weekend'], never: ['sports', 'crypto prices'], hours: { start: '09:00', end: '21:30' }, how: 'list' };
    const thesis = goal({ title: 'Finish my thesis draft', area: 'study', description: 'A full draft of the thesis goes to my supervisor before the winter break, so there is time for one round of feedback.', nextStep: 'Outline chapter 3: method and threat model', targetDate: addDays(today, 45) });
    const lit = goal({ title: 'Literature review', area: 'study', parentId: thesis.id, status: 'done', completedAt: now - 9 * DAY });
    const ch3 = goal({ title: 'Chapter 3 draft', area: 'study', parentId: thesis.id, nextStep: 'Write the threat model section', targetDate: addDays(today, 21) });
    entry(lit.id, 9, 'Finished the literature review: 34 sources, grouped by attack class.');
    entry(thesis.id, 4, 'Supervisor meeting: keep the scope to Linux containers.', 'owner');
    entry(thesis.id, 1, 'Wrote 2,000 words of chapter 2 and moved the old intro to notes.');
    entry(ch3.id, 0, 'Started the method section in the evening focus block.');
    const os = goal({ title: 'Pass Operating Systems', area: 'study', description: 'Pass the OS exam in November with time to spare, without cramming the night before.', nextStep: 'Past paper 2024 under time', targetDate: addDays(today, 12), taskIds: ['t_os', 't_anki'] });
    entry(os.id, 3, 'Did half of past paper 2023. Scheduling questions were the weak part.');
    const pbs = goal({ title: 'Back up every LXC to PBS and test a restore', area: 'homelab', description: 'Every container on pve has a nightly PBS backup that verifies, and one restore has been tested end to end.', nextStep: 'Restore ct/103 to a scratch VM', targetDate: addDays(today, 1), taskIds: ['t_pbs'] });
    goal({ title: 'Test a restore of ct/103', area: 'homelab', parentId: pbs.id, nextStep: 'Pick a free VMID on pve' });
    entry(pbs.id, 2, 'Nightly verify job added for 11 of 12 containers. ct/105 gitea still failing.');
    const sleep = goal({ title: 'In bed by 00:30 on weeknights', area: 'health', description: 'Sleep before half past twelve on weeknights so the 9:00 lectures stop hurting.', nextStep: 'Laptop closed at 00:00' });
    entry(sleep.id, 1, 'Three of five nights this week before 00:30.', 'owner');
    goal({ title: 'Land a security internship for summer 2027', area: 'career', description: 'An internship in security or infrastructure for next summer, ideally with Linux and containers.', nextStep: 'List 10 companies with application dates', targetDate: addDays(today, 90) });
    const ctf = goal({ title: 'Finish the Cyber Apocalypse CTF in the top 20%', area: 'interests', status: 'done', completedAt: now - 30 * DAY, updatedAt: now - 30 * DAY });
    entry(ctf.id, 31, 'Finished 412 of 2,300. Pwn and forensics went well.', 'owner');

    plan = {
      date: today,
      summary: 'Thesis first while it is quiet, then the OS past paper before the gym.',
      items: [
        { time: '10:00', text: 'Thesis: outline chapter 3', kind: 'focus' },
        { time: '12:15', text: 'Networks lecture', kind: 'event' },
        { time: '14:00', text: 'Patch OpenSSH on all boxes, due 15:00', kind: 'task', ref: 't_ssh' },
        { time: '16:30', text: 'OS past paper 2024, first half', kind: 'goal', ref: os.id },
        { time: '19:00', text: 'Gym', kind: 'event' },
      ],
      focus: { text: 'Outline chapter 3: method and threat model', start: '10:00', end: '11:45', goalId: thesis.id },
      question: { text: 'The PBS restore test is due tomorrow. Do it tonight or move the target to Monday?', options: ['Tonight after the gym', 'Move it to Monday'] },
      sessionId: 's_brief',
      savedAt: now - 2 * 3_600_000,
    };
  }

  const tasks = () => db.tasks as Map<string, Task>;
  const children = (id: string) => [...goals.values()].filter((g) => g.parentId === id).sort((a, b) => a.createdAt - b.createdAt);
  const entriesOf = (ids: string[]) => entries.filter((e) => ids.includes(e.goalId)).sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)));

  const summary = (g: Goal): GoalSummary => {
    const subs = children(g.id);
    const ids = [g.id, ...subs.map((s) => s.id)];
    const es = entriesOf(ids);
    const tIds = [...new Set([g, ...subs].flatMap((x) => x.taskIds))];
    return { ...g, subgoals: subs, entryCount: es.length, ...(es[0] ? { lastEntry: es[0] } : {}), openTasks: tIds.filter((t) => tasks().get(t) && tasks().get(t)!.status !== 'done').length };
  };

  const detail = (id: string): GoalDetail => {
    const g = goals.get(id);
    if (!g) return fail(404, `unknown goal ${id}`);
    const subs = g.parentId ? [] : children(g.id);
    const ids = [g.id, ...subs.map((s) => s.id)];
    return {
      goal: g,
      ...(g.parentId && goals.get(g.parentId) ? { parent: goals.get(g.parentId)! } : {}),
      subgoals: subs,
      entries: entriesOf(ids),
      tasks: [...new Set([g, ...subs].flatMap((x) => x.taskIds))].map((t) => tasks().get(t)).filter((t): t is Task => !!t),
    };
  };

  // the Memory page shows each goal as a memory, like the hub does
  const project = (g: Goal) => {
    const top = g.parentId ? goals.get(g.parentId) : g;
    if (!top) return;
    const s = summary(top);
    const content = `Goal (${top.area}, ${top.status === 'done' ? 'done' : `active${top.targetDate ? `, target ${top.targetDate}` : ''}`}): ${top.title}.${top.nextStep ? ` Next step: ${top.nextStep}.` : ''}${s.lastEntry ? ` Latest progress ${s.lastEntry.date}: ${s.lastEntry.text}` : ''}`;
    const entry = { id: `mem_${top.id}`, scope: 'global' as const, kind: 'fact' as const, content, tags: ['imported', 'source:@goals', 'goal', top.area, top.status], importance: 0.4, createdAt: top.createdAt, updatedAt: Date.now(), useCount: 0 };
    db.memories.set(entry.id, entry);
    ctx.emit({ type: 'memory.updated', entry });
  };
  if (!ctx.FRESH) for (const g of goals.values()) if (!g.parentId) project(g);

  const touch = (g: Goal) => {
    g.updatedAt = Date.now();
    project(g);
  };

  on('GET', '/api/routines/templates', () => ROUTINE_TEMPLATES);

  on('GET', '/api/goals', ({ query }) => {
    const status = query.get('status') || 'all';
    const area = query.get('area');
    return [...goals.values()]
      .filter((g) => !g.parentId && (status === 'all' || g.status === status) && (!area || g.area === area))
      .map(summary)
      .sort((a, b) => (a.status === b.status ? Math.max(b.updatedAt, b.lastEntry?.createdAt ?? 0) - Math.max(a.updatedAt, a.lastEntry?.createdAt ?? 0) : a.status === 'active' ? -1 : 1));
  });

  on('GET', '/api/goals/:id', ({ params }) => detail(params[0]));

  on('POST', '/api/goals', async ({ body }) => {
    await ctx.sleep(250);
    const title = String(body?.title ?? '').trim();
    if (!title) fail(400, "A goal needs a title, in the owner's own words.");
    const parent = body?.parentId ? goals.get(body.parentId) : undefined;
    if (body?.parentId && !parent) fail(404, `There is no goal ${body.parentId}.`);
    if (parent?.parentId) fail(400, 'Goals nest one level only. Add this as a subgoal of the top goal instead.');
    if (body?.area && !GOAL_AREAS.includes(body.area)) fail(400, `area must be one of ${GOAL_AREAS.join(', ')}.`);
    const area: GoalArea = parent?.area ?? (GOAL_AREAS.includes(body?.area) ? body.area : 'other');
    const twin = [...goals.values()].find((g) => g.status === 'active' && (g.parentId ?? '') === (parent?.id ?? '') && g.area === area && g.title.toLowerCase() === title.toLowerCase());
    if (twin) fail(409, `An active goal "${twin.title}" already exists. Update that goal instead of making a second one.`);
    if (body?.targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.targetDate)) fail(400, 'targetDate must be a date like 2026-12-01.');
    const g = goal({ title, area, description: String(body?.description ?? '').trim(), ...(body?.nextStep ? { nextStep: String(body.nextStep).trim() } : {}), ...(body?.targetDate ? { targetDate: body.targetDate } : {}), ...(parent ? { parentId: parent.id } : {}), taskIds: Array.isArray(body?.taskIds) ? body.taskIds : [], createdAt: Date.now(), updatedAt: Date.now() });
    touch(g);
    return g;
  });

  on('PATCH', '/api/goals/:id', async ({ params, body }) => {
    await ctx.sleep(150);
    const g = goals.get(params[0]);
    if (!g) return fail(404, `unknown goal ${params[0]}`);
    // the hub's checks, so the app sees the same refusals
    if (body?.status !== undefined && body.status !== 'active' && body.status !== 'done') fail(400, 'status must be active or done. There is no pause: log a progress entry for a break.');
    if (body?.area !== undefined && !GOAL_AREAS.includes(body.area)) fail(400, `area must be one of ${GOAL_AREAS.join(', ')}.`);
    if (body?.area !== undefined && g.parentId) fail(400, 'A subgoal has the area of its goal. Change the top goal instead.');
    if (body?.title !== undefined) {
      if (!String(body.title).trim()) fail(400, 'A goal needs a title.');
      g.title = String(body.title).trim();
    }
    if (body?.area !== undefined && !g.parentId) {
      g.area = body.area;
      for (const s of children(g.id)) s.area = body.area;
    }
    if (body?.description !== undefined) g.description = String(body.description).trim();
    if (body?.nextStep !== undefined) {
      if (body.nextStep) g.nextStep = String(body.nextStep).trim();
      else delete g.nextStep;
    }
    if (body?.targetDate !== undefined) {
      if (body.targetDate) g.targetDate = body.targetDate;
      else delete g.targetDate;
    }
    if (body?.status && body.status !== g.status) {
      g.status = body.status;
      if (g.status === 'done') g.completedAt = Date.now();
      else delete g.completedAt;
    }
    if (Array.isArray(body?.taskIds)) g.taskIds = [...new Set(body.taskIds as string[])];
    touch(g);
    return g;
  });

  on('DELETE', '/api/goals/:id', ({ params }) => {
    const g = goals.get(params[0]);
    if (!g) return fail(404, `unknown goal ${params[0]}`);
    const ids = [g.id, ...(g.parentId ? [] : children(g.id).map((s) => s.id))];
    for (const id of ids) goals.delete(id);
    for (let i = entries.length - 1; i >= 0; i--) if (ids.includes(entries[i].goalId)) entries.splice(i, 1);
    if (!g.parentId) {
      db.memories.delete(`mem_${g.id}`);
      ctx.emit({ type: 'memory.deleted', id: `mem_${g.id}` });
    } else project(goals.get(g.parentId)!);
    return { ok: true };
  });

  on('POST', '/api/goals/:id/entries', async ({ params, body }) => {
    await ctx.sleep(150);
    const g = goals.get(params[0]);
    if (!g) return fail(404, `unknown goal ${params[0]}`);
    const text = String(body?.text ?? '').trim();
    if (!text) fail(400, 'A progress entry needs text: one plain sentence of what happened.');
    const e: GoalEntry = { id: uid('gent'), goalId: g.id, date: body?.date || localDate(Date.now()), text, source: 'owner', createdAt: Date.now() };
    entries.push(e);
    touch(g);
    return e;
  });

  on('DELETE', '/api/goals/:id/entries/:entry', ({ params }) => {
    const i = entries.findIndex((e) => e.id === params[1] && e.goalId === params[0]);
    if (i < 0) return fail(404, 'unknown progress entry');
    entries.splice(i, 1);
    const g = goals.get(params[0]);
    if (g) touch(g);
    return { ok: true };
  });

  // ----- assistant settings ----------------------------------------------------

  const runDto = (kind: 'heartbeat' | 'nightly-reflection'): AssistantRoutineDto => {
    const r = kind === 'heartbeat' ? routine.heartbeat : routine.reflection;
    const t = ROUTINE_TEMPLATES.find((x) => x.id === kind)!;
    const base: AssistantRoutineDto = {
      template: kind,
      enabled: r.enabled,
      schedule: kind === 'heartbeat' ? `*/30 ${Number(prefs.hours.start.slice(0, 2))}-${Math.floor((hm(prefs.hours.end) - 1) / 60)} * * *` : (routine.reflection.schedule ?? t.schedule),
      model: kind === 'heartbeat' ? t.model : (routine.reflection.model ?? t.model),
      today: kind === 'heartbeat' ? (r.enabled ? { ran: 2, skipped: 9 } : { ran: 0, skipped: 0 }) : { ran: 0, skipped: 0 },
      ...(kind === 'heartbeat' ? { checklist, ...(checklist ? { checklistId: 'mem_checklist' } : {}) } : {}),
    };
    if (!r.id) return base;
    const lastAt = kind === 'heartbeat' ? Date.now() - 12 * 60_000 : (() => { const d = new Date(); d.setHours(2, 40, 0, 0); return d.getTime(); })();
    return {
      ...base,
      routineId: r.id,
      timezone: ZONE,
      ...(r.enabled ? { nextRunAt: kind === 'heartbeat' ? Date.now() + 18 * 60_000 : lastAt + DAY } : {}),
      lastRun: kind === 'heartbeat'
        ? { id: uid('run'), routineId: r.id, status: 'skipped', trigger: 'schedule', startedAt: lastAt, finishedAt: lastAt, error: 'Nothing new since the last run' }
        : reflectRun
          ? { id: reflectRun.id, routineId: r.id, status: reflectRun.status, trigger: reflectRun.trigger, startedAt: reflectRun.startedAt, ...(reflectRun.finishedAt ? { finishedAt: reflectRun.finishedAt } : {}), summary: 'STATUS: ok\nSaved: Give the command first, then one line on what it does.' }
          : undefined,
    };
  };

  const settings = (): AssistantSettingsDto => {
    const m = minutes(Date.now());
    const inside = m >= hm(prefs.hours.start) && m < hm(prefs.hours.end);
    return {
      prefs,
      timezone: prefs.timezone ? { zone: prefs.timezone, source: 'set' } : { zone: ZONE, source: ctx.FRESH ? 'hub' : 'profile' },
      quiet: inside ? { now: false } : { now: true, until: Date.now() + 6 * 3_600_000 },
      waiting: inside || ctx.FRESH ? 0 : 1,
      heartbeat: runDto('heartbeat'),
      reflection: runDto('nightly-reflection'),
    };
  };

  on('GET', '/api/assistant', () => settings());

  on('PATCH', '/api/assistant/prefs', async ({ body }) => {
    await ctx.sleep(200);
    const next = { ...prefs, hours: { ...prefs.hours } };
    // tidied like the hub: one line each, no trailing full stop, no repeats
    const list = (v: unknown, name: string) => {
      if (!Array.isArray(v)) fail(400, `${name} must be a list of short lines.`);
      return [...new Set((v as string[]).map((x) => x.replace(/[;\n]+/g, ',').replace(/\s+/g, ' ').trim().replace(/\.$/, '')).filter(Boolean))];
    };
    if (body?.tell !== undefined) next.tell = list(body.tell, 'tell');
    if (body?.never !== undefined) next.never = list(body.never, 'never');
    if (body?.hours !== undefined) {
      const h = body.hours as { start?: string; end?: string };
      if (!/^\d\d:\d\d$/.test(h?.start ?? '') || !/^\d\d:\d\d$/.test(h?.end ?? '')) fail(400, 'hours needs a start and an end like 09:00 and 21:30.');
      next.hours = { start: h.start!, end: h.end! };
    }
    if (body?.how !== undefined) {
      if (!['line', 'list', 'page'].includes(body.how)) fail(400, 'how must be line, list or page.');
      next.how = body.how;
    }
    if (body?.timezone !== undefined) {
      if (body.timezone) next.timezone = body.timezone;
      else delete next.timezone;
    }
    prefs = next;
    return settings();
  });

  on('PUT', '/api/assistant/heartbeat', async ({ body }) => {
    await ctx.sleep(250);
    if (typeof body?.checklist === 'string') checklist = body.checklist.replace(/\r\n/g, '\n').trim();
    if (typeof body?.enabled === 'boolean') {
      routine.heartbeat.enabled = body.enabled;
      routine.heartbeat.id ??= 'r_heartbeat';
    }
    return settings();
  });

  // one setting behind both pages: Settings > Assistant's switch and Settings > Reflect
  const setReflection = (body: { enabled?: unknown; time?: unknown; model?: unknown } | undefined) => {
    if (body?.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'enabled must be true or false.');
    if (typeof body?.enabled === 'boolean') {
      routine.reflection.enabled = body.enabled;
      routine.reflection.id ??= 'r_reflect';
    }
    if (body?.time !== undefined) {
      const m = typeof body.time === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(body.time) : null;
      if (!m) fail(400, 'time must be HH:MM, such as 02:40.');
      routine.reflection.schedule = `${Number(m![2])} ${Number(m![1])} * * *`;
      routine.reflection.id ??= 'r_reflect';
    }
    if (typeof body?.model === 'string') {
      routine.reflection.model = body.model || undefined;
      routine.reflection.id ??= 'r_reflect';
    }
  };

  on('PUT', '/api/assistant/reflection', async ({ body }) => {
    await ctx.sleep(250);
    setReflection(body);
    return settings();
  });

  on('GET', '/api/assistant/reflect', () => reflectDto());

  on('PUT', '/api/assistant/reflect', async ({ body }) => {
    await ctx.sleep(200);
    setReflection(body);
    return reflectDto();
  });

  // Reflect now: runs a few seconds, saves one note and retires none
  on('POST', '/api/assistant/reflect/run', async (): Promise<ReflectNowDto> => {
    await ctx.sleep(300);
    routine.reflection.id ??= 'r_reflect';
    if (ctx.FRESH) return { skipped: 'No chats since the last reflection', reflect: reflectDto() };
    const run: ReflectRunDto = { id: uid('run'), status: 'running', trigger: 'manual', startedAt: Date.now(), sessionId: 's_brief', saved: 0, retired: 0 };
    reflectRun = run;
    setTimeout(() => {
      const m: MemoryEntry = { id: uid('mm'), scope: 'agent', scopeKey: 'assistant', kind: 'procedure', content: 'The owner likes a table when comparing more than two options.', tags: ['reflection'], importance: 0.6, createdAt: Date.now(), updatedAt: Date.now(), useCount: 0 };
      db.memories.set(m.id, m);
      reflectRun = { ...run, status: 'ok', finishedAt: Date.now(), saved: 1 };
    }, 4000);
    return { run, reflect: reflectDto() };
  });

  // ----- Today -----------------------------------------------------------------

  on('GET', '/api/assistant/today', (): TodayDto => {
    const date = localDate(Date.now());
    const due = [...tasks().values()].filter((t) => t.status !== 'done' && t.due !== undefined);
    const start = Date.now() - minutes(Date.now()) * 60_000;
    const top = [...goals.values()]
      .filter((g) => g.status === 'active' && (g.nextStep || g.targetDate))
      .sort((a, b) => (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999'))
      .slice(0, 3)
      .map((g) => ({ id: g.id, title: g.title, area: g.area, ...(g.nextStep ? { nextStep: g.nextStep } : {}), ...(g.targetDate ? { targetDate: g.targetDate, daysLeft: daysBetween(date, g.targetDate) } : {}) }));
    return {
      date,
      timezone: ZONE,
      ...(plan && plan.date === date ? { plan } : {}),
      ...(plan ? { run: { id: 'rr_b_today', routineId: 'r_brief', status: 'ok' as const, startedAt: plan.savedAt - 90_000, finishedAt: plan.savedAt, sessionId: 's_brief', summary: plan.summary } } : {}),
      ...(ctx.FRESH ? {} : { planRoutine: { id: 'r_brief', enabled: true, nextRunAt: Date.now() + 17 * 3_600_000 } }),
      goals: top,
      tasks: { dueToday: due.filter((t) => t.due! >= start && t.due! < start + DAY).length, overdue: due.filter((t) => t.due! < start).length },
      // today's events and the proposals waiting (mock/pim.ts)
      ...pimTodayExtras(),
    };
  });

  on('POST', '/api/assistant/today/answer', async ({ body }) => {
    await ctx.sleep(300);
    if (!plan?.question) return fail(404, "Today's plan has no question to answer.");
    if (!plan.question.options.includes(body?.option)) fail(400, `Pick one of: ${plan.question.options.join(', ')}.`);
    plan = { ...plan, question: { ...plan.question, answer: body.option } };
    return { plan, sessionId: plan.sessionId };
  });
}
