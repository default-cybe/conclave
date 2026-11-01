/**
 * Sign in with Google and Microsoft against fake endpoints in process:
 * PKCE, the loopback and https and phone redirects, the device code flow,
 * refresh (and Microsoft's rotation), revoke on disconnect, and the same
 * mail and calendar calls over Gmail, Graph and Google Calendar. No real
 * Google or Microsoft address is reached (localFetch refuses them).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { startFakeCloud, type FakeCloud } from './fake-cloud';
import { makePim } from './helpers';
import type { ShippedOAuthClients } from '../../src/mail/oauth-clients';
import { GOOGLE_RELAY_URL, OAUTH_CLIENTS } from '../../src/mail/oauth-clients';
import { parseMessage } from '../../src/mail/mime';
import { OAuthError } from '../../src/mail/oauth';
import { isRelayReturn, relayCallback, relayReturn, relayState } from '../../src/pim/oauth-flows';

let cloud: FakeCloud | undefined;
let cleanup: (() => void) | undefined;
afterEach(() => {
  cloud?.stop();
  cleanup?.();
  cloud = undefined;
  cleanup = undefined;
});

const NOW = Date.parse('2026-10-21T08:00:00Z');

function shipped(c: FakeCloud, extra: Partial<ShippedOAuthClients['google']> = {}): ShippedOAuthClients {
  return { google: { desktop: { clientId: c.google.clientId, clientSecret: c.google.clientSecret }, web: { clientId: '', clientSecret: '' }, ios: { clientId: '' }, android: { clientId: '' }, ...extra }, microsoft: { clientId: c.microsoft.clientId } };
}

/** A shared Web client for the relay, with fake values. */
const WEB = { clientId: 'test-web.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-web-secret' };
const CB = '/api/pim/oauth/google/callback';

function setup(opts: { publicUrl?: string; shipped?: (c: FakeCloud) => ShippedOAuthClients; now?: () => number } = {}) {
  cloud = startFakeCloud();
  const t = makePim({ endpoints: cloud.endpoints, shipped: (opts.shipped ?? shipped)(cloud), ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}), now: opts.now ?? Date.now });
  cleanup = t.cleanup;
  return t;
}

const mail = (from: string, subject: string, body: string) => `From: ${from}\r\nTo: owner@gmail.com\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@x>\r\nDate: Tue, 20 Oct 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

describe('shipped clients', () => {
  test('the shared Google Desktop and iOS clients ship; Android and Microsoft stay empty until they exist', () => {
    expect(OAUTH_CLIENTS.google.desktop.clientId).toEndWith('.apps.googleusercontent.com');
    // a Desktop app client's secret is public by Google's rules; its value lives only in oauth-clients.ts
    expect(OAUTH_CLIENTS.google.desktop.clientSecret).toStartWith('GOCSPX-');
    expect(OAUTH_CLIENTS.google.ios.clientId).toEndWith('.apps.googleusercontent.com');
    expect(OAUTH_CLIENTS.google.android.clientId).toBe('');
    expect(OAUTH_CLIENTS.microsoft.clientId).toBe('');
    // the shared Web client behind the relay: both empty until the owner pastes them, then both set
    const web = OAUTH_CLIENTS.google.web;
    if (web.clientId || web.clientSecret) {
      expect(web.clientId).toEndWith('.apps.googleusercontent.com');
      expect(web.clientSecret).toStartWith('GOCSPX-');
    }
    // the one redirect URI registered at Google, exactly
    expect(GOOGLE_RELAY_URL).toBe('https://conclave.kaivalyaahir.com/oauth/google/');
    const t = makePim();
    const s = t.pim.settings().oauth;
    expect(s.google).toMatchObject({ ready: true, builtin: { desktop: true, web: !!web.clientId, ios: true, android: false } });
    expect(s.microsoft.ready).toBe(false);
    // the settings say a client is there, never what its secret is
    expect(JSON.stringify(t.pim.settings())).not.toContain(OAUTH_CLIENTS.google.desktop.clientSecret);
    if (web.clientSecret) expect(JSON.stringify(t.pim.settings())).not.toContain(web.clientSecret);
    t.cleanup();
    const none = makePim({ shipped: { google: { desktop: { clientId: '', clientSecret: '' }, web: { clientId: '', clientSecret: '' }, ios: { clientId: '' }, android: { clientId: '' } }, microsoft: { clientId: '' } } });
    expect(none.pim.settings().oauth.google.how).toContain('No Google client is set up yet');
    none.cleanup();
  });
});

describe('Google', () => {
  test('desktop loopback sign-in with PKCE; tokens land in the secret store; Gmail search, read and a threaded draft', async () => {
    const { pim, secrets, repos } = setup();
    const st = pim.settings().oauth.google;
    expect(st).toMatchObject({ ready: true, builtin: { desktop: true }, redirect: { loopback: 'http://127.0.0.1:7777/api/pim/oauth/google/callback' } });
    expect(st.how).toContain('paste it here');

    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { mail: true, drafts: true } });
    const u = new URL(flow.url!);
    expect(u.origin + u.pathname).toBe(`${cloud!.url}/google/auth`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: cloud!.google.clientId, redirect_uri: 'http://127.0.0.1:7777/api/pim/oauth/google/callback', response_type: 'code', code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' });
    expect(u.searchParams.get('scope')!.split(' ')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose']);

    // a wrong state is refused
    await expect(pim.oauth.finishGoogle({ state: 'nope', code: 'x' })).rejects.toThrow(/unknown or already finished/);
    const { code, state } = cloud!.approveGoogle(flow.url!);
    const done = await pim.oauth.finishGoogle({ state, code });
    expect(done).toMatchObject({ state: 'done', provider: 'google' });
    const acc = pim.accounts().find((a) => a.id === done.accountId)!;
    expect(acc).toMatchObject({ kind: 'google', label: 'owner@gmail.com', email: 'owner@gmail.com', client: 'desktop', mail: true, calendar: false, drafts: true, send: false, signedIn: true });
    const refresh = secrets.get(`pim.${acc.id}.refresh`)!;
    expect(refresh).toStartWith('1//refresh-');
    expect(JSON.stringify(repos.kv.get('pim.accounts', []))).not.toContain(refresh);
    // the token request carried the verifier and the shipped desktop secret
    const tokenReq = cloud!.requests.find((r) => r.path === '/google/token')!;
    expect(new URLSearchParams(tokenReq.body).get('client_secret')).toBe(cloud!.google.clientSecret);
    // a second finish with the same state does nothing new
    expect((await pim.oauth.finishGoogle({ state, code })).state).toBe('done');

    cloud!.google.messages.push({ id: 'g1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], raw: mail('Ana <ana@example.com>', 'Lunch Thursday?', 'Are you free at 12?'), internalDate: Date.parse('2026-10-20T09:00:00Z') });
    cloud!.google.messages.push({ id: 'g2', threadId: 't2', labelIds: ['INBOX'], raw: mail('Shop <news@shop.example>', 'Sale', 'Buy now'), internalDate: Date.parse('2026-10-19T09:00:00Z') });
    const found = await pim.mailSearch({ from: 'ana@example.com', limit: 5 });
    expect(found.map((m) => [m.subject, m.from?.address, m.unread])).toEqual([['Lunch Thursday?', 'ana@example.com', true]]);
    expect(cloud!.requests.find((r) => r.path.startsWith('/gmail/messages?'))!.path).toContain(encodeURIComponent('from:ana@example.com').replace(/%20/g, '+'));
    const msg = await pim.mailRead(found[0].id);
    expect(msg).toMatchObject({ subject: 'Lunch Thursday?', text: 'Are you free at 12?', messageId: '<LunchThursday@x>' });

    const p = await pim.proposeMail({ to: 'ana@example.com', body: 'Yes, 12 works.', replyTo: found[0].id });
    expect(cloud!.google.drafts).toEqual([]);
    expect((await pim.approve(p.id)).status).toBe('applied');
    expect(cloud!.google.drafts).toHaveLength(1);
    expect(cloud!.google.drafts[0].threadId).toBe('t1');
    const parsed = await parseMessage(cloud!.google.drafts[0].raw);
    expect(parsed).toMatchObject({ subject: 'Re: Lunch Thursday?', inReplyTo: '<LunchThursday@x>', text: 'Yes, 12 works.' });
    expect(cloud!.google.sent).toEqual([]);

    // with an HTML signature on the Gmail account, saveDraft sends multipart/alternative raw MIME
    pim.updateAccount(acc.id, { signature: '<table style="font-family: Arial; font-size: 13px; color: #222"><tr><td><b>Kaivalya Ahir</b><br><a href="https://kaivalyaahir.com" style="color: #1a56b8">kaivalyaahir.com</a></td></tr></table>' });
    const pSig = await pim.proposeMail({ to: 'ana@example.com', body: 'See you at 12.\n\nBest,', replyTo: found[0].id });
    expect((await pim.approve(pSig.id)).status).toBe('applied');
    expect(cloud!.google.drafts).toHaveLength(2);
    const sigRaw = cloud!.google.drafts[1].raw;
    expect(sigRaw).toMatch(/Content-Type: multipart\/alternative; boundary="conclave_[0-9a-f]+"/);
    const sigHtmlB64 = sigRaw.split(/--conclave_[0-9a-f]+/).find((part) => part.includes('Content-Type: text/html'))!.split('\r\n\r\n')[1]!.trim();
    const sigHtml = Buffer.from(sigHtmlB64.replace(/\s+/g, ''), 'base64').toString('utf8');
    expect(sigHtml).toContain('<p>See you at 12.</p>\r\n<p>Best,</p>');
    expect(sigHtml).toContain('<a href="https://kaivalyaahir.com" style="color:#1a56b8">kaivalyaahir.com</a>');
    const sigParsed = await parseMessage(cloud!.google.drafts[1].raw);
    expect(sigParsed.text).toBe('See you at 12.\n\nBest,\n\nKaivalya Ahir\nkaivalyaahir.com (https://kaivalyaahir.com)');
  });

  test('a desktop redirect that is not an address is the caller\'s mistake, said in words', () => {
    const { pim } = setup();
    expect(() => pim.oauth.startGoogle({ client: 'desktop', redirectUri: 'not an address', wants: { mail: true } })).toThrow(OAuthError);
  });

  test('a callback that arrives twice at once (a reload, a retry) exchanges the code once and makes one account', async () => {
    const { pim } = setup();
    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { mail: true } });
    const { code, state } = cloud!.approveGoogle(flow.url!);
    const [a, b] = await Promise.all([pim.oauth.finishGoogle({ state, code }), pim.oauth.finishGoogle({ state, code })]);
    expect([a.state, b.state]).toEqual(['done', 'done']);
    expect(pim.oauth.flow(flow.id)!.state).toBe('done');
    expect(pim.accounts()).toHaveLength(1);
    expect(cloud!.requests.filter((r) => r.path === '/google/token')).toHaveLength(1);
  });

  test('one sender\'s odd entity in a snippet does not break the whole Gmail search', async () => {
    const { pim } = setup();
    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { mail: true } });
    const { code, state } = cloud!.approveGoogle(flow.url!);
    await pim.oauth.finishGoogle({ state, code });
    cloud!.google.messages.push({ id: 'g1', threadId: 't1', labelIds: ['INBOX'], raw: mail('Ana <ana@example.com>', 'Lunch', 'See you at 12'), internalDate: Date.parse('2026-10-20T09:00:00Z') });
    // Gmail's snippet escapes the text a sender wrote: "&#1114112;" arrives as "&amp;#1114112;"
    cloud!.google.messages.push({ id: 'g2', threadId: 't2', labelIds: ['INBOX'], raw: mail('Eve <eve@example.com>', 'Odd', 'Code &amp;#1114112; and &amp;lt;b&amp;gt; &#1114112;'), internalDate: Date.parse('2026-10-19T09:00:00Z') });
    const found = await pim.mailSearch({ limit: 5 });
    expect(found.map((m) => m.subject).sort()).toEqual(['Lunch', 'Odd']);
    // decoded once: what the sender typed, not what it would mean as HTML
    expect(found.find((m) => m.subject === 'Odd')!.snippet).toContain('&lt;b&gt;');
  });

  test('a message deleted between the list and its fetch is left out of a Gmail search; other errors still fail it in words', async () => {
    const { pim } = setup();
    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { mail: true } });
    const { code, state } = cloud!.approveGoogle(flow.url!);
    await pim.oauth.finishGoogle({ state, code });
    cloud!.google.messages.push({ id: 'g1', threadId: 't1', labelIds: ['INBOX'], raw: mail('Ana <ana@example.com>', 'Lunch', 'See you at 12'), internalDate: Date.parse('2026-10-20T09:00:00Z') });
    cloud!.google.messages.push({ id: 'g2', threadId: 't2', labelIds: ['INBOX'], raw: mail('Ben <ben@example.com>', 'Deleted meanwhile', 'Gone'), internalDate: Date.parse('2026-10-19T09:00:00Z') });
    cloud!.google.messages.push({ id: 'g3', threadId: 't3', labelIds: ['INBOX'], raw: mail('Cleo <cleo@example.com>', 'Notes', 'Attached'), internalDate: Date.parse('2026-10-18T09:00:00Z') });
    // the owner deleted g2 in Gmail after the list call named it: its fetch answers 404
    cloud!.google.failFetch.set('g2', 404);
    const found = await pim.mailSearch({ limit: 5 });
    expect(found.map((m) => m.subject).sort()).toEqual(['Lunch', 'Notes']);
    // Gmail failing on one is still an error, said as Gmail said it
    cloud!.google.failFetch.set('g3', 500);
    await expect(pim.mailSearch({ limit: 5 })).rejects.toThrow('Gmail answered 500: Backend Error');
  });

  test('an expired access token refreshes with the client the account signed in with', async () => {
    let now = NOW;
    const { pim } = setup({ now: () => now });
    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { mail: true } });
    const { code, state } = cloud!.approveGoogle(flow.url!);
    await pim.oauth.finishGoogle({ state, code });
    const before = cloud!.requests.filter((r) => r.path === '/google/token').length;
    await pim.mailSearch({ limit: 1 });
    expect(cloud!.requests.filter((r) => r.path === '/google/token').length).toBe(before);
    now += 2 * 3_600_000;
    await pim.mailSearch({ limit: 1 });
    const refreshes = cloud!.requests.filter((r) => r.path === '/google/token' && new URLSearchParams(r.body).get('grant_type') === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(new URLSearchParams(refreshes[0].body).get('client_id')).toBe(cloud!.google.clientId);
  });

  test('a gmail.readonly account cannot draft until the owner signs in again with drafts on', async () => {
    const { pim } = setup();
    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { mail: true } });
    const { code, state } = cloud!.approveGoogle(flow.url!);
    const done = await pim.oauth.finishGoogle({ state, code });
    expect(pim.accounts()[0].scopes).not.toContain('https://www.googleapis.com/auth/gmail.compose');
    await expect(pim.proposeMail({ to: 'a@b.org', subject: 's', body: 'b' })).rejects.toThrow(/may not save drafts/);
    expect(() => pim.updateAccount(done.accountId!, { drafts: true })).toThrow(/Sign in again with drafts on/);
  });

  test('the Web application client needs an https hub address and the hub\'s own client', async () => {
    const http = setup({ publicUrl: 'http://hub.lan:7777' });
    expect(http.pim.settings().oauth.google.redirect.web).toBeUndefined();
    expect(() => http.pim.oauth.startGoogle({ client: 'web', wants: { mail: true } })).toThrow(/Web application client/);
    cloud!.stop();
    http.cleanup();
    const { pim, secrets } = setup({ publicUrl: 'https://hub.example.ts.net' });
    pim.oauth.setHubClients({ googleWebClientId: 'hub-web.apps.googleusercontent.com', googleWebSecret: 'GOCSPX-hub-web' });
    expect(secrets.get('pim.oauth.google.web')).toBe('GOCSPX-hub-web');
    const st = pim.settings().oauth.google;
    expect(st).toMatchObject({ redirect: { web: 'https://hub.example.ts.net/api/pim/oauth/google/callback' }, hub: { webClientId: 'hub-web.apps.googleusercontent.com', webSecret: true } });
    expect(st.how).toContain('any browser');
    const flow = pim.oauth.startGoogle({ client: 'web', wants: { mail: true, calendar: true } });
    expect(new URL(flow.url!).searchParams.get('redirect_uri')).toBe('https://hub.example.ts.net/api/pim/oauth/google/callback');
    // a desktop sign-in must come back to this computer
    expect(() => pim.oauth.startGoogle({ client: 'desktop', redirectUri: 'http://evil.example/cb', wants: { mail: true } })).toThrow(/127.0.0.1 or http:\/\/localhost/);
  });

  test('a phone signs in with the shipped Android client and hands the code to the hub', async () => {
    const { pim } = setup({ shipped: (c) => shipped(c, { android: { clientId: '123-android.apps.googleusercontent.com' } }) });
    expect(() => pim.oauth.startGoogle({ client: 'android', redirectUri: 'https://hub/cb', wants: { mail: true } })).toThrow(/app's scheme/);
    const flow = pim.oauth.startGoogle({ client: 'android', redirectUri: 'com.googleusercontent.apps.123-android:/oauth2redirect', wants: { mail: true, calendar: true } });
    const { code, state } = cloud!.approveGoogle(flow.url!);
    const done = await pim.oauth.finishGoogle({ state, code });
    expect(done.state).toBe('done');
    const acc = pim.accounts()[0];
    expect(acc).toMatchObject({ client: 'android', clientId: '123-android.apps.googleusercontent.com', calendar: true });
    // no secret goes with a phone client
    const tokenReq = cloud!.requests.find((r) => r.path === '/google/token')!;
    expect(new URLSearchParams(tokenReq.body).has('client_secret')).toBe(false);
  });

  test('Google Calendar: calendars, expanded events, free/busy of others, and an approved invite', async () => {
    const { pim } = setup();
    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { calendar: true, calendarWrite: true, mail: false } });
    expect(new URL(flow.url!).searchParams.get('scope')!.split(' ')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events']);
    cloud!.google.events.set('primary', [{ id: 'e1_20261021T160000Z', recurringEventId: 'e1', summary: 'Gym', status: 'confirmed', start: { dateTime: '2026-10-21T18:00:00+02:00' }, end: { dateTime: '2026-10-21T19:00:00+02:00' } }, { id: 'h1', summary: 'Holiday', status: 'confirmed', start: { date: '2026-10-21' }, end: { date: '2026-10-22' } }]);
    const { code, state } = cloud!.approveGoogle(flow.url!);
    await pim.oauth.finishGoogle({ state, code });
    const cals = pim.calendars();
    expect(cals.map((c) => [c.name, c.read, c.write, c.scheduling])).toEqual([['owner@gmail.com', true, true, true]]);
    const { events } = await pim.events({ start: Date.parse('2026-10-20T22:00:00Z'), end: Date.parse('2026-10-21T22:00:00Z') });
    expect(events.map((e) => [e.title, e.allDay, e.busy, e.recurring])).toEqual([
      ['Holiday', true, false, false],
      ['Gym', false, true, true],
    ]);
    cloud!.google.busy.set('ana@example.com', [{ start: '2026-10-22T08:00:00Z', end: '2026-10-22T09:00:00Z' }]);
    const fb = await pim.freeBusy({ start: Date.parse('2026-10-21T22:00:00Z'), end: Date.parse('2026-10-22T22:00:00Z'), attendees: ['ana@example.com', 'ghost@example.com'], meetingMinutes: 30 });
    expect(fb.busy.map((b) => b.who)).toEqual([['ana@example.com']]);
    expect(fb.unknown).toEqual(['ghost@example.com']);
    const p = await pim.proposeEvent({ action: 'create', event: { title: 'Project sync', start: '2026-10-22T14:00', end: '2026-10-22T14:30', attendees: ['ana@example.com'] } });
    expect(p.event).toMatchObject({ invites: 'server', attendees: ['ana@example.com'] });
    expect(cloud!.google.events.get('primary')).toHaveLength(2);
    await pim.approve(p.id);
    const added = cloud!.google.events.get('primary')!.find((e) => e.summary === 'Project sync')!;
    expect(added).toMatchObject({ sendUpdates: 'all', attendees: [{ email: 'ana@example.com' }], start: { dateTime: '2026-10-22T12:00:00.000Z', timeZone: 'Europe/Berlin' } });
    // move one occurrence of the series
    const gym = events.find((e) => e.title === 'Gym')!;
    const move = await pim.proposeEvent({ action: 'update', eventId: gym.id, event: { start: '2026-10-21T19:00', end: '2026-10-21T20:00' } });
    await pim.approve(move.id);
    expect(cloud!.requests.some((r) => r.method === 'PATCH' && r.path.includes('/events/e1_20261021T160000Z'))).toBe(true);
  });

  test('Google Calendar: a series changed from one week moves by the change and keeps its notes; an all-day event ending the day it starts lasts that day', async () => {
    const { pim } = setup();
    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { calendar: true, calendarWrite: true, mail: false } });
    const long = `Dial in: ${'1'.repeat(5000)}`;
    cloud!.google.events.set('primary', [
      { id: 'gym', summary: 'Gym', description: long, status: 'confirmed', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=6'], start: { dateTime: '2026-10-07T18:00:00+02:00', timeZone: 'Europe/Berlin' }, end: { dateTime: '2026-10-07T19:00:00+02:00', timeZone: 'Europe/Berlin' } },
      { id: 'gym_20261021T160000Z', recurringEventId: 'gym', summary: 'Gym', description: long, status: 'confirmed', start: { dateTime: '2026-10-21T18:00:00+02:00' }, end: { dateTime: '2026-10-21T19:00:00+02:00' } },
    ]);
    const { code, state } = cloud!.approveGoogle(flow.url!);
    await pim.oauth.finishGoogle({ state, code });
    const { events } = await pim.events({ start: Date.parse('2026-10-20T22:00:00Z'), end: Date.parse('2026-10-21T22:00:00Z') });
    expect(events.map((e) => e.title)).toEqual(['Gym']);
    const p = await pim.proposeEvent({ action: 'update', eventId: events[0].id, scope: 'series', event: { start: '2026-10-21T19:00', end: '2026-10-21T20:00' } });
    expect((await pim.approve(p.id)).status).toBe('applied');
    const master = cloud!.google.events.get('primary')!.find((e) => e.id === 'gym')!;
    // the series keeps its first week and moves an hour, in its own zone
    expect(Date.parse(master.start.dateTime)).toBe(Date.parse('2026-10-07T17:00:00Z'));
    expect(Date.parse(master.end.dateTime)).toBe(Date.parse('2026-10-07T18:00:00Z'));
    // notes longer than a proposal carries are not cut
    expect(master.description).toBe(long);
    const day = await pim.proposeEvent({ action: 'create', event: { title: 'Trip', start: '2026-10-24', end: '2026-10-24', allDay: true } });
    expect((await pim.approve(day.id)).status).toBe('applied');
    const trip = cloud!.google.events.get('primary')!.find((e) => e.summary === 'Trip')!;
    expect(trip.start).toEqual({ date: '2026-10-24' });
    expect(trip.end).toEqual({ date: '2026-10-25' });
  });

  test('disconnect revokes at Google and forgets the token', async () => {
    const { pim, secrets } = setup();
    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { mail: true } });
    const { code, state } = cloud!.approveGoogle(flow.url!);
    const done = await pim.oauth.finishGoogle({ state, code });
    const refresh = secrets.get(`pim.${done.accountId}.refresh`)!;
    const out = await pim.removeAccount(done.accountId!);
    expect(out.revoked).toBe(true);
    expect(cloud!.google.revoked).toEqual([refresh]);
    expect([...secrets.keys()]).toEqual([]);
    expect(pim.accounts()).toEqual([]);
  });

  test('PKCE: the token endpoint gets a verifier that hashes to the challenge in the URL', async () => {
    const { pim } = setup();
    const flow = pim.oauth.startGoogle({ client: 'desktop', wants: { mail: true } });
    const challenge = new URL(flow.url!).searchParams.get('code_challenge')!;
    const { code, state } = cloud!.approveGoogle(flow.url!);
    await pim.oauth.finishGoogle({ state, code });
    const verifier = new URLSearchParams(cloud!.requests.find((r) => r.path === '/google/token')!.body).get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe('Google through the relay', () => {
  const relayed = (c: FakeCloud) => shipped(c, { web: WEB });
  /** A relay state with a made-up flow id, for what the relay page would read. */
  const stateFor = (url: string) => `${'f'.repeat(32)}.${Buffer.from(url, 'utf8').toString('base64url')}`;

  test('the state carries the hub callback; Google gets the relay redirect and PKCE; the hub exchanges with the shared Web secret and refreshes with it', async () => {
    let now = NOW;
    const { pim } = setup({ shipped: relayed, now: () => now });
    const st = pim.settings().oauth.google;
    expect(st).toMatchObject({ ready: true, builtin: { web: true }, relay: GOOGLE_RELAY_URL });
    expect(st.how).toContain('Google opens a Conclave page at conclave.kaivalyaahir.com. Press Continue there');
    expect(JSON.stringify(pim.settings())).not.toContain(WEB.clientSecret);

    const flow = pim.oauth.startGoogle({ client: 'relay', returnTo: 'http://192.168.1.20:7777', wants: { mail: true } });
    const u = new URL(flow.url!);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: WEB.clientId, redirect_uri: 'https://conclave.kaivalyaahir.com/oauth/google/', response_type: 'code', code_challenge_method: 'S256', access_type: 'offline' });
    const state = u.searchParams.get('state')!;
    const [id, back, extra] = state.split('.');
    expect(extra).toBeUndefined();
    expect(id).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(Buffer.from(back, 'base64url').toString('utf8')).toBe(`http://192.168.1.20:7777${CB}`);
    expect(relayReturn(state)).toBe(`http://192.168.1.20:7777${CB}`);
    // each sign-in its own random id
    const again = pim.oauth.startGoogle({ client: 'relay', returnTo: 'http://192.168.1.20:7777', wants: { mail: true } });
    expect(new URL(again.url!).searchParams.get('state')).not.toBe(state);

    // the relay page sends the browser to that callback with code and state, unchanged
    const { code } = cloud!.approveGoogle(flow.url!);
    const done = await pim.oauth.finishGoogle({ state, code });
    expect(done.state).toBe('done');
    const tokenReq = new URLSearchParams(cloud!.requests.find((r) => r.path === '/google/token')!.body);
    expect(tokenReq.get('redirect_uri')).toBe(GOOGLE_RELAY_URL);
    expect(tokenReq.get('client_id')).toBe(WEB.clientId);
    expect(tokenReq.get('client_secret')).toBe(WEB.clientSecret);
    expect(createHash('sha256').update(tokenReq.get('code_verifier')!).digest('base64url')).toBe(u.searchParams.get('code_challenge')!);
    expect(pim.accounts()[0]).toMatchObject({ kind: 'google', client: 'relay', clientId: WEB.clientId, mail: true });

    // an hour later the refresh goes with the same Web client and its secret
    now += 2 * 3_600_000;
    await pim.mailSearch({ limit: 1 });
    const refresh = cloud!.requests.filter((r) => r.path === '/google/token' && new URLSearchParams(r.body).get('grant_type') === 'refresh_token');
    expect(refresh).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(refresh[0].body))).toMatchObject({ client_id: WEB.clientId, client_secret: WEB.clientSecret });
  });

  test('an unknown or expired relay state is refused as before', async () => {
    let now = NOW;
    const { pim } = setup({ shipped: relayed, now: () => now });
    // a state the relay page would accept, but no sign-in here made it
    await expect(pim.oauth.finishGoogle({ state: stateFor(`http://hub.lan:7777${CB}`), code: '4/x' })).rejects.toThrow(/unknown or already finished/);
    const flow = pim.oauth.startGoogle({ client: 'relay', returnTo: 'http://hub.lan:7777', wants: { mail: true } });
    const { code, state } = cloud!.approveGoogle(flow.url!);
    now += 16 * 60_000;
    const late = await pim.oauth.finishGoogle({ state, code });
    expect(late).toMatchObject({ state: 'failed', error: 'The sign-in took too long. Start it again.' });
    expect(cloud!.requests.filter((r) => r.path === '/google/token')).toHaveLength(0);
    expect(pim.accounts()).toEqual([]);
  });

  test('the hub sends only an http or https origin to come back to, with nothing after the host', () => {
    const { pim } = setup({ shipped: relayed });
    expect(relayCallback('http://hub.lan:7777')).toBe(`http://hub.lan:7777${CB}`);
    expect(relayCallback('http://hub.lan:7777/')).toBe(`http://hub.lan:7777${CB}`);
    expect(relayCallback('HTTPS://Hub.Example')).toBe(`https://hub.example${CB}`);
    expect(relayCallback('http://[::1]:7777')).toBe(`http://[::1]:7777${CB}`);
    for (const bad of ['', 'not an address', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://hub.lan', 'http://user:pw@hub.lan:7777', 'http://user@hub.lan:7777', 'http://hub.lan:7777/other', `http://hub.lan:7777${CB}`, 'http://hub.lan:7777/?next=x', 'http://hub.lan:7777/#x']) {
      expect(relayCallback(bad)).toBeUndefined();
      expect(() => pim.oauth.startGoogle({ client: 'relay', returnTo: bad, wants: { mail: true } })).toThrow(OAuthError);
    }
    expect(() => pim.oauth.startGoogle({ client: 'relay', wants: { mail: true } })).toThrow(/hub address to send the sign-in back to/);
  });

  test('what the relay page accepts from a state: exactly an http or https origin and the callback path', () => {
    expect(relayReturn(stateFor(`http://hub.lan:7777${CB}`))).toBe(`http://hub.lan:7777${CB}`);
    expect(relayReturn(stateFor(`https://hub.example.ts.net${CB}`))).toBe(`https://hub.example.ts.net${CB}`);
    for (const bad of [
      'http://hub.lan:7777/api/pim/oauth/google/other',
      `http://hub.lan:7777${CB}/x`,
      `http://hub.lan:7777${CB}?next=https://evil.example`,
      `http://hub.lan:7777${CB}#x`,
      `http://hub.lan:7777/api/pim/oauth/google/../google/callback`,
      `javascript:alert(1)//${CB}`,
      `data:text/html,${CB}`,
      `ftp://hub.lan${CB}`,
      `http://user:pw@hub.lan:7777${CB}`,
      `http://user@hub.lan:7777${CB}`,
      `HTTP://hub.lan:7777${CB}`,
      `http://hub.lan:80${CB}`,
      ` http://hub.lan${CB}`,
    ]) {
      expect(isRelayReturn(bad)).toBe(false);
      expect(relayReturn(stateFor(bad))).toBeUndefined();
    }
    for (const bad of ['', 'nodot', `short.${Buffer.from(`http://hub.lan${CB}`).toString('base64url')}`, `${'f'.repeat(32)}.`, `${'f'.repeat(32)}.a.b`, `${'f'.repeat(32)}.!!`]) expect(relayReturn(bad)).toBeUndefined();
    // the hub's own encoding reads back
    expect(relayReturn(relayState('f'.repeat(32), `http://hub.lan:7777${CB}`))).toBe(`http://hub.lan:7777${CB}`);
  });

  test('the choice order: the hub\'s own Web client with https first, then the relay, then loopback', () => {
    const { pim } = setup({ shipped: relayed, publicUrl: 'https://hub.example.ts.net' });
    expect(pim.settings().oauth.google.how).toContain('Press Continue there');
    pim.oauth.setHubClients({ googleWebClientId: 'hub-web.apps.googleusercontent.com', googleWebSecret: 'GOCSPX-hub-web' });
    const st = pim.settings().oauth.google;
    expect(st.how).toBe('Sign in from any browser: Google sends you back to this hub at its https address.');
    // the relay stays there for a browser that is not on the hub's https address
    expect(st.relay).toBe(GOOGLE_RELAY_URL);
    expect(new URL(pim.oauth.startGoogle({ client: 'web', wants: { mail: true } }).url!).searchParams.get('client_id')).toBe('hub-web.apps.googleusercontent.com');
  });

  test('without the shared Web client the relay is off and sign-in works as before', () => {
    const first = setup();
    const { pim } = first;
    const st = pim.settings().oauth.google;
    expect(st.relay).toBeUndefined();
    expect(st.builtin.web).toBe(false);
    expect(st.how).toContain('paste it here');
    expect(() => pim.oauth.startGoogle({ client: 'relay', returnTo: 'http://hub.lan:7777', wants: { mail: true } })).toThrow(/relay is off/);
    // half a client (an id without its secret) is no client: a Web client cannot exchange a code without it
    cloud!.stop();
    first.cleanup();
    const half = setup({ shipped: (c) => shipped(c, { web: { clientId: WEB.clientId, clientSecret: '' } }) });
    expect(half.pim.settings().oauth.google.relay).toBeUndefined();
  });
});

describe('Microsoft', () => {
  test('device code sign-in, Graph search and read, a reply draft, refresh rotation, and an honest disconnect', async () => {
    let now = NOW;
    const { pim, secrets } = setup({ now: () => now });
    expect(pim.settings().oauth.microsoft).toMatchObject({ builtin: true, ready: true });
    const flow = await pim.oauth.startMicrosoft({ wants: { drafts: true } });
    expect(flow).toMatchObject({ provider: 'microsoft', state: 'waiting', userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin' });
    const scope = new URLSearchParams(cloud!.requests.find((r) => r.path === '/ms/devicecode')!.body).get('scope')!;
    expect(scope.split(' ')).toEqual(['openid', 'email', 'profile', 'offline_access', 'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.ReadWrite']);
    let f = pim.oauth.flow(flow.id)!;
    for (let i = 0; i < 40 && f.state === 'waiting'; i++) {
      await Bun.sleep(100);
      f = pim.oauth.flow(flow.id)!;
    }
    expect(f.state).toBe('done');
    const acc = pim.accounts()[0];
    expect(acc).toMatchObject({ kind: 'microsoft', email: 'owner@outlook.com', mail: true });
    const first = secrets.get(`pim.${acc.id}.refresh`)!;

    cloud!.microsoft.messages.push({ id: 'AAMk1', subject: 'Exam room', from: { emailAddress: { name: 'Prof', address: 'prof@uni.example' } }, toRecipients: [{ emailAddress: { address: 'owner@outlook.com' } }], receivedDateTime: '2026-10-20T08:00:00Z', isRead: false, bodyPreview: 'Room 3.12', hasAttachments: false, internetMessageId: '<exam@uni>', body: { contentType: 'html', content: '<p>Room <b>3.12</b></p>' } });
    const list = await pim.mailSearch({ from: 'prof@uni.example', limit: 5 });
    expect(list.map((m) => [m.subject, m.unread, m.snippet])).toEqual([['Exam room', true, 'Room 3.12']]);
    const read = await pim.mailRead(list[0].id);
    expect(read.text).toBe('Room 3.12');
    const p = await pim.proposeMail({ to: 'prof@uni.example', body: 'Thanks.', replyTo: list[0].id });
    await pim.approve(p.id);
    expect(cloud!.microsoft.drafts).toEqual([expect.objectContaining({ replyTo: 'AAMk1', comment: 'Thanks.' })]);
    expect(cloud!.microsoft.sent).toEqual([]);

    // with an HTML signature on the Microsoft account, a reply draft creates the reply first and PATCHes its body with the reply + signature prepended above the quoted thread
    pim.updateAccount(acc.id, { signature: '<b style="color: #C41230">Kaivalya Ahir</b>' });
    const pSig = await pim.proposeMail({ to: 'prof@uni.example', body: 'On my way.\n\nBest,', replyTo: list[0].id });
    await pim.approve(pSig.id);
    expect(cloud!.microsoft.drafts).toHaveLength(2);
    expect(cloud!.microsoft.drafts[1].comment).toBeUndefined();
    expect(cloud!.microsoft.drafts[1].body).toEqual({
      contentType: 'HTML',
      content: '<p>On my way.</p>\n<p>Best,</p>\n<b style="color:#C41230">Kaivalya Ahir</b>\n<p>Room <b>3.12</b></p>',
    });

    // an hour later the hub refreshes and keeps the rotated refresh token
    now += 2 * 3_600_000;
    await pim.mailSearch({ limit: 1 });
    const second = secrets.get(`pim.${acc.id}.refresh`)!;
    expect(second).not.toBe(first);
    expect(cloud!.microsoft.refresh.has(first)).toBe(false);

    const out = await pim.removeAccount(acc.id);
    expect(out.revoked).toBe(false);
    expect(out.note).toContain('account.live.com/consent/Manage');
    expect(secrets.size).toBe(0);
  });

  test('a refresh under way when the owner disconnects does not bring the rotated token back', async () => {
    let now = NOW;
    const { pim, secrets } = setup({ now: () => now });
    const flow = await pim.oauth.startMicrosoft({ wants: {} });
    let f = pim.oauth.flow(flow.id)!;
    for (let i = 0; i < 40 && f.state === 'waiting'; i++) {
      await Bun.sleep(100);
      f = pim.oauth.flow(flow.id)!;
    }
    expect(f.state).toBe('done');
    const acc = pim.account(f.accountId!);
    now += 2 * 3_600_000;
    // the refresh starts, and the owner removes the account before Microsoft answers
    const refresh = pim.oauth.token(acc).catch((e: Error) => e);
    await pim.removeAccount(acc.id);
    const out = await refresh;
    expect(out).toBeInstanceOf(Error);
    expect(secrets.size).toBe(0);
  });

  test('without a client the hub says so instead of failing at Microsoft', async () => {
    const { pim } = setup({ shipped: (c) => ({ ...shipped(c), microsoft: { clientId: '' } }) });
    await expect(pim.oauth.startMicrosoft({ wants: {} })).rejects.toThrow(/no Microsoft client/);
    pim.oauth.setHubClients({ microsoftClientId: cloud!.microsoft.clientId });
    expect(pim.settings().oauth.microsoft).toMatchObject({ builtin: false, hubClientId: cloud!.microsoft.clientId, ready: true });
  });
});
