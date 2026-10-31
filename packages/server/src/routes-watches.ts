/**
 * Watch routes (watches/service.ts): the Routines page rows, a watch page
 * with its items and runs, and an item's photo, fetched and kept by the hub.
 * Pause, run now, filters and delete are the routine routes
 * (/api/routines/:id, PATCH with { watch }).
 *
 *   GET /api/watches                          WatchSummaryDto[]
 *   GET /api/watches/:id                      WatchDetailDto
 *   GET /api/watches/:id/items/:item/image    the photo
 *   GET /api/watches/sessions/:session/items/:item/image   a chat card's photo
 */
import type { Hono } from 'hono';
import { WatchError, watchesOf, type WatchService } from '@conclave/core/watches/index.ts';
import type { HonoEnv, ServerContext } from './context';
import { HttpError } from './http';
import { accountOf } from './scope';

export function registerWatchRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const svc = (): WatchService => {
    const s = watchesOf(ctx.engine);
    if (!s) throw new HttpError(501, 'This hub has no watches.');
    return s;
  };
  const fail = (err: unknown): never => {
    if (err instanceof WatchError) throw new HttpError(err.status, err.message);
    throw err;
  };

  // each account sees its own watches (route-policy.ts checks the ids of the routes below)
  app.get('/api/watches', (c) => c.json(svc().summaries(accountOf(c))));

  app.get('/api/watches/:id', (c) => {
    try {
      return c.json(svc().detail(c.req.param('id')));
    } catch (err) {
      return fail(err);
    }
  });

  // Hono hands path parameters already decoded: decoding the item id again broke ids with a percent sign
  app.get('/api/watches/:id/items/:item/image', async (c) => {
    let img: { type: string; bytes: Uint8Array };
    try {
      img = await svc().image(c.req.param('id'), c.req.param('item'));
    } catch (err) {
      return fail(err);
    }
    return photo(img);
  });

  // the photo on a chat's item card: only items that chat reported
  app.get('/api/watches/sessions/:session/items/:item/image', async (c) => {
    let img: { type: string; bytes: Uint8Array };
    try {
      img = await svc().draftImage(c.req.param('session'), c.req.param('item'));
    } catch (err) {
      return fail(err);
    }
    return photo(img);
  });

  const photo = (img: { type: string; bytes: Uint8Array }) =>
    new Response(img.bytes as unknown as BodyInit, {
      headers: {
        'content-type': img.type,
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        // a site's photo, kept by the hub: nothing in it may load or run (an SVG opened on its own included)
        'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      },
    });
}
