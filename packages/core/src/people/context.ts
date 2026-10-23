/**
 * The account a piece of work runs for (docs/design/ACCOUNTS.md 5). The
 * server runs each request inside runAs(account), the runner each turn, the
 * scheduler each routine and job. The machine guard (people/guard.ts) reads
 * it, so code that forgot to check whose device it is still cannot reach
 * the wrong one. Outside any context (boot, tests) nothing is refused.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The owner's account id. Every row from before accounts belongs to it. */
export const OWNER_ID = 'owner';

const store = new AsyncLocalStorage<string>();

/** Run fn for an account. Everything it awaits, and every timer it sets, runs for that account too. */
export function runAs<T>(accountId: string, fn: () => T): T {
  return store.run(accountId || OWNER_ID, fn);
}

/** The account the current work runs for, or undefined outside any (boot, tests, hub chores). */
export function currentAccount(): string | undefined {
  return store.getStore();
}

/** Run fn outside any account (hub chores that a request only started). */
export function runAsHub<T>(fn: () => T): T {
  return store.exit(fn);
}

/** True for a member's account (not the owner's). */
export function isMember(accountId: string | undefined): boolean {
  return !!accountId && accountId !== OWNER_ID;
}
