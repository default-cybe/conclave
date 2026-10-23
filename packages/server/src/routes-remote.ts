/**
 * Remote access routes (Settings, Remote access). Contract in
 * core/src/client/index.ts; the work is in remote/index.ts.
 *
 *   GET    /api/remote                     status
 *   PUT    /api/remote                     { mode?, lan?, url? }
 *   POST   /api/remote/restart             quick: a new address, announced before the old one stops
 *   POST   /api/remote/cloudflare          { token } check, save, list zones
 *   GET    /api/remote/cloudflare/zones    zones for the saved token
 *   POST   /api/remote/stable              { zoneId, name? } make the named tunnel and DNS name
 *   DELETE /api/remote/stable              delete them at Cloudflare and forget the token
 *   GET    /api/remote/tailscale           what Tailscale says about this machine
 */
import type { Hono } from 'hono';
import type { RemoteSettingsInput, StableTunnelInput } from '@conclave/core/client/index.ts';
import type { HonoEnv, ServerContext } from './context';
import { auditFor, readJson, requireString } from './http';

export function registerRemoteRoutes(app: Hono<HonoEnv>, ctx: ServerContext): void {
  const { remote, engine } = ctx;

  const audit = auditFor(engine);

  app.get('/api/remote', (c) => c.json(remote.status()));

  app.put('/api/remote', async (c) => {
    const body = await readJson<RemoteSettingsInput>(c);
    const status = await remote.set(body);
    const parts = [body.mode !== undefined && `mode ${body.mode}`, body.lan !== undefined && `same network ${body.lan ? 'on' : 'off'}`, body.url !== undefined && `own address ${body.url === null ? 'removed' : status.addresses.find((a) => a.kind === 'own')?.url ?? body.url}`].filter(Boolean);
    if (parts.length) audit(c, 'remote.update', parts.join(', '));
    return c.json(status);
  });

  app.post('/api/remote/restart', (c) => {
    const status = remote.restart();
    audit(c, 'remote.restart', status.mode);
    return c.json(status);
  });

  app.post('/api/remote/cloudflare', async (c) => {
    const body = await readJson<{ token?: unknown }>(c);
    const zones = await remote.saveToken(requireString(body.token, 'token'));
    audit(c, 'remote.cloudflare.token', `saved, it sees ${zones.length} ${zones.length === 1 ? 'domain' : 'domains'}`);
    return c.json({ zones });
  });

  app.get('/api/remote/cloudflare/zones', async (c) => c.json({ zones: await remote.zones() }));

  app.post('/api/remote/stable', async (c) => {
    const body = await readJson<StableTunnelInput>(c);
    requireString(body.zoneId, 'zoneId');
    const status = await remote.setupStable(body);
    audit(c, 'remote.stable.setup', status.stable?.hostname ?? '');
    return c.json(status);
  });

  app.delete('/api/remote/stable', async (c) => {
    const status = await remote.removeStable();
    audit(c, 'remote.stable.remove', status.warning ?? 'removed, Cloudflare token forgotten');
    return c.json(status);
  });

  app.get('/api/remote/tailscale', async (c) => c.json(await remote.tailscale()));
}
