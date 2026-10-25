import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, statSync, readdirSync, lstatSync } from 'node:fs';
import { join, basename, isAbsolute, resolve as resolvePath, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { copyRepoTree } from '../util/copy-tree';
import { gitRunner, type GitRun } from '../catalog/git';
import type { HooksConfig, McpServerConfig } from '../config/schema';
import type { AgentDef, CommandDef, InstalledPlugin, MarketplaceEntry, PluginInstallOptions, PluginManifest, RuntimeHookCommand, SkillDef } from './types';
export type { PluginInstallOptions } from './types';
import { parseJsonc } from '../config';
import { loadAgentsFromDir, loadCommandsFromDir, loadSkillFolder, loadSkillsFromDir, type ModelMapper } from './loader';
import { logger } from '../util/log';
import { shellQuote } from '../tools/util';

const log = logger('plugins');

interface PluginState {
  dir: string;
  source: string;
  enabled: boolean;
  installedAt: number;
  /** Commit the files came from, when installed from git. */
  sha?: string;
  /** version from the manifest at install. */
  version?: string;
  /** Hash of the manifest, hooks, .mcp.json and scripts, so an update can say what changed. */
  filesHash?: string;
  /** false: keep the plugin's skills, agents and commands but drop its hooks. */
  hooks?: boolean;
  /** Manifest from a strict:false marketplace entry; replaces the plugin's own plugin.json. */
  manifest?: PluginManifest;
  /** Set when installing the plugin's npm dependencies failed: the command to run by hand. */
  depsCommand?: string;
}

/** Files whose change makes an update need review: manifests, hooks, MCP config, scripts and package files. */
export function isSensitivePath(rel: string): boolean {
  return (
    /(^|\/)(plugin|marketplace)\.json$/.test(rel) ||
    /(^|\/)hooks\//.test(rel) ||
    /(^|\/)\.mcp\.json$/.test(rel) ||
    /(^|\/)(scripts|bin)\//.test(rel) ||
    /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod)$/.test(rel) ||
    /\.(sh|bash|zsh|ps1|cmd|bat)$/.test(rel)
  );
}

/** sha256 over the sensitive files of a folder (paths and contents), skipping .git. */
export function sensitiveHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === '.git' || name === 'node_modules') continue;
      const abs = join(d, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) {
        const rel = relative(dir, abs);
        if (!isSensitivePath(rel)) continue;
        h.update(rel).update('\0').update(readFileSync(abs)).update('\0');
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

interface MarketplaceState {
  source: string;
  dir: string;
}

interface StateFile {
  plugins: Record<string, PluginState>;
  marketplaces: Record<string, MarketplaceState>;
}

type Spawn = typeof Bun.spawn;

export interface PluginManagerOptions {
  /** Root where plugins are installed (paths().plugins). */
  dir: string;
  /** Process spawner, overridable in tests. */
  spawn?: Spawn;
  /** Default marketplaces fetched lazily by marketplaces(). Pass [] in tests. */
  defaultMarketplaces?: string[];
}

const DEFAULT_MARKETPLACES = ['anthropics/claude-plugins-official'];

/**
 * Name a plugin component the way Claude Code and Codex do: "<plugin>:<name>".
 * Two plugins often ship a command called "help" or an agent called
 * "code-reviewer"; the prefix keeps them apart. The registry still resolves a
 * bare name when only one component has it.
 */
export function pluginComponentName(plugin: string, name: string): string {
  return name.startsWith(`${plugin}:`) ? name : `${plugin}:${name}`;
}

/** MCP server key for a plugin server. Tools become mcp__plugin_<plugin>_<server>__<tool>, as in Claude Code. */
export function pluginMcpKey(plugin: string, server: string): string {
  return `plugin_${plugin}_${server}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

export class PluginManager {
  private root: string;
  private marketplacesDir: string;
  private statePath: string;
  private gitRun: GitRun;
  private spawn: Spawn;
  private defaults: string[];
  private state: StateFile;
  private manifests = new Map<string, PluginManifest>();

  constructor(opts: PluginManagerOptions) {
    this.root = opts.dir;
    this.marketplacesDir = join(this.root, '.marketplaces');
    this.statePath = join(this.root, 'state.json');
    // the catalog's git: no repo hooks, filters, LFS downloads or command transports, and a time limit
    this.spawn = opts.spawn ?? Bun.spawn;
    this.gitRun = gitRunner(this.spawn);
    this.defaults = opts.defaultMarketplaces ?? DEFAULT_MARKETPLACES;
    mkdirSync(this.root, { recursive: true });
    this.state = this.readState();
    this.refreshManifests();
  }

  private readState(): StateFile {
    if (!existsSync(this.statePath)) return { plugins: {}, marketplaces: {} };
    try {
      const s = parseJsonc<Partial<StateFile>>(readFileSync(this.statePath, 'utf8'));
      return { plugins: s.plugins ?? {}, marketplaces: s.marketplaces ?? {} };
    } catch {
      return { plugins: {}, marketplaces: {} };
    }
  }

  private writeState(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + '\n');
  }

  private refreshManifests(): void {
    this.manifests.clear();
    for (const [name, st] of Object.entries(this.state.plugins)) {
      if (!existsSync(st.dir)) continue;
      this.manifests.set(name, st.manifest ? { ...st.manifest, name } : readManifest(st.dir, name));
    }
  }

  reload(): void {
    this.state = this.readState();
    this.refreshManifests();
  }

  plugins(): InstalledPlugin[] {
    const out: InstalledPlugin[] = [];
    for (const [name, st] of Object.entries(this.state.plugins)) {
      const manifest = this.manifests.get(name) ?? readManifest(st.dir, name);
      out.push({ name, dir: st.dir, manifest, enabled: st.enabled, source: st.source, installedAt: st.installedAt, ...this.extraOf(st) });
    }
    return out;
  }

  private extraOf(st: PluginState): Pick<InstalledPlugin, 'sha' | 'version' | 'hooksEnabled' | 'depsCommand'> {
    return { ...(st.sha ? { sha: st.sha } : {}), ...(st.version ? { version: st.version } : {}), hooksEnabled: st.hooks !== false, ...(st.depsCommand ? { depsCommand: st.depsCommand } : {}) };
  }

  private enabledPlugins(): Array<{ name: string; dir: string; manifest: PluginManifest }> {
    return Object.entries(this.state.plugins)
      .filter(([, st]) => st.enabled && existsSync(st.dir))
      .map(([name, st]) => ({ name, dir: st.dir, manifest: this.manifests.get(name) ?? readManifest(st.dir, name) }));
  }

  // -------------------------------------------------------------------------
  // Component loading for enabled plugins
  // -------------------------------------------------------------------------

  loadComponents(mapModel: ModelMapper): { agents: AgentDef[]; skills: SkillDef[]; commands: CommandDef[] } {
    const agents: AgentDef[] = [];
    const skills: SkillDef[] = [];
    const commands: CommandDef[] = [];
    for (const p of this.enabledPlugins()) {
      const c = this.componentsOf(p, mapModel);
      agents.push(...c.agents);
      skills.push(...c.skills);
      commands.push(...c.commands);
    }
    return { agents, skills, commands };
  }

  /** Everything one plugin contributes, enabled or not. Names are namespaced "<plugin>:<name>". */
  componentsOf(
    p: { name: string; dir: string; manifest: PluginManifest },
    mapModel: ModelMapper,
  ): { agents: AgentDef[]; skills: SkillDef[]; commands: CommandDef[] } {
    const rename = <T extends { name: string }>(list: T[]): T[] => list.map((x) => ({ ...x, name: pluginComponentName(p.name, x.name) }));
    return {
      agents: rename(this.pluginAgents(p, mapModel)),
      skills: rename(this.pluginSkills(p)),
      commands: rename(this.pluginCommands(p, mapModel)),
    };
  }

  /** Full detail of one installed plugin: manifest plus every component, hook and MCP server it adds. */
  detail(name: string, mapModel: ModelMapper):
    | (InstalledPlugin & { agents: AgentDef[]; skills: SkillDef[]; commands: CommandDef[]; hooks: HooksConfig; mcpServers: Record<string, McpServerConfig> })
    | undefined {
    const st = this.state.plugins[name];
    if (!st) return undefined;
    const manifest = this.manifests.get(name) ?? readManifest(st.dir, name);
    const p = { name, dir: st.dir, manifest };
    const hooks: HooksConfig = {};
    for (const h of this.pluginHookConfigs(p)) {
      for (const [event, list] of Object.entries(h)) {
        const key = event as keyof HooksConfig;
        hooks[key] = [...(hooks[key] ?? []), ...(list ?? [])];
      }
    }
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const [server, cfg] of Object.entries(this.pluginMcp(p))) mcpServers[pluginMcpKey(name, server)] = cfg;
    return { name, dir: st.dir, manifest, enabled: st.enabled, source: st.source, installedAt: st.installedAt, ...this.extraOf(st), ...this.componentsOf(p, mapModel), hooks, mcpServers };
  }

  /** Folder for a plugin's persistent data (CLAUDE_PLUGIN_DATA). Survives updates; removed with the plugin. */
  dataDir(name: string): string {
    return join(this.root, '.data', name);
  }

  private pluginAgents(p: { name: string; dir: string; manifest: PluginManifest }, mapModel: ModelMapper): AgentDef[] {
    const paths = manifestPaths(p.manifest.agents);
    if (!paths) return loadAgentsFromDir(join(p.dir, 'agents'), 'plugin', mapModel, p.name);
    const out: AgentDef[] = [];
    for (const rel of paths) {
      const abs = join(p.dir, rel);
      if (!existsSync(abs)) continue;
      if (isDir(abs)) out.push(...loadAgentsFromDir(abs, 'plugin', mapModel, p.name));
      else out.push(...loadAgentsFromDir(abs.replace(/[^/]+$/, ''), 'plugin', mapModel, p.name).filter((a) => a.path === abs));
    }
    return out;
  }

  private pluginSkills(p: { name: string; dir: string; manifest: PluginManifest }): SkillDef[] {
    const out: SkillDef[] = [];
    // Default skills/ always scanned.
    out.push(...loadSkillsFromDir(join(p.dir, 'skills'), 'plugin', p.name));
    // A plugin that is a single skill: SKILL.md at root, no skills/ dir.
    if (!existsSync(join(p.dir, 'skills')) && existsSync(join(p.dir, 'SKILL.md'))) {
      const single = loadSkillFolder(p.dir, 'plugin', p.name);
      if (single) out.push(single);
    }
    for (const rel of manifestPaths(p.manifest.skills) ?? []) {
      const abs = rel === '.' || rel === './' ? p.dir : join(p.dir, rel);
      if (!existsSync(abs)) continue;
      if (existsSync(join(abs, 'SKILL.md'))) {
        const single = loadSkillFolder(abs, 'plugin', p.name);
        if (single) out.push(single);
      } else {
        out.push(...loadSkillsFromDir(abs, 'plugin', p.name));
      }
    }
    // De-dupe by name (default dir then manifest extras).
    const map = new Map<string, SkillDef>();
    for (const s of out) map.set(s.name, s);
    return [...map.values()];
  }

  private pluginCommands(p: { name: string; dir: string; manifest: PluginManifest }, mapModel: ModelMapper): CommandDef[] {
    const paths = manifestPaths(p.manifest.commands);
    if (!paths) return loadCommandsFromDir(join(p.dir, 'commands'), 'plugin', mapModel, p.name);
    const out: CommandDef[] = [];
    for (const rel of paths) {
      const abs = join(p.dir, rel);
      if (!existsSync(abs)) continue;
      if (isDir(abs)) out.push(...loadCommandsFromDir(abs, 'plugin', mapModel, p.name));
      else out.push(...loadCommandsFromDir(abs.replace(/[^/]+$/, ''), 'plugin', mapModel, p.name).filter((c) => c.path === abs));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Hooks and MCP servers contributed by plugins
  // -------------------------------------------------------------------------

  pluginHooks(): HooksConfig {
    const merged: HooksConfig = {};
    for (const p of this.enabledPlugins()) {
      if (this.state.plugins[p.name]?.hooks === false) continue;
      for (const hooks of this.pluginHookConfigs(p)) {
        for (const [event, list] of Object.entries(hooks)) {
          const key = event as keyof HooksConfig;
          merged[key] = [...(merged[key] ?? []), ...(list ?? [])];
        }
      }
    }
    return merged;
  }

  private pluginHookConfigs(p: { name: string; dir: string; manifest: PluginManifest }): HooksConfig[] {
    const out: HooksConfig[] = [];
    const data = this.dataDir(p.name);
    const seen = new Set<string>();
    const fromFile = (abs: string) => {
      const key = resolvePath(abs);
      if (seen.has(key)) return;
      seen.add(key);
      const parsed = readJson<{ hooks?: HooksConfig }>(abs);
      if (parsed?.hooks) out.push(annotateHooks(expandRoot(parsed.hooks, p.dir, data), p.name, p.dir, data));
    };
    const file = join(p.dir, 'hooks', 'hooks.json');
    if (existsSync(file)) fromFile(file);
    for (const h of asArray(p.manifest.hooks)) {
      if (typeof h === 'string') fromFile(join(p.dir, h));
      else if (h && typeof h === 'object') {
        // Inline hooks: either {Event: [...]} or wrapped as {hooks: {Event: [...]}}.
        const o = h as Record<string, unknown>;
        const inner = (o.hooks && typeof o.hooks === 'object' && !Array.isArray(o.hooks) ? o.hooks : o) as HooksConfig;
        out.push(annotateHooks(expandRoot(inner, p.dir, data), p.name, p.dir, data));
      }
    }
    return out;
  }

  pluginMcpServers(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};
    for (const p of this.enabledPlugins()) {
      for (const [name, cfg] of Object.entries(this.pluginMcp(p))) {
        merged[pluginMcpKey(p.name, name)] = cfg;
      }
    }
    return merged;
  }

  private pluginMcp(p: { name: string; dir: string; manifest: PluginManifest }): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    const data = this.dataDir(p.name);
    const dotMcp = join(p.dir, '.mcp.json');
    if (existsSync(dotMcp)) {
      const parsed = readJson<Record<string, unknown>>(dotMcp);
      Object.assign(out, normalizeMcp(parsed, p.dir, p.name, data));
    }
    const manifestMcp = p.manifest.mcpServers;
    for (const m of asArray(manifestMcp)) {
      if (typeof m === 'string') {
        const abs = join(p.dir, m);
        if (resolvePath(abs) === resolvePath(dotMcp)) continue;
        Object.assign(out, normalizeMcp(readJson<Record<string, unknown>>(abs), p.dir, p.name, data));
      } else if (m && typeof m === 'object') {
        Object.assign(out, normalizeMcp(m as Record<string, unknown>, p.dir, p.name, data));
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Install / remove / enable
  // -------------------------------------------------------------------------

  async installPlugin(source: string, opts: Omit<PluginInstallOptions, 'source'> = {}): Promise<InstalledPlugin> {
    const tmp = join(this.root, `.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    let fetched: Fetched;
    try {
      fetched = await this.fetchSource(source, tmp);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    try {
      return await this.installFromDir(fetched.root, {
        ...opts,
        source,
        sha: opts.sha ?? fetched.sha,
        manifest: opts.manifest ?? fetched.manifest,
        name: opts.name ?? fetched.manifest?.name,
        copyRoot: fetched.repoRoot ?? fetched.root,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Install from a folder that is already on disk (a staged, previewed copy).
   * Copies it without .git, records the source, commit and a hash of the
   * hooks, MCP config and scripts. Reinstalling keeps the hooks switch.
   * Then installs its npm dependencies; a failure keeps the plugin and records
   * the command to run by hand.
   */
  async installFromDir(dir: string, opts: PluginInstallOptions): Promise<InstalledPlugin> {
    if (!existsSync(dir)) throw new Error(`plugin folder not found: ${dir}`);
    const own = readManifest(dir, basename(dir));
    const manifest = opts.manifest ? { ...opts.manifest, name: opts.manifest.name || own.name } : own;
    const name = opts.name || manifest.name || basename(dir);
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new Error(`bad plugin name: ${name}`);
    const dest = join(this.root, name);
    const prev = this.state.plugins[name];
    rmSync(dest, { recursive: true, force: true });
    copyRepoTree(dir, dest, opts.copyRoot ?? dir);
    const st: PluginState = {
      dir: dest,
      source: opts.source,
      enabled: opts.enabled ?? prev?.enabled ?? true,
      installedAt: Date.now(),
      sha: opts.sha,
      version: manifest.version,
      filesHash: sensitiveHash(dest),
    };
    const hooks = opts.hooks ?? prev?.hooks;
    if (hooks === false) st.hooks = false;
    if (opts.manifest) st.manifest = { ...manifest, name };
    this.state.plugins[name] = st;
    this.writeState();
    this.manifests.set(name, opts.manifest ? { ...manifest, name } : readManifest(dest, name));
    const depsCommand = await this.installDeps(dest);
    if (depsCommand) {
      st.depsCommand = depsCommand;
      this.writeState();
    }
    log.info(`installed plugin ${name} from ${opts.source}${opts.sha ? ` at ${opts.sha.slice(0, 7)}` : ''}`);
    return { name, dir: dest, manifest: this.manifests.get(name)!, enabled: st.enabled, source: opts.source, installedAt: st.installedAt, ...this.extraOf(st) };
  }

  /**
   * npm dependencies of a plugin whose package.json lists some and that ships
   * no node_modules (an update recopies the folder, so a changed lockfile
   * always installs again). Lifecycle scripts never run. Returns the command
   * to run by hand when the install fails.
   */
  private async installDeps(dir: string): Promise<string | undefined> {
    const pkg = readJson<{ dependencies?: Record<string, string> }>(join(dir, 'package.json'));
    if (!pkg?.dependencies || !Object.keys(pkg.dependencies).length || existsSync(join(dir, 'node_modules'))) return undefined;
    // bun install --production refuses a migrated package-lock ("lockfile is frozen"), so npm does it;
    // --git=git: a plugin's .npmrc could name another git binary, and the command line wins over it
    const argv = ['npm', existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--omit=dev', '--ignore-scripts', '--git=git'];
    const command = `cd ${shellQuote(dir)} && ${argv.join(' ')}`;
    try {
      const proc = this.spawn(argv, { cwd: dir, env: process.env as Record<string, string>, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
      const timer = setTimeout(() => proc.kill(), 120_000);
      try {
        const [, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
        if (code === 0) return undefined;
        log.warn(`npm dependencies of ${dir} failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}. Run: ${command}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      log.warn(`npm dependencies of ${dir} failed: ${(err as Error).message}. Run: ${command}`);
    }
    return command;
  }

  async removePlugin(name: string): Promise<boolean> {
    const st = this.state.plugins[name];
    if (!st) return false;
    rmSync(st.dir, { recursive: true, force: true });
    rmSync(this.dataDir(name), { recursive: true, force: true });
    delete this.state.plugins[name];
    this.manifests.delete(name);
    this.writeState();
    return true;
  }

  async setPluginEnabled(name: string, enabled: boolean): Promise<void> {
    const st = this.state.plugins[name];
    if (!st) throw new Error(`unknown plugin: ${name}`);
    st.enabled = enabled;
    this.writeState();
  }

  /** Turn a plugin's hooks on or off without touching its skills, agents and commands. */
  async setPluginHooks(name: string, on: boolean): Promise<void> {
    const st = this.state.plugins[name];
    if (!st) throw new Error(`unknown plugin: ${name}`);
    if (on) delete st.hooks;
    else st.hooks = false;
    this.writeState();
  }

  /** Marketplaces added so far: name, source and folder. */
  marketplaceSources(): Array<{ name: string; source: string; dir: string }> {
    return Object.entries(this.state.marketplaces).map(([name, m]) => ({ name, source: m.source, dir: m.dir }));
  }

  // -------------------------------------------------------------------------
  // Marketplaces
  // -------------------------------------------------------------------------

  async addMarketplace(source: string): Promise<void> {
    const { dir, manifest } = await this.fetchMarketplace(source);
    const name = (manifest.name as string) || basename(dir);
    this.state.marketplaces[name] = { source, dir };
    this.writeState();
  }

  /** Forget a marketplace and delete its clone. Plugins installed from it keep their own copies. Default marketplaces stay. */
  removeMarketplace(name: string): boolean {
    const m = this.state.marketplaces[name];
    if (!m || this.defaults.includes(m.source)) return false;
    // only clones Conclave made; a local marketplace folder belongs to the owner
    if (m.dir && within(this.marketplacesDir, m.dir) && resolvePath(m.dir) !== resolvePath(this.marketplacesDir)) rmSync(m.dir, { recursive: true, force: true });
    delete this.state.marketplaces[name];
    this.writeState();
    return true;
  }

  async marketplaces(): Promise<MarketplaceEntry[]> {
    // Ensure default marketplaces are fetched (lazy, best effort).
    for (const src of this.defaults) {
      const already = Object.values(this.state.marketplaces).some((m) => m.source === src);
      if (!already) {
        try {
          await this.addMarketplace(src);
        } catch (err) {
          log.warn(`could not fetch default marketplace ${src}: ${(err as Error).message}`);
        }
      }
    }
    const out: MarketplaceEntry[] = [];
    for (const [mkName, st] of Object.entries(this.state.marketplaces)) {
      const manifest = this.readMarketplaceManifest(st.dir);
      if (!manifest) continue;
      for (const entry of (manifest.plugins as Array<Record<string, unknown>>) ?? []) {
        out.push({
          name: String(entry.name),
          description: entry.description ? String(entry.description) : undefined,
          source: entry.source as MarketplaceEntry['source'],
          version: entry.version ? String(entry.version) : undefined,
          category: entry.category ? String(entry.category) : undefined,
          marketplace: mkName,
        });
      }
    }
    return out;
  }

  private readMarketplaceManifest(dir: string): Record<string, unknown> | undefined {
    for (const f of [join(dir, '.claude-plugin', 'marketplace.json'), join(dir, 'marketplace.json')]) {
      if (existsSync(f)) return readJson<Record<string, unknown>>(f);
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Source fetching
  // -------------------------------------------------------------------------

  /** Fetch a plugin source into `tmp`: the plugin root, the commit, and a strict:false manifest when there is one. */
  private async fetchSource(source: string, tmp: string): Promise<Fetched> {
    // name@marketplace (a plugin name never has a slash, so owner/repo@ref is not one)
    const atMatch = /^([^@/\s]+)@([A-Za-z0-9._-]+)$/.exec(source);
    if (atMatch && !source.startsWith('git@')) {
      return this.fetchFromMarketplace(atMatch[1], atMatch[2], tmp);
    }

    const parsed = parsePluginSource(source);
    if (parsed.kind === 'local') {
      if (!existsSync(parsed.path)) throw new Error(`local plugin path not found: ${parsed.path}`);
      return { root: parsed.path };
    }
    // git
    const sha = await this.gitClone(parsed.url, tmp, parsed.ref);
    return { root: parsed.subdir ? join(tmp, parsed.subdir) : tmp, sha, repoRoot: tmp };
  }

  private async fetchFromMarketplace(pluginName: string, marketplaceName: string, tmp: string): Promise<Fetched> {
    const mk = this.state.marketplaces[marketplaceName];
    if (!mk) throw new Error(`marketplace not added: ${marketplaceName}`);
    const manifest = this.readMarketplaceManifest(mk.dir);
    const entry = ((manifest?.plugins as Array<Record<string, unknown>>) ?? []).find((e) => e.name === pluginName);
    if (!entry) throw new Error(`plugin ${pluginName} not found in marketplace ${marketplaceName}`);
    const pluginRoot = ((manifest?.metadata as Record<string, unknown>)?.pluginRoot as string) || '';
    const got = await this.fetchMarketplaceEntrySource(entry.source, mk.dir, pluginRoot, tmp);
    const strictOff = entry.strict === false;
    return { ...got, manifest: strictOff ? entryManifest(entry) : undefined };
  }

  private async fetchMarketplaceEntrySource(src: unknown, marketplaceDir: string, pluginRoot: string, tmp: string): Promise<Fetched> {
    if (typeof src === 'string') {
      // Relative path inside the marketplace, or a bare name under pluginRoot.
      const rel = src === '.' || src === './' ? '' : src.replace(/^\.\//, '');
      const underRoot = rel.includes('/') || !pluginRoot ? rel : join(pluginRoot.replace(/^\.\//, ''), rel);
      const abs = join(marketplaceDir, underRoot);
      if (!within(marketplaceDir, abs)) throw new Error(`marketplace plugin path ${src} points outside the marketplace`);
      if (!existsSync(abs)) throw new Error(`marketplace plugin path not found: ${abs}`);
      const sha = await this.headOf(marketplaceDir);
      return { root: abs, sha, repoRoot: marketplaceDir };
    }
    const o = src as Record<string, unknown>;
    const kind = String(o.source);
    const sub = (dir: string) => {
      const out = typeof o.path === 'string' && o.path ? join(dir, o.path.replace(/^\.\//, '')) : dir;
      if (!within(dir, out)) throw new Error(`marketplace plugin path ${String(o.path)} points outside the repo`);
      return out;
    };
    // a pinned sha wins over a ref, and is fetched exactly
    const pin = isSha(o.sha) ? (o.sha as string) : (o.ref as string | undefined);
    if (kind === 'github') {
      const sha = await this.gitClone(`https://github.com/${o.repo}.git`, tmp, pin);
      return { root: sub(tmp), sha, repoRoot: tmp };
    }
    if (kind === 'url' || kind === 'git') {
      const sha = await this.gitClone(String(o.url), tmp, pin);
      return { root: sub(tmp), sha, repoRoot: tmp };
    }
    if (kind === 'git-subdir') {
      const url = String(o.url).includes('://') || String(o.url).startsWith('git@') ? String(o.url) : `https://github.com/${o.url}.git`;
      const sha = await this.gitClone(url, tmp, pin);
      const root = join(tmp, String(o.path));
      if (!within(tmp, root)) throw new Error(`marketplace plugin path ${String(o.path)} points outside the repo`);
      return { root, sha, repoRoot: tmp };
    }
    throw new Error(`unsupported marketplace plugin source: ${kind}`);
  }

  private async fetchMarketplace(source: string): Promise<{ dir: string; manifest: Record<string, unknown> }> {
    mkdirSync(this.marketplacesDir, { recursive: true });
    const parsed = parsePluginSource(source);
    let dir: string;
    if (parsed.kind === 'local') {
      if (!existsSync(parsed.path)) throw new Error(`local marketplace path not found: ${parsed.path}`);
      dir = parsed.path;
    } else {
      const slug = source.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `mk-${Date.now().toString(36)}`;
      dir = join(this.marketplacesDir, slug);
      rmSync(dir, { recursive: true, force: true });
      await this.gitClone(parsed.url, dir, parsed.ref);
      if (parsed.subdir) dir = join(dir, parsed.subdir);
    }
    const manifest = this.readMarketplaceManifest(dir);
    if (!manifest) throw new Error(`no marketplace.json found at ${dir}`);
    return { dir, manifest };
  }

  private git(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.gitRun(args, { cwd, timeoutMs: 300_000 });
  }

  private async headOf(dir: string): Promise<string | undefined> {
    const r = await this.git(['rev-parse', 'HEAD'], dir).catch(() => undefined);
    const sha = r?.code === 0 ? r.stdout.trim() : '';
    return isSha(sha) ? sha : undefined;
  }

  /**
   * Clone `url` into `dest` and return the commit. A full 40-char sha is
   * fetched exactly (init, fetch --depth 1 <sha>, checkout FETCH_HEAD); a tag
   * or branch goes to --branch. Either fails loudly: there is no silent
   * fallback to the default branch.
   */
  private async gitClone(url: string, dest: string, ref?: string): Promise<string | undefined> {
    rmSync(dest, { recursive: true, force: true });
    if (isSha(ref)) {
      mkdirSync(dest, { recursive: true });
      for (const args of [['init', '-q'], ['remote', 'add', '--', 'origin', url], ['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', ref], ['checkout', '-q', 'FETCH_HEAD']]) {
        const r = await this.git(args, dest);
        if (r.code !== 0) throw new Error(`git ${args[0]} of ${url} at ${ref.slice(0, 7)} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      }
      const head = await this.headOf(dest);
      if (head !== ref) throw new Error(`fetched ${head?.slice(0, 7) ?? 'nothing'} from ${url}, wanted ${ref.slice(0, 7)}`);
      return head;
    }
    const args = ['clone', '-q', '--depth', '1', '--filter=blob:none'];
    if (ref) args.push('--branch', ref);
    // a URL from someone's marketplace.json is never read as an option
    args.push('--', url, dest);
    const r = await this.git(args);
    if (r.code !== 0) throw new Error(`git clone of ${url}${ref ? ` at ${ref}` : ''} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return this.headOf(dest);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** p is root or below it (no ".." escape). Paths in a marketplace.json are someone else's input. */
function within(root: string, p: string): boolean {
  const r = relative(resolvePath(root), resolvePath(p));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

interface ParsedSource {
  kind: 'git' | 'local';
  url: string;
  subdir?: string;
  ref?: string;
  path: string;
}

/** Parse an install source string into a git or local descriptor. */
export function parsePluginSource(source: string): ParsedSource {
  const s = source.trim();
  const expandHome = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
  const splitHash = (v: string) => {
    const i = v.indexOf('#');
    return i >= 0 ? { url: v.slice(0, i), subdir: v.slice(i + 1) } : { url: v, subdir: undefined };
  };

  // Explicit git: a remote protocol, or any path/url that ends in .git (a repo).
  const beforeHash = s.split('#')[0];
  if (s.startsWith('git@') || s.startsWith('ssh://') || s.startsWith('http://') || s.startsWith('https://') || beforeHash.endsWith('.git')) {
    const { url, subdir } = splitHash(s);
    return { kind: 'git', url, subdir, path: '' };
  }

  // Local path: absolute, ./, ../, ~, or file://.
  if (isAbsolute(s) || s.startsWith('./') || s.startsWith('../') || s.startsWith('~') || s.startsWith('file://')) {
    const path = expandHome(s.replace(/^file:\/\//, ''));
    return { kind: 'local', url: path, path: resolvePath(path) };
  }

  // github: prefix or bare owner/repo[@sha or tag][#subdir].
  let body = s;
  if (body.startsWith('github:')) body = body.slice('github:'.length);
  const { url: repoRef, subdir } = splitHash(body);
  const m = /^([\w.-]+\/[\w.-]+?)(?:@([\w./-]+))?$/.exec(repoRef);
  if (m) {
    return { kind: 'git', url: `https://github.com/${m[1]}.git`, subdir, ref: m[2], path: '' };
  }

  // Bare existing local dir.
  if (existsSync(expandHome(s))) return { kind: 'local', url: expandHome(s), path: resolvePath(expandHome(s)) };

  // Fallback: treat as a git url.
  const { url, subdir: sub } = splitHash(s);
  return { kind: 'git', url, subdir: sub, path: '' };
}

interface Fetched {
  root: string;
  /** The clone or marketplace folder the root sits in, for resolving symlinks. */
  repoRoot?: string;
  sha?: string;
  /** Manifest from a strict:false marketplace entry. */
  manifest?: PluginManifest;
}

function isSha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
}

/** The manifest a strict:false marketplace entry stands for: its name, components and hooks. */
export function entryManifest(entry: Record<string, unknown>): PluginManifest {
  const m: PluginManifest = { name: String(entry.name) };
  for (const k of ['version', 'description', 'homepage', 'license', 'author', 'keywords', 'skills', 'agents', 'commands', 'hooks', 'mcpServers'] as const) {
    if (entry[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = entry[k];
  }
  return m;
}

/** Manifest search order. Claude's location first, then the Open Plugins root file, then Codex's. */
function readManifest(dir: string, fallbackName: string): PluginManifest {
  for (const f of [join(dir, '.claude-plugin', 'plugin.json'), join(dir, 'plugin.json'), join(dir, '.codex-plugin', 'plugin.json')]) {
    if (existsSync(f)) {
      const m = readJson<PluginManifest>(f);
      if (m) return { ...m, name: m.name || fallbackName };
    }
  }
  return { name: fallbackName };
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parseJsonc<T>(readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(`invalid json in ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Normalize manifest component path fields to a string array, or undefined to mean "use default". */
function manifestPaths(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return [v.replace(/^\.\//, '')];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').map((x) => (x as string).replace(/^\.\//, ''));
  // Object map (commands) or other shapes are not expanded here.
  return undefined;
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Recursively replace plugin variables in strings: ${CLAUDE_PLUGIN_ROOT},
 * ${CONCLAVE_PLUGIN_ROOT} and ${PLUGIN_ROOT} with the plugin folder, and
 * ${CLAUDE_PLUGIN_DATA} / ${PLUGIN_DATA} with its data folder when given.
 */
export function expandRoot<T>(value: T, root: string, data?: string): T {
  if (typeof value === 'string') {
    let s = value.replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|CONCLAVE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, root);
    if (data) s = s.replace(/\$\{(?:CLAUDE_PLUGIN_DATA|PLUGIN_DATA)\}/g, data);
    return s as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => expandRoot(v, root, data)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandRoot(v, root, data);
    return out as T;
  }
  return value;
}

/** Tag every handler with its plugin so the runner can export CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA. */
function annotateHooks(hooks: HooksConfig, plugin: string, root: string, data: string): HooksConfig {
  const out: HooksConfig = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    out[event as keyof HooksConfig] = groups.map((g) => ({
      ...g,
      hooks: (Array.isArray(g?.hooks) ? g.hooks : []).map((h) => ({ ...h, plugin, pluginRoot: root, pluginData: data }) as RuntimeHookCommand),
    }));
  }
  return out;
}

/**
 * Translate Claude-style variables in MCP config strings into Conclave's
 * placeholders: ${VAR} becomes ${env:VAR}, ${VAR:-default} is resolved now,
 * and ${user_config.KEY} becomes ${secret:plugin.<plugin>.KEY} so the value can
 * be stored as a Conclave secret.
 */
export function translateMcpVars<T>(value: T, plugin: string): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (whole, inner: string) => {
      if (inner.startsWith('env:')) return whole;
      // a plugin reads only its own secrets, never the owner's other keys (github-pat, provider keys)
      if (inner.startsWith('secret:')) {
        const key = inner.slice('secret:'.length);
        return key.startsWith(`plugin.${plugin}.`) ? whole : `\${secret:plugin.${plugin}.${key}}`;
      }
      if (inner.startsWith('user_config.')) return `\${secret:plugin.${plugin}.${inner.slice('user_config.'.length)}}`;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/.exec(inner);
      if (!m) return whole;
      if (m[2] !== undefined) return process.env[m[1]] || m[2];
      return `\${env:${m[1]}}`;
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => translateMcpVars(v, plugin)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = translateMcpVars(v, plugin);
    return out as T;
  }
  return value;
}

/** Accept either { mcpServers: {...} } or a bare { name: cfg } map; expand plugin variables. */
function normalizeMcp(parsed: Record<string, unknown> | undefined, root: string, plugin: string, data: string): Record<string, McpServerConfig> {
  if (!parsed) return {};
  const map = (parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : parsed) as Record<string, unknown>;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const c = translateMcpVars(expandRoot(cfg, root, data), plugin) as McpServerConfig;
    // the hub's whole environment (provider keys) is for servers the owner sets up by hand, never one a plugin brings
    delete c.inheritEnv;
    out[name] = c;
  }
  return out;
}
