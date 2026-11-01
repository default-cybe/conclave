/**
 * Google Calendar through its REST API (v3), for a Google account signed in
 * with OAuth. Google ended password access to its CalDAV endpoint, so this is
 * the way in. Google expands repeating events itself (singleEvents=true) in
 * the zone asked for, answers free/busy for other people it may show, and
 * sends invitations when asked to (sendUpdates=all).
 */
import { addDays, atLocal, localDate, localHhmm, validZone } from '../assistant/time';
import { DRAFT_MAX, draftSpan, draftText, localToEpoch, type Occurrence } from './ical';
import type { EventDraft } from './types';

/** Minutes since 1970 of an instant's wall time in a zone, for steps between wall times. */
function wallOf(ts: number, zone: string): number {
  const [y, m, d] = localDate(ts, zone).split('-').map(Number);
  const [h, mi] = localHhmm(ts, zone).split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) / 60_000;
}

/** The instant a wall time (minutes since 1970, as wallOf gives) happens in a zone. */
function fromWall(minutes: number, zone: string): number {
  const iso = new Date(minutes * 60_000).toISOString();
  return atLocal(iso.slice(0, 10), iso.slice(11, 16), zone);
}

export interface GoogleCalendarEntry {
  id: string;
  name: string;
  color?: string;
  writable: boolean;
  primary: boolean;
}

interface GTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GTime;
  end?: GTime;
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string; self?: boolean }>;
  organizer?: { email?: string };
  recurringEventId?: string;
  transparency?: string;
  extendedProperties?: { private?: Record<string, string> };
  etag?: string;
}

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const STATUS: Record<string, string> = { accepted: 'accepted', declined: 'declined', tentative: 'tentative', needsAction: 'needs-action' };

export class GoogleCalendarClient {
  constructor(
    private token: () => Promise<string>,
    private base = 'https://www.googleapis.com/calendar/v3',
    private f: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...((init.headers as Record<string, string> | undefined) ?? {}) }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new GoogleCalendarError(`Could not reach Google Calendar: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        // keep the text
      }
      if (res.status === 401) throw new GoogleCalendarError('Google refused the sign-in. Sign in again in Settings.', 401);
      if (res.status === 403) throw new GoogleCalendarError(`Google says this sign-in may not do that: ${msg}. Calendar writing may be off for the account.`, 403);
      if (res.status === 412) throw new GoogleCalendarError('The event changed in Google Calendar since it was read. Read the calendar again.', 412);
      throw new GoogleCalendarError(`Google Calendar answered ${res.status}: ${msg}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async calendars(): Promise<GoogleCalendarEntry[]> {
    const r = await this.call<{ items?: Array<{ id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; accessRole?: string; primary?: boolean }> }>('/users/me/calendarList?minAccessRole=freeBusyReader');
    return (r.items ?? []).map((c) => ({
      id: c.id,
      name: c.summaryOverride ?? c.summary ?? c.id,
      ...(c.backgroundColor ? { color: c.backgroundColor } : {}),
      writable: c.accessRole === 'owner' || c.accessRole === 'writer',
      primary: !!c.primary,
    }));
  }

  /** Occurrences in [start, end): Google expands repeats in the owner's zone. */
  async events(calendarId: string, start: number, end: number, zone: string): Promise<Array<Occurrence & { ref: string; etag?: string }>> {
    const out: Array<Occurrence & { ref: string; etag?: string }> = [];
    let page: string | undefined;
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), timeZone: zone, maxResults: '250' });
      if (page) q.set('pageToken', page);
      const r = await this.call<{ items?: GEvent[]; nextPageToken?: string }>(`/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      for (const e of r.items ?? []) {
        const o = this.occurrence(e, zone);
        if (o) out.push(o);
      }
      page = r.nextPageToken;
      if (!page) break;
    }
    return out;
  }

  private occurrence(e: GEvent, zone: string): (Occurrence & { ref: string; etag?: string }) | undefined {
    if (e.status === 'cancelled') return undefined;
    const allDay = !!e.start?.date;
    const t = (g: GTime | undefined) => (g?.dateTime ? Date.parse(g.dateTime) : g?.date ? atLocal(g.date, '00:00', zone) : NaN);
    const start = t(e.start);
    let end = t(e.end);
    if (!Number.isFinite(start)) return undefined;
    if (!(end > start)) end = allDay ? start + 86_400_000 : start;
    const attendees = (e.attendees ?? []).filter((a) => a.email).map((a) => ({ email: a.email!, ...(a.displayName ? { name: a.displayName } : {}), ...(a.responseStatus ? { status: STATUS[a.responseStatus] ?? a.responseStatus } : {}) }));
    const project = e.extendedProperties?.private?.conclaveProject;
    const status = e.status === 'tentative' ? 'tentative' : e.status === 'confirmed' ? 'confirmed' : undefined;
    return {
      ref: e.id,
      uid: e.recurringEventId ?? e.id,
      title: e.summary ?? '(no title)',
      start,
      end,
      allDay,
      recurring: !!e.recurringEventId,
      // Google marks all-day events free unless set busy; a timed one is busy unless set free
      busy: e.transparency !== 'transparent' && !(allDay && e.transparency !== 'opaque'),
      ...(e.location ? { location: e.location } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(attendees.length ? { attendees } : {}),
      ...(e.organizer?.email ? { organizer: e.organizer.email } : {}),
      ...(status ? { status } : {}),
      ...(project ? { project } : {}),
      ...(e.etag ? { etag: e.etag } : {}),
    };
  }

  /** Busy time of calendars or people (by email). Unknown ones come back in errors. */
  async freeBusy(ids: string[], start: number, end: number): Promise<{ busy: Map<string, Array<{ start: number; end: number }>>; unknown: string[] }> {
    const r = await this.call<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>('/freeBusy', {
      method: 'POST',
      body: JSON.stringify({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), items: ids.map((id) => ({ id })) }),
    });
    const busy = new Map<string, Array<{ start: number; end: number }>>();
    const unknown: string[] = [];
    for (const id of ids) {
      const c = r.calendars?.[id];
      if (!c || c.errors?.length) {
        unknown.push(id);
        continue;
      }
      busy.set(id.toLowerCase(), (c.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter((b) => b.end > b.start));
    }
    return { busy, unknown };
  }

  /** A draft's start and end as Google writes them; an all-day end is the day after the last day. */
  private times(d: EventDraft, zone: string): { start: GTime; end: GTime } {
    if (d.allDay) {
      const s = d.start.slice(0, 10);
      const e = d.end.slice(0, 10);
      return { start: { date: s }, end: { date: e > s ? e : addDays(s, 1) } };
    }
    const when = (s: string) => ({ dateTime: new Date(localToEpoch(s, zone)).toISOString(), timeZone: zone });
    return { start: when(d.start), end: when(d.end) };
  }

  private body(d: EventDraft, zone: string): Record<string, unknown> {
    return {
      summary: d.title,
      ...(d.description ? { description: d.description } : {}),
      ...(d.location ? { location: d.location } : {}),
      ...this.times(d, zone),
      ...(d.attendees?.length ? { attendees: d.attendees.map((email) => ({ email })) } : {}),
      ...(d.project ? { extendedProperties: { private: { conclaveProject: d.project } } } : {}),
    };
  }

  async insert(calendarId: string, d: EventDraft, zone: string): Promise<string> {
    const r = await this.call<{ id: string }>(`/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${d.attendees?.length ? 'all' : 'none'}`, { method: 'POST', body: JSON.stringify(this.body(d, zone)) });
    return r.id;
  }

  /**
   * Change an event (an occurrence, or a series by its id) to match a draft:
   * read it first and send only what the draft changes, so notes longer than
   * a draft carries and attendees' answers stay. The draft was made from one
   * occurrence (`before`): a series moves by the change, in its own zone,
   * instead of moving its start to that occurrence.
   */
  async patch(calendarId: string, eventId: string, d: EventDraft, zone: string, opts: { series?: boolean; before?: { start: number; end: number; allDay: boolean } } = {}): Promise<void> {
    const path = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    const cur = await this.call<GEvent>(path);
    const body: Record<string, unknown> = {};
    const differs = (old: string | undefined, value: string | undefined, max: number) => (old ? draftText(old, max) : '') !== (value ?? '');
    if (differs(cur.summary, d.title, DRAFT_MAX.title)) body.summary = d.title;
    if (differs(cur.description, d.description, DRAFT_MAX.description)) body.description = d.description ?? '';
    if (differs(cur.location, d.location, DRAFT_MAX.location)) body.location = d.location ?? '';
    if (d.attendees) {
      const now = (cur.attendees ?? []).filter((a) => a.email);
      const want = new Set(d.attendees.map((a) => a.toLowerCase()));
      const have = new Set(now.map((a) => a.email!.toLowerCase()));
      if (want.size !== have.size || [...want].some((a) => !have.has(a))) body.attendees = [...now.filter((a) => want.has(a.email!.toLowerCase())), ...d.attendees.filter((a) => !have.has(a.toLowerCase())).map((email) => ({ email }))];
    }
    if (d.project && cur.extendedProperties?.private?.conclaveProject !== d.project) body.extendedProperties = { private: { conclaveProject: d.project } };
    const span = draftSpan(d, zone);
    const b = opts.before;
    const moved = !b || b.allDay !== !!d.allDay || b.start !== span.start || b.end !== span.end;
    if (moved) Object.assign(body, (opts.series && b && this.shifted(cur, d, zone, b.start)) || this.times(d, zone));
    const invite = (d.attendees?.length ?? 0) > 0 || (cur.attendees?.length ?? 0) > 0;
    await this.call(`${path}?sendUpdates=${invite ? 'all' : 'none'}`, { method: 'PATCH', body: JSON.stringify(body), ...(cur.etag ? { headers: { 'if-match': cur.etag } } : {}) });
  }

  /** A series' own start and end moved by the step from `anchor` to the draft's start, in the series' zone. Undefined when it cannot. */
  private shifted(cur: GEvent, d: EventDraft, zone: string, anchor: number): { start: GTime; end: GTime } | undefined {
    const span = draftSpan(d, zone);
    if (!!cur.start?.date !== !!d.allDay) return undefined;
    const step = wallOf(span.start, zone) - wallOf(anchor, zone);
    if (cur.start?.date) {
      const s = addDays(cur.start.date, Math.round(step / 1440));
      return { start: { date: s }, end: { date: addDays(s, Math.max(1, Math.round((span.end - span.start) / 86_400_000))) } };
    }
    const at = cur.start?.dateTime ? Date.parse(cur.start.dateTime) : NaN;
    if (!Number.isFinite(at)) return undefined;
    const z = cur.start?.timeZone && validZone(cur.start.timeZone) ? cur.start.timeZone : zone;
    const start = wallOf(at, z) + step;
    const end = start + (wallOf(span.end, zone) - wallOf(span.start, zone));
    return { start: { dateTime: new Date(fromWall(start, z)).toISOString(), timeZone: z }, end: { dateTime: new Date(fromWall(end, z)).toISOString(), timeZone: z } };
  }

  async remove(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof GoogleCalendarError && err.status === 410) return;
      throw err;
    }
  }
}
