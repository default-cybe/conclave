/**
 * The bench's own Conclave hub (PROTOCOL 4.2, 7 step 2). One hub per run: it
 * starts on the bench port with a fresh CONCLAVE_HOME inside the run's own
 * home, serves that one run, and stops. So arm A, like arm B, starts every
 * run from a fresh install: no sessions, usage records or background shells
 * from earlier runs. It never talks to the owner's hub.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackGroup, watchdog } from './proc';
import { killGroup, log, sleep, which } from './util';

/** Config deny list: a backstop at call time. */
export const DENY = [
  'WebFetch',
  'WebSearch',
  'Consult',
  'Notify',
  'ScheduleRoutine',
  'MemorySave',
  'MemorySearch',
  'MemoryForget',
  'AskUserQuestion',
  'GoalList',
  'GoalGet',
  'GoalCreate',
  'GoalUpdate',
  'GoalLog',
  'DayPlan',
  'ProactivePrefs',
  'SessionSearch',
  'SessionRead',
  'SkillManage',
  'Workflow',
  'browser_*',
];

/**
 * Tools taken out of the model's tool list, the way --disallowedTools does it
 * for Claude Code: written as `disallowedTools` into a bench copy of the coder
 * agent and of every subagent it can call. Without this Conclave offers these
 * tools and only denies the call, which costs tokens and turns arm B never
 * pays (PROTOCOL 4.1, same denied tools).
 */
export const AGENT_DENY = DENY;

const DEFAULT_PROVIDERS = ['anthropic', 'openai', 'google', 'zai', 'openrouter', 'ollama', 'cliproxy', 'claude-code', 'codex', 'gemini-cli', 'opencode'];

export interface HubOptions {
  src: string;
  port: number;
  model: string;
  smallModel: string;
  /** Where the providers send model calls: the tap when it runs, else the proxy. */
  proxyBaseUrl: string;
  arms: string[];
  /** Same thinking level for the coder agent (--match-effort). */
  thinking?: string;
  claudeCodeEnv?: Record<string, string>;
}

export function hubConfig(o: HubOptions, token: string): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const id of DEFAULT_PROVIDERS) providers[id] = { enabled: false };
  providers['bench-claude'] = {
    type: 'anthropic',
    name: 'Bench Claude (CLIProxyAPI)',
    baseUrl: o.proxyBaseUrl,
    apiKeyEnv: 'CLIPROXY_API_KEY',
    models: [...new Set([o.model, o.smallModel])],
    enabled: true,
  };
  providers.cliproxy = {
    type: 'openai',
    name: 'CLIProxyAPI',
    baseUrl: o.proxyBaseUrl + '/v1',
    apiKeyEnv: 'CLIPROXY_API_KEY',
    models: [...new Set([o.model, o.smallModel])],
    enabled: o.arms.includes('A2'),
  };
  if (o.arms.includes('C')) {
    providers['claude-code'] = {
      type: 'acp',
      name: 'Claude Code',
      command: 'npx',
      args: ['-y', '@zed-industries/claude-code-acp'],
      models: ['default', 'opus', 'sonnet', 'haiku'],
      env: o.claudeCodeEnv ?? {},
      enabled: true,
    };
  }
  return {
    defaultModel: `bench-claude/${o.model}`,
    smallModel: `bench-claude/${o.smallModel}`,
    defaultAgent: 'coder',
    providers,
    server: { host: '127.0.0.1', port: o.port, token, remote: { mode: 'off', lan: false } },
    permissions: { mode: 'bypass', allow: [], deny: DENY, ask: [], additionalDirectories: [] },
    hooks: {},
    mcpServers: {},
    memory: { enabled: false, autoExtract: false, autoInject: false, injectLimit: 0 },
    limits: { autoResume: false, fallbacks: {} },
    notifications: { on: { sessionDone: false, approvalNeeded: false, limitReset: false, routineDone: false, errors: false }, idleSeconds: 0 },
    compat: { claudeCode: false, agentsMd: false, codex: false, opencode: false, gemini: false },
    ui: { onboarded: true },
  };
}

/** Insert frontmatter lines right after the opening ---. The body stays byte for byte. */
export function withFrontmatter(text: string, lines: string[]): string {
  if (!lines.length) return text;
  if (!text.startsWith('---\n')) return `---\n${lines.join('\n')}\n---\n\n${text}`;
  return text.replace(/^---\n/, `---\n${lines.join('\n')}\n`);
}

/** The thinking level the shipped coder agent sets (frontmatter `thinking:`), or null. */
export function coderThinking(src: string): string | null {
  const f = join(src, 'packages', 'core', 'src', 'agents-defaults', 'coder.md');
  if (!existsSync(f)) return null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(f, 'utf8'))?.[1] ?? '';
  return /^thinking:\s*(\S+)/m.exec(fm)?.[1] ?? null;
}

/**
 * A bench copy of an agent file: its own disallowedTools (one line "a, b" or
 * "- a" lines) joined with the bench denials, and thinking replaced when the
 * set matches effort. Other frontmatter and the body stay byte for byte.
 */
export function benchAgentCopy(text: string, deny: string[], thinking?: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const head = (own: string[]) => [`disallowedTools: ${[...new Set([...own, ...deny])].join(', ')}`, ...(thinking ? [`thinking: ${thinking}`] : [])];
  if (!fm) return withFrontmatter(text, head([]));
  const unquote = (x: string) => x.trim().replace(/^["']|["']$/g, '');
  const lines = fm[1].split('\n');
  const own: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^disallowedTools:\s*(.*)$/.exec(lines[i]);
    if (m) {
      own.push(...m[1].replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean));
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) own.push(unquote(lines[++i].replace(/^\s+-\s+/, '')));
      continue;
    }
    if (thinking && /^thinking:/.test(lines[i])) continue;
    kept.push(lines[i]);
  }
  return `---\n${[...head(own), ...kept].join('\n')}\n---${text.slice(fm[0].length)}`;
}

/**
 * BENCH_SEED_HOME: a copy of a hub's skills, learned-skills and plugins
 * folders, given to every arm the same way. Plugins stay in the seed copy;
 * state.json is rewritten to point there, so nothing is read from a live hub.
 */
export function seedExtensions(seed: string, conclaveHome: string): void {
  for (const dir of ['skills', 'learned-skills']) {
    if (existsSync(join(seed, dir))) cpSync(join(seed, dir), join(conclaveHome, dir), { recursive: true });
  }
  const state = join(seed, 'plugins', 'state.json');
  if (!existsSync(state)) return;
  const parsed = JSON.parse(readFileSync(state, 'utf8')) as { plugins: Record<string, { dir: string }> };
  for (const [name, p] of Object.entries(parsed.plugins)) p.dir = join(seed, 'plugins', name);
  mkdirSync(join(conclaveHome, 'plugins'), { recursive: true });
  writeFileSync(join(conclaveHome, 'plugins', 'state.json'), JSON.stringify(parsed, null, 2));
}

/**
 * Bench copies of the shipped agents: the coder (main loop) and every
 * subagent, each with the denied tools taken out of its tool list, and the
 * coder with the --match-effort thinking level. Returns the files written.
 */
export function writeAgentOverrides(src: string, conclaveHome: string, thinking?: string): string[] {
  const dir = join(src, 'packages', 'core', 'src', 'agents-defaults');
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  mkdirSync(join(conclaveHome, 'agents'), { recursive: true });
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && x !== 'BASE.md' && x !== 'modes.md')) {
    const text = readFileSync(join(dir, f), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    const name = /^name:\s*(\S+)/m.exec(fm)?.[1];
    const isSub = /^subagent:\s*true\b/m.test(fm);
    if (name !== 'coder' && !isSub) continue;
    writeFileSync(join(conclaveHome, 'agents', f), benchAgentCopy(text, AGENT_DENY, name === 'coder' ? thinking : undefined));
    out.push(f);
  }
  return out;
}

export class BenchHub {
  readonly url: string;
  readonly token: string;
  readonly conclaveHome: string;
  startMs: number | null = null;
  overrides: string[] = [];
  private pid?: number;
  private proc?: ReturnType<typeof Bun.spawn>;
  private unwatch: () => void = () => {};

  constructor(
    private o: HubOptions,
    private env: Record<string, string>,
    /** The run's HOME. CONCLAVE_HOME is <home>/.conclave. */
    home: string,
    private logFile: string,
  ) {
    this.url = `http://127.0.0.1:${o.port}`;
    this.token = randomBytes(24).toString('base64url');
    this.conclaveHome = join(home, '.conclave');
  }

  /** Argv used to start the hub, for the manifest. */
  argv(): string[] {
    return ['bun', join(this.o.src, 'packages', 'cli', 'src', 'index.ts'), 'serve', '--host', '127.0.0.1', '--port', String(this.o.port)];
  }

  async start(): Promise<void> {
    const t0 = Date.now();
    if (await this.healthy(800)) throw new Error(`something already answers on ${this.url}; pick another --hub-port. The bench never reuses a running hub.`);
    rmSync(this.conclaveHome, { recursive: true, force: true });
    mkdirSync(this.conclaveHome, { recursive: true });
    writeFileSync(join(this.conclaveHome, 'config.json'), JSON.stringify(hubConfig(this.o, this.token), null, 2) + '\n', { mode: 0o600 });
    this.overrides = writeAgentOverrides(this.o.src, this.conclaveHome, this.o.thinking);
    if (process.env.BENCH_SEED_HOME) seedExtensions(process.env.BENCH_SEED_HOME, this.conclaveHome);
    const fd = openSync(this.logFile, 'a');
    const setsid = await which('setsid');
    const argv = this.argv();
    argv[0] = process.execPath;
    this.proc = Bun.spawn(setsid ? [setsid, ...argv] : argv, {
      cwd: this.conclaveHome,
      env: { ...this.env, CONCLAVE_HOME: this.conclaveHome, CONCLAVE_DETACHED: '1' },
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
    });
    this.pid = this.proc.pid;
    // the hub runs in its own session: end it if the runner exits or dies
    trackGroup(this.pid, true);
    this.unwatch = watchdog([this.pid]);
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      if (await this.healthy(1000)) {
        this.startMs = Date.now() - t0;
        return;
      }
      if (this.proc.exitCode !== null) break;
      await sleep(100);
    }
    const tail = existsSync(this.logFile) ? readFileSync(this.logFile, 'utf8').split('\n').slice(-20).join('\n') : '';
    await this.stop();
    throw new Error(`bench hub did not start. Log ${this.logFile}:\n${tail}`);
  }

  async healthy(timeoutMs: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.url}${path}`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`hub ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async post<T = any>(path: string, body: unknown = {}): Promise<T | null> {
    try {
      const res = await fetch(`${this.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      return res.ok ? ((await res.json().catch(() => null)) as T) : null;
    } catch {
      return null;
    }
  }

  installSkills(ids: string[]): Promise<SkillInstall[]> {
    return installCatalogItems(this.url, this.token, ids);
  }

  /** Abort a session that may still be running after the CLI exited, and wait until it is idle. */
  async settle(sessionId: string, waitMs = 15_000): Promise<string | null> {
    let status: string | null = null;
    const end = Date.now() + waitMs;
    let aborted = false;
    while (Date.now() < end) {
      try {
        status = (await this.get<any>(`/api/sessions/${sessionId}`))?.status ?? null;
      } catch {
        return status;
      }
      if (status !== 'running' && status !== 'waiting_approval' && status !== 'waiting_input') return status;
      if (!aborted) {
        aborted = true;
        await this.post(`/api/sessions/${sessionId}/abort`);
      }
      await sleep(300);
    }
    return status;
  }

  async stop(): Promise<void> {
    if (!this.pid || !this.proc) return;
    killGroup(this.pid, 'SIGINT');
    const end = Date.now() + 10_000;
    while (Date.now() < end && this.proc.exitCode === null) await sleep(100);
    if (this.proc.exitCode === null) killGroup(this.pid, 'SIGKILL');
    trackGroup(this.pid, false);
    this.unwatch();
    const free = Date.now() + 5_000;
    while (Date.now() < free && (await this.healthy(300))) await sleep(100);
    this.pid = undefined;
  }

  /** Session, messages, child sessions and usage records of one run (the hub is fresh, so all of them). */
  async runData(sessionId: string): Promise<HubData> {
    const session = await this.get(`/api/sessions/${sessionId}`);
    const messages = await this.get(`/api/sessions/${sessionId}/messages`);
    const children: HubData['children'] = [];
    const queue = [sessionId];
    const seen = new Set(queue);
    while (queue.length) {
      const parent = queue.shift()!;
      const list = await this.get<any[]>(`/api/sessions?parentId=${encodeURIComponent(parent)}&limit=200`).catch(() => []);
      for (const child of Array.isArray(list) ? list : []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        queue.push(child.id);
        children.push({ session: child, messages: await this.get(`/api/sessions/${child.id}/messages`).catch(() => []) });
      }
    }
    const recent = await this.get<any[]>(`/api/usage/recent?limit=5000`).catch(() => []);
    // a fresh hub serves one run, so every record belongs to it (titles without a session id too)
    const usage = Array.isArray(recent) ? recent : [];
    // the main session's audit rows: the regression gate writes one per look (regression.gate)
    const rows = await this.get<any[]>(`/api/audit?sessionId=${encodeURIComponent(sessionId)}&limit=500`).catch(() => []);
    return { session, messages, children, usage, audit: Array.isArray(rows) ? rows : [] };
  }
}

/** One catalog item the A+skills arm installed, as the hub's catalog API reported it. */
export interface SkillInstall {
  id: string;
  ok: boolean;
  /** Commit the hub installed from. */
  sha: string | null;
  warnings: string[];
  error: string | null;
}

/**
 * Install catalog items into a running hub through its own catalog API
 * (preview, then install), so the arm gets exactly what a user gets from
 * Discover. One item at a time; a failure is reported, not thrown.
 */
export async function installCatalogItems(url: string, token: string, ids: string[], timeoutMs = 300_000): Promise<SkillInstall[]> {
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${String(data?.error ?? data?.message ?? JSON.stringify(data)).slice(0, 300)}`);
    return data;
  };
  const out: SkillInstall[] = [];
  for (const id of ids) {
    try {
      const preview = await call('/api/catalog/preview', { id });
      const done = await call('/api/catalog/install', { planId: preview.planId, enable: true });
      out.push({ id, ok: !!done?.ok, sha: done?.installed?.sha ?? null, warnings: [...(preview.warnings ?? []), ...(done?.warnings ?? [])].map(String), error: done?.ok ? null : 'install returned no ok' });
    } catch (e) {
      out.push({ id, ok: false, sha: null, warnings: [], error: (e as Error).message });
    }
  }
  return out;
}

export interface HubData {
  session: any;
  messages: any[];
  children: Array<{ session: any; messages: any[] }>;
  usage: any[];
  /** Audit rows of the main session (older sets have none). */
  audit?: any[];
}

export function hubLogTail(file: string, lines = 20): string {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n') : '';
}

export { log };
