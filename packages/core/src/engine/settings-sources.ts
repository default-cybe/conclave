/**
 * Where hooks and permission rules come from, with the origin of each group.
 *
 * Layers, low to high: Claude Code user settings (~/.claude/settings.json,
 * when compat.claudeCode is on), Conclave config.json, plugins, then the
 * project files (.claude/settings.json, .claude/settings.local.json,
 * .conclave/settings.json, .conclave/settings.local.json). Hook lists and
 * permission lists concatenate across layers, as in Claude Code.
 *
 * Project files come from whatever folder a session opens, which can be a
 * repo someone else wrote. Their hooks run commands and their allow rules
 * skip prompts, so both stay off until the owner trusts the folder once
 * (ProjectTrust). Deny and ask rules from an untrusted folder still apply,
 * since they only make things stricter.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { claudeHome, parseJsonc } from '../config';
import type { ConclaveConfig, HookEvent, HooksConfig } from '../config/schema';
import type { RuntimeHookCommand } from '../extensions/types';
import type { KvRepo } from '../storage/repos';

export type HookOrigin = 'claude-user' | 'config' | 'plugin' | 'claude-project' | 'project';

/** Hook events in the order they happen in a session (for the Hooks view). */
export const HOOK_EVENTS: HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Stop',
  'SessionEnd',
];

/** Events the engine fires. Every event in the schema fires now; kept as a list so the UI can say so. */
export const FIRED_HOOK_EVENTS = new Set<HookEvent>(HOOK_EVENTS);

export interface HookGroupInfo {
  event: HookEvent;
  matcher?: string;
  hooks: RuntimeHookCommand[];
  source: HookOrigin;
  /** File the group was read from (settings files), when there is one. */
  path?: string;
  plugin?: string;
  /** Position among this event's groups from the same source (and plugin). */
  index: number;
  /** False for project groups in a folder the owner has not trusted yet. */
  active: boolean;
}

export interface SettingsFile {
  path: string;
  source: 'claude-user' | 'claude-project' | 'project';
  hooks?: HooksConfig;
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
}

function readSettings(path: string, source: SettingsFile['source']): SettingsFile | undefined {
  if (!existsSync(path)) return undefined;
  let data: Record<string, unknown>;
  try {
    data = parseJsonc<Record<string, unknown>>(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object') return undefined;
  const out: SettingsFile = { path, source };
  if (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)) out.hooks = data.hooks as HooksConfig;
  const p = data.permissions as Record<string, unknown> | undefined;
  if (p && typeof p === 'object') {
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
    out.permissions = { allow: list(p.allow), deny: list(p.deny), ask: list(p.ask) };
  }
  return out;
}

/** ~/.claude/settings.json (honours CLAUDE_CONFIG_DIR). */
export function claudeUserSettings(): SettingsFile | undefined {
  return readSettings(join(claudeHome(), 'settings.json'), 'claude-user');
}

/** Project settings files in load order. Claude files only when compat.claudeCode is on. */
export function projectSettingsFiles(cwd: string, claudeCompat: boolean): SettingsFile[] {
  const files: Array<[string, SettingsFile['source']]> = [];
  if (claudeCompat) files.push([join(cwd, '.claude', 'settings.json'), 'claude-project'], [join(cwd, '.claude', 'settings.local.json'), 'claude-project']);
  files.push([join(cwd, '.conclave', 'settings.json'), 'project'], [join(cwd, '.conclave', 'settings.local.json'), 'project']);
  return files.map(([p, s]) => readSettings(p, s)).filter((f): f is SettingsFile => !!f);
}

/** True when a project folder has hooks, allow rules or MCP servers that wait for trust. */
export function projectNeedsTrust(cwd: string, claudeCompat: boolean): { hooks: number; allow: number; mcpServers: number; files: string[] } {
  const files = projectSettingsFiles(cwd, claudeCompat);
  let hooks = 0;
  let allow = 0;
  for (const f of files) {
    for (const list of Object.values(f.hooks ?? {})) hooks += (list ?? []).reduce((n, g) => n + (g?.hooks?.length ?? 0), 0);
    allow += f.permissions?.allow?.length ?? 0;
  }
  let mcpServers = 0;
  const mcpPath = join(cwd, '.mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const data = parseJsonc<{ mcpServers?: Record<string, unknown> }>(readFileSync(mcpPath, 'utf8'));
      mcpServers = Object.keys(data?.mcpServers ?? {}).length;
    } catch {
      /* ignore */
    }
  }
  const used = files.filter((f) => Object.keys(f.hooks ?? {}).length || f.permissions?.allow?.length).map((f) => f.path);
  if (mcpServers) used.push(mcpPath);
  return { hooks, allow, mcpServers, files: used };
}

/**
 * Folders the owner trusted. Trust covers the folder and everything below
 * it. Stored in the kv table so it survives restarts.
 */
export class ProjectTrust {
  private static KEY = 'trust.folders';

  constructor(private kv: KvRepo) {}

  list(): Array<{ path: string; at: number }> {
    const map = this.kv.get<Record<string, number>>(ProjectTrust.KEY, {});
    return Object.entries(map).map(([path, at]) => ({ path, at })).sort((a, b) => a.path.localeCompare(b.path));
  }

  isTrusted(cwd: string | undefined): boolean {
    if (!cwd) return false;
    const map = this.kv.get<Record<string, number>>(ProjectTrust.KEY, {});
    let dir = resolve(cwd);
    for (;;) {
      if (map[dir] !== undefined) return true;
      const up = dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  }

  set(cwd: string, trusted: boolean): void {
    const map = { ...this.kv.get<Record<string, number>>(ProjectTrust.KEY, {}) };
    const key = resolve(cwd);
    if (trusted) map[key] = Date.now();
    else delete map[key];
    this.kv.set(ProjectTrust.KEY, map);
  }
}

function groupsFrom(hooks: HooksConfig | undefined, source: HookOrigin, extra: { path?: string; active: boolean }): HookGroupInfo[] {
  const out: HookGroupInfo[] = [];
  for (const [event, list] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    const counters = new Map<string, number>();
    for (const g of list) {
      if (!g || !Array.isArray(g.hooks)) continue;
      const hooksList = g.hooks as RuntimeHookCommand[];
      const plugin = source === 'plugin' ? hooksList.find((h) => h.plugin)?.plugin : undefined;
      const key = plugin ?? '';
      const index = counters.get(key) ?? 0;
      counters.set(key, index + 1);
      out.push({ event: event as HookEvent, matcher: g.matcher, hooks: hooksList, source, path: extra.path, plugin, index, active: extra.active });
    }
  }
  return out;
}

export interface CollectOptions {
  config: ConclaveConfig;
  pluginHooks: HooksConfig;
  cwd?: string;
  /** Whether the project folder is trusted. Project groups are inactive otherwise. */
  trusted: boolean;
  /** Path of config.json, for the origin label. */
  configPath?: string;
}

/** Every hook group from every layer, with its origin. Inactive groups are listed but do not run. */
export function collectHookGroups(o: CollectOptions): HookGroupInfo[] {
  const groups: HookGroupInfo[] = [];
  if (o.config.compat.claudeCode) {
    const user = claudeUserSettings();
    if (user) groups.push(...groupsFrom(user.hooks, 'claude-user', { path: user.path, active: true }));
  }
  groups.push(...groupsFrom(o.config.hooks, 'config', { path: o.configPath, active: true }));
  groups.push(...groupsFrom(o.pluginHooks, 'plugin', { active: true }));
  if (o.cwd) {
    for (const f of projectSettingsFiles(o.cwd, o.config.compat.claudeCode)) {
      groups.push(...groupsFrom(f.hooks, f.source === 'claude-project' ? 'claude-project' : 'project', { path: f.path, active: o.trusted }));
    }
  }
  return groups;
}

/** Merge active groups back into one HooksConfig, optionally limited to a subset (hook test runs). */
export function hooksFromGroups(groups: HookGroupInfo[], only?: { source?: HookOrigin; plugin?: string; index?: number; path?: string }): HooksConfig {
  const out: HooksConfig = {};
  for (const g of groups) {
    if (!g.active) continue;
    if (only?.source && g.source !== only.source) continue;
    if (only?.plugin && g.plugin !== only.plugin) continue;
    if (only?.path && g.path !== only.path) continue;
    if (only?.index !== undefined && g.index !== only.index) continue;
    (out[g.event] ??= []).push({ matcher: g.matcher, hooks: g.hooks });
  }
  return out;
}

/** Permission rules from Claude user settings and the project files, split by trust. */
export function settingsPermissionRules(cwd: string, claudeCompat: boolean, trusted: boolean): { allow: string[]; deny: string[]; ask: string[]; ignoredAllow: string[] } {
  const out = { allow: [] as string[], deny: [] as string[], ask: [] as string[], ignoredAllow: [] as string[] };
  const add = (f: SettingsFile | undefined, allowOk: boolean) => {
    if (!f?.permissions) return;
    out.deny.push(...(f.permissions.deny ?? []));
    out.ask.push(...(f.permissions.ask ?? []));
    if (allowOk) out.allow.push(...(f.permissions.allow ?? []));
    else out.ignoredAllow.push(...(f.permissions.allow ?? []));
  };
  if (claudeCompat) add(claudeUserSettings(), true);
  for (const f of projectSettingsFiles(cwd, claudeCompat)) add(f, trusted);
  return out;
}
