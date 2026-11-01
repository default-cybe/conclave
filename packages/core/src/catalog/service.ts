/**
 * The Discover catalog: merges the shipped list, hook recipes, routine
 * suggestions, marketplaces, the MCP registry, GitHub search and the raw
 * feeds into one ranked list, with installed state, readiness and live stars
 * (docs/design/ECOSYSTEM.md section 1).
 *
 * Precedence: a curated entry wins over a derived one with the same id or,
 * for whole-repo results, the same repo. Shipped data needs no network, so
 * Discover renders offline on first open.
 */
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Db } from '../storage/db';
import type { ExecOptions, ExecResult } from '../machine/types';
import { LocalMachine } from '../machine/local';
import { HOOK_RECIPES, type HookRecipe, type RecipeCategory } from '../extensions/hook-recipes';
import { ROUTINE_SUGGESTIONS, type RoutineSuggestion } from '../scheduler/suggestions';
import { CATALOG_FEEDS, KNOWN_MARKETPLACES, RECOMMENDED, type CatalogCategory, type CatalogItem, type CatalogKind } from './recommended';
import { CatalogStore } from './store';
import { CatalogHttp, OfflineError, type FetchFn } from './http';
import { GithubClient, ghRepoToItem, kindFromRepo, type GithubRateState } from './github';
import { McpRegistry, registryToItem } from './registry';
import { awesomeItems, marketplaceItems, parseStarIndex, readMarketplace } from './feeds';
import { CatalogInstaller, CatalogError, type CatalogHost } from './install';
import { gitRunner, type GitRun } from './git';
import { TailLines, hubSetupBins, hubSetupOffer, type HubFacts, type HubSetupOffer, type HubSetupTarget } from './hub-setup';
import type {
  CatalogDetail,
  CatalogItemDto,
  CatalogPage,
  CatalogPreviewRequest,
  CatalogQuery,
  CatalogSearchQuery,
  CatalogSearchResult,
  CatalogSetupRequest,
  CatalogSetupResult,
  CatalogSourceStatus,
  CatalogStatus,
  InstallPreview,
} from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** "Install on the hub": the whole run, every command in it. */
const SETUP_TIMEOUT_MS = 10 * 60_000;
/** Lines of output kept for the answer. */
const SETUP_TAIL_LINES = 200;
/** Where the shipped list comes from: only these items may run setup on the hub. */
const SHIPPED_SOURCES = new Set(['recommended', 'recipe', 'suggestion']);

/** The account the hub runs as, for the confirm ("runs as conclave"). */
function hubUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || 'the hub user';
  }
}

/** The hub's PATH with ~/.local/bin in front, where uv and `uv tool install` put programs, unless it is there already. */
function setupPath(home: string): string {
  const path = process.env.PATH ?? '';
  const local = join(home, '.local', 'bin');
  return path.split(delimiter).includes(local) ? path : [local, path].filter(Boolean).join(delimiter);
}

const RECIPE_CATEGORY: Record<RecipeCategory, CatalogCategory> = {
  safety: 'safety',
  security: 'security',
  homelab: 'homelab',
  'token-savers': 'token-savers',
  memory: 'memory',
  verification: 'verification',
  'minimal-code': 'minimal-code',
  quality: 'quality',
  ctf: 'ctf',
  'self-improvement': 'self-improvement',
};

const SUGGESTION_CATEGORY: Record<RoutineSuggestion['category'], CatalogCategory> = {
  memory: 'memory',
  homelab: 'homelab',
  security: 'security',
  dev: 'dev',
  uni: 'uni',
  meta: 'meta',
};

/** A hook recipe as a catalog item (kind hook). `index` keeps the shipped order (ranks after curated items). */
export function recipeItem(r: HookRecipe, index?: number): CatalogItem {
  return {
    id: `hook:${r.id}`,
    kind: 'hook',
    name: r.title,
    repo: r.source && /^[\w.-]+\/[\w.-]+$/.test(r.source) ? r.source : undefined,
    description: r.summary,
    category: RECIPE_CATEGORY[r.category] ?? 'quality',
    tags: [...new Set(r.handlers.map((h) => h.event))],
    license: 'MIT',
    install: { type: 'hook', recipe: r.id },
    touches: r.script ? ['hub-code', 'shell', 'files'] : ['hub-code'],
    // "jq 1.6+" and "grep -P" name a program plus a version or flag: check the program, keep the rest in why
    needs: r.needs.map((need) => {
      const bin = need.trim().split(/\s+/)[0];
      return { bin, where: 'hub' as const, why: bin === need.trim() ? 'The script calls it.' : `The script calls it (${need.trim()}).` };
    }),
    hooks: r.handlers.map((h) => ({ event: h.event, matcher: h.matcher, interpreter: h.type === 'prompt' ? 'prompt' : 'bash', timeout: h.timeout, note: r.budget })),
    recommended: r.recommended,
    ...(index !== undefined ? { rank: 500 + index } : {}),
    source: 'recipe',
    verified: true,
    risk: r.safety,
  };
}

/** A routine suggestion as a catalog item (kind routine). Add opens the Routines tab. `index` keeps the shipped order. */
export function suggestionItem(s: RoutineSuggestion, index?: number): CatalogItem {
  return {
    id: `routine:${s.id}`,
    kind: 'routine',
    name: s.name,
    description: s.description,
    category: SUGGESTION_CATEGORY[s.category] ?? 'meta',
    tags: [s.schedule, s.agent ?? 'assistant'].filter(Boolean) as string[],
    install: { type: 'routine', suggestion: s.id },
    touches: [],
    recommended: s.recommended,
    ...(index !== undefined ? { rank: 500 + index } : {}),
    source: 'suggestion',
    verified: true,
    risk: s.risk,
    fit: s.outputs,
  };
}

export interface CatalogServiceOptions {
  db: Db;
  paths: { home: string; skills: string; agents: string; commands: string; hooks: string; cache: string; plugins: string };
  host: CatalogHost;
  /** GitHub token (secret catalog.github-token, else github-pat). */
  githubToken?: () => string | undefined;
  /** GitHub API base, for GitHub Enterprise (https://ghe.example/api/v3) or a fixture server in tests. */
  githubApi?: string;
  /** kv for the rate state and sync times. */
  kv?: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  fetch?: FetchFn;
  git?: GitRun;
  now?: () => number;
  /** command -v on the hub. Default spawns sh. */
  checkBin?: (bin: string) => Promise<boolean>;
  /** How long a search waits for the MCP registry before it answers from the synced copy. Default 5 s. */
  registryWaitMs?: number;
  /** Turn off live sources (tests). */
  sources?: Partial<Record<'github' | 'mcp-registry' | 'marketplaces' | 'feeds', boolean>>;
  /**
   * Runs "Install on the hub" commands on the hub machine: the server passes
   * the hub's own machine (engine.devices "local"), whose exec drops the hub's
   * secrets from the environment like hook commands do. Default: a LocalMachine.
   */
  hubShell?: { exec(command: string, opts: ExecOptions): Promise<ExecResult> };
}

interface RankedItem {
  item: CatalogItem;
  /** Lower ranks first. */
  order: number;
}

async function defaultCheckBin(bin: string): Promise<boolean> {
  if (!/^[\w.+-]+$/.test(bin)) return false;
  try {
    // the PATH the hub has now (Bun.spawn's default is the one it started with), which a hub may extend at run time
    const p = Bun.spawn(['sh', '-c', 'command -v "$0" >/dev/null 2>&1', bin], { stdout: 'ignore', stderr: 'ignore', env: process.env as Record<string, string> });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

export class CatalogService {
  readonly store: CatalogStore;
  readonly http: CatalogHttp;
  readonly github: GithubClient;
  readonly registry: McpRegistry;
  readonly installer: CatalogInstaller;
  private now: () => number;
  private shipped: CatalogItem[];
  private shippedById: Map<string, CatalogItem>;
  private binCache = new Map<string, { ok: boolean; at: number }>();
  private checkBinRaw: (bin: string) => Promise<boolean>;
  private lastRefreshCall = 0;
  private sourceErrors = new Map<string, string>();
  private sourceFetched = new Map<string, number>();
  private refreshingStars = false;
  private starsRetryAt = 0;
  private kv?: CatalogServiceOptions['kv'];
  /** Items with an "Install on the hub" run going: one at a time per item. */
  private setupRunning = new Set<string>();
  /** The hub's account and home, read once. */
  private hubAccount?: { user: string; home: string };

  constructor(private o: CatalogServiceOptions) {
    this.now = o.now ?? Date.now;
    this.kv = o.kv;
    this.store = new CatalogStore(o.db);
    this.http = new CatalogHttp(this.store, { fetch: o.fetch, now: this.now });
    this.github = new GithubClient({
      http: this.http,
      token: o.githubToken,
      api: o.githubApi,
      fetch: o.fetch,
      now: this.now,
      load: () => this.kv?.get<GithubRateState | undefined>('catalog.github.rate', undefined),
      save: (s) => this.kv?.set('catalog.github.rate', s),
    });
    this.registry = new McpRegistry(this.http);
    // a curated entry wins over the recipe or suggestion with the same id (hook:rtk-rewrite is both)
    const curatedIds = new Set(RECOMMENDED.map((i) => i.id));
    this.shipped = [...RECOMMENDED, ...[...HOOK_RECIPES.map((r, i) => recipeItem(r, i)), ...ROUTINE_SUGGESTIONS.map((s, i) => suggestionItem(s, i))].filter((i) => !curatedIds.has(i.id))];
    this.shippedById = new Map(this.shipped.map((i) => [i.id, i]));
    this.checkBinRaw = o.checkBin ?? defaultCheckBin;
    this.installer = new CatalogInstaller({
      paths: o.paths,
      store: this.store,
      http: this.http,
      git: o.git ?? gitRunner(),
      github: this.github,
      registry: this.registry,
      host: o.host,
      now: this.now,
      checkBin: (bin) => this.checkBin(bin),
      itemFor: (id) => this.itemFor(id),
      dtoFor: (item) => this.dto(item),
    });
    for (const k of ['marketplaces', 'mcp-registry', 'star-index', 'awesome-claude-code', 'github']) {
      const t = this.kv?.get<number>(`catalog.fetched.${k}`, 0);
      if (t) this.sourceFetched.set(k, t);
    }
  }

  private on(source: 'github' | 'mcp-registry' | 'marketplaces' | 'feeds'): boolean {
    return this.o.sources?.[source] !== false;
  }

  async checkBin(bin: string): Promise<boolean> {
    const hit = this.binCache.get(bin);
    if (hit && this.now() - hit.at < 60_000) return hit.ok;
    const ok = await this.checkBinRaw(bin);
    this.binCache.set(bin, { ok, at: this.now() });
    return ok;
  }

  /**
   * Warm the command -v cache for every hub need, so list calls can answer without spawning.
   * Items with hub needs also warm what "Install on the hub" asks about (uv, curl, a step's program).
   */
  async warmNeeds(items: CatalogItem[]): Promise<void> {
    const bins = new Set<string>();
    for (const it of items) {
      if (!(it.needs ?? []).some((n) => n.where === 'hub')) continue;
      for (const b of hubSetupBins(this.shippedDef(it) ?? it)) bins.add(b);
    }
    await Promise.all([...bins].map((b) => this.checkBin(b)));
  }

  /** The shipped definition of an item, or undefined when it does not ship with Conclave. Setup runs from this, never from a cached copy. */
  private shippedDef(item: Pick<CatalogItem, 'id' | 'source'>): CatalogItem | undefined {
    const def = this.shippedById.get(item.id);
    return def && SHIPPED_SOURCES.has(def.source) && item.source === def.source ? def : undefined;
  }

  /** What the hub knows for an offer: the warmed command -v answers (unknown counts as found), its user and home. */
  private facts(): HubFacts {
    this.hubAccount ??= { user: hubUser(), home: homedir() };
    return { has: (bin) => this.binCache.get(bin)?.ok !== false, ...this.hubAccount, platform: process.platform };
  }

  /** The offer for one target, from the shipped definition when there is one. */
  private offerFor(item: CatalogItem, target: HubSetupTarget): HubSetupOffer {
    const def = this.shippedDef(item);
    return hubSetupOffer(def ?? item, target, this.facts(), { shipped: !!def });
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  /** Shipped item, else a cached one, else the snapshot an install kept. */
  itemFor(id: string): CatalogItem | undefined {
    const s = this.shippedById.get(id);
    if (s) return this.withLiveStars(s);
    const c = this.store.getItem(id);
    if (c) {
      const { fetchedAt: _f, ...item } = c;
      return item;
    }
    return this.store.getInstall(id)?.meta.item;
  }

  /** Curated stars, replaced by a fresher live count for the same repo. */
  private withLiveStars(item: CatalogItem): CatalogItem & { starsLive?: boolean } {
    if (!item.repo) return item;
    const live = this.store.getItem(`gh:${item.repo}`) ?? this.store.itemsByRepo(item.repo).find((r) => r.source === 'github' || r.source === 'star-index');
    if (!live || live.stars === undefined) return item;
    const fresher = !item.starsAt || (live.starsAt ?? '') >= item.starsAt;
    if (!fresher) return item;
    return {
      ...item,
      stars: live.stars,
      starsAt: live.starsAt,
      updatedAt: live.updatedAt && (!item.updatedAt || live.updatedAt > item.updatedAt) ? live.updatedAt : item.updatedAt,
      archived: live.archived ?? item.archived,
      starsLive: this.now() - live.fetchedAt < DAY,
    };
  }

  dto(item: CatalogItem): CatalogItemDto {
    const row = this.store.getInstall(item.id);
    const installed = row ? this.installer.refFromRow(row) : this.installer.matchByName(item);
    const missing = (item.needs ?? []).filter((n) => n.where === 'hub' && this.binCache.get(n.bin)?.ok === false);
    const live = item as CatalogItem & { starsLive?: boolean };
    const hubSetup = missing.length ? this.offerFor(item, { missing: true }) : undefined;
    return {
      ...item,
      ...(installed ? { installed } : {}),
      ...(row?.upstreamSha && row.upstreamSha !== (row.sha ?? row.version) ? { updateAvailable: true } : {}),
      ready: { ok: missing.length === 0, missing, ...(hubSetup ? { hubSetup } : {}) },
      ...(live.starsLive ? { starsLive: true } : {}),
    };
  }

  /** Cached derived items, minus those a curated entry covers. */
  private derived(kind?: CatalogKind): CatalogItem[] {
    const curatedRepos = new Set(this.shipped.filter((i) => i.repo).map((i) => i.repo!.toLowerCase()));
    const curatedPlugins = new Set(
      this.shipped.flatMap((i) => [i.install, ...(i.variants ?? [])]).flatMap((s) => (s.type === 'plugin' ? s.plugins : [])),
    );
    const out: CatalogItem[] = [];
    for (const r of this.store.listItems({ kind })) {
      const { fetchedAt: _f, ...it } = r;
      if (this.shippedById.has(it.id)) continue;
      if (it.id.startsWith('gh:') && it.repo && curatedRepos.has(it.repo.toLowerCase())) continue;
      if (it.id.startsWith('mkt:') && curatedPlugins.has(it.id.slice(4))) continue;
      out.push(it);
    }
    return out;
  }

  private all(kind?: CatalogKind): RankedItem[] {
    const shipped = this.shipped.filter((i) => !kind || i.kind === kind).map((i) => this.withLiveStars(i));
    const ranked: RankedItem[] = shipped.map((item) => ({
      item,
      order: item.must ? (item.rank ?? 0) : item.recommended ? 100 + (item.rank ?? 900) : 10_000,
    }));
    for (const item of this.derived(kind)) ranked.push({ item, order: 20_000 });
    return ranked;
  }

  private static matches(item: CatalogItem, q: string): number {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 1;
    const name = `${item.name} ${item.repo ?? ''}`.toLowerCase();
    const body = `${item.description} ${item.tags.join(' ')} ${item.category}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 3;
      else if (body.includes(w)) score += 1;
      else return 0;
    }
    return score;
  }

  /** GET /api/catalog: local data only. */
  async list(q: CatalogQuery = {}, opts: { refreshStars?: boolean } = {}): Promise<CatalogPage> {
    let ranked = this.all(q.kind);
    if (q.category) ranked = ranked.filter((r) => r.item.category === q.category);
    if (q.recommended) ranked = ranked.filter((r) => r.item.recommended);
    if (q.q?.trim()) {
      const text = q.q.trim();
      const fts = new Set(this.store.searchItems(text, { kind: q.kind }).map((r) => r.id));
      ranked = ranked
        .map((r) => ({ ...r, score: CatalogService.matches(r.item, text) + (fts.has(r.item.id) ? 1 : 0) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => (a.order < 20_000 ? 0 : 1) - (b.order < 20_000 ? 0 : 1) || b.score - a.score || a.order - b.order || (b.item.stars ?? 0) - (a.item.stars ?? 0));
    } else {
      ranked.sort((a, b) => a.order - b.order || (b.item.stars ?? 0) - (a.item.stars ?? 0) || a.item.name.localeCompare(b.item.name));
    }
    await this.warmNeeds(ranked.slice(0, 200).map((r) => r.item));
    let dtos = ranked.map((r) => this.dto(r.item));
    if (q.installed) dtos = dtos.filter((d) => d.installed);
    const offset = Math.max(0, Number(q.cursor ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, q.limit ?? 60));
    const page = dtos.slice(offset, offset + limit);
    // stars for the first rows on screen, in the background, within the budget (about one search call)
    if (opts.refreshStars !== false) void this.refreshStars(page.filter((d) => d.repo && !d.starsLive).map((d) => d.repo!).slice(0, 10)).catch(() => undefined);
    return { items: page, total: dtos.length, next: offset + limit < dtos.length ? String(offset + limit) : undefined, status: this.status() };
  }

  /** GET /api/catalog/search: curated matches first, then live GitHub, registry and marketplace results. */
  async search(q: CatalogSearchQuery): Promise<CatalogSearchResult> {
    const text = q.q.trim();
    if (!text) throw new CatalogError(400, 'q is required');
    const page = Math.max(1, q.page ?? 1);
    const from = new Set<CatalogSearchResult['from'][number]>();
    const notes: string[] = [];
    const seen = new Set<string>();
    const head: CatalogItem[] = [];
    const tail: CatalogItem[] = [];
    const curatedByRepo = new Map(this.shipped.filter((i) => i.repo && i.source === 'recommended').map((i) => [i.repo!.toLowerCase(), i]));
    const add = (it: CatalogItem) => {
      // a curated entry wins over a live result for the same repo, and moves to the front
      const curated = it.source === 'recommended' ? it : it.id.startsWith('gh:') && it.repo ? curatedByRepo.get(it.repo.toLowerCase()) : undefined;
      const pick = curated ? this.withLiveStars(curated) : it;
      if (seen.has(pick.id)) return;
      seen.add(pick.id);
      (curated || it.source === 'recipe' || it.source === 'suggestion' ? head : tail).push(pick);
    };
    const out = { some: (fn: (x: CatalogItem) => boolean) => head.some(fn) || tail.some(fn) };
    if (page === 1) {
      const local = await this.list({ q: text, kind: q.kind, limit: 200 }, { refreshStars: false });
      for (const it of local.items.filter((i) => i.source === 'recommended' || i.source === 'recipe' || i.source === 'suggestion')) add(it);
      for (const it of local.items.filter((i) => i.source === 'marketplace')) {
        add(it);
        from.add('marketplace');
      }
    }
    let more = false;
    const at = this.now();
    const saved = () => {
      const rows = this.store.searchItems(text, { kind: q.kind }).filter((x) => x.source === 'github');
      return rows.map(({ fetchedAt: _f, ...it }) => it as CatalogItem);
    };
    // GitHub and the registry run side by side: a new registry query can take several seconds
    const githubTask = async (): Promise<CatalogItem[]> => {
      if (!this.on('github') || q.kind === 'routine') return [];
      const kinds: Array<Exclude<CatalogKind, 'routine'>> = q.kind ? [q.kind] : ['mcp', 'skill', 'plugin'];
      const found: CatalogItem[] = [];
      for (const k of kinds) {
        try {
          const r = await this.github.searchKind(text, k, { sort: q.sort, page });
          const cached = r.responses.every((x) => x.fromCache);
          if (r.items.length) from.add(cached ? 'cache' : 'github');
          const items = r.items.filter((g) => !g.fork).map((g) => ghRepoToItem(g, kindFromRepo(g, k), at));
          this.store.upsertItems(items, at);
          for (const it of items) found.push(this.itemFor(it.id) ?? it);
          if (r.total > page * 30) more = true;
          const paused = r.responses.some((x) => x.error === 'paused');
          const until = this.github.rate().blockedUntil;
          const failed = r.responses.find((x) => x.liveStatus && x.liveStatus >= 400);
          if (paused || (until && failed)) {
            notes.push(`GitHub limit reached. Showing saved results${until ? ` until ${new Date(until).toISOString().slice(11, 16)} UTC` : ''}.`);
          } else if (failed) {
            notes.push(failed.liveStatus === 401 ? 'GitHub did not accept the token (catalog.github-token or github-pat). Showing saved results.' : `GitHub answered ${failed.liveStatus}. Showing saved results.`);
            this.sourceErrors.set('github', `search answered ${failed.liveStatus}`);
          } else {
            this.sourceErrors.delete('github');
            continue;
          }
          if (!r.items.length) for (const it of saved()) found.push(it), from.add('cache');
          break;
        } catch (err) {
          if (err instanceof OfflineError) {
            notes.push(this.github.rate().blockedUntil ? 'GitHub limit reached. Showing saved results.' : "Can't reach GitHub from the hub.");
            for (const it of saved()) found.push(it), from.add('cache');
            break;
          }
          throw err;
        }
      }
      return found;
    };
    const registryTask = async (): Promise<CatalogItem[]> => {
      if (!this.on('mcp-registry') || (q.kind && q.kind !== 'mcp') || page !== 1) return [];
      const savedRegistry = () =>
        this.store
          .searchItems(text, { kind: 'mcp', limit: 30 })
          .filter((x) => x.source === 'mcp-registry')
          .map(({ fetchedAt: _f, ...it }) => it as CatalogItem);
      const live = this.registry.search(text).then((r) => {
        const items = r.entries.map((e) => registryToItem(e, at)).filter((x): x is CatalogItem => !!x);
        this.store.upsertItems(items, this.now());
        if (r.error) this.sourceErrors.set('mcp-registry', r.error);
        else this.sourceErrors.delete('mcp-registry');
        return { items, fromCache: r.fromCache };
      });
      // a new registry query can take 10 seconds or more: answer from the synced copy, and let the call finish into the cache
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow = new Promise<'slow'>((res) => (timer = setTimeout(() => res('slow'), this.o.registryWaitMs ?? 5000)));
      try {
        const got = await Promise.race([live, slow]);
        if (got === 'slow') {
          live.catch((err) => this.sourceErrors.set('mcp-registry', (err as Error).message));
          const rows = savedRegistry();
          if (rows.length) from.add('cache');
          regNotes.push('The MCP registry is slow to answer. Showing saved registry entries.');
          return rows;
        }
        if (got.items.length) from.add(got.fromCache ? 'cache' : 'mcp-registry');
        return got.items;
      } catch (err) {
        this.sourceErrors.set('mcp-registry', (err as Error).message);
        if (err instanceof OfflineError) regNotes.push("Can't reach the MCP registry.");
        return savedRegistry();
      } finally {
        clearTimeout(timer);
      }
    };
    const regNotes: string[] = [];
    const [ghItems, regItems] = await Promise.all([githubTask(), registryTask()]);
    notes.push(...regNotes);
    for (const it of ghItems) add(it);
    for (const it of regItems) {
      // a curated or GitHub row for the same repo already covers it
      if (it.repo && out.some((x) => x.repo?.toLowerCase() === it.repo!.toLowerCase())) continue;
      add(it);
    }
    const items = [...head, ...tail];
    await this.warmNeeds(items);
    return { items: items.map((i) => this.dto(i)), page, more, from: [...from], note: notes[0] };
  }

  async detail(id: string): Promise<CatalogDetail> {
    const item = this.itemFor(id);
    if (!item) throw new CatalogError(404, `unknown catalog item ${id}`);
    await this.warmNeeds([item]);
    const d: CatalogDetail = this.dto(item);
    if (item.repo) {
      const ref = item.install.type === 'files' || item.install.type === 'plugin' ? ((item.install as { sha?: string }).sha ?? 'HEAD') : 'HEAD';
      d.readme = await this.github.readme(item.repo, ref).catch(() => undefined);
      if (item.kind === 'plugin') {
        const { data } = await this.http
          .json<Record<string, unknown>>(`https://raw.githubusercontent.com/${item.repo}/${ref}/.claude-plugin/plugin.json`, { ttlMs: ref === 'HEAD' ? DAY : Infinity })
          .catch(() => ({ data: undefined }));
        if (data) d.manifest = data;
      }
    }
    return d;
  }

  async preview(req: CatalogPreviewRequest): Promise<InstallPreview> {
    const item = this.itemFor(req.id);
    if (!item) throw new CatalogError(404, `unknown catalog item ${req.id}`);
    // what "Install on the hub" asks about (uv, curl, a step's program), before the preview shapes the item
    await Promise.all(hubSetupBins(this.shippedDef(item) ?? item).map((b) => this.checkBin(b)));
    const p = await this.installer.preview(item, req);
    // steps that run on the hub say what "Install on the hub" would run, or why it cannot
    const spec = [p.item.install, ...(p.item.variants ?? [])][p.variant];
    const setup = spec?.type === 'mcp' ? (spec.setup ?? []) : spec?.type === 'manual' ? spec.steps : [];
    if (setup.some((s) => s.on === 'hub' && s.run)) {
      // a live repo's steps were worked out just now
      await Promise.all(hubSetupBins(p.item).map((b) => this.checkBin(b)));
      p.steps = p.steps.map((st) => {
        if (st.on !== 'hub' || !st.run) return st;
        const step = setup.findIndex((s) => s.say === st.say && s.run === st.run);
        return step < 0 ? st : { ...st, hub: this.offerFor(p.item, { step, variant: p.variant }) };
      });
    }
    return p;
  }

  // -------------------------------------------------------------------------
  // Install on the hub (catalog/hub-setup.ts)
  // -------------------------------------------------------------------------

  /** The target a request names: a step (with its variant), one need, or every missing hub need. */
  private setupTarget(item: CatalogItem, req: CatalogSetupRequest): HubSetupTarget {
    if (req.step !== undefined) {
      const variants = 1 + (item.variants?.length ?? 0);
      const variant = req.variant ?? 0;
      if (!Number.isInteger(req.step) || req.step < 0) throw new CatalogError(400, 'step must be a whole number');
      if (!Number.isInteger(variant) || variant < 0 || variant >= variants) throw new CatalogError(400, `variant must be 0 to ${variants - 1}`);
      return { step: req.step, variant };
    }
    if (req.bin !== undefined) {
      if (typeof req.bin !== 'string' || !/^[\w.+-]{1,64}$/.test(req.bin)) throw new CatalogError(400, 'bin must be a program name');
      return { bin: req.bin };
    }
    return { missing: true };
  }

  /** The offer with fresh command -v answers: the cache may be a minute old, and what runs must match what is there now. */
  async setupOffer(id: string, req: CatalogSetupRequest = {}): Promise<HubSetupOffer> {
    const item = this.itemFor(id);
    if (!item) throw new CatalogError(404, `unknown catalog item ${id}`);
    const def = this.shippedDef(item) ?? item;
    const target = this.setupTarget(def, req);
    const bins = hubSetupBins(def);
    for (const b of bins) this.binCache.delete(b);
    await Promise.all(bins.map((b) => this.checkBin(b)));
    return this.offerFor(item, target);
  }

  /**
   * POST /api/catalog/items/:id/setup: run what the offer says, as the hub's
   * own user in its home, one command after another, stopping at the first
   * that fails. Then check readiness again and answer with it.
   */
  async runSetup(id: string, req: CatalogSetupRequest = {}): Promise<CatalogSetupResult> {
    if (this.setupRunning.has(id)) throw new CatalogError(409, 'An install for this item is already running on the hub.');
    this.setupRunning.add(id);
    try {
      const offer = await this.setupOffer(id, req);
      if (!offer.commands.length || offer.refusal) {
        const r = offer.refusal;
        const status = r === 'not-shipped' ? 403 : r === 'no-step' || r === 'not-needed' || r === 'device' || r === 'no-run' ? 400 : r === 'os' ? 501 : 409;
        throw new CatalogError(status, offer.why ?? 'Nothing to run on the hub.', { setup: offer });
      }
      const runs = offer.commands.map((c) => c.run);
      if (req.commands && (req.commands.length !== runs.length || req.commands.some((r, i) => r !== runs[i])))
        throw new CatalogError(409, 'What it would run changed since you looked. Check the commands again.', { setup: offer });
      this.o.host.audit('catalog.setup', `${id} as ${offer.user} in ${offer.home}: ${runs.join(' && ')}`);
      const shell = this.o.hubShell ?? new LocalMachine();
      const tail = new TailLines(SETUP_TAIL_LINES);
      const started = Date.now();
      const deadline = started + SETUP_TIMEOUT_MS;
      const env = { PATH: setupPath(offer.home) };
      const ran: string[] = [];
      let exitCode: number | null = 0;
      let timedOut = false;
      for (const run of runs) {
        ran.push(run);
        tail.line(`$ ${run}`);
        let streamed = false;
        const r = await shell
          .exec(run, {
            cwd: offer.home,
            env,
            timeoutMs: Math.max(1000, deadline - Date.now()),
            maxOutputBytes: 512 * 1024,
            onOutput: (chunk) => {
              streamed = true;
              tail.push(chunk);
            },
          })
          .catch((err: Error): ExecResult => ({ exitCode: 1, stdout: '', stderr: `${err.message}\n`, timedOut: false, aborted: false, durationMs: 0 }));
        if (!streamed) tail.push(`${r.stdout}${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}`);
        tail.flush();
        exitCode = r.timedOut || r.aborted ? null : r.exitCode;
        if (r.timedOut) {
          timedOut = true;
          tail.line('Stopped: the install ran past 10 minutes.');
        }
        if (exitCode !== 0) break;
      }
      const ok = exitCode === 0;
      this.o.host.audit('catalog.setup.result', `${id}: ${ok ? 'ok' : timedOut ? 'timed out' : `failed, exit ${exitCode ?? 'none'}`}, ran ${ran.length} of ${runs.length}`);
      // installing uv fixes every item that runs through uvx: forget every answer, not only this item's
      this.binCache.clear();
      const item = this.itemFor(id)!;
      await Promise.all([...new Set([...hubSetupBins(this.shippedDef(item) ?? item), ...offer.checks])].map((b) => this.checkBin(b)));
      const ready = this.dto(item).ready;
      // it landed in ~/.local/bin, but the hub's own PATH (MCP servers, the readiness check) does not have that folder
      const local = join(offer.home, '.local', 'bin');
      const offPath = offer.checks.filter((b) => this.binCache.get(b)?.ok === false && existsSync(join(local, b)));
      const note = offPath.length ? `${offPath.join(' and ')} landed in ~/.local/bin, which is not on the hub's PATH. Add ${local} to the PATH the hub starts with, then restart the hub.` : undefined;
      return { ok, exitCode, ...(timedOut ? { timedOut } : {}), ran, user: offer.user, tail: tail.text(), durationMs: Date.now() - started, ready, ...(note ? { note } : {}) };
    } finally {
      this.setupRunning.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Status and refresh
  // -------------------------------------------------------------------------

  status(): CatalogStatus {
    const counts = this.store.countItems();
    const cache = this.store.cacheSize();
    const src = (id: string, label: string, on: boolean, items: number, fetchKey = id): CatalogSourceStatus => ({
      id,
      label,
      on,
      items,
      ...(this.sourceFetched.get(fetchKey) ? { lastFetch: this.sourceFetched.get(fetchKey) } : {}),
      ...(this.sourceErrors.get(id) ? { lastError: this.sourceErrors.get(id) } : {}),
    });
    const feed = (id: string) => CATALOG_FEEDS.find((f) => f.id === id)?.defaultOn !== false;
    return {
      sources: [
        src('shipped', 'Picked for your setup', true, this.shipped.length),
        src('marketplaces', 'Plugin marketplaces', this.on('marketplaces'), counts.bySource.marketplace ?? 0),
        src('mcp-registry', 'Official MCP registry', this.on('mcp-registry'), counts.bySource['mcp-registry'] ?? 0),
        src('github', 'GitHub search', this.on('github'), counts.bySource.github ?? 0),
        src('star-index', 'Plugin star index', this.on('feeds') && feed('star-index'), counts.bySource['star-index'] ?? 0),
        src('awesome-claude-code', 'awesome-claude-code list', this.on('feeds') && feed('awesome-claude-code'), counts.bySource['awesome-list'] ?? 0),
      ],
      github: this.github.rate(),
      lastRefresh: this.kv?.get<number>('catalog.lastRefresh', 0) || undefined,
      cache: { items: counts.total, bytes: cache.bytes },
      ...(this.http.offline ? { offline: true } : {}),
    };
  }

  private fetched(id: string): void {
    this.sourceFetched.set(id, this.now());
    this.kv?.set(`catalog.fetched.${id}`, this.now());
    this.sourceErrors.delete(id);
  }

  async refreshMarketplaces(): Promise<number> {
    const sources = new Map<string, string>();
    for (const k of KNOWN_MARKETPLACES) sources.set(k.source.toLowerCase(), k.source);
    for (const m of this.o.host.plugins.marketplaces()) if (/^[\w.-]+\/[\w.-]+$/.test(m.source)) sources.set(m.source.toLowerCase(), m.source);
    let n = 0;
    const at = this.now();
    for (const repo of sources.values()) {
      try {
        const mk = await readMarketplace(this.http, repo);
        if (!mk) continue;
        const items = marketplaceItems(mk, repo, at);
        this.store.upsertItems(items, at);
        n += items.length;
      } catch (err) {
        this.sourceErrors.set('marketplaces', `${repo}: ${(err as Error).message}`);
      }
    }
    this.fetched('marketplaces');
    return n;
  }

  async refreshRegistry(): Promise<number> {
    const since = this.kv?.get<string | undefined>('catalog.registry.since', undefined);
    const started = new Date(this.now()).toISOString();
    const entries = await this.registry.changedSince(since, since ? 20 : 10);
    const at = this.now();
    const items = entries.map((e) => registryToItem(e, at)).filter((x): x is CatalogItem => !!x);
    this.store.upsertItems(items, at);
    this.kv?.set('catalog.registry.since', started);
    this.fetched('mcp-registry');
    return items.length;
  }

  async refreshFeeds(): Promise<number> {
    let n = 0;
    const at = this.now();
    const day = new Date(at).toISOString().slice(0, 10);
    const star = CATALOG_FEEDS.find((f) => f.id === 'star-index');
    if (star?.defaultOn) {
      try {
        const res = await this.http.get(star.url, { ttlMs: DAY, storeBody: false, maxBytes: 40_000_000, timeoutMs: 60_000 });
        if (res.status === 200 && res.body && !res.notModified) {
          const rows = parseStarIndex(res.body);
          const items: CatalogItem[] = [];
          for (const r of rows) {
            // curated and GitHub rows for the repo get the stars; the rest become plugin rows
            if (this.store.setRepoStats(r.repo, { stars: r.stars, at: day, description: r.description }) > 0) continue;
            items.push({
              id: `gh:${r.repo}`,
              kind: 'plugin',
              name: r.repo.split('/')[1],
              repo: r.repo,
              stars: r.stars,
              starsAt: day,
              description: r.description,
              category: 'dev',
              tags: ['plugin'],
              install: { type: 'manual', steps: [{ say: 'The preview reads this repo at its latest commit and works out how to add it.' }] },
              touches: [],
              recommended: false,
              source: 'star-index',
              verified: false,
            });
          }
          this.store.upsertItems(items, at);
          n += rows.length;
        }
        this.fetched('star-index');
      } catch (err) {
        this.sourceErrors.set('star-index', (err as Error).message);
      }
    }
    const csv = CATALOG_FEEDS.find((f) => f.id === 'awesome-claude-code');
    if (csv?.defaultOn) {
      try {
        const res = await this.http.get(csv.url, { ttlMs: DAY });
        if (res.status === 200 && res.body) {
          const items = awesomeItems(res.body).filter((i) => !this.store.getItem(i.id) || this.store.getItem(i.id)?.source === 'awesome-list');
          this.store.upsertItems(items, at);
          n += items.length;
        }
        this.fetched('awesome-claude-code');
      } catch (err) {
        this.sourceErrors.set('awesome-claude-code', (err as Error).message);
      }
    }
    return n;
  }

  /** Stars for repos on screen. Skips repos refreshed in the last day; never below the background budget. */
  async refreshStars(repos: string[]): Promise<number> {
    if (!this.on('github') || this.refreshingStars || this.now() < this.starsRetryAt) return 0;
    const stale = [...new Set(repos)].filter((r) => {
      const live = this.store.getItem(`gh:${r}`);
      return !live || this.now() - live.fetchedAt > DAY;
    });
    if (!stale.length) return 0;
    this.refreshingStars = true;
    try {
      const got = await this.github.stars(stale.slice(0, 30), true).catch(() => []);
      // nothing came back (no network, a refusal, no budget): leave GitHub alone for a while instead of asking on every list
      if (!got.length) this.starsRetryAt = this.now() + 10 * 60_000;
      const at = this.now();
      for (const g of got) {
        const existing = this.store.getItem(`gh:${g.fullName}`);
        const kind = existing?.kind ?? this.shipped.find((s) => s.repo?.toLowerCase() === g.fullName.toLowerCase())?.kind ?? 'plugin';
        this.store.upsertItem({ ...(existing ?? ghRepoToItem(g, kind, at)), stars: g.stars, starsAt: new Date(at).toISOString().slice(0, 10), updatedAt: g.pushedAt, archived: g.archived || undefined, license: existing?.license ?? g.license }, at);
      }
      if (got.length) this.fetched('github');
      return got.length;
    } finally {
      this.refreshingStars = false;
    }
  }

  /** POST /api/catalog/refresh: at most once a minute. */
  async refresh(source?: string): Promise<CatalogStatus> {
    const now = this.now();
    if (now - this.lastRefreshCall < 60_000) throw new CatalogError(429, 'Refreshed less than a minute ago. Try again shortly.', { retryAfter: Math.ceil((60_000 - (now - this.lastRefreshCall)) / 1000) });
    this.lastRefreshCall = now;
    await this.runRefresh(source);
    return this.status();
  }

  /** The daily job: marketplaces, registry, feeds, update checks and archived flags. */
  async runRefresh(source?: string): Promise<{ archived: string[] }> {
    const want = (s: string) => !source || source === s;
    if (want('marketplaces') && this.on('marketplaces')) await this.refreshMarketplaces().catch((e) => this.sourceErrors.set('marketplaces', (e as Error).message));
    if (want('mcp-registry') && this.on('mcp-registry')) await this.refreshRegistry().catch((e) => this.sourceErrors.set('mcp-registry', (e as Error).message));
    if (want('feeds') && this.on('feeds')) await this.refreshFeeds().catch(() => undefined);
    const archived: string[] = [];
    if (!source || source === 'installed') {
      await this.installer.checkUpdates().catch(() => undefined);
      const repos = this.store.listInstalls().map((r) => r.meta.repo).filter((x): x is string => !!x);
      if (this.on('github')) await this.refreshStars(repos).catch(() => undefined);
      const told = new Set(this.kv?.get<string[]>('catalog.archivedTold', []) ?? []);
      for (const row of this.store.listInstalls()) {
        const repo = row.meta.repo;
        const live = repo ? this.store.getItem(`gh:${repo}`) : undefined;
        if (live?.archived && !told.has(row.id)) {
          archived.push(row.id);
          told.add(row.id);
        }
      }
      this.kv?.set('catalog.archivedTold', [...told]);
    }
    this.kv?.set('catalog.lastRefresh', this.now());
    return { archived };
  }
}
