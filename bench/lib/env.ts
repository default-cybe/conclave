/**
 * Clean environments for the agents and the scorer (PROTOCOL 4.2, 4.3).
 *
 * Both arms get HOME=bench/.state/home, the real toolchain paths, the offline
 * variables and nothing from the caller's CLAUDE_*, ANTHROPIC_* or CONCLAVE_*
 * variables. Each arm adds only what it needs for its own config and auth.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BENCH_DIR, exec } from './util';

export const STATE_DIR = process.env.BENCH_STATE ?? join(BENCH_DIR, '.state');
export const BENCH_HOME = join(STATE_DIR, 'home');
export const CONCLAVE_HOME = join(STATE_DIR, 'conclave-home');
export const EMPTY_MCP = join(STATE_DIR, 'empty-mcp.json');

export const OFFLINE: Record<string, string> = {
  GOPROXY: 'off',
  GOTOOLCHAIN: 'local',
  CARGO_NET_OFFLINE: 'true',
  PIP_NO_INDEX: '1',
  npm_config_offline: 'true',
};

let toolchainCache: Record<string, string> | null = null;

/** Real toolchain locations, read once with the caller's own HOME. */
export async function toolchainEnv(): Promise<Record<string, string>> {
  if (toolchainCache) return toolchainCache;
  const realHome = process.env.HOME || homedir();
  const out: Record<string, string> = {};
  out.CARGO_HOME = process.env.CARGO_HOME || join(realHome, '.cargo');
  out.RUSTUP_HOME = process.env.RUSTUP_HOME || join(realHome, '.rustup');
  const go = await exec(['sh', '-c', 'go env GOPATH GOMODCACHE GOCACHE 2>/dev/null']);
  const [gopath, gomodcache, gocache] = go.code === 0 ? go.stdout.trim().split('\n') : [];
  out.GOPATH = process.env.GOPATH || gopath || join(realHome, 'go');
  out.GOMODCACHE = process.env.GOMODCACHE || gomodcache || join(out.GOPATH, 'pkg', 'mod');
  out.GOCACHE = process.env.GOCACHE || gocache || join(realHome, '.cache', 'go-build');
  toolchainCache = out;
  return out;
}

const PASS_THROUGH = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE'];

function noProxy(extraHosts: string[]): string | undefined {
  const cur = process.env.NO_PROXY || process.env.no_proxy || '';
  const hosts = new Set(cur.split(',').map((s) => s.trim()).filter(Boolean));
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy && !process.env.HTTP_PROXY && !process.env.http_proxy) return cur || undefined;
  for (const h of ['127.0.0.1', 'localhost', ...extraHosts]) hosts.add(h);
  return [...hosts].join(',');
}

/**
 * The environment every agent and every test run starts from. Agents get the
 * fresh home of their own run (see workcopy.ts makeHome); the scorer and
 * validate use BENCH_HOME, which no agent ever sees.
 */
export async function baseEnv(extraNoProxyHosts: string[] = [], home: string = BENCH_HOME): Promise<Record<string, string>> {
  ensureState();
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) if (process.env[k]) env[k] = process.env[k]!;
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!env.LANG) env.LANG = 'C.UTF-8';
  env.TERM = 'dumb';
  env.NO_COLOR = '1';
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.XDG_CACHE_HOME = join(home, '.cache');
  env.XDG_DATA_HOME = join(home, '.local', 'share');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  const np = noProxy(extraNoProxyHosts);
  if (np) {
    env.NO_PROXY = np;
    env.no_proxy = np;
  }
  Object.assign(env, await toolchainEnv(), OFFLINE);
  // Cargo reads config.toml from CARGO_HOME. A shared one would let an agent set a
  // test runner (or rustflags) for the scorer and every later run, so each home
  // gets its own. The tasks have no crates to fetch; rustup still finds its
  // toolchains through RUSTUP_HOME and PATH.
  env.CARGO_HOME = join(home, '.cargo');
  return env;
}

/** Paths an agent must never be pointed at (in its env or argv): the bench tree and runner state. */
export function benchPathsIn(values: string[]): string[] {
  const bad = [BENCH_DIR, STATE_DIR];
  return values.filter((v) => bad.some((b) => v.includes(b)));
}

/**
 * Where B's Claude Code login lives when --b-transport login is used without
 * CLAUDE_CODE_OAUTH_TOKEN: log in once with CLAUDE_CONFIG_DIR set to this
 * folder. Each run copies only the credentials file into its own fresh
 * config folder.
 */
export const CLAUDE_LOGIN_DIR = join(STATE_DIR, 'claude-login');

export function ensureState(): void {
  for (const d of [STATE_DIR, BENCH_HOME, join(BENCH_HOME, '.claude'), join(BENCH_HOME, '.config')]) mkdirSync(d, { recursive: true });
  const gitconfig = join(BENCH_HOME, '.gitconfig');
  if (!existsSync(gitconfig)) writeFileSync(gitconfig, '[user]\n\tname = bench\n\temail = bench@localhost\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  if (!existsSync(EMPTY_MCP)) writeFileSync(EMPTY_MCP, '{"mcpServers": {}}\n');
}

/** Proxy settings from the environment (PROTOCOL 2). */
export function proxyConfig(): { baseUrl: string; apiKey: string | undefined; host: string } {
  const raw = (process.env.CLIPROXY_BASE_URL || 'http://127.0.0.1:8317').replace(/\/+$/, '');
  const baseUrl = raw.replace(/\/v1$/, '');
  let host = '127.0.0.1';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    /* keep default */
  }
  return { baseUrl, apiKey: process.env.CLIPROXY_API_KEY, host };
}

/**
 * Where Claude model calls go (both arms, side calls, a Claude judge): the
 * Anthropic API when BENCH_CLAUDE_API_KEY is set, else the proxy. GPT judges
 * always use the proxy.
 */
export function claudeConfig(): { baseUrl: string; apiKey: string | undefined; host: string } {
  const key = process.env.BENCH_CLAUDE_API_KEY;
  if (!key) return proxyConfig();
  const baseUrl = (process.env.BENCH_CLAUDE_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  return { baseUrl, apiKey: key, host: new URL(baseUrl).hostname };
}
