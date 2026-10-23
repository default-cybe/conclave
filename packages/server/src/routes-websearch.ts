/**
 * Settings > Web search (core tools/search-providers.ts): the engines
 * WebSearch can use with their free allowance and sign-up steps, the
 * owner's choice, the SearXNG address, each engine's key (a hub secret
 * that goes in through PUT /api/websearch/key and never comes back out)
 * and the Test button. The owner's only (route-policy.ts).
 */
import type { Context, Hono } from 'hono';
import { patchSearchSettings, SearchSettingsError, searchSettings, setSearchKey, testSearch } from '@conclave/core/tools/search-settings.ts';
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

  app.get('/api/websearch', (c) => run(c, () => searchSettings(config())));

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
    return run(c, () => testSearch(config(), body.provider as string | undefined, c.req.raw.signal));
  });
}
