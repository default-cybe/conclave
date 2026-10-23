/**
 * Discover catalog DTOs for the hub API (docs/design/ECOSYSTEM.md section 2.1).
 * Type-only, so the client can re-export them for the browser.
 */
import type { CatalogCategory, CatalogInput, CatalogItem, CatalogKind, CatalogNeed, HookSummary, InstallSpec, Touch } from './recommended';
import type { McpServerConfig } from '../config/schema';
import type { HookTraceDto, McpTestResult } from '../client';
import type { HubSetupOffer } from './hub-setup';

export type { CatalogCategory, CatalogInput, CatalogItem, CatalogKind, CatalogNeed, CatalogSource, HookSummary, InstallSpec, SetupStep, Touch } from './recommended';
export type { HubByHand, HubSetupCommand, HubSetupOffer, HubSetupRefusal, HubSetupTarget } from './hub-setup';

export interface CatalogQuery {
  kind?: CatalogKind;
  q?: string;
  category?: CatalogCategory;
  recommended?: boolean;
  installed?: boolean;
  cursor?: string;
  limit?: number;
}

export interface InstalledRef {
  id: string;
  kind: CatalogKind;
  /** Server name, plugin name, skill folder, agent or command name, recipe id, or routine id. */
  ref: string;
  /** Where it lives in the app, e.g. "/extensions/mcp?server=github". */
  href: string;
  sha?: string;
  version?: string;
  installedAt?: number;
  /** record: Discover installed it. name: found by name, no update tracking. */
  matchedBy: 'record' | 'name';
}

export interface CatalogItemDto extends CatalogItem {
  installed?: InstalledRef;
  updateAvailable?: boolean;
  /**
   * needs checked on the hub; device needs show as unknown until a device is picked.
   * hubSetup: what "Install on the hub" would run for the missing hub needs, set when some are missing.
   */
  ready: { ok: boolean; missing: CatalogNeed[]; hubSetup?: HubSetupOffer };
  /** Stars refreshed in the last 24 hours. */
  starsLive?: boolean;
}

export interface GithubRate {
  authenticated: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the core limit resets. 0 when unknown. */
  resetAt: number;
  searchRemaining?: number;
  /** Set while the hub waits out a 403 or 429. Epoch ms. */
  blockedUntil?: number;
}

export interface CatalogSourceStatus {
  id: string;
  label: string;
  on: boolean;
  items: number;
  lastFetch?: number;
  lastError?: string;
}

export interface CatalogStatus {
  sources: CatalogSourceStatus[];
  github: GithubRate;
  lastRefresh?: number;
  cache: { items: number; bytes: number };
  /** True when the last live call failed for a network reason. */
  offline?: boolean;
}

export interface CatalogPage {
  items: CatalogItemDto[];
  total: number;
  next?: string;
  status: CatalogStatus;
}

export interface CatalogSearchQuery {
  q: string;
  kind?: CatalogKind;
  sort?: 'stars' | 'updated';
  page?: number;
}

export interface CatalogSearchResult {
  items: CatalogItemDto[];
  page: number;
  more: boolean;
  from: Array<'github' | 'mcp-registry' | 'marketplace' | 'cache'>;
  /** Set when results are partial: "GitHub limit reached. Showing saved results until 14:05." */
  note?: string;
}

export interface CatalogDetail extends CatalogItemDto {
  /** First 8 KB of the README as markdown. */
  readme?: string;
  manifest?: Record<string, unknown>;
  tree?: { kinds: CatalogKind[]; files: number; bytes: number };
}

export interface CatalogPreviewRequest {
  id: string;
  /** Index into [install, ...variants]. Default 0. */
  variant?: number;
  /** For live gh: items with several kinds. */
  kind?: CatalogKind;
  options?: {
    /** Plugins to install from PluginInstall.plugins. Default all. */
    plugins?: string[];
    hooks?: boolean;
    toolPreset?: string;
    /** Recipes: user or project scope, or another CLI on a device. */
    scope?: 'user' | 'project';
    cwd?: string;
    target?: { cli: 'claude-code' | 'codex' | 'gemini'; device: string };
    /** Device for device needs and device-side steps. */
    device?: string;
  };
}

export interface PreviewFile {
  path: string;
  bytes: number;
  role: 'skill' | 'agent' | 'command' | 'hook' | 'script' | 'manifest' | 'mcp' | 'other';
  /** Has the executable bit set in the repo. */
  executable?: boolean;
  /** Written by Conclave from the catalog entry, not copied from the repo. */
  written?: boolean;
}

export interface PreviewWarning {
  level: 'info' | 'warn' | 'risk';
  text: string;
}

export interface PreviewHook extends HookSummary {
  command?: string;
  plugin?: string;
  network?: boolean;
}

export interface InstallPreview {
  planId: string;
  expiresAt: number;
  item: CatalogItemDto;
  variant: number;
  variants: Array<{ index: number; label: string; type: InstallSpec['type'] }>;
  /** Full commit to install, and how it was picked. */
  sha?: string;
  shaFrom?: 'pinned' | 'head';
  /** hub: for a step that runs on the hub, what "Install on the hub" would run, or why it cannot. */
  steps: Array<{ say: string; run?: string; on?: 'hub' | 'device'; hub?: HubSetupOffer }>;
  inputs: CatalogInput[];
  /** Paths under ~/.conclave. */
  files: PreviewFile[];
  totalBytes: number;
  /** MCP: the config that will be saved, secrets shown as ${secret:key}. */
  config?: McpServerConfig;
  /** The same change as a CLI command, for copy. */
  equivalent?: string;
  hooks: PreviewHook[];
  mcpServers: Array<{ name: string; config: McpServerConfig }>;
  scripts: string[];
  license?: string;
  licenseOsi?: boolean;
  needs: Array<CatalogNeed & { found: boolean | null; checkedOn: string }>;
  touches: Touch[];
  warnings: PreviewWarning[];
  scan?: { tool: 'skillspector' | 'agnix'; findings: Array<{ level: 'info' | 'warn' | 'risk'; file: string; line?: number; text: string }> };
  /** Plugins: the plugins the install covers, with their marketplace entry name. */
  plugins?: Array<{ source: string; name: string; description?: string; selected: boolean }>;
  /** Routines open the Routines tab instead of installing here. */
  handoff?: { label: string; href: string };
}

export interface CatalogInstallRequest {
  planId: string;
  /** Input values by name. */
  values?: Record<string, string>;
  /** Turn it on right away. Default true; false installs it disabled. */
  enable?: boolean;
  /** MCP: keep the server even when the test connect fails (saved disabled). */
  saveOnFail?: boolean;
  syncClis?: { device: string; clis: Array<'claude' | 'codex' | 'opencode' | 'gemini'> };
}

export interface RecipeTestResult {
  name: string;
  ok: boolean;
  why?: string;
  trace?: HookTraceDto;
}

export interface CatalogInstallResult {
  ok: boolean;
  installed: InstalledRef;
  test?: McpTestResult;
  recipeTests?: RecipeTestResult[];
  warnings: string[];
  /** Links for the done state: "Open in MCP servers", "Connect to my CLIs". */
  next: Array<{ label: string; href: string }>;
}

/**
 * POST /api/catalog/items/:id/setup. step (with variant) runs that setup step;
 * bin installs one missing need; neither installs every missing hub need.
 * commands: the runs the owner confirmed. When the hub would now run
 * something else it answers 409 with the new offer instead of running.
 */
export interface CatalogSetupRequest {
  step?: number;
  variant?: number;
  bin?: string;
  commands?: string[];
}

export interface CatalogSetupResult {
  ok: boolean;
  /** Exit code of the last command that ran. null when it was stopped (timeout). */
  exitCode: number | null;
  timedOut?: boolean;
  /** The commands that ran, in order. When ok is false the last one failed. */
  ran: string[];
  user: string;
  /** The last 200 lines of output, stdout and stderr in the order they came, each command after a "$ command" line. */
  tail: string;
  durationMs: number;
  /** Readiness checked again after the run. */
  ready: CatalogItemDto['ready'];
  /** For example: it landed in ~/.local/bin, which is not on the hub's PATH. */
  note?: string;
}

export interface InstalledCatalogItem extends InstalledRef {
  name: string;
  source: string;
  upstreamSha?: string;
  updateAvailable: boolean;
  checkedAt?: number;
  previous?: { sha?: string; at: number };
}

export interface UpdatePreview {
  planId: string;
  from: string;
  to: string;
  changes: Array<{ path: string; change: 'added' | 'removed' | 'modified'; executable: boolean; diff?: string }>;
  hooksChanged: boolean;
  mcpChanged: boolean;
  scriptsChanged: boolean;
  /** True when hooks, MCP servers or scripts changed: the UI asks again. */
  needsReview: boolean;
  warnings: PreviewWarning[];
}

// ---------------------------------------------------------------------------
// Task import (section 1.10)
// ---------------------------------------------------------------------------

export interface TaskImportRequest {
  from: 'agentic-tools-mcp';
  /** Device that holds the folder. Default "local" (the hub). */
  device?: string;
  /** Project folder that holds .agentic-tools-mcp/. */
  path: string;
  dryRun?: boolean;
}

export interface TaskDraft {
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'done';
  priority: number;
  labels: string[];
  project?: string;
  meta: Record<string, unknown>;
}

export interface TaskImportResult {
  projects: number;
  tasks: number;
  memories: number;
  skipped: string[];
  preview?: TaskDraft[];
}
