/**
 * Passwords (docs/design/HUB-LOGIN-AND-IDENTITY.md, docs/design/ACCOUNTS.md 4):
 * a backup to pairing codes, off until a person sets one. Each account has
 * its own; only the argon2id hash is kept, in the accounts table, so it is
 * never in config.json and never in a backup (backups do not read that table).
 * The hub password from before accounts is the owner's (people/migrate.ts).
 */
import type { PasswordStatus } from '@conclave/core/client/index.ts';
import type { HubAccount, PeopleStore } from '@conclave/core/people/store.ts';
import { OWNER_ID } from '@conclave/core/people/context.ts';
import { badRequest } from './http';

export const PASSWORD_MIN = 12;
const PASSWORD_MAX = 1024;

/** Pinned so a stored hash and the stand-in below always cost the same to check. */
const ARGON = { algorithm: 'argon2id', memoryCost: 65_536, timeCost: 2 } as const;

/**
 * The hash of a random value nobody kept, with the same cost. A login for a
 * name nobody has, or an account without a password, is checked against this,
 * so it takes as long to say no and timing tells neither.
 */
const STAND_IN = '$argon2id$v=19$m=65536,t=2,p=1$9OuiaS1FjGp2uDNhiOGWosCFvssc3wCrA9cvHL1yDoo$8o2oIlABJ9aXFlNrCBaO46SbfokF9qYwB6EiH5R67wo';

export function passwordStatus(people: PeopleStore, accountId: string = OWNER_ID): PasswordStatus {
  const a = people.get(accountId);
  return a?.passwordSet ? { set: true, setAt: a.passwordSetAt ?? 0 } : { set: false };
}

/** Throws a 400 that says what a password needs. */
export function checkNewPassword(password: unknown): string {
  if (typeof password !== 'string' || [...password].length < PASSWORD_MIN || !password.trim()) {
    throw badRequest(`The password needs ${PASSWORD_MIN} characters or more.`);
  }
  if (password.length > PASSWORD_MAX) throw badRequest(`The password can have ${PASSWORD_MAX} characters at most.`);
  return password;
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON);
}

export async function setPassword(people: PeopleStore, accountId: string, password: unknown): Promise<PasswordStatus> {
  const p = checkNewPassword(password);
  people.setPasswordHash(accountId, await hashPassword(p));
  return passwordStatus(people, accountId);
}

export function clearPassword(people: PeopleStore, accountId: string = OWNER_ID): PasswordStatus {
  people.setPasswordHash(accountId, undefined);
  return { set: false };
}

/**
 * The account a name and password sign in to, or undefined. The name is a
 * sign-in name or an email (people.bySignIn); none is the owner (a single
 * person hub, and apps from before accounts). A name or email nobody has, an
 * email two accounts share, an account without a password and a wrong
 * password all take the same time and give the same answer.
 */
export async function checkLogin(people: PeopleStore, name: string | undefined, password: string): Promise<HubAccount | undefined> {
  // a guess longer than any password that can be set is wrong either way
  if (password.length > PASSWORD_MAX) return undefined;
  const account = name && name.trim() ? people.bySignIn(name) : people.owner();
  const hash = account ? people.passwordHash(account.id) : undefined;
  let ok = false;
  try {
    ok = await Bun.password.verify(password, hash ?? STAND_IN);
  } catch {
    ok = false;
  }
  return ok && account && hash ? account : undefined;
}
