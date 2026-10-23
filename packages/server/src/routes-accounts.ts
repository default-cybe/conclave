/**
 * Accounts and their order (Settings > Models > Accounts). Contract in
 * core/src/client/index.ts; the order and the budgets live in
 * core/src/accounts/service.ts, the CLIProxyAPI side in cliproxy/index.ts.
 * Keys and tokens never appear in an answer. A member works on their own
 * plans (cliproxy/member.ts), never the hub's.
 *
 *   GET    /api/accounts              every account, its windows, models and state; the order; who takes the next call
 *   POST   /api/accounts/refresh      read the credentials, plan usage and models again now
 *   PUT    /api/accounts/order        { vendor, match?, order } the owner's order; the hub writes CLIProxyAPI priorities
 *   PATCH  /api/accounts/:id          { label?, enabled?, budget?, starter?, refusal? } pause pauses the credential in CLIProxyAPI too; starter is the window starter;
 *                                     refusal: "Use when a model refuses" (a plan without a short name gets the suggested one first)
 *   POST   /api/accounts/:id/try      clear CLIProxyAPI's cooldown on a signed in account ("Try now")
 *   PUT    /api/accounts/:id/prefix   { prefix } a plan's short name, written to CLIProxyAPI as its prefix; empty removes it
 */
import type { Context, Hono } from 'hono';
import type { AccountOrderInput, AccountPatch, AccountPrefixInput } from '@conclave/core/client/index.ts';
import type { HonoEnv, ServerContext } from './context';
import { suggestPrefixes } from '@conclave/core/accounts/prefix.ts';
import { CliproxyManager } from './cliproxy';
import { plansFor } from './cliproxy/member';
import { HttpError, auditFor, readJson } from './http';
import { accountOf } from './scope';

/** Why a signed in plan cannot be marked: the hub cannot give it a short name. */
export const REFUSAL_NEEDS_MANAGEMENT = "Using a plan when a model refuses needs a short name, and short names need CLIProxyAPI's management key. Add it in Subscriptions.";

export function registerAccountRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { engine } = ctx;
  const audit = auditFor(engine);
  // the caller's plans: the hub's for the owner, their own for a member
  const mine = (c: Context<HonoEnv>) => {
    const p = plansFor(ctx, accountOf(c));
    return { ...p, name: (id: string) => p.accounts.account(id)?.label ?? id };
  };

  app.get('/api/accounts', (c) => c.json(mine(c).accounts.status()));

  app.post('/api/accounts/refresh', async (c) => {
    const { cliproxy, accounts } = mine(c);
    await cliproxy.refreshAll();
    accounts.publish();
    return c.json(accounts.status());
  });

  app.put('/api/accounts/order', async (c) => {
    const body = await readJson<AccountOrderInput>(c);
    const { cliproxy, accounts, name } = mine(c);
    try {
      accounts.setOrder(body);
    } catch (err) {
      CliproxyManager.http(err);
    }
    await cliproxy.syncPriorities();
    audit(c, 'accounts.order', `${body.vendor}${body.match ? ` ${body.match}` : ''}: ${body.order.map(name).join(', ')}`);
    return c.json(accounts.status());
  });

  app.patch('/api/accounts/:id', async (c) => {
    const id = c.req.param('id');
    const body = await readJson<AccountPatch>(c);
    const { cliproxy, accounts, name, member } = mine(c);
    // the window starter and the refusal fallback use the hub's plans only
    if (member && body.starter !== undefined) throw new HttpError(400, 'The window starter is for the owner\'s plans.');
    if (member && body.refusal !== undefined) throw new HttpError(400, "Use when a model refuses is for the owner's plans.");
    const before = accounts.account(id);
    if (body.refusal !== undefined && typeof body.refusal !== 'boolean') throw new HttpError(400, 'refusal must be true or false');
    // a marked plan must be reachable alone: one without a short name gets the suggested one now, so the owner never names it
    let named: string | undefined;
    if (body.refusal === true && before?.kind === 'subscription' && !before.prefix) {
      if (!accounts.status().management || !accounts.credentialOf(id)) throw new HttpError(409, REFUSAL_NEEDS_MANAGEMENT);
      const taken = accounts
        .status()
        .accounts.filter((a) => a.id !== id && a.prefix)
        .map((a) => a.prefix!);
      const name = suggestPrefixes([{ id, label: before.label, ...(before.email ? { email: before.email } : {}) }], taken).get(id);
      if (name) named = await cliproxy.setPrefix(id, name);
    }
    // pausing a signed in plan pauses it in CLIProxyAPI as well, so no client of it uses the account
    if (before?.kind === 'subscription' && typeof body.enabled === 'boolean' && body.enabled !== before.enabled && accounts.credentialOf(id)) {
      await cliproxy.setPaused(id, !body.enabled);
    }
    try {
      accounts.patch(id, body);
    } catch (err) {
      CliproxyManager.http(err);
    }
    const parts = [
      typeof body.enabled === 'boolean' && (body.enabled ? 'resumed' : 'paused'),
      typeof body.label === 'string' && `label ${body.label.trim() || 'default'}`,
      body.budget === null ? 'budget removed' : body.budget && `budget $${body.budget.usd} per ${body.budget.period ?? 'month'}`,
      body.starter === null ? 'window starter removed' : body.starter && typeof body.starter.enabled === 'boolean' ? `window starter ${body.starter.enabled ? 'on' : 'off'}` : body.starter && 'window starter settings',
      named && `short name ${named}`,
      typeof body.refusal === 'boolean' && (body.refusal ? 'used when a model refuses' : 'not used when a model refuses'),
    ].filter(Boolean);
    if (parts.length) audit(c, 'accounts.update', `${name(id)}: ${parts.join(', ')}`);
    return c.json(accounts.status());
  });

  app.post('/api/accounts/:id/try', async (c) => {
    const id = c.req.param('id');
    const { cliproxy, accounts, name } = mine(c);
    await cliproxy.tryNow(id);
    audit(c, 'accounts.try', name(id));
    accounts.publish();
    return c.json(accounts.status());
  });

  // the plan's short name, so Refusal fallback and the Window starter can pick it (neu/claude-opus-5-5)
  app.put('/api/accounts/:id/prefix', async (c) => {
    const id = c.req.param('id');
    const body = await readJson<Partial<AccountPrefixInput>>(c);
    const { cliproxy, accounts, name } = mine(c);
    const before = accounts.account(id)?.prefix ?? '';
    const prefix = await cliproxy.setPrefix(id, body.prefix);
    if (prefix !== before) audit(c, 'accounts.update', `${name(id)}: ${prefix ? `short name ${prefix}` : 'short name removed'}`);
    accounts.publish();
    return c.json(accounts.status());
  });
}
