/**
 * Arm adapters (PROTOCOL 2, 7.1, 9). Each one starts its agent on a fresh
 * copy, watches the stream for live usage and rate limits, and returns a
 * Normalized record. In dry-run mode every arm runs bench/lib/fake-agent.ts,
 * which prints the same stream format as the real tool, so the parsers below
 * are the ones that score real runs.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_LOGIN_DIR } from './env';
import { BenchHub, coderThinking, hubLogTail, type HubData, type HubOptions, type SkillInstall } from './hub';
import type { LeakProbe } from './leaks';
import { addTokens, emptyNormalized, RATE_LIMIT_RE, regressionGateCounts, TRANSIENT_RE, totalTokens, zeroTokens, type Call, type Normalized, type Request, type Tokens } from './metrics';
import { startProc, type ProcResult } from './proc';
import type { Tap, TapRecord } from './tap';
import { BENCH_DIR, exec, readJson } from './util';

/** How much of each tool result the normalizers keep (for the leak scan; not written to results.jsonl). */
const RESULT_KEEP = 50_000;

export type ArmId = 'A' | 'A2' | 'A+skills' | 'B' | 'C' | 'D';
export const ARM_IDS: ArmId[] = ['A', 'A2', 'A+skills', 'B', 'C', 'D'];
/** Catalog items the A+skills arm installs into its hub, from their pinned commits (core catalog/recommended.ts). */
export const DEFAULT_SKILLS = ['plugin:ponytail', 'plugin:caveman'];

/** An arm id as typed on the command line, any case ("a+skills" is A+skills). */
export function parseArm(text: string): ArmId {
  const hit = ARM_IDS.find((a) => a.toLowerCase() === text.trim().toLowerCase());
  if (!hit) throw new Error(`unknown arm: ${text}`);
  return hit;
}

/** Arms that run Conclave in a per run hub. */
export function isHubArm(a: ArmId): boolean {
  return a === 'A' || a === 'A2' || a === 'A+skills' || a === 'C';
}
export const VERDICT_ARMS: ArmId[] = ['A', 'B'];

export interface ClaudeFlags {
  version: string | null;
  bypass: 'permission-mode' | 'dangerously-skip-permissions';
  outputFormat: 'stream-json' | 'json';
  disallowed: string | null;
  strictMcp: boolean;
  mcpConfig: boolean;
  effort: boolean;
  verbose: boolean;
  noSessionPersistence: boolean;
}

export async function detectClaudeFlags(bin = 'claude'): Promise<ClaudeFlags | null> {
  const v = await exec([bin, '--version'], { timeoutMs: 30_000 });
  if (v.code !== 0) return null;
  const h = await exec([bin, '--help'], { timeoutMs: 30_000 });
  const help = h.stdout + h.stderr;
  return {
    version: v.stdout.trim().split('\n')[0] || null,
    bypass: /bypassPermissions/.test(help) ? 'permission-mode' : 'dangerously-skip-permissions',
    outputFormat: /stream-json/.test(help) ? 'stream-json' : 'json',
    disallowed: /--disallowedTools\b/.test(help) ? '--disallowedTools' : /--disallowed-tools\b/.test(help) ? '--disallowed-tools' : null,
    strictMcp: /--strict-mcp-config/.test(help),
    mcpConfig: /--mcp-config/.test(help),
    effort: /--effort\b/.test(help),
    verbose: /--verbose\b/.test(help),
    noSessionPersistence: /--no-session-persistence/.test(help),
  };
}

/** Tools Claude Code must not use: the web, other people, schedules (PROTOCOL 4.1). */
export const CLAUDE_DENY = [
  'WebFetch',
  'WebSearch',
  'DesignSync',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
  'SendUserMessage',
  'SendMessage',
  'ListAgents',
  'AskUserQuestion',
];

/**
 * Tools that must not be in either arm's tool list as sent to the model. The
 * parity check and every run's tap record are checked against this list.
 */
export const FORBIDDEN_TOOLS = [
  'WebFetch',
  'WebSearch',
  'Consult',
  'Notify',
  'ScheduleRoutine',
  'MemorySave',
  'MemorySearch',
  'MemoryForget',
  'AskUserQuestion',
  'DesignSync',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
  'SendUserMessage',
  'SendMessage',
  'ListAgents',
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
];

export function forbiddenOffered(tools: string[]): string[] {
  return tools.filter((t) => FORBIDDEN_TOOLS.includes(t) || /^browser_|^mcp__/.test(t));
}

export interface ArmContext {
  arm: ArmId;
  runId: string;
  model: string;
  smallModel: string;
  prompt: string;
  copy: string;
  /** The run's own fresh HOME (sandbox/home). */
  home: string;
  runDir: string;
  limitS: number;
  /** Agent env for this run (HOME is the run's home). */
  env: Record<string, string>;
  conclaveSrc: string;
  /** Per run hub for the Conclave arms (null in dry runs and for B and D). */
  hubOptions: HubOptions | null;
  tap: Tap | null;
  probe: LeakProbe | null;
  claudeFlags: ClaudeFlags | null;
  transport: 'login' | 'proxy';
  proxy: { baseUrl: string; apiKey: string | undefined };
  matchEffort: string | null;
  /** A+skills: catalog item ids to install into the run's hub before the agent starts. */
  skills?: string[];
  tokenCap: number;
  dryRun: boolean;
  fake?: { taskDir: string; outcome: 'good' | 'bad'; claim: 'DONE' | 'NOT DONE' | 'none'; seed: number; fault?: string; canary?: string; resetInS?: number };
  /** Dry runs only: shorter kill steps, so the fault checks do not wait 60 s per timeout. */
  killStepMs?: number;
  /** Called with a reason when the runner wants the run stopped (SIGINT). */
  onHandle?: (stop: (reason: string) => void) => void;
}

export interface ArmOutput {
  argv: string[];
  proc: ProcResult;
  norm: Normalized;
  transport: string;
  thinking: { mode: string; effort: string | null; source: string };
  /** Model calls the tap saw for this run; null when the arm did not go through the tap. */
  tap: TapRecord[] | null;
  hub: { start_ms: number | null; overrides: string[]; settle_status: string | null; error: string | null; skills?: SkillInstall[]; skills_ms?: number } | null;
}

export function claudeAlias(model: string): string {
  if (/opus/.test(model)) return 'opus';
  if (/haiku/.test(model)) return 'haiku';
  return 'sonnet';
}

/** The argv for an arm, with the prompt and copy in place. */
export function armArgv(
  c: Pick<ArmContext, 'arm' | 'model' | 'prompt' | 'copy' | 'limitS' | 'conclaveSrc' | 'claudeFlags' | 'matchEffort'> & { hub: { url: string; token: string } | null; mcpConfig?: string },
): string[] {
  const cli = join(c.conclaveSrc, 'packages', 'cli', 'src', 'index.ts');
  const conclave = (modelRef: string) => [
    'bun',
    cli,
    'run',
    c.prompt,
    '--agent',
    'coder',
    '--model',
    modelRef,
    '--cwd',
    c.copy,
    '--json',
    '--yes',
    '--permission-mode',
    'bypass',
    '--timeout',
    `${c.limitS}s`,
    '--hub',
    c.hub?.url ?? 'http://127.0.0.1:7799',
    '--token',
    c.hub?.token ?? '<token>',
  ];
  switch (c.arm) {
    case 'A':
    case 'A+skills':
      return conclave(`bench-claude/${c.model}`);
    case 'A2':
      return conclave(`cliproxy/${c.model}`);
    case 'C':
      return conclave(`claude-code/${claudeAlias(c.model)}`);
    case 'B': {
      const f = c.claudeFlags;
      const argv = ['claude', '-p', c.prompt, '--model', c.model, '--output-format', f?.outputFormat ?? 'stream-json'];
      if ((f?.outputFormat ?? 'stream-json') === 'stream-json' && (f?.verbose ?? true)) argv.push('--verbose');
      if ((f?.bypass ?? 'permission-mode') === 'permission-mode') argv.push('--permission-mode', 'bypassPermissions');
      else argv.push('--dangerously-skip-permissions');
      if (c.matchEffort && f?.effort) argv.push('--effort', c.matchEffort);
      if (f?.disallowed ?? '--disallowedTools') argv.push(f?.disallowed ?? '--disallowedTools', ...CLAUDE_DENY);
      if (f?.strictMcp ?? true) argv.push('--strict-mcp-config');
      if (f?.mcpConfig ?? true) argv.push('--mcp-config', c.mcpConfig ?? '<home>/.claude/mcp-none.json');
      return argv;
    }
    case 'D':
      return ['codex', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', c.copy, c.prompt];
  }
}

function fakeArgv(c: ArmContext, style: 'conclave' | 'claude' | 'codex', hubFile: string): string[] {
  return [
    process.execPath,
    join(BENCH_DIR, 'lib', 'fake-agent.ts'),
    '--style',
    style,
    '--task',
    c.fake!.taskDir,
    '--outcome',
    c.fake!.outcome,
    '--claim',
    c.fake!.claim,
    '--cwd',
    c.copy,
    '--model',
    c.model,
    '--small-model',
    c.smallModel,
    '--seed',
    String(c.fake!.seed),
    '--hubdata',
    hubFile,
    ...(c.fake!.fault ? ['--fault', c.fake!.fault] : []),
    ...(c.fake!.canary ? ['--canary', c.fake!.canary] : []),
    ...(c.fake!.resetInS !== undefined ? ['--reset-in', String(c.fake!.resetInS)] : []),
  ];
}

// ---------------------------------------------------------------------------
// Conclave (A, A2, C)
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : '')).join('');
  return '';
}

export function normalizeConclave(stream: any[], data: HubData | null, requestedModel: string): Normalized {
  const n = emptyNormalized('unknown');
  const done = stream.find((e) => e.type === 'run.done');
  let resumeAt: number | null = null;
  for (const e of stream) {
    if (e.type === 'session.updated' && e.session?.status === 'waiting_reset') {
      n.rateLimited = true;
      resumeAt = e.session.resumeAt ?? resumeAt;
    }
  }
  n.status = done?.status ?? data?.session?.status ?? 'unknown';
  n.error = done?.error ?? data?.session?.error ?? null;
  n.extra.sessionId = done?.sessionId ?? data?.session?.id ?? null;
  if (data?.session?.status === 'waiting_reset') {
    n.rateLimited = true;
    resumeAt = data.session.resumeAt ?? resumeAt;
  }
  if (n.error && RATE_LIMIT_RE.test(n.error)) n.rateLimited = true;
  if (n.error && !n.rateLimited && TRANSIENT_RE.test(n.error)) n.transientError = true;
  n.resetAt = resumeAt;
  n.regressionGate = regressionGateCounts(stream, data?.audit);
  if (!data) {
    // no hub data: fall back to what the stream says
    const st = done?.stats;
    if (st) {
      n.tokens = { input: st.inputTokens ?? 0, output: st.outputTokens ?? 0, cache_read: st.cacheReadTokens ?? 0, cache_write: 0, by_model: {} };
      n.costReportedUsd = st.costUsd ?? null;
    }
    return n;
  }
  const mainId = data.session.id;
  const sessions = [{ session: data.session, messages: data.messages, sub: false }, ...data.children.map((c) => ({ ...c, sub: true }))];
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  let assistantMain = 0;
  let assistantSub = 0;
  let lastMain: any = null;
  for (const s of sessions) {
    for (const m of s.messages ?? []) {
      if (m.role === 'assistant' && (m.kind ?? 'normal') === 'normal') {
        if (s.sub) assistantSub++;
        else {
          assistantMain++;
          lastMain = m;
        }
      }
      for (const b of m.content ?? []) {
        if (b.type === 'tool_use') {
          const c: Call = { id: b.id, name: b.name, input: b.input ?? {}, isError: null, result: '', sub: s.sub };
          calls.push(c);
          byId.set(b.id, c);
        } else if (b.type === 'tool_result') {
          const c = byId.get(b.toolUseId ?? b.tool_use_id);
          if (c) {
            c.isError = !!(b.isError ?? b.is_error);
            c.result = textOf(b.content).slice(0, RESULT_KEEP);
          }
        }
      }
    }
  }
  for (const c of calls) if (c.isError === null) c.isError = false;
  n.calls = calls;
  const subIds = new Set(data.children.map((c) => c.session.id));
  const requests: Request[] = [];
  const total = zeroTokens();
  const byModel: Record<string, Tokens> = {};
  let cost = 0;
  let costKnown = false;
  let latency = 0;
  let latencyKnown = false;
  let turnMain = 0;
  let turnSub = 0;
  const served = new Set<string>();
  for (const r of data.usage) {
    const t: Tokens = { input: r.inputTokens ?? 0, output: r.outputTokens ?? 0, cache_read: r.cacheReadTokens ?? 0, cache_write: r.cacheWriteTokens ?? 0 };
    const sub = r.sessionId ? subIds.has(r.sessionId) : false;
    requests.push({ model: r.model ?? null, sub, purpose: r.purpose ?? null, tokens: t, latency_ms: r.latencyMs ?? null });
    addTokens(total, t);
    byModel[r.model ?? 'unknown'] = addTokens(byModel[r.model ?? 'unknown'] ?? zeroTokens(), t);
    if (typeof r.costUsd === 'number') {
      cost += r.costUsd;
      costKnown = true;
    }
    if (typeof r.latencyMs === 'number') {
      latency += r.latencyMs;
      latencyKnown = true;
    }
    if ((r.purpose ?? 'turn') === 'turn') {
      if (r.sessionId === mainId) {
        turnMain++;
        if (r.model) served.add(r.model);
      } else if (sub) turnSub++;
    }
  }
  n.requests = requests;
  n.tokens = data.usage.length ? { ...total, by_model: byModel } : null;
  n.costReportedUsd = costKnown ? Math.round(cost * 1e6) / 1e6 : (data.session.stats?.costUsd ?? null);
  n.apiMs = latencyKnown ? latency : null;
  n.turnsMain = turnMain || assistantMain;
  n.turnsSub = turnSub || assistantSub;
  n.modelServed = served.size ? [...served] : [];
  n.finalText = lastMain ? textOf(lastMain.content) : null;
  n.stopReason = lastMain?.stopReason ?? null;
  n.permissionDenials = calls.filter((c) => c.isError && /Denied by rule|not allowed in|permission denied by/i.test(c.result)).length;
  n.extra.requested = requestedModel;
  n.extra.compactions = data.usage.filter((r) => r.purpose === 'compaction').length;
  return n;
}

// ---------------------------------------------------------------------------
// Claude Code (B)
// ---------------------------------------------------------------------------

function usageTokens(u: any): Tokens {
  return { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cache_read: u?.cache_read_input_tokens ?? 0, cache_write: u?.cache_creation_input_tokens ?? 0 };
}

export function normalizeClaude(lines: any[], outputFormat: 'stream-json' | 'json'): Normalized {
  const n = emptyNormalized('unknown');
  const result = [...lines].reverse().find((e) => e.type === 'result');
  const init = lines.find((e) => e.type === 'system' && e.subtype === 'init');
  if (init) n.extra.init = { model: init.model, claude_code_version: init.claude_code_version, permissionMode: init.permissionMode, tools: init.tools, mcp_servers: init.mcp_servers };
  let retries429 = 0;
  for (const e of lines) {
    if (e.type === 'system' && /retry/.test(e.subtype ?? '') && (e.error_status === 429 || /429|rate/i.test(JSON.stringify(e.error ?? '')))) retries429++;
  }
  if (result) {
    n.status = result.is_error ? 'error' : 'completed';
    n.error = result.is_error ? String(result.result ?? result.subtype ?? 'error') : null;
    n.finalText = typeof result.result === 'string' ? result.result : null;
    n.costReportedUsd = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
    n.apiMs = typeof result.duration_api_ms === 'number' ? result.duration_api_ms : null;
    n.ttftMs = typeof result.ttft_ms === 'number' ? result.ttft_ms : null;
    n.stopReason = result.stop_reason ?? result.subtype ?? null;
    n.permissionDenials = Array.isArray(result.permission_denials) ? result.permission_denials.length : null;
    n.extra.num_turns = result.num_turns ?? null;
    n.extra.duration_ms = result.duration_ms ?? null;
    n.extra.session_id = result.session_id ?? null;
    n.extra.subtype = result.subtype ?? null;
    const mu = result.modelUsage as Record<string, any> | undefined;
    if (mu && Object.keys(mu).length) {
      const byModel: Record<string, Tokens> = {};
      const total = zeroTokens();
      for (const [model, u] of Object.entries(mu)) {
        const t = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cache_read: u.cacheReadInputTokens ?? 0, cache_write: u.cacheCreationInputTokens ?? 0 };
        byModel[model] = t;
        addTokens(total, t);
      }
      n.tokens = { ...total, by_model: byModel };
    } else if (result.usage) {
      const t = usageTokens(result.usage);
      n.tokens = { ...t, by_model: { [init?.model ?? 'unknown']: { ...t } } };
    }
    if (result.usage?.server_tool_use) n.extra.server_tool_use = result.usage.server_tool_use;
  } else {
    n.status = 'no_result';
  }
  const errText = `${n.error ?? ''}`;
  if ((n.status !== 'completed' && RATE_LIMIT_RE.test(errText)) || (retries429 >= 3 && n.status !== 'completed')) n.rateLimited = true;
  if (n.status === 'error' && !n.rateLimited && TRANSIENT_RE.test(errText)) n.transientError = true;
  // "resets at <epoch>" or Claude Code's "usage limit reached|<epoch>"
  const m = /reset[s]? (?:at )?(\d{10,13})|limit reached\|(\d{10,13})/i.exec(errText);
  if (m) {
    const v = Number(m[1] ?? m[2]);
    n.resetAt = v < 1e12 ? v * 1000 : v;
  }
  n.extra.retries_429 = retries429;
  if (outputFormat === 'json') return n; // no tool events in this mode: tool metrics stay null

  const msgs = new Map<string, { model: string | null; sub: boolean; usage: any; content: any[] }>();
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  for (const e of lines) {
    if (e.type === 'assistant' && e.message) {
      const id = e.message.id ?? `anon-${msgs.size}`;
      const sub = !!e.parent_tool_use_id;
      const prev = msgs.get(id) ?? { model: e.message.model ?? null, sub, usage: null as any, content: [] as any[] };
      if (e.message.usage) prev.usage = e.message.usage;
      for (const b of e.message.content ?? []) {
        prev.content.push(b);
        if (b.type === 'tool_use' && !byId.has(b.id)) {
          const c: Call = { id: b.id, name: b.name, input: b.input ?? {}, isError: null, result: '', sub };
          calls.push(c);
          byId.set(b.id, c);
        }
      }
      msgs.set(id, prev);
    } else if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type !== 'tool_result') continue;
        const c = byId.get(b.tool_use_id);
        if (c) {
          c.isError = !!b.is_error;
          c.result = textOf(b.content).slice(0, RESULT_KEEP);
        }
      }
    }
  }
  for (const c of calls) if (c.isError === null) c.isError = false;
  n.calls = calls;
  const requests: Request[] = [];
  const served = new Set<string>();
  let main = 0;
  let sub = 0;
  for (const m of msgs.values()) {
    if (m.model === '<synthetic>') continue;
    if (m.sub) sub++;
    else {
      main++;
      if (m.model) served.add(m.model);
    }
    if (m.usage) requests.push({ model: m.model, sub: m.sub, purpose: m.sub ? 'subagent' : 'turn', tokens: usageTokens(m.usage), latency_ms: null });
  }
  n.requests = requests;
  n.turnsMain = main;
  n.turnsSub = sub;
  n.modelServed = [...served];
  if (!n.tokens && requests.length) {
    const total = zeroTokens();
    for (const r of requests) addTokens(total, r.tokens);
    n.tokens = { ...total, by_model: {} };
  }
  return n;
}

// ---------------------------------------------------------------------------
// Codex (D, reference only)
// ---------------------------------------------------------------------------

export function normalizeCodex(lines: any[]): Normalized {
  const n = emptyNormalized('unknown');
  const calls: Call[] = [];
  let last: string | null = null;
  const total = zeroTokens();
  let haveUsage = false;
  let turns = 0;
  for (const e of lines) {
    const item = e.item ?? e.msg ?? e;
    const type = item?.type ?? e.type;
    if (/agent_message/.test(type) && typeof (item.text ?? item.message) === 'string') last = item.text ?? item.message;
    if (/command_execution|exec_command/.test(type)) calls.push({ id: String(item.id ?? calls.length), name: 'Bash', input: { command: item.command ?? '' }, isError: item.exit_code ? item.exit_code !== 0 : null, result: String(item.aggregated_output ?? '').slice(0, RESULT_KEEP), sub: false });
    if (/file_change|patch_apply/.test(type)) calls.push({ id: String(item.id ?? calls.length), name: 'Edit', input: { changes: item.changes ?? null }, isError: item.status === 'failed', result: '', sub: false });
    if (/turn\.completed|token_count/.test(e.type ?? '') && (e.usage || item.usage)) {
      const u = e.usage ?? item.usage;
      haveUsage = true;
      turns++;
      addTokens(total, { input: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0), output: u.output_tokens ?? 0, cache_read: u.cached_input_tokens ?? 0 });
    }
  }
  n.status = last ? 'completed' : 'unknown';
  n.calls = calls.length ? calls : null;
  n.finalText = last;
  n.tokens = haveUsage ? { ...total, by_model: {} } : null;
  n.turnsMain = turns || null;
  return n;
}

// ---------------------------------------------------------------------------
// Running an arm
// ---------------------------------------------------------------------------

function parseLines(file: string): any[] {
  if (!existsSync(file)) return [];
  const out: any[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* partial line */
    }
  }
  return out;
}

export async function runArm(c: ArmContext): Promise<ArmOutput> {
  const stdoutFile = join(c.runDir, 'stdout.txt');
  const stderrFile = join(c.runDir, 'stderr.txt');
  const hubFile = join(c.runDir, 'hub.json');
  const isConclave = isHubArm(c.arm);
  const style = isConclave ? 'conclave' : c.arm === 'B' ? 'claude' : 'codex';
  const env: Record<string, string> = { ...c.env };
  let transport = 'n/a';
  let thinking = { mode: 'tool default', effort: null as string | null, source: 'not set by the runner' };
  const viaTap = !!c.tap && !c.dryRun && (isConclave || (c.arm === 'B' && c.transport === 'proxy'));
  c.tap?.begin(c.runId, { prompt: c.prompt, probe: c.probe });

  // per run hub for the Conclave arms: fresh CONCLAVE_HOME inside the run's own home
  let hub: BenchHub | null = null;
  const hubInfo: NonNullable<ArmOutput['hub']> = { start_ms: null, overrides: [], settle_status: null, error: null };
  if (isConclave && c.hubOptions && !c.dryRun) {
    const hubEnv = { ...env };
    if (c.proxy.apiKey) hubEnv.CLIPROXY_API_KEY = c.proxy.apiKey;
    if (c.arm === 'C') hubEnv.npm_config_cache = join(tmpdir(), 'conclave-bench-npm'); // the ACP adapter, fetched once by doctor
    hub = new BenchHub(c.hubOptions, hubEnv, c.home, join(c.runDir, 'hub.log'));
    try {
      await hub.start();
      hubInfo.start_ms = hub.startMs;
      hubInfo.overrides = hub.overrides;
      // A+skills: the same hub with catalog items installed through Conclave's own catalog code
      if (c.arm === 'A+skills' && c.skills?.length) {
        const t0 = Date.now();
        hubInfo.skills = await hub.installSkills(c.skills);
        hubInfo.skills_ms = Date.now() - t0;
        const bad = hubInfo.skills.filter((s) => !s.ok);
        if (bad.length) throw new Error(`skill install failed: ${bad.map((s) => `${s.id} (${s.error})`).join('; ')}`);
      }
    } catch (e) {
      await hub.stop().catch(() => {});
      hubInfo.error = (e as Error).message.slice(0, 500);
      await c.tap?.end(0);
      const norm = emptyNormalized('hub_start_failed');
      norm.error = hubInfo.error;
      writeFileSync(join(c.runDir, 'final.txt'), '');
      const proc: ProcResult = { exitCode: null, signal: null, wallMs: 0, timedOut: false, stoppedFor: null, maxRssKb: null, cpuMs: null, startedAt: Date.now() };
      return { argv: [], proc, norm, transport: 'n/a', thinking, tap: null, hub: hubInfo };
    }
  }

  const mcpConfig = join(c.home, '.claude', 'mcp-none.json');
  const shown = armArgv({ ...c, hub: hub ? { url: hub.url, token: hub.token } : null, mcpConfig });
  let argv = [...shown];

  if (isConclave) {
    env.CONCLAVE_HOME = hub?.conclaveHome ?? join(c.home, '.conclave');
    argv[0] = process.execPath;
    transport = c.arm === 'A' || c.arm === 'A+skills' ? 'proxy-anthropic' : c.arm === 'A2' ? 'proxy-openai' : 'acp';
    const shipped = coderThinking(c.conclaveSrc);
    thinking = c.matchEffort
      ? { mode: 'agent override', effort: c.matchEffort, source: 'bench agent coder.md with thinking: ' + c.matchEffort }
      : shipped
        ? { mode: 'coder agent default', effort: shipped, source: `coder.md sets thinking: ${shipped}` }
        : { mode: 'Conclave default for coding agents', effort: null, source: 'coder agent sets no thinking level; Conclave sends medium to Claude models that take effort (the tap records what was sent)' };
  } else if (c.arm === 'B') {
    // a fresh config folder per run: no transcripts, memory or settings from any earlier run
    const cfg = join(c.home, '.claude');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(mcpConfig, '{"mcpServers": {}}\n');
    env.CLAUDE_CONFIG_DIR = cfg;
    env.DISABLE_AUTOUPDATER = '1';
    if (process.getuid?.() === 0) env.IS_SANDBOX = '1';
    if (c.transport === 'proxy') {
      env.ANTHROPIC_BASE_URL = viaTap ? c.tap!.url : c.proxy.baseUrl;
      if (c.proxy.apiKey) env.ANTHROPIC_API_KEY = c.proxy.apiKey;
      env.ANTHROPIC_SMALL_FAST_MODEL = c.smallModel;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = c.smallModel;
      transport = 'proxy-anthropic';
    } else {
      const tok = process.env.BENCH_CLAUDE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
      else if (existsSync(join(CLAUDE_LOGIN_DIR, '.credentials.json'))) copyFileSync(join(CLAUDE_LOGIN_DIR, '.credentials.json'), join(cfg, '.credentials.json'));
      transport = 'login';
    }
    thinking = c.matchEffort && c.claudeFlags?.effort
      ? { mode: 'effort flag', effort: c.matchEffort, source: '--effort ' + c.matchEffort }
      : { mode: 'Claude Code default', effort: null, source: `version ${c.claudeFlags?.version ?? 'unknown'} default, no flag passed` };
  } else {
    transport = 'codex-login';
  }

  if (c.dryRun) argv = fakeArgv(c, style, hubFile);

  // live watch: token cap and rate limits. With the tap, the cap counts the
  // same way for every arm; without it each arm's own stream is used.
  let liveTokens = 0;
  const perMsg = new Map<string, number>();
  let stopper: ((r: string) => void) | null = null;
  const onLine = (line: string) => {
    if (!line.startsWith('{')) return;
    const e = JSON.parse(line);
    if (isConclave) {
      if (!viaTap && e.type === 'usage.recorded' && e.record) {
        const r = e.record;
        liveTokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
      }
      if (e.type === 'session.updated' && e.session?.status === 'waiting_reset') stopper?.('rate_limit');
    } else if (!viaTap && c.arm === 'B' && e.type === 'assistant' && e.message?.usage) {
      const u = usageTokens(e.message.usage);
      perMsg.set(e.message.id ?? String(perMsg.size), u.input + u.output + u.cache_read + u.cache_write);
      liveTokens = [...perMsg.values()].reduce((a, b) => a + b, 0);
    }
    if (liveTokens > c.tokenCap) stopper?.('token_cap');
  };

  const handle = await startProc({ cmd: argv, cwd: c.copy, env, stdoutFile, stderrFile, limitMs: c.limitS * 1000, plan: isConclave ? 'conclave' : 'claude', onLine, stepMs: c.dryRun ? c.killStepMs : undefined });
  stopper = handle.stop;
  c.onHandle?.(handle.stop);
  let poll: ReturnType<typeof setInterval> | undefined;
  if (viaTap) {
    poll = setInterval(() => {
      liveTokens = c.tap!.liveTokens();
      if (liveTokens > c.tokenCap) handle.stop('token_cap');
    }, 2_000);
  }
  const proc = await handle.done;
  if (poll) clearInterval(poll);
  const lines = parseLines(stdoutFile);
  let norm: Normalized;
  if (isConclave) {
    let data: HubData | null = null;
    const sessionId = lines.find((e) => e.type === 'run.session')?.session?.id ?? lines.find((e) => e.type === 'run.done')?.sessionId;
    if (c.dryRun) data = existsSync(hubFile) ? readJson<HubData>(hubFile) : null;
    else if (hub && sessionId) {
      try {
        // the CLI is gone; make sure the session is too before anything reads the folder
        hubInfo.settle_status = await hub.settle(sessionId);
        await new Promise((r) => setTimeout(r, 1000)); // late usage records (titles)
        data = await hub.runData(sessionId);
        writeFileSync(hubFile, JSON.stringify(data, null, 1));
      } catch (e) {
        writeFileSync(join(c.runDir, 'hub-error.txt'), String(e) + '\n' + hubLogTail(join(c.runDir, 'hub.log')));
      }
    }
    if (hub) await hub.stop();
    norm = normalizeConclave(lines, data, c.model);
    writeFileSync(join(c.runDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  } else if (c.arm === 'B') {
    norm = normalizeClaude(lines, c.claudeFlags?.outputFormat ?? 'stream-json');
    writeFileSync(join(c.runDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  } else {
    norm = normalizeCodex(lines);
  }
  const tapRecs = c.tap ? await c.tap.end() : null;
  if (tapRecs && viaTap) writeFileSync(join(c.runDir, 'tap.jsonl'), tapRecs.map((r) => JSON.stringify(r)).join('\n') + (tapRecs.length ? '\n' : ''));
  if (proc.stoppedFor === 'rate_limit') norm.rateLimited = true;
  writeFileSync(join(c.runDir, 'final.txt'), norm.finalText ?? '');
  return { argv: shown.map((x) => (x === hub?.token ? '<token>' : x)), proc, norm, transport, thinking, tap: viaTap ? tapRecs : null, hub: isConclave && !c.dryRun ? hubInfo : null };
}

export { totalTokens };
