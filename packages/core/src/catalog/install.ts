/**
 * Preview, install, update, rollback and remove for every catalog kind
 * (docs/design/ECOSYSTEM.md 1.6 and 1.7).
 *
 * Preview resolves the commit, fetches only the files the install needs into
 * ~/.conclave/cache/catalog/<plan>/, and lists every file, hook command, MCP
 * config and script. Install copies exactly that staged copy, so what was
 * shown is what lands. Nothing from a repo is ever executed here: no install
 * scripts, no package managers. An MCP server starts only when Install runs
 * its test connect, after the owner pressed Add.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { linkTarget } from '../util/copy-tree';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { HooksConfig, McpServerConfig } from '../config/schema';
import type { InstalledPlugin, PluginManifest } from '../extensions/types';
import { entryManifest, sensitiveHash, isSensitivePath, type PluginInstallOptions } from '../extensions/plugins';
import { HOOK_RECIPES } from '../extensions/hook-recipes';
import type { McpTestResult } from '../client';
import type { CatalogHttp } from './http';
import type { GithubClient } from './github';
import { McpRegistry, namespaceMatches, repoFromUrl } from './registry';
import { copyTree, fetchCommit, isFullSha, listTree, lsRemote, repoUrl, resolveRef, walkFiles, type GitRun } from './git';
import { readMarketplace, resolveEntrySource, safeGitUrl, type MarketplaceJson } from './feeds';
import { detectKinds, deriveMcpFromRepo } from './detect';
import {
  agentFileHooks,
  commandWarnings,
  fileRole,
  hookWarnings,
  ignoredManifestFields,
  inlineCommands,
  inlineCommandWarnings,
  licenseIsOsi,
  listFiles,
  pluginHooks,
  pluginMcp,
  readPluginManifest,
  scriptsIn,
  secretsOutsideEnv,
} from './inspect';
import {
  KNOWN_MARKETPLACES,
  type CatalogInput,
  type CatalogItem,
  type CatalogKind,
  type CatalogNeed,
  type FilesInstall,
  type InstallSpec,
  type McpInstall,
  type PluginInstall,
} from './recommended';
import type { CatalogStore, InstallMeta, InstallRow } from './store';
import type {
  CatalogInstallRequest,
  CatalogInstallResult,
  CatalogItemDto,
  CatalogPreviewRequest,
  InstallPreview,
  InstalledCatalogItem,
  InstalledRef,
  PreviewFile,
  PreviewHook,
  PreviewWarning,
  RecipeTestResult,
  UpdatePreview,
} from './types';

export class CatalogError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** What the installer needs from the hub. The server wires these to the engine; tests pass fakes. */
export interface CatalogHost {
  secrets: { set(key: string, value: string): void; has(key: string): boolean; remove(key: string): void; get?(key: string): string | undefined };
  mcp: {
    get(name: string): McpServerConfig | undefined;
    add(name: string, config: McpServerConfig): void;
    update(name: string, config: McpServerConfig): void;
    remove(name: string): boolean;
    test(name: string): Promise<McpTestResult>;
  };
  plugins: {
    list(): InstalledPlugin[];
    installFrom(dir: string, opts: PluginInstallOptions): Promise<InstalledPlugin>;
    remove(name: string): Promise<boolean>;
    marketplaces(): Array<{ name: string; source: string }>;
    addMarketplace(source: string): Promise<void>;
    /** Forget a marketplace by its source and delete its clone. */
    removeMarketplace?(source: string): Promise<boolean>;
  };
  reloadExtensions(): Promise<void>;
  /** User hooks (config.json), to find recipe handlers by tag. */
  hooks(): HooksConfig;
  routines(): Array<{ id: string; name: string; suggestion?: string }>;
  /** The hook recipe service (section 4.2). Missing until the hooks update lands. */
  recipes?: {
    install(id: string, req: { scope: 'user' | 'project'; cwd?: string; env?: Record<string, string>; target?: { cli: 'claude-code' | 'codex' | 'gemini'; device: string } }): Promise<{ tests: RecipeTestResult[] }>;
    remove(id: string, where: { scope?: string; cwd?: string; cli?: string; device?: string }): Promise<void>;
  };
  syncClis?(device: string, clis: string[]): Promise<string[]>;
  /** Memory connections (config memory.connections): a memory MCP server connected there counts as installed. */
  memoryConnections?(): Array<{ id: string; type: string; enabled?: boolean; options?: Record<string, unknown> }>;
  /** command -v on a paired device. null when the device cannot be asked. */
  deviceHas?(device: string, bin: string): Promise<boolean | null>;
  audit(action: string, detail: string): void;
}

export interface InstallerOptions {
  paths: { home: string; skills: string; agents: string; commands: string; hooks: string; cache: string; plugins: string };
  store: CatalogStore;
  http: CatalogHttp;
  git: GitRun;
  github: GithubClient;
  registry: McpRegistry;
  host: CatalogHost;
  checkBin: (bin: string) => Promise<boolean>;
  /** The full item (curated, cached or snapshot) for an id. */
  itemFor: (id: string) => CatalogItem | undefined;
  /** Shape an item as a DTO with installed state. */
  dtoFor: (item: CatalogItem) => CatalogItemDto;
  now?: () => number;
  planTtlMs?: number;
}

interface StagedPlugin {
  source: string;
  name: string;
  dir: string;
  sha?: string;
  manifest?: PluginManifest;
  marketplace?: string;
  description?: string;
  selected: boolean;
}

interface StagedFile {
  from: string;
  to: string;
  dir: boolean;
  rel: string;
}

interface Plan {
  id: string;
  expiresAt: number;
  item: CatalogItem;
  variant: number;
  spec: InstallSpec;
  inputs: CatalogInput[];
  options: NonNullable<CatalogPreviewRequest['options']>;
  sha?: string;
  shaFrom?: 'pinned' | 'head';
  repoUrl?: string;
  stage: string;
  plugins?: StagedPlugin[];
  files?: StagedFile[];
  preview: InstallPreview;
  update?: { installId: string; changes: UpdatePreview };
  used?: boolean;
  /** The install spec was worked out from the repo's latest commit. */
  live?: boolean;
}

const INDEX_FILE = 'catalog-files.json';
/** Earlier versions kept for rollback, under ~/.conclave and outside every folder Conclave loads from. */
const PREV_DIR = 'catalog-prev';
/** Open previews kept staged at once. Older ones expire early and must be opened again. */
const MAX_PLANS = 8;
const MARKER = '.conclave-catalog.json';
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const short = (sha?: string) => (sha ? sha.slice(0, 7) : '');

function specLabel(spec: InstallSpec, item: CatalogItem): string {
  switch (spec.type) {
    case 'mcp':
      return spec.label ?? (spec.config.url ? 'Remote server' : `${spec.config.command} on the hub`);
    case 'plugin':
      return spec.plugins.length > 1 ? `${spec.plugins.length} plugins` : 'Plugin';
    case 'files':
      return item.kind === 'plugin' || spec.files.some((f) => f.to.startsWith('skills/')) ? 'Skill files only' : 'Copy the files';
    case 'hook':
      return 'Hook recipe';
    case 'routine':
      return 'Routine';
    case 'manual':
      return 'Manual steps';
  }
}

export function hrefFor(kind: CatalogKind, ref: string): string {
  const q = encodeURIComponent(ref);
  switch (kind) {
    case 'mcp':
      return `/extensions/mcp?server=${q}`;
    case 'plugin':
      return `/extensions/plugins?plugin=${q}`;
    case 'skill':
      return `/extensions/skills?skill=${q}`;
    case 'subagent':
      return `/agents/${q}`;
    case 'command':
      return `/extensions/commands?command=${q}`;
    case 'hook':
      return `/extensions/hooks?recipe=${q}`;
    case 'routine':
      return `/routines/${q}`;
  }
}

/** Fill {{NAME}} placeholders. Secrets become ${secret:key}; an empty optional input drops the key that held only its placeholder. */
export function fillPlaceholders<T>(
  value: T,
  inputs: CatalogInput[],
  values: Record<string, string>,
  secretHas: (key: string) => boolean,
  serverName = 'server',
): { value: T; secrets: Array<{ key: string; value: string }>; missing: string[]; secretKeys: string[] } {
  const repl = new Map<string, string>();
  const secrets: Array<{ key: string; value: string }> = [];
  const missing: string[] = [];
  const secretKeys: string[] = [];
  for (const i of inputs) {
    const given = (values[i.name] ?? '').trim();
    if (i.secret) {
      const key = i.secretKey ?? `${serverName}.${i.name}`.toLowerCase();
      if (given) {
        secrets.push({ key, value: given });
        secretKeys.push(key);
        repl.set(i.name, `\${secret:${key}}`);
      } else if (secretHas(key)) {
        secretKeys.push(key);
        repl.set(i.name, `\${secret:${key}}`);
      } else if (i.required) missing.push(i.name);
      else repl.set(i.name, '');
    } else {
      const v = given || i.default || '';
      if (!v && i.required) missing.push(i.name);
      repl.set(i.name, v);
    }
  }
  const DROP = Symbol('drop');
  const sub = (s: string): string | typeof DROP => {
    const only = /^\{\{([A-Z0-9_]+)\}\}$/.exec(s);
    if (only && repl.has(only[1]) && repl.get(only[1]) === '') return DROP;
    return s.replace(/\{\{([A-Z0-9_]+)\}\}/g, (w, n: string) => (repl.has(n) ? repl.get(n)! : w));
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return sub(v);
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== DROP);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const w = walk(x);
        if (w !== DROP) out[k] = w;
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, secrets, missing, secretKeys };
}

const HUB_REF = /\$\{(env|secret):([^}]*)\}/g;

/**
 * McpManager expands ${env:X} and ${secret:X} in env, headers, args and url.
 * A config from outside the curated list (the registry, a README, a Docker
 * catalog entry) that names one would hand the hub's own keys to a stranger's
 * server. Each one becomes a required field instead, so only what the owner
 * types is passed. Input defaults that name one are dropped for the same reason.
 */
export function neutralizeHubRefs(
  specs: InstallSpec[],
  inputs: CatalogInput[],
): { specs: InstallSpec[]; inputs: CatalogInput[]; found: string[] } {
  const found: string[] = [];
  const list = inputs.map((i) => (i.default && /\$\{/.test(i.default) ? { ...i, default: undefined } : i));
  const out = specs.map((spec) => {
    if (spec.type !== 'mcp') return spec;
    const server = spec.server.replace(/\{\{[^}]*\}\}/g, 'server').toLowerCase();
    const fix = (s: string) =>
      s.replace(HUB_REF, (whole, kind: string, name: string) => {
        if (!found.includes(whole)) found.push(whole);
        const key = `${kind === 'secret' ? 'SECRET_' : ''}${name}`.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'VALUE';
        if (!list.some((i) => i.name === key)) {
          list.push({
            name: key,
            label: name || key,
            description: `The config asked for the hub's ${whole}. Conclave never passes hub values to a server from outside the picked list. Type the value this server should get.`,
            required: true,
            secret: true,
            secretKey: `${server}.${key}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-'),
          });
        }
        return `{{${key}}}`;
      });
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return fix(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    const config = walk(spec.config) as McpServerConfig;
    // the hub's whole environment is for servers the owner set up by hand
    delete config.inheritEnv;
    return { ...spec, config };
  });
  return { specs: out, inputs: list, found };
}

/** The config as the preview shows it: secrets as ${secret:key}, plain inputs with their defaults. */
function shownConfig<T>(value: T, inputs: CatalogInput[], server = 'server'): T {
  return JSON.parse(
    JSON.stringify(value).replace(/\{\{([A-Z0-9_]+)\}\}/g, (w, n: string) => {
      const i = inputs.find((x) => x.name === n);
      if (!i) return w;
      if (i.secret) return `\${secret:${i.secretKey ?? `${server}.${n}`.toLowerCase()}}`;
      return i.default ?? w;
    }),
  ) as T;
}

const trimSlash = (p: string) => p.replace(/\/+$/, '');

/**
 * What one files entry installs as: the skill folder (skills/<name>) for
 * anything inside a skill, else the path itself (one agent or command).
 */
export function installUnit(to: string): string {
  const t = trimSlash(to);
  return /^skills\/[^/]+/.exec(t)?.[0] ?? t;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function inside(root: string, p: string): boolean {
  const r = relative(resolve(root), resolve(p));
  return r === '' || (!r.startsWith('..') && !r.startsWith('/'));
}

function readIndex(home: string): Record<string, { id: string; repo?: string; sha?: string; installedAt: number }> {
  try {
    return JSON.parse(readFileSync(join(home, INDEX_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function writeIndex(home: string, idx: Record<string, unknown>): void {
  writeFileSync(join(home, INDEX_FILE), JSON.stringify(idx, null, 2) + '\n');
}

/** Earlier copies kept by an update: prevPairs, or the older "<dest>.prev" list. */
function prevPairsOf(meta: InstallMeta): Array<{ prev: string; dest: string }> {
  if (meta.prevPairs?.length) return meta.prevPairs;
  return (meta.prevPaths ?? []).map((prev) => ({ prev, dest: prev.replace(/\.prev$/, '') }));
}

/** Conclave wrote this path (folder marker or index entry) for this catalog id. */
function ownedBy(home: string, path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    if (statSync(path).isDirectory()) {
      const m = JSON.parse(readFileSync(join(path, MARKER), 'utf8')) as { id?: string };
      return m.id;
    }
  } catch {
    return undefined;
  }
  return readIndex(home)[resolve(path)]?.id;
}

export class CatalogInstaller {
  private plans = new Map<string, Plan>();
  private now: () => number;
  private ttl: number;

  constructor(private o: InstallerOptions) {
    this.now = o.now ?? Date.now;
    this.ttl = o.planTtlMs ?? 10 * 60_000;
    // plans live in memory, so staged copies left by an earlier run belong to no plan
    rmSync(join(o.paths.cache, 'catalog'), { recursive: true, force: true });
  }

  private get host(): CatalogHost {
    return this.o.host;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, p] of this.plans) {
      if (p.expiresAt < now || p.used) {
        rmSync(p.stage, { recursive: true, force: true });
        this.plans.delete(id);
      }
    }
    // a staged plugin can be tens of MB: keep only the newest few open previews on disk
    // the Map keeps creation order, so the first entries are the oldest
    for (const p of [...this.plans.values()].slice(0, Math.max(0, this.plans.size - MAX_PLANS))) {
      rmSync(p.stage, { recursive: true, force: true });
      this.plans.delete(p.id);
    }
  }

  /** Remove expired plans and their staged files. */
  dispose(): void {
    for (const p of this.plans.values()) rmSync(p.stage, { recursive: true, force: true });
    this.plans.clear();
  }

  private stageDir(id: string): string {
    return join(this.o.paths.cache, 'catalog', id);
  }

  private async needsRows(needs: CatalogNeed[], device?: string): Promise<InstallPreview['needs']> {
    const out: InstallPreview['needs'] = [];
    for (const n of needs) {
      if (out.some((x) => x.bin === n.bin && x.where === n.where)) continue;
      if (n.where === 'hub') out.push({ ...n, found: await this.o.checkBin(n.bin), checkedOn: 'hub' });
      else if (device && this.host.deviceHas) out.push({ ...n, found: await this.host.deviceHas(device, n.bin), checkedOn: device });
      else out.push({ ...n, found: null, checkedOn: device ?? 'device' });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  async preview(source: CatalogItem, req: CatalogPreviewRequest, internal: { update?: boolean } = {}): Promise<InstallPreview> {
    this.sweep();
    const id = randomUUID();
    const stage = this.stageDir(id);
    mkdirSync(stage, { recursive: true });
    try {
      let item = source;
      // live results have no install spec yet: read the repo and work one out
      const live = item.install.type === 'manual' && !!item.repo && ['github', 'awesome-list', 'star-index'].includes(item.source);
      if (live) item = await this.deriveLive(item, req.kind, stage);
      // configs from outside the curated list never get the hub's own env vars or secrets
      let hubRefs: string[] = [];
      if (item.source !== 'recommended' && !internal.update) {
        const n = neutralizeHubRefs([item.install, ...(item.variants ?? [])], item.inputs ?? []);
        hubRefs = n.found;
        item = { ...item, install: n.specs[0], variants: item.variants ? n.specs.slice(1) : undefined, inputs: n.inputs.length ? n.inputs : undefined };
      }
      const specs = [item.install, ...(item.variants ?? [])];
      const variant = Math.max(0, Math.min(specs.length - 1, req.variant ?? 0));
      const plan: Plan = {
        id,
        expiresAt: this.now() + this.ttl,
        item,
        variant,
        spec: specs[variant],
        inputs: item.inputs ?? [],
        options: req.options ?? {},
        stage,
        preview: undefined as unknown as InstallPreview,
        live,
      };
      const base: InstallPreview = {
        planId: id,
        expiresAt: plan.expiresAt,
        item: this.o.dtoFor(item),
        variant,
        variants: specs.map((s, index) => ({ index, label: specLabel(s, item), type: s.type })),
        steps: [],
        inputs: [],
        files: [],
        totalBytes: 0,
        hooks: [],
        mcpServers: [],
        scripts: [],
        license: item.license,
        licenseOsi: licenseIsOsi(item.license),
        needs: [],
        touches: item.touches,
        warnings: [],
      };
      plan.preview = base;
      const sp = plan.spec;
      if (sp.type === 'mcp') await this.previewMcp(plan, sp);
      else if (sp.type === 'plugin') await this.previewPlugin(plan, sp);
      else if (sp.type === 'files') await this.previewFiles(plan, sp);
      else if (sp.type === 'hook') await this.previewHook(plan, sp.recipe);
      else if (sp.type === 'routine') {
        base.steps.push({ say: 'Routines are added in the Routines tab, where you pick the device, folder and schedule.' });
        base.handoff = { label: 'Open in Routines', href: `/routines?suggest=${encodeURIComponent(sp.suggestion)}` };
      } else {
        base.steps.push(...sp.steps);
        if (item.repo) base.steps.push({ say: `See https://github.com/${item.repo} for the details.` });
      }
      // shared warnings
      if (hubRefs.length)
        base.warnings.unshift({ level: 'risk', text: `The config asked for ${hubRefs.slice(0, 4).join(', ')} from the hub. Conclave turned ${hubRefs.length > 1 ? 'them' : 'it'} into fields, so the server gets only what you type.` });
      if (item.archived) base.warnings.unshift({ level: 'risk', text: 'The repository is archived. It gets no fixes.' });
      if (item.updatedAt && this.now() - Date.parse(item.updatedAt) > 180 * 86_400_000) base.warnings.push({ level: 'warn', text: `No commit since ${item.updatedAt}.` });
      if (base.licenseOsi === false) base.warnings.push({ level: 'warn', text: `${base.license} is not an open source license. Read its terms before you use it.` });
      for (const w of item.warnings ?? []) base.warnings.push({ level: 'warn', text: w });
      // "None beyond prompt text." is a fine note in the data, not a warning
      if (item.risk && !/^none\b/i.test(item.risk.trim())) base.warnings.push({ level: 'info', text: item.risk });
      for (const o of item.overlaps ?? []) {
        const other = this.o.itemFor(o);
        if (!other) continue;
        const added = this.o.dtoFor(other).installed;
        base.warnings.push({ level: added ? 'warn' : 'info', text: `Overlaps with ${other.name}${added ? ' (added)' : ''}.` });
      }
      base.totalBytes = base.files.reduce((n, f) => n + f.bytes, 0);
      if (!base.inputs.length) base.inputs = plan.inputs;
      this.plans.set(id, plan);
      this.sweep();
      return base;
    } catch (err) {
      rmSync(stage, { recursive: true, force: true });
      throw err;
    }
  }

  /** Read a live repo at its latest commit and turn it into an item with an install spec. */
  private async deriveLive(item: CatalogItem, kind: CatalogKind | undefined, stage: string): Promise<CatalogItem> {
    const url = repoUrl(item.repo!);
    let sha: string | undefined;
    try {
      sha = await lsRemote(this.o.git, url);
    } catch (err) {
      throw new CatalogError(502, `Failed. Could not read ${item.repo}: ${(err as Error).message}`);
    }
    if (!sha) throw new CatalogError(502, `Failed. ${item.repo} has no commits.`);
    const clone = join(stage, 'probe');
    const meta = ['README.md', 'readme.md', 'package.json', 'pyproject.toml', 'Dockerfile', 'server.json', '.claude-plugin/', '.codex-plugin/', 'plugin.json', 'hooks/hooks.json', '.mcp.json'];
    await fetchCommit(this.o.git, url, sha, clone, meta);
    const tree = (await listTree(this.o.git, clone, sha)).filter((t) => t.type === 'blob').map((t) => t.path);
    const read = (p: string) => {
      const abs = join(clone, p);
      if (!inside(clone, abs) || !existsSync(abs)) return undefined;
      try {
        return readFileSync(abs, 'utf8');
      } catch {
        return undefined;
      }
    };
    const det = detectKinds(tree, read);
    const pick = kind && det.kinds.includes(kind) ? kind : det.kinds[0];
    if (!pick) throw new CatalogError(422, `Failed. No plugin.json, SKILL.md or MCP server found in this repo at ${short(sha)}.`, { kinds: det.kinds });
    const out: CatalogItem = { ...item, kind: pick, warnings: [...(item.warnings ?? [])] };
    if (det.kinds.length > 1) out.warnings!.push(`This repo also holds: ${det.kinds.filter((k) => k !== pick).join(', ')}. Pick another kind in the preview to add those.`);
    const repoName = basename(item.repo!).replace(/\.git$/, '');
    if (pick === 'plugin') {
      if (det.marketplace) {
        const mk = (() => {
          try {
            return JSON.parse(read(det.marketplace!) ?? '') as MarketplaceJson;
          } catch {
            return undefined;
          }
        })();
        const mkName = mk?.name ?? repoName;
        const entries = (mk?.plugins ?? []).filter((p) => p?.name);
        if (!entries.length) throw new CatalogError(422, `Failed. The marketplace.json in ${item.repo} lists no plugins.`);
        out.install = { type: 'plugin', marketplace: item.repo, plugins: entries.map((e) => `${e.name}@${mkName}`), sha };
      } else {
        out.install = { type: 'plugin', plugins: [`${item.repo}@${sha}`], sha };
      }
    } else if (pick === 'mcp') {
      const derived = await deriveMcpFromRepo({ repo: item.repo!, read, paths: tree, readme: read('README.md') ?? read('readme.md') });
      if (!derived.length) throw new CatalogError(422, `Failed. ${item.repo} looks like an MCP server, but no way to run it was found at ${short(sha)}. Open it on GitHub and add it by hand in MCP servers.`);
      out.install = derived[0].spec;
      out.variants = derived.slice(1).map((d) => d.spec);
      const inputs: CatalogInput[] = [];
      for (const d of derived) for (const i of d.inputs) if (!inputs.some((x) => x.name === i.name)) inputs.push(i);
      out.inputs = inputs;
      out.warnings!.push(...new Set(derived.flatMap((d) => d.warnings)));
      out.warnings!.push(`Worked out from ${derived[0].from}. Conclave tests the connection before it saves anything.`);
      out.touches = out.install.config.command ? ['hub-code', 'network'] : ['network'];
      const bin = out.install.config.command;
      if (bin) out.needs = [{ bin, where: 'hub', why: `Conclave starts stdio servers on the hub, and this one runs through ${bin}.` }];
    } else {
      const files: FilesInstall['files'] = [];
      // two sources that land on the same name would overwrite each other: the shallower one wins and the preview says so
      const byDepth = (list: string[]) => [...list].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      const skipped: string[] = [];
      const push = (from: string, to: string) => {
        if (files.some((f) => f.to === to)) skipped.push(from || '/');
        else files.push({ from, to });
      };
      if (pick === 'skill') {
        for (const folder of byDepth(det.skills).slice(0, 50)) push(folder ? `${folder}/` : '', `skills/${folder ? basename(folder) : repoName}/`);
      } else if (pick === 'subagent') {
        for (const p of byDepth(det.agents).slice(0, 100)) push(p, `agents/${basename(p)}`);
      } else if (pick === 'command') {
        for (const p of byDepth(det.commands).slice(0, 100)) push(p, `commands/${p.replace(/^(\.claude\/)?commands\//, '')}`);
      }
      if (skipped.length) out.warnings!.push(`Left out ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? ` and ${skipped.length - 4} more` : ''}: the same name is already taken by another folder in this repo.`);
      out.install = { type: 'files', repo: item.repo!, sha, files };
      out.variants = undefined;
    }
    out.verified = false;
    return out;
  }

  private async previewMcp(plan: Plan, spec: McpInstall): Promise<void> {
    const p = plan.preview;
    let cfg: McpServerConfig = structuredClone(spec.config);
    const presets = spec.toolPresets ?? [];
    if (presets.length) {
      const preset = presets.find((x) => x.id === plan.options.toolPreset) ?? presets[0];
      cfg.tools = preset.tools;
    }
    const resolved: McpInstall = { ...spec, config: cfg };
    plan.spec = resolved;
    const server = shownConfig(spec.server, plan.inputs);
    cfg = shownConfig(cfg, plan.inputs, server);
    p.config = cfg;
    p.mcpServers = [{ name: server, config: cfg }];
    p.steps.push(...(spec.setup ?? []));
    p.equivalent = `conclave config set mcpServers.${server} ${shq(JSON.stringify(cfg))}`;
    const needs = [...(plan.item.needs ?? [])];
    if (cfg.command && !needs.some((n) => n.bin === cfg.command)) needs.push({ bin: cfg.command, where: 'hub', why: 'Conclave starts stdio servers on the hub.' });
    p.needs = await this.needsRows(needs, plan.options.device);
    const secretNames = plan.inputs.filter((i) => i.secret).map((i) => i.name);
    for (const n of secretsOutsideEnv(resolved, secretNames)) p.warnings.push({ level: 'warn', text: `The secret ${n} is passed on the command line, where other programs on the hub can read it.` });
    if (plan.item.source !== 'recommended') p.warnings.push(...commandWarnings(cfg));
    const existing = SERVER_NAME.test(server) ? this.host.mcp.get(server) : undefined;
    if (existing) p.warnings.unshift({ level: 'risk', text: `An MCP server named ${server} is already set up. Add stops here; remove or rename that one first.` });
    if (!cfg.command && cfg.url) {
      try {
        p.warnings.push({ level: 'info', text: `Calls go to ${new URL(cfg.url.replace(/\$\{[^}]+\}|\{\{[^}]+\}\}/g, 'x')).host}.` });
      } catch {
        p.warnings.unshift({ level: 'risk', text: `${cfg.url} is not a URL Conclave can call.` });
      }
    }
    // registry entries: the trust rule
    if (plan.item.source === 'mcp-registry' && plan.item.id.startsWith('reg:')) {
      const name = plan.item.id.slice(4);
      const entry = await this.o.registry.get(name).catch(() => undefined);
      const github = /^io\.github\./i.test(name);
      // io.github names must match the repo owner; other names are domains the registry checked itself
      const matches = github ? namespaceMatches(name, entry?.server.repository?.url) : true;
      const pkg = entry?.server.packages?.[0];
      const marker = pkg ? await this.o.registry.ownershipMarker(pkg, name) : entry?.server.remotes?.length ? true : null;
      const verified = matches && marker === true;
      plan.item = { ...plan.item, verified };
      p.item = this.o.dtoFor(plan.item);
      if (!verified) {
        p.warnings.unshift({
          level: 'risk',
          text: !matches
            ? `Not verified. The registry name ${name} does not match the owner of ${repoFromUrl(entry?.server.repository?.url) ?? 'its repository'}. It may be a copy.`
            : marker === false
              ? `Not verified. The package ${pkg?.identifier} does not carry the registry name ${name}.`
              : 'Not verified. Conclave could not check the package for the registry ownership marker.',
        });
      } else if (!github) {
        const domain = name.split('/')[0].split('.').reverse().join('.');
        p.warnings.push({ level: 'info', text: `The registry checked that the publisher owns ${domain}. The link to the source repository is not checked.` });
      }
    }
    if (spec.offer?.includes('connect-clis')) p.steps.push({ say: 'After it is added, "Connect to my CLIs" writes the same server into Claude Code, Codex, OpenCode or Gemini on a device.' });
  }

  private async readMarketplaceAt(repo: string, sha?: string): Promise<{ mk?: MarketplaceJson; sha?: string }> {
    if (sha) {
      const mk = await readMarketplace(this.o.http, repo, sha).catch(() => undefined);
      if (mk) return { mk, sha };
    }
    const head = await lsRemote(this.o.git, repoUrl(repo)).catch(() => undefined);
    const mk = await readMarketplace(this.o.http, repo, head ?? 'HEAD').catch(() => undefined);
    return { mk, sha: head };
  }

  private async previewPlugin(plan: Plan, spec: PluginInstall): Promise<void> {
    const p = plan.preview;
    const staged: StagedPlugin[] = [];
    const wanted = plan.options.plugins?.length ? new Set(plan.options.plugins) : undefined;
    const mkCache = new Map<string, { mk?: MarketplaceJson; sha?: string }>();
    const mkRepoFor = (mkName: string) =>
      spec.marketplace ?? KNOWN_MARKETPLACES.find((k) => k.name === mkName)?.source ?? this.host.plugins.marketplaces().find((m) => m.name === mkName)?.source;
    let i = 0;
    for (const source of spec.plugins) {
      const selected = wanted ? wanted.has(source) : spec.plugins.length <= 8;
      const at = /^([^@/\s]+)@([A-Za-z0-9._-]+)$/.exec(source);
      let url: string;
      let sha: string | undefined;
      let path = '';
      let name: string;
      let manifest: PluginManifest | undefined;
      let description: string | undefined;
      let marketplace: string | undefined;
      if (at) {
        name = at[1];
        const mkRepo = mkRepoFor(at[2]);
        if (!mkRepo) throw new CatalogError(422, `Failed. Conclave does not know the marketplace ${at[2]}. Add it in Plugins, Marketplace first.`);
        marketplace = mkRepo;
        if (!mkCache.has(mkRepo)) mkCache.set(mkRepo, await this.readMarketplaceAt(mkRepo, spec.sha));
        const { mk, sha: mkSha } = mkCache.get(mkRepo)!;
        const entry = mk?.plugins?.find((e) => e.name === at[1]);
        if (!entry) throw new CatalogError(502, `Failed. ${at[1]} is not in the marketplace ${mkRepo}${mkSha ? ` at ${short(mkSha)}` : ''}.`);
        description = entry.description;
        const src = resolveEntrySource(entry, mkRepo, mk?.metadata?.pluginRoot);
        if (!src.local && !safeGitUrl(src.url)) throw new CatalogError(422, `Failed. ${at[1]} in ${mkRepo} points at ${src.url.slice(0, 120)}, which Conclave does not fetch. Only https and ssh git URLs are allowed.`);
        url = src.local ? repoUrl(mkRepo) : src.url;
        path = src.path;
        if (src.local) sha = mkSha ?? (await resolveRef(this.o.git, url));
        else if (spec.sha && spec.sha !== mkSha) sha = spec.sha;
        else sha = isFullSha(src.sha) ? src.sha : await resolveRef(this.o.git, url, src.ref);
        if (entry.strict === false) manifest = entryManifest(entry as unknown as Record<string, unknown>);
      } else {
        const m = /^([\w.-]+\/[\w.-]+?)(?:@([\w./-]+))?(?:#(.+))?$/.exec(source);
        if (!m) throw new CatalogError(400, `Failed. Cannot read the plugin source ${source}.`);
        name = m[1].split('/')[1];
        url = repoUrl(m[1]);
        path = m[3] ?? '';
        sha = spec.sha ?? (await resolveRef(this.o.git, url, m[2]));
      }
      if (!selected) {
        staged.push({ source, name, dir: '', sha, manifest, description, marketplace, selected });
        continue;
      }
      const clone = join(plan.stage, `p${i++}`);
      try {
        await fetchCommit(this.o.git, url, sha!, clone, path ? [`${path}/`] : []);
      } catch (err) {
        throw new CatalogError(502, `Failed. Could not fetch ${source} at ${short(sha)}: ${(err as Error).message}`);
      }
      const dir = path ? join(clone, path) : clone;
      if (!inside(clone, dir) || !existsSync(dir)) throw new CatalogError(502, `Failed. ${path} is not in ${url} at ${short(sha)}.`);
      const own = readPluginManifest(dir, name);
      const finalName = manifest?.name ?? own.name ?? name;
      staged.push({ source, name: finalName, dir, sha, manifest: manifest ?? undefined, description, marketplace, selected });
    }
    plan.plugins = staged;
    const first = staged.find((s) => s.selected) ?? staged[0];
    plan.sha = first?.sha;
    plan.shaFrom = spec.sha && !plan.live ? 'pinned' : 'head';
    p.sha = plan.sha;
    p.shaFrom = plan.shaFrom;
    p.plugins = staged.map((s) => ({ source: s.source, name: s.name, description: s.description, selected: s.selected }));
    const hooksOn = plan.options.hooks ?? spec.hooks !== 'off';
    const needs: CatalogNeed[] = [...(plan.item.needs ?? [])];
    const scriptTexts: Array<{ path: string; text: string }> = [];
    const ignored: string[] = [];
    const inline: string[] = [];
    for (const s of staged.filter((x) => x.selected)) {
      const manifest = s.manifest ?? readPluginManifest(s.dir, s.name);
      p.files.push(...listFiles(s.dir, `~/.conclave/plugins/${s.name}`, plan.stage));
      inline.push(...inlineCommands(s.dir, `~/.conclave/plugins/${s.name}`, plan.stage));
      const h = pluginHooks(s.dir, manifest, s.name);
      p.hooks.push(...h.hooks);
      ignored.push(...h.ignored, ...ignoredManifestFields(manifest));
      for (const m of pluginMcp(s.dir, manifest)) p.mcpServers.push({ name: `plugin_${s.name}_${m.name}`.replace(/[^A-Za-z0-9_-]/g, '_'), config: m.config });
      for (const sc of scriptsIn(s.dir, plan.stage)) p.scripts.push(`${s.name}/${sc}`);
      for (const f of walkFiles(s.dir, plan.stage).filter((r) => fileRole(r) === 'script' || fileRole(r) === 'hook').slice(0, 200)) {
        try {
          scriptTexts.push({ path: `${s.name}/${f}`, text: readFileSync(join(s.dir, f), 'utf8').slice(0, 200_000) });
        } catch {
          /* binary */
        }
      }
      if (!p.license && manifest.license) p.license = manifest.license;
      if (hooksOn) for (const hk of h.hooks) if (hk.interpreter !== 'prompt' && !needs.some((n) => n.bin === hk.interpreter) && hk.interpreter !== 'sh') needs.push({ bin: hk.interpreter, where: 'hub', why: 'Its hooks run this on the hub.' });
    }
    p.licenseOsi = licenseIsOsi(p.license);
    p.needs = await this.needsRows(needs, plan.options.device);
    p.warnings.push(...hookWarnings(p.hooks, scriptTexts), ...inlineCommandWarnings(inline));
    if (!hooksOn && p.hooks.length) p.warnings.push({ level: 'info', text: `Hooks off: the ${p.hooks.length} hooks above are installed but do not run. Skills, commands and agents stay on.` });
    if (ignored.length) p.warnings.push({ level: 'info', text: `Conclave ignores ${[...new Set(ignored)].join(', ')}.` });
    if (p.mcpServers.length) p.warnings.push({ level: 'warn', text: `Brings ${p.mcpServers.length} MCP server${p.mcpServers.length > 1 ? 's' : ''} that start with the plugin.` });
    // plugin MCP configs read hub env vars as Claude Code does; say which ones
    const envRefs = new Set<string>();
    for (const m of p.mcpServers) {
      for (const r of JSON.stringify(m.config).matchAll(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
        if (!/^(CLAUDE_PLUGIN_ROOT|CONCLAVE_PLUGIN_ROOT|PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|PLUGIN_DATA)$/.test(r[1])) envRefs.add(r[1]);
      }
    }
    if (envRefs.size) {
      const names = [...envRefs];
      const keyish = names.filter((n) => /KEY|TOKEN|SECRET|PASS|AUTH|CRED/i.test(n));
      p.warnings.push({
        level: keyish.length ? 'risk' : 'warn',
        text: `Its MCP servers read ${names.slice(0, 6).join(', ')} from the hub's environment. Check that ${names.length > 1 ? 'these are' : 'this is'} meant for them.`,
      });
    }
    for (const s of staged.filter((x) => x.selected)) {
      const have = this.host.plugins.list().find((x) => x.name === s.name);
      if (have && !have.source.startsWith(s.source.split('@')[0])) p.warnings.unshift({ level: 'warn', text: `A plugin named ${s.name} is installed from ${have.source}. Add replaces it.` });
    }
    const mks = [...new Set(staged.map((s) => s.marketplace).filter((x): x is string => !!x))];
    const added = new Set(this.host.plugins.marketplaces().map((m) => m.source.toLowerCase()));
    for (const m of mks) if (!added.has(m.toLowerCase())) p.steps.push({ say: `Adds the marketplace ${m} to Plugins, so later updates can find it.` });
    p.steps.push({ say: `Copies ${staged.filter((s) => s.selected).length} plugin folder${staged.filter((s) => s.selected).length === 1 ? '' : 's'} from commit ${short(plan.sha)} without .git. Nothing in it is run during the install.` });
    p.equivalent = staged.filter((s) => s.selected).map((s) => `POST /api/plugins ${JSON.stringify({ source: s.source })}`).join('\n');
  }

  private async previewFiles(plan: Plan, spec: FilesInstall): Promise<void> {
    const p = plan.preview;
    const url = repoUrl(spec.repo);
    const writes = spec.write ?? [];
    // a file written by Conclave is part of the curated data; nothing from a repo or a feed may carry one
    if (writes.length && plan.item.source !== 'recommended') throw new CatalogError(400, 'Failed. Only curated items may write their own files.');
    const clone = join(plan.stage, 'files');
    try {
      await fetchCommit(this.o.git, url, spec.sha, clone, spec.files.map((f) => f.from || '/'));
    } catch (err) {
      throw new CatalogError(502, `Failed. Could not fetch ${spec.repo} at ${short(spec.sha)}: ${(err as Error).message}`);
    }
    plan.sha = spec.sha;
    plan.shaFrom = plan.live ? 'head' : 'pinned';
    p.sha = spec.sha;
    p.shaFrom = plan.shaFrom;
    const home = this.o.paths.home;
    const roots = [this.o.paths.skills, this.o.paths.agents, this.o.paths.commands];
    const underRoots = (to: string) => {
      const dest = join(home, to).replace(/\/+$/, '');
      if (to.split(/[\\/]/).includes('..') || !roots.some((r) => inside(r, dest)) || roots.includes(resolve(dest))) throw new CatalogError(400, `Failed. ${to} is not under skills/, agents/ or commands/.`);
      return dest;
    };
    // a skill folder filled from several repo paths, or with a file Conclave writes, is put together in the stage first and copied as one folder
    const parts = new Map<string, number>();
    for (const to of [...spec.files.map((f) => f.to), ...writes.map((w) => w.to)]) parts.set(installUnit(to), (parts.get(installUnit(to)) ?? 0) + 1);
    const assembled = new Set(
      [...parts].filter(([unit, n]) => n > 1 || writes.some((w) => installUnit(w.to) === unit) || spec.files.some((f) => installUnit(f.to) === unit && trimSlash(f.to) !== unit)).map(([unit]) => unit),
    );
    const assembly = join(plan.stage, 'assembled');
    const files: StagedFile[] = [];
    const inline: string[] = [];
    /** Whether each entry of spec.files is a folder, for the equivalent command. */
    const isDir: boolean[] = [];
    // one staged path: list its files, scripts and inline commands, and stop if someone else's copy is where it goes
    const stage = (src: string, to: string, root: string, rel: string) => {
      const dest = join(home, to);
      const dir = statSync(src).isDirectory();
      files.push({ from: src, to: dest, dir, rel });
      const shown = `~/.conclave/${to}`;
      inline.push(...inlineCommands(src, shown, root));
      if (dir) {
        p.files.push(...listFiles(src, shown, root));
        for (const sc of scriptsIn(src, root)) p.scripts.push(`${to}/${sc}`);
        const skill = join(src, 'SKILL.md');
        if (existsSync(skill) && /disable-model-invocation:\s*true/.test(readFileSync(skill, 'utf8').slice(0, 4000)))
          p.warnings.push({ level: 'info', text: `${basename(dest)} sets disable-model-invocation, which Conclave ignores. The agent may load it on its own.` });
      } else {
        const st = statSync(src);
        p.files.push({ path: shown, bytes: st.size, role: fileRole(to), ...(st.mode & 0o111 ? { executable: true } : {}) });
      }
      const owner = ownedBy(home, dest);
      if (existsSync(dest) && owner !== plan.item.id) {
        p.warnings.unshift({ level: 'risk', text: `${shown} already exists${owner ? ` (added from ${owner})` : ' and Discover did not add it'}. Add stops here so your copy stays.` });
      }
    };
    for (const f of spec.files) {
      let src = join(clone, f.from).replace(/\/+$/, '');
      underRoots(f.to);
      if (!inside(clone, src)) throw new CatalogError(400, `Failed. ${f.from} points outside the repo.`);
      // a linked file or folder counts only when the link stays inside the repo
      if (existsSync(src) && lstatSync(src).isSymbolicLink()) {
        const target = linkTarget(src, clone);
        if (!target) throw new CatalogError(400, `Failed. ${f.from} is a link that points outside the repo.`);
        src = target;
      }
      if (!existsSync(src)) throw new CatalogError(502, `Failed. ${f.from || 'The repo root'} is not in ${spec.repo} at ${short(spec.sha)}.`);
      isDir.push(statSync(src).isDirectory());
      if (!assembled.has(installUnit(f.to))) {
        stage(src, trimSlash(f.to), clone, f.from);
        continue;
      }
      const at = join(assembly, trimSlash(f.to));
      if (existsSync(at)) throw new CatalogError(400, `Failed. Two entries write ${f.to}.`);
      mkdirSync(dirname(at), { recursive: true });
      if (isDir[isDir.length - 1]) copyTree(src, at, clone);
      else copyFileSync(src, at);
    }
    for (const w of writes) {
      underRoots(w.to);
      const at = join(assembly, trimSlash(w.to));
      if (!inside(assembly, at) || existsSync(at)) throw new CatalogError(400, `Failed. ${w.to} is written twice or points outside the install.`);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, w.text);
    }
    for (const unit of assembled) stage(join(assembly, unit), unit, plan.stage, unit);
    for (const w of writes) {
      const row = p.files.find((f) => f.path === `~/.conclave/${trimSlash(w.to)}`);
      if (row) row.written = true;
    }
    plan.files = files;
    if (p.scripts.length) p.warnings.push({ level: 'warn', text: `Brings ${p.scripts.length} script${p.scripts.length > 1 ? 's' : ''} the agent may run when it uses this.` });
    p.warnings.push(...inlineCommandWarnings(inline));
    // an agent profile runs the hooks in its frontmatter whenever the agent runs (extensions/agent-hooks.ts)
    const agentHooks = files.filter((f) => inside(this.o.paths.agents, f.to)).flatMap((f) => agentFileHooks(f.from, f.to.slice(home.length + 1)));
    if (agentHooks.length) {
      p.hooks.push(...agentHooks);
      const names = [...new Set(agentHooks.map((h) => h.plugin))].join(', ');
      p.warnings.push({ level: 'warn', text: `${names} ${agentHooks.length === 1 ? 'runs a hook' : `runs ${agentHooks.length} hooks`} on the hub whenever ${agentHooks.length === 1 ? 'that agent runs' : 'those agents run'}. Read ${agentHooks.length === 1 ? 'it' : 'them'} above before you add it.` });
      p.warnings.push(...hookWarnings(agentHooks, []));
    }
    p.needs = await this.needsRows(plan.item.needs ?? [], plan.options.device);
    const n = spec.files.length;
    p.steps.push({ say: `Copies ${n} ${n === 1 ? 'path' : 'paths'} from ${spec.repo} at ${short(spec.sha)} into ~/.conclave without .git.` });
    if (writes.length) p.steps.push({ say: `Writes ${writes.map((w) => trimSlash(w.to)).join(', ')} from Conclave's catalog entry, not from the repo.` });
    // the same copy by hand: a clone with no blobs, then each path written where Conclave puts it
    const dir = `/tmp/${basename(spec.repo).replace(/[^\w.-]+/g, '-') || 'repo'}`;
    p.equivalent = [
      `git clone -q --filter=blob:none --no-checkout ${shq(url)} ${dir}`,
      ...spec.files.map((f, i) => {
        const from = f.from.replace(/\/+$/, '');
        const to = `~/.conclave/${trimSlash(f.to)}`;
        return isDir[i]
          ? `mkdir -p ${to} && git -C ${dir} archive ${spec.sha}:${shq(from)} | tar -x -C ${to}`
          : `mkdir -p ${dirname(to)} && git -C ${dir} show ${spec.sha}:${shq(from)} > ${to}`;
      }),
      ...writes.map((w) => `cat > ~/.conclave/${trimSlash(w.to)} <<'CONCLAVE_EOF'\n${w.text.replace(/\n$/, '')}\nCONCLAVE_EOF`),
    ].join('\n');
  }

  private async previewHook(plan: Plan, recipeId: string): Promise<void> {
    const p = plan.preview;
    const recipe = HOOK_RECIPES.find((r) => r.id === recipeId);
    if (!recipe) throw new CatalogError(404, `Unknown hook recipe ${recipeId}.`);
    const script = join(this.o.paths.hooks, 'recipes', `${recipe.id}.sh`);
    if (recipe.script) p.files.push({ path: `~/.conclave/hooks/recipes/${recipe.id}.sh`, bytes: Buffer.byteLength(recipe.script), role: 'hook', executable: true });
    for (const h of recipe.handlers) {
      p.hooks.push({
        event: h.event,
        matcher: h.matcher,
        interpreter: h.type === 'prompt' ? 'prompt' : 'bash',
        timeout: h.timeout,
        command: h.type === 'prompt' ? h.prompt : h.command?.replace('{script}', script),
        network: !!recipe.script && /\bcurl\b|\bwget\b|https?:\/\//.test(recipe.script),
        note: recipe.budget,
      });
    }
    plan.inputs = (recipe.env ?? []).map((e) => ({ name: e.name, label: e.name, description: e.description, required: false, secret: false, default: e.default }));
    p.inputs = plan.inputs;
    const target = plan.options.target;
    p.needs = await this.needsRows(
      recipe.needs.map((bin) => ({ bin, where: target ? ('device' as const) : ('hub' as const), why: 'The script calls it.' })),
      target?.device ?? plan.options.device,
    );
    if (plan.item.risk !== recipe.safety) p.warnings.push({ level: 'info', text: recipe.safety });
    if (recipe.handlers.some((h) => h.runOn === 'device') && !target)
      p.warnings.push({ level: 'warn', text: 'Reads the session\'s files. Until hooks run on devices, it only works for sessions on the hub.' });
    if (!this.host.recipes) p.warnings.unshift({ level: 'risk', text: 'This hub cannot add hook recipes yet. Update Conclave, then try again.' });
    p.steps.push({ say: `Writes the script, adds ${recipe.handlers.length} handler${recipe.handlers.length > 1 ? 's' : ''} to ${target ? `${target.cli} on ${target.device}` : plan.options.scope === 'project' ? 'this project' : 'this hub'}, then runs its ${recipe.tests.length} tests.` });
    p.equivalent = JSON.stringify(recipe.handlers.map((h) => ({ event: h.event, matcher: h.matcher, hooks: [{ type: h.type, command: h.command?.replace('{script}', script), timeout: h.timeout }] })), null, 2);
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  private takePlan(planId: string): Plan {
    this.sweep();
    const plan = this.plans.get(planId);
    if (!plan || plan.used) throw new CatalogError(409, 'This preview expired. Open it again.');
    if (plan.expiresAt < this.now()) {
      this.sweep();
      throw new CatalogError(409, 'This preview expired. Open it again.');
    }
    return plan;
  }

  async install(req: CatalogInstallRequest): Promise<CatalogInstallResult> {
    const plan = this.takePlan(req.planId);
    if (plan.update) throw new CatalogError(400, 'This is an update preview. Use Update.');
    const spec = plan.spec;
    if (spec.type === 'routine') throw new CatalogError(400, `Routines are added in the Routines tab: /routines?suggest=${spec.suggestion}`);
    if (spec.type === 'manual') throw new CatalogError(400, 'Nothing to add here. Follow the steps in the preview.');
    if (spec.type === 'mcp') {
      // check the form before the plan is used, so the owner can fill in what is missing and press Add again
      const missing = fillPlaceholders(spec, plan.inputs, req.values ?? {}, (k) => this.host.secrets.has(k)).missing;
      if (missing.length) throw new CatalogError(400, `Fill in ${missing.join(', ')}.`, { missing });
    }
    // taken before the first await, so two presses of Add cannot both install
    plan.used = true;
    try {
      // a plan made from the latest commit is refused when the branch moved since
      if (plan.shaFrom === 'head' && plan.sha && plan.item.repo && spec.type === 'files') {
        const head = await lsRemote(this.o.git, repoUrl(plan.item.repo)).catch(() => undefined);
        if (head && head !== plan.sha) throw new CatalogError(409, `${plan.item.repo} moved from ${short(plan.sha)} to ${short(head)} since the preview. Open it again.`);
      }
      let result: CatalogInstallResult;
      if (spec.type === 'mcp') result = await this.installMcp(plan, spec, req);
      else if (spec.type === 'plugin') result = await this.installPlugins(plan, spec, req);
      else if (spec.type === 'files') result = await this.installFiles(plan, req);
      else result = await this.installRecipe(plan, spec.recipe, req);
      return result;
    } finally {
      rmSync(plan.stage, { recursive: true, force: true });
      this.plans.delete(plan.id);
    }
  }

  private record(plan: Plan, row: Omit<InstallRow, 'installedAt' | 'updatedAt' | 'id' | 'source'>): InstallRow {
    const now = this.now();
    const prev = this.o.store.getInstall(plan.item.id);
    const full: InstallRow = {
      id: plan.item.id,
      source: plan.item.source,
      installedAt: prev?.installedAt ?? now,
      updatedAt: now,
      ...row,
      meta: { ...row.meta, ...(plan.item.source !== 'recommended' ? { item: plan.item } : {}) },
    };
    this.o.store.putInstall(full);
    this.host.audit('catalog.install', `${plan.item.id} ${row.sha ?? row.version ?? ''}`.trim());
    return full;
  }

  private async installMcp(plan: Plan, spec: McpInstall, req: CatalogInstallRequest): Promise<CatalogInstallResult> {
    const values = req.values ?? {};
    const filled = fillPlaceholders(spec, plan.inputs, values, (k) => this.host.secrets.has(k));
    if (filled.missing.length) throw new CatalogError(400, `Fill in ${filled.missing.join(', ')}.`, { missing: filled.missing });
    const name = filled.value.server;
    if (!SERVER_NAME.test(name)) throw new CatalogError(400, `The server name "${name}" may only use letters, digits, _ and -.`);
    const existing = this.host.mcp.get(name);
    if (existing) throw new CatalogError(409, `An MCP server named ${name} is already set up.`);
    const cfg: McpServerConfig = { ...filled.value.config };
    const enable = req.enable !== false;
    if (!enable) cfg.enabled = false;
    // keep what each key held before, so a failed test puts the old values back
    const before = filled.secrets.map((s) => ({ key: s.key, had: this.host.secrets.has(s.key), value: this.host.secrets.has(s.key) ? this.host.secrets.get?.(s.key) : undefined }));
    for (const s of filled.secrets) this.host.secrets.set(s.key, s.value);
    const restoreSecrets = () => {
      for (const b of before) {
        if (!b.had) this.host.secrets.remove(b.key);
        else if (b.value !== undefined) this.host.secrets.set(b.key, b.value);
      }
    };
    this.host.mcp.add(name, cfg);
    const ref: InstalledRef = { id: plan.item.id, kind: 'mcp', ref: name, href: hrefFor('mcp', name), matchedBy: 'record', installedAt: this.now() };
    let test: McpTestResult | undefined;
    const warnings: string[] = [];
    if (enable) {
      test = await this.host.mcp.test(name).catch((err) => ({ ok: false, ms: 0, tools: 0, error: (err as Error).message }));
      if (!test.ok) {
        if (req.saveOnFail) {
          this.host.mcp.update(name, { ...cfg, enabled: false });
          warnings.push('The test failed, so it was saved turned off.');
        } else {
          this.host.mcp.remove(name);
          restoreSecrets();
          this.host.audit('catalog.install-failed', `${plan.item.id}: ${test.error ?? 'test failed'}`);
          return { ok: false, installed: ref, test, warnings: ['Nothing was saved.'], next: [] };
        }
      }
    }
    const version = /@(\d[\w.-]*)$/.exec(cfg.args?.find((a) => /@\d/.test(a)) ?? '')?.[1] ?? /==([\w.-]+)$/.exec(cfg.args?.find((a) => a.includes('==')) ?? '')?.[1];
    this.record(plan, {
      kind: 'mcp',
      ref: name,
      version,
      meta: { name: plan.item.name, repo: plan.item.repo, spec: { ...filled.value, config: cfg }, server: name, secrets: filled.secretKeys },
    });
    const next = [{ label: 'Open in MCP servers', href: ref.href }];
    if (spec.offer?.includes('connect-clis')) next.push({ label: 'Connect to my CLIs', href: `${ref.href}&connect=1` });
    if (spec.offer?.includes('memory-connection')) next.push({ label: 'Use as a memory connection', href: `/memory/connections?add=basic-memory&server=${encodeURIComponent(name)}` });
    return { ok: true, installed: ref, test, warnings, next };
  }

  private async installPlugins(plan: Plan, spec: PluginInstall, req: CatalogInstallRequest): Promise<CatalogInstallResult> {
    const chosen = (plan.plugins ?? []).filter((s) => s.selected);
    if (!chosen.length) throw new CatalogError(400, 'Pick at least one plugin.');
    const warnings: string[] = [];
    const known = new Set(this.host.plugins.marketplaces().map((m) => m.source.toLowerCase()));
    const addedMarketplaces: string[] = [];
    for (const mk of [...new Set(chosen.map((s) => s.marketplace).filter((x): x is string => !!x))]) {
      if (known.has(mk.toLowerCase())) continue;
      try {
        await this.host.plugins.addMarketplace(mk);
        addedMarketplaces.push(mk);
      } catch (err) {
        warnings.push(`Could not add the marketplace ${mk}: ${(err as Error).message}. Updates from it will fail until it is added.`);
      }
    }
    const hooks = plan.options.hooks ?? spec.hooks !== 'off';
    const installed: InstalledPlugin[] = [];
    for (const s of chosen) {
      // owner/repo sources are recorded at their commit, so a later update knows where it came from
      const source = /^[\w.-]+\/[\w.-]+$/.test(s.source) && s.sha ? `${s.source}@${s.sha}` : s.source;
      installed.push(
        await this.host.plugins.installFrom(s.dir, { source, sha: s.sha, hooks, enabled: req.enable !== false, manifest: s.manifest, name: s.name, copyRoot: plan.stage }),
      );
    }
    await this.host.reloadExtensions();
    const first = installed[0];
    this.record(plan, {
      kind: 'plugin',
      ref: first.name,
      sha: first.sha,
      version: first.version,
      filesHash: installed.map((p) => sensitiveHash(p.dir)).join(','),
      meta: {
        name: plan.item.name,
        repo: plan.item.repo,
        spec,
        plugins: installed.map((p) => p.name),
        paths: installed.map((p) => p.dir),
        marketplace: chosen[0].marketplace,
        ...(addedMarketplaces.length ? { addedMarketplaces } : {}),
      },
    });
    const ref: InstalledRef = { id: plan.item.id, kind: 'plugin', ref: first.name, href: hrefFor('plugin', first.name), sha: first.sha, version: first.version, matchedBy: 'record', installedAt: this.now() };
    if (!hooks) warnings.push('Installed with its hooks off.');
    return { ok: true, installed: ref, warnings, next: [{ label: 'Open in Plugins', href: ref.href }] };
  }

  /** Where the copy before an update is kept: outside skills/, agents/, commands/ and plugins/, so nothing loads it. */
  private prevPath(dest: string): string {
    const home = this.o.paths.home;
    const rel = relative(resolve(home), resolve(dest));
    return rel && inside(home, dest) ? join(home, PREV_DIR, rel) : `${dest}.prev`;
  }

  /**
   * Copy staged files to their places. What was there is moved aside first;
   * if any copy fails, everything written is removed and the old copies go
   * back, so a failed install changes nothing.
   */
  private writeFiles(files: StagedFile[], stage: string, after: (f: StagedFile) => void): Array<{ prev: string; dest: string }> {
    const moved: Array<{ prev: string; dest: string }> = [];
    const touched: string[] = [];
    try {
      for (const f of files) {
        if (existsSync(f.to)) {
          const prev = this.prevPath(f.to);
          rmSync(prev, { recursive: true, force: true });
          mkdirSync(dirname(prev), { recursive: true });
          renameSync(f.to, prev);
          moved.push({ prev, dest: f.to });
        }
        touched.push(f.to);
        mkdirSync(dirname(f.to), { recursive: true });
        if (f.dir) copyTree(f.from, f.to, stage);
        else copyFileSync(f.from, f.to);
        after(f);
      }
    } catch (err) {
      for (const t of touched) rmSync(t, { recursive: true, force: true });
      for (const m of moved) renameSync(m.prev, m.dest);
      throw new CatalogError(500, `Failed. ${(err as Error).message}. Nothing was changed.`);
    }
    return moved;
  }

  private async installFiles(plan: Plan, req: CatalogInstallRequest): Promise<CatalogInstallResult> {
    const files = plan.files ?? [];
    const home = this.o.paths.home;
    for (const f of files) {
      const owner = ownedBy(home, f.to);
      if (existsSync(f.to) && owner !== plan.item.id) throw new CatalogError(409, `${f.to} already exists${owner ? ` (added from ${owner})` : ''}. Remove it first.`);
    }
    const now = this.now();
    const idx = readIndex(home);
    const written: string[] = [];
    const moved = this.writeFiles(files, plan.stage, (f) => {
      if (f.dir) {
        writeFileSync(join(f.to, MARKER), JSON.stringify({ id: plan.item.id, repo: (plan.spec as FilesInstall).repo, sha: plan.sha, installedAt: now, files: walkFiles(f.to) }, null, 2) + '\n');
      } else {
        idx[resolve(f.to)] = { id: plan.item.id, repo: (plan.spec as FilesInstall).repo, sha: plan.sha, installedAt: now };
      }
      written.push(f.to);
    });
    writeIndex(home, idx);
    await this.host.reloadExtensions();
    const warnings: string[] = [];
    if (req.syncClis && this.host.syncClis) {
      try {
        const out = await this.host.syncClis(req.syncClis.device, req.syncClis.clis);
        warnings.push(`Synced ${out.length} files to ${req.syncClis.clis.join(', ')} on ${req.syncClis.device}.`);
      } catch (err) {
        warnings.push(`Sync to ${req.syncClis.device} failed: ${(err as Error).message}`);
      }
    }
    const kind = plan.item.kind === 'plugin' ? 'skill' : plan.item.kind;
    const first = written[0];
    const refName = basename(first).replace(/\.md$/, '');
    this.record(plan, {
      kind,
      ref: refName,
      sha: plan.sha,
      filesHash: written.map((w) => sensitiveHash(existsSync(w) && statSync(w).isDirectory() ? w : dirname(w))).join(','),
      meta: { name: plan.item.name, repo: (plan.spec as FilesInstall).repo, spec: plan.spec, paths: written },
    });
    const ref: InstalledRef = { id: plan.item.id, kind, ref: refName, href: hrefFor(kind, refName), sha: plan.sha, matchedBy: 'record', installedAt: now };
    // a reinstall over Discover's own copy keeps no earlier version
    for (const m of moved) rmSync(m.prev, { recursive: true, force: true });
    return { ok: true, installed: ref, warnings, next: [{ label: `Open in ${kind === 'skill' ? 'Skills' : kind === 'subagent' ? 'Agents' : 'Commands'}`, href: ref.href }] };
  }

  private async installRecipe(plan: Plan, recipeId: string, req: CatalogInstallRequest): Promise<CatalogInstallResult> {
    if (!this.host.recipes) throw new CatalogError(501, 'This hub cannot add hook recipes yet. Update Conclave, then try again.');
    const recipe = HOOK_RECIPES.find((r) => r.id === recipeId)!;
    const env: Record<string, string> = {};
    for (const e of recipe.env ?? []) {
      const v = req.values?.[e.name];
      if (v !== undefined && v !== '' && v !== e.default) env[e.name] = v;
    }
    const res = await this.host.recipes.install(recipeId, { scope: plan.options.scope ?? 'user', cwd: plan.options.cwd, env, target: plan.options.target });
    const where = { scope: plan.options.scope ?? 'user', ...(plan.options.cwd ? { cwd: plan.options.cwd } : {}), ...(plan.options.target ? { target: plan.options.target } : {}) } as const;
    this.record(plan, { kind: 'hook', ref: recipeId, meta: { name: recipe.title, spec: plan.spec, where } });
    const ref: InstalledRef = { id: plan.item.id, kind: 'hook', ref: recipeId, href: hrefFor('hook', recipeId), matchedBy: 'record', installedAt: this.now() };
    const failed = res.tests.filter((t) => !t.ok).length;
    return {
      ok: true,
      installed: ref,
      recipeTests: res.tests,
      warnings: failed ? [`${failed} of ${res.tests.length} tests failed. The hook is installed; remove it if the failures matter.`] : [],
      next: [{ label: 'Open in Hooks', href: ref.href }],
    };
  }

  // -------------------------------------------------------------------------
  // Installed state
  // -------------------------------------------------------------------------

  /** Installed by name, for items Discover did not install (no update tracking). */
  matchByName(item: CatalogItem): InstalledRef | undefined {
    const ref = (kind: CatalogKind, name: string): InstalledRef => ({ id: item.id, kind, ref: name, href: hrefFor(kind, name), matchedBy: 'name' });
    const spec = item.install;
    switch (spec.type) {
      case 'mcp': {
        if (spec.server.includes('{{')) return undefined;
        // a memory server connected under Memory, Connections (Basic Memory as a basic-memory connection) is installed too
        if (spec.offer?.includes('memory-connection')) {
          const conn = this.host.memoryConnections?.().find((c) => c.enabled !== false && (c.type === spec.server || c.options?.server === spec.server));
          if (conn) return { id: item.id, kind: 'mcp', ref: conn.id, href: '/memory/connections', matchedBy: 'name' };
        }
        const cfg = this.host.mcp.get(spec.server);
        if (!cfg) return undefined;
        const sameCmd = !!cfg.command && cfg.command === spec.config.command && (cfg.args ?? []).some((a) => (spec.config.args ?? []).slice(0, 3).includes(a));
        const sameUrl = !!cfg.url && !!spec.config.url && cfg.url.split('?')[0] === spec.config.url.split('?')[0];
        return sameCmd || sameUrl ? ref('mcp', spec.server) : undefined;
      }
      case 'plugin': {
        const names = spec.plugins.map((s) => (s.includes('@') && !s.includes('/') ? s.split('@')[0] : s.split('/')[1]?.split(/[@#]/)[0] ?? s));
        const have = this.host.plugins.list().find((p) => names.includes(p.name));
        return have ? { ...ref('plugin', have.name), sha: have.sha, version: have.version } : undefined;
      }
      case 'files': {
        const f = spec.files[0];
        if (!f) return undefined;
        const dest = join(this.o.paths.home, installUnit(f.to));
        if (!existsSync(dest)) return undefined;
        const kind = f.to.startsWith('skills/') ? 'skill' : f.to.startsWith('agents/') ? 'subagent' : 'command';
        return ref(kind, basename(dest).replace(/\.md$/, ''));
      }
      case 'hook': {
        const hooks = this.host.hooks();
        for (const groups of Object.values(hooks ?? {})) {
          for (const g of (groups ?? []) as unknown as Array<{ hooks?: Array<Record<string, unknown>> }>) {
            if ((g.hooks ?? []).some((h) => h.recipe === spec.recipe || (typeof h.command === 'string' && h.command.includes(`/recipes/${spec.recipe}.sh`)))) return ref('hook', spec.recipe);
          }
        }
        return undefined;
      }
      case 'routine': {
        const r = this.host.routines().find((x) => x.suggestion === spec.suggestion);
        return r ? { ...ref('routine', r.id), href: `/routines/${encodeURIComponent(r.id)}` } : undefined;
      }
      default:
        return undefined;
    }
  }

  refFromRow(row: InstallRow): InstalledRef {
    return { id: row.id, kind: row.kind, ref: row.ref, href: hrefFor(row.kind, row.ref), sha: row.sha, version: row.version, installedAt: row.installedAt, matchedBy: 'record' };
  }

  private rowToInstalled(row: InstallRow): InstalledCatalogItem {
    return {
      ...this.refFromRow(row),
      name: row.meta.name,
      source: row.source,
      upstreamSha: row.upstreamSha,
      updateAvailable: !!row.upstreamSha && row.upstreamSha !== (row.sha ?? row.version),
      checkedAt: row.checkedAt,
      previous: row.previous ? { sha: row.previous.sha ?? row.previous.version, at: row.previous.at } : undefined,
    };
  }

  installed(): InstalledCatalogItem[] {
    this.sweep();
    return this.o.store.listInstalls().map((r) => this.rowToInstalled(r));
  }

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------

  /** Latest upstream for one install: a commit for git items, a version for pinned npx and uvx servers. */
  private async upstreamOf(row: InstallRow): Promise<string | undefined> {
    const spec = row.meta.spec;
    if (row.kind === 'mcp' && spec?.type === 'mcp') {
      const args = spec.config.args ?? [];
      const npm = args.map((a) => /^(@?[^@\s]+)@(\d[\w.-]*)$/.exec(a)).find(Boolean);
      if (spec.config.command === 'npx' && npm) {
        const { data } = await this.o.http.json<{ version?: string }>(`https://registry.npmjs.org/${npm[1].replace('/', '%2F')}/latest`, { ttlMs: 6 * 3_600_000, maxBytes: 5_000_000 });
        return data?.version;
      }
      const py = args.map((a) => /^([\w.-]+)==([\w.-]+)$/.exec(a)).find(Boolean);
      if (spec.config.command === 'uvx' && py) {
        const { data } = await this.o.http.json<{ info?: { version?: string } }>(`https://pypi.org/pypi/${py[1]}/json`, { ttlMs: 6 * 3_600_000, maxBytes: 20_000_000 });
        return data?.info?.version;
      }
      return undefined;
    }
    if (!row.sha) return undefined;
    if (spec?.type === 'files') return lsRemote(this.o.git, repoUrl(spec.repo));
    if (spec?.type === 'plugin') {
      const first = spec.plugins[0];
      const mk = /^[^@/]+@/.test(first) ? (spec.marketplace ?? KNOWN_MARKETPLACES.find((k) => k.name === first.split('@')[1])?.source) : undefined;
      if (mk) {
        const head = await lsRemote(this.o.git, repoUrl(mk));
        const m = head ? await readMarketplace(this.o.http, mk, head) : undefined;
        const entry = m?.plugins?.find((e) => e.name === first.split('@')[0]);
        if (!entry) return head;
        const src = resolveEntrySource(entry, mk, m?.metadata?.pluginRoot);
        if (src.local) return head;
        if (isFullSha(src.sha)) return src.sha;
        return safeGitUrl(src.url) ? lsRemote(this.o.git, src.url, src.ref ?? 'HEAD') : undefined;
      }
      const repo = /^([\w.-]+\/[\w.-]+)/.exec(first)?.[1];
      return repo ? lsRemote(this.o.git, repoUrl(repo)) : undefined;
    }
    return undefined;
  }

  async checkUpdates(): Promise<InstalledCatalogItem[]> {
    for (const row of this.o.store.listInstalls()) {
      try {
        const up = await this.upstreamOf(row);
        this.o.store.putInstall({ ...row, upstreamSha: up ?? row.upstreamSha, checkedAt: this.now() });
      } catch {
        this.o.store.putInstall({ ...row, checkedAt: this.now() });
      }
    }
    return this.installed();
  }

  private requireRow(id: string): InstallRow {
    const row = this.o.store.getInstall(id);
    if (!row) throw new CatalogError(404, `Discover did not add ${id}. Change it in its own tab.`);
    return row;
  }

  async updatePreview(id: string): Promise<UpdatePreview> {
    const row = this.requireRow(id);
    const spec = row.meta.spec;
    if (!spec) throw new CatalogError(400, 'Nothing is known about how this was added.');
    if (spec.type === 'hook') throw new CatalogError(400, 'Hook recipes update with Conclave itself.');
    const item = this.o.itemFor(id) ?? row.meta.item;
    if (!item) throw new CatalogError(404, `${id} is no longer in the catalog.`);
    const upstream = await this.upstreamOf(row);
    if (!upstream) throw new CatalogError(502, 'Could not read the latest version.');
    const from = row.sha ?? row.version ?? '';
    if (upstream === from) throw new CatalogError(409, 'Already up to date.');
    if (spec.type === 'mcp') {
      const cfg = structuredClone(spec.config);
      cfg.args = (cfg.args ?? []).map((a) => a.replace(/^(@?[^@\s]+)@\d[\w.-]*$/, `$1@${upstream}`).replace(/^([\w.-]+)==[\w.-]+$/, `$1==${upstream}`));
      const before = JSON.stringify(spec.config, null, 2);
      const after = JSON.stringify(cfg, null, 2);
      const preview = await this.preview({ ...item, install: { ...spec, config: cfg }, variants: undefined, inputs: [] }, { id }, { update: true });
      const plan = this.plans.get(preview.planId)!;
      plan.spec = { ...spec, config: cfg };
      const changes: UpdatePreview = {
        planId: plan.id,
        from,
        to: upstream,
        changes: [{ path: `mcpServers.${spec.server}`, change: 'modified', executable: false, diff: createTwoFilesPatch('before', 'after', before, after) }],
        hooksChanged: false,
        mcpChanged: true,
        scriptsChanged: false,
        needsReview: true,
        warnings: [{ level: 'info', text: `${spec.server} moves from ${from} to ${upstream}. Conclave tests the connection after the change.` }],
      };
      plan.update = { installId: id, changes };
      return changes;
    }
    // git items: preview the latest commit, then diff it against what is installed
    let next: InstallSpec;
    if (spec.type === 'files') next = { ...spec, sha: upstream };
    else next = { ...(spec as PluginInstall), sha: undefined };
    const preview = await this.preview({ ...item, install: next, variants: undefined }, { id, options: { hooks: true, plugins: spec.type === 'plugin' ? spec.plugins : undefined } }, { update: true });
    const plan = this.plans.get(preview.planId)!;
    const pairs: Array<{ oldDir: string; newDir: string; label: string }> = [];
    if (spec.type === 'files') {
      for (const f of plan.files ?? []) pairs.push({ oldDir: f.dir ? f.to : dirname(f.to), newDir: f.dir ? f.from : dirname(f.from), label: relative(this.o.paths.home, f.to) });
    } else {
      for (const s of (plan.plugins ?? []).filter((x) => x.selected)) pairs.push({ oldDir: join(this.o.paths.plugins, s.name), newDir: s.dir, label: `plugins/${s.name}` });
    }
    const changes: UpdatePreview['changes'] = [];
    for (const pair of pairs) {
      const a = new Set(walkFiles(pair.oldDir).filter((r) => r !== MARKER));
      const b = new Set(walkFiles(pair.newDir, plan.stage));
      for (const rel of new Set([...a, ...b])) {
        if (!isSensitivePath(rel) && !/(^|\/)SKILL\.md$/.test(rel)) continue;
        const oldText = a.has(rel) ? readFileSync(join(pair.oldDir, rel), 'utf8') : '';
        const newText = b.has(rel) ? readFileSync(join(pair.newDir, rel), 'utf8') : '';
        if (a.has(rel) && b.has(rel) && oldText === newText) continue;
        let exec = false;
        try {
          exec = !!(statSync(join(b.has(rel) ? pair.newDir : pair.oldDir, rel)).mode & 0o111);
        } catch {
          /* gone */
        }
        changes.push({
          path: `${pair.label}/${rel}`,
          change: !a.has(rel) ? 'added' : !b.has(rel) ? 'removed' : 'modified',
          executable: exec,
          diff: oldText.length + newText.length < 200_000 ? createTwoFilesPatch(`a/${rel}`, `b/${rel}`, oldText, newText) : undefined,
        });
      }
    }
    const hooksChanged = changes.some((c) => /(^|\/)hooks\//.test(c.path) || /plugin\.json$/.test(c.path));
    const mcpChanged = changes.some((c) => /\.mcp\.json$/.test(c.path));
    const scriptsChanged = changes.some((c) => c.executable || /(^|\/)(scripts|bin)\//.test(c.path) || /\.(sh|bash|ps1)$/.test(c.path) || /package\.json$/.test(c.path));
    const up: UpdatePreview = {
      planId: plan.id,
      from,
      to: plan.sha ?? upstream,
      changes,
      hooksChanged,
      mcpChanged,
      scriptsChanged,
      needsReview: hooksChanged || mcpChanged || scriptsChanged,
      warnings: preview.warnings,
    };
    plan.update = { installId: id, changes: up };
    return up;
  }

  async update(id: string, planId: string): Promise<InstalledCatalogItem> {
    const plan = this.takePlan(planId);
    if (plan.update?.installId !== id) throw new CatalogError(400, 'This plan is not an update for that item.');
    const row = this.requireRow(id);
    plan.used = true;
    try {
      const spec = plan.spec;
      const previous = { sha: row.sha, version: row.version, at: this.now(), meta: row.meta };
      if (spec.type === 'mcp') {
        const name = row.meta.server ?? row.ref;
        const cur = this.host.mcp.get(name);
        if (!cur) throw new CatalogError(404, `${name} is no longer set up.`);
        const cfg = { ...cur, args: spec.config.args };
        this.host.mcp.update(name, cfg);
        const version = plan.update.changes.to;
        this.o.store.putInstall({ ...row, version, updatedAt: this.now(), previous, upstreamSha: version, meta: { ...row.meta, spec: { ...(row.meta.spec as McpInstall), config: cfg } } });
      } else if (spec.type === 'plugin') {
        const current = new Map(this.host.plugins.list().map((p) => [p.name, p]));
        const prevPairs: Array<{ prev: string; dest: string }> = [];
        let sha: string | undefined;
        for (const s of (plan.plugins ?? []).filter((x) => x.selected)) {
          const cur = current.get(s.name);
          if (cur && existsSync(cur.dir)) {
            const prev = this.prevPath(cur.dir);
            rmSync(prev, { recursive: true, force: true });
            mkdirSync(dirname(prev), { recursive: true });
            copyTree(cur.dir, prev);
            prevPairs.push({ prev, dest: cur.dir });
          }
          const source = cur?.source ?? s.source;
          const p = await this.host.plugins.installFrom(s.dir, { source, sha: s.sha, hooks: cur?.hooksEnabled !== false, enabled: cur?.enabled ?? true, manifest: s.manifest, name: s.name, copyRoot: plan.stage });
          sha ??= p.sha;
        }
        await this.host.reloadExtensions();
        this.o.store.putInstall({ ...row, sha, updatedAt: this.now(), previous, upstreamSha: sha, meta: { ...row.meta, prevPaths: undefined, prevPairs } });
      } else if (spec.type === 'files') {
        const idx = readIndex(this.o.paths.home);
        const prevPairs = this.writeFiles(plan.files ?? [], plan.stage, (f) => {
          if (f.dir) writeFileSync(join(f.to, MARKER), JSON.stringify({ id, repo: spec.repo, sha: plan.sha, installedAt: this.now(), files: walkFiles(f.to) }, null, 2) + '\n');
          else idx[resolve(f.to)] = { id, repo: spec.repo, sha: plan.sha, installedAt: this.now() };
        });
        writeIndex(this.o.paths.home, idx);
        await this.host.reloadExtensions();
        this.o.store.putInstall({ ...row, sha: plan.sha, updatedAt: this.now(), previous, upstreamSha: plan.sha, meta: { ...row.meta, spec: { ...spec }, prevPaths: undefined, prevPairs } });
      }
      this.host.audit('catalog.update', `${id} ${previous.sha ?? previous.version ?? ''} -> ${plan.update.changes.to}`);
      return this.rowToInstalled(this.requireRow(id));
    } finally {
      rmSync(plan.stage, { recursive: true, force: true });
      this.plans.delete(plan.id);
    }
  }

  async rollback(id: string): Promise<InstalledCatalogItem> {
    const row = this.requireRow(id);
    const prev = row.previous;
    if (!prev) throw new CatalogError(409, 'There is no earlier version to go back to.');
    if (row.kind === 'mcp') {
      const name = row.meta.server ?? row.ref;
      const old = prev.meta?.spec;
      if (!old || old.type !== 'mcp') throw new CatalogError(409, 'The earlier config was not kept.');
      const cur = this.host.mcp.get(name);
      this.host.mcp.update(name, { ...(cur ?? {}), ...old.config, enabled: cur?.enabled });
    } else {
      const pairs = prevPairsOf(row.meta);
      for (const pr of pairs) if (!existsSync(pr.prev)) throw new CatalogError(409, 'The earlier copy is gone.');
      if (row.kind === 'plugin') {
        const current = new Map(this.host.plugins.list().map((p) => [p.name, p]));
        for (const pr of pairs) {
          const name = basename(pr.dest);
          const cur = current.get(name);
          await this.host.plugins.installFrom(pr.prev, { source: cur?.source ?? name, sha: prev.sha, hooks: cur?.hooksEnabled !== false, enabled: cur?.enabled ?? true, name });
          rmSync(pr.prev, { recursive: true, force: true });
        }
      } else {
        for (const pr of pairs) {
          rmSync(pr.dest, { recursive: true, force: true });
          renameSync(pr.prev, pr.dest);
        }
      }
      await this.host.reloadExtensions();
    }
    this.o.store.putInstall({ ...row, sha: prev.sha, version: prev.version, previous: undefined, updatedAt: this.now(), meta: { ...(prev.meta ?? row.meta), prevPaths: undefined, prevPairs: undefined } });
    this.host.audit('catalog.rollback', `${id} -> ${prev.sha ?? prev.version ?? ''}`);
    return this.rowToInstalled(this.requireRow(id));
  }

  // -------------------------------------------------------------------------
  // Remove
  // -------------------------------------------------------------------------

  async remove(id: string, opts: { secrets?: boolean; scope?: string; cwd?: string } = {}): Promise<{ ok: true; removed: string[] }> {
    const row = this.requireRow(id);
    const removed: string[] = [];
    if (row.kind === 'routine') throw new CatalogError(400, 'Remove routines in the Routines tab.');
    if (row.kind === 'mcp') {
      const name = row.meta.server ?? row.ref;
      if (this.host.mcp.get(name) && this.host.mcp.remove(name)) removed.push(`mcpServers.${name}`);
      if (opts.secrets) for (const k of row.meta.secrets ?? []) if (this.host.secrets.has(k)) {
        this.host.secrets.remove(k);
        removed.push(`secret ${k}`);
      }
    } else if (row.kind === 'plugin' && row.meta.plugins) {
      for (const name of row.meta.plugins) if (await this.host.plugins.remove(name)) removed.push(`plugin ${name}`);
      for (const pr of prevPairsOf(row.meta)) rmSync(pr.prev, { recursive: true, force: true });
      // a marketplace this install added goes too, once no plugin and no other Discover install uses it
      for (const src of row.meta.addedMarketplaces ?? []) {
        const mk = this.host.plugins.marketplaces().find((m) => m.source.toLowerCase() === src.toLowerCase());
        if (!mk || !this.host.plugins.removeMarketplace) continue;
        const usedByPlugin = this.host.plugins.list().some((p) => p.source.endsWith(`@${mk.name}`));
        const usedByInstall = this.o.store.listInstalls().some((r) => r.id !== id && (r.meta.marketplace ?? '').toLowerCase() === src.toLowerCase());
        if (usedByPlugin || usedByInstall) continue;
        if (await this.host.plugins.removeMarketplace(src).catch(() => false)) removed.push(`marketplace ${src}`);
      }
      await this.host.reloadExtensions();
    } else if (row.kind === 'hook') {
      if (!this.host.recipes) throw new CatalogError(501, 'This hub cannot remove hook recipes yet. Remove the handlers in Hooks.');
      // remove from where it was added, unless the caller names another place
      const w = row.meta.where;
      const target = opts.scope || opts.cwd ? undefined : w?.target;
      await this.host.recipes.remove(row.ref, {
        scope: opts.scope ?? w?.scope,
        cwd: opts.cwd ?? (opts.scope ? undefined : w?.cwd),
        ...(target ? { cli: target.cli, device: target.device } : {}),
      });
      removed.push(`recipe ${row.ref}`);
    } else {
      const home = this.o.paths.home;
      const idx = readIndex(home);
      for (const p of row.meta.paths ?? []) {
        // only what Conclave wrote, and only while its marker still says so
        if (ownedBy(home, p) !== id) continue;
        rmSync(p, { recursive: true, force: true });
        delete idx[resolve(p)];
        removed.push(p);
      }
      for (const pr of prevPairsOf(row.meta)) rmSync(pr.prev, { recursive: true, force: true });
      writeIndex(home, idx);
      await this.host.reloadExtensions();
    }
    this.o.store.deleteInstall(id);
    this.host.audit('catalog.remove', `${id}: ${removed.join(', ') || 'nothing left to remove'}`);
    return { ok: true, removed };
  }
}

export type { InstallMeta, PreviewFile, PreviewHook, PreviewWarning };
