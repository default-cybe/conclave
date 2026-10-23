/**
 * Which alert service belongs to which engine. Kept apart from service.ts so
 * routes and views can look it up without importing the service.
 */
import type { LiveAlerts } from '../client/alerts';
import type { AlertService } from './service';

const attached = new WeakMap<object, AlertService>();

export function setAlerts(engine: object, svc: AlertService): void {
  attached.set(engine, svc);
}

/** The alert service of an engine, when the hub has one. */
export function alertsOf(engine: object): AlertService | undefined {
  return attached.get(engine);
}

/**
 * The live state behind the alerts, for views that draw sessions (the Map
 * snapshot): which sessions are stuck since when, and which pairs of live
 * sessions wrote the same file in the last 10 minutes. Read only and cheap.
 */
export function liveAlerts(engine: object, now = Date.now()): LiveAlerts {
  return alertsOf(engine)?.live(now) ?? { stuck: {}, conflicts: [] };
}
