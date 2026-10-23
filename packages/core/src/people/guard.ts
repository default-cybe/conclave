/**
 * The machine guard (docs/design/ACCOUNTS.md 5). Tools run as the hub's OS
 * user, so a member's work must never reach the hub's own disk or shell, and
 * nobody's work may reach another account's device. The device registry
 * wraps every Machine it hands out in this guard; the account comes from the
 * context the work runs in (people/context.ts), not from the caller, so a
 * path that forgot to check is still refused.
 */
import type { Machine } from '../machine/types';
import { currentAccount, OWNER_ID } from './context';

export const HUB_REFUSED =
  "This runs on the hub's own computer, which only the hub's owner can use. Pair a device of your own in Settings, Devices, and work there.";
export const DEVICE_REFUSED = 'This device belongs to someone else on this hub.';
/** A member's code session on the hub, refused before it starts instead of at every tool (engine createSession, the repo session route). */
export const CODE_NEEDS_DEVICE = 'Code sessions run on a computer you paired. Pair yours in Devices.';

/** A call the guard stopped. Status 403, so routes answer it as refused. */
export class MachineRefused extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'MachineRefused';
  }
}

/** Calls that only compute (no disk, no process): always allowed. */
const PURE = new Set(['resolve']);
/** The one Machine call that answers synchronously; every other one returns a promise, so a refusal is a rejected promise. */
const SYNC = new Set(['spawn']);

const GUARDED = Symbol('guarded');

/**
 * Wrap a machine. `owner` is the account it belongs to: the owner for the
 * hub, the device row's account for a paired device (read at call time, so
 * a device moved or removed is judged as it is now). Outside any account
 * context nothing is refused.
 */
export function guardMachine<T extends Machine>(machine: T, owner: string | (() => string | undefined), kind: 'hub' | 'device'): T {
  if ((machine as unknown as Record<symbol, unknown>)[GUARDED]) return machine;
  const refused = (): MachineRefused | undefined => {
    const acct = currentAccount();
    if (acct === undefined) return undefined;
    const who = typeof owner === 'function' ? owner() : owner;
    if (acct === who) return undefined;
    return new MachineRefused(kind === 'hub' ? HUB_REFUSED : DEVICE_REFUSED);
  };
  return new Proxy(machine, {
    get(target, prop, receiver) {
      if (prop === GUARDED) return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string' || PURE.has(prop)) return value;
      return function guarded(this: unknown, ...args: unknown[]) {
        const no = refused();
        if (no) {
          if (SYNC.has(prop)) throw no;
          return Promise.reject(no);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** True when the current work may use a machine that belongs to `owner` (for checks before a call). */
export function mayUse(owner: string | undefined): boolean {
  const acct = currentAccount();
  return acct === undefined || acct === (owner ?? OWNER_ID);
}

/**
 * Stands in for a machine an account may not use: the hub for a member, or
 * another account's device. Every call fails with the refusal, so a tool
 * says why instead of running anywhere.
 */
export class RefusedMachine implements Machine {
  readonly refused = true;
  readonly name: string;
  constructor(
    readonly id: string,
    /** Why every call fails: said to the person instead of running anywhere. */
    readonly reason: string,
  ) {
    this.name = id === 'local' ? 'the hub' : id;
  }
  private fail(): Promise<never> {
    return Promise.reject(new MachineRefused(this.reason));
  }
  info() {
    return this.fail();
  }
  stat() {
    return this.fail();
  }
  readFile() {
    return this.fail();
  }
  readText() {
    return this.fail();
  }
  writeFile() {
    return this.fail();
  }
  readdir() {
    return this.fail();
  }
  mkdir() {
    return this.fail();
  }
  remove() {
    return this.fail();
  }
  rename() {
    return this.fail();
  }
  glob() {
    return this.fail();
  }
  grep() {
    return this.fail();
  }
  exec() {
    return this.fail();
  }
  spawn(): never {
    throw new MachineRefused(this.reason);
  }
  resolve(path: string, cwd: string): string {
    if (path.startsWith('/')) return path;
    return `${cwd.replace(/\/+$/, '')}/${path}`;
  }
}
