/**
 * Approval grants (docs/design/SECURITY-MODE.md 4.3): issuing, revoking and
 * counting. A grant names in-scope hosts, the accounts, a request budget, a
 * rate and an expiry of 24 h; the owner approves it on a SecurityGrant card
 * (session/grants.ts asks), and it is stored under GRANTS_KV in the shape the
 * scope guard (security/scope.ts) and the egress gateway (security/gateway.ts)
 * read. Pure over a kv, so tests need no hub.
 */
import { GRANTS_KV, GRANT_MAX_MS, GRANT_MAX_REQUESTS, classify, grantLive, hostMatches, normHost, type Scope, type ScopeGrant } from './scope';

export interface GrantKv {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

/** What a workflow asks for: lib.approve({ grant: {...} }). */
export interface GrantRequest {
  hosts: string[];
  accounts?: string[];
  requestBudget?: number;
  rateRps?: number;
  reason?: string;
}

/** A checked request: the grant to store once the owner approves, and the scope it is pinned to. */
export type GrantCheck = { ok: true; grant: Omit<ScopeGrant, 'id' | 'issuedAt' | 'expiresAt'>; scope: Scope; file?: string } | { ok: false; why: string };

const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()) ? v.map((x: string) => x.trim()) : undefined);

/**
 * Check a request against the hunt's scope files. Every host must be in_scope
 * of one file (not lab, not out of scope); the budget and rate are capped by
 * that file and by the owner's 500 requests; accounts must be listed there.
 */
export function checkGrant(raw: unknown, scopes: Scope[], files: string[] = []): GrantCheck {
  const o = (raw ?? {}) as Record<string, unknown>;
  const hosts = strs(o.hosts);
  if (!hosts?.length) return { ok: false, why: 'a grant needs hosts: a list of in-scope hosts or globs' };
  const accounts = o.accounts === undefined ? [] : strs(o.accounts);
  if (!accounts) return { ok: false, why: 'accounts must be a list of account labels from scope.yaml' };
  for (const k of ['requestBudget', 'rateRps'] as const) {
    if (o[k] !== undefined && !(typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) > 0)) return { ok: false, why: `${k} must be a number above 0` };
  }
  const norm = hosts.map(normHost);
  // one file covers the whole grant, so its caps and its out_of_scope are the ones pinned
  const at = scopes.findIndex((s) => norm.every((h) => classify(s, h) === 'in'));
  if (at < 0) {
    const bad = norm.find((h) => !scopes.some((s) => classify(s, h) === 'in')) ?? norm[0];
    return { ok: false, why: `${bad} is not an in-scope host of one scope.yaml (lab and out-of-scope hosts get no grant)` };
  }
  const scope = scopes[at];
  const extra = accounts.find((a) => scope.accounts.length && !scope.accounts.includes(a));
  if (extra) return { ok: false, why: `account ${extra} is not in scope.yaml accounts` };
  const requestBudget = Math.floor(Math.min((o.requestBudget as number | undefined) ?? scope.requestBudget, scope.requestBudget, GRANT_MAX_REQUESTS));
  if (requestBudget < 1) return { ok: false, why: 'requestBudget must be at least 1' };
  const rateRps = Math.min((o.rateRps as number | undefined) ?? scope.rateLimitRps, scope.rateLimitRps);
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 600) : undefined;
  return { ok: true, grant: { hosts: norm, accounts, requestBudget, used: 0, rateRps, scope, ...(reason ? { reason } : {}) }, scope, ...(files[at] ? { file: files[at] } : {}) };
}

/** The card's text: the mono block of the SecurityGrant approval (web ApprovalCard). */
export function grantCardText(c: Extract<GrantCheck, { ok: true }>, expiresAt: number): string {
  const g = c.grant;
  const when = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16);
  return [
    `hosts     ${g.hosts.join(', ')}`,
    `accounts  ${g.accounts.length ? g.accounts.join(', ') : 'none named'}`,
    `budget    ${g.requestBudget} requests, ${g.rateRps} per second`,
    `expires   in 24 hours (${when} UTC)`,
    `scope     ${c.scope.program}${c.file ? `, ${c.file}` : ''}`,
  ].join('\n');
}

export function grantsOf(kv: GrantKv, sessionId: string): ScopeGrant[] {
  const all = kv.get<Record<string, ScopeGrant[]>>(GRANTS_KV, {});
  return Array.isArray(all[sessionId]) ? all[sessionId] : [];
}

function write(kv: GrantKv, sessionId: string, fn: (list: ScopeGrant[]) => ScopeGrant[]): void {
  const all = kv.get<Record<string, ScopeGrant[]>>(GRANTS_KV, {});
  all[sessionId] = fn(Array.isArray(all[sessionId]) ? all[sessionId] : []);
  kv.set(GRANTS_KV, all);
}

/** Store an approved grant: 24 h from now, the owner's fixed term. */
export function addGrant(kv: GrantKv, sessionId: string, g: Omit<ScopeGrant, 'id' | 'issuedAt' | 'expiresAt'>, now = Date.now(), id = `grant_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`): ScopeGrant {
  const grant: ScopeGrant = { ...g, id, used: g.used ?? 0, issuedAt: now, expiresAt: now + GRANT_MAX_MS };
  write(kv, sessionId, (list) => [...list, grant]);
  return grant;
}

/** Revoke one grant now. Returns it, or undefined when the session has no such grant. */
export function revokeGrant(kv: GrantKv, sessionId: string, id: string, now = Date.now()): ScopeGrant | undefined {
  let hit: ScopeGrant | undefined;
  write(kv, sessionId, (list) => list.map((g) => (g.id === id ? (hit = { ...g, revokedAt: g.revokedAt ?? now }) : g)));
  return hit;
}

/** Count one request on a grant (the gateway calls it). Returns the new count. */
export function countUse(kv: GrantKv, sessionId: string, id: string): number {
  let used = 0;
  write(kv, sessionId, (list) => list.map((g) => (g.id === id ? { ...g, used: (used = (g.used ?? 0) + 1) } : g)));
  return used;
}

/** A live grant that already covers every host, so a later lead asks nothing (4.3). */
export function coveringGrant(grants: ScopeGrant[], hosts: string[], now = Date.now()): ScopeGrant | undefined {
  const norm = hosts.map(normHost);
  return grants.find((g) => grantLive(g, now) && norm.every((h) => g.hosts.some((p) => hostMatches(p, h))));
}
