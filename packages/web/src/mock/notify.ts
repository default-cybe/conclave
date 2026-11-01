/**
 * Mock routes for notifications inside Conclave: the hub's Web Push key, the
 * browsers it sends Web Push to (GET /api/notify/devices, DELETE
 * /api/notify/devices/:id), subscribe and unsubscribe, and a test to one
 * browser.
 *
 * The busy hub notifies two other browsers. A first-run hub has none.
 */
import type { NotifyDeviceDto } from '@conclave/core/client';
import type { MockCtx } from './index';

const DAY = 86_400_000;

/** Same id the hub uses: sha256 of the endpoint, first 16 hex characters. */
async function endpointId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export function registerNotify(ctx: MockCtx) {
  const { on, fail, sleep } = ctx;
  const devices = new Map<string, NotifyDeviceDto & { endpoint?: string }>();
  if (!ctx.FRESH) {
    const now = Date.now();
    devices.set('5c1f0a9e2b7d4e31', { id: '5c1f0a9e2b7d4e31', name: 'Safari on iOS, installed', kind: 'webpush', createdAt: now - 14 * DAY });
    devices.set('a83d2c6f90e1b457', { id: 'a83d2c6f90e1b457', name: 'Firefox on Linux', kind: 'webpush', createdAt: now - 37 * DAY });
  }
  const list = () => [...devices.values()].map(({ endpoint: _e, ...d }) => d).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  on('GET', '/api/notify/vapid', () => ({ publicKey: 'BMock0VapidKeyForDevelopmentOnly0000000000000000000000000000000000000000000000000000000' }));
  on('GET', '/api/notify/devices', async () => {
    await sleep(150);
    return list();
  });
  on('POST', '/api/notify/subscribe', async ({ body }) => {
    const endpoint = String(body?.endpoint ?? '');
    if (!/^https:\/\//.test(endpoint)) fail(400, 'endpoint must be an https URL');
    const id = await endpointId(endpoint);
    devices.set(id, { id, endpoint, name: typeof body.device === 'string' ? body.device : undefined, kind: 'webpush', createdAt: devices.get(id)?.createdAt ?? Date.now() });
    return { ok: true };
  });
  on('POST', '/api/notify/unsubscribe', async ({ body }) => {
    devices.delete(await endpointId(String(body?.endpoint ?? '')));
    return { ok: true };
  });
  on('DELETE', '/api/notify/devices/:id', async ({ params }) => {
    await sleep(250);
    if (!devices.delete(params[0])) fail(404, 'That device no longer gets notifications. Reload the list.');
    return { ok: true };
  });
  on('POST', '/api/notify/test', async ({ body }) => {
    await sleep(500);
    if (body?.endpoint && !devices.has(await endpointId(String(body.endpoint)))) {
      fail(409, 'This browser is not set up for notifications yet. Turn on Notify this device, then send a test.');
    }
    if (!body?.endpoint && !devices.size) fail(409, 'No browser is set up for notifications yet. Turn on Notify this device in Settings, then send a test.');
    return { ok: true };
  });
}
