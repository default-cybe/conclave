/**
 * Calendar and mail routes: accounts behind the bearer token, the proposal
 * approve and decline taps, and the public Google callback that accepts
 * nothing but a state the owner started. Fake CalDAV and Google servers in
 * process; no real provider is reached.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { PimService, attachPim, relayReturn } from '@conclave/core/pim/index.ts';
import { GOOGLE_RELAY_URL } from '@conclave/core/mail/oauth-clients.ts';
import { startHub, type TestHub } from './helpers';
import { startFakeCaldav, type FakeCaldav } from '../../core/test/pim/fake-caldav';
import { startFakeCloud, type FakeCloud } from '../../core/test/pim/fake-cloud';

let hub: TestHub | undefined;
let dav: FakeCaldav | undefined;
let cloud: FakeCloud | undefined;
afterEach(async () => {
  await hub?.stop();
  dav?.stop();
  cloud?.stop();
  hub = undefined;
  dav = undefined;
  cloud = undefined;
});

/** A shared Web client for the relay, with fake values. */
const WEB = { clientId: 'test-web.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-web-secret' };

function withPim(opts: { relay?: boolean } = {}): { hub: TestHub; pim: PimService; secrets: Map<string, string> } {
  hub = startHub();
  cloud = startFakeCloud();
  const secrets = new Map<string, string>();
  const pim = new PimService({
    db: hub.engine.repos.db,
    kv: hub.engine.repos.kv,
    secret: (n) => secrets.get(n),
    setSecret: (n, v) => (v === undefined ? secrets.delete(n) : secrets.set(n, v)),
    zone: () => 'Europe/Berlin',
    endpoints: cloud.endpoints,
    shipped: { google: { desktop: { clientId: cloud.google.clientId, clientSecret: cloud.google.clientSecret }, web: opts.relay ? WEB : { clientId: '', clientSecret: '' }, ios: { clientId: '' }, android: { clientId: '' } }, microsoft: { clientId: cloud.microsoft.clientId } },
    loopbackUrl: () => hub!.url,
  });
  attachPim(hub.engine, pim);
  return { hub, pim, secrets };
}

describe('pim routes', () => {
  test('accounts need the token, and the settings never carry a password', async () => {
    const { hub, secrets } = withPim();
    dav = startFakeCaldav();
    expect((await hub.api('/api/pim', { token: null })).status).toBe(401);
    const bad = await hub.api('/api/pim/accounts/caldav', { method: 'POST', json: { serverUrl: dav.url, username: dav.user, password: 'wrong' } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('refused the user name or app password');
    const res = await hub.api('/api/pim/accounts/caldav', { method: 'POST', json: { preset: 'nextcloud', serverUrl: dav.url, username: dav.user, password: dav.password } });
    expect(res.status).toBe(200);
    const acc = await res.json();
    expect(acc).toMatchObject({ kind: 'caldav', signedIn: true });
    const settings = await (await hub.api('/api/pim')).text();
    expect(settings).not.toContain(dav.password);
    expect(JSON.parse(settings).calendars.map((c: { name: string }) => c.name)).toContain('Personal');
    expect(secrets.get(`pim.${acc.id}.password`)).toBe(dav.password);
    // the owner turns writing on for Work
    const work = acc.calendars.find((c: { name: string }) => c.name === 'Work');
    const patched = await (await hub.api(`/api/pim/accounts/${acc.id}`, { method: 'PATCH', json: { calendars: [{ remoteId: work.remoteId, write: true }], signature: '<b style="color: #C41230" onclick="evil()">CMU</b><script>x</script>' } })).json();
    expect(patched.calendars.find((c: { name: string }) => c.name === 'Work').write).toBe(true);
    expect(patched.signature).toBe('<b style="color:#C41230">CMU</b>');
    const audit = hub.engine.repos.audit.list({ limit: 20 }).map((a: { action: string; detail: string }) => `${a.action} ${a.detail}`).join('\n');
    expect(audit).toContain('pim.account.add');
    expect(audit).not.toContain(dav.password);
  });

  test('approve and decline are one tap each, and a second tap writes nothing', async () => {
    const { hub, pim } = withPim();
    dav = startFakeCaldav();
    await pim.addCaldav({ serverUrl: dav.url, username: dav.user, password: dav.password });
    const a = await pim.proposeEvent({ action: 'create', event: { title: 'Run', start: '2026-10-22T07:00', end: '2026-10-22T07:45' } });
    const b = await pim.proposeEvent({ action: 'create', event: { title: 'Swim', start: '2026-10-23T07:00', end: '2026-10-23T07:45' } });
    const list = await (await hub.api('/api/proposals')).json();
    expect(list.map((p: { event: { title: string } }) => p.event.title).sort()).toEqual(['Run', 'Swim']);
    const ok = await (await hub.api(`/api/proposals/${a.id}/approve`, { method: 'POST' })).json();
    expect(ok.status).toBe('applied');
    expect((await (await hub.api(`/api/proposals/${a.id}/approve`, { method: 'POST' })).json()).status).toBe('applied');
    expect(dav.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    const no = await (await hub.api(`/api/proposals/${b.id}/decline`, { method: 'POST', json: { note: 'too early' } })).json();
    expect(no).toMatchObject({ status: 'declined', result: 'too early' });
    expect(await (await hub.api('/api/proposals')).json()).toEqual([]);
    expect((await hub.api('/api/proposals/prop_none/approve', { method: 'POST' })).status).toBe(404);
  });

  test('the Google callback is public, but only finishes a sign-in the owner started', async () => {
    const { hub, pim } = withPim();
    // a stranger with no token and a made-up state gets a page, not an account
    const stranger = await fetch(`${hub.url}/api/pim/oauth/google/callback?state=guess&code=4/x`);
    expect(stranger.status).toBe(400);
    expect(await stranger.text()).toContain('Sign-in failed');
    expect(pim.accounts()).toEqual([]);
    // the owner starts it (token), Google sends the browser back (no token)
    const flow = await (await hub.api('/api/pim/oauth/google/start', { method: 'POST', json: { client: 'desktop', mail: true, calendar: true } })).json();
    expect(new URL(flow.url).searchParams.get('redirect_uri')).toBe(`${hub.url}/api/pim/oauth/google/callback`);
    const { code, state } = cloud!.approveGoogle(flow.url);
    const back = await fetch(`${hub.url}/api/pim/oauth/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
    expect(back.status).toBe(200);
    const page = await back.text();
    expect(page).toContain('owner@gmail.com is connected to Conclave');
    expect(page).not.toContain(code);
    const done = await (await hub.api(`/api/pim/oauth/flows/${flow.id}`)).json();
    expect(done).toMatchObject({ state: 'done', provider: 'google' });
    expect(pim.accounts()[0]).toMatchObject({ kind: 'google', email: 'owner@gmail.com', calendar: true, mail: true });
    // the same state again does not make a second account
    await fetch(`${hub.url}/api/pim/oauth/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
    expect(pim.accounts()).toHaveLength(1);
  });

  test('a desktop app or phone hands its code over with the token', async () => {
    const { hub, pim } = withPim();
    const flow = await (await hub.api('/api/pim/oauth/google/start', { method: 'POST', json: { client: 'desktop', redirectUri: 'http://127.0.0.1:53123/callback', mail: true } })).json();
    const { code, state } = cloud!.approveGoogle(flow.url);
    expect((await hub.api('/api/pim/oauth/google/finish', { method: 'POST', token: null, json: { state, code } })).status).toBe(401);
    const done = await (await hub.api('/api/pim/oauth/google/finish', { method: 'POST', json: { state, code } })).json();
    expect(done.state).toBe('done');
    expect(pim.accounts()).toHaveLength(1);
    // a bad redirect never starts
    const evil = await hub.api('/api/pim/oauth/google/start', { method: 'POST', json: { client: 'desktop', redirectUri: 'https://evil.example/cb', mail: true } });
    expect(evil.status).toBe(400);
  });

  test('a relayed sign-in comes back from the relay page to the hub address the page uses, and only to one of the hub\'s own', async () => {
    const { hub, pim } = withPim({ relay: true });
    const settings = await (await hub.api('/api/pim')).json();
    expect(settings.oauth.google).toMatchObject({ ready: true, relay: GOOGLE_RELAY_URL, builtin: { web: true } });
    expect(JSON.stringify(settings)).not.toContain(WEB.clientSecret);
    const start = (json: Record<string, unknown>) => hub.api('/api/pim/oauth/google/start', { method: 'POST', json: { client: 'relay', mail: true, ...json } });

    // another host, even with the right path later, is never written into a state
    for (const origin of ['https://evil.example', 'http://evil.example:7777', `http://127.0.0.2:${new URL(hub.url).port}`]) {
      const res = await start({ origin });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('is not one');
    }
    // the hub's own host with something after it, credentials, or another scheme
    for (const origin of [`${hub.url}/elsewhere`, `${hub.url}/?next=x`, hub.url.replace('://', '://me:pw@'), 'javascript:alert(1)', 42]) expect((await start({ origin })).status).toBe(400);

    // the address the page uses
    const flow = await (await start({ origin: hub.url })).json();
    const u = new URL(flow.url);
    expect(u.searchParams.get('redirect_uri')).toBe(GOOGLE_RELAY_URL);
    expect(u.searchParams.get('client_id')).toBe(WEB.clientId);
    const state = u.searchParams.get('state')!;
    const back = relayReturn(state)!;
    expect(back).toBe(`${hub.url}/api/pim/oauth/google/callback`);

    // what the relay page does on Continue: the same public callback, with code and state
    const { code } = cloud!.approveGoogle(flow.url);
    const res = await fetch(`${back}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('owner@gmail.com is connected to Conclave');
    const token = new URLSearchParams(cloud!.requests.find((r) => r.path === '/google/token')!.body);
    expect(Object.fromEntries(token)).toMatchObject({ redirect_uri: GOOGLE_RELAY_URL, client_id: WEB.clientId, client_secret: WEB.clientSecret });
    expect(pim.accounts()[0]).toMatchObject({ client: 'relay', clientId: WEB.clientId });

    // a page that names no address comes back where its request came in
    const plain = await (await start({})).json();
    expect(relayReturn(new URL(plain.url).searchParams.get('state')!)).toBe(`${hub.url}/api/pim/oauth/google/callback`);
    // a state the relay page could carry, but no sign-in made here, is still refused
    const guess = `${'f'.repeat(32)}.${Buffer.from(back).toString('base64url')}`;
    expect((await fetch(`${back}?state=${guess}&code=4/x`)).status).toBe(400);
  });

  test('without the shared Web client the relay does not start', async () => {
    const { hub } = withPim();
    const settings = await (await hub.api('/api/pim')).json();
    expect(settings.oauth.google.relay).toBeUndefined();
    const res = await hub.api('/api/pim/oauth/google/start', { method: 'POST', json: { client: 'relay', origin: hub.url, mail: true } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('relay is off');
  });
});
