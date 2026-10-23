import type { Session } from '../types';
import type { Engine } from './engine';
import type { PermissionRules } from '../session/permissions';
import { isUntrusted } from '../session/untrusted';
import { claudeUserSettings, projectSettingsFiles, settingsPermissionRules, type SettingsFile } from './settings-sources';

/**
 * Merge permission rules from config, the agent, the routine that started the
 * session, Claude Code user settings
 * (~/.claude/settings.json when compat is on) and project settings
 * (.claude/settings*.json, .conclave/settings*.json). Allow rules from a
 * project folder count only once the owner trusted it; its deny and ask rules
 * always apply.
 *
 * An untrusted session (session/untrusted.ts) gets no allow rule but its
 * routine's own: config, Claude Code and project allow rules, a skills.learn
 * grant and workflow rules do not reach it. Deny and ask rules all apply, and
 * askReadOnly makes every other call ask.
 */
export function PermissionRulesFor(engine: Engine, session: Session): PermissionRules {
  const cfg = engine.config.get();
  const files = settingsPermissionRules(session.cwd, cfg.compat.claudeCode, engine.trust.isTrusted(session.cwd));
  const agent = engine.agentFor(session);
  const deny = [...files.deny, ...cfg.permissions.deny];
  const ask = [...files.ask, ...cfg.permissions.ask];
  if (isUntrusted(session, agent.untrusted)) {
    if (agent.disallowedTools) deny.push(...agent.disallowedTools);
    const routine = routineOf(engine, session);
    if (routine?.deny?.length) deny.push(...routine.deny);
    const wf = session.meta?.workflowRules as { deny?: unknown } | undefined;
    if (Array.isArray(wf?.deny)) deny.push(...wf.deny.filter((r): r is string => typeof r === 'string'));
    return { allow: [...(routine?.allow ?? [])], deny, ask, askReadOnly: true, ...(routine?.suggestion ? { webFetchNeedsRule: true } : {}) };
  }
  const allow = [...files.allow, ...cfg.permissions.allow];
  // An agent's tools list decides what the model sees, not what it may run:
  // listing Bash must not allow every command. Read-only tools need no rule
  // (checkPermission allows them), so nothing is added here.
  if (agent.disallowedTools) deny.push(...agent.disallowedTools);
  // skills.learn auto: skills agents write save without the approval card (ask and deny rules still win)
  if (cfg.skills?.learn === 'auto') allow.push('SkillManage');
  // a routine's own rules apply to the sessions it starts, subagents included (ECOSYSTEM.md 5.3)
  const routine = routineOf(engine, session);
  if (routine?.allow?.length) allow.push(...routine.allow);
  if (routine?.deny?.length) deny.push(...routine.deny);
  // a workflow's meta.permissions apply to its agents and its lib.exec calls only (workflows/run.ts)
  const wf = session.meta?.workflowRules as { allow?: unknown; deny?: unknown } | undefined;
  if (Array.isArray(wf?.allow)) allow.push(...wf.allow.filter((r): r is string => typeof r === 'string'));
  if (Array.isArray(wf?.deny)) deny.push(...wf.deny.filter((r): r is string => typeof r === 'string'));
  // a routine made from a suggestion fetches only from the domains its allow list names
  return { allow, deny, ask, ...(routine?.suggestion ? { webFetchNeedsRule: true } : {}) };
}

/** The routine a session runs for: its own routineId, or the one of the session that started it (subagents). */
export function routineOf(engine: Engine, session: Session) {
  let s: Session | undefined = session;
  for (let depth = 0; s && depth < 6; depth++) {
    if (s.routineId) return engine.routines.get(s.routineId);
    s = s.parentId ? engine.getSession(s.parentId) : undefined;
  }
  return undefined;
}

/** Where each rule came from (config, a settings file path), for the Tools view. */
export function ruleSources(engine: Engine, cwd: string | undefined): Array<{ rule: string; list: 'allow' | 'deny' | 'ask'; source: string; active: boolean }> {
  const cfg = engine.config.get();
  const out: Array<{ rule: string; list: 'allow' | 'deny' | 'ask'; source: string; active: boolean }> = [];
  const add = (f: SettingsFile | undefined, trusted: boolean) => {
    for (const list of ['allow', 'deny', 'ask'] as const) for (const rule of f?.permissions?.[list] ?? []) out.push({ rule, list, source: f!.path, active: list !== 'allow' || trusted });
  };
  if (cfg.compat.claudeCode) add(claudeUserSettings(), true);
  for (const list of ['allow', 'deny', 'ask'] as const) for (const rule of cfg.permissions[list]) out.push({ rule, list, source: 'config', active: true });
  if (cwd) {
    const trusted = engine.trust.isTrusted(cwd);
    for (const f of projectSettingsFiles(cwd, cfg.compat.claudeCode)) add(f, trusted);
  }
  return out;
}
