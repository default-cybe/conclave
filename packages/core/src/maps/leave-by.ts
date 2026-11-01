/**
 * The leave-by hook for the day plan: today's calendar events with a place
 * get a travel time from home and a "Leave by 17:40". Calendar data comes
 * only through CalendarPort; until a calendar module attaches one
 * (setCalendarPort in registry.ts), the stub returns no events.
 */

/** A calendar event as the hook needs it. */
export interface CalendarEventLike {
  id: string;
  title: string;
  /** Epoch ms. */
  start: number;
  end?: number;
  /** Free text from the event: an address or a place name. */
  location?: string;
  allDay?: boolean;
}

/** What the leave-by hook reads from a calendar. */
export interface CalendarPort {
  /** Events that start in [start, end), epoch ms. */
  eventsBetween(start: number, end: number): Promise<CalendarEventLike[]>;
}

/** No calendar yet: no events. */
export const NO_CALENDAR: CalendarPort = {
  async eventsBetween() {
    return [];
  },
};

/** Events worth a travel time: timed, with a place, not an online meeting, not over yet. */
export function travelEvents(events: CalendarEventLike[], now: number, max = 6): CalendarEventLike[] {
  return events
    .filter((e) => !e.allDay && typeof e.location === 'string' && e.location.trim() && e.start > now && !isOnline(e.location))
    .sort((a, b) => a.start - b.start)
    .slice(0, max);
}

/** "Zoom", a meeting link or "Online" is not a place to travel to. */
export function isOnline(location: string): boolean {
  return /^(online|remote|virtual|zoom|teams|google meet|meet|skype|discord|phone|call)\b/i.test(location.trim()) || /https?:\/\/|meet\.google|zoom\.us|teams\.microsoft/i.test(location);
}
