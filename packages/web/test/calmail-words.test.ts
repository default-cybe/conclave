/** Words for calendar events, proposals and Settings > Calendar and mail. */
import { describe, expect, test } from 'bun:test';
import type { GoogleOAuthStatus, ProposalDto } from '@conclave/core/client';
import { approveWords, clock, eventRange, eventWhen, inviteWords, nextEventLine, outcomeWords, proposalQuestion } from '../src/features/home/proposalWords';
import { accountKind, checkWords, googleChoice, googleWaitWords, hubOrigin, onHubMachine, pastedCallback, scopeWords } from '../src/features/settings/calmailWords';

const Z = 'Europe/Berlin';
const t = (iso: string) => Date.parse(iso);

describe('event words', () => {
  test('times read in the owner\'s zone, across the DST change too', () => {
    expect(clock(t('2026-10-24T16:00:00Z'), Z)).toBe('18:00');
    expect(clock(t('2026-10-26T17:00:00Z'), Z)).toBe('18:00');
    expect(eventRange({ start: t('2026-10-22T16:00:00Z'), end: t('2026-10-22T17:00:00Z'), allDay: false }, Z)).toBe('18:00 to 19:00');
    expect(eventRange({ start: t('2026-10-22T20:00:00Z'), end: t('2026-10-23T01:00:00Z'), allDay: false }, Z)).toBe('22:00 to Fri 23 Oct 03:00');
    expect(eventRange({ start: t('2026-10-21T22:00:00Z'), end: t('2026-10-22T22:00:00Z'), allDay: true }, Z)).toBe('All day');
    expect(eventWhen({ start: t('2026-10-22T05:00:00Z'), end: t('2026-10-22T05:45:00Z'), allDay: false }, Z)).toBe('Thu 22 Oct, 07:00 to 07:45');
    expect(eventWhen({ start: t('2026-10-21T22:00:00Z'), end: t('2026-10-22T22:00:00Z'), allDay: true }, Z)).toBe('Thu 22 Oct, all day');
  });

  test('the next event line', () => {
    const ev = (title: string, s: string, e: string, allDay = false) => ({ id: title, title, start: t(s), end: t(e), allDay, calendar: 'Personal' });
    const list = [ev('Holiday', '2026-10-21T22:00:00Z', '2026-10-22T22:00:00Z', true), ev('Lecture', '2026-10-22T08:15:00Z', '2026-10-22T09:45:00Z'), ev('Gym', '2026-10-22T16:00:00Z', '2026-10-22T17:00:00Z')];
    expect(nextEventLine(list, t('2026-10-22T06:00:00Z'), Z)).toBe('Next: Lecture at 10:15');
    expect(nextEventLine(list, t('2026-10-22T09:00:00Z'), Z)).toBe('Now: Lecture, until 11:45');
    expect(nextEventLine(list, t('2026-10-22T20:00:00Z'), Z)).toBe('Today: Holiday');
    expect(nextEventLine([], t('2026-10-22T20:00:00Z'), Z)).toBeUndefined();
  });
});

describe('proposal words', () => {
  const base: ProposalDto = { id: 'p', kind: 'event', action: 'create', status: 'pending', summary: 's', createdAt: 0, event: { title: 'Run', start: 0, end: 1, allDay: false, calendarId: 'cal_1', calendar: 'Personal', account: 'Nextcloud' } };
  test('the card asks what it does', () => {
    expect(proposalQuestion(base)).toBe('Add to Personal?');
    expect(proposalQuestion({ ...base, action: 'update' })).toBe('Change in Personal?');
    expect(proposalQuestion({ ...base, action: 'delete' })).toBe('Delete from Personal?');
    expect(proposalQuestion({ ...base, kind: 'mail', action: 'draft' })).toBe('Save this draft?');
    expect(proposalQuestion({ ...base, kind: 'mail', action: 'send' })).toBe('Send this message?');
    expect(approveWords(base)).toBe('Add');
    expect(approveWords({ ...base, kind: 'mail', action: 'draft' })).toBe('Save draft');
  });
  test('invitations say who sends them', () => {
    expect(inviteWords(base)).toBeUndefined();
    expect(inviteWords({ ...base, event: { ...base.event!, attendees: ['ana@example.com'], invites: 'server' } })).toBe('Invites ana@example.com. The calendar sends the invitations.');
    expect(inviteWords({ ...base, event: { ...base.event!, attendees: ['ana@example.com'], invites: 'none' } })).toBe('With ana@example.com. This calendar sends no invitations.');
  });
  test('outcomes', () => {
    expect(outcomeWords({ ...base, status: 'applied' })).toBe('Added');
    expect(outcomeWords({ ...base, kind: 'mail', action: 'draft', status: 'applied' })).toBe('Draft saved');
    expect(outcomeWords({ ...base, status: 'failed', error: 'The server refused the event (403).' })).toBe('Failed: The server refused the event (403).');
    expect(outcomeWords({ ...base, status: 'declined' })).toBe('Declined');
  });
});

describe('settings words', () => {
  test('accounts and what their sign-in may do', () => {
    expect(accountKind({ kind: 'caldav', preset: 'nextcloud' })).toBe('Nextcloud calendar');
    expect(accountKind({ kind: 'caldav', preset: 'other' })).toBe('CalDAV calendar');
    expect(accountKind({ kind: 'imap', preset: 'icloud' })).toBe('iCloud mail over IMAP');
    expect(accountKind({ kind: 'google', mail: true, calendar: true })).toBe('Google mail and calendar');
    expect(accountKind({ kind: 'microsoft', mail: true })).toBe('Outlook mail');
    expect(scopeWords(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events'])).toEqual(['read mail', 'change events']);
    expect(scopeWords(['offline_access', 'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.ReadWrite'])).toEqual(['read mail', 'save drafts', 'stay signed in']);
    expect(checkWords({ signedIn: false })).toMatchObject({ tone: 'fault', word: 'Signed out' });
    expect(checkWords({ signedIn: true, lastCheck: { at: 0, ok: true, detail: '3 calendars.' } })).toMatchObject({ tone: 'ok', word: 'Works' });
  });

  test('which Google sign-in fits where the page is open', () => {
    const g = (over: Partial<GoogleOAuthStatus>): GoogleOAuthStatus => ({ builtin: { desktop: true, web: false, ios: false, android: false }, hub: { webSecret: false, desktopSecret: false }, redirect: { loopback: 'http://127.0.0.1:7777/x' }, how: '', ready: true, ...over });
    expect(onHubMachine('127.0.0.1')).toBe(true);
    expect(onHubMachine('hub.lan')).toBe(false);
    expect(googleChoice(g({}), 'localhost')).toEqual({ client: 'desktop' });
    // away from the hub machine the loopback sign-in still starts, and the owner pastes the address back
    expect(googleChoice(g({}), 'hub.lan')).toEqual({ client: 'desktop', paste: true });
    expect(googleChoice(g({ redirect: { web: 'https://hub.ts.net/cb', loopback: 'x' }, hub: { webClientId: 'w', webSecret: true, desktopSecret: false } }), 'hub.ts.net')).toEqual({ client: 'web' });
    expect(googleChoice(g({ builtin: { desktop: false, web: false, ios: false, android: false } }), 'localhost')).toEqual({ why: 'No Google client is set up on this hub yet. Follow the steps below once.' });
  });

  test('the order: the hub\'s own Web client with https, then the relay, then loopback, then pasting back', () => {
    const relay = 'https://conclave.kaivalyaahir.com/oauth/google/';
    const g = (over: Partial<GoogleOAuthStatus>): GoogleOAuthStatus => ({ builtin: { desktop: true, web: true, ios: false, android: false }, hub: { webSecret: false, desktopSecret: false }, redirect: { loopback: 'http://127.0.0.1:7777/x' }, relay, how: '', ready: true, ...over });
    const own = { redirect: { web: 'https://hub.ts.net/cb', loopback: 'x' }, hub: { webClientId: 'w', webSecret: true, desktopSecret: false } };
    // the hub's own Web client with its https address wins over the relay
    expect(googleChoice(g(own), 'hub.ts.net')).toEqual({ client: 'web' });
    // the relay everywhere else: another browser, a phone, the desktop app, and the hub machine itself
    for (const host of ['hub.lan', '192.168.1.20', 'localhost', '127.0.0.1']) expect(googleChoice(g({}), host)).toEqual({ client: 'relay' });
    // half of the own client (no secret, or no https address) leaves the relay in charge
    expect(googleChoice(g({ ...own, hub: { webClientId: 'w', webSecret: false, desktopSecret: false } }), 'hub.ts.net')).toEqual({ client: 'relay' });
    expect(googleChoice(g({ ...own, redirect: { loopback: 'x' } }), 'hub.lan')).toEqual({ client: 'relay' });
    // the relay works without the shipped Desktop client too
    expect(googleChoice(g({ builtin: { desktop: false, web: true, ios: false, android: false } }), 'hub.lan')).toEqual({ client: 'relay' });
    // no relay: loopback on the hub machine, else paste back
    const off = g({ relay: undefined, builtin: { desktop: true, web: false, ios: false, android: false } });
    expect(googleChoice(off, 'localhost')).toEqual({ client: 'desktop' });
    expect(googleChoice(off, 'hub.lan')).toEqual({ client: 'desktop', paste: true });
  });

  test('what to do while it waits, for each way', () => {
    expect(googleWaitWords({ client: 'relay' })).toBe('Allow it in the Google tab, then press Continue on the Conclave page it opens. This page updates when it is done.');
    expect(googleWaitWords({ client: 'desktop', paste: true })).toBe('Allow it in the Google tab, then paste the address above.');
    expect(googleWaitWords({ client: 'web' })).toBe('Finish the sign-in in the Google tab. This page updates when it is done.');
    expect(googleWaitWords({ client: 'desktop' })).toBe('Finish the sign-in in the Google tab. This page updates when it is done.');
  });

  test('the hub address the relay returns to is the one the page talks to', () => {
    // a browser or the desktop app: the API is the page's own origin
    expect(hubOrigin('http://192.168.1.20:7777', 'http://192.168.1.20:7777')).toBe('http://192.168.1.20:7777');
    expect(hubOrigin('https://hub.example.ts.net/', 'https://hub.example.ts.net')).toBe('https://hub.example.ts.net');
    // the phone app's page is capacitor://localhost: the hub is the API address
    expect(hubOrigin('http://192.168.1.20:7777', 'capacitor://localhost')).toBe('http://192.168.1.20:7777');
    // no usable API address: the page's own
    expect(hubOrigin('', 'http://hub.lan:7777')).toBe('http://hub.lan:7777');
    expect(hubOrigin('capacitor://localhost', 'http://hub.lan:7777')).toBe('http://hub.lan:7777');
  });
});

describe('pastedCallback', () => {
  test('reads state and code from the address Google sent the browser to', () => {
    expect(pastedCallback(' http://127.0.0.1:7717/api/pim/oauth/google/callback?state=abc&code=4%2F0Ax&scope=email ')).toEqual({ state: 'abc', code: '4/0Ax' });
    expect(pastedCallback('http://127.0.0.1:7717/api/pim/oauth/google/callback?error=access_denied&state=abc')).toEqual({ state: 'abc', error: 'access_denied' });
  });
  test('anything else is not a callback', () => {
    for (const t of ['', 'hello', 'http://127.0.0.1:7717/?code=x', 'http://x/?state=abc']) expect(pastedCallback(t)).toBeUndefined();
  });
});
