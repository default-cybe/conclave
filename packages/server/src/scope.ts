/**
 * Helpers for routes that work on the caller's account (docs/design/ACCOUNTS.md).
 * route-policy.ts decides who may call a route and checks the ids in its
 * path; a handler uses these for what is in the body and for lists.
 */
import type { Context } from 'hono';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import { OWNER_ID, isMember } from '@conclave/core/people/context.ts';
import { shownName } from '@conclave/core/client/people.ts';
import type { HonoEnv } from './context';
import { HttpError, notFound } from './http';

/** The caller's account. Every list and every create in a "self" route uses it. */
export function accountOf(c: Context<HonoEnv>): string {
  return c.get('auth')?.accountId ?? OWNER_ID;
}

export const OWNER_ONLY = 'Only the owner of this hub can do this.';

/** Throw 403 unless the caller is the hub's owner (the owner token or an app the owner signed in to). */
export function ownerOnly(c: Context<HonoEnv>): void {
  if (c.get('auth')?.role !== 'owner') throw new HttpError(403, OWNER_ONLY);
}

/** A member may start agents that ship and plugin agents only; another name reads as unknown. */
export function checkAgentAllowed(engine: EngineApi, c: Context<HonoEnv>, name: string): void {
  const acct = accountOf(c);
  if (!isMember(acct)) return;
  if (!engine.agentsFor(acct).some((a) => a.name === name)) throw notFound(`unknown agent ${name}`);
}

/** A session id from a body must be the caller's own, else it reads as unknown. */
export function ownSession(engine: EngineApi, c: Context<HonoEnv>, id: unknown, what = 'session'): string {
  if (typeof id !== 'string' || !id || engine.sessionAccount(id) !== accountOf(c)) throw notFound(`unknown ${what} ${typeof id === 'string' ? id : ''}`.trim());
  return id;
}

/** A device id from a body must be the caller's own ("local" is the owner's). */
export function ownDevice(engine: EngineApi, c: Context<HonoEnv>, id: unknown): string {
  const device = typeof id === 'string' && id ? id : 'local';
  if (engine.repos.devices.accountOf(device) !== accountOf(c)) throw notFound(`unknown device ${device}`);
  return device;
}

/** Provider fields a member may see: no keys, headers or environment of the hub. */
const PROVIDER_FIELDS = ['type', 'name', 'baseUrl', 'models', 'enabled', 'modelOverrides', 'command'] as const;

/**
 * GET /api/config for a member: what the apps need to draw (models, defaults,
 * memory and notification switches, UI), and the member's own secret names.
 * No server, permissions, hooks, MCP servers, remote access, paths or keys.
 */
export function memberConfig(engine: EngineApi, accountId: string): { config: Record<string, unknown>; user: Record<string, unknown>; secrets: { providers: string[]; values: string[] } } {
  const c = engine.config.get();
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [id, p] of Object.entries(c.providers)) {
    const out: Record<string, unknown> = {};
    const raw = p as unknown as Record<string, unknown>;
    for (const f of PROVIDER_FIELDS) if (raw[f] !== undefined) out[f] = raw[f];
    providers[id] = out;
  }
  const account = engine.people.get(accountId);
  const prefs = account?.settings ?? {};
  const config: Record<string, unknown> = {
    defaultModel: prefs.defaultModel ?? c.defaultModel,
    smallModel: prefs.smallModel ?? c.smallModel,
    defaultAgent: prefs.defaultAgent ?? c.defaultAgent,
    providers,
    memory: { enabled: c.memory.enabled, autoExtract: c.memory.autoExtract, autoInject: c.memory.autoInject, injectLimit: c.memory.injectLimit },
    notifications: c.notifications ? { on: c.notifications.on, idleSeconds: c.notifications.idleSeconds } : undefined,
    chat: (c as unknown as Record<string, unknown>).chat,
    // ui.name is the name apps greet by: the member's own display name, never the owner's
    ui: { ...c.ui, name: shownName(account) },
    models: c.models ? { tiers: c.models.tiers } : undefined,
  };
  return { config, user: {}, secrets: engine.accountSecrets.names(accountId) };
}
