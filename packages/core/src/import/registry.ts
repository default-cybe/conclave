/** The import service attached to each engine (create.ts), so routes reach it without widening the engine's interfaces. */
import type { ImportOffers } from './offers';
import type { ImportService } from './service';

const attached = new WeakMap<object, ImportService>();
const offers = new WeakMap<object, ImportOffers>();

export function attachImport(engine: object, service: ImportService): void {
  attached.set(engine, service);
}

/** The import service of an engine, when the hub has one. */
export function importOf(engine: object): ImportService | undefined {
  return attached.get(engine);
}

export function attachImportOffers(engine: object, o: ImportOffers): void {
  offers.set(engine, o);
}

/** The offers to import a newly paired computer's chats (import/offers.ts), when the hub has them. */
export function importOffersOf(engine: object): ImportOffers | undefined {
  return offers.get(engine);
}
