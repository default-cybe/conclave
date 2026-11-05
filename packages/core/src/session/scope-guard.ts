/**
 * The scope guard (docs/design/SECURITY-MODE.md 4.4): an in-hub PreToolUse
 * hook for Security mode sessions. It is the early warning, not the boundary;
 * the egress gateway on Madx (PR 1b) is.
 *
 * - On for a session whose agent lists the `scope-guard` recipe, and for every
 *   session below one (Task children, Delegate sessions on other devices), so
 *   handing a network task to a child or a device does not drop the guard.
 * - The scope and the grants come from the topmost guarded session in the
 *   chain (the security session): scope.yaml and targets/<t>/scope.yaml in its
 *   folder, read on its device; grants from the hub's kv (GRANTS_KV), keyed by
 *   that session's id. Agents cannot write either store through a tool.
 * - It runs in the hub, so it also covers members' sessions, where hook
 *   commands do not run. A member's in-scope call is denied: lab only in v1.
 * - The decision itself is security/scope.ts decide().
 */
import { join } from 'node:path';
import type { Hooks } from '../extensions/hooks';
import type { AgentDef, HookInput, HookOutcome } from '../extensions/types';
import type { Machine } from '../machine/types';
import type { Session } from '../types';
import { wantsScopeGuard } from '../extensions/agent-hooks';
import { GRANTS_KV, ScopeError, decide, guardedTool, parseScope, scopeExpired, type Scope, type ScopeGrant, type ScopeState } from '../security/scope';

export interface ScopeGuardHost {
  getSession(id: string): Session | undefined;
  agentFor(session: Session): AgentDef;
  machineFor(session: Session): Machine;
  isMemberSession(session: Session): boolean;
  repos: { kv: { get<T>(key: string, fallback: T): T } };
}

/** The topmost session in the chain whose agent turns the guard on, or undefined when none does. */
export function guardAnchor(host: ScopeGuardHost, session: Session): Session | undefined {
  let anchor: Session | undefined;
  let s: Session | undefined = session;
  for (let i = 0; s && i < 32; i++) {
    if (wantsScopeGuard(host.agentFor(s))) anchor = s;
    s = s.parentId ? host.getSession(s.parentId) : undefined;
  }
  return anchor;
}

async function readIf(m: Machine, path: string): Promise<string | undefined> {
  try {
    return (await m.stat(path)) ? await m.readText(path) : undefined;
  } catch {
    return undefined;
  }
}

/** scope.yaml in the folder and targets/<t>/scope.yaml below it. An invalid or expired file makes the whole state bad. */
export async function loadScope(m: Machine, cwd: string, now = Date.now()): Promise<ScopeState> {
  const files = [join(cwd, 'scope.yaml')];
  try {
    for (const e of await m.readdir(join(cwd, 'targets'))) if (e.type === 'dir') files.push(join(cwd, 'targets', e.name, 'scope.yaml'));
  } catch {
    /* no targets folder */
  }
  const scopes: Scope[] = [];
  const found: string[] = [];
  for (const f of files) {
    const text = await readIf(m, f);
    if (text === undefined) continue;
    let s: Scope;
    try {
      s = parseScope(text);
    } catch (err) {
      return { kind: 'bad', why: `${f}: ${err instanceof ScopeError ? err.message : (err as Error).message}` };
    }
    if (scopeExpired(s, now)) return { kind: 'bad', why: `${f} expired on ${s.expires}` };
    scopes.push(s);
    found.push(f);
  }
  return scopes.length ? { kind: 'ok', scopes, files: found } : { kind: 'none' };
}

/** The scope guard's PreToolUse function. Returns undefined when the session is not guarded or the call passes. */
export async function scopeGuardCheck(host: ScopeGuardHost, input: HookInput): Promise<Partial<HookOutcome> | undefined> {
  const tool = input.tool_name ?? '';
  if (!guardedTool(tool)) return undefined;
  const session = host.getSession(input.session_id);
  if (!session) return undefined;
  const anchor = guardAnchor(host, session);
  if (!anchor) return undefined;
  let scope: ScopeState;
  try {
    scope = await loadScope(host.machineFor(anchor), anchor.cwd);
  } catch (err) {
    scope = { kind: 'bad', why: `could not read the hunt folder: ${(err as Error).message}` };
  }
  const member = host.isMemberSession(anchor) || host.isMemberSession(session);
  const all = host.repos.kv.get<Record<string, ScopeGrant[]>>(GRANTS_KV, {});
  const grants = Array.isArray(all[anchor.id]) ? all[anchor.id] : [];
  const v = decide({ tool, input: input.tool_input ?? {}, scope, grants, member });
  if (!v) return undefined;
  return v.decision === 'deny' ? { blocked: true, permissionDecision: 'deny', reason: v.reason } : { permissionDecision: 'ask', reason: v.reason };
}

/** Register the scope guard on the hook runner. Returns a function that removes it. */
export function attachScopeGuard(host: ScopeGuardHost, hooks: Hooks): () => void {
  return hooks.register('PreToolUse', (input) => scopeGuardCheck(host, input), undefined, 'scope-guard');
}
