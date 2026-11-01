/**
 * Updates (docs/DESIGN.md, Updates; client: hubUpdate(), checkHubUpdate(),
 * applyHubUpdate(), setAutoUpdate(), deviceUpdates(), updateDeviceDaemon()).
 * The owner's only (route-policy.ts): a member never sees the hub's version
 * checks, its install or its devices' daemons.
 *
 *   GET  /api/update                 how this hub updates, the newest release, the update running now
 *   POST /api/update/check           look at the newest release now
 *   POST /api/update/apply           { version, force?, when? }: download, check, swap and restart (202, then follow GET);
 *                                    409 { error, busy } while work runs unless force; when 'idle' installs once nothing runs
 *   PUT  /api/update/settings        { auto?, window? }: install updates automatically, when idle or at night
 *   GET  /api/devices/updates        each device's daemon version against the hub's
 *   POST /api/devices/:id/update     the device's daemon updates itself to the hub's version (202)
 */
import type { Hono } from 'hono';
import type { HonoEnv, ServerContext } from './context';
import { badRequest, optBool, readJson } from './http';
import { BusyError } from './update/service';

export function registerUpdateRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const updates = ctx.updates;

  app.get('/api/update', (c) => c.json(updates.status()));

  app.post('/api/update/check', async (c) => c.json(await updates.check()));

  app.post('/api/update/apply', async (c) => {
    const body = await readJson<{ version?: unknown; force?: unknown; when?: unknown }>(c);
    if (typeof body.version !== 'string' || !body.version.trim()) throw badRequest('version is required');
    if (body.when !== undefined && body.when !== 'idle') throw badRequest("when must be 'idle'");
    const force = optBool(body.force, 'force');
    const version = body.version.trim().replace(/^v/, '');
    if (body.when === 'idle') return c.json(await updates.applyWhenIdle(version, 'owner'), 202);
    try {
      return c.json(await updates.apply(version, 'owner', { force }), 202);
    } catch (err) {
      if (err instanceof BusyError) return c.json({ error: err.message, busy: err.busy }, 409);
      throw err;
    }
  });

  app.put('/api/update/settings', async (c) => {
    const body = await readJson<{ auto?: unknown; window?: unknown }>(c);
    const auto = optBool(body.auto, 'auto');
    if (body.window !== undefined && body.window !== 'idle' && body.window !== 'night') throw badRequest("window must be 'idle' or 'night'");
    if (auto === undefined && body.window === undefined) throw badRequest('auto must be true or false');
    return c.json(updates.setAuto({ ...(auto !== undefined ? { auto } : {}), ...(body.window ? { window: body.window } : {}) }));
  });

  app.get('/api/devices/updates', (c) => c.json(updates.deviceUpdates()));

  app.post('/api/devices/:id/update', async (c) => c.json(await updates.updateDevice(c.req.param('id'), 'owner'), 202));
}
