/**
 * Alerts: two live chats editing one file, and stuck turns (docs/DESIGN.md
 * 28). The Inbox lists them next to approvals and questions; the work is in
 * packages/core/src/alerts.
 *
 *   GET  /api/alerts       open alerts, oldest first
 *   POST /api/alerts/:id   { action: "stop" | "wait" } for a stuck turn, { action: "dismiss" } for a file conflict
 */
import type { Hono } from 'hono';
import type { AlertAction } from '@conclave/core/client/alerts.ts';
import { alertsOf } from '@conclave/core/alerts/attached.ts';
import type { HonoEnv, ServerContext } from './context';
import { badRequest, notFound, readJson } from './http';
import { OWNER_ID } from '@conclave/core/people/context.ts';
import { accountOf } from './scope';

const ACTIONS: AlertAction[] = ['stop', 'wait', 'dismiss'];

export function registerAlertRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { engine } = ctx;

  // an alert is about a session: each account sees its own (one whose session is gone is the owner's)
  app.get('/api/alerts', (c) => c.json((alertsOf(engine)?.list() ?? []).filter((a) => (engine.sessionAccount(a.sessionId) ?? OWNER_ID) === accountOf(c))));

  app.post('/api/alerts/:id', async (c) => {
    const { action } = await readJson<{ action?: unknown }>(c);
    if (typeof action !== 'string' || !ACTIONS.includes(action as AlertAction)) throw badRequest(`action must be one of ${ACTIONS.join(', ')}`);
    const svc = alertsOf(engine);
    const r = svc ? svc.act(c.req.param('id'), action as AlertAction) : 'missing';
    if (r === 'missing') throw notFound('This alert is not open any more.');
    if (r === 'bad') throw badRequest(action === 'dismiss' ? 'A stuck turn takes stop or wait.' : 'A file conflict takes dismiss.');
    return c.json({ ok: true as const });
  });
}
