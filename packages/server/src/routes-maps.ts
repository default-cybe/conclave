/**
 * Maps routes (maps/service.ts): Settings > Maps (provider, key, home,
 * travel mode, links, daily cap, the Test button), the image a map card
 * shows, and the leave-by times for Home. The Google key goes in through
 * PUT /api/maps/key and never comes back out: the image route fetches from
 * Google on the hub and sends only the picture.
 *
 * Every route works on the caller's account (route-policy.ts `self`): the
 * server runs each request as its account, and the service reads a
 * member's own key, home and cap then (maps/service.ts). A member never
 * reads or changes the owner's.
 */
import type { Context, Hono } from 'hono';
import { mapsOf, MapsError, type MapsService, type MapsSettingsPatch } from '@conclave/core/maps/index.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError, readJson } from './http';
import type { AuditFn } from './routes-extensions';
import { isMember } from '@conclave/core/people/context.ts';
import { accountOf } from './scope';

/** A provider's refusal is not the hub's: a bad Google key must never read as a bad hub token (401). */
function statusOf(err: MapsError): number {
  switch (err.code) {
    case 'bad_input':
    case 'no_key':
      return 400;
    case 'not_found':
    case 'no_route':
      return 404;
    case 'cap':
      return 429;
    default:
      return 502;
  }
}

export function registerMapsRoutes(app: Hono<HonoEnv>, ctx: ServerContext, audit: AuditFn): void {
  const svc = (): MapsService => {
    const s = mapsOf(ctx.engine);
    if (!s) throw new HttpError(501, 'This hub has no maps service.');
    return s;
  };
  const run = async (c: Context<HonoEnv>, fn: () => unknown) => {
    try {
      return c.json((await fn()) as object);
    } catch (err) {
      if (err instanceof MapsError) return c.json({ error: err.message, code: err.code }, statusOf(err) as 400);
      throw err;
    }
  };

  app.get('/api/maps', (c) => run(c, () => svc().settings()));

  app.patch('/api/maps', async (c) => {
    const body = await readJson<MapsSettingsPatch>(c);
    return run(c, async () => {
      const out = await svc().patch(body);
      audit(c, 'maps.settings', Object.keys(body).join(', '));
      return out;
    });
  });

  // { key: string | null }; the reply says only whether a key is set
  app.put('/api/maps/key', async (c) => {
    const body = await readJson<{ key?: unknown }>(c);
    if (body.key !== null && typeof body.key !== 'string') throw new HttpError(400, 'key must be text, or null to remove it');
    return run(c, () => {
      const out = svc().setKey((body.key as string | null) ?? null);
      // a member's key is theirs alone: nothing hub wide changed
      if (!isMember(accountOf(c))) ctx.engine.bus.emit({ type: 'config.updated' });
      audit(c, 'maps.key', body.key ? 'set' : 'removed');
      return out;
    });
  });

  app.post('/api/maps/test', (c) => run(c, () => svc().test()));

  // from the caller's own home, on their own key
  app.get('/api/maps/leave-by', (c) => run(c, () => svc().leaveBy(c.req.query('date') || undefined)));

  // the picture of a map card: fetched or drawn on the hub, so the key never reaches the app
  app.get('/api/maps/image/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^map_[a-z0-9]{10,40}$/.test(id)) return c.json({ error: 'unknown map' }, 404);
    try {
      const img = await svc().imageBytes(id);
      return new Response(img.bytes as unknown as BodyInit, {
        headers: {
          'content-type': img.type,
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
          // an SVG map is drawn by the hub; nothing in it may load or run
          'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        },
      });
    } catch (err) {
      if (err instanceof MapsError) return c.json({ error: err.message, code: err.code }, statusOf(err) as 400);
      throw err;
    }
  });
}
