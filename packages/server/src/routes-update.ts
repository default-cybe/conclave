/**
 * Updates (docs/DESIGN.md, Updates; client: hubUpdate(), checkHubUpdate(),
 * applyHubUpdate(), setAutoUpdate(), deviceUpdates(), updateDeviceDaemon()).
 * The owner's only (route-policy.ts): a member never sees the hub's version
 * checks, its install or its devices' daemons.
 *
 *   GET  /api/update                 how this hub updates, the newest release, the update running now
 *   POST /api/update/check           look at the newest release now
 *   POST /api/update/apply           { version }: download, check, swap and restart (202, then follow GET)
 *   PUT  /api/update/settings        { auto }: install updates automatically at night
 *   GET  /api/devices/updates        each device's daemon version against the hub's
 *   POST /api/devices/:id/update     the device's daemon updates itself to the hub's version (202)
 */
import type { Hono } from 'hono';
import type { HonoEnv, ServerContext } from './context';
import { badRequest, readJson } from './http';

export function registerUpdateRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const updates = ctx.updates;

  app.get('/api/update', (c) => c.json(updates.status()));

  app.post('/api/update/check', async (c) => c.json(await updates.check()));

  app.post('/api/update/apply', async (c) => {
    const body = await readJson<{ version?: unknown }>(c);
    if (typeof body.version !== 'string' || !body.version.trim()) throw badRequest('version is required');
    return c.json(await updates.apply(body.version.trim().replace(/^v/, ''), 'owner'), 202);
  });

  app.put('/api/update/settings', async (c) => {
    const body = await readJson<{ auto?: unknown }>(c);
    if (typeof body.auto !== 'boolean') throw badRequest('auto must be true or false');
    return c.json(updates.setAuto(body.auto));
  });

  app.get('/api/devices/updates', (c) => c.json(updates.deviceUpdates()));

  app.post('/api/devices/:id/update', async (c) => c.json(await updates.updateDevice(c.req.param('id'), 'owner'), 202));
}
