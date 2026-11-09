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
import { hubKeyStore, memberKeyStore, memberSearchSettings, patchSearchKeys, patchSearchSettings, SearchSettingsError, searchSettings, testMemberSearch, testSearch, updateSearchKey } from '@conclave/core/tools/search-settings.ts';
import { isMember } from '@conclave/core/people/context.ts';
import { accountKv } from '@conclave/core/people/scoped.ts';
import { accountOf } from './scope';
import { memberProxy, MemberProxyError, setMemberProxy, type MemberProxyUpdate } from '@conclave/core/browser/member-proxy.ts';
import type { WebSearchKeysPatch, WebSearchKeyUpdate, WebSearchSettingsPatch } from '@conclave/core/tools/search-providers.ts';
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

  const hubKeys = () => hubKeyStore(config(), ctx.engine.repos.kv);

  /** The member making the request, their own keys and the owner's allowance; undefined for the owner. */
  const member = (c: Context<HonoEnv>) => {
    const id = accountOf(c);
    if (!isMember(id)) return undefined;
    return { own: memberKeyStore(ctx.engine.accountSecrets, id, accountKv(ctx.engine.repos.kv, id)), hub: !!ctx.engine.people.get(id)?.settings.webSearch };
  };

  /** The page as the caller sees it: a member's own keys, or the hub's. */
  const view = (m: ReturnType<typeof member>) => (m ? memberSearchSettings(config(), m.own, m.hub, hubKeys()) : searchSettings(config(), hubKeys()));

  app.get('/api/websearch', (c) => {
    const m = member(c);
    return run(c, () => view(m));
  });

  app.patch('/api/websearch', async (c) => {
    const body = await readJson<WebSearchSettingsPatch>(c);
    if (body.provider !== undefined && typeof body.provider !== 'string') throw new HttpError(400, 'provider must be text');
    if (body.url !== undefined && body.url !== null && typeof body.url !== 'string') throw new HttpError(400, 'url must be text, or null to remove it');
    return run(c, () => {
      const out = patchSearchSettings(config(), body, hubKeys());
      ctx.engine.bus.emit({ type: 'config.updated' });
      audit(c, 'websearch.settings', Object.keys(body).join(', '));
      return out;
    });
  });

  // WebSearchKeyUpdate: add, replace or remove one key; the reply has labels, last 4 characters and states, never a key
  app.put('/api/websearch/key', async (c) => {
    const body = await readJson<WebSearchKeyUpdate>(c);
    if (typeof body.provider !== 'string') throw new HttpError(400, 'provider is required');
    if (body.key !== null && typeof body.key !== 'string') throw new HttpError(400, 'key must be text, or null to remove it');
    const m = member(c);
    return run(c, () => {
      updateSearchKey(m ? m.own : hubKeys(), { provider: body.provider, key: body.key, label: body.label, index: body.index, add: body.add === true });
      if (!m) ctx.engine.bus.emit({ type: 'config.updated' });
      audit(c, 'websearch.key', `${body.provider} ${body.key ? (body.add ? 'added' : 'set') : 'removed'}${typeof body.index === 'number' ? ` #${body.index + 1}` : ''}`);
      return view(m);
    });
  });

  // WebSearchKeysPatch: a new order, or a label
  app.patch('/api/websearch/keys', async (c) => {
    const body = await readJson<WebSearchKeysPatch>(c);
    if (typeof body.provider !== 'string') throw new HttpError(400, 'provider is required');
    const m = member(c);
    return run(c, () => {
      patchSearchKeys(m ? m.own : hubKeys(), body);
      if (!m) ctx.engine.bus.emit({ type: 'config.updated' });
      audit(c, 'websearch.keys', `${body.provider} ${body.order ? 'reordered' : 'relabelled'}`);
      return view(m);
    });
  });

  app.post('/api/websearch/test', async (c) => {
    const body = await readJson<{ provider?: unknown; index?: unknown }>(c);
    if (body.provider !== undefined && typeof body.provider !== 'string') throw new HttpError(400, 'provider must be text');
    if (body.index !== undefined && typeof body.index !== 'number') throw new HttpError(400, 'index must be a number');
    const provider = body.provider as string | undefined;
    const index = body.index as number | undefined;
    const m = member(c);
    return run(c, () => (m ? testMemberSearch(m.own, provider, c.req.raw.signal, index) : testSearch(config(), provider, c.req.raw.signal, index, hubKeys())));
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
