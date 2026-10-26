/**
 * Repo sessions (docs/DESIGN.md 30): cloud-style coding on the owner's own
 * hub. Pick a GitHub repository; the hub keeps one clone of it per device,
 * gives each session its own git worktree on a new branch from a freshly
 * fetched base, pushes the branch, opens the pull request, follows its state
 * and checks, and removes the worktree after the merge.
 *
 * The token is the hub secret "github". It is used here only: in the
 * Authorization header of API calls from the hub process, and on stdin of
 * the git commands that reach GitHub (git.ts). Never in a session's shell,
 * a file in the worktree, a transcript or a log.
 */
import { posix } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Engine } from '../engine/engine';
import type { Machine } from '../machine/types';
import type { Tool } from '../tools/types';
import type { EngineEventEnvelope, Session } from '../types';
import type {
  CleanupInput,
  FolderGitDto,
  GithubBranchesDto,
  GithubRepoDto,
  GithubStatusDto,
  MergeInput,
  OpenPrInput,
  PrDraft,
  PushInput,
  PushResult,
  RepoSessionDto,
  RepoSessionInput,
  SessionRepoMeta,
  WorktreeSessionInput,
} from '../client/github';
import { EngineError } from '../engine/errors';
import { reminder } from '../session/transcript';
import { projectsOf } from '../projects/attached';
import { normalizeRemote } from '../projects/identity';
import { trimSlash } from '../projects/store';
import { addWorktree, mergeBranch, WorktreeError } from '../workflows/worktrees';
import { logger } from '../util/log';
import { DEFAULT_API_URL, DEFAULT_GIT_URL, GithubApi, GithubError, parseRepoName, type GithubUser, type RepoInfo } from './api';
import { cloneScript, fetchScript, git, gitError, pushOutcome, pushScript, remoteFor, scrub, shq, validBranch, validSha, committedBy, withCommittedBy, withToken, type Remote } from './git';
import { RepoStore, type RepoSessionRow } from './store';
import { pullRequestTool, PULL_REQUEST_TOOL } from './tool';
import { OWNER_ID, currentAccount, isMember, runAs } from '../people/context';

const log = logger('github');

/** The secret's name in secrets.json (values). */
export const GITHUB_SECRET = 'github';
const TOKEN_ENV = 'CONCLAVE_GITHUB_TOKEN';
const REPOS_TTL_MS = 2 * 60_000;
const USER_TTL_MS = 5 * 60_000;
const CLONE_TIMEOUT_MS = 15 * 60_000;
const NET_TIMEOUT_MS = 5 * 60_000;

/** A branch name part from a title or a task: lower-case words joined by dashes. */
export function slugify(text: string, max = 40): string {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 6);
  let out = '';
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || 'session';
}

function suffix(): string {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...randomBytes(4)].map((b) => abc[b % abc.length]).join('');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A GitHub repo session, or a folder worktree whose origin is on GitHub: Push and pull requests can work. */
function onGithub(row: RepoSessionRow): boolean {
  return row.source !== 'folder' || !!row.url;
}

/** owner/name of a remote on github.com, else undefined. */
export function githubName(remote: string): string | undefined {
  const n = normalizeRemote(remote);
  const m = n ? /^github\.com\/([\w.-]+)\/([\w.-]+)$/i.exec(n) : null;
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The compact form a session carries on meta.repo. */
function metaOf(row: RepoSessionRow): SessionRepoMeta {
  return {
    repo: row.repo,
    branch: row.branch,
    base: row.base,
    ...(row.prNumber && row.prUrl && row.prState ? { pr: { number: row.prNumber, url: row.prUrl, state: row.prState, ...(row.prDraft ? { draft: true } : {}) } } : {}),
    ...(row.ci && row.ci !== 'none' ? { ci: row.ci } : {}),
    ...(row.cleanedAt ? { cleaned: true } : {}),
    ...(row.source === 'folder' ? { folder: true } : {}),
    ...(row.mergedAt ? { merged: true } : {}),
  };
}

export class GithubService {
  readonly store: RepoStore;
  private off: Array<() => void> = [];
  private timer?: ReturnType<typeof setInterval>;
  private repoCache?: { at: number; key: string; list: RepoInfo[] };
  private userCache?: { at: number; key: string; user: GithubUser };
  /** One push, pull request or clean up at a time per session; one clone at a time per device and repository. */
  private locks = new Map<string, Promise<unknown>>();
  private bg = new Set<Promise<unknown>>();
  readonly tool = pullRequestTool(this);

  constructor(
    readonly engine: Engine,
    private readonly opts: { fetch?: typeof fetch; timer?: boolean } = {},
  ) {
    this.store = new RepoStore(engine.repos.db);
  }

  start(): void {
    if (this.off.length) return;
    this.off.push(
      this.engine.runnerExtensions.register({
        name: 'github',
        tools: (session, tools, depth) => {
          if (depth > 0 || session.kind === 'chat' || tools.some((t) => t.name === PULL_REQUEST_TOOL)) return;
          const row = this.store.get(session.id);
          if (!row || row.cleanedAt || !onGithub(row) || this.engine.isUntrusted(session)) return;
          return [...tools, this.tool as unknown as Tool];
        },
      }),
    );
    this.off.push(this.engine.bus.on((e) => this.onEvent(e)));
    const seconds = this.config().pollSeconds;
    if (this.opts.timer !== false && seconds > 0) {
      this.timer = setInterval(() => this.track(this.poll()), seconds * 1000);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    for (const f of this.off.splice(0)) f();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private track(p: Promise<unknown>): void {
    const done = p.catch((err) => log.debug('background work failed', err)).finally(() => this.bg.delete(done));
    this.bg.add(done);
  }

  /** Wait for background work (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.bg.size) await Promise.allSettled([...this.bg]);
  }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  config(): { apiUrl: string; gitUrl: string; reposRoot: string; pollSeconds: number } {
    const g = this.engine.config.get().github ?? {};
    return {
      apiUrl: (g.apiUrl || DEFAULT_API_URL).replace(/\/+$/, ''),
      gitUrl: (g.gitUrl || DEFAULT_GIT_URL).replace(/\/+$/, ''),
      reposRoot: g.reposRoot || '~/repos',
      pollSeconds: g.pollSeconds ?? 120,
    };
  }

  // -------------------------------------------------------------------------
  // The token
  // -------------------------------------------------------------------------

  /** The token and where it comes from. Only this module reads it. */
  private token(): { value?: string; source?: 'secret' | 'env' } {
    // each account has its own token (docs/design/ACCOUNTS.md); the hub's environment is the owner's
    const acct = currentAccount() ?? OWNER_ID;
    const secret = this.engine.accountSecrets.value(acct, GITHUB_SECRET);
    if (secret) return { value: secret, source: 'secret' };
    if (isMember(acct)) return {};
    const env = process.env[TOKEN_ENV];
    if (env) return { value: env, source: 'env' };
    return {};
  }

  private requireToken(): string {
    const t = this.token().value;
    if (!t) throw new EngineError(409, 'Connect GitHub first: Settings, GitHub, or conclave github login.');
    return t;
  }

  private api(token = this.requireToken()): GithubApi {
    return new GithubApi(token, { apiUrl: this.config().apiUrl, fetch: this.opts.fetch });
  }

  /** A GitHub error as the hub's: a 401 stays a 401's words, others say GitHub. */
  private fail(err: unknown): never {
    if (err instanceof EngineError) throw err;
    // GitHub refused or did not answer: a line in the hub's logs with the status, never the token
    log.warn('github request failed', { status: err instanceof GithubError ? err.status : undefined, error: scrub((err as Error)?.message ?? String(err), this.token().value) });
    if (err instanceof GithubError) throw new EngineError(err.status === 401 ? 409 : err.status === 404 ? 404 : err.status === 422 ? 422 : 502, scrub(err.message, this.token().value));
    throw new EngineError(502, scrub((err as Error)?.message ?? String(err), this.token().value));
  }

  private cacheKey(token: string): string {
    return `${currentAccount() ?? OWNER_ID}\u0000${this.config().apiUrl}\u0000${token.slice(-6)}\u0000${token.length}`;
  }

  async status(): Promise<GithubStatusDto> {
    const { value, source } = this.token();
    const apiUrl = this.config().apiUrl;
    const extra = apiUrl !== DEFAULT_API_URL ? { apiUrl } : {};
    if (!value) return { connected: false, ...extra };
    try {
      const user = await this.user(value);
      const repos = this.repoCache?.key === this.cacheKey(value) ? this.repoCache.list.length : undefined;
      return { connected: true, source, login: user.login, ...(user.name ? { name: user.name } : {}), ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}), ...(repos !== undefined ? { repos } : {}), ...extra };
    } catch (err) {
      log.warn('github check failed', { status: err instanceof GithubError ? err.status : undefined, error: scrub((err as Error)?.message ?? String(err), value) });
      return { connected: false, source, error: err instanceof GithubError ? scrub(err.message, value) : 'GitHub did not answer. Try again in a moment.', ...extra };
    }
  }

  private async user(token: string): Promise<GithubUser> {
    const key = this.cacheKey(token);
    if (this.userCache?.key === key && Date.now() - this.userCache.at < USER_TTL_MS) return this.userCache.user;
    const user = await this.api(token).user();
    this.userCache = { at: Date.now(), key, user };
    return user;
  }

  /** Check a token with GitHub, then keep it as the hub secret. A token GitHub refuses is not saved. */
  async connect(token: string): Promise<GithubStatusDto> {
    const t = token.trim();
    if (!t || /\s/.test(t) || t.length > 512) throw new EngineError(400, 'That does not look like a GitHub token.');
    let user: GithubUser;
    try {
      user = await this.api(t).user();
    } catch (err) {
      if (err instanceof GithubError && err.status === 401) throw new EngineError(400, 'GitHub did not accept that token. Check that you copied all of it and that it has not expired.');
      throw new EngineError(502, err instanceof GithubError ? scrub(err.message, t) : 'GitHub did not answer. Try again in a moment.');
    }
    this.engine.accountSecrets.set(currentAccount() ?? OWNER_ID, 'values', GITHUB_SECRET, t);
    this.userCache = { at: Date.now(), key: this.cacheKey(t), user };
    this.repoCache = undefined;
    this.engine.audit(undefined, 'github.connect', `@${user.login}`);
    this.engine.bus.emit({ type: 'config.updated' });
    await this.repos().catch(() => undefined);
    return this.status();
  }

  disconnect(): GithubStatusDto {
    this.engine.accountSecrets.set(currentAccount() ?? OWNER_ID, 'values', GITHUB_SECRET, undefined);
    this.userCache = undefined;
    this.repoCache = undefined;
    this.engine.audit(undefined, 'github.disconnect', 'token removed');
    this.engine.bus.emit({ type: 'config.updated' });
    const env = this.token();
    return { connected: false, ...(env.source ? { source: env.source } : {}) };
  }

  // -------------------------------------------------------------------------
  // Repositories
  // -------------------------------------------------------------------------

  /** Repositories the token can see, most recently pushed first; q filters by name and description. */
  async repos(q?: string, opts: { refresh?: boolean } = {}): Promise<GithubRepoDto[]> {
    const token = this.requireToken();
    const key = this.cacheKey(token);
    let list = this.repoCache?.key === key && Date.now() - this.repoCache.at < REPOS_TTL_MS && !opts.refresh ? this.repoCache.list : undefined;
    if (!list) {
      try {
        list = await this.api(token).repos();
      } catch (err) {
        this.fail(err);
      }
      this.repoCache = { at: Date.now(), key, list };
    }
    const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = words.length ? list.filter((r) => words.every((w) => r.fullName.toLowerCase().includes(w) || (r.description ?? '').toLowerCase().includes(w))) : list;
    return hits.map(({ cloneUrl: _c, ...r }) => r);
  }

  async branches(full: string): Promise<GithubBranchesDto> {
    const name = parseRepoName(full);
    if (!name) throw new EngineError(400, 'repo must be owner/name');
    const api = this.api();
    try {
      const info = await api.repo(name.owner, name.name);
      if (!info) throw new EngineError(404, `GitHub has no repository ${full} that this token can see.`);
      const all = await api.branches(name.owner, name.name);
      const branches = [info.defaultBranch, ...all.filter((b) => b !== info.defaultBranch).sort()];
      return { defaultBranch: info.defaultBranch, branches };
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * A repository as a shared project's code view shows it: its page, its
   * default branch, the open pull requests with who opened them, and its
   * branches. Only what this hub's token can see.
   */
  async repoActivity(full: string): Promise<{ fullName: string; url: string; private: boolean; defaultBranch: string; login?: string; pulls: Array<{ number: number; title: string; url: string; author: string; branch: string; draft: boolean; updatedAt?: number }>; branches: string[] }> {
    const name = parseRepoName(full);
    if (!name) throw new EngineError(400, 'repo must be owner/name');
    const token = this.requireToken();
    const api = this.api(token);
    try {
      const info = await api.repo(name.owner, name.name);
      if (!info) throw new EngineError(404, `GitHub has no repository ${full} that this hub's token can see.`);
      const [pulls, branches, user] = await Promise.all([api.openPulls(name.owner, name.name), api.branches(name.owner, name.name), this.user(token).catch(() => undefined)]);
      return {
        fullName: info.fullName,
        url: info.url,
        private: info.private,
        defaultBranch: info.defaultBranch,
        ...(user ? { login: user.login } : {}),
        pulls: pulls.map((p) => ({ number: p.number, title: p.title, url: p.url, author: p.author, branch: p.headRef, draft: p.draft, ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}) })),
        branches,
      };
    } catch (err) {
      this.fail(err);
    }
  }

  /** The GitHub login of this hub's token, when one is set and GitHub answers. */
  async login(): Promise<string | undefined> {
    const t = this.token().value;
    if (!t) return undefined;
    return (await this.user(t).catch(() => undefined))?.login;
  }

  // -------------------------------------------------------------------------
  // Devices and clones
  // -------------------------------------------------------------------------

  deviceName(id: string): string {
    return this.engine.devices.list().find((d) => d.id === id)?.name ?? id;
  }

  private machine(device: string): Machine {
    const id = device || 'local';
    const m = this.engine.devices.get(id);
    if (m) return m;
    if (!this.engine.devices.list().some((d) => d.id === id)) throw new EngineError(404, `There is no device ${id}.`);
    throw new EngineError(409, `${this.deviceName(id)} is offline. Repo sessions need the device online for git.`);
  }

  private async home(machine: Machine): Promise<string> {
    const h = await this.engine.machineHome(machine);
    if (!h) throw new EngineError(502, `Could not read the home folder on ${machine.name}.`);
    return trimSlash(h);
  }

  private remote(info: { owner: string; name: string }): Remote {
    try {
      return remoteFor(this.config().gitUrl, info.owner, info.name);
    } catch (err) {
      throw new EngineError(400, (err as Error).message);
    }
  }

  /** The git folder at path is the top of a repository whose remotes name this one. */
  private async isCloneOf(machine: Machine, path: string, remote: Remote, info: RepoInfo): Promise<'yes' | 'no' | 'missing'> {
    const st = await machine.stat(path).catch(() => null);
    if (!st) return 'missing';
    if (st.type !== 'dir') return 'no';
    const top = await git(machine, path, 'rev-parse --show-toplevel', 20_000).catch(() => undefined);
    if (!top?.ok || trimSlash(top.out) !== trimSlash(path)) {
      // a symlinked path: compare the real folders
      const real = await machine.exec(`cd ${shq(path)} && pwd -P`, { cwd: '/', timeoutMs: 10_000 }).catch(() => undefined);
      if (!top?.ok || !real || trimSlash(real.stdout.trim()) !== trimSlash(top.out)) return 'no';
    }
    const remotes = await git(machine, path, 'remote -v', 20_000).catch(() => undefined);
    const wanted = this.wantedRemotes(remote, info);
    const urls = (remotes?.out ?? '').split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean);
    return urls.some((u) => u === remote.url || wanted.has(normalizeRemote(u)?.toLowerCase() ?? '\u0000')) ? 'yes' : 'no';
  }

  /** Normalized remotes that mean this repository: github.com/owner/name, and the configured git address. */
  private wantedRemotes(remote: Remote, info: { owner: string; name: string }): Set<string> {
    const out = new Set<string>([`github.com/${info.owner}/${info.name}`.toLowerCase()]);
    const own = normalizeRemote(remote.url);
    if (own) out.add(own.toLowerCase());
    return out;
  }

  /**
   * The clone of a repository on a device: the one the hub made before, a
   * folder the projects service knows for this repository, ~/repos/<owner>/<repo>
   * when it is already a clone, else a new clone there.
   */
  async ensureClone(device: string, machine: Machine, info: RepoInfo, token: string): Promise<string> {
    return this.locked(`clone:${device}:${info.fullName.toLowerCase()}`, async () => {
      const remote = this.remote(info);
      const known = this.store.clone(device, info.fullName);
      if (known && (await this.isCloneOf(machine, known, remote, info)) === 'yes') {
        this.store.saveClone(device, info.fullName, known);
        return known;
      }
      const home = await this.home(machine);
      const worktrees = posix.join(home, '.conclave', 'worktrees');
      // a folder the projects service already knows for this repository on this device
      const projects = projectsOf(this.engine);
      if (projects) {
        const wanted = this.wantedRemotes(remote, info);
        for (const p of projects.store.list()) {
          if (!p.identity.remotes.some((r) => wanted.has(r.toLowerCase()))) continue;
          for (const loc of projects.store.locations(p.id)) {
            if (loc.device !== device || loc.path === worktrees || loc.path.startsWith(`${worktrees}/`)) continue;
            if ((await this.isCloneOf(machine, loc.path, remote, info)) === 'yes') {
              this.store.saveClone(device, info.fullName, loc.path);
              return loc.path;
            }
          }
        }
      }
      const rootDir = this.config().reposRoot;
      const reposRoot = rootDir === '~' ? home : rootDir.startsWith('~/') ? posix.join(home, rootDir.slice(2)) : rootDir;
      const dest = posix.join(reposRoot, info.owner, info.name);
      const there = await this.isCloneOf(machine, dest, remote, info);
      if (there === 'yes') {
        this.store.saveClone(device, info.fullName, dest);
        return dest;
      }
      if (there === 'no') throw new EngineError(409, `${dest} is there but is not a clone of ${info.fullName}. Move it away, or set github.reposRoot.`);
      const r = await withToken(machine, cloneScript(remote, dest), token, { cwd: '/', timeoutMs: CLONE_TIMEOUT_MS });
      if (!r.ok) throw new EngineError(502, `Cloning ${info.fullName} on ${machine.name} failed: ${gitError(r)}`);
      // the clone came without a checkout; fill the working tree without the token and without hooks
      const co = await git(machine, dest, 'reset -q --hard HEAD', 10 * 60_000);
      if (!co.ok) log.warn(`checkout after clone of ${info.fullName} failed: ${gitError(co)}`);
      this.store.saveClone(device, info.fullName, dest);
      this.engine.audit(undefined, 'github.clone', `${info.fullName} on ${device} at ${dest}`);
      return dest;
    });
  }

  /** The clone's object store, which fetch and push borrow. */
  private async objectsDir(machine: Machine, root: string): Promise<string> {
    const r = await git(machine, root, 'rev-parse --path-format=absolute --git-common-dir', 20_000);
    if (!r.ok || !r.out.startsWith('/')) throw new EngineError(502, `Could not read the git folder of ${root}: ${gitError(r)}`);
    return posix.join(trimSlash(r.out), 'objects');
  }

  /** Commits the clone has, so a fetch brings only what is new. */
  private async haves(machine: Machine, root: string): Promise<string[]> {
    const r = await git(machine, root, "for-each-ref --sort=-committerdate --count=24 --format='%(objectname)' refs/heads refs/remotes refs/conclave", 20_000).catch(() => undefined);
    return (r?.out ?? '').split('\n').map((s) => s.trim()).filter(validSha);
  }

  /** Fetch a branch fresh from GitHub into the clone; returns its commit. */
  private async fetchBase(machine: Machine, root: string, info: RepoInfo, base: string, token: string): Promise<string> {
    const objects = await this.objectsDir(machine, root);
    const r = await withToken(machine, fetchScript(this.remote(info), objects, base, await this.haves(machine, root)), token, { cwd: '/', timeoutMs: NET_TIMEOUT_MS });
    if (!r.ok) {
      if (/couldn't find remote ref|not our ref|no such ref/i.test(r.err)) throw new EngineError(404, `${info.fullName} has no branch ${base}.`);
      throw new EngineError(502, `Fetching ${base} of ${info.fullName} failed: ${gitError(r)}`);
    }
    const sha = r.out.split('\n').pop()?.trim() ?? '';
    if (!validSha(sha)) throw new EngineError(502, `Fetching ${base} gave no commit.`);
    // a ref keeps the fetched commits from git gc, out of the way of the owner's branches
    await git(machine, root, `update-ref ${shq(`refs/conclave/base/${base}`)} ${sha}`, 20_000);
    return sha;
  }

  // -------------------------------------------------------------------------
  // Starting a repo session
  // -------------------------------------------------------------------------

  async startSession(input: RepoSessionInput): Promise<Session> {
    const name = parseRepoName(input.repo ?? '');
    if (!name) throw new EngineError(400, 'repo must be owner/name, for example acme/widgets');
    const token = this.requireToken();
    let info: RepoInfo | undefined;
    try {
      info = await this.api(token).repo(name.owner, name.name);
    } catch (err) {
      this.fail(err);
    }
    if (!info) throw new EngineError(404, `GitHub has no repository ${input.repo} that this token can see.`);
    const base = input.base?.trim() || info.defaultBranch;
    if (!validBranch(base)) throw new EngineError(400, `${base} is not a branch name`);
    const device = input.device || 'local';
    const machine = this.machine(device);
    const home = await this.home(machine);

    const root = await this.ensureClone(device, machine, info, token);
    const baseSha = await this.fetchBase(machine, root, info, base, token);
    const defaultBranch = info.defaultBranch;
    return this.startIn(machine, input, {
      device,
      root,
      dir: posix.join(home, '.conclave', 'worktrees', 'gh', info.owner, info.name),
      row: { repo: info.fullName, base, baseSha, defaultBranch, url: info.url },
      reminder: (wt, branch, model) =>
        `This session works in a git worktree of ${info.fullName} at ${wt}, on the branch ${branch}, made from ${base} at ${baseSha.slice(0, 7)}. Commit your work on this branch, authored by the owner's git identity only, with no Co-authored-by line for an AI. End each commit message with the trailer line "${committedBy(model)}", or your model id from your environment if it changed. When it is done and checked, the PullRequest tool pushes the branch and can open a pull request; the owner approves each call. Do not push yourself, do not switch branches, and never push to ${defaultBranch}.`,
      audit: 'github.session',
    });
  }

  /** Whether a folder on a device is in a git repository, with its top folder, branch and GitHub name. */
  async folderGit(device: string, folder: string): Promise<FolderGitDto> {
    const machine = this.machine(device || 'local');
    const path = await this.expand(machine, folder);
    if (!(await machine.stat(path).catch(() => null))) return { git: false };
    const top = await git(machine, path, 'rev-parse --show-toplevel', 20_000).catch(() => undefined);
    if (!top?.ok || !top.out.startsWith('/')) return { git: false };
    const root = trimSlash(top.out);
    const [cur, origin] = await Promise.all([git(machine, root, 'symbolic-ref --short -q HEAD', 20_000), git(machine, root, 'remote get-url origin', 20_000)]);
    const gh = origin.ok ? githubName(origin.out) : undefined;
    return { git: true, root, ...(cur.ok && cur.out ? { branch: cur.out } : {}), ...(gh ? { github: gh } : {}) };
  }

  private async expand(machine: Machine, folder: string): Promise<string> {
    const f = folder.trim() || '~';
    if (f === '~' || f.startsWith('~/')) return trimSlash(posix.join(await this.home(machine), f.slice(2)));
    if (!f.startsWith('/')) throw new EngineError(400, 'folder must be an absolute path or start with ~/');
    return trimSlash(posix.normalize(f)) || '/';
  }

  /**
   * "Run in a worktree" on any git folder of a device: a new conclave/ branch
   * from the folder's current branch, in a worktree under
   * ~/.conclave/worktrees/dir/<name>-<hash>/ (outside the repository, so its
   * tools never see a nested copy). The folder itself is not touched.
   */
  async startFolderSession(input: WorktreeSessionInput): Promise<Session> {
    const device = input.device || 'local';
    const machine = this.machine(device);
    const where = await this.folderGit(device, input.folder ?? '');
    if (!where.git || !where.root) throw new EngineError(400, `${input.folder} is not in a git repository on ${machine.name}.`);
    const root = where.root;
    if (!where.branch) throw new EngineError(409, `${root} is on a detached commit. Check out a branch there first; the worktree's branch merges back into it.`);
    const base = where.branch;
    const head = await git(machine, root, 'rev-parse --verify -q HEAD', 20_000);
    if (!head.ok || !validSha(head.out)) throw new EngineError(409, `${root} has no commits yet. Make a first commit, then start the session.`);
    const home = await this.home(machine);
    const name = posix.basename(root) || 'repo';
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
    const gh = where.github;
    return this.startIn(machine, input, {
      device,
      root,
      dir: posix.join(home, '.conclave', 'worktrees', 'dir', `${name.replace(/[^\w.-]/g, '-')}-${hash}`),
      row: { repo: gh ?? name, base, baseSha: head.out, defaultBranch: base, url: gh ? `https://github.com/${gh}` : '', source: 'folder' },
      reminder: (wt, branch, model) =>
        `This session works in its own git worktree of ${root} at ${wt}, on the branch ${branch}, made from ${base} at ${head.out.slice(0, 7)}. Other sessions may work in the same repository at once, each in its own worktree. Work and commit only here, on this branch, authored by the owner's git identity only, with no Co-authored-by line for an AI. End each commit message with the trailer line "${committedBy(model)}", or your model id from your environment if it changed. The owner merges the branch into ${base} or discards it from the session header. Do not switch branches, do not merge into ${base}, do not push, and do not edit the main checkout at ${root}.`,
      audit: 'worktree.session',
    });
  }

  /** A new conclave/ branch and its worktree under dir, then the session in it: GitHub repo sessions and folder worktrees alike. */
  private async startIn(
    machine: Machine,
    input: Omit<WorktreeSessionInput, 'folder'>,
    w: {
      device: string;
      root: string;
      dir: string;
      row: Pick<RepoSessionRow, 'repo' | 'base' | 'baseSha' | 'defaultBranch' | 'url' | 'source'>;
      reminder: (wt: string, branch: string, model: string | undefined) => string;
      audit: string;
    },
  ): Promise<Session> {
    const { device, root } = w;
    const { repo, base, baseSha } = w.row;
    // a new branch and a worktree for it, under ~/.conclave/worktrees, never inside a synced folder
    const slug = slugify(input.title || input.prompt || 'session', 32);
    let branch = '';
    for (let i = 0; i < 6 && !branch; i++) {
      const b = `conclave/${slug}-${suffix()}`;
      const taken = this.store.branches(device, root).includes(b) || (await git(machine, root, `rev-parse --verify --quiet ${shq(`refs/heads/${b}`)}`, 20_000)).ok;
      if (!taken) branch = b;
    }
    if (!branch || !validBranch(branch)) throw new EngineError(500, 'Could not pick a branch name.');
    const wt = posix.join(w.dir, branch.slice('conclave/'.length).replace(/\//g, '-'));
    try {
      await addWorktree(machine, { root, path: wt, branch, base: baseSha });
    } catch (err) {
      throw err instanceof WorktreeError ? new EngineError(err.status, err.message) : err;
    }

    let session: Session;
    try {
      session = await this.engine.createSession({
        device,
        cwd: wt,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(input.chat ? { chat: input.chat } : {}),
      });
    } catch (err) {
      await git(machine, root, `worktree remove --force ${shq(wt)}`).catch(() => undefined);
      await git(machine, root, `branch -D ${shq(branch)}`).catch(() => undefined);
      throw err;
    }
    this.store.insert({ sessionId: session.id, device, clonePath: root, worktree: wt, branch, ...w.row });
    this.syncMeta(session.id);
    // the projects service learns the worktree as a folder of the repository's project, so checkpoints, the write gate, alerts and the Map see it
    await projectsOf(this.engine)?.recordState(session.id);
    this.engine.runnerFor(session.id).deliver({ block: reminder(w.reminder(wt, branch, session.model)), wake: false });
    this.engine.notice(session.id, `Working in a new worktree of ${repo} on ${branch}, from ${base} at ${baseSha.slice(0, 7)}.`, 'info');
    this.engine.audit(session.id, w.audit, `${repo} ${branch} from ${base} on ${device}`);
    if (input.prompt) await this.engine.send(session.id, { text: input.prompt });
    return this.engine.requireSession(session.id);
  }

  // -------------------------------------------------------------------------
  // A repo session
  // -------------------------------------------------------------------------

  row(sessionId: string): RepoSessionRow | undefined {
    return this.store.get(sessionId);
  }

  private requireRow(sessionId: string): RepoSessionRow {
    this.engine.requireSession(sessionId);
    const row = this.store.get(sessionId);
    if (!row) throw new EngineError(404, 'This session is not a repo session.');
    return row;
  }

  private nameOf(row: RepoSessionRow): { owner: string; name: string } {
    if (!onGithub(row)) throw new EngineError(409, `${row.clonePath} has no origin on GitHub, so there is nothing to push to. Merge the branch into ${row.base}, or discard it.`);
    const n = parseRepoName(row.repo);
    if (!n) throw new EngineError(500, `bad repository name ${row.repo}`);
    return n;
  }

  /** The compact form on session.meta.repo, written when it changed. */
  syncMeta(sessionId: string): void {
    const row = this.store.get(sessionId);
    const s = this.engine.repos.sessions.get(sessionId);
    if (!row || !s) return;
    const meta = metaOf(row);
    if (JSON.stringify(s.meta?.repo) === JSON.stringify(meta)) return;
    const next = { ...s, meta: { ...(s.meta ?? {}), repo: meta } };
    this.engine.repos.sessions.update(next);
    this.engine.bus.emit({ type: 'session.updated', session: next });
  }

  /** Branch commit, commits beyond the base, unpushed commits and uncommitted files, read on the device. */
  private async local(row: RepoSessionRow, machine: Machine | undefined): Promise<{ head?: string; commits?: number; unpushed?: number; dirty?: number; current?: string }> {
    if (!machine || row.cleanedAt) return {};
    if (!(await machine.stat(row.worktree).catch(() => null))) return {};
    const head = await git(machine, row.worktree, `rev-parse --verify --quiet ${shq(`refs/heads/${row.branch}`)}`, 20_000);
    if (!head.ok || !validSha(head.out)) return {};
    const [count, ahead, status, cur] = await Promise.all([
      git(machine, row.worktree, `rev-list --count ${row.baseSha}..${head.out}`, 20_000),
      row.pushedSha ? git(machine, row.worktree, `rev-list --count ${row.pushedSha}..${head.out}`, 20_000) : Promise.resolve(undefined),
      git(machine, row.worktree, 'status --porcelain', 30_000),
      git(machine, row.worktree, 'symbolic-ref --short -q HEAD', 20_000),
    ]);
    return {
      head: head.out,
      ...(count.ok ? { commits: Number(count.out) } : {}),
      ...(ahead?.ok ? { unpushed: Number(ahead.out) } : {}),
      ...(status.ok ? { dirty: status.out ? status.out.split('\n').length : 0 } : {}),
      current: cur.ok ? cur.out : '',
    };
  }

  /** The session's repository state for the apps. refresh reads the pull request from GitHub first. */
  async dto(sessionId: string, opts: { refresh?: boolean } = {}): Promise<RepoSessionDto> {
    if (opts.refresh) await this.refresh(sessionId).catch((err) => log.debug(`refresh of ${sessionId} failed`, err));
    const row = this.requireRow(sessionId);
    const machine = this.engine.devices.get(row.device);
    const l = await this.local(row, machine).catch(() => ({}) as Awaited<ReturnType<GithubService['local']>>);
    const pushed: RepoSessionDto['pushed'] = !row.pushedSha ? 'never' : l.head && l.head !== row.pushedSha ? 'behind' : 'current';
    const canCleanUp = !row.cleanedAt && (row.prState === 'merged' || row.prState === 'closed' || !!row.mergedAt);
    return {
      ...metaOf(row),
      sessionId,
      device: row.device,
      deviceName: this.deviceName(row.device),
      clonePath: row.clonePath,
      worktree: row.worktree,
      baseSha: row.baseSha,
      defaultBranch: row.defaultBranch,
      url: row.url,
      ...(row.pushedSha && row.url ? { branchUrl: `${row.url}/tree/${row.branch}` } : {}),
      ...(l.head ? { head: l.head } : {}),
      ...(l.commits !== undefined ? { commits: l.commits } : {}),
      ...(l.dirty !== undefined ? { dirty: l.dirty } : {}),
      ...(row.pushedSha ? { pushedSha: row.pushedSha } : {}),
      ...(row.pushedAt ? { pushedAt: row.pushedAt } : {}),
      pushed,
      ...(row.prTitle ? { prTitle: row.prTitle } : {}),
      ...(row.ciUrl ? { ciUrl: row.ciUrl } : {}),
      ...(row.checkedAt ? { checkedAt: row.checkedAt } : {}),
      canCleanUp,
      pullRequests: onGithub(row) && !!this.token().value,
      canMerge: row.source === 'folder' && !row.cleanedAt && !row.mergedAt && row.prState !== 'merged' && !!l.commits,
      online: !!machine,
      line: this.line(row, l, pushed),
    };
  }

  /** One plain sentence: where the branch and the pull request stand. */
  line(row: RepoSessionRow, l: { commits?: number; unpushed?: number; dirty?: number }, pushed: RepoSessionDto['pushed']): string {
    const dirty = l.dirty ? ` ${plural(l.dirty, 'file')} ${l.dirty === 1 ? 'is' : 'are'} not committed.` : '';
    if (row.source === 'folder' && !row.prNumber) {
      if (row.cleanedAt) return row.mergedAt ? `Merged into ${row.base} and cleaned up.` : 'Discarded. The worktree is gone.';
      if (row.mergedAt) return `Merged into ${row.base}. Clean up removes the worktree and ${row.branch}.${dirty}`;
      if (pushed === 'never') return `${l.commits ? `${plural(l.commits, 'commit')} ahead of ${row.base}.` : 'No commits yet.'}${dirty}`;
    }
    if (row.cleanedAt) return `Cleaned up. The branch stays on GitHub.`;
    const pr = row.prNumber ? `Pull request #${row.prNumber}` : '';
    if (row.prState === 'merged') return `${pr} was merged. Clean up removes the worktree.`;
    if (row.prState === 'closed') return `${pr} was closed without a merge. Clean up removes the worktree.`;
    const waiting = pushed === 'behind' && l.unpushed ? ` ${plural(l.unpushed, 'new commit')} ${l.unpushed === 1 ? 'is' : 'are'} not pushed.` : '';
    if (row.prState === 'open') {
      const ci = row.ci === 'pending' ? ' Checks are running.' : row.ci === 'success' ? ' Checks passed.' : row.ci === 'failure' ? ' A check failed.' : '';
      return `${pr} is ${row.prDraft ? 'open as a draft' : 'open'}.${ci}${waiting}${dirty}`;
    }
    if (pushed === 'current') return `Pushed. No pull request yet.${dirty}`;
    if (pushed === 'behind') return `Pushed before.${waiting}${dirty}`;
    if (l.commits) return `${plural(l.commits, 'commit')}, not pushed yet.${dirty}`;
    return `No commits yet.${dirty}`;
  }

  // -------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------

  async push(sessionId: string, input: PushInput = {}): Promise<PushResult> {
    return this.locked(`session:${sessionId}`, () => this.pushNow(sessionId, input));
  }

  private async pushNow(sessionId: string, input: PushInput): Promise<PushResult> {
    const row = this.requireRow(sessionId);
    if (row.cleanedAt) throw new EngineError(409, 'This session was cleaned up. Its worktree is gone.');
    const { owner, name } = this.nameOf(row);
    const token = this.requireToken();
    let info: RepoInfo | undefined;
    try {
      info = await this.api(token).repo(owner, name);
    } catch (err) {
      this.fail(err);
    }
    if (!info) throw new EngineError(404, `GitHub has no repository ${row.repo} that this token can see.`);
    // never the default branch: the session's own branch is the only place a push goes
    if (!validBranch(row.branch) || !row.branch.startsWith('conclave/') || row.branch === info.defaultBranch || row.branch === row.defaultBranch) {
      throw new EngineError(409, `Conclave never pushes to the default branch (${info.defaultBranch}). This session pushes only to its own conclave/ branch.`);
    }
    if (!info.canPush) throw new EngineError(403, `The token cannot push to ${row.repo}. Give it Contents read and write on this repository.`);
    const machine = this.machine(row.device);
    if (!(await machine.stat(row.worktree).catch(() => null))) throw new EngineError(409, `The worktree ${row.worktree} is not on ${machine.name}.`);
    const cur = await git(machine, row.worktree, 'symbolic-ref --short -q HEAD', 20_000);
    if (cur.out !== row.branch) throw new EngineError(409, `The worktree is on ${cur.out || 'a detached commit'}, not on ${row.branch}. Switch back to ${row.branch} to push.`);

    let committed: number | undefined;
    const status = await git(machine, row.worktree, 'status --porcelain', 60_000);
    let dirty = status.ok && status.out ? status.out.split('\n').length : 0;
    if (dirty && input.commitMessage?.trim()) {
      const ident = await this.identity(machine, row.worktree, token);
      const add = await git(machine, row.worktree, 'add -A', 120_000);
      const c = add.ok ? await git(machine, row.worktree, `${ident} commit -q --no-verify -m ${shq(withCommittedBy(input.commitMessage, this.engine.getSession(sessionId)?.model))}`, 120_000) : add;
      if (!c.ok) throw new EngineError(502, `Committing failed: ${gitError(c)}`);
      committed = dirty;
      dirty = 0;
    }
    const head = await git(machine, row.worktree, `rev-parse --verify ${shq(`refs/heads/${row.branch}`)}`, 20_000);
    if (!head.ok || !validSha(head.out)) throw new EngineError(409, `The branch ${row.branch} is gone from the worktree.`);
    const sha = head.out;
    const count = await git(machine, row.worktree, `rev-list --count ${row.baseSha}..${sha}`, 20_000);
    const commits = count.ok ? Number(count.out) : 0;
    if (!commits) throw new EngineError(409, `There are no commits on ${row.branch} beyond ${row.base} yet. Commit the work first.${dirty ? ` ${plural(dirty, 'file')} ${dirty === 1 ? 'is' : 'are'} not committed.` : ''}`);

    const objects = await this.objectsDir(machine, row.clonePath);
    const r = await withToken(machine, pushScript(this.remote(info), objects, sha, row.branch), token, { cwd: '/', timeoutMs: NET_TIMEOUT_MS });
    const outcome = pushOutcome(r.out);
    if (!r.ok || outcome.flag === '!') {
      const text = `${outcome.summary} ${r.err}`;
      if (/non-fast-forward|fetch first|stale info|rejected/i.test(text)) {
        throw new EngineError(409, `GitHub has commits on ${row.branch} that this session does not have. Conclave never force pushes. Bring them into the worktree first, or start a new session.`);
      }
      throw new EngineError(502, `Pushing ${row.branch} failed: ${gitError(r)}`);
    }
    const moved = outcome.flag !== '=';
    this.store.update(sessionId, { pushedSha: sha, pushedAt: Date.now() });
    this.syncMeta(sessionId);
    this.engine.audit(sessionId, 'github.push', `${row.repo} ${row.branch} ${sha.slice(0, 12)}`);
    const line = moved ? `Pushed ${plural(commits, 'commit')} to ${row.branch} on ${row.repo}.` : `${row.branch} on ${row.repo} is already up to date.`;
    if (moved) this.engine.notice(sessionId, line, 'info');
    return { pushed: moved, branch: row.branch, sha, commits, ...(committed ? { committed } : {}), ...(dirty ? { dirty } : {}), line: dirty ? `${line} ${plural(dirty, 'file')} ${dirty === 1 ? 'is' : 'are'} not committed.` : line };
  }

  /** `-c user.name -c user.email` when the device has no git identity: the GitHub login and its noreply address. */
  private async identity(machine: Machine, cwd: string, token: string): Promise<string> {
    const email = await git(machine, cwd, 'config user.email', 10_000);
    const name = await git(machine, cwd, 'config user.name', 10_000);
    if (email.ok && email.out && name.ok && name.out) return '';
    const user = await this.user(token).catch(() => undefined);
    const login = user?.login ?? 'conclave';
    return `-c ${shq(`user.name=${name.out || user?.name || login}`)} -c ${shq(`user.email=${email.out || `${login}@users.noreply.github.com`}`)}`;
  }

  // -------------------------------------------------------------------------
  // Pull request
  // -------------------------------------------------------------------------

  /** A title and body from the session: its title or the commit, the last answer, and the commits. */
  async draft(sessionId: string): Promise<PrDraft> {
    const row = this.requireRow(sessionId);
    const s = this.engine.requireSession(sessionId);
    const machine = this.engine.devices.get(row.device);
    let commits: PrDraft['commits'] = [];
    if (machine && !row.cleanedAt) {
      const log = await git(machine, row.worktree, `log --format=%H%x09%s -n 50 ${row.baseSha}..${shq(`refs/heads/${row.branch}`)}`, 20_000);
      if (log.ok && log.out) commits = log.out.split('\n').map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }));
    }
    const titled = s.title && s.title !== 'New chat' ? s.title : '';
    const title = (commits.length === 1 ? commits[0].subject : titled || commits[commits.length - 1]?.subject || row.branch).slice(0, 200);
    // the last answer of the session, with the worktree's path made relative
    const msgs = this.engine.repos.messages.list(sessionId);
    let answer = '';
    for (let i = msgs.length - 1; i >= 0 && !answer; i--) {
      const m = msgs[i];
      if (m.role !== 'assistant' || (m.kind && m.kind !== 'normal')) continue;
      answer = m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }
    answer = answer.split(`${row.worktree}/`).join('').split(row.worktree).join('.').trim();
    if (answer.length > 1500) answer = `${answer.slice(0, 1500).replace(/\s+\S*$/, '')}…`;
    const parts = [answer, commits.length ? `## Commits\n\n${commits.map((c) => `- ${c.subject} (${c.sha.slice(0, 7)})`).join('\n')}` : '', `Made in the Conclave session "${titled || row.branch}".`].filter(Boolean);
    return { title, body: parts.join('\n\n'), base: row.base, head: row.branch, commits };
  }

  async openPr(sessionId: string, input: OpenPrInput): Promise<RepoSessionDto> {
    await this.locked(`session:${sessionId}`, async () => {
      const row = this.requireRow(sessionId);
      if (row.prNumber && row.prState === 'open') throw new EngineError(409, `Pull request #${row.prNumber} is already open.`);
      const title = input.title?.trim();
      if (!title) throw new EngineError(400, 'A pull request needs a title.');
      // GitHub needs the branch there first
      await this.pushNow(sessionId, {});
      const { owner, name } = this.nameOf(row);
      const api = this.api();
      let pr;
      try {
        pr = await api.createPull(owner, name, { title, body: input.body ?? '', head: row.branch, base: row.base, draft: !!input.draft });
      } catch (err) {
        // one GitHub already has for this branch (opened on github.com, or by an earlier try)
        if (err instanceof GithubError && err.status === 422 && /already exists/i.test(err.message)) pr = await api.pullFor(owner, name, row.branch).catch(() => undefined);
        if (!pr) this.fail(err);
      }
      this.store.update(sessionId, { prNumber: pr.number, prUrl: pr.url, prState: pr.state, prTitle: pr.title, prDraft: pr.draft, checkedAt: Date.now() });
      this.engine.audit(sessionId, 'github.pr', `${row.repo}#${pr.number} ${row.branch} into ${row.base}`);
      this.engine.notice(sessionId, `Opened pull request #${pr.number}: ${pr.title}.`, 'info');
      await this.readChecks(sessionId).catch(() => undefined);
      this.syncMeta(sessionId);
    });
    return this.dto(sessionId);
  }

  private async readChecks(sessionId: string): Promise<void> {
    const row = this.store.get(sessionId);
    const sha = row?.pushedSha;
    if (!row || !sha) return;
    const { owner, name } = this.nameOf(row);
    const c = await this.api().checks(owner, name, sha);
    this.store.update(sessionId, { ci: c.state, ciUrl: c.url });
  }

  /** Read the pull request and its checks from GitHub. A pull request opened on github.com for the branch is adopted. */
  async refresh(sessionId: string): Promise<void> {
    const row = this.requireRow(sessionId);
    if (!this.token().value || !onGithub(row)) return;
    const { owner, name } = this.nameOf(row);
    const api = this.api();
    try {
      const pr = row.prNumber ? await api.pull(owner, name, row.prNumber) : row.pushedSha ? await api.pullFor(owner, name, row.branch) : undefined;
      if (!pr) {
        this.store.update(sessionId, { checkedAt: Date.now() });
        return;
      }
      const before = row.prState;
      this.store.update(sessionId, { prNumber: pr.number, prUrl: pr.url, prState: pr.state, prTitle: pr.title, prDraft: pr.draft, checkedAt: Date.now() });
      const sha = pr.headSha && validSha(pr.headSha) ? pr.headSha : row.pushedSha;
      if (sha && pr.state === 'open') {
        const c = await api.checks(owner, name, sha);
        this.store.update(sessionId, { ci: c.state, ciUrl: c.url });
      }
      if (before && before !== pr.state && pr.state !== 'open') {
        this.engine.notice(sessionId, pr.state === 'merged' ? `Pull request #${pr.number} was merged. Clean up removes the worktree; the branch stays on GitHub.` : `Pull request #${pr.number} was closed without a merge.`, 'info');
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.syncMeta(sessionId);
    }
  }

  /** One pass over open pull requests (the timer, and tests). */
  async poll(): Promise<void> {
    for (const row of this.store.open().slice(0, 20)) {
      const acct = this.engine.sessionAccount(row.sessionId);
      if (!acct) continue;
      // each pull request is read with its own account's token
      await runAs(acct, () => this.refresh(row.sessionId)).catch((err) => log.debug(`poll of ${row.repo}#${row.prNumber} failed`, err));
    }
  }

  // -------------------------------------------------------------------------
  // Merge (a folder's worktree)
  // -------------------------------------------------------------------------

  /**
   * Merge the branch into its base in the main checkout (the folder the
   * session started from). Refused while the worktree or the main checkout
   * has uncommitted changes; a conflict is undone and refused.
   */
  async merge(sessionId: string, input: MergeInput = {}): Promise<RepoSessionDto> {
    await this.locked(`session:${sessionId}`, async () => {
      const row = this.requireRow(sessionId);
      if (row.source !== 'folder') throw new EngineError(409, 'A GitHub repo session merges through its pull request.');
      if (row.cleanedAt) throw new EngineError(409, 'This session was cleaned up. Its worktree is gone.');
      if (row.mergedAt) throw new EngineError(409, `${row.branch} is already merged into ${row.base}.`);
      const machine = this.machine(row.device);
      const l = await this.local(row, machine);
      if (l.head === undefined) throw new EngineError(409, `The worktree ${row.worktree} or its branch ${row.branch} is not on ${machine.name}.`);
      if (l.dirty) throw new EngineError(409, `${plural(l.dirty, 'file')} in the worktree ${l.dirty === 1 ? 'is' : 'are'} not committed, so ${l.dirty === 1 ? 'it' : 'they'} would not be merged. Commit or discard ${l.dirty === 1 ? 'it' : 'them'} first.`);
      if (!l.commits) throw new EngineError(409, `There are no commits on ${row.branch} beyond ${row.base} to merge.`);
      const title = this.engine.getSession(sessionId)?.title;
      const message = withCommittedBy(title && title !== 'New chat' ? title : `Squash merge ${row.branch}`, this.engine.getSession(sessionId)?.model);
      let r: Awaited<ReturnType<typeof mergeBranch>>;
      try {
        r = await mergeBranch(machine, { root: row.clonePath, branch: row.branch, into: row.base, squash: !!input.squash, message });
      } catch (err) {
        throw err instanceof WorktreeError ? new EngineError(err.status, err.message) : err;
      }
      if (!r.ok) {
        if (r.conflict) throw new EngineError(409, `${row.branch} conflicts with ${row.base} in ${row.clonePath}. Nothing was merged and the main checkout is as it was. Bring ${row.base} into the branch in the worktree (git merge ${row.base}), resolve it there, then merge again.`);
        throw new EngineError(502, `Merging ${row.branch} into ${row.base} failed: ${r.output.split('\n').slice(-3).join(' ')}`);
      }
      this.store.update(sessionId, { mergedAt: Date.now() });
      this.syncMeta(sessionId);
      this.engine.notice(sessionId, `${input.squash ? 'Squash merged' : 'Merged'} ${plural(l.commits, 'commit')} of ${row.branch} into ${row.base}. Clean up removes the worktree and the branch.`, 'info');
      this.engine.audit(sessionId, 'worktree.merge', `${row.clonePath} ${row.branch} into ${row.base}${input.squash ? ' (squash)' : ''}`);
    });
    return this.dto(sessionId);
  }

  // -------------------------------------------------------------------------
  // Clean up and Discard
  // -------------------------------------------------------------------------

  /**
   * Remove the worktree; a GitHub branch stays on GitHub. Before a merge or
   * close, or with uncommitted files, only with force. discard removes the
   * local branch too, merged or not; with uncommitted files it needs force.
   */
  async cleanup(sessionId: string, input: CleanupInput = {}): Promise<RepoSessionDto> {
    await this.locked(`session:${sessionId}`, async () => {
      let row = this.requireRow(sessionId);
      if (row.cleanedAt) return;
      // merged on github.com a moment ago: read it now instead of waiting for the poll
      if (row.prNumber && row.prState === 'open' && !input.force) {
        await this.refresh(sessionId).catch((err) => log.debug(`refresh before clean up of ${sessionId} failed`, err));
        row = this.requireRow(sessionId);
      }
      if (!input.force && !input.discard && row.prState !== 'merged' && row.prState !== 'closed' && !row.mergedAt) {
        throw new EngineError(
          409,
          row.prNumber
            ? `Pull request #${row.prNumber} is still open. Clean up with force to remove the worktree anyway.`
            : row.source === 'folder'
              ? `${row.branch} is not merged into ${row.base} yet. Merge it, or discard it.`
              : 'There is no merged or closed pull request yet. Clean up with force to remove the worktree anyway.',
        );
      }
      const machine = this.machine(row.device);
      await this.removeWorktree(machine, row, !!input.force, !!input.discard || (row.source === 'folder' && !!row.mergedAt));
      this.store.update(sessionId, { cleanedAt: Date.now() });
      const s = this.engine.repos.sessions.get(sessionId);
      const projects = projectsOf(this.engine);
      if (projects && s?.projectId) projects.store.removeLocation(s.projectId, row.device, row.worktree);
      this.syncMeta(sessionId);
      const words = input.discard ? `Discarded. The worktree and ${row.branch} are gone.` : row.source === 'folder' ? `Cleaned up. The worktree and ${row.branch} are gone.` : `Cleaned up. The worktree is gone and ${row.branch} stays on GitHub.`;
      this.engine.notice(sessionId, words, 'info');
      this.engine.audit(sessionId, input.discard ? 'worktree.discard' : 'github.cleanup', `${row.repo} ${row.branch} ${row.worktree}`);
    });
    return this.dto(sessionId);
  }

  /**
   * git worktree remove, then the local branch: with dropBranch always, else
   * when GitHub has it as it is. The remote branch is never touched.
   */
  private async removeWorktree(machine: Machine, row: RepoSessionRow, force: boolean, dropBranch = false): Promise<void> {
    const there = await machine.stat(row.worktree).catch(() => null);
    if (there) {
      const status = await git(machine, row.worktree, 'status --porcelain', 60_000);
      const dirty = status.ok && status.out ? status.out.split('\n').length : 0;
      if (dirty && !force) throw new EngineError(409, `${plural(dirty, 'file')} in the worktree ${dirty === 1 ? 'is' : 'are'} not committed. Commit ${dirty === 1 ? 'it' : 'them'}, or ${dropBranch ? 'discard' : 'clean up'} with force to lose ${dirty === 1 ? 'it' : 'them'}.`);
      const r = await git(machine, row.clonePath, `worktree remove ${force ? '--force ' : ''}${shq(row.worktree)}`, 120_000);
      // git deletes the folder first; its .git/worktrees entry can then fail ("Directory not empty") while
      // a detached auto-maintenance from the agent's last commit still writes there. Prune finishes the job.
      if (!r.ok && (await machine.stat(row.worktree).catch(() => null))) throw new EngineError(502, `git worktree remove failed: ${gitError(r)}`);
      for (let i = 0; !r.ok && i < 5; i++) {
        await git(machine, row.clonePath, 'worktree prune', 60_000);
        const list = await git(machine, row.clonePath, 'worktree list --porcelain', 20_000);
        if (list.ok && !list.out.split('\n').includes(`worktree ${row.worktree}`)) break;
        await Bun.sleep(200);
      }
    } else {
      await git(machine, row.clonePath, 'worktree prune', 60_000).catch(() => undefined);
    }
    const head = await git(machine, row.clonePath, `rev-parse --verify --quiet ${shq(`refs/heads/${row.branch}`)}`, 20_000);
    if (head.ok && (dropBranch || (row.pushedSha && head.out === row.pushedSha))) await git(machine, row.clonePath, `branch -D ${shq(row.branch)}`, 20_000);
  }

  private onEvent(e: EngineEventEnvelope): void {
    if (e.type !== 'session.deleted') return;
    const row = this.store.get(e.sessionId);
    if (!row) return;
    this.store.delete(e.sessionId);
    if (row.cleanedAt) return;
    const machine = this.engine.devices.get(row.device);
    if (!machine) return;
    // a deleted session's worktree goes when nothing in it is uncommitted; its branch stays in the clone
    this.track(
      this.removeWorktree(machine, row, false).catch((err) => log.info(`kept the worktree of a deleted session at ${row.worktree}: ${(err as Error).message}`)),
    );
  }
}
