/**
 * Mock routes for calendar and mail (docs/DESIGN.md, Calendar and mail): a
 * Nextcloud calendar and an Outlook account on the busy hub, today's events,
 * two proposals waiting (a workout and a draft reply), and sign-ins that
 * finish after a few seconds. A first-run hub has none of it.
 */
import type { CalendarInfo, OAuthFlowDto, PimAccountDto, PimSettingsDto, ProposalDto, TodayEvent } from '@conclave/core/client';
import { CALDAV_PRESETS } from '@conclave/core/calendar/types';
import { MAIL_PRESETS } from '@conclave/core/mail/types';
import type { MockCtx } from './index';

const ZONE = 'Europe/Berlin';
const MIN = 60_000;

/** Today at a local time in the owner's zone. */
function at(hhmm: string, dayOffset = 0): number {
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const offset = local - Math.floor(now.getTime() / MIN) * MIN;
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(+p.year, +p.month - 1, +p.day + dayOffset, h, m) - offset;
}

let accounts: PimAccountDto[] = [];
let proposals: ProposalDto[] = [];
let events: TodayEvent[] = [];
const flows = new Map<string, OAuthFlowDto>();

function calendars(): CalendarInfo[] {
  return accounts.flatMap((a) => (a.calendar ? (a.calendars ?? []).map((c, i) => ({ id: `cal_${a.id.slice(-4)}${i}`, accountId: a.id, account: a.label, name: c.name, ...(c.color ? { color: c.color } : {}), writable: c.writable, read: c.read, write: c.write, scheduling: true })) : []));
}

export function pimTodayExtras(): { events?: TodayEvent[]; proposals?: ProposalDto[] } {
  const readable = new Set(calendars().filter((c) => c.read).map((c) => c.name));
  const pending = proposals.filter((p) => p.status === 'pending');
  return { ...(readable.size ? { events: events.filter((e) => readable.has(e.calendar)) } : {}), ...(pending.length ? { proposals: pending } : {}) };
}

export function registerPim(ctx: MockCtx) {
  const { on, uid, fail, sleep } = ctx;
  if (!ctx.FRESH) {
    const now = Date.now();
    accounts = [
      {
        id: 'acct_nc',
        kind: 'caldav',
        label: 'Nextcloud',
        preset: 'nextcloud',
        serverUrl: 'https://cloud.home.arpa/remote.php/dav',
        username: 'sam',
        calendar: true,
        scheduling: true,
        organizer: 'sam@home.arpa',
        calendars: [
          { remoteId: 'https://cloud.home.arpa/remote.php/dav/calendars/sam/personal/', name: 'Personal', color: '#2e7d32', writable: true, read: true, write: true },
          { remoteId: 'https://cloud.home.arpa/remote.php/dav/calendars/sam/uni/', name: 'Uni', color: '#1565c0', writable: true, read: true, write: false },
          { remoteId: 'https://cloud.home.arpa/remote.php/dav/calendars/sam/holidays/', name: 'Holidays', writable: false, read: false, write: false },
        ],
        createdAt: now - 20 * 86_400_000,
        updatedAt: now - 3_600_000,
        lastCheck: { at: now - 3_600_000, ok: true, detail: '3 calendars.' },
        signedIn: true,
      },
      {
        id: 'acct_ms',
        kind: 'microsoft',
        label: 'sam@outlook.com',
        email: 'sam@outlook.com',
        address: 'sam@outlook.com',
        client: 'microsoft',
        scopes: ['openid', 'email', 'profile', 'offline_access', 'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.ReadWrite'],
        mail: true,
        drafts: true,
        send: false,
        createdAt: now - 6 * 86_400_000,
        updatedAt: now - 7_200_000,
        lastCheck: { at: now - 7_200_000, ok: true, detail: 'Signed in as sam@outlook.com, inbox 1,204 messages.' },
        signedIn: true,
      },
    ];
    events = [
      { id: 'ev_lecture01', title: 'Operating Systems lecture', start: at('10:15'), end: at('11:45'), allDay: false, calendar: 'Uni', color: '#1565c0', location: 'HS 1' },
      { id: 'ev_lunch0001', title: 'Lunch with Ana', start: at('12:30'), end: at('13:15'), allDay: false, calendar: 'Personal', color: '#2e7d32' },
      { id: 'ev_shift0001', title: 'Bar shift', start: at('18:00'), end: at('22:00'), allDay: false, calendar: 'Personal', color: '#2e7d32' },
    ];
    proposals = [
      {
        id: 'prop_run',
        kind: 'event',
        action: 'create',
        status: 'pending',
        summary: 'Workout: run, tomorrow 07:00 in Personal',
        createdAt: now - 12 * MIN,
        sessionId: 's_brief',
        event: { title: 'Workout: run', start: at('07:00', 1), end: at('07:45', 1), allDay: false, calendarId: 'cal_nc0', calendar: 'Personal', account: 'Nextcloud' },
      },
      {
        id: 'prop_reply',
        kind: 'mail',
        action: 'draft',
        status: 'pending',
        summary: 'Draft to ana@uni.example: Re: Lunch Thursday?',
        createdAt: now - 9 * MIN,
        sessionId: 's_brief',
        mail: { accountId: 'acct_ms', account: 'sam@outlook.com', from: 'sam@outlook.com', to: ['ana@uni.example'], cc: [], subject: 'Re: Lunch Thursday?', body: 'Thursday at 12 works. See you at the Mensa.', inReplyTo: 'Lunch Thursday?' },
      },
    ];
  }

  const settings = (): PimSettingsDto => ({
    accounts,
    calendars: calendars(),
    timezone: ZONE,
    oauth: {
      google: { builtin: { desktop: true, web: false, ios: true, android: true }, hub: { webSecret: false, desktopSecret: false }, redirect: { loopback: 'http://127.0.0.1:7777/api/pim/oauth/google/callback' }, how: 'Sign in from any browser. This hub has no https address for Google, so after you allow, Google opens a page at 127.0.0.1 that may not load. Copy that address and paste it here.', ready: true },
      microsoft: { builtin: true, ready: true },
    },
    presets: { caldav: CALDAV_PRESETS, mail: MAIL_PRESETS },
    pending: proposals.filter((p) => p.status === 'pending').length,
  });

  on('GET', '/api/pim', () => settings());

  on('POST', '/api/pim/accounts/caldav', async ({ body }) => {
    await sleep(700);
    if (!body?.password) fail(400, 'A CalDAV account needs the server address, the user name and an app password.');
    if (body.password === 'wrong') fail(400, 'The server refused the user name or app password.');
    const a: PimAccountDto = {
      id: uid('acct'),
      kind: 'caldav',
      label: `${CALDAV_PRESETS.find((p) => p.id === body.preset)?.label ?? 'CalDAV'} (${body.username})`,
      preset: body.preset,
      serverUrl: body.serverUrl,
      username: body.username,
      calendar: true,
      calendars: [{ remoteId: `${body.serverUrl}/calendars/home/`, name: 'Home', writable: true, read: true, write: !accounts.some((x) => x.calendars?.some((c) => c.write)) }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastCheck: { at: Date.now(), ok: true, detail: '1 calendar found.' },
      signedIn: true,
    };
    accounts = [...accounts, a];
    return a;
  });

  on('POST', '/api/pim/accounts/imap', async ({ body }) => {
    await sleep(700);
    if (body?.password === 'wrong') fail(400, 'The server refused the login: [AUTHENTICATIONFAILED] Invalid credentials Check the user name and the app password.');
    const a: PimAccountDto = { id: uid('acct'), kind: 'imap', label: body.address || body.username, preset: body.preset, username: body.username, address: body.address || body.username, imap: { host: body.host, port: body.port, security: body.security }, mail: true, drafts: true, send: !!body.send, createdAt: Date.now(), updatedAt: Date.now(), lastCheck: { at: Date.now(), ok: true, detail: 'Inbox: 2,318 messages.' }, signedIn: true };
    accounts = [...accounts, a];
    return a;
  });

  on('PATCH', '/api/pim/accounts/:id', async ({ params, body }) => {
    await sleep(150);
    const a = accounts.find((x) => x.id === params[0]) ?? fail(404, 'unknown account');
    const next: PimAccountDto = { ...a, ...(typeof body.send === 'boolean' ? { send: body.send } : {}), ...(typeof body.drafts === 'boolean' ? { drafts: body.drafts } : {}), ...(typeof body.autoDraft === 'boolean' ? { autoDraft: body.autoDraft } : {}), ...(typeof body.signature === 'string' ? { signature: body.signature.trim() || undefined } : {}) };
    if (Array.isArray(body.calendars)) next.calendars = (a.calendars ?? []).map((c) => {
      const p = body.calendars.find((x: { remoteId: string }) => x.remoteId === c.remoteId);
      if (!p) return c;
      const read = p.read ?? c.read;
      return { ...c, read, write: (p.write ?? c.write) && c.writable && read };
    });
    accounts = accounts.map((x) => (x.id === a.id ? next : x));
    return next;
  });

  on('POST', '/api/pim/accounts/:id/test', async ({ params }) => {
    await sleep(600);
    const a = accounts.find((x) => x.id === params[0]) ?? fail(404, 'unknown account');
    const next = { ...a, lastCheck: { at: Date.now(), ok: true, detail: a.lastCheck?.detail ?? 'Works.' } };
    accounts = accounts.map((x) => (x.id === a.id ? next : x));
    return next;
  });

  on('DELETE', '/api/pim/accounts/:id', async ({ params }) => {
    await sleep(300);
    const a = accounts.find((x) => x.id === params[0]) ?? fail(404, 'unknown account');
    accounts = accounts.filter((x) => x.id !== a.id);
    return a.kind === 'microsoft' ? { revoked: false, note: 'Microsoft has no revoke for one app\'s tokens. The hub forgot them.' } : { revoked: a.kind === 'google' };
  });

  on('PUT', '/api/pim/oauth/clients', async () => {
    await sleep(200);
    return settings();
  });

  on('POST', '/api/pim/oauth/google/start', async () => {
    await sleep(300);
    const f: OAuthFlowDto = { id: uid('flow'), provider: 'google', state: 'waiting', expiresAt: Date.now() + 15 * MIN, url: 'about:blank' };
    flows.set(f.id, f);
    setTimeout(() => {
      flows.set(f.id, { ...f, state: 'done', accountId: 'acct_g' });
      accounts = [...accounts, { id: 'acct_g', kind: 'google', label: 'sam@gmail.com', email: 'sam@gmail.com', client: 'desktop', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'], mail: true, calendar: false, drafts: false, send: false, createdAt: Date.now(), updatedAt: Date.now(), lastCheck: { at: Date.now(), ok: true, detail: 'Signed in as sam@gmail.com.' }, signedIn: true }];
    }, 4_000);
    return f;
  });

  on('POST', '/api/pim/oauth/microsoft/start', async () => {
    await sleep(400);
    const f: OAuthFlowDto = { id: uid('flow'), provider: 'microsoft', state: 'waiting', expiresAt: Date.now() + 15 * MIN, userCode: 'K7QF-2MXP', verificationUri: 'https://microsoft.com/devicelogin' };
    flows.set(f.id, f);
    setTimeout(() => flows.set(f.id, { ...f, state: 'done', accountId: 'acct_ms' }), 8_000);
    return f;
  });

  on('GET', '/api/pim/oauth/flows/:id', ({ params }) => flows.get(params[0]) ?? fail(404, 'That sign-in is unknown or too old.'));

  on('GET', '/api/proposals', ({ query }) => {
    const status = query.get('status') ?? 'pending';
    return status === 'all' ? proposals : proposals.filter((p) => p.status === status);
  });

  on('POST', '/api/proposals/:id/approve', async ({ params }) => {
    await sleep(500);
    const p = proposals.find((x) => x.id === params[0]) ?? fail(404, `unknown proposal ${params[0]}`);
    if (p.status !== 'pending') return p;
    const next: ProposalDto = { ...p, status: 'applied', decidedAt: Date.now(), result: p.kind === 'mail' ? 'Saved in the Outlook Drafts folder.' : `It is in ${p.event?.calendar}.` };
    proposals = proposals.map((x) => (x.id === p.id ? next : x));
    return next;
  });

  on('POST', '/api/proposals/:id/decline', async ({ params, body }) => {
    await sleep(250);
    const p = proposals.find((x) => x.id === params[0]) ?? fail(404, `unknown proposal ${params[0]}`);
    if (p.status !== 'pending') return p;
    const next: ProposalDto = { ...p, status: 'declined', decidedAt: Date.now(), ...(body?.note ? { result: body.note } : {}) };
    proposals = proposals.map((x) => (x.id === p.id ? next : x));
    return next;
  });
}
