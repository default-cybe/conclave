/**
 * Subscription sign-in routes (Settings > Models > Subscriptions, setup step
 * 2). Contract in core/src/client/index.ts; the work is in cliproxy/index.ts.
 * Keys and tokens never appear in an answer.
 *
 * The owner works on the hub's CLIProxyAPI. A member works on their own one
 * (cliproxy/member.ts, docs/design/ACCOUNTS.md 12): PUT only turns it on, and
 * signing out their last plan stops it and deletes its folder.
 *
 *   GET    /api/subscriptions                          status (local: this request came from the hub's own computer)
 *   PUT    /api/subscriptions                          { mode?, url?, key?, managementKey? }; a member: { mode: 'builtin' } only
 *   POST   /api/subscriptions/update                   install the newer pinned CLIProxyAPI, roll back when it does not start
 *   POST   /api/subscriptions/signin                   { provider } -> { state, url, flow, userCode?, caught }
 *   GET    /api/subscriptions/signin/:state            wait, ok, error, cancelled
 *   POST   /api/subscriptions/signin/:state/callback   { url } the address from the browser bar
 *   DELETE /api/subscriptions/signin/:state            cancel
 *   DELETE /api/subscriptions/accounts/:name           remove an account
 *   POST   /api/subscriptions/accounts/:name/refresh   ask the provider for a new token
 */
import type { Hono } from 'hono';
import type { SubscriptionsSettingsInput } from '@conclave/core/client/index.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, actorOf, auditFor, isDirectLocal, readJson } from './http';
import { OWNER_ONLY, accountOf } from './scope';
import { plansFor } from './cliproxy/member';

export function registerSubscriptionRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { cliproxy, engine } = ctx;

  const audit = auditFor(engine);
  // the caller's plans: the hub's for the owner, their own for a member
  const mine = (c: Parameters<typeof accountOf>[0]) => plansFor(ctx, accountOf(c));

  app.get('/api/subscriptions', (c) => {
    const { member } = mine(c);
    return c.json(member ? ctx.memberPlans.status(member) : { ...cliproxy.status(), local: isDirectLocal(c) });
  });

  app.put('/api/subscriptions', async (c) => {
    const body = await readJson<SubscriptionsSettingsInput>(c);
    const { member } = mine(c);
    if (member) {
      // a member's own CLIProxyAPI always runs on the hub; how the hub reaches one is the owner's
      if (body.mode !== 'builtin' || body.url !== undefined || body.key !== undefined || body.managementKey !== undefined) throw new HttpError(403, OWNER_ONLY);
      return c.json(await ctx.memberPlans.start(member));
    }
    const before = cliproxy.mode();
    const status = await cliproxy.set(body);
    const parts = [
      status.mode !== before && `mode ${status.mode}`,
      body.url !== undefined && status.external && `address ${status.external.url}`,
      typeof body.key === 'string' && body.key.trim() && 'client key saved',
      body.managementKey === null ? 'management key removed' : typeof body.managementKey === 'string' && body.managementKey.trim() && 'management key saved',
    ].filter(Boolean);
    if (parts.length) audit(c, 'subscriptions.mode', parts.join(', '));
    return c.json({ ...status, local: isDirectLocal(c) });
  });

  app.post('/api/subscriptions/update', async (c) => c.json({ ...(await cliproxy.update(actorOf(c))), local: isDirectLocal(c) }));

  app.post('/api/subscriptions/signin', async (c) => {
    const body = await readJson<{ provider?: unknown }>(c);
    return c.json(await mine(c).cliproxy.startSignIn(body.provider, isDirectLocal(c), actorOf(c)));
  });

  app.get('/api/subscriptions/signin/:state', async (c) => c.json(await mine(c).cliproxy.signIn(c.req.param('state'))));

  app.post('/api/subscriptions/signin/:state/callback', async (c) => {
    const body = await readJson<{ url?: unknown }>(c);
    return c.json(await mine(c).cliproxy.finishSignIn(c.req.param('state'), body.url));
  });

  app.delete('/api/subscriptions/signin/:state', async (c) => c.json(await mine(c).cliproxy.cancelSignIn(c.req.param('state'))));

  app.delete('/api/subscriptions/accounts/:name', async (c) => {
    const { cliproxy: own, member } = mine(c);
    const status = await own.removeAccount(c.req.param('name'), actorOf(c));
    // a member's last plan: their CLIProxyAPI stops and its folder goes
    return c.json(member ? await ctx.memberPlans.afterRemove(member) : { ...status, local: isDirectLocal(c) });
  });

  app.post('/api/subscriptions/accounts/:name/refresh', async (c) => {
    const { cliproxy: own, member } = mine(c);
    const status = await own.refreshAccount(c.req.param('name'), actorOf(c));
    return c.json(member ? ctx.memberPlans.status(member) : { ...status, local: isDirectLocal(c) });
  });
}
