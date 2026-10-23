/**
 * The life assistant's routes (docs/design/ROUND-LIFE-ASSISTANT.md 3): goals,
 * proactive preferences, the heartbeat and nightly reflection switches,
 * Home's Today, and template upgrades for routines.
 */
import type { Context, Hono } from 'hono';
import { assistantFor, GOAL_AREAS, type AssistantService, type GoalArea, type GoalPatch, type GoalStatus } from '@conclave/core/assistant/index.ts';
import { pimFor } from '@conclave/core/pim/index.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, badRequest, notFound, readJson } from './http';
import type { AuditFn } from './routes-extensions';
import { accountOf } from './scope';

export function registerAssistantRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  // each account has its own assistant: goals, preferences, Today (docs/design/ACCOUNTS.md 2)
  const svc = (c: Context<HonoEnv>): AssistantService => {
    const s = assistantFor(ctx.engine, accountOf(c));
    if (!s) throw new HttpError(501, 'This hub has no assistant service.');
    return s;
  };
  const goalOf = (c: Context<HonoEnv>, id: string) => {
    const g = svc(c).goals.get(id);
    if (!g) throw notFound(`unknown goal ${id}`);
    return g;
  };

  // ----- goals ---------------------------------------------------------------

  app.get('/api/goals', (c) => {
    const status = c.req.query('status') || 'all';
    if (!['active', 'done', 'all'].includes(status)) throw badRequest('status must be active, done or all');
    const area = c.req.query('area') || undefined;
    if (area && !GOAL_AREAS.includes(area as GoalArea)) throw badRequest(`area must be one of ${GOAL_AREAS.join(', ')}`);
    return c.json(svc(c).goals.list({ status: status as GoalStatus | 'all', area: area as GoalArea | undefined }));
  });

  app.get('/api/goals/:id', (c) => {
    const d = svc(c).goals.detail(c.req.param('id'));
    if (!d) throw notFound(`unknown goal ${c.req.param('id')}`);
    return c.json(d);
  });

  app.post('/api/goals', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    const g = svc(c).goals.create(body as never);
    audit(c, 'goal.create', g.title);
    return c.json(g);
  });

  app.patch('/api/goals/:id', async (c) => {
    goalOf(c, c.req.param('id'));
    const body = await readJson<GoalPatch>(c);
    const g = svc(c).goals.update(c.req.param('id'), body);
    if (body.status) audit(c, body.status === 'done' ? 'goal.complete' : 'goal.reopen', g.title);
    return c.json(g);
  });

  app.delete('/api/goals/:id', (c) => {
    const g = goalOf(c, c.req.param('id'));
    svc(c).goals.remove(g.id);
    audit(c, 'goal.delete', g.title);
    return c.json({ ok: true });
  });

  app.post('/api/goals/:id/entries', async (c) => {
    goalOf(c, c.req.param('id'));
    const body = await readJson<{ text?: string; date?: string }>(c);
    return c.json(svc(c).goals.addEntry(c.req.param('id'), { text: body.text ?? '', date: body.date, source: 'owner' }));
  });

  app.delete('/api/goals/:id/entries/:entryId', (c) => {
    goalOf(c, c.req.param('id'));
    if (!svc(c).goals.removeEntry(c.req.param('id'), c.req.param('entryId'))) throw notFound('unknown progress entry');
    return c.json({ ok: true });
  });

  // ----- assistant settings and Today ----------------------------------------

  app.get('/api/assistant', (c) => c.json(svc(c).settings()));

  app.patch('/api/assistant/prefs', async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    const out = await svc(c).setPrefs(body as never);
    audit(c, 'assistant.prefs', Object.keys(body).join(', '));
    return c.json(out);
  });

  app.put('/api/assistant/heartbeat', async (c) => {
    const body = await readJson<{ enabled?: unknown; checklist?: unknown }>(c);
    const out = await svc(c).setHeartbeat(body);
    if (body.enabled !== undefined) audit(c, 'assistant.heartbeat', body.enabled ? 'on' : 'off');
    return c.json(out);
  });

  app.put('/api/assistant/reflection', async (c) => {
    const body = await readJson<{ enabled?: unknown; time?: unknown; model?: unknown }>(c);
    const out = svc(c).setReflection(body);
    if (body.enabled !== undefined) audit(c, 'assistant.reflection', body.enabled ? 'on' : 'off');
    return c.json(out);
  });

  // Settings > Reflect: the same switch as above, with its time, model, last run and notes
  app.get('/api/assistant/reflect', (c) => c.json(svc(c).reflect()));

  app.put('/api/assistant/reflect', async (c) => {
    const body = await readJson<{ enabled?: unknown; time?: unknown; model?: unknown }>(c);
    const a = svc(c);
    a.setReflection(body);
    if (body.enabled !== undefined) audit(c, 'assistant.reflection', body.enabled ? 'on' : 'off');
    return c.json(a.reflect());
  });

  // Reflect now: the hub's owner only (route-policy.ts), the night's rules, one run at a time
  app.post('/api/assistant/reflect/run', async (c) => {
    const out = await svc(c).reflectNow();
    audit(c, 'assistant.reflect', out.skipped ? `skipped: ${out.skipped}` : 'started');
    return c.json(out);
  });

  app.get('/api/assistant/today', async (c) => {
    const today = svc(c).todayDto();
    // the calendar and the proposals waiting (pim/service.ts), when the hub has them; Home shows what it can. They are the caller's own
    const pim = pimFor(ctx.engine, accountOf(c));
    if (!pim) return c.json(today);
    const cal = await pim.today().catch((err: Error) => ({ events: [], error: err.message }));
    // events in the order they happen, then messages in the order they came
    const proposals = pim.proposals({ status: 'pending', limit: 20 }).sort((a, b) => (a.event?.start ?? Number.MAX_SAFE_INTEGER) - (b.event?.start ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt);
    return c.json({ ...today, ...(pim.calendars().some((x) => x.read) ? { events: cal.events } : {}), ...(cal.error ? { calendarError: cal.error } : {}), ...(proposals.length ? { proposals } : {}) });
  });

  app.post('/api/assistant/today/answer', async (c) => {
    const body = await readJson<{ option?: unknown }>(c);
    return c.json(await svc(c).answerToday(body.option));
  });

  // ----- template upgrades -----------------------------------------------------

  app.post('/api/routines/:id/upgrade', (c) => {
    const r = ctx.engine.routines.get(c.req.param('id'));
    if (!r) throw notFound(`unknown routine ${c.req.param('id')}`);
    if (!ctx.engine.routines.upgrade) throw new HttpError(501, 'This hub cannot upgrade routines.');
    let out;
    try {
      out = ctx.engine.routines.upgrade(r.id);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    audit(c, 'routine.upgrade', r.name);
    return c.json(out);
  });
}
