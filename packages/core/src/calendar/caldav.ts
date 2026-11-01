/**
 * A CalDAV client (RFC 4791, RFC 6638 for scheduling) over fetch: find the
 * calendars of an account, read the objects in a time range, write and delete
 * objects with ETags, and ask the scheduling outbox for other people's free
 * and busy time. Basic auth with an app password. The requests are few and
 * plain, so this is written out here instead of a WebDAV library.
 */
import { isIP } from 'node:net';
import { CALDAV, CS, APPLE, DAV, find, kid, kids, multistatus, parseXml, prop, textOf, type DavResponse } from './xml';
import { freeBusyPeriods, freeBusyRequest } from './ical';

export interface CaldavOptions {
  url: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface CaldavCalendar {
  /** Absolute URL of the collection. */
  url: string;
  name: string;
  color?: string;
  writable: boolean;
  ctag?: string;
}

export interface CaldavAccountInfo {
  principal: string;
  home: string;
  /** The scheduling outbox, for free/busy lookups of other people. */
  outbox?: string;
  /** The account's own addresses (mailto:), the first one is the organizer of invitations. */
  addresses: string[];
  /** The server sends invitations itself when an event has attendees (calendar-auto-schedule). */
  scheduling: boolean;
  calendars: CaldavCalendar[];
}

export interface CaldavObject {
  url: string;
  etag?: string;
  data: string;
}

export class CaldavError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const MAX_REDIRECTS = 5;

/**
 * Suffixes under which each name is someone else's: dynamic DNS and home
 * server names many self-hosted calendars use. Under these only the same
 * host counts.
 */
const SHARED_SUFFIXES = new Set(['duckdns.org', 'synology.me', 'myqnapcloud.com', 'ts.net', 'dyndns.org', 'ddns.net', 'no-ip.org', 'no-ip.biz', 'hopto.org', 'freeboxos.fr', 'myfritz.net', 'dynv6.net', 'nsupdate.info', 'mooo.com', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com']);

/**
 * Two hosts belong to the same provider when their registered domain
 * matches (caldav.icloud.com and p42-caldav.icloud.com). An IP address only
 * matches itself; "co.uk"-style names take three labels; a shared suffix
 * (duckdns.org) only the same host.
 */
function sameSite(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/^\[|\]$/g, '');
  const y = b.toLowerCase().replace(/^\[|\]$/g, '');
  if (x === y) return true;
  if (isIP(x) || isIP(y)) return false;
  const site = (h: string) => {
    const labels = h.split('.');
    const two = labels.slice(-2).join('.');
    // example.co.uk, example.com.au: the second level is the public part
    const n = /^(co|com|net|org|gov|ac|edu|ne|or|go)\.[a-z]{2}$/.test(two) ? 3 : 2;
    return labels.slice(-n).join('.');
  };
  const s = site(x);
  if (SHARED_SUFFIXES.has(s) || s.split('.').length < 2) return false;
  return s === site(y);
}

export class CaldavClient {
  private readonly base: URL;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly auth: string;

  constructor(private readonly opts: CaldavOptions) {
    let u: URL;
    try {
      u = new URL(opts.url.trim());
    } catch {
      throw new CaldavError('That server address is not a URL.');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CaldavError('The server address must start with https://.');
    this.base = u;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.auth = `Basic ${Buffer.from(`${opts.username}:${opts.password}`, 'utf8').toString('base64')}`;
  }

  /** One request, following redirects by hand so the password only goes to the provider's own hosts. */
  async request(method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; url: string; headers: Headers }> {
    let target = new URL(url, this.base);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const h: Record<string, string> = { ...headers };
      if (sameSite(target.hostname, this.base.hostname)) h.authorization = this.auth;
      if (body !== undefined && !h['content-type']) h['content-type'] = 'application/xml; charset=utf-8';
      let res: Response;
      try {
        res = await this.fetchFn(target.toString(), { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        const e = err as Error;
        throw new CaldavError(e.name === 'TimeoutError' ? `The server did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.` : `Could not reach ${target.host}: ${e.message}`);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new CaldavError(`The server redirected without a location (${res.status}).`, res.status);
        target = new URL(loc, target);
        if (target.protocol !== 'https:' && this.base.protocol === 'https:') throw new CaldavError('The server redirected to a plain http address. Refusing to send the password there.');
        if (res.status === 303) method = 'GET';
        continue;
      }
      const text = await res.text();
      if (res.status === 401 || res.status === 403) throw new CaldavError(res.status === 401 ? 'The server refused the user name or app password.' : 'The server says this account may not do that.', res.status);
      return { status: res.status, text, url: target.toString(), headers: res.headers };
    }
    throw new CaldavError('Too many redirects.');
  }

  private async propfind(url: string, depth: '0' | '1', props: string): Promise<{ responses: DavResponse[]; url: string }> {
    const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:cs="${CS}" xmlns:ic="${APPLE}"><d:prop>${props}</d:prop></d:propfind>`;
    const r = await this.request('PROPFIND', url, body, { depth });
    if (r.status === 404 || r.status === 405) throw new CaldavError(`No calendar service at ${new URL(r.url).pathname} (${r.status}).`, r.status);
    if (r.status !== 207) throw new CaldavError(`The server answered ${r.status} to PROPFIND.`, r.status);
    try {
      return { responses: multistatus(r.text), url: r.url };
    } catch (err) {
      throw new CaldavError(`The server's answer is not WebDAV XML: ${(err as Error).message}`);
    }
  }

  private abs(href: string, base: string): string {
    return new URL(href, base).toString();
  }

  /** The principal of the signed-in user: from the address given, else from /.well-known/caldav. */
  private async principal(): Promise<string> {
    const tries = [this.base.toString(), new URL('/.well-known/caldav', this.base).toString()];
    let last: Error | undefined;
    for (const url of tries) {
      try {
        const { responses, url: at } = await this.propfind(url, '0', '<d:current-user-principal/>');
        for (const r of responses) {
          const href = textOf(kid(prop(r, DAV, 'current-user-principal'), DAV, 'href')).trim();
          if (href) return this.abs(href, at);
        }
      } catch (err) {
        if (err instanceof CaldavError && (err.status === 401 || err.status === 403)) throw err;
        last = err as Error;
      }
    }
    throw new CaldavError(`Found no CalDAV account at this address.${last ? ` ${last.message}` : ''}`);
  }

  /** The account: principal, calendar home, outbox, addresses, scheduling, and the calendars that hold events. */
  async discover(): Promise<CaldavAccountInfo> {
    const principal = await this.principal();
    const p = await this.propfind(principal, '0', '<c:calendar-home-set/><c:schedule-outbox-URL/><c:calendar-user-address-set/>');
    const r = p.responses[0];
    if (!r) throw new CaldavError('The server sent an empty answer for the principal.');
    const homeHref = textOf(kid(prop(r, CALDAV, 'calendar-home-set'), DAV, 'href')).trim();
    if (!homeHref) throw new CaldavError('The account has no calendar home.');
    const home = this.abs(homeHref, p.url);
    const outboxHref = textOf(kid(prop(r, CALDAV, 'schedule-outbox-URL'), DAV, 'href')).trim();
    const addresses = kids(prop(r, CALDAV, 'calendar-user-address-set'), DAV, 'href')
      .map((h) => textOf(h).trim())
      .filter((h) => /^mailto:/i.test(h));
    let scheduling = false;
    try {
      const o = await this.request('OPTIONS', home);
      scheduling = /calendar-auto-schedule/i.test(o.headers.get('dav') ?? '');
    } catch {
      scheduling = false;
    }
    const calendars = await this.calendars(home);
    return { principal, home, ...(outboxHref ? { outbox: this.abs(outboxHref, p.url) } : {}), addresses, scheduling, calendars };
  }

  /** Calendar collections under a home that can hold events. */
  async calendars(home: string): Promise<CaldavCalendar[]> {
    const { responses, url } = await this.propfind(home, '1', '<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><ic:calendar-color/><cs:getctag/><d:current-user-privilege-set/>');
    const out: CaldavCalendar[] = [];
    for (const r of responses) {
      const rt = prop(r, DAV, 'resourcetype');
      if (!kid(rt, CALDAV, 'calendar')) continue;
      // a subscribed (read-only feed) calendar is still read; it is never written
      const subscribed = !!kid(rt, CS, 'subscribed');
      const comps = find(prop(r, CALDAV, 'supported-calendar-component-set'), CALDAV, 'comp').map((c) => (c.attrs.name ?? '').toUpperCase());
      if (comps.length && !comps.includes('VEVENT')) continue;
      const privs = prop(r, DAV, 'current-user-privilege-set');
      const names = new Set(find(privs, DAV, 'privilege').flatMap((p) => p.children.map((c) => c.name)));
      const writable = !subscribed && (!privs || names.has('all') || names.has('write') || names.has('write-content') || names.has('bind'));
      const color = textOf(prop(r, APPLE, 'calendar-color')).trim().slice(0, 7);
      const name = textOf(prop(r, DAV, 'displayname')).trim() || decodeURIComponent(new URL(r.href, url).pathname.split('/').filter(Boolean).pop() ?? 'Calendar');
      const ctag = textOf(prop(r, CS, 'getctag')).trim();
      out.push({ url: this.abs(r.href, url), name, writable, ...(/^#[0-9a-f]{6}$/i.test(color) ? { color } : {}), ...(ctag ? { ctag } : {}) });
    }
    return out;
  }

  /** The objects with an event in [start, end). The server filters by time; the caller expands repeats. */
  async objects(calendarUrl: string, start: number, end: number): Promise<CaldavObject[]> {
    const t = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${t(start)}" end="${t(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const r = await this.request('REPORT', calendarUrl, body, { depth: '1' });
    if (r.status !== 207) throw new CaldavError(`The server answered ${r.status} to the calendar query.`, r.status);
    const out: CaldavObject[] = [];
    for (const x of multistatus(r.text)) {
      const data = textOf(prop(x, CALDAV, 'calendar-data'));
      if (!data.trim()) continue;
      const etag = textOf(prop(x, DAV, 'getetag')).trim();
      out.push({ url: this.abs(x.href, r.url), data, ...(etag ? { etag } : {}) });
    }
    return out;
  }

  /** One object with its ETag. */
  async get(url: string): Promise<CaldavObject> {
    const r = await this.request('GET', url, undefined, { accept: 'text/calendar' });
    if (r.status === 404) throw new CaldavError('That event is gone from the calendar.', 404);
    if (r.status !== 200) throw new CaldavError(`The server answered ${r.status} to GET.`, r.status);
    const etag = r.headers.get('etag') ?? undefined;
    return { url: r.url, data: r.text, ...(etag ? { etag } : {}) };
  }

  /**
   * Write an object. A new one goes to <calendar>/<uid>.ics with
   * If-None-Match, so it never replaces an event; a changed one names the
   * ETag it was read with, so a change made elsewhere in between is not lost.
   */
  async put(url: string, ics: string, cond: { create: true } | { etag?: string }): Promise<{ url: string; etag?: string }> {
    const headers: Record<string, string> = { 'content-type': 'text/calendar; charset=utf-8' };
    if ('create' in cond) headers['if-none-match'] = '*';
    else if (cond.etag) headers['if-match'] = cond.etag;
    const r = await this.request('PUT', url, ics, headers);
    if (r.status === 412) throw new CaldavError('The event changed on the server since it was read. Read the calendar again and propose the change again.', 412);
    if (r.status < 200 || r.status >= 300) throw new CaldavError(`The server refused the event (${r.status})${r.text ? `: ${r.text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}.`, r.status);
    const etag = r.headers.get('etag') ?? undefined;
    return { url: r.url, ...(etag ? { etag } : {}) };
  }

  async delete(url: string, etag?: string): Promise<void> {
    const r = await this.request('DELETE', url, undefined, etag ? { 'if-match': etag } : {});
    if (r.status === 404) return;
    if (r.status === 412) throw new CaldavError('The event changed on the server since it was read. Read the calendar again.', 412);
    if (r.status < 200 || r.status >= 300) throw new CaldavError(`The server refused to delete the event (${r.status}).`, r.status);
  }

  /**
   * Other people's busy time through the scheduling outbox (RFC 6638 5.2).
   * Servers answer only for people they know (users on the same server).
   * Returns busy periods per address and the addresses it could not ask.
   */
  async freeBusy(outbox: string, organizer: string, attendees: string[], start: number, end: number): Promise<{ busy: Map<string, Array<{ start: number; end: number }>>; unknown: string[] }> {
    const ics = freeBusyRequest(organizer.replace(/^mailto:/i, ''), attendees, start, end);
    const r = await this.request('POST', outbox, ics, { 'content-type': 'text/calendar; charset=utf-8', originator: `mailto:${organizer.replace(/^mailto:/i, '')}`, recipient: attendees.map((a) => `mailto:${a}`).join(', ') });
    const busy = new Map<string, Array<{ start: number; end: number }>>();
    const unknown = new Set(attendees.map((a) => a.toLowerCase()));
    if (r.status !== 200) return { busy, unknown: [...unknown] };
    let doc;
    try {
      doc = parseXml(r.text);
    } catch {
      return { busy, unknown: [...unknown] };
    }
    for (const resp of find(doc, CALDAV, 'response')) {
      const who = textOf(find(resp, DAV, 'href')[0] ?? kid(resp, CALDAV, 'recipient')).trim().replace(/^mailto:/i, '').toLowerCase();
      const status = textOf(kid(resp, CALDAV, 'request-status')).trim();
      const data = textOf(kid(resp, CALDAV, 'calendar-data'));
      if (!who || !status.startsWith('2.') || !data.trim()) continue;
      busy.set(who, freeBusyPeriods(data));
      unknown.delete(who);
    }
    return { busy, unknown: [...unknown] };
  }
}
