/**
 * GitHub client for Discover: repository search by topic and keywords, repo
 * stats, README heads and star refreshes. Every call goes through the
 * catalog HTTP cache with ETags (GitHub says a 304 does not count against
 * the limit). Rate limits are read from the response headers and kept in kv,
 * so a restart does not forget a block.
 *
 * Unauthenticated: 60 core calls an hour and 10 searches a minute. With a
 * token (secret catalog.github-token, else github-pat): 5,000 and 30.
 * Background work never spends below 10 core calls or 3 searches.
 */
import type { CachedResponse, CatalogHttp, FetchFn } from './http';
import { GITHUB_TOPICS, type CatalogCategory, type CatalogItem, type CatalogKind } from './recommended';
import type { GithubRate } from './types';

export const GITHUB_API = 'https://api.github.com';
export const RAW = 'https://raw.githubusercontent.com';

const HOUR = 3_600_000;
export const TTL = {
  search: HOUR,
  repo: 24 * HOUR,
  readme: 24 * HOUR,
} as const;

export interface GhRepo {
  fullName: string;
  name: string;
  owner: string;
  description: string;
  stars: number;
  license?: string;
  /** YYYY-MM-DD of the last push. */
  pushedAt?: string;
  archived: boolean;
  fork: boolean;
  topics: string[];
  defaultBranch?: string;
  htmlUrl: string;
  language?: string;
}

interface RateBucket {
  limit: number;
  remaining: number;
  /** Epoch ms. */
  reset: number;
}

export interface GithubRateState {
  authenticated: boolean;
  core: RateBucket;
  search: RateBucket;
  blockedUntil?: number;
  /** Which bucket the block is for. */
  blocked?: 'core' | 'search';
}

export interface GithubClientOptions {
  http: CatalogHttp;
  /** Returns the token, if any. Never logged. */
  token?: () => string | undefined;
  /** Persist rate state across restarts (kv). */
  load?: () => GithubRateState | undefined;
  save?: (s: GithubRateState) => void;
  now?: () => number;
  /** For GraphQL star batches (POST, not cached). */
  fetch?: FetchFn;
  api?: string;
}

export class RateLimitedError extends Error {
  constructor(readonly until: number) {
    super(`GitHub limit reached until ${new Date(until).toISOString()}`);
    this.name = 'RateLimitedError';
  }
}

/** YYYY-MM-DD from an ISO time; anything that is not a date (null, "nullT00:00:00Z") gives undefined. */
const day = (iso?: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);

export function mapGhRepo(raw: Record<string, unknown>): GhRepo {
  const owner = (raw.owner as { login?: string } | undefined)?.login ?? String(raw.full_name ?? '').split('/')[0];
  const lic = raw.license as { spdx_id?: string; name?: string } | null | undefined;
  const spdx = lic?.spdx_id && lic.spdx_id !== 'NOASSERTION' ? lic.spdx_id : lic?.name === 'Other' ? 'Other' : undefined;
  return {
    fullName: String(raw.full_name ?? ''),
    name: String(raw.name ?? ''),
    owner,
    description: typeof raw.description === 'string' ? raw.description : '',
    stars: Number(raw.stargazers_count ?? 0),
    license: spdx,
    pushedAt: day((raw.pushed_at as string) ?? (raw.updated_at as string)),
    archived: raw.archived === true,
    fork: raw.fork === true,
    topics: Array.isArray(raw.topics) ? (raw.topics as string[]) : [],
    defaultBranch: typeof raw.default_branch === 'string' ? raw.default_branch : undefined,
    htmlUrl: String(raw.html_url ?? `https://github.com/${raw.full_name}`),
    language: typeof raw.language === 'string' ? raw.language : undefined,
  };
}

/** The kind a repo most likely is, from its topics and name. */
export function kindFromRepo(repo: Pick<GhRepo, 'topics' | 'name' | 'description'>, fallback: CatalogKind): CatalogKind {
  const topics = new Set(repo.topics.map((t) => t.toLowerCase()));
  const order: Array<Exclude<CatalogKind, 'routine'>> = ['plugin', 'hook', 'subagent', 'command', 'skill', 'mcp'];
  // the searched kind wins when its topic is present
  if (fallback !== 'routine' && GITHUB_TOPICS[fallback]?.some((t) => topics.has(t))) return fallback;
  for (const k of order) if (GITHUB_TOPICS[k].some((t) => topics.has(t))) return k;
  if (/\bmcp\b|mcp-server|-mcp$|^mcp-/i.test(repo.name)) return 'mcp';
  if (/skills?\b/i.test(repo.name)) return 'skill';
  return fallback;
}

const CATEGORY_WORDS: Array<[CatalogCategory, RegExp]> = [
  ['memory', /\bmemory|knowledge (base|graph)|notes?\b|obsidian|zettel/i],
  ['token-savers', /\btoken|compress|terse|context window|cost\b/i],
  ['minimal-code', /\byagni|minimal|less code|simplif/i],
  ['ctf', /\bctf\b|capture the flag|pwn|reverse engineer|ghidra/i],
  ['security', /\bsecurity|vuln|cve|semgrep|pentest|audit\b/i],
  ['homelab', /\bproxmox|homelab|home assistant|kubernetes|docker|truenas|unraid/i],
  ['databases', /\bpostgres|mysql|sqlite|database|redis|mongo/i],
  ['browser', /\bbrowser|playwright|puppeteer|chrome|selenium/i],
  ['search', /\bsearch|searxng|brave|tavily|exa\b|web fetch/i],
  ['github-git', /\bgithub|gitlab|\bgit\b|pull request/i],
  ['docs', /\bdocs?\b|documentation|context7|markdown/i],
  ['review', /\breview/i],
  ['verification', /\btest(s|ing)?\b|verif/i],
  ['monitoring', /\bmonitor|grafana|prometheus|observab|logs?\b/i],
  ['calendar-mail', /\bcalendar|gmail|mail\b|outlook/i],
  ['tasks', /\btasks?\b|todo|kanban|project management/i],
  ['writing', /\bwriting|prose|copywrit/i],
  ['uni', /\bzotero|arxiv|paper|scholar|research/i],
];

export function guessCategory(text: string): CatalogCategory {
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(text)) return cat;
  return 'dev';
}

/** A live GitHub result as a catalog item. The preview works out the install. */
export function ghRepoToItem(repo: GhRepo, kind: CatalogKind, at: number): CatalogItem {
  return {
    id: `gh:${repo.fullName}`,
    kind,
    name: repo.name,
    repo: repo.fullName,
    url: repo.htmlUrl,
    stars: repo.stars,
    starsAt: new Date(at).toISOString().slice(0, 10),
    description: repo.description,
    category: guessCategory(`${repo.name} ${repo.description} ${repo.topics.join(' ')}`),
    tags: repo.topics.slice(0, 6).map((t) => t.replace(/-/g, ' ')),
    license: repo.license,
    updatedAt: repo.pushedAt,
    archived: repo.archived || undefined,
    install: { type: 'manual', steps: [{ say: 'The preview reads this repo at its latest commit and works out how to add it.' }] },
    touches: [],
    recommended: false,
    source: 'github',
    verified: false,
  };
}

function bucket(limit: number): RateBucket {
  return { limit, remaining: limit, reset: 0 };
}

export class GithubClient {
  private http: CatalogHttp;
  private tokenFn: () => string | undefined;
  private now: () => number;
  private state: GithubRateState;
  private saveFn?: (s: GithubRateState) => void;
  private fetchFn: FetchFn;
  readonly api: string;

  constructor(opts: GithubClientOptions) {
    this.http = opts.http;
    this.tokenFn = opts.token ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.saveFn = opts.save;
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.api = opts.api ?? GITHUB_API;
    this.state = opts.load?.() ?? { authenticated: false, core: bucket(60), search: bucket(10) };
    this.syncAuth();
  }

  private syncAuth(): void {
    const authed = !!this.tokenFn();
    if (authed !== this.state.authenticated) {
      this.state = authed
        ? { authenticated: true, core: bucket(5000), search: bucket(30) }
        : { authenticated: false, core: bucket(60), search: bucket(10) };
    }
  }

  private roll(): void {
    const now = this.now();
    for (const b of [this.state.core, this.state.search]) if (b.reset && now >= b.reset) {
      b.remaining = b.limit;
      b.reset = 0;
    }
    if (this.state.blockedUntil && now >= this.state.blockedUntil) {
      this.state.blockedUntil = undefined;
      this.state.blocked = undefined;
    }
  }

  rate(): GithubRate {
    this.syncAuth();
    this.roll();
    return {
      authenticated: this.state.authenticated,
      limit: this.state.core.limit,
      remaining: this.state.core.remaining,
      resetAt: this.state.core.reset,
      searchRemaining: this.state.search.remaining,
      blockedUntil: this.state.blockedUntil,
    };
  }

  /** Whether a call may go out now. Background work keeps a reserve for the owner. */
  canCall(kind: 'core' | 'search', background = false): boolean {
    this.syncAuth();
    this.roll();
    if (this.state.blockedUntil && (this.state.blocked === kind || this.state.blocked === undefined)) return false;
    const b = this.state[kind];
    if (b.remaining <= 0) return false;
    if (background) return kind === 'core' ? b.remaining > 10 : b.remaining >= 3;
    return true;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    const t = this.tokenFn();
    if (t) h.authorization = `Bearer ${t}`;
    return h;
  }

  /** Read limits from a response. A 403 or 429 with no calls left pauses that bucket until reset. */
  noteResponse(kind: 'core' | 'search', res: Pick<CachedResponse, 'headers' | 'liveStatus' | 'status' | 'fromCache' | 'notModified'> & { body?: string; error?: string }): void {
    const h = res.headers;
    const resource = (h['x-ratelimit-resource'] as 'core' | 'search' | undefined) ?? kind;
    const b = resource === 'search' ? this.state.search : this.state.core;
    if (h['x-ratelimit-limit']) b.limit = Number(h['x-ratelimit-limit']) || b.limit;
    if (h['x-ratelimit-remaining'] !== undefined) b.remaining = Number(h['x-ratelimit-remaining']);
    else if (!res.fromCache && !res.notModified) b.remaining = Math.max(0, b.remaining - 1);
    if (h['x-ratelimit-reset']) b.reset = Number(h['x-ratelimit-reset']) * 1000;
    const status = res.liveStatus ?? res.status;
    // a 403 is a limit only when GitHub says so (no calls left, retry-after, or the secondary limit text); other 403s are refusals
    const limited =
      status === 429 ||
      (status === 403 && (h['retry-after'] !== undefined || h['x-ratelimit-remaining'] === '0' || /rate limit/i.test(`${res.body ?? ''} ${res.error ?? ''}`.slice(0, 2000))));
    if (limited) {
      const retry = Number(h['retry-after']);
      let until: number;
      if (retry > 0) until = this.now() + retry * 1000;
      else if (b.remaining === 0 && b.reset) until = b.reset;
      else until = this.now() + 60_000;
      this.state.blockedUntil = until;
      this.state.blocked = resource === 'search' ? 'search' : 'core';
    }
    this.saveFn?.(this.state);
  }

  private async call(kind: 'core' | 'search', url: string, ttlMs: number, background: boolean): Promise<CachedResponse> {
    const res = await this.http.get(url, { ttlMs, headers: this.headers(), allow: () => this.canCall(kind, background) });
    if (res.error !== 'paused') this.noteResponse(kind, res);
    return res;
  }

  /** Raw repository search. `q` is the full GitHub query. */
  async searchRepositories(
    q: string,
    opts: { sort?: 'stars' | 'updated'; page?: number; perPage?: number; background?: boolean } = {},
  ): Promise<{ total: number; items: GhRepo[]; res: CachedResponse }> {
    const params = new URLSearchParams({ q: q.slice(0, 256), sort: opts.sort ?? 'stars', order: 'desc', per_page: String(opts.perPage ?? 30), page: String(opts.page ?? 1) });
    const url = `${this.api}/search/repositories?${params}`;
    const res = await this.call('search', url, TTL.search, opts.background ?? false);
    if (res.status !== 200 || !res.body) return { total: 0, items: [], res };
    try {
      const data = JSON.parse(res.body) as { total_count?: number; items?: Array<Record<string, unknown>> };
      return { total: data.total_count ?? 0, items: (data.items ?? []).map(mapGhRepo), res };
    } catch {
      return { total: 0, items: [], res };
    }
  }

  /** The query a kind search sends: terms, the topic, no archives or forks. */
  static kindQuery(terms: string, topic: string): string {
    return `${terms.trim()} topic:${topic} archived:false fork:false`.trim();
  }

  /**
   * Search one kind by its topics, most specific first. The next topic is
   * tried only when the results so far are fewer than 10.
   */
  async searchKind(
    terms: string,
    kind: Exclude<CatalogKind, 'routine'>,
    opts: { sort?: 'stars' | 'updated'; page?: number; background?: boolean } = {},
  ): Promise<{ items: GhRepo[]; total: number; responses: CachedResponse[] }> {
    const topics = GITHUB_TOPICS[kind] ?? [];
    const seen = new Map<string, GhRepo>();
    const responses: CachedResponse[] = [];
    let total = 0;
    for (const topic of topics.slice(0, 3)) {
      if (seen.size >= 10) break;
      const r = await this.searchRepositories(GithubClient.kindQuery(terms, topic), opts);
      responses.push(r.res);
      total += r.total;
      for (const it of r.items) if (!seen.has(it.fullName.toLowerCase())) seen.set(it.fullName.toLowerCase(), it);
      if (r.res.error === 'paused' || (r.res.liveStatus && r.res.liveStatus >= 400)) break;
    }
    return { items: [...seen.values()], total, responses };
  }

  async repo(fullName: string, background = false): Promise<GhRepo | undefined> {
    const res = await this.call('core', `${this.api}/repos/${fullName}`, TTL.repo, background).catch(() => undefined);
    if (!res || res.status !== 200 || !res.body) return undefined;
    try {
      return mapGhRepo(JSON.parse(res.body));
    } catch {
      return undefined;
    }
  }

  /** First 8 KB of the README over raw.githubusercontent.com (no API quota). */
  async readme(fullName: string, ref = 'HEAD'): Promise<string | undefined> {
    for (const name of ['README.md', 'readme.md', 'Readme.md', 'README']) {
      try {
        const res = await this.http.get(`${RAW}/${fullName}/${ref}/${name}`, { ttlMs: TTL.readme, maxBytes: 2_000_000 });
        if (res.status === 200 && res.body) return res.body.slice(0, 8192);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Fresh stars for these repos. With a token: GraphQL, 100 per query.
   * Without: search with repo: qualifiers, about 10 per call (the query is
   * capped at 256 chars).
   */
  async stars(repos: string[], background = true): Promise<GhRepo[]> {
    const list = [...new Set(repos.map((r) => r.trim()).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))];
    if (!list.length) return [];
    if (this.tokenFn()) return this.graphqlStars(list, background);
    const out: GhRepo[] = [];
    let batch: string[] = [];
    const flush = async () => {
      if (!batch.length) return;
      if (!this.canCall('search', background)) return;
      const q = batch.map((r) => `repo:${r}`).join(' ');
      const r = await this.searchRepositories(q, { perPage: 100, background });
      out.push(...r.items);
      batch = [];
    };
    for (const repo of list) {
      const next = [...batch, repo].map((r) => `repo:${r}`).join(' ');
      if (next.length > 256) await flush();
      batch.push(repo);
    }
    await flush();
    return out;
  }

  private async graphqlStars(repos: string[], background: boolean): Promise<GhRepo[]> {
    const out: GhRepo[] = [];
    for (let i = 0; i < repos.length; i += 100) {
      if (!this.canCall('core', background)) break;
      const chunk = repos.slice(i, i + 100);
      const fields = 'nameWithOwner name description stargazerCount isArchived isFork pushedAt url licenseInfo { spdxId } owner { login } defaultBranchRef { name }';
      const query = `query { ${chunk.map((r, n) => {
        const [o, name] = r.split('/');
        return `r${n}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(name)}) { ${fields} }`;
      }).join(' ')} }`;
      let res: Response;
      try {
        res = await this.fetchFn(`${this.api}/graphql`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        break;
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      this.noteResponse('core', { headers: { ...headers, 'x-ratelimit-resource': 'core' }, status: res.status, fromCache: false });
      if (!res.ok) break;
      const data = (await res.json().catch(() => ({}))) as { data?: Record<string, Record<string, unknown> | null> };
      for (const v of Object.values(data.data ?? {})) {
        if (!v) continue;
        out.push({
          fullName: String(v.nameWithOwner),
          name: String(v.name),
          owner: String((v.owner as { login?: string })?.login ?? ''),
          description: typeof v.description === 'string' ? v.description : '',
          stars: Number(v.stargazerCount ?? 0),
          license: ((l) => (l && l !== 'NOASSERTION' ? l : undefined))((v.licenseInfo as { spdxId?: string } | null)?.spdxId),
          pushedAt: day(v.pushedAt as string),
          archived: v.isArchived === true,
          fork: v.isFork === true,
          topics: [],
          defaultBranch: (v.defaultBranchRef as { name?: string } | null)?.name,
          htmlUrl: String(v.url),
        });
      }
    }
    return out;
  }
}
