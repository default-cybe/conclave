/**
 * Settings > Web search (core tools/search-providers.ts): the engines
 * WebSearch can use with their free allowance and sign-up steps, the
 * owner's choice, the SearXNG address, each engine's key (a hub secret
 * that goes in through PUT /api/websearch/key and never comes back out)
 * and the Test button. The engine choice and the SearXNG address are the
 * owner's (route-policy.ts). A member reads and sets only their own keys,
 * in their own secrets file (search-settings.ts memberSearchSettings).
 */
import type { Context, Hono } from 'hono';
import { memberSearchKeys, memberSearchSettings, patchSearchSettings, SearchSettingsError, searchSettings, setMemberSearchKey, setSearchKey, testMemberSearch, testSearch } from '@conclave/core/tools/search-settings.ts';
import { isMember } from '@conclave/core/people/context.ts';
import { accountOf } from './scope';
import { memberProxy, MemberProxyError, setMemberProxy, type MemberProxyUpdate } from '@conclave/core/browser/member-proxy.ts';
import type { WebSearchSettingsPatch } from '@conclave/core/tools/search-providers.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, readJson } from './http';
import type { AuditFn } from './routes-extensions';

export function registerWebSearchRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const config = () => ctx.engine.config;
  const run = async (c: Context<HonoEnv>, fn: () => unknown) => {
    try {
      return c.json((await fn()) as object);
    } catch (err) {
      if (err instanceof SearchSettingsError) return c.json({ error: err.message }, 400);
      throw err;
    }
  };

  /** The member making the request, their own keys and the owner's allowance; undefined for the owner. */
  const member = (c: Context<HonoEnv>) => {
    const id = accountOf(c);
    if (!isMember(id)) return undefined;
    return { own: memberSearchKeys(ctx.engine.accountSecrets, id), hub: !!ctx.engine.people.get(id)?.settings.webSearch };
  };

  app.get('/api/websearch', (c) => {
    const m = member(c);
    return run(c, () => (m ? memberSearchSettings(config(), m.own.get, m.hub) : searchSettings(config())));
  });

  app.patch('/api/websearch', async (c) => {
    const body = await readJson<WebSearchSettingsPatch>(c);
    if (body.provider !== undefined && typeof body.provider !== 'string') throw new HttpError(400, 'provider must be text');
    if (body.url !== undefined && body.url !== null && typeof body.url !== 'string') throw new HttpError(400, 'url must be text, or null to remove it');
    return run(c, () => {
      const out = patchSearchSettings(config(), body);
      ctx.engine.bus.emit({ type: 'config.updated' });
      audit(c, 'websearch.settings', Object.keys(body).join(', '));
      return out;
    });
  });

  // { provider, key: string | null }; the reply says only whether a key is set
  app.put('/api/websearch/key', async (c) => {
    const body = await readJson<{ provider?: unknown; key?: unknown }>(c);
    if (typeof body.provider !== 'string') throw new HttpError(400, 'provider is required');
    if (body.key !== null && typeof body.key !== 'string') throw new HttpError(400, 'key must be text, or null to remove it');
    const provider = body.provider;
    const m = member(c);
    if (m)
      return run(c, () => {
        const out = setMemberSearchKey(config(), m.own, m.hub, provider, (body.key as string | null) ?? null);
        audit(c, 'websearch.key', `${provider} ${body.key ? 'set' : 'removed'}`);
        return out;
      });
    return run(c, () => {
      const out = setSearchKey(config(), provider, (body.key as string | null) ?? null);
      ctx.engine.bus.emit({ type: 'config.updated' });
      audit(c, 'websearch.key', `${provider} ${body.key ? 'set' : 'removed'}`);
      return out;
    });
  });

  app.post('/api/websearch/test', async (c) => {
    const body = await readJson<{ provider?: unknown }>(c);
    if (body.provider !== undefined && typeof body.provider !== 'string') throw new HttpError(400, 'provider must be text');
    const m = member(c);
    return run(c, () => (m ? testMemberSearch(m.own.get, body.provider as string | undefined, c.req.raw.signal) : testSearch(config(), body.provider as string | undefined, c.req.raw.signal)));
  });

  // a member's own proxy for blocked WebFetch and WebSearch requests (core browser/member-proxy.ts); the owner's is in Settings > Browser
  const proxyMember = (c: Context<HonoEnv>): string => {
    const id = accountOf(c);
    if (!isMember(id)) throw new HttpError(400, "The hub's proxy is in Settings, Browser, Proxy.");
    return id;
  };

  app.get('/api/websearch/proxy', (c) => c.json(memberProxy(ctx.engine.repos.kv, ctx.engine.accountSecrets, proxyMember(c))));

  // the reply says only whether a login or password is saved
  app.put('/api/websearch/proxy', async (c) => {
    const id = proxyMember(c);
    const body = await readJson<MemberProxyUpdate>(c);
    try {
      const out = await setMemberProxy(ctx.engine.repos.kv, ctx.engine.accountSecrets, id, body);
      audit(c, 'websearch.proxy', `provider ${out.provider}`);
      return c.json(out);
    } catch (err) {
      if (err instanceof MemberProxyError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
}
