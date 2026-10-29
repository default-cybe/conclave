import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ConfigStore } from '../config';
import { claudeHome } from '../config/paths';
import type { HooksConfig, McpServerConfig } from '../config/schema';
import type { AgentDef, CommandDef, ExtensionRegistry, ExtensionSource, InstalledPlugin, MarketplaceEntry, SkillDef } from './types';
import { toFrontmatter } from '../util/frontmatter';
import { builtinAgents } from './builtin-agents';
import { builtinSkills } from './builtin-skills';
import { defaultModelMapper, loadAgentsFromDir, loadCommandsFromDir, loadSkillsFromDir, parseMd, type LoadResult, type ModelMapper } from './loader';
import { PluginManager, type PluginInstallOptions } from './plugins';
import { loadCompatScopes, type CompatHomes } from './compat';
import type { McpManager } from './mcp';
import { loadLearnedSkills } from './learned';
import { refusalEntryText } from '../session/refusal-entries';

const CWD_NONE = '\u0000none';

export interface ExtensionsOptions {
  config: ConfigStore;
  mcp?: McpManager;
  /** Inject a PluginManager (tests pass one with defaultMarketplaces: []). */
  plugins?: PluginManager;
  defaultMarketplaces?: string[];
  /** Override where the Codex, OpenCode, Gemini and ~/.agents folders are (tests). */
  compatHomes?: CompatHomes;
}

export type ComponentKind = 'agent' | 'skill' | 'command';

/** One loaded component and where it came from, for the Extensions overview. */
export interface InventoryItem {
  kind: ComponentKind;
  name: string;
  description?: string;
  source: ExtensionSource;
  plugin?: string;
  path?: string;
  /** Scope label, e.g. "claude user", "opencode project /repo". */
  scope: string;
  /** True when this copy is the one in use. */
  active: boolean;
  /** For a shadowed copy: the scope of the copy that wins. */
  shadowedBy?: string;
  /** A skill an agent wrote (extensions/learned.ts). */
  learned?: boolean;
}

interface Loaded extends LoadResult {
  inventory: InventoryItem[];
}

/**
 * The registry the engine uses. Aggregates built-in, user, project, plugin and
 * Claude Code agents/skills/commands with a fixed precedence, and owns plugins,
 * marketplaces and the MCP server set contributed by plugins.
 *
 * Precedence (low to high): builtin < ~/.agents, Codex, OpenCode, Gemini (each
 * opt in, user then project) < claude < plugin < learned < user < project. Plugin
 * components are named "<plugin>:<name>" so they rarely collide.
 */
export class Extensions implements ExtensionRegistry {
  private config: ConfigStore;
  private mcp?: McpManager;
  private pluginMgr: PluginManager;
  private cache = new Map<string, Loaded>();
  private compatHomes?: CompatHomes;

  constructor(opts: ExtensionsOptions) {
    this.config = opts.config;
    this.mcp = opts.mcp;
    this.compatHomes = opts.compatHomes;
    this.pluginMgr =
      opts.plugins ??
      new PluginManager({ dir: this.config.paths.plugins, defaultMarketplaces: opts.defaultMarketplaces });
    this.syncMcp();
  }

  private mapper(): ModelMapper {
    const cfg = this.config.get();
    return defaultModelMapper(cfg.defaultModel, cfg.smallModel);
  }

  private syncMcp(): void {
    this.mcp?.setExtraServers(this.pluginMgr.pluginMcpServers());
  }

  async reload(cwd?: string): Promise<void> {
    this.pluginMgr.reload();
    this.cache.clear();
    this.syncMcp();
    if (cwd) this.load(cwd);
  }

  private load(cwd?: string): Loaded {
    const key = cwd ?? CWD_NONE;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const mapModel = this.mapper();
    const compat = this.config.get().compat;
    const paths = this.config.paths;

    const maps = { agent: new Map<string, InventoryItem>(), skill: new Map<string, InventoryItem>(), command: new Map<string, InventoryItem>() };
    const agents = new Map<string, AgentDef>();
    const skills = new Map<string, SkillDef>();
    const commands = new Map<string, CommandDef>();
    const inventory: InventoryItem[] = [];

    const track = (kind: ComponentKind, item: AgentDef | SkillDef | CommandDef, scope: string) => {
      const entry: InventoryItem = {
        kind,
        name: item.name,
        description: item.description,
        source: item.source,
        plugin: item.plugin,
        path: item.path,
        scope,
        active: true,
        ...('learned' in item && item.learned ? { learned: true } : {}),
      };
      const prev = maps[kind].get(item.name);
      if (prev) {
        prev.active = false;
        prev.shadowedBy = scope;
      }
      maps[kind].set(item.name, entry);
      inventory.push(entry);
    };
    const overlay = (res: LoadResult, scope: string) => {
      for (const a of res.agents) {
        agents.set(a.name, a);
        track('agent', a, scope);
      }
      for (const s of res.skills) {
        skills.set(s.name, s);
        track('skill', s, scope);
      }
      for (const c of res.commands) {
        commands.set(c.name, c);
        track('command', c, scope);
      }
    };

    // 1. builtin agents and skills
    overlay({ agents: builtinAgents(), skills: builtinSkills(), commands: [] }, 'builtin');

    // 2. other CLIs, opt in: ~/.agents, Codex, OpenCode, Gemini (user, then project)
    for (const scope of loadCompatScopes({ codex: compat.codex, opencode: compat.opencode, gemini: compat.gemini }, mapModel, cwd, this.compatHomes)) {
      overlay(scope, scope.label);
    }

    // 3. claude compat (user ~/.claude, then project <cwd>/.claude)
    if (compat.claudeCode) {
      overlay(this.scan(claudeHome(), 'claude', mapModel), 'claude user');
      if (cwd) overlay(this.scan(join(cwd, '.claude'), 'claude', mapModel), 'claude project');
    }

    // 4. plugins (names are "<plugin>:<name>")
    overlay(this.pluginMgr.loadComponents(mapModel), 'plugins');

    // 5. skills agents wrote (learned-skills/), under the owner's own so a hand-written skill wins
    overlay({ agents: [], skills: loadLearnedSkills(paths.home, cwd), commands: [] }, 'learned');

    // 6. user (.conclave)
    overlay(
      {
        agents: loadAgentsFromDir(paths.agents, 'user', mapModel),
        skills: loadSkillsFromDir(paths.skills, 'user'),
        commands: loadCommandsFromDir(paths.commands, 'user', mapModel),
      },
      'user',
    );

    // 7. project (<cwd>/.conclave)
    if (cwd) overlay(this.scan(join(cwd, '.conclave'), 'project', mapModel), 'project');

    const result: Loaded = { agents: [...agents.values()], skills: [...skills.values()], commands: [...commands.values()], inventory };
    this.cache.set(key, result);
    return result;
  }

  private scan(base: string, source: 'claude' | 'project' | 'user', mapModel: ModelMapper): LoadResult {
    return {
      agents: loadAgentsFromDir(join(base, 'agents'), source, mapModel),
      skills: loadSkillsFromDir(join(base, 'skills'), source),
      commands: loadCommandsFromDir(join(base, 'commands'), source, mapModel),
    };
  }

  /**
   * Every agent, skill and command found, including copies hidden by a
   * higher-precedence scope (active: false, shadowedBy set). Drives the
   * Sources view in the Extensions area.
   */
  inventory(cwd?: string): InventoryItem[] {
    return this.load(cwd).inventory;
  }

  /** Detail of one installed plugin with everything it contributes. */
  pluginDetail(name: string) {
    return this.pluginMgr.detail(name, this.mapper());
  }

  agents(cwd?: string): AgentDef[] {
    return this.load(cwd).agents;
  }

  agent(name: string, cwd?: string): AgentDef | undefined {
    return resolveName(this.load(cwd).agents, name);
  }

  skills(cwd?: string): SkillDef[] {
    return this.load(cwd).skills;
  }

  skill(name: string, cwd?: string): SkillDef | undefined {
    return resolveName(this.load(cwd).skills, name);
  }

  commands(cwd?: string): CommandDef[] {
    return this.load(cwd).commands;
  }

  /**
   * Resolve a typed slash command. Tries the exact name, a case-insensitive
   * match, a unique "<plugin>:<name>" match, then a skill of that name (Claude
   * Code lists skills as commands too).
   */
  command(name: string, cwd?: string): CommandDef | undefined {
    const loaded = this.load(cwd);
    const hit = resolveName(loaded.commands, name);
    if (hit) return hit;
    const skill = resolveName(loaded.skills, name);
    if (!skill) return undefined;
    let body = skill.body ?? '';
    if (skill.body === undefined) {
      try {
        body = parseMd(readFileSync(skill.path, 'utf8')).body.trim();
      } catch {
        return undefined;
      }
    }
    return {
      name: skill.name,
      description: skill.description,
      allowedTools: skill.allowedTools,
      body: skill.dir ? `Base directory for this skill: ${skill.dir}\n\n${body}` : body,
      source: skill.source,
      path: skill.path,
      plugin: skill.plugin,
    };
  }

  async saveAgent(def: AgentDef, scope: 'user' | 'project', cwd?: string): Promise<AgentDef> {
    const dir = scope === 'user' ? this.config.paths.agents : join(cwd ?? process.cwd(), '.conclave', 'agents');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${def.name}.md`);
    writeFileSync(path, toFrontmatter(agentFrontmatter(def), def.prompt));
    this.cache.clear();
    return { ...def, source: scope, path };
  }

  async deleteAgent(name: string): Promise<boolean> {
    // Only user/project files can be deleted; builtins have no file.
    let removed = false;
    for (const path of [join(this.config.paths.agents, `${name}.md`)]) {
      if (existsSync(path)) {
        rmSync(path);
        removed = true;
      }
    }
    if (removed) this.cache.clear();
    return removed;
  }

  // ----- plugins -----
  pluginHooks(): HooksConfig {
    return this.pluginMgr.pluginHooks();
  }

  pluginMcpServers(): Record<string, McpServerConfig> {
    return this.pluginMgr.pluginMcpServers();
  }

  plugins(): InstalledPlugin[] {
    return this.pluginMgr.plugins();
  }

  async installPlugin(source: string): Promise<InstalledPlugin> {
    const p = await this.pluginMgr.installPlugin(source);
    this.cache.clear();
    this.syncMcp();
    return p;
  }

  async removePlugin(name: string): Promise<boolean> {
    const ok = await this.pluginMgr.removePlugin(name);
    this.cache.clear();
    this.syncMcp();
    return ok;
  }

  async setPluginEnabled(name: string, enabled: boolean): Promise<void> {
    await this.pluginMgr.setPluginEnabled(name, enabled);
    this.cache.clear();
    this.syncMcp();
  }

  async marketplaces(): Promise<MarketplaceEntry[]> {
    return this.pluginMgr.marketplaces();
  }

  async addMarketplace(source: string): Promise<void> {
    await this.pluginMgr.addMarketplace(source);
  }

  async installPluginFrom(dir: string, opts: PluginInstallOptions): Promise<InstalledPlugin> {
    const p = await this.pluginMgr.installFromDir(dir, opts);
    this.cache.clear();
    this.syncMcp();
    return p;
  }

  async setPluginHooks(name: string, on: boolean): Promise<void> {
    await this.pluginMgr.setPluginHooks(name, on);
    this.cache.clear();
  }

  marketplaceSources(): Array<{ name: string; source: string; dir: string }> {
    return this.pluginMgr.marketplaceSources();
  }

  async removeMarketplace(name: string): Promise<boolean> {
    return this.pluginMgr.removeMarketplace(name);
  }
}

/**
 * Find a component by name: exact, then case-insensitive, then the single
 * "<plugin>:<name>" whose last part matches. Ambiguous bare names return
 * undefined so the caller asks for the full name.
 */
export function resolveName<T extends { name: string }>(list: T[], name: string): T | undefined {
  const exact = list.find((x) => x.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const ci = list.filter((x) => x.name.toLowerCase() === lower);
  if (ci.length === 1) return ci[0];
  if (name.includes(':')) return undefined;
  const suffix = list.filter((x) => {
    const i = x.name.lastIndexOf(':');
    return i > 0 && x.name.slice(i + 1).toLowerCase() === lower;
  });
  return suffix.length === 1 ? suffix[0] : undefined;
}

function agentFrontmatter(def: AgentDef): Record<string, unknown> {
  return {
    name: def.name,
    description: def.description,
    tools: def.tools,
    disallowedTools: def.disallowedTools,
    optInTools: def.optInTools,
    model: def.model,
    color: def.color,
    icon: def.icon,
    mode: def.mode,
    permissionMode: def.permissionMode,
    skills: def.skills,
    mcpServers: def.mcpServers,
    memory: def.memory,
    subagent: def.subagent,
    primary: def.primary,
    untrusted: def.untrusted,
    device: def.device,
    temperature: def.temperature,
    thinking: def.thinking,
    maxSteps: def.maxSteps,
    // specialist fields (extensions/agent-hooks.ts, session/verify-gate.ts): a saved copy keeps them
    hooks: def.hooks,
    recipes: def.recipes,
    ultra: def.ultra,
    verifyCommand: def.verifyCommand,
    refusalFallback: def.refusalFallback === false ? 'off' : def.refusalFallback?.map(refusalEntryText),
    // only the off switch is written: on is the default
    platformCard: def.platformCard === false ? false : undefined,
  };
}
