/** The assistant attached to each engine (create.ts), so routes and tools reach it without widening the engine's interfaces. */
import type { AssistantService } from './service';
import { isMember } from '../people/context';

const attached = new WeakMap<object, AssistantService>();
const factories = new WeakMap<object, (accountId: string) => AssistantService>();
const members = new WeakMap<object, Map<string, AssistantService>>();

export function attachAssistant(engine: object, service: AssistantService, forMember?: (accountId: string) => AssistantService): void {
  attached.set(engine, service);
  if (forMember) factories.set(engine, forMember);
}

/** The owner's assistant of an engine, when the hub has one. */
export function assistantOf(engine: object): AssistantService | undefined {
  return attached.get(engine);
}

/**
 * An account's assistant: its goals, preferences, day plans and Today
 * (docs/design/ACCOUNTS.md 2). The owner's is assistantOf; a member's is
 * made on first use.
 */
export function assistantFor(engine: object, accountId: string | undefined): AssistantService | undefined {
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

/** Forget a removed member's assistant. */
export function forgetAssistant(engine: object, accountId: string): void {
  members.get(engine)?.delete(accountId);
}
