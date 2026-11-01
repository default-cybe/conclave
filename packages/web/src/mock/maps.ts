/**
 * Mock routes for maps (src/features/maps, Settings > Maps): the settings
 * with OpenStreetMap until a key is pasted, the Test button, a leave-by
 * time for Home, and a drawn map picture for map cards.
 */
import type { LeaveByDto, MapsSettingsDto, MapsSettingsPatch, MapsTestResult } from '@conclave/core/client';
import type { MockCtx } from './index';

const ZONE = 'Europe/Berlin';

function hhmm(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
}

/** A simple street grid with a route and two markers, as the hub draws one from tiles. */
function picture(): string {
  const streets = Array.from({ length: 12 }, (_, i) => `<path d="M ${i * 56} 0 L ${i * 56 - 40} 320" stroke="#fff" stroke-width="5"/><path d="M 0 ${i * 34} L 600 ${i * 34 + 12}" stroke="#fff" stroke-width="4"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320" viewBox="0 0 600 320"><rect width="600" height="320" fill="#f2efe9"/><rect x="330" y="40" width="120" height="80" fill="#c8e6be"/>${streets}<path d="M 120 240 L 210 200 L 330 170 L 470 90" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/><path d="M 120 240 L 210 200 L 330 170 L 470 90" fill="none" stroke="#2f6fde" stroke-width="5" stroke-linecap="round"/><circle cx="120" cy="240" r="11" fill="#d6453d" stroke="#fff" stroke-width="2.5"/><text x="120" y="244" text-anchor="middle" font-family="Helvetica, Arial" font-size="12" font-weight="700" fill="#fff">A</text><circle cx="470" cy="90" r="11" fill="#d6453d" stroke="#fff" stroke-width="2.5"/><text x="470" y="94" text-anchor="middle" font-family="Helvetica, Arial" font-size="12" font-weight="700" fill="#fff">B</text><rect x="440" y="302" width="160" height="18" fill="#fff" opacity="0.85"/><text x="594" y="315" text-anchor="end" font-family="Helvetica, Arial" font-size="10.5" fill="#333">© OpenStreetMap contributors</text></svg>`;
}

export function registerMaps(ctx: MockCtx) {
  const { on, fail, FRESH } = ctx;
  let keySet = false;
  let s: MapsSettingsDto = {
    provider: 'osm',
    google: { keySet: false },
    osm: { email: 'sam@example.org', nominatimUrl: 'https://nominatim.openstreetmap.org', osrmUrl: 'https://router.project-osrm.org', tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', publicServers: true },
    home: { address: 'Torstraße 1, 10119 Berlin', lat: 52.5294, lng: 13.401, zone: ZONE },
    mode: 'transit',
    links: 'google',
    dailyCap: 300,
    today: { date: new Date().toISOString().slice(0, 10), calls: 12, byApi: { nominatim: 7, osrm: 4, staticmap: 1 } },
  };
  const view = (): MapsSettingsDto => ({ ...s, provider: s.chosen ?? (keySet ? 'google' : 'osm'), google: keySet ? { keySet: true, keyFrom: 'hub' } : { keySet: false } });

  on('GET', '/api/maps', () => view());
  on('PATCH', '/api/maps', async ({ body }) => {
    await ctx.sleep(200);
    const p = body as MapsSettingsPatch;
    if (p.mode) s = { ...s, mode: p.mode };
    if (p.links) s = { ...s, links: p.links };
    if (p.dailyCap !== undefined) s = { ...s, dailyCap: p.dailyCap };
    if (p.provider !== undefined) s = { ...s, chosen: p.provider ?? undefined };
    if (p.osm?.email !== undefined) s = { ...s, osm: { ...s.osm, email: p.osm.email ?? undefined } };
    if (p.home !== undefined) s = p.home ? { ...s, home: { address: `${p.home}, Berlin`, lat: 52.52, lng: 13.405, zone: ZONE } } : { ...s, home: undefined };
    return view();
  });
  on('PUT', '/api/maps/key', ({ body }) => {
    const k = (body as { key?: string | null }).key;
    if (k && !/^[A-Za-z0-9_-]{20,}$/.test(k)) fail(400, 'That does not look like a Google API key. It is about 39 letters and digits and usually starts with AIza.');
    keySet = !!k;
    return view();
  });
  on('POST', '/api/maps/test', async (): Promise<MapsTestResult> => {
    await ctx.sleep(600);
    if (view().provider === 'google')
      return {
        provider: 'google',
        ok: false,
        steps: [
          { api: 'geocode', name: 'Geocoding API', ok: true, message: 'Works. Found Brandenburger Tor, Pariser Platz, 10117 Berlin, Germany.' },
          { api: 'places', name: 'Places API (New)', ok: false, message: "Billing is not enabled on the key's Google Cloud project, so the Places API (New) refuses calls. Turn on billing for the project in the Cloud console, set a budget alert, then press Test again." },
          { api: 'routes', name: 'Routes API', ok: true, message: 'Works. A short walk takes 9 min.' },
          { api: 'timezone', name: 'Time Zone API', ok: true, message: 'Works. The zone there is Europe/Berlin.' },
          { api: 'staticmap', name: 'Maps Static API', ok: true, message: 'Works. Got a 41 KB image.' },
        ],
      };
    return {
      provider: 'osm',
      ok: true,
      steps: [
        { api: 'nominatim', name: 'Nominatim search', ok: true, message: 'Works. Found Brandenburger Tor, Pariser Platz.' },
        { api: 'osrm', name: 'OSRM routing', ok: true, message: 'Works. A short drive is 1.2 km.' },
        { api: 'tiles', name: 'OpenStreetMap tiles', ok: true, message: 'Works. Got a 22 KB tile.' },
      ],
    };
  });
  on('GET', '/api/maps/leave-by', (): LeaveByDto => {
    const date = new Date().toISOString().slice(0, 10);
    if (FRESH) return { date, zone: ZONE, items: [] };
    const start = Date.now() + 3 * 3_600_000;
    const leave = start - 26 * 60_000;
    return { date, zone: ZONE, items: [{ title: 'Seminar', start, startText: hhmm(start), location: 'Unter den Linden 6, Berlin', mode: 'transit', durationSec: 26 * 60, leaveBy: leave, leaveByText: hhmm(leave) }] };
  });
  on('GET', '/api/maps/image/:id', () => new Response(picture(), { headers: { 'content-type': 'image/svg+xml' } }));
}
