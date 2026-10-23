/**
 * An in-process CalDAV server for tests and the real run: Basic auth,
 * discovery through /.well-known/caldav, a principal with a calendar home,
 * a scheduling outbox and calendar-auto-schedule, calendars (one read-only,
 * one for tasks only, one subscribed), calendar-query with time ranges,
 * GET, PUT and DELETE with ETags. It uses its own namespace prefixes so the
 * client has to match by namespace.
 */
import { createHash } from 'node:crypto';
import { expand } from '../../src/calendar/ical';

export interface FakeCalendar {
  path: string;
  name: string;
  color?: string;
  readOnly?: boolean;
  components?: string[];
  subscribed?: boolean;
  objects: Map<string, { data: string; etag: string }>;
}

export interface FakeCaldav {
  url: string;
  user: string;
  password: string;
  calendars: Map<string, FakeCalendar>;
  requests: Array<{ method: string; path: string; auth?: string; body?: string }>;
  /** Busy periods of other people the outbox knows. */
  people: Map<string, Array<{ start: string; end: string }>>;
  put(calendar: string, name: string, data: string): void;
  objects(calendar: string): string[];
  stop(): void;
}

const etagOf = (data: string) => `"${createHash('sha1').update(data).digest('hex').slice(0, 16)}"`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ms(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav" xmlns:CSRV="http://calendarserver.org/ns/" xmlns:AI="http://apple.com/ns/ical/">${responses.join('')}</multistatus>`;
}

function ok(href: string, props: string): string {
  return `<response><href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
}

export function startFakeCaldav(opts: { user?: string; password?: string; zone?: string } = {}): FakeCaldav {
  const user = opts.user ?? 'owner';
  const password = opts.password ?? 'app-pass-1234';
  const zone = opts.zone ?? 'Europe/Berlin';
  const home = `/dav/calendars/${user}/`;
  const principal = `/dav/principals/${user}/`;
  const outbox = `${home}outbox/`;
  const calendars = new Map<string, FakeCalendar>();
  const add = (c: Omit<FakeCalendar, 'objects'>) => calendars.set(c.path, { ...c, objects: new Map() });
  add({ path: `${home}personal/`, name: 'Personal', color: '#2E7D32FF' });
  add({ path: `${home}work/`, name: 'Work', color: '#1565C0' });
  add({ path: `${home}shared/`, name: 'Team (read only)', readOnly: true });
  add({ path: `${home}tasks/`, name: 'Tasks', components: ['VTODO'] });
  add({ path: `${home}holidays/`, name: 'Holidays', subscribed: true });
  const requests: FakeCaldav['requests'] = [];
  const people = new Map<string, Array<{ start: string; end: string }>>();
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.text();
      requests.push({ method: req.method, path, auth: req.headers.get('authorization') ?? undefined, ...(body ? { body } : {}) });
      if (path === '/.well-known/caldav') return new Response(null, { status: 301, headers: { location: '/dav/' } });
      if (req.headers.get('authorization') !== expected) return new Response('no', { status: 401, headers: { 'www-authenticate': 'Basic realm="fake"' } });
      if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: { dav: '1, 2, 3, calendar-access, calendar-auto-schedule' } });
      if (req.method === 'PROPFIND') {
        const depth = req.headers.get('depth') ?? '0';
        if (path === '/' || path === '/dav/' || path === '/dav') return new Response(ms([ok('/dav/', `<current-user-principal><href>${principal}</href></current-user-principal>`)]), { status: 207, headers: { 'content-type': 'application/xml' } });
        if (path === principal)
          return new Response(ms([ok(principal, `<CAL:calendar-home-set><href>${home}</href></CAL:calendar-home-set><CAL:schedule-outbox-URL><href>${outbox}</href></CAL:schedule-outbox-URL><CAL:calendar-user-address-set><href>mailto:${user}@example.com</href><href>${principal}</href></CAL:calendar-user-address-set>`)]), { status: 207, headers: { 'content-type': 'application/xml' } });
        if (path === home) {
          const rs = [ok(home, '<resourcetype><collection/></resourcetype>')];
          if (depth === '1') {
            for (const c of calendars.values()) {
              const comps = (c.components ?? ['VEVENT']).map((x) => `<CAL:comp name="${x}"/>`).join('');
              const privs = c.readOnly ? '<privilege><read/></privilege>' : '<privilege><read/></privilege><privilege><write/></privilege>';
              rs.push(ok(c.path, `<resourcetype><collection/><CAL:calendar/>${c.subscribed ? '<CSRV:subscribed/>' : ''}</resourcetype><displayname>${esc(c.name)}</displayname><CAL:supported-calendar-component-set>${comps}</CAL:supported-calendar-component-set>${c.color ? `<AI:calendar-color>${c.color}</AI:calendar-color>` : ''}<CSRV:getctag>ctag-${c.objects.size}</CSRV:getctag><current-user-privilege-set>${privs}</current-user-privilege-set>`));
            }
            rs.push(ok(outbox, '<resourcetype><collection/><CAL:schedule-outbox/></resourcetype>'));
          }
          return new Response(ms(rs), { status: 207, headers: { 'content-type': 'application/xml' } });
        }
        return new Response('not found', { status: 404 });
      }
      if (req.method === 'REPORT') {
        const cal = calendars.get(path);
        if (!cal) return new Response('not found', { status: 404 });
        const m = /time-range start="(\d{8}T\d{6}Z)" end="(\d{8}T\d{6}Z)"/.exec(body ?? '');
        const t = (s: string) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
        const range = m ? { start: t(m[1]), end: t(m[2]) } : { start: 0, end: 8.64e15 };
        const rs: string[] = [];
        for (const [name, o] of cal.objects) {
          if (!expand(o.data, range, zone).length) continue;
          rs.push(ok(`${cal.path}${encodeURIComponent(name)}`, `<getetag>${o.etag}</getetag><CAL:calendar-data>${esc(o.data)}</CAL:calendar-data>`));
        }
        return new Response(ms(rs), { status: 207, headers: { 'content-type': 'application/xml' } });
      }
      if (req.method === 'POST' && path === outbox) {
        const attendees = [...(body ?? '').matchAll(/^ATTENDEE:mailto:(.+)$/gm)].map((x) => x[1].trim().toLowerCase());
        const rs = attendees.map((a) => {
          const busy = people.get(a);
          if (!busy) return `<CAL:response><CAL:recipient><href>mailto:${a}</href></CAL:recipient><CAL:request-status>3.7;Invalid calendar user</CAL:request-status></CAL:response>`;
          const fb = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REPLY', 'BEGIN:VFREEBUSY', ...busy.map((b) => `FREEBUSY:${b.start}/${b.end}`), 'END:VFREEBUSY', 'END:VCALENDAR'].join('\r\n');
          return `<CAL:response><CAL:recipient><href>mailto:${a}</href></CAL:recipient><CAL:request-status>2.0;Success</CAL:request-status><CAL:calendar-data>${esc(fb)}</CAL:calendar-data></CAL:response>`;
        });
        return new Response(`<?xml version="1.0"?><CAL:schedule-response xmlns="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav">${rs.join('')}</CAL:schedule-response>`, { status: 200, headers: { 'content-type': 'application/xml' } });
      }
      const slash = path.lastIndexOf('/');
      const cal = calendars.get(path.slice(0, slash + 1));
      const name = path.slice(slash + 1);
      if (!cal || !name) return new Response('not found', { status: 404 });
      const cur = cal.objects.get(name);
      if (req.method === 'GET') return cur ? new Response(cur.data, { status: 200, headers: { etag: cur.etag, 'content-type': 'text/calendar' } }) : new Response('gone', { status: 404 });
      if (req.method === 'PUT') {
        if (cal.readOnly || cal.subscribed) return new Response('read only', { status: 403 });
        if (req.headers.get('if-none-match') === '*' && cur) return new Response('exists', { status: 412 });
        const im = req.headers.get('if-match');
        if (im && (!cur || cur.etag !== im)) return new Response('changed', { status: 412 });
        const etag = etagOf(body ?? '');
        cal.objects.set(name, { data: body ?? '', etag });
        return new Response(null, { status: cur ? 204 : 201, headers: { etag } });
      }
      if (req.method === 'DELETE') {
        if (!cur) return new Response('gone', { status: 404 });
        const im = req.headers.get('if-match');
        if (im && cur.etag !== im) return new Response('changed', { status: 412 });
        cal.objects.delete(name);
        return new Response(null, { status: 204 });
      }
      return new Response('no', { status: 405 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/`,
    user,
    password,
    calendars,
    requests,
    people,
    put(calendar, name, data) {
      const c = [...calendars.values()].find((x) => x.name === calendar || x.path === calendar);
      if (!c) throw new Error(`no calendar ${calendar}`);
      c.objects.set(name, { data, etag: etagOf(data) });
    },
    objects(calendar) {
      const c = [...calendars.values()].find((x) => x.name === calendar || x.path === calendar);
      return c ? [...c.objects.values()].map((o) => o.data) : [];
    },
    stop: () => server.stop(true),
  };
}
