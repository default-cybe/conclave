/**
 * The maps service attached to each engine (engine/create.ts), and the
 * calendar port the leave-by hook reads, so routes, tools and a calendar
 * module reach them without widening the engine's interfaces.
 */
import type { MapsService } from './service';
import { NO_CALENDAR, type CalendarPort } from './leave-by';

const attached = new WeakMap<object, MapsService>();
const calendars = new WeakMap<object, CalendarPort>();

export function attachMaps(engine: object, service: MapsService): void {
  attached.set(engine, service);
}

/** The maps service of an engine, when the hub has one. */
export function mapsOf(engine: object): MapsService | undefined {
  return attached.get(engine);
}

/** A calendar module calls this once it can list events; the leave-by times follow from then on. */
export function setCalendarPort(engine: object, port: CalendarPort): void {
  calendars.set(engine, port);
}

/** The engine's calendar, or the stub with no events. */
export function calendarPortOf(engine: object): CalendarPort {
  return calendars.get(engine) ?? NO_CALENDAR;
}
