/**
 * iCalendar in and out, on ical.js (pinned in package.json): repeating events
 * expanded into occurrences in a time range, overrides (RECURRENCE-ID) and
 * EXDATEs applied by the instant they name, times turned into instants
 * through the event's own zone (an IANA name through Intl, else its
 * VTIMEZONE), and new or changed events written back. Parsing RRULE and
 * VTIMEZONE by hand breaks on real calendars; this is what ical.js is for.
 */
import ICAL from 'ical.js';
import { createHash, randomUUID } from 'node:crypto';
import { atLocal, localDate, localHhmm, validZone } from '../assistant/time';
import type { EventAttendee, EventDraft } from './types';

/** An occurrence as it comes out of a calendar object, before the service adds ids and names. */
export interface Occurrence {
  uid: string;
  /** The original start of this occurrence in a repeating series, as the server wrote it, so a change can name it. */
  recurrenceId?: RecurrenceRef;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees?: EventAttendee[];
  organizer?: string;
  recurring: boolean;
  busy: boolean;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  project?: string;
}

/** How a RECURRENCE-ID or EXDATE names an occurrence: the value and the zone parameter of the series start. */
export interface RecurrenceRef {
  value: string;
  tzid?: string;
  date?: boolean;
}

/** Most occurrences one series may produce in one range, so a rule that never ends cannot run away. */
const MAX_OCCURRENCES = 2_000;
/** Most iterator steps per series, for a series that started long ago. */
const MAX_STEPS = 50_000;

type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalComponent = InstanceType<typeof ICAL.Component>;

/** An IANA zone from a TZID: the name itself, or one at its end ("/mozilla.org/20050126_1/Europe/Berlin"). */
export function ianaZone(tzid: string | undefined | null): string | undefined {
  if (!tzid) return undefined;
  const t = tzid.trim().replace(/^"|"$/g, '');
  if (t.toUpperCase() === 'UTC' || t.toUpperCase() === 'GMT' || t === 'Etc/UTC' || t === 'Z') return 'UTC';
  if (validZone(t) && t.includes('/')) return t;
  const m = /((?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(t);
  if (m && validZone(m[1])) return m[1];
  return WINDOWS_ZONES[t];
}

/** The Windows names Exchange and Outlook write most often. */
const WINDOWS_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'India Standard Time': 'Asia/Kolkata',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  UTC: 'UTC',
};

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** A zone's offset from UTC at an instant, in ms. */
function offsetAt(ts: number, zone: string): number {
  const [y, mo, d] = localDate(ts, zone).split('-').map(Number);
  const [h, mi] = localHhmm(ts, zone).split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - Math.floor(ts / 60_000) * 60_000;
}

/**
 * The instant a wall time happens in a zone, read as RFC 5545 3.3.5 says: a
 * time the clocks pass twice is the first one, and a time they skip takes
 * the offset from before the change (02:30 on New York's spring-forward day
 * is 03:30 EDT). A server that writes a RECURRENCE-ID in UTC counts the
 * same way, so the override still finds its occurrence on those days.
 */
function wallToEpoch(t: IcalTime, zone: string): number {
  const date = `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
  if (t.isDate) return atLocal(date, '00:00', zone);
  const hhmm = `${pad(t.hour)}:${pad(t.minute)}`;
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);
  // the offsets a day either side differ only when the clocks change that day
  const before = wall - offsetAt(wall - 86_400_000, zone);
  const after = wall - offsetAt(wall + 86_400_000, zone);
  if (before === after) return before + t.second * 1000;
  const real = [before, after].filter((ts) => localDate(ts, zone) === date && localHhmm(ts, zone) === hhmm);
  return (real.length ? Math.min(...real) : before) + t.second * 1000;
}

/** An ICAL time as an instant: UTC as is, an IANA zone through Intl, a VTIMEZONE through ical.js, floating in the owner's zone. */
export function epochOf(t: IcalTime, ownerZone: string, tzid?: string): number {
  const zone = t.zone as { tzid?: string } | undefined;
  if (zone === ICAL.Timezone.utcTimezone || zone?.tzid === 'UTC') return t.toUnixTime() * 1000;
  const named = tzid ?? (t as unknown as { timezone?: string }).timezone ?? (zone && zone !== ICAL.Timezone.localTimezone ? zone.tzid : undefined);
  const iana = ianaZone(named);
  if (iana) return wallToEpoch(t, iana);
  if (zone && zone !== ICAL.Timezone.localTimezone && zone.tzid) return t.toUnixTime() * 1000;
  return wallToEpoch(t, ownerZone);
}

function text(c: IcalComponent, name: string): string | undefined {
  const v = c.getFirstPropertyValue(name);
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

function tzidOf(c: IcalComponent, name: string): string | undefined {
  const p = c.getFirstProperty(name);
  const v = p?.getParameter('tzid');
  return typeof v === 'string' ? v : undefined;
}

function attendeesOf(c: IcalComponent): EventAttendee[] | undefined {
  const out: EventAttendee[] = [];
  for (const p of c.getAllProperties('attendee')) {
    const email = String(p.getFirstValue() ?? '').replace(/^mailto:/i, '').trim();
    if (!email) continue;
    const cn = p.getParameter('cn');
    const st = p.getParameter('partstat');
    out.push({ email, ...(typeof cn === 'string' && cn ? { name: cn } : {}), ...(typeof st === 'string' ? { status: st.toLowerCase() } : {}) });
  }
  return out.length ? out : undefined;
}

function statusOf(c: IcalComponent): Occurrence['status'] {
  const s = text(c, 'status')?.toLowerCase();
  return s === 'cancelled' || s === 'tentative' || s === 'confirmed' ? s : undefined;
}

function projectOf(c: IcalComponent): string | undefined {
  const x = text(c, 'x-conclave-project');
  if (x) return x;
  return undefined;
}

/** Busy unless marked free or cancelled. All-day events block time only when marked busy outright. */
function busyOf(c: IcalComponent, allDay: boolean): boolean {
  if (statusOf(c) === 'cancelled') return false;
  const transp = text(c, 'transp')?.toUpperCase();
  if (transp === 'TRANSPARENT') return false;
  if (allDay) return transp === 'OPAQUE';
  return true;
}

function details(c: IcalComponent): Pick<Occurrence, 'title' | 'location' | 'description' | 'attendees' | 'organizer' | 'status' | 'project'> {
  const organizer = text(c, 'organizer')?.replace(/^mailto:/i, '');
  const location = text(c, 'location');
  const description = text(c, 'description');
  const attendees = attendeesOf(c);
  const status = statusOf(c);
  const project = projectOf(c);
  return {
    title: text(c, 'summary') ?? '(no title)',
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    ...(attendees ? { attendees } : {}),
    ...(organizer ? { organizer } : {}),
    ...(status ? { status } : {}),
    ...(project ? { project } : {}),
  };
}

function refOf(t: IcalTime, tzid: string | undefined): RecurrenceRef {
  const utc = (t.zone as { tzid?: string } | undefined)?.tzid === 'UTC';
  const value = t.toICALString();
  return { value, ...(tzid && !utc && !t.isDate ? { tzid } : {}), ...(t.isDate ? { date: true } : {}) };
}

/** A RECURRENCE-ID or EXDATE line for a ref, in the ref's own zone. */
function refLine(name: 'RECURRENCE-ID' | 'EXDATE', r: RecurrenceRef): string {
  return `${name}${r.date ? ';VALUE=DATE' : r.tzid ? `;TZID=${r.tzid}` : ''}:${r.value.replace(/[-:]/g, '')}`;
}

/**
 * The instant a RECURRENCE-ID or EXDATE names, which is how it finds its
 * occurrence: ical.js relates them by local time text, which misses one
 * written in another zone than the series (UTC, or London for a New York
 * series) and can take one that names another moment. One without a zone
 * of its own is in the series' zone, as clients that leave it out mean.
 */
function namedEpoch(t: IcalTime, tzid: string | undefined, masterTz: string | undefined, ownerZone: string): number {
  return epochOf(t, ownerZone, t.isDate ? undefined : (tzid ?? masterTz));
}

/**
 * The overrides in an object for the occurrence a ref names, by instant.
 * Dates and floating times are read in UTC on both sides, which matches
 * them the same as any zone would.
 */
function overridesFor(root: IcalComponent, vevents: IcalComponent[], r: RecurrenceRef, masterTz: string | undefined): IcalComponent[] {
  const p = ICAL.Property.fromString(refLine('RECURRENCE-ID', r));
  // read like the object's own times: through its VTIMEZONE when the name is not an IANA one
  p.parent = root;
  const at = namedEpoch(p.getFirstValue() as IcalTime, r.tzid, masterTz, 'UTC');
  return vevents.filter((v) => {
    const rid = v.getFirstPropertyValue('recurrence-id') as IcalTime | null;
    return !!rid && namedEpoch(rid, tzidOf(v, 'recurrence-id'), masterTz, 'UTC') === at;
  });
}

/**
 * Every occurrence of the events in a calendar object that overlaps
 * [start, end), in time order. One object holds one series: the master and
 * its overrides share a UID.
 */
export function expand(ics: string, range: { start: number; end: number }, ownerZone: string): Occurrence[] {
  let root: IcalComponent;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch {
    return [];
  }
  const vevents = root.name === 'vevent' ? [root] : root.getAllSubcomponents('vevent');
  const byUid = new Map<string, { master?: IcalComponent; overrides: IcalComponent[] }>();
  for (const v of vevents) {
    const uid = text(v, 'uid') ?? `nouid-${createHash('sha1').update(v.toString()).digest('hex').slice(0, 12)}`;
    const g = byUid.get(uid) ?? { overrides: [] };
    if (v.getFirstProperty('recurrence-id')) g.overrides.push(v);
    else g.master = v;
    byUid.set(uid, g);
  }
  const out: Occurrence[] = [];
  for (const [uid, g] of byUid) {
    // one series ical.js cannot walk (a broken override, a value it does not take) must not cost the calendar's other events
    try {
      out.push(...series(uid, g, range, ownerZone));
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * RDATEs the way ical.js can walk them. A period (RDATE;VALUE=PERIOD, valid
 * and rare) becomes its start time: ical.js expands only date and date-time
 * values, and each such occurrence takes the series' length. And an event
 * with RDATEs but no RRULE gets its own start as one more RDATE: RFC 5545
 * counts DTSTART in the set, ical.js only walks the rule and the dates.
 */
function rdatesFor(master: IcalComponent): void {
  const rdates = master.getAllProperties('rdate');
  if (!rdates.length) return;
  for (const p of rdates) {
    if (p.type !== 'period') continue;
    const starts = (p.getValues() as Array<InstanceType<typeof ICAL.Period>>).map((v) => v.start).filter(Boolean);
    const next = new ICAL.Property('rdate', master);
    const tz = p.getParameter('tzid');
    if (typeof tz === 'string') next.setParameter('tzid', tz);
    next.setValues(starts);
    master.removeProperty(p);
    if (starts.length) master.addProperty(next);
  }
  const start = master.getFirstProperty('dtstart');
  const t = start?.getFirstValue() as IcalTime | null | undefined;
  if (!start || !t || master.getFirstProperty('rrule')) return;
  const listed = master.getAllProperties('rdate').some((p) => p.getValues().some((v) => v instanceof ICAL.Time && v.compare(t) === 0));
  if (listed) return;
  const own = new ICAL.Property('rdate', master);
  const tz = start.getParameter('tzid');
  if (typeof tz === 'string') own.setParameter('tzid', tz);
  own.setValue(t.clone());
  master.addProperty(own);
}

function series(uid: string, g: { master?: IcalComponent; overrides: IcalComponent[] }, range: { start: number; end: number }, ownerZone: string): Occurrence[] {
  const out: Occurrence[] = [];
  if (!g.master) {
    // only overrides came back (a server that filtered the master out): each stands alone
    for (const o of g.overrides) out.push(...single(uid, o, range, ownerZone, true));
    return out;
  }
  rdatesFor(g.master);
  // overrides go by instant (namedEpoch); left alone ical.js takes every override in the object, so it gets
  // only those that move the later occurrences too (RANGE=THISANDFUTURE), which it shifts
  const event = new ICAL.Event(g.master, { exceptions: g.overrides.filter((o) => new ICAL.Event(o).modifiesFuture()) });
  if (!event.isRecurring()) {
    out.push(...single(uid, g.master, range, ownerZone, false));
    return out;
  }
  const masterTz = tzidOf(g.master, 'dtstart');
  const overrides = new Map<number, IcalComponent>();
  for (const o of g.overrides) overrides.set(namedEpoch(o.getFirstPropertyValue('recurrence-id') as IcalTime, tzidOf(o, 'recurrence-id'), masterTz, ownerZone), o);
  const exdates = new Set<number>();
  for (const p of g.master.getAllProperties('exdate')) {
    const tz = p.getParameter('tzid');
    for (const v of p.getValues()) if (v instanceof ICAL.Time) exdates.add(namedEpoch(v, typeof tz === 'string' ? tz : undefined, masterTz, ownerZone));
  }
  const it = event.iterator();
  let steps = 0;
  let found = 0;
  for (let next = it.next(); next; next = it.next()) {
    if (++steps > MAX_STEPS || found >= MAX_OCCURRENCES) break;
    const original = epochOf(next, ownerZone, next.isDate ? undefined : masterTz);
    const own = overrides.get(original);
    const ev = own ? new ICAL.Event(own) : undefined;
    const d = ev ? { item: ev, startDate: ev.startDate, endDate: ev.endDate } : event.getOccurrenceDetails(next);
    const item = d.item.component;
    const tz = tzidOf(item, 'dtstart') ?? masterTz;
    const start = epochOf(d.startDate, ownerZone, d.startDate.isDate ? undefined : tz);
    // the original start says when the series is past the range; an override may move later
    if (original >= range.end && start >= range.end) break;
    if (exdates.has(original)) continue;
    const allDay = d.startDate.isDate;
    let end = epochOf(d.endDate, ownerZone, d.endDate.isDate ? undefined : (tzidOf(item, 'dtend') ?? tz));
    if (!(end > start)) end = allDay ? start + 86_400_000 : start;
    if (end <= range.start || start >= range.end) continue;
    if (statusOf(item) === 'cancelled') continue;
    found++;
    out.push({ uid, recurrenceId: refOf(next, masterTz), start, end, allDay, recurring: true, busy: busyOf(item, allDay), ...details(item) });
  }
  return out;
}

function single(uid: string, v: IcalComponent, range: { start: number; end: number }, ownerZone: string, isOverride: boolean): Occurrence[] {
  const dtstart = v.getFirstPropertyValue('dtstart') as IcalTime | null;
  if (!dtstart) return [];
  const allDay = dtstart.isDate;
  const start = epochOf(dtstart, ownerZone, allDay ? undefined : tzidOf(v, 'dtstart'));
  const dtend = v.getFirstPropertyValue('dtend') as IcalTime | null;
  const dur = v.getFirstPropertyValue('duration') as InstanceType<typeof ICAL.Duration> | null;
  let end: number;
  if (dtend) end = epochOf(dtend, ownerZone, dtend.isDate ? undefined : (tzidOf(v, 'dtend') ?? tzidOf(v, 'dtstart')));
  else if (dur) end = start + dur.toSeconds() * 1000;
  else end = allDay ? start + 86_400_000 : start;
  if (!(end > start)) end = allDay ? start + 86_400_000 : start;
  if (end <= range.start || start >= range.end) return [];
  if (statusOf(v) === 'cancelled') return [];
  const rid = isOverride ? (v.getFirstPropertyValue('recurrence-id') as IcalTime | null) : null;
  return [{ uid, ...(rid ? { recurrenceId: refOf(rid, tzidOf(v, 'recurrence-id')) } : {}), start, end, allDay, recurring: isOverride, busy: busyOf(v, allDay), ...details(v) }];
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/** "2026-10-21T18:00" in the owner's zone to an instant; a bare date is local midnight. */
export function localToEpoch(s: string, zone: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return NaN;
  // a day that does not exist (2026-02-29, month 13, 24:30) is not quietly the next one
  const [y, mo, d] = m[1].split('-').map(Number);
  if (new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) !== m[1]) return NaN;
  if (m[2] && (Number(m[2]) > 23 || Number(m[3]) > 59)) return NaN;
  return atLocal(m[1], m[2] ? `${m[2]}:${m[3]}` : '00:00', zone);
}

function utcStamp(ts: number): string {
  return new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function dateStamp(date: string): string {
  return date.replace(/-/g, '');
}

/** Text value escaping for iCalendar (RFC 5545 3.3.11). */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold a content line at 75 octets. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      len = 0;
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** Strip anything that could end a property line early. */
function clean(s: string): string {
  // CR and LF too: a raw line break would start a new property (folding is applied afterwards)
  return s.replace(/[\u0000-\u001f]/g, '').trim();
}

export interface WriteOptions {
  uid?: string;
  ownerZone: string;
  /** The account's own address, as ORGANIZER when there are attendees. */
  organizer?: string;
  now?: number;
}

/** The VEVENT lines of a draft (times in UTC, all-day as dates). */
function veventLines(d: EventDraft, uid: string, o: WriteOptions, extra: string[] = []): string[] {
  const now = o.now ?? Date.now();
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcStamp(now)}`];
  if (d.allDay) {
    const s = d.start.slice(0, 10);
    const e = d.end.slice(0, 10);
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(s)}`, `DTEND;VALUE=DATE:${dateStamp(e > s ? e : nextDay(s))}`);
  } else {
    lines.push(`DTSTART:${utcStamp(localToEpoch(d.start, o.ownerZone))}`, `DTEND:${utcStamp(localToEpoch(d.end, o.ownerZone))}`);
  }
  lines.push(...extra);
  lines.push(`SUMMARY:${esc(clean(d.title))}`);
  if (d.location) lines.push(`LOCATION:${esc(clean(d.location))}`);
  if (d.description) lines.push(`DESCRIPTION:${esc(d.description.trim())}`);
  if (d.project) lines.push(`CATEGORIES:${esc(clean(d.project))}`, `X-CONCLAVE-PROJECT:${esc(clean(d.project))}`);
  const attendees = (d.attendees ?? []).map((a) => a.trim()).filter(Boolean);
  if (attendees.length) {
    if (o.organizer) lines.push(`ORGANIZER:mailto:${clean(o.organizer)}`);
    for (const a of attendees) lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${clean(a)}`);
  }
  lines.push('TRANSP:OPAQUE', 'END:VEVENT');
  return lines;
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** A new calendar object for a draft. */
export function buildEvent(d: EventDraft, o: WriteOptions): { uid: string; ics: string } {
  const uid = o.uid ?? `${randomUUID()}@conclave`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Conclave//Calendar//EN', 'CALSCALE:GREGORIAN', ...veventLines(d, uid, o), 'END:VCALENDAR'];
  return { uid, ics: lines.map(fold).join('\r\n') + '\r\n' };
}

function serialize(root: IcalComponent): string {
  return root.toString().replace(/\r?\n/g, '\r\n') + '\r\n';
}

function parseRoot(ics: string): IcalComponent {
  return new ICAL.Component(ICAL.parse(ics));
}

/** One VEVENT from lines, parsed so it can join an existing object. */
function veventComponent(lines: string[]): IcalComponent {
  const cal = parseRoot(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Conclave//Calendar//EN', ...lines, 'END:VCALENDAR'].map(fold).join('\r\n'));
  return cal.getFirstSubcomponent('vevent')!;
}

function bumpSequence(v: IcalComponent): void {
  const seq = Number(v.getFirstPropertyValue('sequence') ?? 0);
  v.updatePropertyWithValue('sequence', Number.isFinite(seq) ? seq + 1 : 1);
}

/** The longest title, place and notes a proposal carries (the service cuts drafts to these). */
export const DRAFT_MAX = { title: 200, location: 300, description: 4000 } as const;

/** Text as a draft carries it: no control characters, trimmed, cut to max. */
export function draftText(v: string, max: number): string {
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

/** Minutes since 1970 of a local wall time "YYYY-MM-DD[THH:MM]", zone left out: for differences between wall times. */
function wallMinutes(local: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(local.trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) / 60_000 : NaN;
}

/** An instant as the owner's local wall time "YYYY-MM-DDTHH:MM". */
function localOf(ts: number, zone: string): string {
  return `${localDate(ts, zone)}T${localHhmm(ts, zone)}`;
}

/** A draft's start and end as instants, an all-day end at least a day after its start (as the proposal card shows it). */
export function draftSpan(d: Pick<EventDraft, 'start' | 'end' | 'allDay'>, zone: string): { start: number; end: number } {
  const start = localToEpoch(d.start, zone);
  let end = localToEpoch(d.end, zone);
  if (d.allDay && end <= start) end = start + 86_400_000;
  return { start, end };
}

/** Replace a component's start and end with the draft's: UTC times, or dates for an all-day event. */
function setTimes(v: IcalComponent, d: EventDraft, o: WriteOptions): void {
  const lines = ['BEGIN:VEVENT', 'UID:x'];
  if (d.allDay) {
    const s = d.start.slice(0, 10);
    const e = d.end.slice(0, 10);
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(s)}`, `DTEND;VALUE=DATE:${dateStamp(e > s ? e : nextDay(s))}`);
  } else {
    lines.push(`DTSTART:${utcStamp(localToEpoch(d.start, o.ownerZone))}`, `DTEND:${utcStamp(localToEpoch(d.end, o.ownerZone))}`);
  }
  const parsed = veventComponent([...lines, 'END:VEVENT']);
  for (const n of ['dtstart', 'dtend', 'duration']) v.removeAllProperties(n);
  v.addProperty(parsed.getFirstProperty('dtstart')!);
  v.addProperty(parsed.getFirstProperty('dtend')!);
}

/**
 * Move a series by what the draft changed, in the series' own zone: the
 * draft's start is one occurrence (the one at `anchor`), so the series start
 * moves by the same wall-clock step and keeps its date, rule and count.
 * False when it cannot (all-day and timed mixed): the caller writes the
 * draft's times as they are.
 */
function shiftSeries(v: IcalComponent, d: EventDraft, o: WriteOptions, anchor: number | undefined): boolean {
  const p = v.getFirstProperty('dtstart');
  const t = p?.getFirstValue() as IcalTime | null | undefined;
  if (!p || !t || t.isDate !== !!d.allDay) return false;
  const from = anchor ?? epochOf(t, o.ownerZone, t.isDate ? undefined : tzidOf(v, 'dtstart'));
  const step = wallMinutes(d.allDay ? d.start.slice(0, 10) : d.start) - wallMinutes(d.allDay ? localOf(from, o.ownerZone).slice(0, 10) : localOf(from, o.ownerZone));
  let length = wallMinutes(d.allDay ? d.end.slice(0, 10) : d.end) - wallMinutes(d.allDay ? d.start.slice(0, 10) : d.start);
  if (!Number.isFinite(step) || !Number.isFinite(length)) return false;
  if (d.allDay && length <= 0) length = 1440;
  const start = t.clone();
  if (t.isDate) start.adjust(Math.round(step / 1440), 0, 0, 0);
  else start.adjust(0, 0, step, 0);
  p.setValue(start);
  const end = start.clone();
  if (t.isDate) end.adjust(Math.round(length / 1440), 0, 0, 0);
  else end.adjust(0, 0, length, 0);
  const hadDuration = !!v.getFirstProperty('duration');
  v.removeAllProperties('dtend');
  v.removeAllProperties('duration');
  if (hadDuration) {
    v.addPropertyWithValue('duration', ICAL.Duration.fromSeconds(length * 60));
  } else {
    const e = new ICAL.Property('dtend', v);
    e.setValue(end);
    const tz = p.getParameter('tzid');
    if (typeof tz === 'string' && !t.isDate) e.setParameter('tzid', tz);
    v.addProperty(e);
  }
  return true;
}

/**
 * Write a draft's text, place, project and people into a component that
 * already exists, keeping everything the draft does not cover: alarms, the
 * free or busy mark, the privacy class, other apps' lines, attendees'
 * answers, and text longer than a draft carries when the draft did not
 * change it.
 */
function applyDraft(v: IcalComponent, d: EventDraft, o: WriteOptions, timesMoved: boolean): void {
  const setText = (name: string, value: string | undefined, max: number) => {
    const cur = text(v, name);
    if (!value) {
      v.removeAllProperties(name);
      return;
    }
    // unchanged: the draft holds the old text as a draft carries it, which may be cut short
    if (cur !== undefined && draftText(cur, max) === value) return;
    v.updatePropertyWithValue(name, value);
  };
  if (!(text(v, 'summary') === undefined && d.title === '(no title)')) setText('summary', d.title, DRAFT_MAX.title);
  setText('location', d.location, DRAFT_MAX.location);
  setText('description', d.description, DRAFT_MAX.description);
  if (d.project && text(v, 'x-conclave-project') !== d.project) {
    v.updatePropertyWithValue('x-conclave-project', d.project);
    const has = v.getAllProperties('categories').some((p) => p.getValues().some((x) => String(x) === d.project));
    if (!has) v.addPropertyWithValue('categories', d.project);
  }
  if (d.attendees) {
    const want = new Set(d.attendees.map((a) => a.trim().toLowerCase()).filter(Boolean));
    const emailOf = (p: InstanceType<typeof ICAL.Property>) => String(p.getFirstValue() ?? '').replace(/^mailto:/i, '').trim().toLowerCase();
    for (const p of v.getAllProperties('attendee')) if (!want.has(emailOf(p))) v.removeProperty(p);
    const have = new Set(v.getAllProperties('attendee').map(emailOf));
    const organizer = (text(v, 'organizer') ?? o.organizer ?? '').replace(/^mailto:/i, '').toLowerCase();
    // a new time asks everyone again
    if (timesMoved) for (const p of v.getAllProperties('attendee')) if (emailOf(p) !== organizer) p.setParameter('partstat', 'NEEDS-ACTION');
    const added = d.attendees.map((a) => a.trim()).filter((a) => a && !have.has(a.toLowerCase()));
    if (added.length) {
      const lines = added.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${clean(a)}`);
      for (const p of veventComponent(['BEGIN:VEVENT', 'UID:x', ...lines, 'END:VEVENT']).getAllProperties('attendee')) v.addProperty(p);
    }
    if (want.size && o.organizer && !v.getFirstProperty('organizer')) v.addPropertyWithValue('organizer', `mailto:${clean(o.organizer)}`);
  }
  v.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(o.now ?? Date.now()), true));
}

export interface UpdateOptions {
  /**
   * The occurrence the draft was made from, as it was read. A change to a
   * whole series moves it by the difference instead of moving the series'
   * start to that occurrence, and times left alone stay as they are. Left
   * out, the draft's times are taken as the series' (or event's) own.
   */
  before?: { start: number; end: number; allDay: boolean };
}

/**
 * Change an existing object, keeping what the draft does not cover.
 * Without a recurrence id the whole event (or series) gets the new fields;
 * a series moves by the change in its own zone and keeps its rule. With
 * one, that occurrence gets an override. Returns the new text.
 */
export function updateEvent(ics: string, uid: string, d: EventDraft, o: WriteOptions, recurrenceId?: RecurrenceRef, u: UpdateOptions = {}): string {
  const root = parseRoot(ics);
  const vevents = root.getAllSubcomponents('vevent').filter((v) => text(v, 'uid') === uid);
  const master = vevents.find((v) => !v.getFirstProperty('recurrence-id'));
  const span = draftSpan(d, o.ownerZone);
  const moved = !u.before || u.before.allDay !== !!d.allDay || u.before.start !== span.start || u.before.end !== span.end;
  if (recurrenceId) {
    // the override already there, found by instant: its RECURRENCE-ID may be in another zone than the ref
    const found = overridesFor(root, vevents, recurrenceId, master ? tzidOf(master, 'dtstart') : undefined);
    // the newest when an older write left two
    const existing = found.at(-1);
    const base = existing ?? master;
    if (!base) throw new Error('That event is not in the calendar object.');
    const seq = Number(base.getFirstPropertyValue('sequence') ?? 0);
    // an override is the occurrence as it stands (alarms and all), without a rule of its own
    // a copy: toJSON() hands out the component's own arrays
    const next = new ICAL.Component(structuredClone(base.toJSON()));
    for (const n of ['rrule', 'rdate', 'exdate', 'exrule']) next.removeAllProperties(n);
    if (!existing) {
      next.removeAllProperties('recurrence-id');
      next.addProperty(veventComponent(['BEGIN:VEVENT', 'UID:x', refLine('RECURRENCE-ID', recurrenceId), 'END:VEVENT']).getFirstProperty('recurrence-id')!);
    }
    applyDraft(next, d, o, moved);
    // the override's own start and end: the draft's (a master copied for a new override has the series' first ones)
    setTimes(next, d, o);
    next.updatePropertyWithValue('sequence', (Number.isFinite(seq) ? seq : 0) + 1);
    for (const v of found) root.removeSubcomponent(v);
    root.addSubcomponent(next);
    return serialize(root);
  }
  if (!master) throw new Error('That event is not in the calendar object.');
  const series = !!(master.getFirstProperty('rrule') || master.getFirstProperty('rdate'));
  applyDraft(master, d, o, moved);
  // a series moves by the change in its own zone; one event takes the draft's times
  if (moved && (!series || !shiftSeries(master, d, o, u.before?.start))) setTimes(master, d, o);
  bumpSequence(master);
  return serialize(root);
}

/** Leave one occurrence of a series out (EXDATE), for deleting just that one. */
export function excludeOccurrence(ics: string, uid: string, recurrenceId: RecurrenceRef): string {
  const root = parseRoot(ics);
  const vevents = root.getAllSubcomponents('vevent').filter((v) => text(v, 'uid') === uid);
  const master = vevents.find((v) => !v.getFirstProperty('recurrence-id'));
  if (!master) throw new Error('That series is not in the calendar object.');
  // its override goes too, found by instant like in expand
  for (const v of overridesFor(root, vevents, recurrenceId, tzidOf(master, 'dtstart'))) root.removeSubcomponent(v);
  const ex = veventComponent(['BEGIN:VEVENT', `UID:${uid}`, refLine('EXDATE', recurrenceId), 'END:VEVENT']).getFirstProperty('exdate')!;
  master.addProperty(ex);
  bumpSequence(master);
  return serialize(root);
}

/** A VFREEBUSY request for the scheduling outbox (RFC 6638 free/busy lookup). */
export function freeBusyRequest(organizer: string, attendees: string[], start: number, end: number, now = Date.now()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Conclave//Calendar//EN',
    'METHOD:REQUEST',
    'BEGIN:VFREEBUSY',
    `UID:${randomUUID()}@conclave`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `ORGANIZER:mailto:${clean(organizer)}`,
    ...attendees.map((a) => `ATTENDEE:mailto:${clean(a)}`),
    'END:VFREEBUSY',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Busy periods in a VFREEBUSY reply. */
export function freeBusyPeriods(ics: string): Array<{ start: number; end: number }> {
  let root: IcalComponent;
  try {
    root = parseRoot(ics);
  } catch {
    return [];
  }
  const out: Array<{ start: number; end: number }> = [];
  for (const fb of root.name === 'vfreebusy' ? [root] : root.getAllSubcomponents('vfreebusy')) {
    for (const p of fb.getAllProperties('freebusy')) {
      const type = String(p.getParameter('fbtype') ?? 'BUSY').toUpperCase();
      if (type === 'FREE') continue;
      for (const v of p.getValues() as Array<InstanceType<typeof ICAL.Period>>) {
        const s = v.start.toUnixTime() * 1000;
        const e = v.end ? v.end.toUnixTime() * 1000 : s + (v.duration?.toSeconds() ?? 0) * 1000;
        if (e > s) out.push({ start: s, end: e });
      }
    }
  }
  return out;
}

/** The UIDs in an object. */
export function uidsOf(ics: string): string[] {
  try {
    const root = parseRoot(ics);
    return [...new Set(root.getAllSubcomponents('vevent').map((v) => text(v, 'uid')).filter((u): u is string => !!u))];
  } catch {
    return [];
  }
}
