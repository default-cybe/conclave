/**
 * Mock routes. Discover (docs/design/ECOSYSTEM.md section 2): the catalog
 * and hook recipes, served from the data that ships with
 * the hub (RECOMMENDED, HOOK_RECIPES, ROUTINE_SUGGESTIONS), plus a few live
 * GitHub results taken from the recorded search fixtures of 2026-10-17.
 *
 * The world: hub madx has node, uvx, docker, git, jq and python3, but no npx
 * (the playwright server fails for that reason in the MCP mock), no rtk and
 * no semgrep. GitHub is unauthenticated with 54 of 60 calls left; a search
 * spends one call, a repeated search is served from the cache. Saving the
 * secret catalog.github-token (or github-pat) signs it in.
 *
 * Installed state is read from the other mocks at request time: MCP servers
 * by key, plugins by name, recipes by the "recipe" tag on a hook handler,
 * routines by their suggestion id. superpowers counts as installed from
 * Discover at an older commit, so its row offers an update.
 *
 * Search words: "limit" shows the rate limit note, "offline" fails the way an
 * unreachable GitHub does. Live results' dates and some descriptions are
 * written for the mock.
 */
import type { HookCommand, HookEvent, McpServerConfig } from '@conclave/core/config/schema';
import type { AgentDef, InstalledPlugin } from '@conclave/core/extensions/types';
import type { Routine } from '@conclave/core/types';
import { PINS, RECOMMENDED, type CatalogCategory, type CatalogInput, type CatalogItem, type CatalogKind, type CatalogNeed, type InstallSpec, type Touch } from '@conclave/core/catalog/recommended';
import { hubSetupOffer, type HubFacts, type HubSetupTarget } from '@conclave/core/catalog/hub-setup';
import { HOOK_RECIPES, type HookRecipe } from '@conclave/core/extensions/hook-recipes';
import { ROUTINE_SUGGESTIONS, type RoutineSuggestion } from '@conclave/core/scheduler/suggestions';
import type {
  CatalogDetail,
  CatalogInstallResult,
  CatalogItemDto,
  CatalogStatus,
  HookRecipeDto,
  InstallPreview,
  InstalledCatalogItem,
  InstalledRef,
  PreviewFile,
  PreviewWarning,
  RecipeInstall,
  RecipeTestResult,
  UpdatePreview,
} from '@conclave/core/client';
import type { MockCtx } from './index';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HUB = 'madx';
const CH = '/root/.conclave';
const STARS_AT = '2026-10-17';

/** Programs on the hub. Everything else is missing. */
const HUB_HAS = new Set(['bash', 'git', 'jq', 'grep', 'node', 'uvx', 'docker', 'curl', 'python3', 'conclave', 'sh']);
/** A recipe need such as "jq 1.6+" or "grep -P", checked by its program. */
const hubHas = (need: string) => HUB_HAS.has(need.trim().split(/\s+/)[0]);
/** "Install on the hub" plans with the hub's own planner over HUB_HAS; a run adds what it gave. */
const HUB_FACTS: HubFacts = { has: (b) => HUB_HAS.has(b), user: 'conclave', home: '/home/conclave', platform: 'linux' };
const shippedSource = (it: CatalogItem) => it.source === 'recommended' || it.source === 'recipe' || it.source === 'suggestion';
const offerOf = (it: CatalogItem, target: HubSetupTarget) => hubSetupOffer(it, target, HUB_FACTS, { shipped: shippedSource(it) });

/** Tool counts a passing test connect reports. */
const TOOLS: Record<string, number> = { github: 51, 'basic-memory': 17, context7: 2, serena: 21, markitdown: 1, pve: 30, searxng: 2, 'chrome-devtools': 26, ghidra: 27, semgrep: 7, db: 3, zotero: 12, grafana: 43, cbm: 9 };

const sha40 = (seed: string) => {
  let h = 2166136261;
  let out = '';
  while (out.length < 40) {
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
    seed += out;
  }
  return out.slice(0, 40);
};

// ---------------------------------------------------------------------------
// Live GitHub results (from the recorded search fixtures)
// ---------------------------------------------------------------------------

interface Live {
  repo: string;
  stars: number;
  kind: CatalogKind;
  /** Kinds the tree shows, when more than one. */
  kinds?: CatalogKind[];
  category: CatalogCategory;
  description: string;
  tags: string[];
  license?: string;
  updatedAt?: string;
  /** In the cache from an earlier search, so it shows under More without a search. */
  cached?: boolean;
  touches: Touch[];
  needs?: CatalogNeed[];
  /** Registry entry that does not pass the trust rule. */
  registry?: boolean;
}

const LIVE: Live[] = [
  { repo: 'thedotmack/claude-mem', stars: 101270, kind: 'plugin', category: 'memory', description: 'Captures what Claude Code does in a session, compresses it with the model, and brings the relevant parts back into later sessions.', tags: ['memory', 'claude code', 'hooks'], license: 'AGPL-3.0', updatedAt: '2026-10-14', cached: true, touches: ['hub-code', 'files', 'memory'], needs: [{ bin: 'node', where: 'hub', why: 'Its hooks and worker run on node.' }] },
  { repo: 'nizos/tdd-guard', stars: 2361, kind: 'plugin', category: 'verification', description: 'Hooks that stop the agent from writing code before a failing test exists, and from skipping or deleting tests to get green.', tags: ['tdd', 'hooks', 'tests'], license: 'MIT', updatedAt: '2026-10-08', cached: true, touches: ['hub-code', 'files'], needs: [{ bin: 'node', where: 'hub', why: 'The hook is a node program.' }] },
  { repo: 'mrexodia/ida-pro-mcp', stars: 12964, kind: 'mcp', category: 'ctf', description: 'Reverse engineering assistant that bridges IDA Pro with language models through MCP.', tags: ['ida pro', 'reverse engineering'], license: 'MIT', updatedAt: '2026-10-12', cached: true, touches: ['files', 'network'], needs: [{ bin: 'idat', where: 'device', why: 'IDA Pro runs on the device that has the license.' }] },
  { repo: 'czlonkowski/n8n-mcp', stars: 23093, kind: 'mcp', category: 'homelab', description: 'An MCP server for Claude Code and other clients to build and edit n8n workflows.', tags: ['n8n', 'automation'], license: 'MIT', updatedAt: '2026-10-15', touches: ['network', 'cloud-account'] },
  { repo: '0x4m4/hexstrike-ai', stars: 12868, kind: 'mcp', category: 'security', description: 'MCP server that lets agents run 150 or more security tools for pentesting and bug bounty work.', tags: ['pentest', 'offensive'], license: 'MIT', updatedAt: '2026-09-28', touches: ['shell', 'network', 'hub-code'], needs: [{ bin: 'python3', where: 'hub', why: 'The server is a Python program.' }] },
  { repo: 'tadata-org/fastapi_mcp', stars: 12024, kind: 'mcp', category: 'dev', description: 'Expose FastAPI endpoints as MCP tools, with auth.', tags: ['fastapi', 'python'], license: 'MIT', updatedAt: '2026-10-02', touches: ['network'] },
  { repo: 'apify/apify-mcp-server', stars: 11627, kind: 'mcp', category: 'browser', description: 'Lets agents extract data from social media, search engines and other websites through Apify actors.', tags: ['scraping', 'web'], license: 'MIT', updatedAt: '2026-10-16', touches: ['network', 'cloud-account'] },
  { repo: 'cyberkaida/reverse-engineering-assistant', stars: 875, kind: 'mcp', category: 'ctf', description: 'A Ghidra extension and MCP server for reverse engineering with an agent.', tags: ['ghidra', 'reverse engineering'], license: 'Apache-2.0', updatedAt: '2026-10-05', touches: ['files', 'network'] },
  { repo: 'secforge/chrome-devtools-mcp', stars: 3, kind: 'mcp', category: 'browser', description: 'Chrome DevTools for coding agents. Registered as io.github.secforge/chrome-devtools-mcp, a lookalike of the official package.', tags: ['chrome'], updatedAt: '2026-10-11', touches: ['browser', 'hub-code'], registry: true },
  { repo: 'Egonex-AI/Understand-Anything', stars: 86689, kind: 'skill', category: 'code-intelligence', description: 'Skills that build a knowledge graph of a codebase so the agent can answer questions about it.', tags: ['knowledge graph', 'codebase'], license: 'MIT', updatedAt: '2026-10-13', touches: ['files'] },
  { repo: 'tigerless-labs/autoharness', stars: 11123, kind: 'plugin', category: 'workflow', description: 'Plugin and skills that set up a project harness: tests, checks and agent instructions.', tags: ['harness', 'setup'], license: 'MIT', updatedAt: '2026-10-10', touches: ['files', 'hub-code'] },
  { repo: 'SnailSploit/Claude-Red', stars: 7562, kind: 'skill', category: 'security', description: 'Red team and offensive security skills for authorized testing.', tags: ['red team', 'skills'], license: 'MIT', updatedAt: '2026-10-01', touches: ['files'] },
  { repo: 'Yeachan-Heo/oh-my-claudecode', stars: 39983, kind: 'plugin', kinds: ['plugin', 'subagent', 'command'], category: 'workflow', description: 'Multi-agent orchestration for Claude Code: agents, commands and hooks that split work across parallel subagents.', tags: ['multi-agent', 'orchestration'], license: 'MIT', updatedAt: '2026-10-16', touches: ['hub-code', 'files', 'shell'] },
  { repo: 'EveryInc/compound-engineering-plugin', stars: 25564, kind: 'plugin', category: 'workflow', description: 'Plan, work, review and compound: a plugin that turns each finished task into notes the next one uses.', tags: ['planning', 'review'], license: 'MIT', updatedAt: '2026-10-09', touches: ['files'] },
  { repo: 'egorfedorov/claude-context-optimizer', stars: 116, kind: 'plugin', category: 'token-savers', description: 'Hooks that track which files the agent reads and warn when context fills up with ones it never uses.', tags: ['context', 'tokens'], license: 'MIT', updatedAt: '2026-07-02', touches: ['hub-code'] },
  { repo: 'vaporif/parry-guard', stars: 45, kind: 'hook', category: 'security', description: 'A Rust prompt injection scanner that runs as a PreToolUse and PostToolUse hook.', tags: ['prompt injection', 'rust'], license: 'MIT', updatedAt: '2026-09-21', touches: ['hub-code'] },
  { repo: 'ldayton/Dippy', stars: 243, kind: 'hook', category: 'safety', description: 'A hook that auto-approves safe read-only shell commands and asks for the rest.', tags: ['permissions', 'bash'], license: 'MIT', updatedAt: '2026-10-04', touches: ['hub-code', 'shell'] },
  { repo: 'wshobson/commands', stars: 2641, kind: 'command', category: 'workflow', description: 'Slash commands for Claude Code: workflows and tools for common development tasks.', tags: ['slash commands'], license: 'MIT', updatedAt: '2026-08-30', touches: ['files'] },
  { repo: 'yusufkaraaslan/Skill_Seekers', stars: 15168, kind: 'skill', category: 'docs', description: 'Turns documentation sites, GitHub repos and PDFs into Claude skills.', tags: ['docs', 'skill builder'], license: 'MIT', updatedAt: '2026-10-07', touches: ['network', 'files'] },
  { repo: 'NVIDIA/SkillSpector', stars: 20392, kind: 'skill', category: 'security', description: 'A security scanner for agent skills: finds prompt injection, data exfiltration and risky scripts before you install them.', tags: ['scanner', 'skills'], license: 'Apache-2.0', updatedAt: '2026-10-15', touches: ['files'] },
];

function liveItem(l: Live): CatalogItem {
  const name = l.repo.split('/')[1];
  return {
    id: l.registry ? `reg:io.github.${l.repo}` : `gh:${l.repo}`,
    kind: l.kind,
    name,
    repo: l.repo,
    stars: l.stars,
    starsAt: STARS_AT,
    description: l.description,
    category: l.category,
    tags: l.tags,
    ...(l.license ? { license: l.license } : {}),
    ...(l.updatedAt ? { updatedAt: l.updatedAt } : {}),
    install:
      l.kind === 'mcp'
        ? { type: 'mcp', server: name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-mcp(-server)?$/, ''), config: { command: 'uvx', args: [name] } }
        : l.kind === 'hook'
          ? { type: 'manual', steps: [{ say: `Read ${l.repo}'s README for its hook config, then add it in Extensions > Hooks with Import.` }] }
          : l.kind === 'plugin'
            ? { type: 'plugin', marketplace: l.repo, plugins: [`${name}@${name}`] }
            : { type: 'files', repo: l.repo, sha: sha40(l.repo), files: [{ from: l.kind === 'command' ? 'commands/' : 'skills/', to: l.kind === 'command' ? 'commands/' : 'skills/' }] },
    touches: l.touches,
    ...(l.needs ? { needs: l.needs } : {}),
    recommended: false,
    source: l.registry ? 'mcp-registry' : 'github',
    verified: false,
  };
}

// ---------------------------------------------------------------------------
// Recipes and suggestions as catalog items (the hub's catalog service does the same)
// ---------------------------------------------------------------------------

function recipeItem(r: HookRecipe): CatalogItem {
  const device = r.handlers.some((h) => h.runOn === 'device');
  return {
    id: `hook:${r.id}`,
    kind: 'hook',
    name: r.title,
    description: r.summary,
    category: r.category,
    tags: [...new Set(r.handlers.map((h) => h.event))],
    install: { type: 'hook', recipe: r.id },
    touches: r.script ? (device ? ['hub-code', 'files'] : ['hub-code']) : [],
    // as on the hub: "jq 1.6+" and "grep -P" check the program, the rest stays in why
    needs: r.needs.map((need) => {
      const bin = need.trim().split(/\s+/)[0];
      return { bin, where: 'hub' as const, why: bin === need.trim() ? 'The script calls it.' : `The script calls it (${need.trim()}).` };
    }),
    hooks: r.handlers.map((h) => ({ event: h.event, ...(h.matcher ? { matcher: h.matcher } : {}), interpreter: h.type === 'prompt' ? 'prompt' : 'bash', ...(h.timeout ? { timeout: h.timeout } : {}) })),
    recommended: r.recommended,
    source: 'recipe',
    verified: true,
    fit: r.budget,
    risk: r.safety,
  };
}

const SUGGESTION_CATEGORY: Record<RoutineSuggestion['category'], CatalogCategory> = { memory: 'memory', homelab: 'homelab', security: 'security', dev: 'dev', uni: 'uni', meta: 'meta' };

function suggestionItem(s: RoutineSuggestion): CatalogItem {
  return {
    id: `routine:${s.id}`,
    kind: 'routine',
    name: s.name,
    description: s.description,
    category: SUGGESTION_CATEGORY[s.category],
    tags: [s.schedule, s.agent ?? 'assistant'],
    install: { type: 'routine', suggestion: s.id },
    touches: s.allow.some((a) => a.startsWith('Bash')) ? ['shell', 'memory'] : ['memory'],
    recommended: s.recommended,
    source: 'suggestion',
    verified: true,
    fit: s.outputs,
    risk: s.risk,
  };
}

const README: Record<string, string> = {
  'plugin:ponytail': `# ponytail

Lazy senior dev mode for coding agents. The simplest, shortest solution that works: YAGNI, stdlib first, no abstractions nobody asked for.

## What it does

- Reuses what the repo already has before it writes anything new.
- Then the standard library, then dependencies you already installed.
- Skips features, flags and layers nobody asked for.

Levels: \`lite\`, \`full\` (default) and \`ultra\`. Switch with \`/ponytail lite\`.

## Install

\`\`\`
/plugin marketplace add DietrichGebert/ponytail
/plugin install ponytail@ponytail
\`\`\`

It runs two node lifecycle hooks: one at session start that loads the ruleset and a map of the codebase, and one for each subagent.`,
  'plugin:caveman': `# caveman

Why use many token when few token do trick.

caveman makes the agent answer in short, plain sentences. Code, commands, paths, errors and tool calls stay exactly as they are. Safety warnings stay full sentences.

## Levels

- \`lite\`: drop filler.
- \`full\`: short sentences, no preamble (default).
- \`ultra\`: telegraph style.

## Install

\`\`\`
/plugin marketplace add JuliusBrussee/caveman
/plugin install caveman@caveman
\`\`\`

The same author has a local proxy that compresses tool output. You do not need it for the plugin.`,
};

function readmeFor(it: CatalogItem): string {
  if (README[it.id]) return README[it.id];
  const lines = [`# ${it.name}`, '', it.description];
  if (it.fit) lines.push('', '## Why', '', it.fit);
  if (it.repo) lines.push('', '## Source', '', `https://github.com/${it.repo}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerDiscover(ctx: MockCtx) {
  const { on, db, fail, sleep, uid } = ctx;
  const cfg = db.config as { hooks?: Record<string, Array<{ matcher?: string; hooks: Array<HookCommand & { recipe?: string }> }>>; mcpServers?: Record<string, McpServerConfig> };

  const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const r = await ctx.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json();
    if (!r.ok) throw new Error((data as { error?: string })?.error ?? `HTTP ${r.status}`);
    return data as T;
  };

  const curated: CatalogItem[] = structuredClone(RECOMMENDED);
  const curatedIds = new Set(curated.map((x) => x.id));
  const curatedRepos = new Set(curated.map((x) => x.repo?.toLowerCase()).filter(Boolean));
  const recipes: CatalogItem[] = HOOK_RECIPES.filter((r) => !curatedIds.has(`hook:${r.id}`)).map(recipeItem);
  const routines: CatalogItem[] = ROUTINE_SUGGESTIONS.map(suggestionItem);
  const live: CatalogItem[] = LIVE.filter((l) => !curatedRepos.has(l.repo.toLowerCase())).map(liveItem);
  const liveKinds = new Map(LIVE.filter((l) => l.kinds).map((l) => [`gh:${l.repo}`, l.kinds!]));
  const local = () => [...curated, ...recipes, ...routines, ...live.filter((x) => LIVE.find((l) => `gh:${l.repo}` === x.id)?.cached)];
  const everything = () => [...curated, ...recipes, ...routines, ...live];
  const find = (id: string) => everything().find((x) => x.id === id);

  // ----- rate limit and sources -----
  const rate = { remaining: ctx.FRESH ? 60 : 54, resetAt: Date.now() + 38 * MIN, search: 9 };
  const searched = new Set<string>();
  let lastRefresh = Date.now() - 5 * HOUR;
  /** What the last live search ran into, so the status line agrees with the search note. */
  let lastSearch: 'ok' | 'limited' | 'offline' = 'ok';
  const signedIn = () => db.values.includes('catalog.github-token') || db.values.includes('github-pat');
  const status = (): CatalogStatus => {
    if (Date.now() > rate.resetAt) Object.assign(rate, { remaining: 60, resetAt: Date.now() + HOUR, search: 10 });
    const auth = signedIn();
    return {
      sources: [
        { id: 'shipped', label: 'Shipped with Conclave', on: true, items: curated.length + recipes.length + routines.length },
        { id: 'marketplace', label: 'Your plugin marketplaces', on: true, items: 61, lastFetch: lastRefresh },
        { id: 'mcp-registry', label: 'Official MCP registry', on: true, items: 1874, lastFetch: lastRefresh },
        { id: 'github', label: 'GitHub search', on: true, items: live.length, lastFetch: Date.now() - 2 * HOUR },
        { id: 'star-index', label: 'Plugin star index', on: true, items: 48424, lastFetch: lastRefresh },
        { id: 'awesome-list', label: 'awesome-claude-code list', on: true, items: 312, lastFetch: lastRefresh },
      ],
      github: auth
        ? { authenticated: true, limit: 5000, remaining: 4980 - (60 - rate.remaining), resetAt: rate.resetAt, searchRemaining: 30 }
        : { authenticated: false, limit: 60, remaining: rate.remaining, resetAt: rate.resetAt, searchRemaining: rate.search, ...(lastSearch === 'limited' ? { blockedUntil: rate.resetAt } : {}) },
      lastRefresh,
      cache: { items: everything().length, bytes: 2_412_544 },
      ...(lastSearch === 'offline' ? { offline: true } : {}),
    };
  };

  // ----- installed state -----
  const records = new Map<string, InstalledCatalogItem>();
  if (!ctx.FRESH)
    records.set('plugin:superpowers', {
      id: 'plugin:superpowers',
      kind: 'plugin',
      ref: 'superpowers',
      href: '/extensions/plugins?plugin=superpowers',
      sha: 'a41c7e09d3b25f8816c0e2d97b4f5a3c1e8d6b20',
      version: '4.0.3',
      installedAt: Date.now() - 41 * DAY,
      matchedBy: 'record',
      name: 'superpowers',
      source: 'recommended',
      upstreamSha: PINS.superpowers,
      updateAvailable: true,
      checkedAt: Date.now() - 3 * HOUR,
    });
  const added = new Map<string, RecipeInstall[]>();

  const installedOf = async (it: CatalogItem): Promise<InstalledRef | undefined> => {
    const rec = records.get(it.id);
    if (rec) return rec;
    const spec = it.install;
    if (spec.type === 'mcp') {
      const s = cfg.mcpServers?.[spec.server];
      const all = [spec, ...(it.variants ?? [])].filter((v): v is Extract<InstallSpec, { type: 'mcp' }> => v.type === 'mcp');
      if (s && all.some((v) => (v.config.command && v.config.command === s.command) || (v.config.url && v.config.url === s.url))) return { id: it.id, kind: it.kind, ref: spec.server, href: `/extensions/mcp?server=${encodeURIComponent(spec.server)}`, matchedBy: 'name' };
    }
    if (spec.type === 'plugin') {
      const names = new Set((await call<InstalledPlugin[]>('/api/plugins')).map((p) => p.name));
      const hit = spec.plugins.map((p) => p.split('@')[0]).find((n) => names.has(n));
      if (hit) return { id: it.id, kind: it.kind, ref: hit, href: `/extensions/plugins?plugin=${encodeURIComponent(hit)}`, matchedBy: 'name' };
    }
    if (spec.type === 'hook') {
      const tagged = Object.values(cfg.hooks ?? {}).some((groups) => groups?.some((g) => g.hooks.some((h) => h.recipe === spec.recipe || h.command?.includes(`/recipes/${spec.recipe}.sh`))));
      if (tagged) return { id: it.id, kind: 'hook', ref: spec.recipe, href: `/extensions/hooks?event=${recipeEvent(spec.recipe)}`, matchedBy: 'record' };
    }
    if (spec.type === 'routine') {
      const r = [...db.routines.values()].find((x) => (x as Routine & { suggestion?: string }).suggestion === spec.suggestion);
      if (r) return { id: it.id, kind: 'routine', ref: r.id, href: `/routines/${r.id}`, matchedBy: 'record' };
    }
    if (spec.type === 'files' && it.kind === 'subagent') {
      const name = spec.files[0]?.to.replace(/^agents\//, '').replace(/\.md$/, '');
      if (name && db.agents.some((a) => a.name === name)) return { id: it.id, kind: 'subagent', ref: name, href: `/agents/${encodeURIComponent(name)}`, matchedBy: 'name' };
    }
    return undefined;
  };

  const recipeEvent = (rid: string): HookEvent => HOOK_RECIPES.find((r) => r.id === rid)?.handlers[0]?.event ?? 'PreToolUse';

  const missingOf = (it: CatalogItem): CatalogNeed[] => (it.needs ?? []).filter((n) => n.where !== 'device' && !HUB_HAS.has(n.bin));

  const dto = async (it: CatalogItem): Promise<CatalogItemDto> => {
    const installed = await installedOf(it);
    const rec = records.get(it.id);
    const missing = missingOf(it);
    const hubSetup = missing.some((n) => n.where === 'hub') ? offerOf(it, { missing: true }) : undefined;
    return { ...it, ...(installed ? { installed } : {}), ...(rec?.updateAvailable ? { updateAvailable: true } : {}), ready: { ok: missing.length === 0, missing, ...(hubSetup ? { hubSetup } : {}) }, starsLive: false };
  };

  const order = (a: CatalogItem, b: CatalogItem) => {
    if (!!a.must !== !!b.must) return a.must ? -1 : 1;
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (a.recommended && b.recommended && (a.rank !== undefined || b.rank !== undefined)) return (a.rank ?? 999) - (b.rank ?? 999);
    return (b.stars ?? 0) - (a.stars ?? 0);
  };

  const matches = (it: CatalogItem, q: string) => {
    const hay = [it.name, it.repo ?? '', it.description, it.category, ...it.tags].join(' ').toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => hay.includes(w));
  };

  on('GET', '/api/catalog', async ({ query }) => {
    await sleep(160);
    const kind = query.get('kind') as CatalogKind | null;
    const q = (query.get('q') ?? '').trim();
    const category = query.get('category');
    let list = local().filter((x) => (!kind || x.kind === kind) && (!category || x.category === category) && (!q || matches(x, q)));
    if (query.get('recommended') === '1') list = list.filter((x) => x.recommended);
    let items = await Promise.all(list.sort(order).map(dto));
    if (query.get('installed') === '1') items = items.filter((x) => x.installed);
    const start = Number(query.get('cursor') ?? 0) || 0;
    const limit = Math.min(200, Number(query.get('limit') ?? 50) || 50);
    const page = items.slice(start, start + limit);
    return { items: page, total: items.length, ...(start + limit < items.length ? { next: String(start + limit) } : {}), status: status() };
  });

  on('GET', '/api/catalog/search', async ({ query }) => {
    const q = (query.get('q') ?? '').trim();
    if (!q) fail(400, 'q is required');
    const kind = query.get('kind') as CatalogKind | null;
    const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
    const sort = query.get('sort') === 'updated' ? 'updated' : 'stars';
    const key = `${q}|${kind ?? ''}|${page}|${sort}`;
    if (/offline/i.test(q)) {
      lastSearch = 'offline';
      await sleep(900);
      fail(502, 'Could not reach api.github.com from the hub: getaddrinfo ENOTFOUND api.github.com');
    }
    const limited = /limit/i.test(q) || (!signedIn() && rate.remaining <= 0);
    lastSearch = limited && !signedIn() ? 'limited' : 'ok';
    const fresh = !searched.has(key) && !limited;
    await sleep(fresh ? 700 : 150);
    if (fresh) {
      searched.add(key);
      rate.remaining = Math.max(0, rate.remaining - 1);
      rate.search = Math.max(0, rate.search - 1);
    }
    const words = q.replace(/\blimit\b/gi, '').trim();
    const cur = [...curated, ...recipes, ...routines].filter((x) => (!kind || x.kind === kind) && (!words || matches(x, words))).sort(order);
    const liveHits = live
      .filter((x) => (!kind || x.kind === kind) && (!words || matches(x, words)))
      .filter((x) => !limited || LIVE.find((l) => `gh:${l.repo}` === x.id)?.cached)
      .sort((a, b) => (sort === 'updated' ? (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') : (b.stars ?? 0) - (a.stars ?? 0)));
    const all = [...cur, ...liveHits];
    const size = 12;
    const slice = all.slice((page - 1) * size, page * size);
    const resetAt = new Date(rate.resetAt);
    return {
      items: await Promise.all(slice.map(dto)),
      page,
      more: page * size < all.length,
      from: limited ? ['cache'] : [...(kind && kind !== 'mcp' ? [] : (['mcp-registry'] as const)), 'github', 'marketplace'],
      ...(limited ? { note: `GitHub limit reached. Showing saved results until ${String(resetAt.getHours()).padStart(2, '0')}:${String(resetAt.getMinutes()).padStart(2, '0')}.` } : {}),
    };
  });

  on('GET', '/api/catalog/items/:id', async ({ params }) => {
    const it = find(params[0]);
    if (!it) fail(404, `unknown catalog item ${params[0]}`);
    await sleep(220);
    const d: CatalogDetail = { ...(await dto(it!)), ...(it!.repo && it!.source !== 'suggestion' && it!.source !== 'recipe' ? { readme: readmeFor(it!) } : {}) };
    const kinds = liveKinds.get(it!.id);
    if (kinds) d.tree = { kinds, files: 214, bytes: 1_840_000 };
    return d;
  });

  // ----- preview -----
  interface Plan {
    preview: InstallPreview;
    spec: InstallSpec;
    item: CatalogItem;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: Record<string, any>;
  }
  const plans = new Map<string, Plan>();

  const fill = (v: string, values: Record<string, string>, inputs: CatalogInput[]) =>
    v.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, n: string) => {
      const inp = inputs.find((i) => i.name === n);
      if (inp?.secret) return `\${secret:${inp.secretKey ?? n.toLowerCase()}}`;
      return values[n] ?? inp?.default ?? inp?.example ?? `{{${n}}}`;
    });
  const fillConfig = (c: McpServerConfig, values: Record<string, string>, inputs: CatalogInput[]): McpServerConfig => {
    const out = structuredClone(c) as McpServerConfig;
    const map = (o?: Record<string, string>) => {
      if (!o) return o;
      const r: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) {
        const only = /^\{\{([A-Z0-9_]+)\}\}$/.exec(v);
        const inp = only && inputs.find((i) => i.name === only[1]);
        if (inp && !inp.required && !values[inp.name] && !inp.default) continue;
        r[k] = fill(v, values, inputs);
      }
      return r;
    };
    if (out.args) out.args = out.args.map((a) => fill(a, values, inputs));
    if (out.url) out.url = fill(out.url, values, inputs);
    if (out.env) out.env = map(out.env);
    if (out.headers) out.headers = map(out.headers);
    return out;
  };

  const variantLabel = (it: CatalogItem, s: InstallSpec): string => {
    switch (s.type) {
      case 'mcp':
        return s.label ?? (s.config.url ? 'Remote' : `${s.config.command} on the hub`);
      case 'plugin':
        return it.hooks?.length ? 'Plugin, with its hooks' : 'Plugin';
      case 'files':
        return s.files.every((f) => f.to.startsWith('skills/')) ? 'Skill files only' : s.files.every((f) => f.to.startsWith('agents/')) ? 'Agent file only' : 'Files only';
      case 'hook':
        return 'Hook recipe';
      case 'routine':
        return 'Routine';
      default:
        return 'By hand';
    }
  };

  const recipeOf = (rid: string) => HOOK_RECIPES.find((r) => r.id === rid);

  const buildPreview = async (it: CatalogItem, variant: number, options: Record<string, any>): Promise<Plan> => {
    const specs = [it.install, ...(it.variants ?? [])];
    const spec = specs[variant] ?? it.install;
    const files: PreviewFile[] = [];
    const warnings: PreviewWarning[] = [];
    const hooks: InstallPreview['hooks'] = [];
    const mcpServers: InstallPreview['mcpServers'] = [];
    const scripts: string[] = [];
    const steps: InstallPreview['steps'] = [];
    const used = JSON.stringify(spec);
    let inputs: CatalogInput[] = (it.inputs ?? []).filter((i) => used.includes(`{{${i.name}}}`));
    let config: McpServerConfig | undefined;
    let equivalent: string | undefined;
    let sha: string | undefined;
    let shaFrom: InstallPreview['shaFrom'];
    const live = it.source === 'github' || it.source === 'mcp-registry';

    for (const n of missingOf(it)) {
      if (n.bin === 'npx') steps.push({ say: `Install Node.js with npm on ${HUB}. ${n.why}`, run: 'apt install -y nodejs npm', on: 'hub' });
      else if (n.where === 'every-device') steps.push({ say: `Install ${n.bin} on each device. ${n.why}` });
      else steps.push({ say: `Install ${n.bin} on ${HUB}. ${n.why}`, on: 'hub' });
    }

    if (spec.type === 'mcp') {
      steps.push(...(spec.setup ?? []).map((s, i) => (s.on === 'hub' && s.run ? { ...s, hub: offerOf(it, { step: i, variant }) } : s)));
      const preset = spec.toolPresets?.find((t) => t.id === options.toolPreset) ?? spec.toolPresets?.[0];
      config = fillConfig(spec.config, {}, inputs);
      if (preset && preset.tools.length) config.tools = preset.tools;
      const server = fill(spec.server, {}, inputs);
      mcpServers.push({ name: server, config });
      equivalent = `conclave config set mcpServers.${server} '${JSON.stringify(config)}'`;
      if (config.command && !HUB_HAS.has(config.command) && !['serena', 'semgrep'].includes(config.command)) {
        /* the test connect will say so */
      }
      if (live) {
        sha = sha40(`${it.id}-head`);
        shaFrom = 'head';
        warnings.push({ level: 'warn', text: 'Derived from the README. The test connect runs before anything is saved.' });
      }
    } else if (spec.type === 'plugin') {
      sha = spec.sha ?? sha40(`${it.id}-head`);
      shaFrom = spec.sha ? 'pinned' : 'head';
      const picked: string[] = options.plugins ?? spec.plugins;
      for (const src of picked) {
        const name = src.split('@')[0];
        const dir = `plugins/${name}`;
        files.push({ path: `${dir}/.claude-plugin/plugin.json`, bytes: 1508, role: 'manifest' });
        if (it.id === 'plugin:ponytail') {
          files.push(
            { path: `${dir}/hooks/claude-codex-hooks.json`, bytes: 1227, role: 'hook' },
            { path: `${dir}/hooks/ponytail-activate.js`, bytes: 6880, role: 'script' },
            { path: `${dir}/hooks/ponytail-subagent.js`, bytes: 3412, role: 'script' },
            { path: `${dir}/hooks/ponytail-mode-tracker.js`, bytes: 2210, role: 'script' },
            { path: `${dir}/skills/ponytail/SKILL.md`, bytes: 4977, role: 'skill' },
            { path: `${dir}/skills/ponytail-review/SKILL.md`, bytes: 2304, role: 'skill' },
            { path: `${dir}/skills/ponytail-audit/SKILL.md`, bytes: 2118, role: 'skill' },
            { path: `${dir}/skills/ponytail-debt/SKILL.md`, bytes: 1960, role: 'skill' },
            { path: `${dir}/commands/ponytail.md`, bytes: 640, role: 'command' },
            { path: `${dir}/README.md`, bytes: 9120, role: 'other' },
            { path: `${dir}/LICENSE`, bytes: 1071, role: 'other' },
          );
        } else if (it.id === 'plugin:caveman') {
          files.push({ path: `${dir}/hooks/hooks.json`, bytes: 1460, role: 'hook' }, { path: `${dir}/hooks/caveman-hook.js`, bytes: 8210, role: 'script' });
          for (const s of ['caveman', 'caveman-compress', 'verify-and-stop', 'surgical-patch', 'lean-build', 'investigate-first', 'safe-refactor', 'caveman-commit', 'caveman-review'])
            files.push({ path: `${dir}/skills/${s}/SKILL.md`, bytes: 1800 + s.length * 97, role: 'skill' });
          files.push({ path: `${dir}/proxy/main.go`, bytes: 18_400, role: 'other' }, { path: `${dir}/README.md`, bytes: 12_300, role: 'other' });
        } else {
          files.push({ path: `${dir}/skills/${name}/SKILL.md`, bytes: 3120, role: 'skill' }, { path: `${dir}/README.md`, bytes: 4200, role: 'other' });
          if (it.hooks?.length) files.push({ path: `${dir}/hooks/hooks.json`, bytes: 860, role: 'hook' });
        }
      }
      const hooksOn = options.hooks ?? spec.hooks !== 'off';
      if (hooksOn) {
        for (const h of it.hooks ?? []) {
          const script = it.id === 'plugin:ponytail' ? { SessionStart: 'ponytail-activate.js', SubagentStart: 'ponytail-subagent.js', UserPromptSubmit: 'ponytail-mode-tracker.js' }[h.event as string] : it.id === 'plugin:caveman' ? 'caveman-hook.js' : undefined;
          hooks.push({ ...h, plugin: picked[0]?.split('@')[0], ...(script ? { command: `node \${CLAUDE_PLUGIN_ROOT}/hooks/${script}` } : {}) });
        }
        scripts.push(...files.filter((f) => f.role === 'script').map((f) => `${CH}/${f.path}`));
      } else if (it.hooks?.length) warnings.push({ level: 'info', text: `Hooks off: ${it.hooks.length} hooks stay in the folder but never run. Skills, commands and agents still load.` });
      equivalent = [...(spec.marketplace ? [`/plugin marketplace add ${spec.marketplace}`] : []), ...picked.map((p) => `/plugin install ${p}`)].join('\n');
    } else if (spec.type === 'files') {
      sha = spec.sha;
      shaFrom = live ? 'head' : 'pinned';
      for (const f of spec.files) {
        // a folder inside a skill (the rules of a data skill): one row for the folder
        if (/^skills\/[^/]+\/.+\/$/.test(f.to)) files.push({ path: f.to, bytes: 120_000 + f.to.length * 9_000, role: 'other' });
        else if (f.to.endsWith('/')) {
          const kind = f.to.startsWith('skills/') ? 'skill' : f.to.startsWith('commands/') ? 'command' : 'agent';
          files.push({ path: `${f.to}${kind === 'skill' ? 'SKILL.md' : 'index.md'}`, bytes: 2400 + f.to.length * 61, role: kind });
          if (kind === 'skill') files.push({ path: `${f.to}reference.md`, bytes: 5100 + f.to.length * 13, role: 'other' });
        } else files.push({ path: f.to, bytes: 1900 + f.to.length * 37, role: f.to.startsWith('agents/') ? 'agent' : f.to.startsWith('commands/') ? 'command' : 'other' });
      }
      // files Conclave writes itself, such as the SKILL.md of the detection rules skill
      for (const w of spec.write ?? []) files.push({ path: w.to, bytes: w.text.length, role: w.to.endsWith('/SKILL.md') ? 'skill' : 'other', written: true });
      equivalent = `git clone --filter=blob:none https://github.com/${spec.repo}\ngit -C ${spec.repo.split('/')[1]} checkout ${spec.sha}\n${spec.files.map((f) => `cp -r ${spec.repo.split('/')[1]}/${f.from} ~/.conclave/${f.to}`).join('\n')}`;
    } else if (spec.type === 'hook') {
      const r = recipeOf(spec.recipe);
      if (r) {
        const path = `${CH}/hooks/recipes/${r.id}.sh`;
        if (r.script) {
          files.push({ path: `hooks/recipes/${r.id}.sh`, bytes: r.script.length, role: 'script' });
          scripts.push(path);
        }
        for (const h of r.handlers) {
          const command = h.command?.replaceAll('{script}', path);
          hooks.push({ event: h.event, ...(h.matcher ? { matcher: h.matcher } : {}), interpreter: h.type === 'prompt' ? 'prompt' : 'bash', ...(h.timeout ? { timeout: h.timeout } : {}), ...(command ? { command } : {}), network: /curl|wget|https?:\/\//.test(r.script ?? '') });
          if (h.runOn === 'device') warnings.push({ level: 'info', text: 'Reads the session\'s files. Until hooks run on devices, it only works for sessions on the hub.' });
          if (h.event === 'PreToolUse' && !h.matcher) warnings.push({ level: 'info', text: 'Runs on every tool call.' });
        }
        inputs = (r.env ?? []).map((e) => ({ name: e.name, label: e.name, description: e.description, required: false, secret: false, default: e.default }));
        const where = options.target ? `${options.target.cli} on ${options.target.device}` : options.scope === 'project' ? `${options.cwd}/.conclave/settings.json` : `${CH}/config.json`;
        equivalent = `# writes ${path} and adds ${r.handlers.length === 1 ? 'one handler' : `${r.handlers.length} handlers`} to ${where}\nconclave config get hooks`;
      }
    } else if (spec.type === 'manual') {
      steps.push(...spec.steps);
    }

    for (const w of it.warnings ?? []) warnings.push({ level: 'warn', text: w });
    if (it.source === 'mcp-registry' && !it.verified) warnings.unshift({ level: 'risk', text: 'Not verified. The registry name points at a repo, but the package does not carry the matching ownership marker. It may be a lookalike.' });
    for (const o of it.overlaps ?? []) {
      const other = curated.find((x) => x.id === o);
      if (!other) continue;
      const inst = await installedOf(other);
      warnings.push({ level: 'info', text: `Overlaps with ${other.name}${inst ? ' (added)' : ''}.` });
    }
    const needs = (it.needs ?? []).map((n) => ({ ...n, found: n.where === 'device' ? (options.device ? n.bin !== 'recursive-improve' : null) : HUB_HAS.has(n.bin), checkedOn: n.where === 'device' ? (options.device ?? '') : HUB }));
    const lic = it.license;
    const preview: InstallPreview = {
      planId: uid('plan'),
      expiresAt: Date.now() + 10 * MIN,
      item: await dto(it),
      variant,
      variants: specs.map((s, i) => ({ index: i, label: variantLabel(it, s), type: s.type })),
      ...(sha ? { sha, shaFrom } : {}),
      steps,
      inputs,
      files,
      totalBytes: files.reduce((n, f) => n + f.bytes, 0),
      ...(config ? { config } : {}),
      ...(equivalent ? { equivalent } : {}),
      hooks,
      mcpServers,
      scripts,
      ...(lic ? { license: lic, licenseOsi: !/elastic|busl|source.available|commons clause/i.test(lic) } : {}),
      needs,
      touches: it.touches,
      warnings,
    };
    return { preview, spec, item: it, options };
  };

  on('POST', '/api/catalog/preview', async ({ body }) => {
    const it = find(String(body?.id ?? ''));
    if (!it) fail(404, `unknown catalog item ${body?.id}`);
    if (it!.install.type === 'routine') fail(400, 'Routines are added from the Routines tab.');
    await sleep(it!.install.type === 'mcp' ? 260 : 620);
    const plan = await buildPreview(it!, Number(body.variant ?? 0) || 0, body.options ?? {});
    plans.set(plan.preview.planId, plan);
    return plan.preview;
  });

  // ----- install on the hub: the hub's planner, a pretend run, then what it gave is on the hub -----
  const setupRunning = new Set<string>();
  on('POST', '/api/catalog/items/:id/setup', async ({ params, body }) => {
    const it = find(params[0]);
    if (!it) return fail(404, `unknown catalog item ${params[0]}`);
    if (setupRunning.has(it.id)) fail(409, 'An install for this item is already running on the hub.');
    const target: HubSetupTarget = body?.step !== undefined ? { step: Number(body.step), variant: Number(body.variant ?? 0) } : body?.bin ? { bin: String(body.bin) } : { missing: true };
    const offer = offerOf(it, target);
    if (!offer.commands.length || offer.refusal) fail(offer.refusal === 'not-shipped' ? 403 : 409, offer.why ?? 'Nothing to run on the hub.');
    const runs = offer.commands.map((c) => c.run);
    if (Array.isArray(body?.commands) && body.commands.join('\n') !== runs.join('\n')) fail(409, 'What it would run changed since you looked. Check the commands again.');
    setupRunning.add(it.id);
    try {
      await sleep(2400);
      // "fail" in a package name shows the failure path
      const failing = runs.findIndex((r) => /fail/.test(r));
      const ran = failing < 0 ? runs : runs.slice(0, failing + 1);
      if (failing < 0) for (const b of offer.checks) HUB_HAS.add(b);
      const tail = ran.flatMap((r) => [`$ ${r}`, ...(r.startsWith('curl') ? ['downloading uv 0.12.24 x86_64-unknown-linux-gnu', 'installing to /home/conclave/.local/bin', '  uv', '  uvx', 'everything\'s installed!'] : [`Resolved 38 packages in 1.2s`, `Installed 38 packages in 410ms`, ` + ${r.split(/\s+/).pop()}`])]).join('\n');
      const d = await dto(it);
      return { ok: failing < 0, exitCode: failing < 0 ? 0 : 1, ran, user: offer.user, tail, durationMs: 2400, ready: d.ready };
    } finally {
      setupRunning.delete(it.id);
    }
  });

  // ----- install -----
  on('POST', '/api/catalog/install', async ({ body }) => {
    const plan = plans.get(String(body?.planId ?? ''));
    if (!plan || plan.preview.expiresAt < Date.now()) fail(409, 'The plan expired. Preview it again.');
    const { item: it, spec, preview } = plan!;
    const values: Record<string, string> = body.values ?? {};
    const missing = preview.inputs.filter((i) => i.required && !values[i.name] && !(i.secret && i.secretKey && db.values.includes(i.secretKey)));
    if (missing.length) fail(400, `Fill in ${missing.map((m) => m.label).join(', ')}.`);
    const enable = body.enable !== false;
    const warnings: string[] = [];
    await sleep(spec.type === 'plugin' && spec.marketplace ? 3100 : 2200);
    plans.delete(body.planId);

    let installed: InstalledRef;
    let test: CatalogInstallResult['test'];
    let recipeTests: RecipeTestResult[] | undefined;
    const next: CatalogInstallResult['next'] = [];

    if (spec.type === 'mcp') {
      const server = fill(spec.server, values, preview.inputs);
      const config = fillConfig(spec.config, values, preview.inputs);
      const preset = spec.toolPresets?.find((t) => t.id === plan!.options.toolPreset) ?? spec.toolPresets?.[0];
      if (preset?.tools.length) config.tools = preset.tools;
      const bin = config.command;
      const ok = !bin || HUB_HAS.has(bin);
      test = ok ? { ok: true, ms: 640 + server.length * 37, tools: TOOLS[server] ?? 8 } : { ok: false, ms: 38, tools: 0, error: `Executable not found in $PATH: "${bin}"` };
      if (!ok && !body.saveOnFail) {
        return { ok: false, installed: { id: it.id, kind: it.kind, ref: server, href: `/extensions/mcp`, matchedBy: 'record' }, test, warnings: [`${bin} is not on ${HUB}.`], next: [] } satisfies CatalogInstallResult;
      }
      for (const inp of preview.inputs) if (inp.secret && inp.secretKey && values[inp.name]) await call('/api/secrets', 'PUT', { kind: 'values', key: inp.secretKey, value: values[inp.name] });
      await call('/api/mcp', 'POST', { name: server, config: { ...config, ...(enable && ok ? {} : { enabled: false }) } });
      installed = { id: it.id, kind: 'mcp', ref: server, href: `/extensions/mcp?server=${encodeURIComponent(server)}`, installedAt: Date.now(), matchedBy: 'record' };
      next.push({ label: 'Open in MCP servers', href: installed.href });
      if (spec.offer?.includes('memory-connection')) next.push({ label: 'Use as a memory connection', href: '/memory/connections' });
      if (spec.offer?.includes('connect-clis')) next.push({ label: 'Connect to my CLIs', href: installed.href });
    } else if (spec.type === 'plugin') {
      const picked: string[] = plan!.options.plugins ?? spec.plugins;
      const owner = (it.repo ?? 'anthropics/claude-plugins-official').split('/')[0];
      let first = '';
      for (const src of picked) {
        const name = src.split('@')[0];
        const p = await call<InstalledPlugin>('/api/plugins', 'POST', { source: `${owner}/${name}` });
        first ||= p.name;
        if (!enable) await call(`/api/plugins/${encodeURIComponent(p.name)}`, 'PATCH', { enabled: false });
      }
      installed = { id: it.id, kind: 'plugin', ref: first, href: `/extensions/plugins?plugin=${encodeURIComponent(first)}`, sha: preview.sha, installedAt: Date.now(), matchedBy: 'record' };
      if (plan!.options.hooks === false) warnings.push('Installed with its hooks off.');
      next.push({ label: 'Open in Plugins', href: installed.href });
    } else if (spec.type === 'files') {
      const first = spec.files[0];
      const name = first.to.replace(/^(skills|agents|commands)\//, '').replace(/\/$/, '').replace(/\.md$/, '');
      if (it.kind === 'subagent' && !db.agents.some((a) => a.name === name)) {
        const a: AgentDef = { name, description: it.description, prompt: `${it.description}\n\nWork from what is in this session. Say what you found and where, with file paths.`, source: 'user', path: `${CH}/agents/${name}.md` } as AgentDef;
        db.agents.push(a);
      }
      const href = it.kind === 'subagent' ? `/agents/${encodeURIComponent(name)}` : it.kind === 'command' ? `/extensions/commands?command=${encodeURIComponent(name)}` : `/extensions/skills?skill=${encodeURIComponent(name)}`;
      installed = { id: it.id, kind: it.kind, ref: name, href, sha: spec.sha, installedAt: Date.now(), matchedBy: 'record' };
      next.push({ label: it.kind === 'subagent' ? 'Open in Agents' : it.kind === 'command' ? 'Open in Commands' : 'Open in Skills', href });
      if (body.syncClis) warnings.push(`Synced to ${body.syncClis.clis.join(' and ')} on ${body.syncClis.device}.`);
    } else if (spec.type === 'hook') {
      const o = plan!.options;
      const r = await installRecipe(spec.recipe, o.target ? 'user' : (o.scope ?? 'user'), values, { cwd: o.cwd, target: o.target });
      recipeTests = r.tests;
      if (r.note) warnings.push(r.note);
      installed = { id: it.id, kind: 'hook', ref: spec.recipe, href: `/extensions/hooks?event=${recipeEvent(spec.recipe)}`, installedAt: Date.now(), matchedBy: 'record' };
      next.push({ label: 'Open in Hooks', href: installed.href });
    } else {
      fail(400, 'Nothing to install for this item.');
    }
    const rec: InstalledCatalogItem = { ...installed!, name: it.name, source: it.source, upstreamSha: installed!.sha, updateAvailable: false, checkedAt: Date.now() };
    records.set(it.id, rec);
    ctx.emit({ type: 'config.updated' });
    return { ok: true, installed: installed!, ...(test ? { test } : {}), ...(recipeTests ? { recipeTests } : {}), warnings, next } satisfies CatalogInstallResult;
  });

  on('GET', '/api/catalog/installed', () => [...records.values()]);

  on('POST', '/api/catalog/updates/check', async () => {
    await sleep(900);
    for (const r of records.values()) r.checkedAt = Date.now();
    return [...records.values()];
  });

  on('POST', '/api/catalog/installed/:id/update-preview', async ({ params }) => {
    const r = records.get(params[0]);
    if (!r) fail(404, 'Not installed from Discover.');
    await sleep(800);
    const to = r!.upstreamSha ?? sha40(`${r!.id}-next`);
    const u: UpdatePreview = {
      planId: uid('uplan'),
      from: r!.sha ?? '',
      to,
      changes: [
        { path: `plugins/${r!.ref}/.claude-plugin/plugin.json`, change: 'modified', executable: false, diff: '@@ -1,4 +1,4 @@\n {\n   "name": "superpowers",\n-  "version": "4.0.3",\n+  "version": "4.1.1",' },
        { path: `plugins/${r!.ref}/skills/brainstorming/SKILL.md`, change: 'modified', executable: false },
        { path: `plugins/${r!.ref}/skills/finishing-a-branch/SKILL.md`, change: 'added', executable: false },
        { path: `plugins/${r!.ref}/hooks/session-start.sh`, change: 'modified', executable: true, diff: '@@ -3,3 +3,4 @@\n cat "$ROOT/skills/using-superpowers/SKILL.md"\n-exit 0\n+echo "Skills: $(ls "$ROOT/skills" | wc -l)"\n+exit 0' },
      ],
      hooksChanged: true,
      mcpChanged: false,
      scriptsChanged: true,
      needsReview: true,
      warnings: [{ level: 'warn', text: 'The SessionStart hook script changed. It runs on the hub at every session start.' }],
    };
    plans.set(u.planId, { preview: {} as InstallPreview, spec: { type: 'manual', steps: [] }, item: find(r!.id)!, options: { update: u } });
    return u;
  });

  on('POST', '/api/catalog/installed/:id/update', async ({ params, body }) => {
    const r = records.get(params[0]);
    if (!r) fail(404, 'Not installed from Discover.');
    const plan = plans.get(String(body?.planId ?? ''));
    if (!plan) fail(409, 'The update plan expired. Check again.');
    await sleep(1400);
    r!.previous = { sha: r!.sha, at: Date.now() };
    r!.sha = (plan!.options.update as UpdatePreview).to;
    r!.version = '4.1.1';
    r!.updateAvailable = false;
    plans.delete(body.planId);
    return r;
  });

  on('POST', '/api/catalog/installed/:id/rollback', async ({ params }) => {
    const r = records.get(params[0]);
    if (!r?.previous) fail(400, 'There is no earlier copy to go back to.');
    await sleep(600);
    r!.sha = r!.previous!.sha;
    r!.previous = undefined;
    r!.updateAvailable = true;
    return r;
  });

  on('DELETE', '/api/catalog/installed/:id', async ({ params, query }) => {
    const r = records.get(params[0]);
    if (!r) fail(404, 'Not installed from Discover.');
    await sleep(500);
    const removed: string[] = [];
    if (r!.kind === 'mcp') {
      await call(`/api/mcp/${encodeURIComponent(r!.ref)}`, 'DELETE').catch(() => undefined);
      removed.push(`mcpServers.${r!.ref}`);
      if (query.get('secrets') === '1') {
        const it = find(r!.id);
        for (const inp of it?.inputs ?? []) if (inp.secret && inp.secretKey) await call('/api/secrets', 'PUT', { kind: 'values', key: inp.secretKey, value: null });
      }
    } else if (r!.kind === 'plugin') {
      await call(`/api/plugins/${encodeURIComponent(r!.ref)}`, 'DELETE').catch(() => undefined);
      removed.push(`${CH}/plugins/${r!.ref}`);
    } else if (r!.kind === 'hook') {
      for (const groups of Object.values(cfg.hooks ?? {})) if (groups) for (const g of groups) g.hooks = g.hooks.filter((h) => h.recipe !== r!.ref);
      for (const [ev, groups] of Object.entries(cfg.hooks ?? {})) cfg.hooks![ev] = (groups ?? []).filter((g) => g.hooks.length);
      added.delete(r!.ref);
      removed.push(`${CH}/hooks/recipes/${r!.ref}.sh`);
    } else {
      if (r!.kind === 'subagent') db.agents = db.agents.filter((a) => !(a.name === r!.ref && a.source === 'user'));
      removed.push(`${CH}/${r!.kind === 'subagent' ? 'agents' : r!.kind === 'command' ? 'commands' : 'skills'}/${r!.ref}`);
    }
    records.delete(r!.id);
    return { ok: true, removed };
  });

  on('GET', '/api/catalog/status', () => status());
  on('POST', '/api/catalog/refresh', async () => {
    await sleep(1200);
    lastRefresh = Date.now();
    return status();
  });

  // ----- hook recipes (2.2) -----
  const recipeDto = (r: HookRecipe): HookRecipeDto => {
    const { script, tests, ...rest } = r;
    return { ...rest, scriptBytes: script?.length ?? 0, testCount: tests.length, installed: added.get(r.id) ?? [], ready: { ok: r.needs.every(hubHas), missing: r.needs.filter((n) => !hubHas(n)) } };
  };

  const CLI_FILE = { 'claude-code': '~/.claude/settings.json', codex: '~/.codex/hooks.json', gemini: '~/.gemini/settings.json' } as const;
  const CLI_NOTE = {
    'claude-code': 'Claude Code reads hooks when it starts. Restart open Claude Code sessions, or review the change in /hooks.',
    codex: 'Codex runs a new hook only after you trust it. Start Codex and pick Review hooks, or open /hooks.',
    gemini: 'Gemini CLI reads hooks when it starts. Restart open Gemini CLI sessions.',
  } as const;

  async function installRecipe(rid: string, scope: 'user' | 'project', env: Record<string, string>, where: { cwd?: string; target?: { cli: keyof typeof CLI_FILE; device: string } } = {}) {
    const r = recipeOf(rid);
    if (!r) fail(404, `unknown recipe ${rid}`);
    if (scope === 'project' && !where.target && !where.cwd?.startsWith('/')) fail(400, 'cwd must be an absolute path');
    if (where.target && !r!.targets.includes(where.target.cli)) fail(400, `${r!.title} does not work in ${where.target.cli}. It works in ${r!.targets.join(', ')}.`);
    const path = `${CH}/hooks/recipes/${r!.id}.sh`;
    const changed = Object.entries(env).filter(([k, v]) => r!.env?.find((e) => e.name === k)?.default !== v);
    const prefix = changed.map(([k, v]) => `${k}='${v}' `).join('');
    cfg.hooks ??= {};
    for (const h of r!.handlers) {
      const handler = h.type === 'prompt' ? { type: 'prompt' as const, prompt: h.prompt ?? '', ...(h.timeout ? { timeout: h.timeout } : {}), recipe: r!.id } : { type: 'command' as const, command: `${prefix}${(h.command ?? '{script}').replaceAll('{script}', path)}`, ...(h.timeout ? { timeout: h.timeout } : {}), recipe: r!.id };
      (cfg.hooks[h.event] ??= []).push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [handler as HookCommand & { recipe: string }] });
    }
    const inst: RecipeInstall = where.target
      ? { scope: where.target.cli, device: where.target.device, env: Object.fromEntries(changed), installedAt: Date.now() }
      : { scope, ...(scope === 'project' ? { cwd: where.cwd } : {}), env: Object.fromEntries(changed), installedAt: Date.now() };
    added.set(r!.id, [...(added.get(r!.id) ?? []), inst]);
    const file = where.target ? `${CLI_FILE[where.target.cli]} on ${where.target.device}` : scope === 'project' ? `${where.cwd}/.conclave/settings.json` : `${CH}/config.json`;
    const tests: RecipeTestResult[] = r!.tests.map((t) => {
      const lacking = r!.needs.find((n) => !hubHas(n));
      return lacking ? { name: t.name, ok: false, why: `${lacking} is not on ${HUB}, so the script exits before it decides.` } : { name: t.name, ok: true };
    });
    return { tests, installed: inst, file, ...(where.target ? { note: CLI_NOTE[where.target.cli] } : {}) };
  }

  on('GET', '/api/hooks/recipes', async () => {
    await sleep(120);
    return HOOK_RECIPES.map(recipeDto);
  });
  on('GET', '/api/hooks/recipes/:id', ({ params }) => {
    const r = recipeOf(params[0]);
    if (!r) fail(404, `unknown recipe ${params[0]}`);
    return { ...r, installed: added.get(r!.id) ?? [], ready: { ok: r!.needs.every(hubHas), missing: r!.needs.filter((n) => !hubHas(n)) }, scriptPath: `${CH}/hooks/recipes/${r!.id}.sh` };
  });
  on('POST', '/api/hooks/recipes/:id/test', async ({ params }) => {
    const r = recipeOf(params[0]);
    if (!r) fail(404, `unknown recipe ${params[0]}`);
    await sleep(300 + r!.tests.length * 120);
    return r!.tests.map((t) => ({ name: t.name, ok: r!.needs.every(hubHas) }));
  });
  on('POST', '/api/hooks/recipes/:id/install', async ({ params, body }) => {
    await sleep(700);
    const r = await installRecipe(params[0], body?.scope === 'project' ? 'project' : 'user', body?.env ?? {}, { cwd: body?.cwd, target: body?.target });
    const it = find(`hook:${params[0]}`);
    if (it) records.set(it.id, { id: it.id, kind: 'hook', ref: params[0], href: `/extensions/hooks?event=${recipeEvent(params[0])}`, installedAt: Date.now(), matchedBy: 'record', name: it.name, source: it.source, updateAvailable: false });
    ctx.emit({ type: 'config.updated' });
    return { ok: true, ...r };
  });
  on('DELETE', '/api/hooks/recipes/:id', ({ params }) => {
    for (const [ev, groups] of Object.entries(cfg.hooks ?? {})) cfg.hooks![ev] = (groups ?? []).map((g) => ({ ...g, hooks: g.hooks.filter((h) => h.recipe !== params[0]) })).filter((g) => g.hooks.length);
    added.delete(params[0]);
    records.delete(`hook:${params[0]}`);
    return { ok: true };
  });
}
