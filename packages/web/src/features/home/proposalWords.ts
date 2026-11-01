/**
 * Words for calendar events and proposals (docs/DESIGN.md, Calendar and
 * mail), in the owner's zone: "18:00 to 19:00", "Thu 22 Oct, 07:00 to
 * 07:45", "Add to Personal". Plain functions, so they have tests.
 */
import type { ProposalDto, TodayEvent } from '@conclave/core/client';

function parts(ts: number, zone?: string): Record<string, string> {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric' });
  return Object.fromEntries(f.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
}

/** "18:00" in the zone. */
export function clock(ts: number, zone?: string): string {
  const p = parts(ts, zone);
  return `${p.hour}:${p.minute}`;
}

/** "Thu 22 Oct" in the zone. */
export function dayWords(ts: number, zone?: string): string {
  const p = parts(ts, zone);
  return `${p.weekday} ${p.day} ${p.month}`;
}

function sameDay(a: number, b: number, zone?: string): boolean {
  const x = parts(a, zone);
  const y = parts(b, zone);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** "18:00 to 19:00", "All day", or with the day when it ends on another one. */
export function eventRange(e: Pick<TodayEvent, 'start' | 'end' | 'allDay'>, zone?: string): string {
  if (e.allDay) return 'All day';
  if (sameDay(e.start, e.end - 1, zone)) return `${clock(e.start, zone)} to ${clock(e.end, zone)}`;
  return `${clock(e.start, zone)} to ${dayWords(e.end, zone)} ${clock(e.end, zone)}`;
}

/** "Thu 22 Oct, 18:00 to 19:00" or "Thu 22 Oct, all day". */
export function eventWhen(e: Pick<TodayEvent, 'start' | 'end' | 'allDay'>, zone?: string): string {
  if (e.allDay) {
    const days = Math.round((e.end - e.start) / 86_400_000);
    return days > 1 ? `${dayWords(e.start, zone)} to ${dayWords(e.end - 1, zone)}, all day` : `${dayWords(e.start, zone)}, all day`;
  }
  return `${dayWords(e.start, zone)}, ${eventRange(e, zone).replace('All day', 'all day')}`;
}

/** The card's question: "Add to Personal?", "Move in Work?", "Save this draft?". */
export function proposalQuestion(p: ProposalDto): string {
  if (p.kind === 'mail') return p.action === 'send' ? 'Send this message?' : 'Save this draft?';
  const cal = p.event?.calendar ?? 'the calendar';
  if (p.action === 'create') return `Add to ${cal}?`;
  if (p.action === 'update') return `Change in ${cal}?`;
  return `Delete from ${cal}?`;
}

/** The approve button's words. */
export function approveWords(p: ProposalDto): string {
  if (p.kind === 'mail') return p.action === 'send' ? 'Send' : 'Save draft';
  return p.action === 'delete' ? 'Delete' : p.action === 'update' ? 'Change' : 'Add';
}

/** What happens to invitations, one line, or nothing. */
export function inviteWords(p: ProposalDto): string | undefined {
  const e = p.event;
  if (!e?.attendees?.length) return undefined;
  const who = e.attendees.join(', ');
  return e.invites === 'server' ? `Invites ${who}. The calendar sends the invitations.` : `With ${who}. This calendar sends no invitations.`;
}

/** After a decision: "Added", "Failed: ...", "Declined". */
export function outcomeWords(p: ProposalDto): string {
  if (p.status === 'applied') return p.kind === 'mail' ? (p.action === 'send' ? 'Sent' : 'Draft saved') : p.action === 'delete' ? 'Deleted' : p.action === 'update' ? 'Changed' : 'Added';
  if (p.status === 'declined') return 'Declined';
  if (p.status === 'failed') return `Failed: ${p.error ?? 'unknown error'}`;
  return 'Waiting for you';
}

/** "Next: Gym at 18:00", or the first event still to come, for one quiet line. */
export function nextEventLine(events: TodayEvent[], now: number, zone?: string): string | undefined {
  const timed = events.filter((e) => !e.allDay);
  const next = timed.find((e) => e.end > now);
  if (next) return next.start <= now ? `Now: ${next.title}, until ${clock(next.end, zone)}` : `Next: ${next.title} at ${clock(next.start, zone)}`;
  if (events.some((e) => e.allDay)) return `Today: ${events.find((e) => e.allDay)!.title}`;
  return undefined;
}
