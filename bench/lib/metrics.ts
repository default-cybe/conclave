/**
 * Normalized metrics (PROTOCOL 9). Each arm adapter turns its own transcript
 * into a Normalized record; computeMetrics() then derives the same fields for
 * every arm. A value a tool does not report stays null, never 0.
 */
import { isLeak, leakEvidence, scanCalls, type LeakProbe } from './leaks';
import type { DiffResult, WorkCopy } from './workcopy';
import { endsEqualToPristine } from './workcopy';

export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isError: boolean | null;
  result: string;
  sub: boolean;
}

export interface Request {
  model: string | null;
  sub: boolean;
  purpose: string | null;
  tokens: Tokens;
  latency_ms: number | null;
}

export interface Normalized {
  status: string;
  error: string | null;
  calls: Call[] | null;
  turnsMain: number | null;
  turnsSub: number | null;
  requests: Request[] | null;
  tokens: (Tokens & { by_model: Record<string, Tokens> }) | null;
  costReportedUsd: number | null;
  modelServed: string[];
  finalText: string | null;
  apiMs: number | null;
  ttftMs: number | null;
  stopReason: string | null;
  permissionDenials: number | null;
  rateLimited: boolean;
  resetAt: number | null;
  transientError: boolean;
  /** What Conclave's regression gate saw in the run; null for a tool without it. */
  regressionGate?: RegressionGateCounts | null;
  /** Free-form extra fields from the tool (session id, version, raw counters). */
  extra: Record<string, unknown>;
}

/**
 * Conclave's regression gate (packages/core/src/session/regression-gate.ts):
 * how often it ran a turn's changed tests on the code from before the turn,
 * and what it found. One count per `regression.checked` event.
 */
export interface RegressionGateCounts {
  /** The tests failed on the old code. */
  proven: number;
  /** The tests passed on the old code. */
  passes: number;
  /** The run said nothing (timeout, a test that did not load). */
  not_run: number;
  /** It did not run them (the checkpoint raced, no runner it knows, an untrusted folder). */
  skipped: number;
  /** Reminders sent to the agent (passes, once per user turn). */
  reminded: number;
}

/**
 * Count the gate's events in a Conclave run: from the event stream, else from
 * the session's audit rows (`regression.gate`, detail "<outcome>[, reminded]: ...").
 */
export function regressionGateCounts(stream: any[], audit: any[] | null | undefined): RegressionGateCounts {
  const c: RegressionGateCounts = { proven: 0, passes: 0, not_run: 0, skipped: 0, reminded: 0 };
  const events = stream.filter((e) => e?.type === 'regression.checked');
  const looks = events.length
    ? events.map((e) => ({ outcome: String(e.outcome), reminded: !!e.reminded }))
    : (audit ?? []).filter((a) => a?.action === 'regression.gate').map((a) => {
        const head = String(a.detail ?? '').split(/[:(]/)[0];
        return { outcome: head.split(',')[0].trim(), reminded: /\breminded\b/.test(head) };
      });
  for (const l of looks) {
    if (l.outcome === 'proven' || l.outcome === 'passes' || l.outcome === 'not_run' || l.outcome === 'skipped') c[l.outcome]++;
    if (l.reminded) c.reminded++;
  }
  return c;
}

export function emptyNormalized(status = 'unknown'): Normalized {
  return {
    status,
    error: null,
    calls: null,
    turnsMain: null,
    turnsSub: null,
    requests: null,
    tokens: null,
    costReportedUsd: null,
    modelServed: [],
    finalText: null,
    apiMs: null,
    ttftMs: null,
    stopReason: null,
    permissionDenials: null,
    rateLimited: false,
    resetAt: null,
    transientError: false,
    regressionGate: null,
    extra: {},
  };
}

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

export function addTokens(a: Tokens, b: Partial<Tokens>): Tokens {
  a.input += b.input ?? 0;
  a.output += b.output ?? 0;
  a.cache_read += b.cache_read ?? 0;
  a.cache_write += b.cache_write ?? 0;
  return a;
}

export function totalTokens(t: Tokens | null | undefined): number | null {
  if (!t) return null;
  return t.input + t.output + t.cache_read + t.cache_write;
}

const TOOL_MAP: Record<string, string> = {
  Read: 'read',
  NotebookRead: 'read',
  ReadToolOutput: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Bash: 'bash',
  BashOutput: 'bash',
  KillShell: 'bash',
  KillBash: 'bash',
  Grep: 'grep',
  RepoMap: 'grep',
  Glob: 'glob',
  LS: 'list',
  TodoWrite: 'todo',
  Task: 'task',
  Agent: 'task',
};

export function normTool(name: string): string {
  return TOOL_MAP[name] ?? 'other';
}

export const RATE_LIMIT_RE = /rate.?limit|\b429\b|usage limit|overloaded|too many requests/i;
export const TRANSIENT_RE = /overloaded|\b5\d\d\b|ECONNRESET|ECONNREFUSED|ConnectionRefused|Unable to connect|socket hang up|network|fetch failed|timed? ?out talking/i;

const EDIT_MISS_RE = /not found in|was not found|String to replace not found|not unique|matches \d+ places|Found \d+ matches|must match exactly one|old_string/i;
const NETWORK_RE = /\b(curl|wget|pip3? install|python3? -m pip|npm (i|install|ci|add)\b|yarn add|pnpm add|bun (add|install|i)\b|cargo (fetch|add|install|update)\b|go (get|mod download|install)\b|git (clone|fetch|pull)\b|apt(-get)? |brew install|npx )/;
const REVERT_BASH_RE = /git (checkout --|checkout \S+ --|restore\b|reset --hard)|\bcp\s+\S+\.(bak|orig)\b|\bmv\s+\S+\.(bak|orig)\b/;
/** git stash that sets work aside (not pop, apply, list, show, drop, clear or branch). */
const STASH_RE = /\bgit\s+stash\b(?!\s+(pop|apply|list|show|drop|clear|branch)\b)/;
const UNSTASH_RE = /\bgit\s+stash\s+(pop|apply)\b/;
/** Test output that shows a failure. */
const TEST_FAIL_RE = /\bFAIL(ED)?\b|\bfailed\b|\bfailures?\b|AssertionError|\bpanicked\b|\bnot ok\b|\(fail\)|\berror\[E\d+\]/;

export interface StashUse {
  /** Stashes never popped or applied in the same or a later command: work put away for good. */
  reverts: number;
  /** Stash, then a test run, then pop or apply: checking the test without the fix. */
  checks: number;
  /** One of those checks showed a failing test. */
  failedWithoutFix: boolean;
}

/**
 * How a run used git stash. Commands are split at && || ; | and newlines and
 * read in order. A stash followed by a pop or apply (in the same or a later
 * command) is a check, not a reverted edit; with a test run in between that
 * shows a failure, it verified that the test fails without the fix.
 */
export function stashUse(cmds: Array<{ cmd: string; result: string }>): StashUse {
  const segs: Array<{ text: string; call: number }> = [];
  cmds.forEach((c, i) => {
    for (const s of c.cmd.split(/&&|\|\||;|\||\n/)) if (s.trim()) segs.push({ text: s.trim(), call: i });
  });
  let reverts = 0;
  let checks = 0;
  let failedWithoutFix = false;
  for (let i = 0; i < segs.length; i++) {
    if (!STASH_RE.test(segs[i].text) || UNSTASH_RE.test(segs[i].text)) continue;
    const back = segs.findIndex((s, j) => j > i && UNSTASH_RE.test(s.text));
    if (back < 0) {
      reverts++;
      continue;
    }
    const tests = segs.slice(i + 1, back).filter((s) => TEST_RUN_RE.test(s.text));
    if (!tests.length) continue;
    checks++;
    if (tests.some((s) => TEST_FAIL_RE.test(cmds[s.call].result))) failedWithoutFix = true;
  }
  return { reverts, checks, failedWithoutFix };
}
const TEST_RUN_RE = /\b(bun test|npm test|pytest|python3? -m (unittest|pytest)|unittest|go test|cargo test|node --test|jest|vitest)\b|_test\.py|\.spec\.js|test_\w+\.py/;
const FILE_TOOLS = new Set(['read', 'edit', 'write']);
const LEAK_MARKERS = ['/hidden/', '/.meta/', 'polyglot-benchmark', '/bench/tasks', '/bench/fixtures', '/bench/results', '/bench/.state', 'conclave-bench/_validate'];

function inputText(c: Call): string {
  try {
    return JSON.stringify(c.input);
  } catch {
    return '';
  }
}

function bashCommand(c: Call): string | null {
  if (normTool(c.name) !== 'bash') return null;
  const cmd = c.input.command ?? c.input.cmd;
  return typeof cmd === 'string' ? cmd : null;
}

function filePathOf(c: Call): string | null {
  const p = c.input.file_path ?? c.input.path ?? c.input.notebook_path;
  return typeof p === 'string' ? p : null;
}

function relTo(repo: string, p: string): string {
  if (p.startsWith(repo + '/')) return p.slice(repo.length + 1);
  return p.replace(/^\.\//, '');
}

/** The last RESULT line. Markdown around it ("**RESULT: DONE**", "RESULT: **NOT DONE**", backticks) does not hide it. */
export function parseClaim(text: string | null): 'DONE' | 'NOT DONE' | null {
  if (!text) return null;
  const all = [...text.matchAll(/RESULT[*_`]*\s*:\s*[*_`]*\s*(NOT\s+DONE|DONE)\b/gi)];
  if (!all.length) return null;
  return all[all.length - 1][1].toUpperCase() === 'DONE' ? 'DONE' : 'NOT DONE';
}

export interface Derived {
  turns: { main: number | null; sub: number | null };
  tools: {
    calls: number | null;
    by_tool: Record<string, number> | null;
    raw: Record<string, number> | null;
    failed: number | null;
    bash_nonzero: number | null;
    edit_misses: number | null;
    /** Failed file tool calls on a wrong absolute path under the work root: nothing was read or written. */
    path_slips: number | null;
    failed_examples: string[];
  };
  edits: { edit_calls: number | null; reverted: number | null };
  /** git stash, a test run, then pop: did the run check its test without the fix, and did that show a failure. */
  verify: { stash_checks: number | null; failed_without_fix: boolean | null };
  shell: { commands: string[] | null; ran_tests: boolean | null };
  files_read: string[] | null;
  files_written: string[] | null;
  flags: { network_attempt: boolean | null; leak_suspect: boolean | null; leak_evidence: string[]; wide_search: string[] };
  claim: 'DONE' | 'NOT DONE' | null;
  no_claim: boolean;
}

export function derive(n: Normalized, wc: WorkCopy, workRoot: string, benchDir: string, probe: LeakProbe | null = null): Derived {
  const claim = parseClaim(n.finalText);
  const out: Derived = {
    turns: { main: n.turnsMain, sub: n.turnsSub },
    tools: { calls: null, by_tool: null, raw: null, failed: null, bash_nonzero: null, edit_misses: null, path_slips: null, failed_examples: [] },
    edits: { edit_calls: null, reverted: null },
    verify: { stash_checks: null, failed_without_fix: null },
    shell: { commands: null, ran_tests: null },
    files_read: null,
    files_written: null,
    flags: { network_attempt: null, leak_suspect: null, leak_evidence: [], wide_search: [] },
    claim,
    no_claim: claim === null,
  };
  if (!n.calls) return out;
  const calls = n.calls;
  const byTool: Record<string, number> = {};
  const raw: Record<string, number> = {};
  let failed = 0;
  let bashNonzero = 0;
  let editMisses = 0;
  let pathSlips = 0;
  const commands: string[] = [];
  const bashCalls: Array<{ cmd: string; result: string }> = [];
  const read = new Set<string>();
  const written = new Set<string>();
  const editPairs: Array<{ file: string; old: string; neu: string }> = [];
  let reverted = 0;
  let network = false;
  const leaks: string[] = [];
  const wide: string[] = [];
  for (const c of calls) {
    const k = normTool(c.name);
    byTool[k] = (byTool[k] ?? 0) + 1;
    raw[c.name] = (raw[c.name] ?? 0) + 1;
    if (c.isError) {
      if (k === 'bash') bashNonzero++;
      else {
        failed++;
        if (out.tools.failed_examples.length < 8) out.tools.failed_examples.push(`${c.name}: ${c.result.slice(0, 200)}`);
      }
      if (k === 'edit' && EDIT_MISS_RE.test(c.result)) editMisses++;
    }
    const cmd = bashCommand(c);
    if (cmd) {
      commands.push(cmd.length > 400 ? cmd.slice(0, 400) + '...' : cmd);
      bashCalls.push({ cmd, result: c.result ?? '' });
      if (NETWORK_RE.test(cmd)) network = true;
      if (REVERT_BASH_RE.test(cmd)) reverted++;
      if (/\b(find|locate|fd|rg|grep\s+-[a-zA-Z]*r)\b[^|;&]*\s(\/|~|\$HOME|\.\.\/\.\.)(\s|$|\/\s)/.test(cmd)) wide.push(cmd.slice(0, 160)); // info only: it counts as a leak when the tap or the scan below sees hidden paths or lines
    }
    if (c.name === 'WebFetch' || c.name === 'WebSearch' || /^browser_/.test(c.name)) network = true;
    const fp = filePathOf(c);
    if (fp && k === 'read') read.add(relTo(wc.repo, fp));
    if (fp && (k === 'edit' || k === 'write') && !c.isError) written.add(relTo(wc.repo, fp));
    if (k === 'edit' && !c.isError && fp) {
      const pairs: Array<{ old: string; neu: string }> = [];
      if (typeof c.input.old_string === 'string' && typeof c.input.new_string === 'string') pairs.push({ old: c.input.old_string, neu: c.input.new_string });
      if (Array.isArray(c.input.edits)) for (const e of c.input.edits as Array<Record<string, unknown>>) if (typeof e.old_string === 'string' && typeof e.new_string === 'string') pairs.push({ old: e.old_string, neu: e.new_string });
      for (const p of pairs) {
        if (editPairs.some((q) => q.file === fp && q.old === p.neu && q.neu === p.old && p.old !== '')) reverted++;
        editPairs.push({ file: fp, ...p });
      }
    }
    // paths outside the copy that point at tasks, hidden tests or the bench
    const text = inputText(c);
    // a file tool call that failed because its path does not exist read and wrote nothing
    const missed = !!c.isError && FILE_TOOLS.has(k) && /does not exist|no such file|ENOENT/i.test(c.result);
    for (const m of text.matchAll(/(?:\/[\w.@+-]+)+\/?/g)) {
      const p = m[0];
      // the run's own sandbox (repo and home) is fine; other runs, the bench tree and hidden folders are not
      if (p === wc.root || p.startsWith(wc.root + '/') || p.startsWith('/dev/') || p.startsWith('/proc/') || p.startsWith('/usr/') || p.startsWith('/bin/')) continue;
      const hidden = p.startsWith(benchDir + '/') || LEAK_MARKERS.some((mk) => p.includes(mk));
      if (missed && !hidden && p.startsWith(workRoot + '/')) pathSlips++;
      else if (hidden || p.startsWith(workRoot + '/')) leaks.push(`${c.name}: ${p}`);
    }
  }
  // (b) files the agent wrote that end equal to pristine
  for (const f of written) if (endsEqualToPristine(wc, f)) reverted++;
  // (c) stashes: put away for good is a revert; stash, test, pop is a check of the test without the fix
  const stash = stashUse(bashCalls);
  reverted += stash.reverts;
  out.verify = { stash_checks: stash.checks, failed_without_fix: stash.failedWithoutFix };
  out.tools = {
    calls: calls.length,
    by_tool: byTool,
    raw,
    failed,
    bash_nonzero: bashNonzero,
    edit_misses: editMisses,
    path_slips: pathSlips,
    failed_examples: out.tools.failed_examples,
  };
  out.edits = { edit_calls: (byTool.edit ?? 0) + (byTool.write ?? 0), reverted };
  out.shell = { commands, ran_tests: commands.some((c) => TEST_RUN_RE.test(c)) };
  out.files_read = [...read].sort();
  out.files_written = [...written].sort();
  if (probe) {
    const scan = scanCalls(calls, probe);
    if (isLeak(scan)) leaks.push(...leakEvidence(scan, 'transcript'));
  }
  out.flags = { network_attempt: network, leak_suspect: leaks.length > 0, leak_evidence: [...new Set(leaks)].slice(0, 10), wide_search: wide.slice(0, 5) };
  return out;
}

export interface Prices {
  date: string;
  models: Record<string, { input: number; output: number; cache_read: number; cache_write: number }>;
}

/** List cost with one formula for every arm: tokens times USD per million. Unknown model: null. */
export function listCost(byModel: Record<string, Tokens> | null | undefined, prices: Prices): number | null {
  if (!byModel) return null;
  let total = 0;
  for (const [model, t] of Object.entries(byModel)) {
    const p = priceFor(model, prices);
    if (!p) return null;
    total += (t.input * p.input + t.output * p.output + t.cache_read * p.cache_read + t.cache_write * p.cache_write) / 1e6;
  }
  return Math.round(total * 1e6) / 1e6;
}

/**
 * List cost from tap counts. The same formula as listCost, except that cache
 * writes with the 1 hour TTL use their own price (2 times input, the API's
 * rate), because one harness may ask for the longer TTL and the other not.
 */
export function listCostTap(byModel: Record<string, Tokens & { cache_write_1h?: number }> | null | undefined, prices: Prices): number | null {
  if (!byModel) return null;
  let total = 0;
  for (const [model, t] of Object.entries(byModel)) {
    const p = priceFor(model, prices);
    if (!p) return null;
    const w1h = Math.min(t.cache_write, t.cache_write_1h ?? 0);
    const p1h = (p as { cache_write_1h?: number }).cache_write_1h ?? p.input * 2;
    total += (t.input * p.input + t.output * p.output + t.cache_read * p.cache_read + (t.cache_write - w1h) * p.cache_write + w1h * p1h) / 1e6;
  }
  return Math.round(total * 1e6) / 1e6;
}

export function priceFor(model: string, prices: Prices) {
  const id = model.replace(/^[\w-]+\//, '').replace(/^neu\//, '').replace(/\[.*\]$/, '');
  if (prices.models[id]) return prices.models[id];
  const hit = Object.keys(prices.models)
    .sort((a, b) => b.length - a.length)
    .find((k) => id.startsWith(k + '-') || id.startsWith(k + '@'));
  return hit ? prices.models[hit] : null;
}
