/**
 * Role routing for Security mode (docs/design/SECURITY-MODE.md 1.4): the
 * owner's Settings > Security > Roles table (config security.roles) over the
 * sec-* profiles' own model and fallback list. First match wins:
 *
 * 1. a model the owner names (a provider/model override: subagentModel's ask)
 * 2. the Same-model pin (session/model-pin.ts)
 * 3. the Roles table row: its model, then its fallback list
 * 4. the role profile's model, then its fallback list
 * 5. the parent's model (an unusable or 404 model gives way: agent-model.ts)
 *
 * roleDef folds 3 and 4 into the def's model and fallback, so subagentModel
 * does 1, 2 and 5 as for any agent. A member routes only to models their
 * account may use: the owner's table is not theirs, and a profile model they
 * cannot use drops out, so they land on their own chat model.
 */
import type { ConclaveConfig } from '../config/schema';
import type { AgentDef } from '../extensions/types';
import type { Engine } from '../engine/engine';
import { isMember } from '../people/context';
import { memberCanUse } from '../session/member-fallbacks';

export interface RoleRoute {
  model?: string;
  fallback?: string[];
}

/** What roleDef needs from the engine. */
export interface RoleHost {
  config: { get(): ConclaveConfig };
}

/** The def with the Roles table folded in. Only grouped security roles change. `canUse` is set for a member's account. */
export function roleDef<T extends Pick<AgentDef, 'name' | 'group' | 'model' | 'fallback'>>(host: RoleHost, def: T, canUse?: (ref: string) => boolean): T {
  if (def.group !== 'security') return def;
  const row = canUse ? undefined : host.config.get().security?.roles?.[def.name];
  const list = [row?.model, ...(row?.fallback ?? []), def.model, ...(def.fallback ?? [])].filter((m, i, all): m is string => !!m && all.indexOf(m) === i);
  const mine = canUse ? list.filter((m) => m.includes('/') && canUse(m)) : list;
  // a member with none of the role's models usable: no model, so subagentModel takes the parent's (their own chat model)
  return { ...def, model: mine[0], fallback: mine.slice(1) };
}

/** roleDef as an account sees it: a member's routes only to models their account may use. */
export function accountRole<T extends Pick<AgentDef, 'name' | 'group' | 'model' | 'fallback'>>(engine: Engine, def: T, accountId: string): T {
  return roleDef(engine, def, isMember(accountId) ? (m) => memberCanUse(engine, accountId, m) : undefined);
}

const REF = /^[\w.-]+\/\S+$/;

/** A bad security.roles patch, in words for the owner, else undefined. */
export function rolesProblem(roles: unknown): string | undefined {
  if (roles === undefined || roles === null) return undefined;
  if (typeof roles !== 'object' || Array.isArray(roles)) return 'security.roles must be an object keyed by role';
  for (const [role, row] of Object.entries(roles as Record<string, unknown>)) {
    if (!/^sec-[a-z-]+$/.test(role)) return `security.roles.${role}: roles are the sec-* agents`;
    if (row === null) continue;
    if (typeof row !== 'object' || Array.isArray(row)) return `security.roles.${role} must be { model, fallback }`;
    const r = row as Record<string, unknown>;
    if (r.model !== undefined && r.model !== null && (typeof r.model !== 'string' || !REF.test(r.model))) return `security.roles.${role}.model must be provider/model`;
    if (r.fallback !== undefined && r.fallback !== null && (!Array.isArray(r.fallback) || r.fallback.some((m) => typeof m !== 'string' || !REF.test(m)))) return `security.roles.${role}.fallback must be a list of provider/model`;
  }
  return undefined;
}
