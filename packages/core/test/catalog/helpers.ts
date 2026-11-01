/**
 * Catalog test helpers: a fetch that replays recorded fixtures (no network),
 * local git repos in temp folders (never github.com), a temp hub home and an
 * in-memory CatalogHost.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HooksConfig, McpServerConfig } from '../../src/config/schema';
import type { McpTestResult } from '../../src/client';
import type { CatalogHost } from '../../src/catalog/install';
import type { InstalledPlugin } from '../../src/extensions/types';
import { PluginManager } from '../../src/extensions/plugins';
import { openDb, type Db } from '../../src/storage/db';

export const FIXTURES = join(import.meta.dir, 'fixtures');
export const fx = (p: string) => readFileSync(join(FIXTURES, p), 'utf8');
export const fxJson = <T = Record<string, unknown>>(p: string) => JSON.parse(fx(p)) as T;

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export interface FixtureFetch {
  (url: string, init?: RequestInit): Promise<Response>;
  calls: Array<{ url: string; headers: Record<string, string> }>;
}

/** A fetch that answers from routes; anything else throws, so a test can never reach the network. */
export function fixtureFetch(routes: Array<[RegExp | string, Handler]>): FixtureFetch {
  const calls: FixtureFetch['calls'] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, headers });
    const u = new URL(url);
    for (const [pat, h] of routes) {
      if (typeof pat === 'string' ? url.startsWith(pat) : pat.test(url)) return h(u, init);
    }
    throw new TypeError(`fetch failed: no fixture for ${url}`);
  }) as FixtureFetch;
  f.calls = calls;
  return f;
}

export function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const dirs: string[] = [];

export function tmp(prefix = 'conclave-catalog-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export function cleanupAll(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function write(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode) chmodSync(path, mode);
}

export interface Home {
  home: string;
  db: Db;
  paths: { home: string; skills: string; agents: string; commands: string; hooks: string; cache: string; plugins: string };
}

export function tempHome(): Home {
  const home = tmp('conclave-home-');
  const paths = {
    home,
    skills: join(home, 'skills'),
    agents: join(home, 'agents'),
    commands: join(home, 'commands'),
    hooks: join(home, 'hooks'),
    cache: join(home, 'cache'),
    plugins: join(home, 'plugins'),
  };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
  return { home, db: openDb(join(home, 'conclave.db')), paths };
}

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, env: { ...process.env, ...GIT_ENV }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`);
  return out.trim();
}

/** A local repo that allows fetching any reachable commit (as GitHub does). Returns its path and a commit helper. */
export async function gitRepo(files: Record<string, string | { text: string; mode: number }>): Promise<{ dir: string; sha: string; commit(files: Record<string, string>, msg?: string): Promise<string> }> {
  const dir = tmp('conclave-repo-');
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  await git(dir, 'config', 'uploadpack.allowFilter', 'true');
  const put = (f: Record<string, string | { text: string; mode: number }>) => {
    for (const [p, v] of Object.entries(f)) {
      if (typeof v === 'string') write(join(dir, p), v);
      else write(join(dir, p), v.text, v.mode);
    }
  };
  put(files);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
  const sha = await git(dir, 'rev-parse', 'HEAD');
  return {
    dir,
    sha,
    async commit(more, msg = 'next') {
      put(more);
      await git(dir, 'add', '-A');
      await git(dir, 'commit', '-q', '-m', msg);
      return git(dir, 'rev-parse', 'HEAD');
    },
  };
}

export interface FakeHost extends CatalogHost {
  state: {
    secrets: Map<string, string>;
    mcp: Map<string, McpServerConfig>;
    audit: Array<{ action: string; detail: string }>;
    testResult: McpTestResult;
    hooks: HooksConfig;
    routines: Array<{ id: string; name: string; suggestion?: string }>;
    reloads: number;
    recipeInstalls: Array<{ id: string; req: unknown }>;
  };
  pm: PluginManager;
}

/** An in-memory host with a real PluginManager in the temp home. */
export function fakeHost(home: Home, opts: { recipes?: boolean } = {}): FakeHost {
  const pm = new PluginManager({ dir: home.paths.plugins, defaultMarketplaces: [] });
  const state: FakeHost['state'] = {
    secrets: new Map(),
    mcp: new Map(),
    audit: [],
    testResult: { ok: true, ms: 5, tools: 3 },
    hooks: {},
    routines: [],
    reloads: 0,
    recipeInstalls: [],
  };
  const host: FakeHost = {
    state,
    pm,
    secrets: {
      set: (k, v) => void state.secrets.set(k, v),
      has: (k) => state.secrets.has(k),
      remove: (k) => void state.secrets.delete(k),
      get: (k) => state.secrets.get(k),
    },
    mcp: {
      get: (n) => state.mcp.get(n),
      add: (n, c) => {
        if (state.mcp.has(n)) throw new Error('exists');
        state.mcp.set(n, c);
      },
      update: (n, c) => void state.mcp.set(n, c),
      remove: (n) => state.mcp.delete(n),
      test: async () => state.testResult,
    },
    plugins: {
      list: (): InstalledPlugin[] => pm.plugins(),
      installFrom: async (dir, o) => pm.installFromDir(dir, o),
      remove: (n) => pm.removePlugin(n),
      marketplaces: () => pm.marketplaceSources(),
      addMarketplace: (s) => pm.addMarketplace(s),
      removeMarketplace: async (s) => {
        const m = pm.marketplaceSources().find((x) => x.source.toLowerCase() === s.toLowerCase());
        return m ? pm.removeMarketplace(m.name) : false;
      },
    },
    reloadExtensions: async () => {
      state.reloads++;
    },
    hooks: () => state.hooks,
    routines: () => state.routines,
    audit: (action, detail) => void state.audit.push({ action, detail }),
  };
  if (opts.recipes) {
    host.recipes = {
      install: async (id, req) => {
        state.recipeInstalls.push({ id, req });
        return { tests: [{ name: 'blocks it', ok: true }, { name: 'lets it pass', ok: true }] };
      },
      remove: async () => undefined,
    };
  }
  return host;
}
