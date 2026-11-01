#!/usr/bin/env bun
/**
 * `bench parity`: checks that the two arms get the same deal and cannot see
 * what they must not see. Fast checks run without any model or agent. With
 * --e2e it also runs the real Conclave hub and the real Claude Code against a
 * fake model API (checks/mock-upstream.ts), through the tap, and checks what
 * each harness actually sent and what its agent could see.
 *
 *   bun bench/bench.ts parity          fast checks
 *   bun bench/bench.ts parity --e2e    fast checks plus both real harnesses on a fake model
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_DENY, writeAgentOverrides } from '../lib/hub';
import { armArgv, CLAUDE_DENY, detectClaudeFlags, FORBIDDEN_TOOLS, forbiddenOffered, runArm, type ArmId } from '../lib/arms';
import { baseEnv, benchPathsIn, BENCH_HOME, STATE_DIR } from '../lib/env';
import { buildJudgePrompt, type Candidate } from '../lib/judge';
import { buildCanaries, isLeak, leakMarkers, scanCalls, scanRequest, type LeakProbe } from '../lib/leaks';
import { derive, listCost, listCostTap, type Prices } from '../lib/metrics';
import { firstCounts, makePlan, servedMatches } from '../lib/runset';
import { foldAnthropicUsage, summarizeTap, Tap } from '../lib/tap';
import { loadTasks, taskPrompt, type Task } from '../lib/tasks';
import { BENCH_DIR, readJson, REPO_DIR, sha256, shuffle } from '../lib/util';
import { computeDiff, foreignBenchProcesses, killStragglers, makeWorkCopy, retireWorkCopy, sandboxNeighbours } from '../lib/workcopy';
import { MOCK_USAGE, startMockUpstream } from './mock-upstream';

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });
const scratch = join(tmpdir(), `conclave-bench-parity-${process.pid}`);

function fakeTask(dir: string): Task {
  mkdirSync(join(dir, 'repo'), { recursive: true });
  writeFileSync(join(dir, 'repo', 'README.md'), '# demo\n');
  writeFileSync(join(dir, 'repo', 'main.py'), 'def add(a, b):\n    return a + b\n');
  return {
    id: 'parity-demo',
    title: 'parity demo',
    kind: 'feature',
    lang: 'python',
    difficulty: 'easy',
    time_limit_s: 120,
    smoke: false,
    requires: [],
    source: {},
    visible_test_cmd: null,
    hidden: { files: {}, clear: [], runs: [], timeout_s: 60, expected_total: 0, restore: [], move_aside: [] },
    protected: ['tests/**'],
    artifacts: ['node_modules/', 'target/', '__pycache__/'],
    reference: 'hidden/reference/',
    naive: null,
    license: null,
    dir,
  };
}

// ---------------------------------------------------------------------------
// fast checks
// ---------------------------------------------------------------------------

async function fastChecks(): Promise<void> {
  // 1. arm order: exact balance of who goes first
  const ids = Array.from({ length: 18 }, (_, i) => `t${i}`);
  for (const [arms, reps] of [[['A', 'B'], 1], [['A', 'B'], 2], [['A', 'B', 'A2'], 1]] as Array<[ArmId[], number]>) {
    const fc = firstCounts(makePlan(ids, arms, reps, 1));
    const v = arms.map((a) => fc[a] ?? 0);
    check(`arm order balanced (${arms.join(',')} x${reps})`, Math.max(...v) - Math.min(...v) <= 1, JSON.stringify(fc));
  }

  // 2. the same prompt, byte for byte, in both argvs
  const tasks = loadTasks('all');
  let same = 0;
  for (const t of tasks) {
    const prompt = taskPrompt(t);
    const a = armArgv({ arm: 'A', model: 'm', prompt, copy: '/c', limitS: t.time_limit_s, conclaveSrc: REPO_DIR, claudeFlags: null, matchEffort: null, hub: null });
    const b = armArgv({ arm: 'B', model: 'm', prompt, copy: '/c', limitS: t.time_limit_s, conclaveSrc: REPO_DIR, claudeFlags: null, matchEffort: null, hub: null });
    if (a.filter((x) => x === prompt).length === 1 && b.filter((x) => x === prompt).length === 1) same++;
  }
  check('same prompt in both argvs', same === tasks.length, `${same} of ${tasks.length} tasks`);

  // 3. denied tools: both deny lists cover the forbidden tools each harness has
  const conclaveTools = new Set<string>();
  const toolDir = join(REPO_DIR, 'packages', 'core', 'src', 'tools');
  // tool files only: tools/ also holds folders (tools/compress)
  if (existsSync(toolDir)) for (const f of readdirSync(toolDir).filter((x) => x.endsWith('.ts'))) for (const m of readFileSync(join(toolDir, f), 'utf8').matchAll(/name: '([A-Z]\w+)'/g)) conclaveTools.add(m[1]);
  const conclaveForbidden = FORBIDDEN_TOOLS.filter((t) => conclaveTools.has(t));
  const missA = conclaveForbidden.filter((t) => !AGENT_DENY.includes(t));
  check('A deny list covers Conclave tools that reach the web, people, memory or schedules', !missA.length, missA.length ? `missing ${missA.join(', ')}` : conclaveForbidden.join(', '));
  const claudeSide = FORBIDDEN_TOOLS.filter((t) => !conclaveTools.has(t) || ['WebFetch', 'WebSearch', 'AskUserQuestion'].includes(t));
  const missB = claudeSide.filter((t) => !CLAUDE_DENY.includes(t));
  check('B deny list covers Claude Code tools that reach the web, people or schedules', !missB.length, missB.length ? `missing ${missB.join(', ')}` : `${CLAUDE_DENY.length} tools`);

  // 4. agent overrides: the tools come out of the list, the prompt text stays byte for byte
  const ovr = join(scratch, 'overrides');
  const written = writeAgentOverrides(REPO_DIR, ovr);
  let bodiesSame = 0;
  for (const f of written) {
    const shipped = readFileSync(join(REPO_DIR, 'packages', 'core', 'src', 'agents-defaults', f), 'utf8');
    const ours = readFileSync(join(ovr, 'agents', f), 'utf8');
    const body = (s: string) => s.replace(/^---\n[\s\S]*?\n---/, '');
    const fmLines = (s: string) => (/^---\n([\s\S]*?)\n---/.exec(s)?.[1] ?? '').split('\n');
    // the shipped disallowedTools line is joined with the bench denials; every other line stays
    const keeps = fmLines(shipped).filter((l) => !/^disallowedTools:/.test(l)).every((l) => fmLines(ours).includes(l));
    const list = (s: string) => /^disallowedTools: (.*)$/m.exec(s)?.[1]?.split(',').map((x) => x.trim()) ?? [];
    const deny = list(ours);
    if (body(shipped) === body(ours) && keeps && [...AGENT_DENY, ...list(shipped)].every((t) => deny.includes(t))) bodiesSame++;
  }
  check('A agent overrides: coder and every subagent, prompt unchanged', written.includes('coder.md') && bodiesSame === written.length && written.length > 1, `${bodiesSame} of ${written.length}: ${written.join(', ')}`);

  // 5. sandboxes: fresh home per run, no neighbours, no bench path in env or argv, pristine outside
  const t = fakeTask(join(scratch, 'task'));
  const work = join(scratch, 'work');
  const w1 = await makeWorkCopy(t, work, 'r1aaaa', join(scratch, 'private', 'r1aaaa'));
  const env1 = await baseEnv([], w1.home);
  const n1 = sandboxNeighbours(w1);
  retireWorkCopy(w1, join(scratch, 'runs', 'r1aaaa'), join(scratch, 'private', 'r1aaaa'));
  const w2 = await makeWorkCopy(t, work, 'r2bbbb', join(scratch, 'private', 'r2bbbb'));
  const env2 = await baseEnv([], w2.home);
  const n2 = sandboxNeighbours(w2);
  check('sandbox has only repo/ and home/, and no earlier run beside it', !n1.length && !n2.length, [...n1, ...n2].join(', ') || 'clean');
  check('fresh HOME per run', env1.HOME !== env2.HOME && env1.HOME === w1.home && existsSync(join(w2.home, '.gitconfig')), `${env1.HOME} vs ${env2.HOME}`);
  check('earlier run deleted, final repo kept', !existsSync(w1.root) && existsSync(join(scratch, 'runs', 'r1aaaa', 'final', 'main.py')));
  check('pristine copy is outside the sandbox', !w2.pristine.startsWith(w2.root));
  const bArgv = armArgv({ arm: 'B', model: 'm', prompt: 'p', copy: w2.repo, limitS: 60, conclaveSrc: REPO_DIR, claudeFlags: null, matchEffort: null, hub: null, mcpConfig: join(w2.home, '.claude', 'mcp-none.json') });
  const aArgv = armArgv({ arm: 'A', model: 'm', prompt: 'p', copy: w2.repo, limitS: 60, conclaveSrc: REPO_DIR, claudeFlags: null, matchEffort: null, hub: { url: 'http://127.0.0.1:1', token: 't' } });
  const envBad = benchPathsIn(Object.values(env2));
  const argvBad = benchPathsIn([...bArgv, ...aArgv]);
  check('no bench or state path in the agent env', !envBad.length, envBad.join(', ') || `HOME=${env2.HOME}`);
  check('no bench or state path in either argv', !argvBad.length, argvBad.join(', ') || 'clean');
  check('scorer home is not an agent home', !Object.values(env2).includes(BENCH_HOME));

  // 6. build products stay out of the diff
  writeFileSync(join(w2.repo, 'Cargo.lock'), 'version = 3\n');
  writeFileSync(join(w2.repo, 'bun.lock'), '{}\n');
  writeFileSync(join(w2.repo, 'main.py'), 'def add(a, b):\n    return b + a\n');
  const d = await computeDiff(t, w2, join(scratch, 'runs', 'r2bbbb'));
  check('build products are not in the diff', d.files_changed === 1 && !d.patch.includes('Cargo.lock') && !d.patch.includes('bun.lock'), `${d.files_changed} changed: ${[...d.files_added, ...d.files_modified].join(', ')}`);

  // 7. the leftover process sweep
  const sleeper = Bun.spawn(['sleep', '120'], { cwd: w2.repo, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true } as any);
  await Bun.sleep(100);
  const killed = await killStragglers(w2.root);
  await Bun.sleep(100);
  check('leftover processes in the sandbox are killed', killed.some((k) => k.includes('sleep')) && sleeper.killed !== undefined, killed.join('; ') || 'nothing killed');
  retireWorkCopy(w2, join(scratch, 'runs', 'r2bbbb'), join(scratch, 'private', 'r2bbbb'));

  // 8. judge prompt: no arm, run id, harness name or harness file
  const jt = tasks.find((x) => x.id === 'bug-py-utf8') ?? tasks[0];
  const mk = (id: string, arm: string, extra: string): Candidate => {
    const f = join(scratch, `${id}.patch`);
    writeFileSync(f, `diff --git a/tasksd/http_util.py b/tasksd/http_util.py\n--- a/tasksd/http_util.py\n+++ b/tasksd/http_util.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n${extra}`);
    return { run_id: id, arm, diffPath: f, testsPath: join(scratch, 'none.txt'), tests: { passed: 3, expected_total: 6, build_error: false, pass: false }, modified_existing_tests: [] };
  };
  const cands = [
    mk('rzzz11', 'A', 'diff --git a/.conclave/notes.md b/.conclave/notes.md\n+++ b/.conclave/notes.md\n+note\n'),
    mk('rqqq22', 'B', 'diff --git a/.claude/settings.local.json b/.claude/settings.local.json\n+++ b/.claude/settings.local.json\n+{}\n'),
  ];
  const { text: jp } = buildJudgePrompt(jt, 'ref diff', cands);
  const taskText = taskPrompt(jt).toLowerCase();
  const bad: string[] = [];
  for (const needle of ['rzzz11', 'rqqq22', '.conclave/', '.claude/', 'arm a', 'arm b', 'conclave', 'claude code']) if (jp.toLowerCase().includes(needle) && !taskText.includes(needle)) bad.push(needle);
  check('judge prompt is blind (no run ids, arm or harness names, harness files)', !bad.length, bad.join(', ') || 'clean');
  let aFirst = 0;
  for (const x of tasks) if (shuffle([{ arm: 'A' }, { arm: 'B' }], parseInt(sha256(x.id).slice(0, 8), 16))[0].arm === 'A') aFirst++;
  check('judge order: A is candidate 1 in about half the tasks (the swap pass then reverses each)', aFirst >= 5 && aFirst <= tasks.length - 5, `A first in ${aFirst} of ${tasks.length} tasks in pass 1`);

  // 9. leak scan: paths and hidden lines the agent was shown, not lines it wrote
  const probe: LeakProbe = { markers: leakMarkers([STATE_DIR]), canaries: ['self.assertEqual(game.score(), 300) # perfect game', 'def test_two_strikes_in_a_row_bonus(self):', 'def test_spare_in_last_frame_bonus(self):'] };
  const body = (calls: any[], resultText: string) => ({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: calls }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: resultText }] }] });
  const find = scanRequest(body([{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'find / -name "*bowling*"' } }], `${join(BENCH_DIR, 'tasks', 'pg-py-bowling', 'hidden', 'tests', 'bowling_test.py')}\n`), probe);
  const peek = scanRequest(body([{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'cat ../../x' } }], probe.canaries.join('\n')), probe);
  const own = scanRequest(body([{ type: 'tool_use', id: 'x', name: 'Write', input: { file_path: 'test_b.py', content: probe.canaries.join('\n') } }, { type: 'tool_use', id: 'y', name: 'Read', input: { file_path: 'test_b.py' } }], probe.canaries.join('\n')), probe);
  const calm = scanRequest(body([{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }], 'main.py\nREADME.md\n'), probe);
  check('leak scan: a search that shows hidden paths is a leak', isLeak(find), JSON.stringify(find.markerInResults));
  check('leak scan: hidden test lines the agent did not write are a leak', isLeak(peek) && peek.canaryLines.length === 3);
  check('leak scan: lines the agent wrote itself are not a leak', !isLeak(own), JSON.stringify(own));
  check('leak scan: an ordinary run is clean', !isLeak(calm));
  const canaries = buildCanaries(tasks, new Map(tasks.map((x) => [x.id, taskPrompt(x)])));
  const withLines = tasks.filter((x) => (canaries.get(x.id)?.length ?? 0) >= 5).length;
  check('every task has hidden test lines to watch for', withLines === tasks.length, `${withLines} of ${tasks.length} tasks have 5 or more`);
  const wcFake = { root: '/tmp/x/r1', repo: '/tmp/x/r1/repo', home: '/tmp/x/r1/home', pristine: '/p', scratch: '/s' };
  const dv = derive(
    { status: 'completed', error: null, calls: [{ id: '1', name: 'Read', input: { file_path: '/tmp/x/r1/home/.gitconfig' }, isError: false, result: '', sub: false }], turnsMain: 1, turnsSub: 0, requests: null, tokens: null, costReportedUsd: null, modelServed: [], finalText: null, apiMs: null, ttftMs: null, stopReason: null, permissionDenials: null, rateLimited: false, resetAt: null, transientError: false, extra: {} },
    wcFake,
    '/tmp/x',
    BENCH_DIR,
    probe,
  );
  check('reading its own home is not a leak', dv.flags.leak_suspect === false, dv.flags.leak_evidence.join('; '));
  const dv2 = scanCalls([{ id: '1', name: 'Read', input: { file_path: join(BENCH_DIR, 'tasks', 'x', 'hidden', 'tests', 'a.py') }, isError: false, result: '', sub: false }], probe);
  check('reading a hidden test path is a leak (transcript scan)', isLeak(dv2));

  // 10. accounting: one price formula; 1 hour cache writes priced apart; served ids
  const prices = readJson<Prices>(join(BENCH_DIR, 'prices.json'));
  const tok = { input: 1000, output: 2000, cache_read: 30000, cache_write: 4000 };
  const lc = listCost({ 'claude-sonnet-5-5': tok }, prices);
  const lt = listCostTap({ 'claude-sonnet-5-5': { ...tok, cache_write_1h: 0 } }, prices);
  const lt1h = listCostTap({ 'claude-sonnet-5-5': { ...tok, cache_write_1h: 4000 } }, prices);
  check('tap and tool cost use the same formula', lc === lt && lc !== null, `${lc} vs ${lt}`);
  check('1 hour cache writes cost more than 5 minute ones', lt1h !== null && lt !== null && lt1h > lt, `${lt} vs ${lt1h}`);
  const u = { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
  foldAnthropicUsage(u, { input_tokens: 5, cache_creation_input_tokens: 70, cache_read_input_tokens: 9, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 50 } });
  foldAnthropicUsage(u, { output_tokens: 33 });
  check('tap usage parse (message_start then message_delta)', u.input === 5 && u.cache_write === 70 && u.cache_write_1h === 50 && u.output === 33, JSON.stringify(u));
  check('served id: dated and neu/ ids match, another model does not', servedMatches('A', 'claude-sonnet-5-5', ['claude-sonnet-5-5-20261001']) && servedMatches('B', 'neu/claude-sonnet-5-5', ['claude-sonnet-5-5']) && !servedMatches('B', 'claude-sonnet-5-5', ['claude-opus-5-5']));

  // 11. the tap passes streams through and counts them
  const mock = startMockUpstream({ servedModel: (m) => (m === 'claude-opus-5-5' ? 'claude-sonnet-5-5' : m) });
  const tap = new Tap(mock.url, 0);
  tap.start();
  tap.begin('rtap01', { prompt: 'hello there', probe });
  for (const stream of [true, false]) {
    const res = await fetch(`${tap.url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, stream, tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }] }) });
    await res.text();
  }
  const r3 = await fetch(`${tap.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] }) });
  await r3.text();
  const recs = await tap.end();
  const sum = summarizeTap(recs, 'claude-sonnet-5-5');
  const want = 3 * (MOCK_USAGE.input + MOCK_USAGE.output + MOCK_USAGE.cache_read + MOCK_USAGE.cache_write);
  const got = sum.tokens ? sum.tokens.input + sum.tokens.output + sum.tokens.cache_read + sum.tokens.cache_write : 0;
  check('tap counts streamed and plain responses', got === want, `${got} of ${want} tokens over ${recs.length} requests`);
  check('tap sees the prompt in the first request', sum.prompt_found === true);
  check('tap records the served model id (a swapped model shows)', JSON.stringify(sum.models_served['claude-opus-5-5']) === '["claude-sonnet-5-5"]', JSON.stringify(sum.models_served));
  tap.stop();
  mock.stop();
}

// ---------------------------------------------------------------------------
// end to end: both real harnesses against a fake model, through the tap
// ---------------------------------------------------------------------------

function probeOutput(bodyText: string): string {
  try {
    const body = JSON.parse(bodyText);
    for (const m of body.messages ?? []) for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join('\n');
  } catch {
    /* ignore */
  }
  return '';
}

function section(out: string, name: string): string {
  const i = out.indexOf(`--- ${name}`);
  if (i < 0) return '';
  const rest = out.slice(i + name.length + 4);
  const j = rest.indexOf('\n--- ');
  return j < 0 ? rest : rest.slice(0, j);
}

async function e2eChecks(): Promise<void> {
  const flags = await detectClaudeFlags();
  if (!flags) {
    check('e2e: claude on PATH', false, 'claude not found; the e2e part needs Claude Code');
    return;
  }
  if (!existsSync(join(REPO_DIR, 'packages', 'cli', 'src', 'index.ts'))) {
    check('e2e: Conclave source', false, 'packages/cli not found');
    return;
  }
  const mock = startMockUpstream({});
  const tap = new Tap(mock.url, 0, join(scratch, 'tap.jsonl'));
  tap.start();
  const t = fakeTask(join(scratch, 'e2e-task'));
  const work = join(scratch, 'e2e-work');
  const prompt = 'You are working in the repository in the current directory.\n\nLook around and report.\n\nRules for this task:\n- End your reply with one line, exactly "RESULT: DONE" or "RESULT: NOT DONE".';
  const probe: LeakProbe = { markers: leakMarkers([STATE_DIR]), canaries: [] };
  const hubPort = 17000 + (process.pid % 2000);
  const seen: Record<string, { home: string; out: string; tools: string[]; sum: ReturnType<typeof summarizeTap>; toolTokens: number | null; stragglers: string[] }> = {};
  for (const arm of ['A', 'B'] as ArmId[]) {
    const runId = arm === 'A' ? 'raaaaa' : 'rbbbbb';
    const privateDir = join(scratch, 'private', runId);
    const runDir = join(scratch, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const wc = await makeWorkCopy(t, work, runId, privateDir);
    const env = await baseEnv(['127.0.0.1'], wc.home);
    const before = mock.requests.length;
    const out = await runArm({
      arm,
      runId,
      model: 'claude-sonnet-5-5',
      smallModel: 'claude-haiku-5-5',
      prompt,
      copy: wc.repo,
      home: wc.home,
      runDir,
      limitS: 120,
      env,
      conclaveSrc: REPO_DIR,
      hubOptions: arm === 'A' ? { src: REPO_DIR, port: hubPort, model: 'claude-sonnet-5-5', smallModel: 'claude-haiku-5-5', proxyBaseUrl: tap.url, arms: ['A', 'B'] } : null,
      tap,
      probe,
      claudeFlags: flags,
      transport: 'proxy',
      proxy: { baseUrl: mock.url, apiKey: 'sk-mock-key' },
      matchEffort: null,
      tokenCap: 1_000_000,
      dryRun: false,
    });
    const stragglers = await killStragglers(wc.root);
    const reqs = mock.requests.slice(before);
    const mainReqs = reqs.filter((r) => r.tools.length > 0);
    const second = mainReqs.find((r) => probeOutput(r.bodyText));
    const sum = summarizeTap(out.tap ?? [], 'claude-sonnet-5-5');
    const toolTok = out.norm.tokens ? out.norm.tokens.input + out.norm.tokens.output + out.norm.tokens.cache_read + out.norm.tokens.cache_write : null;
    seen[arm] = { home: wc.home, out: second ? probeOutput(second.bodyText) : '', tools: mainReqs[0]?.tools ?? [], sum, toolTokens: toolTok, stragglers };
    check(`e2e ${arm}: ran and answered`, /RESULT: DONE/.test(out.norm.finalText ?? ''), `exit ${out.proc.exitCode}, status ${out.norm.status}, ${reqs.length} model calls${out.hub?.error ? `, hub: ${out.hub.error}` : ''}`);
    check(`e2e ${arm}: every model call went through the tap`, (out.tap?.filter((r) => /\/v1\/messages$/.test(r.path)).length ?? -1) === reqs.length, `${out.tap?.length ?? 0} tap records, ${reqs.length} at the API`);
    check(`e2e ${arm}: prompt reached the model byte for byte`, sum.prompt_found === true);
    check(`e2e ${arm}: no denied tool offered`, forbiddenOffered(seen[arm].tools).length === 0, forbiddenOffered(seen[arm].tools).join(', ') || `${seen[arm].tools.length} tools`);
    check(`e2e ${arm}: tap tokens equal the tool's own count`, sum.tokens !== null && toolTok !== null && toolTok === sum.tokens.input + sum.tokens.output + sum.tokens.cache_read + sum.tokens.cache_write, `tap ${sum.tokens ? sum.tokens.input + sum.tokens.output + sum.tokens.cache_read + sum.tokens.cache_write : 'n/a'}, tool ${toolTok}`);
    const o = seen[arm].out;
    check(`e2e ${arm}: agent works in its own repo with its own HOME`, o.includes(`PWD=${wc.repo}`) && o.includes(`HOME=${wc.home}`), o.split('\n').slice(0, 2).join(' | '));
    const envSec = section(o, 'env');
    const benchInEnv = benchPathsIn(envSec.split('\n'));
    check(`e2e ${arm}: no bench or state path in what the agent's shell sees in env`, !benchInEnv.length, benchInEnv.slice(0, 3).join(' | ') || 'clean');
    const parent = section(o, 'parent');
    const grand = section(o, 'grandparent');
    const names = (s: string) => s.split('\n').map((l) => l.trim().split(/\s+/).pop() ?? '').filter((x) => x && x !== '.' && x !== '..' && !/^total$/.test(x) && !/^\d+$/.test(x));
    check(`e2e ${arm}: parent folder holds only repo and home`, names(parent).every((n) => n === 'repo' || n === 'home'), names(parent).join(', '));
    check(`e2e ${arm}: no other run beside this one`, names(grand).every((n) => n === runId), names(grand).join(', '));
    const psSec = section(o, 'ps');
    // other bench commands running at the same time (a validate, a dry run) put hidden paths in ps; that is the machine, not the kit
    const busy = foreignBenchProcesses(probe.markers);
    if (busy.length) check(`e2e ${arm}: process list (skipped)`, true, `other bench processes are running (${busy.length}, e.g. ${busy[0].slice(0, 80)}); run the e2e check on a quiet machine`);
    else check(`e2e ${arm}: no hidden path in the process list`, !probe.markers.some((m) => psSec.includes(m)), psSec.includes(BENCH_DIR) ? 'the bench path shows (the runner was started with an absolute path); not a leak by itself' : 'clean');
    check(`e2e ${arm}: background process killed after the run`, stragglers.some((s) => s.includes('sleep 600')) || !existsSync('/proc'), stragglers.join('; ') || 'none found');
    const leaked = isLeak({ markerInCalls: sum.leak.marker_in_calls, markerInResults: sum.leak.marker_in_results, canaryLines: sum.leak.canary_lines });
    if (busy.length && leaked) check(`e2e ${arm}: leak scan saw the other bench processes in ps (expected on a busy machine)`, sum.leak.marker_in_results.length > 0, JSON.stringify(sum.leak));
    else check(`e2e ${arm}: no leak flagged on a clean run`, !leaked, JSON.stringify(sum.leak));
    retireWorkCopy(wc, runDir, privateDir);
  }
  check('e2e: the two runs had different homes', seen.A?.home !== seen.B?.home);
  // what each harness sends: shown, not judged (these are the shipped defaults)
  for (const arm of ['A', 'B']) {
    const s = seen[arm]?.sum;
    if (!s) continue;
    check(`e2e ${arm}: sent settings (info)`, true, `max_tokens ${s.max_tokens.join(',')}, thinking ${s.thinking.join(',')}, effort ${s.effort.join(',')}, system ${s.first_main?.system_chars ?? 'n/a'} chars, ${s.tools_offered.length} tools: ${s.tools_offered.join(' ')}`);
  }
  tap.stop();
  mock.stop();
}

export async function runParity(opts: { e2e: boolean }): Promise<number> {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    await fastChecks();
    if (opts.e2e) await e2eChecks();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const r of results) process.stderr.write(`[parity] ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `: ${r.detail}` : ''}\n`);
  const bad = results.filter((r) => !r.ok).length;
  process.stderr.write(`[parity] ${results.length - bad} of ${results.length} checks pass\n`);
  return bad ? 1 : 0;
}

if (import.meta.main) {
  runParity({ e2e: process.argv.includes('--e2e') }).then((c) => process.exit(c));
}
