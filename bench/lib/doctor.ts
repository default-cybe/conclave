/** `bench doctor` (PROTOCOL 7 step 1): check the machine before a set. */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectClaudeFlags, type ClaudeFlags } from './arms';
import { baseEnv, BENCH_HOME, claudeConfig, STATE_DIR } from './env';
import { exec, listFiles, log, which, writeJson } from './util';

/** Side call model for both arms when --small-model is not given. */
export const DEFAULT_SMALL_MODEL = 'claude-haiku-4-5-20251001';

/** DEFAULT_SMALL_MODEL on the same proxy account as the main model ("neu/claude-..." keeps "neu/"). */
export function defaultSmallModel(model: string): string {
  return model.includes('/') ? `${model.split('/')[0]}/${DEFAULT_SMALL_MODEL}` : DEFAULT_SMALL_MODEL;
}

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface DoctorReport {
  at: string;
  checks: Check[];
  versions: Record<string, string>;
  claudeFlags: ClaudeFlags | null;
  conclave: { src: string; commit: string | null; dirty: number | null };
  proxy: { base_url: string; models: string[] | null; version: string | null; account: string };
  servedA: string | null;
  servedB: { login: string | null; proxy: string | null };
  transport: { chosen: 'login' | 'proxy'; why: string };
  smallModel: string;
  ok: boolean;
}

async function version(cmd: string[]): Promise<string | null> {
  const r = await exec(cmd, { timeoutMs: 20_000 });
  if (r.code !== 0) return null;
  return (r.stdout || r.stderr).trim().split('\n')[0];
}

export async function conclaveInfo(src: string): Promise<{ commit: string | null; dirty: number | null }> {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' };
  const c = await exec(['git', '-C', src, 'rev-parse', '--short', 'HEAD'], { env });
  const d = await exec(['git', '-C', src, 'status', '--porcelain', '--', 'packages'], { env });
  return { commit: c.code === 0 ? c.stdout.trim() : null, dirty: d.code === 0 ? d.stdout.split('\n').filter((l) => l.trim()).length : null };
}

function authHeaders(key: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (key) {
    h['x-api-key'] = key;
    h.authorization = `Bearer ${key}`;
  }
  return h;
}

/**
 * The proxy's model list in the OpenAI format. With an anthropic-version header
 * CLIProxyAPI answers in the Anthropic format, where every id that is not a
 * plain claude-* id (neu/claude-sonnet-5-5, gpt-6.1-sol) is renamed so Claude
 * Code accepts it, so this asks with the bearer key only. The Anthropic API
 * needs the header and lists real ids.
 */
export async function proxyModels(baseUrl: string, key: string | undefined): Promise<{ ids: string[] | null; version: string | null; error?: string }> {
  try {
    const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
    // the Anthropic API itself refuses a list without the version header
    if (new URL(baseUrl).hostname.endsWith('anthropic.com')) headers['anthropic-version'] = '2023-06-01';
    const res = await fetch(`${baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(15_000) });
    const version = res.headers.get('x-cpa-version') ?? res.headers.get('server') ?? null;
    if (!res.ok) return { ids: null, version, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
    const body: any = await res.json();
    const ids = (body.data ?? body.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
    return { ids, version };
  } catch (e) {
    return { ids: null, version: null, error: (e as Error).message };
  }
}

/** One tiny Messages call: which model id does the proxy say it served? */
export async function servedByProxy(baseUrl: string, key: string | undefined, model: string): Promise<{ model: string | null; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }),
      signal: AbortSignal.timeout(120_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) return { model: null, error: `${res.status} ${JSON.stringify(body).slice(0, 300)}` };
    return { model: body.model ?? null };
  } catch (e) {
    return { model: null, error: (e as Error).message };
  }
}

async function servedByClaude(model: string, transport: 'login' | 'proxy', smallModel: string): Promise<{ model: string | null; error?: string }> {
  const env = await baseEnv([claudeConfig().host]);
  env.CLAUDE_CONFIG_DIR = join(BENCH_HOME, '.claude');
  env.DISABLE_AUTOUPDATER = '1';
  if (process.getuid?.() === 0) env.IS_SANDBOX = '1';
  if (transport === 'proxy') {
    const p = claudeConfig();
    env.ANTHROPIC_BASE_URL = p.baseUrl;
    if (p.apiKey) env.ANTHROPIC_API_KEY = p.apiKey;
    env.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;
  } else {
    const tok = process.env.BENCH_CLAUDE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  }
  const r = await exec(['claude', '-p', 'Reply with the single word OK. Do not use any tools.', '--model', model, '--output-format', 'json'], { cwd: STATE_DIR, env, timeoutMs: 180_000 });
  try {
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
    if (out.is_error) return { model: null, error: String(out.result ?? out.subtype).slice(0, 300) };
    const keys = Object.keys(out.modelUsage ?? {});
    const main = keys.find((k) => k === model) ?? keys.find((k) => !/haiku/.test(k)) ?? keys[0] ?? null;
    return { model: main };
  } catch {
    return { model: null, error: (r.stderr || r.stdout).slice(0, 300) };
  }
}

function hasAgentFiles(dir: string): string | null {
  let d = dir;
  for (;;) {
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'CONCLAVE.md', '.claude']) {
      if (existsSync(join(d, f)) && !(d === dirname(BENCH_HOME) && f === '.claude')) return join(d, f);
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export interface DoctorOptions {
  model: string;
  smallModel?: string;
  conclaveSrc: string;
  hubPort: number;
  tapPort?: number;
  workRoot: string;
  bTransport: 'auto' | 'login' | 'proxy';
  arms: string[];
  dryRun: boolean;
}

export async function doctor(o: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string) => checks.push({ name, status, detail });
  const versions: Record<string, string> = {};
  for (const [name, cmd] of [
    ['bun', ['bun', '--version']],
    ['node', ['node', '--version']],
    ['python3', ['python3', '--version']],
    ['go', ['go', 'version']],
    ['cargo', ['cargo', '--version']],
    ['git', ['git', '--version']],
  ] as Array<[string, string[]]>) {
    const v = await version(cmd);
    if (v) versions[name] = v;
    add(`toolchain ${name}`, v ? 'ok' : name === 'node' ? 'warn' : 'fail', v ?? 'not found; its tasks are skipped');
  }
  const needsClaude = o.arms.includes('B') || o.arms.includes('C');
  const flags = needsClaude ? await detectClaudeFlags() : null;
  if (needsClaude) {
    if (flags?.version) versions.claude = flags.version;
    add('claude code', flags ? 'ok' : o.dryRun ? 'warn' : 'fail', flags ? `${flags.version}; bypass via ${flags.bypass}, output ${flags.outputFormat}, deny flag ${flags.disallowed ?? 'none'}, effort flag ${flags.effort ? 'yes' : 'no'}` : 'claude not on PATH');
    if (flags && flags.outputFormat !== 'stream-json') add('claude stream-json', 'warn', 'this version has no stream-json; tool metrics for B will be null');
  }
  if (o.arms.includes('D')) {
    const v = await version(['codex', '--version']);
    if (v) versions.codex = v;
    add('codex', v ? 'ok' : 'warn', v ?? 'not found; arm D will fail');
  }
  const cli = join(o.conclaveSrc, 'packages', 'cli', 'src', 'index.ts');
  const needsConclave = o.arms.some((a) => a === 'A' || a === 'A2' || a === 'A+skills' || a === 'C');
  if (needsConclave) {
    add('conclave source', existsSync(cli) ? 'ok' : 'fail', existsSync(cli) ? cli : `${cli} not found`);
    add('conclave node_modules', existsSync(join(o.conclaveSrc, 'node_modules')) ? 'ok' : 'fail', existsSync(join(o.conclaveSrc, 'node_modules')) ? 'present' : `run bun install in ${o.conclaveSrc}`);
  }
  // ponytail and caveman run node hooks in the hub; each run installs them from GitHub at their pinned commits
  if (o.arms.includes('A+skills')) {
    const node = await which('node');
    add('node for A+skills', node ? 'ok' : o.dryRun ? 'warn' : 'fail', node ? `${node}; the hub fetches the skills from GitHub on each A+skills run` : 'node not on PATH; the skill hooks would fail with exit 127');
  }
  const ci = await conclaveInfo(o.conclaveSrc);
  if (needsConclave) add('conclave commit', ci.commit ? (ci.dirty ? 'warn' : 'ok') : 'warn', `${ci.commit ?? 'unknown'}, ${ci.dirty ?? '?'} changed files under packages/${ci.dirty ? ' (allowed; the summary says so; use --conclave-src with a worktree for a fixed version)' : ''}`);

  // ports and work root
  let portBusy = false;
  try {
    const r = await fetch(`http://127.0.0.1:${o.hubPort}/api/health`, { signal: AbortSignal.timeout(800) });
    portBusy = !!r;
  } catch {
    portBusy = false;
  }
  if (needsConclave && !o.dryRun) add('hub port', portBusy ? 'fail' : 'ok', portBusy ? `something answers on ${o.hubPort}; pass --hub-port` : `${o.hubPort} is free`);
  const tapPort = o.tapPort ?? o.hubPort - 1;
  if (!o.dryRun && tapPort > 0) {
    let tapBusy = false;
    try {
      await fetch(`http://127.0.0.1:${tapPort}/`, { signal: AbortSignal.timeout(800) });
      tapBusy = true;
    } catch {
      tapBusy = false;
    }
    add('tap port', tapBusy ? 'fail' : 'ok', tapBusy ? `something answers on ${tapPort}; pass --tap-port` : `${tapPort} is free (the tap records every model call of both arms)`);
  }
  // machine wide Claude Code settings reach arm B whatever its config folder is
  for (const f of ['/etc/claude-code/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.json']) {
    if (o.arms.includes('B') && existsSync(f)) add('claude managed settings', 'warn', `${f} exists and applies to arm B; record it with the set`);
  }
  const inGit = await exec(['git', '-C', dirname(o.workRoot), 'rev-parse', '--show-toplevel'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp' } });
  const near = hasAgentFiles(dirname(o.workRoot));
  add('work root', inGit.code === 0 || near ? 'fail' : 'ok', inGit.code === 0 ? `${o.workRoot} is inside the git repo ${inGit.stdout.trim()}` : near ? `a parent folder holds ${near}` : `${o.workRoot} is outside any repo with no agent files above it`);
  // files left in the work base by other sets or by validate: a sandbox's ../.. would show them
  const base = dirname(o.workRoot);
  const leftovers = existsSync(base)
    ? readdirSync(base)
        .filter((e) => join(base, e) !== o.workRoot && e !== 'doctor')
        .filter((e) => listFiles(join(base, e)).length > 0)
    : [];
  add('work base clean', leftovers.length ? 'fail' : 'ok', leftovers.length ? `${base} holds files from other sets or validate runs (${leftovers.slice(0, 5).join(', ')}); an agent could list them. Remove them: rm -rf ${leftovers.map((e) => join(base, e)).slice(0, 3).join(' ')}` : `${base} holds no other files`);
  let dfDir = dirname(o.workRoot);
  while (!existsSync(dfDir) && dirname(dfDir) !== dfDir) dfDir = dirname(dfDir); // df fails on a folder not made yet
  const df = await exec(['df', '-Pk', dfDir]);
  const freeKb = Number(df.stdout.trim().split('\n').pop()?.split(/\s+/)[3] ?? 0);
  add('disk', freeKb > 2_000_000 ? 'ok' : 'warn', `${Math.round(freeKb / 1024)} MB free under ${dirname(o.workRoot)}`);

  // proxy and model
  const p = claudeConfig();
  const account = o.model.includes('/') ? o.model.split('/')[0] : 'default';
  let models: string[] | null = null;
  let proxyVersion: string | null = null;
  let servedA: string | null = null;
  const servedB = { login: null as string | null, proxy: null as string | null };
  let smallModel = o.smallModel ?? defaultSmallModel(o.model);
  let transport: DoctorReport['transport'] = { chosen: o.bTransport === 'login' ? 'login' : 'proxy', why: o.bTransport === 'auto' ? 'not checked' : 'set by --b-transport' };
  if (o.dryRun) {
    smallModel = o.smallModel ?? defaultSmallModel(o.model);
    servedA = o.model;
    servedB.proxy = o.model;
    transport = { chosen: o.bTransport === 'login' ? 'login' : 'proxy', why: 'dry run: no model call' };
    add('proxy', 'warn', `dry run: ${p.baseUrl} not contacted`);
  } else {
    if (!p.apiKey) add('proxy key', 'warn', 'neither BENCH_CLAUDE_API_KEY nor CLIPROXY_API_KEY is set');
    const m = await proxyModels(p.baseUrl, p.apiKey);
    models = m.ids;
    proxyVersion = m.version;
    add('proxy models', models ? 'ok' : 'fail', models ? `${models.length} models at ${p.baseUrl}/v1/models` : `cannot list models at ${p.baseUrl}: ${m.error}`);
    if (models) add('model listed', models.includes(o.model) ? 'ok' : 'fail', models.includes(o.model) ? o.model : `${o.model} is not in the proxy list: ${models.slice(0, 20).join(', ')}`);
    // a pinned id, not the first haiku the proxy lists: unprefixed claude-3-5-haiku-20241022 went away from the proxy
    if (!o.smallModel) smallModel = defaultSmallModel(o.model);
    if (models) add('small model listed', models.includes(smallModel) ? 'ok' : 'warn', models.includes(smallModel) ? smallModel : `${smallModel} is not in the proxy list; pass --small-model`);
    if (needsConclave) {
      const s = await servedByProxy(p.baseUrl, p.apiKey, o.model);
      servedA = s.model;
      add('served id (A path)', s.model === o.model || (s.model && o.model.endsWith('/' + s.model)) ? 'ok' : 'fail', s.model ? `proxy answered as ${s.model}` : `no answer: ${s.error}`);
    }
    if (o.arms.includes('B') && flags) {
      if (o.bTransport !== 'proxy') {
        const s = await servedByClaude(o.model, 'login', smallModel);
        servedB.login = s.model;
        if (o.bTransport === 'login') add('served id (B login)', s.model === o.model ? 'ok' : 'fail', s.model ?? s.error ?? 'no answer');
        else add('served id (B login)', s.model === o.model ? 'ok' : 'warn', s.model ? `login served ${s.model}` : `login did not work: ${s.error}`);
      }
      if (o.bTransport === 'proxy' || (o.bTransport === 'auto' && servedB.login !== o.model)) {
        const s = await servedByClaude(o.model, 'proxy', smallModel);
        servedB.proxy = s.model;
        add('served id (B proxy)', s.model === o.model ? 'ok' : 'fail', s.model ? `proxy served ${s.model}` : `proxy did not work: ${s.error}`);
      }
      if (o.bTransport === 'auto') transport = servedB.login === o.model ? { chosen: 'login', why: 'auto: the login served the exact model id' } : { chosen: 'proxy', why: `auto: login ${servedB.login ? `served ${servedB.login}` : 'did not work'}, so B goes through the proxy` };
    }
  }
  const report: DoctorReport = {
    at: new Date().toISOString(),
    checks,
    versions,
    claudeFlags: flags,
    conclave: { src: o.conclaveSrc, commit: ci.commit, dirty: ci.dirty },
    proxy: { base_url: p.baseUrl, models, version: proxyVersion, account },
    servedA,
    servedB,
    transport,
    smallModel,
    ok: !checks.some((c) => c.status === 'fail' && !c.name.startsWith('toolchain')),
  };
  writeJson(join(STATE_DIR, 'doctor.json'), report);
  return report;
}

export function printDoctor(r: DoctorReport): void {
  for (const c of r.checks) log(`${c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'FAIL'} ${c.name}: ${c.detail}`);
  log(`arm B transport: ${r.transport.chosen} (${r.transport.why}); small model ${r.smallModel}`);
}

export { which };
