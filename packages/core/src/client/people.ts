/**
 * Accounts on one hub (docs/design/ACCOUNTS.md): who you are (/api/me) and,
 * for the owner, the people on the hub (/api/people).
 */

export type AccountRole = 'owner' | 'member';

/** Who a token signs in as. Pairing and login replies carry it. */
export interface AccountRef {
  id: string;
  /** The sign-in name: one word, unique on the hub. */
  name: string;
  /** What the apps show and greet by ("Kai Ahir"). Missing: none given (the owner's default account), or an older hub. */
  displayName?: string;
  role: AccountRole;
}

/** What the owner's account is called until the owner gives a name (core people/migrate.ts). */
export const OWNER_DEFAULT_NAME = 'owner';

/** The longest display name, in characters. */
export const DISPLAY_NAME_MAX = 60;
/** What a display name may hold: letters of any script, digits, spaces and common punctuation. */
const DISPLAY_NAME_RE = /^[\p{L}\p{M}\p{N} .,'’‘"“”()&!?@+:;/#_~-]+$/u;

/** A display name as it is kept: trimmed, each run of spaces one space. */
export function tidyDisplayName(v: string): string {
  return v.trim().replace(/\s+/g, ' ');
}

/**
 * Why this cannot be a display name, or undefined when it can. Checked after
 * tidyDisplayName; empty is no display name, which is fine. The hub checks
 * the same (core people/store.ts checkDisplayName).
 */
export function displayNameProblem(v: string): string | undefined {
  const n = tidyDisplayName(v);
  if (!n) return undefined;
  if ([...n].length > DISPLAY_NAME_MAX) return `A display name has at most ${DISPLAY_NAME_MAX} characters.`;
  if (!DISPLAY_NAME_RE.test(n) || !/[\p{L}\p{N}]/u.test(n)) return 'Use letters, digits, spaces and common punctuation in a display name.';
  return undefined;
}

/**
 * The name to show and greet a person by, or undefined for none: their
 * display name, else their sign-in name. One that is still the sign-in name
 * gets a capital first letter ("riley" greets as "Riley"), as before display
 * names; one set apart shows as it was typed. The owner's default sign-in
 * name, owner, is no name.
 */
export function shownName(a: Pick<AccountRef, 'name' | 'displayName' | 'role'> | undefined): string | undefined {
  if (!a) return undefined;
  const d = a.displayName?.trim();
  if (d && d !== a.name) return d;
  const n = (d || a.name || '').trim();
  if (!n || (a.role === 'owner' && n.toLowerCase() === OWNER_DEFAULT_NAME)) return undefined;
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** One provider as an account may use it. */
export interface ProviderAccessDto {
  provider: string;
  name: string;
  /** Whose key a call would use now: the hub's, the person's own, or none. */
  source: 'hub' | 'own' | 'none';
  /** The owner lets this person use the hub's key. */
  hubAllowed: boolean;
  /** The person saved a key of their own. */
  ownKey: boolean;
  /** cliproxy: how many plans the person signed in themselves (docs/design/ACCOUNTS.md 12). */
  ownPlans?: number;
  /** Monthly cap on the hub's key, in USD. Missing: no cap. */
  monthlyUsd?: number;
  /** Spent on the hub's key this month. */
  spentUsd: number;
  /** When the month's budget starts again. */
  resetsAt: number;
}

/** The most sessions side by side (/sessions/split). */
export const SPLIT_MAX = 4;

export interface MePreferences {
  defaultModel?: string;
  smallModel?: string;
  defaultAgent?: string;
  /** Watch this person's devices for new chats to import. */
  importWatch?: boolean;
  /** Sessions side by side (/sessions/split): up to SPLIT_MAX session ids, left to right. */
  splitView?: string[];
}

/** GET /api/me */
export interface MeDto extends AccountRef {
  email?: string;
  /** More than one person on this hub. */
  people: boolean;
  /** The hub's own computer may run this person's tools (the owner only). */
  hubMachine: boolean;
  passwordSet: boolean;
  providers: ProviderAccessDto[];
  preferences: MePreferences;
  /** A member's own "always allow" rules (the owner's are permissions.allow in /api/config). */
  allow?: string[];
  /** A member's files on the hub: what they take and the owner's cap, in bytes. Missing for the owner. */
  disk?: { usedBytes: number; limitBytes: number };
}

/** PATCH /api/me. null clears a default or the display name. */
export interface MePatch {
  /** The sign-in name. */
  name?: string;
  /** 1 to 60 characters, spaces and common punctuation allowed. */
  displayName?: string | null;
  email?: string | null;
  defaultModel?: string | null;
  smallModel?: string | null;
  defaultAgent?: string | null;
  importWatch?: boolean;
  /** Up to SPLIT_MAX session ids; null or [] clears the view. */
  splitView?: string[] | null;
  /** A member's own usage fallback: models they can call, first tried first. null clears it. The owner's is models.limitFallback in /api/config. */
  usageFallback?: { enabled?: boolean; models?: string[] } | null;
  /** A member's own refusal fallback: models they can call, no accounts. null clears it. The owner's is models.refusalFallback. */
  refusalFallback?: { enabled?: boolean; stay?: boolean; entries?: Array<{ model: string }> } | null;
  /** A member's own "always allow" rules, the whole list (at most 200). The owner's are permissions.allow. */
  allow?: string[];
}

/** The owner's grant of a hub key: missing provider is no access; monthlyUsd null is no cap. */
export type ProviderGrantsDto = Record<string, { monthlyUsd?: number | null }>;

/** GET /api/people (owner) */
export interface PersonDto extends AccountRef {
  email?: string;
  passwordSet: boolean;
  /** An invite link waits until this time. */
  inviteExpiresAt?: number;
  createdAt: number;
  /** Paired devices and apps. */
  devices: number;
  apps: number;
  /** Which hub keys this person may use, with this month's spend. */
  providers: ProviderGrantsDto;
  spend: Array<{ provider: string; name: string; monthlyUsd?: number; spentUsd: number }>;
  /** Plans the person signed in themselves, on their own CLIProxyAPI. Only how many: never which or whose. */
  ownPlans?: number;
  /** A member's disk cap on the hub in GB, and what their files take now (bytes). */
  diskLimitGb?: number;
  diskUsedBytes?: number;
  /** A member with no web search key of their own may use the hub's web search. */
  webSearch?: boolean;
}

/** POST /api/people (owner) */
export interface PersonInput {
  /** The sign-in name. */
  name: string;
  /** What the apps show. Left out: the sign-in name. */
  displayName?: string;
  email?: string;
  /** Set a password now (12 characters or more), or leave it out and send an invite. */
  password?: string;
  /** Make an invite link (default when no password is given). */
  invite?: boolean;
  providers?: ProviderGrantsDto;
}

/** PATCH /api/people/:id (owner) */
export interface PersonPatch {
  name?: string;
  displayName?: string | null;
  email?: string | null;
  providers?: ProviderGrantsDto;
  /** A member's disk cap on the hub in GB (1 to 1000); null back to the default. */
  diskLimitGb?: number | null;
  /** Let a member use the hub's web search when they have no key of their own. */
  webSearch?: boolean;
}

/** An invite link: shown once, good once, for 7 days. */
export interface InviteDto {
  url: string;
  /** The secret in the link, for apps that build their own. */
  secret: string;
  expiresAt: number;
}

/** POST /api/people (owner) */
export interface PersonCreated {
  person: PersonDto;
  invite?: InviteDto;
}

/** GET /api/invite/:secret (no token): who the invite is for, before they set a password. */
export interface InviteInfo {
  /** The sign-in name. */
  name: string;
  /** What the apps will call them. Missing on an older hub. */
  displayName?: string;
  hub: string;
  expiresAt: number;
}

/** A device code for a person's workspace on the hub machine (a daemon under its own OS user or container). */
export interface WorkspaceCode {
  code: string;
  expiresAt: number;
  addresses: string[];
  /** The commands to run on the hub machine, filled in. */
  commands: { linux: string[]; docker: string[] };
}
