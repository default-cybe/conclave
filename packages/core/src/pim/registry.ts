/**
 * The calendar and mail service attached to each engine (create.ts), like
 * the assistant: the owner's, and one per member made on first use
 * (docs/design/ACCOUNTS.md 2). Each has its own accounts, short ids,
 * proposals and secrets; the hub's own OAuth clients are shared.
 */
import type { PimService } from './service';
import { OWNER_ID, isMember } from '../people/context';

const attached = new WeakMap<object, PimService>();
const factories = new WeakMap<object, (accountId: string) => PimService>();
const members = new WeakMap<object, Map<string, PimService>>();

export function attachPim(engine: object, service: PimService, factory?: (accountId: string) => PimService): void {
  attached.set(engine, service);
  if (factory) factories.set(engine, factory);
}

/** The owner's calendar and mail service, when the hub has one. */
export function pimOf(engine: object): PimService | undefined {
  return attached.get(engine);
}

/** An account's calendar and mail service: the owner's is pimOf, a member's is made on first use. */
export function pimFor(engine: object, accountId: string | undefined): PimService | undefined {
  if (!isMember(accountId)) return attached.get(engine);
  const make = factories.get(engine);
  if (!make) return undefined;
  let map = members.get(engine);
  if (!map) members.set(engine, (map = new Map()));
  let svc = map.get(accountId!);
  if (!svc) {
    svc = make(accountId!);
    map.set(accountId!, svc);
  }
  return svc;
}

/** Every account's service made so far, the owner's first: the Google callback finds the sign-in it finishes. */
export function pimServices(engine: object): Array<{ accountId: string; service: PimService }> {
  const out: Array<{ accountId: string; service: PimService }> = [];
  const own = attached.get(engine);
  if (own) out.push({ accountId: OWNER_ID, service: own });
  for (const [accountId, service] of members.get(engine) ?? []) out.push({ accountId, service });
  return out;
}

/** A removed member: their service goes. */
export function forgetPim(engine: object, accountId: string): void {
  members.get(engine)?.delete(accountId);
}
