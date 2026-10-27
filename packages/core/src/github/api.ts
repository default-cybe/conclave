/**
 * The GitHub REST calls repo sessions need (docs/DESIGN.md 30). They run in
 * the hub process only, with the token in the Authorization header. Errors
 * carry GitHub's message and the status, never the token.
 */
import type { CiState, GithubRepoDto, PrState } from '../client/github';

export const DEFAULT_API_URL = 'https://api.github.com';
export const DEFAULT_GIT_URL = 'https://github.com';

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

export interface GithubUser {
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface RepoInfo extends GithubRepoDto {
  cloneUrl?: string;
}

export interface PullInfo {
  number: number;
  url: string;
  title: string;
  state: PrState;
  draft: boolean;
  headSha?: string;
  headRef: string;
}

export interface ChecksInfo {
  state: CiState;
  /** A link to a failing check, else a running one. */
  url?: string;
}

/** A failed check run or commit status, for "Fix failing checks". */
export interface FailedCheck {
  name: string;
  url?: string;
  /** The GitHub Actions job id (the check run id), only for checks the Actions app ran. */
  id?: number;
}

const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'];
/** Bytes kept from the end of a job log; real logs can be tens of MB. */
export const LOG_MAX_BYTES = 256 * 1024;

type Json = Record<string, any>;

/** A repository name GitHub accepts: owner/name with letters, digits, dot, dash and underscore. */
export function parseRepoName(full: string): { owner: string; name: string } | undefined {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(full.trim().replace(/\.git$/i, ''));
  if (!m || m[2] === '.' || m[2] === '..') return undefined;
  return { owner: m[1], name: m[2] };
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

function toRepo(r: Json): RepoInfo {
  return {
    fullName: String(r.full_name),
    owner: String(r.owner?.login ?? String(r.full_name).split('/')[0]),
    name: String(r.name),
    private: !!r.private,
    defaultBranch: String(r.default_branch || 'main'),
    ...(r.description ? { description: String(r.description) } : {}),
    ...(r.pushed_at ? { pushedAt: Date.parse(r.pushed_at) } : {}),
    url: String(r.html_url ?? ''),
    canPush: r.permissions ? !!(r.permissions.push || r.permissions.admin || r.permissions.maintain) : true,
    ...(r.clone_url ? { cloneUrl: String(r.clone_url) } : {}),
  };
}

function toPull(p: Json): PullInfo {
  const state: PrState = p.merged || p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open';
  return {
    number: Number(p.number),
    url: String(p.html_url ?? ''),
    title: String(p.title ?? ''),
    state,
    draft: !!p.draft,
    ...(p.head?.sha ? { headSha: String(p.head.sha) } : {}),
    headRef: String(p.head?.ref ?? ''),
  };
}

export class GithubApi {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly token: string,
    opts: { apiUrl?: string; fetch?: typeof fetch } = {},
  ) {
    this.base = trimBase(opts.apiUrl || DEFAULT_API_URL);
    this.doFetch = opts.fetch ?? fetch;
  }

  private async call<T = Json>(method: string, path: string, body?: unknown, opts: { allow404?: boolean } = {}): Promise<T | undefined> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'conclave-hub',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new GithubError(502, `GitHub did not answer: ${(err as Error).message}`);
    }
    if (res.status === 404 && opts.allow404) return undefined;
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const msg = (data as Json | undefined)?.message;
      const errors = ((data as Json | undefined)?.errors as Json[] | undefined)?.map((e) => e.message ?? e.code).filter(Boolean) ?? [];
      const detail = [typeof msg === 'string' ? msg : '', ...errors].filter(Boolean).join('. ');
      if (res.status === 401) throw new GithubError(401, 'GitHub did not accept the token. Make a new one and connect again.');
      throw new GithubError(res.status, detail ? `GitHub said: ${detail}` : `GitHub answered ${res.status}`);
    }
    return data as T;
  }

  async user(): Promise<GithubUser> {
    const u = (await this.call('GET', '/user'))!;
    return { login: String(u.login), ...(u.name ? { name: String(u.name) } : {}), ...(u.avatar_url ? { avatarUrl: String(u.avatar_url) } : {}) };
  }

  /** Every repository the token can see, most recently pushed first, up to max. */
  async repos(max = 500): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    for (let page = 1; out.length < max && page <= 10; page++) {
      const list = (await this.call<Json[]>('GET', `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`)) ?? [];
      out.push(...list.map(toRepo));
      if (list.length < 100) break;
    }
    return out.slice(0, max);
  }

  async repo(owner: string, name: string): Promise<RepoInfo | undefined> {
    const r = await this.call('GET', `/repos/${owner}/${name}`, undefined, { allow404: true });
    return r ? toRepo(r) : undefined;
  }

  async branches(owner: string, name: string): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const list = (await this.call<Json[]>('GET', `/repos/${owner}/${name}/branches?per_page=100&page=${page}`)) ?? [];
      out.push(...list.map((b) => String(b.name)));
      if (list.length < 100) break;
    }
    return out;
  }

  async createPull(owner: string, name: string, input: { title: string; body?: string; head: string; base: string; draft?: boolean }): Promise<PullInfo> {
    const p = (await this.call('POST', `/repos/${owner}/${name}/pulls`, { title: input.title, body: input.body ?? '', head: input.head, base: input.base, draft: !!input.draft }))!;
    return toPull(p);
  }

  /** The newest pull request from a branch of this repository, in any state. */
  async pullFor(owner: string, name: string, branch: string): Promise<PullInfo | undefined> {
    const list = (await this.call<Json[]>('GET', `/repos/${owner}/${name}/pulls?state=all&per_page=10&head=${encodeURIComponent(`${owner}:${branch}`)}`)) ?? [];
    const p = list.find((x) => x.head?.ref === branch) ?? list[0];
    return p ? toPull(p) : undefined;
  }

  /** Open pull requests, newest first, with who opened them: a shared project's code view. */
  async openPulls(owner: string, name: string, max = 100): Promise<Array<PullInfo & { author: string; updatedAt?: number }>> {
    const list = (await this.call<Json[]>('GET', `/repos/${owner}/${name}/pulls?state=open&sort=updated&direction=desc&per_page=${Math.min(100, max)}`)) ?? [];
    return list.slice(0, max).map((p) => ({ ...toPull(p), author: String(p.user?.login ?? ''), ...(p.updated_at ? { updatedAt: Date.parse(p.updated_at) } : {}) }));
  }

  async pull(owner: string, name: string, number: number): Promise<PullInfo | undefined> {
    const p = await this.call('GET', `/repos/${owner}/${name}/pulls/${number}`, undefined, { allow404: true });
    return p ? toPull(p) : undefined;
  }

  /**
   * Check runs and commit statuses of a commit, as one state. A token
   * without the permission to read them gives none, not an error.
   */
  async checks(owner: string, name: string, sha: string): Promise<ChecksInfo> {
    const runs = await this.call<Json>('GET', `/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`).catch((err) => {
      if (err instanceof GithubError && (err.status === 403 || err.status === 404)) return undefined;
      throw err;
    });
    const status = await this.call<Json>('GET', `/repos/${owner}/${name}/commits/${sha}/status`).catch((err) => {
      if (err instanceof GithubError && (err.status === 403 || err.status === 404)) return undefined;
      throw err;
    });
    let failing: string | undefined;
    let running: string | undefined;
    let any = false;
    for (const r of (runs?.check_runs as Json[] | undefined) ?? []) {
      any = true;
      if (r.status !== 'completed') running ??= r.html_url ?? r.details_url ?? '';
      else if (FAILED.includes(r.conclusion)) failing ??= r.html_url ?? r.details_url ?? '';
    }
    for (const s of (status?.statuses as Json[] | undefined) ?? []) {
      any = true;
      if (s.state === 'pending') running ??= s.target_url ?? '';
      else if (s.state === 'failure' || s.state === 'error') failing ??= s.target_url ?? '';
    }
    if (failing !== undefined) return { state: 'failure', ...(failing ? { url: failing } : {}) };
    if (running !== undefined) return { state: 'pending', ...(running ? { url: running } : {}) };
    return { state: any ? 'success' : 'none' };
  }

  /** The failed check runs and commit statuses of a commit, by name. */
  async failedChecks(owner: string, name: string, sha: string): Promise<FailedCheck[]> {
    const quiet = (err: unknown) => {
      if (err instanceof GithubError && (err.status === 403 || err.status === 404)) return undefined;
      throw err;
    };
    const runs = await this.call<Json>('GET', `/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`).catch(quiet);
    const status = await this.call<Json>('GET', `/repos/${owner}/${name}/commits/${sha}/status`).catch(quiet);
    const out: FailedCheck[] = [];
    for (const r of (runs?.check_runs as Json[] | undefined) ?? []) {
      if (r.status !== 'completed' || !FAILED.includes(r.conclusion)) continue;
      const url = r.html_url ?? r.details_url;
      const actions = r.app?.slug === 'github-actions' && Number.isInteger(r.id);
      out.push({ name: String(r.name ?? 'check'), ...(url ? { url: String(url) } : {}), ...(actions ? { id: r.id } : {}) });
    }
    for (const s of (status?.statuses as Json[] | undefined) ?? []) {
      if (s.state === 'failure' || s.state === 'error') out.push({ name: String(s.context ?? 'status'), ...(s.target_url ? { url: String(s.target_url) } : {}) });
    }
    return out;
  }

  /**
   * The log of a GitHub Actions job as text, or undefined when the check is
   * not an Actions job or the token cannot read it. GitHub answers with a
   * redirect to short-lived storage; that request goes without the token.
   */
  async jobLog(owner: string, name: string, jobId: number): Promise<string | undefined> {
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${this.token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'conclave-hub' };
    try {
      let res = await this.doFetch(`${this.base}/repos/${owner}/${name}/actions/jobs/${jobId}/logs`, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (to) res = await this.doFetch(to, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok || !res.body) return undefined;
      // keep only the last LOG_MAX_BYTES while streaming, so a huge log never sits in memory whole
      let kept = new Uint8Array(0);
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        const next = new Uint8Array(kept.length + chunk.length);
        next.set(kept);
        next.set(chunk, kept.length);
        kept = next.length > LOG_MAX_BYTES * 2 ? next.slice(-LOG_MAX_BYTES) : next;
      }
      return new TextDecoder().decode(kept.length > LOG_MAX_BYTES ? kept.slice(-LOG_MAX_BYTES) : kept);
    } catch {
      return undefined;
    }
  }
}
