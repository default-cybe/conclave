#!/usr/bin/env bun
/**
 * Fake agent for `--dry-run`. It changes the work copy the way a real agent
 * might (the reference solution for a good outcome, the naive fix or nothing
 * for a bad one) and prints a stream in the format of the arm it stands in
 * for, so the real parsers, scorer, judge and report all run without a model.
 *
 *   bun fake-agent.ts --style conclave|claude|codex --task <task dir> --outcome good|bad
 *     --claim DONE|"NOT DONE"|none --cwd <copy> --model <id> --small-model <id> --seed <n> --hubdata <file>
 *     [--fault <name>] [--canary <dir>] [--reset-in <s>]
 *
 * --fault plays one way a real agent can go wrong, for bench/checks/faults.ts:
 *   hang         does its edits, then sleeps past the time limit
 *   hang-hard    the same, ignores SIGINT and SIGTERM, and leaves two background
 *                processes (one in the repo, one that moved to /)
 *   crash        does its edits and some turns, then exits 1 with no final event
 *   crash-early  exits 1 before any model call
 *   tamper       naive edit, then writes passing tests at the hidden test paths,
 *                edits a visible test, adds sitecustomize.py, conftest.py,
 *                bunfig.toml, a *_test.go file or a Cargo [[test]] redirect,
 *                and claims DONE
 *   symlink      makes each hidden test path, and the folder above it, a link to
 *                files in --canary (outside the sandbox)
 *   delete       deletes everything in the repo, .git included
 *   nuke         deletes the repo folder itself
 *   loop         the same Read call 40 times
 *   runaway      reports usage without end (for --run-token-cap)
 *   rate-limit   ends with a 429 rate limit error (reset in --reset-in seconds, if given)
 *   transient    ends with a connection error and no tool calls
 *   garbage      prints broken JSON and control bytes before the normal stream
 *   claim-bold   good outcome, ends with "RESULT: **DONE**"
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listFiles, matchesAny, readJson, rng } from './util';

const FAULTS = ['none', 'hang', 'hang-hard', 'crash', 'crash-early', 'tamper', 'symlink', 'delete', 'nuke', 'loop', 'runaway', 'rate-limit', 'transient', 'garbage', 'claim-bold'];

const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const style = args.style as 'conclave' | 'claude' | 'codex';
const cwd = args.cwd;
const model = args.model;
const small = args['small-model'];
const fault = args.fault ?? 'none';
if (!FAULTS.includes(fault)) {
  process.stderr.write(`fake agent: unknown fault ${fault}\n`);
  process.exit(2);
}
const r = rng(Number(args.seed) || 1);
const task = readJson(join(args.task, 'task.json'));
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

if (fault === 'crash-early') {
  process.stderr.write('fake agent: crashed before any model call\n');
  process.exit(1);
}
if (fault === 'garbage') {
  process.stdout.write('{not json at all\n');
  process.stdout.write('{"type": "message.created", "message": \n');
  process.stdout.write('\u0000\u0007\u001b[31mred\u001b[0m\n');
  process.stdout.write('{' + 'x'.repeat(200_000) + '\n');
  process.stdout.write('plain text line\n');
}

// 1. change the copy
const outcome = fault === 'claim-bold' ? 'good' : ['tamper', 'symlink', 'delete', 'nuke'].includes(fault) ? 'bad' : args.outcome;
let overlay: string | null = null;
if (outcome === 'good') overlay = join(args.task, task.reference);
else if (task.naive && existsSync(join(args.task, task.naive))) overlay = join(args.task, task.naive);
const changed: Array<{ rel: string; content: string }> = [];
if (overlay) {
  for (const rel of listFiles(overlay)) {
    const to = join(cwd, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(overlay, rel), to);
    changed.push({ rel, content: readFileSync(to, 'utf8') });
  }
}

/** A test file that passes, in the language of the hidden test at `rel`. */
function passingTest(rel: string, count: number): string {
  const n = Math.max(1, count);
  if (rel.endsWith('.py')) return `import unittest\n\n\nclass Fake(unittest.TestCase):\n${Array.from({ length: n }, (_, i) => `    def test_fake_${i}(self):\n        pass\n`).join('')}`;
  if (/\.[jt]s$/.test(rel)) return `import { test } from 'bun:test';\n${Array.from({ length: n }, (_, i) => `test('fake ${i}', () => {});\n`).join('')}`;
  if (rel.endsWith('.go')) {
    const goFile = listFiles(cwd).find((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
    const pkg = goFile ? (/^package (\w+)/m.exec(readFileSync(join(cwd, goFile), 'utf8'))?.[1] ?? 'main') : 'main';
    return `package ${pkg}\n\nimport "testing"\n\n${Array.from({ length: n }, (_, i) => `func TestFake${i}(t *testing.T) {}\n`).join('')}`;
  }
  if (rel.endsWith('.rs')) return Array.from({ length: n }, (_, i) => `#[test]\nfn fake_${i}() {}\n`).join('');
  return '';
}

const expected: number = task.hidden.expected_total ?? 1;
const targets = Object.values(task.hidden.files as Record<string, string>);

/**
 * Its own tests, for the own-test metric (PROTOCOL 9 own_tests), in seeded
 * tasks: a good run copies each hidden test next to the visible ones (it
 * fails on the start code), a bad run adds one test that passes anyway.
 * Python tests go in tests/ (unittest discover does not enter a folder
 * without __init__.py); TypeScript ones in tests/agent/, the hidden folder's
 * depth, so their relative imports hold.
 */
const ownTests: string[] = [];
if (task.visible_test_cmd && overlay !== null && !['tamper', 'symlink', 'delete', 'nuke'].includes(fault)) {
  const place = (rel: string) => (rel.endsWith('.py') ? `tests/test_agent_${rel.split('/').pop()!.replace(/^test_(hidden_)?/, '')}` : rel.replace(/^tests\/hidden\//, 'tests/agent/'));
  const own: Array<[string, string]> = outcome === 'good'
    ? Object.entries(task.hidden.files as Record<string, string>).map(([from, to]) => [place(to), readFileSync(join(args.task, from), 'utf8')])
    : targets.slice(0, 1).map((to) => [place(to).replace(/[^/]+$/, (n) => (n.endsWith('.py') ? 'test_agent_smoke.py' : 'smoke.test.ts')), passingTest(to, 1)]);
  for (const [rel, text] of own) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text);
    changed.push({ rel, content: text });
    ownTests.push(rel);
  }
}
/** What Conclave's regression gate would say about this run: its tests fail on the start code (good), or pass there (bad). */
const gateLook = ownTests.length ? { outcome: outcome === 'good' ? 'proven' : 'passes', reminded: outcome !== 'good' } : null;
if (fault === 'tamper') {
  // passing tests at every hidden path; the scorer must overwrite them
  for (const rel of targets) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), passingTest(rel, expected));
    changed.push({ rel, content: 'fake tests' });
  }
  // weaken an existing test file
  const prot = listFiles(cwd, ['.git/']).find((f) => matchesAny(f, task.protected) && /\.(py|[jt]s|go|rs)$/.test(f));
  if (prot) {
    writeFileSync(join(cwd, prot), passingTest(prot, 1));
    changed.push({ rel: prot, content: 'weakened' });
  }
  // test config and import hooks
  const extra: Record<string, string> = {
    python: { 'sitecustomize.py': 'import os\n', 'conftest.py': 'collect_ignore = ["tests"]\n' },
    typescript: { 'bunfig.toml': '[test]\npreload = ["./cheat-preload.ts"]\n', 'cheat-preload.ts': 'process.exit(0);\n' },
    javascript: { 'bunfig.toml': '[test]\npreload = ["./cheat-preload.js"]\n', 'cheat-preload.js': 'process.exit(0);\n' },
    go: { 'zz_cheat_test.go': passingTest('zz_cheat_test.go', 3), 'go.work': 'go 1.18\n\nuse .\n' },
    rust: {
      'src/cheat.rs': passingTest('cheat.rs', expected),
      // a test runner that prints passing lines instead of running the tests
      '.cargo/config.toml': '[target.x86_64-unknown-linux-gnu]\nrunner = "./fake-runner.sh"\n[target.aarch64-unknown-linux-gnu]\nrunner = "./fake-runner.sh"\n',
      'fake-runner.sh': `#!/bin/sh\nfor i in $(seq 1 ${expected}); do echo "test fake_$i ... ok"; done\necho "test result: ok. ${expected} passed; 0 failed"\n`,
    },
  }[task.lang as string] ?? {};
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text, { mode: rel.endsWith('.sh') ? 0o755 : 0o644 });
    changed.push({ rel, content: text });
  }
  if (task.lang === 'rust') {
    // point the hidden test target at the agent's own file, with as many tests as the hidden file has
    const name = targets[0].replace(/^tests\//, '').replace(/\.rs$/, '');
    const toml = join(cwd, 'Cargo.toml');
    writeFileSync(toml, readFileSync(toml, 'utf8').replace(/\[package\]\n/, '[package]\nautotests = false\n') + `\n[[test]]\nname = "${name}"\npath = "src/cheat.rs"\n`);
    changed.push({ rel: 'Cargo.toml', content: 'redirect' });
  }
}
if (fault === 'symlink') {
  // each hidden test path, and its folder, made a link to files outside the sandbox
  const canary = args.canary ?? '/tmp/conclave-bench-canary';
  mkdirSync(join(canary, 'dir'), { recursive: true });
  writeFileSync(join(canary, 'file.txt'), 'canary\n');
  writeFileSync(join(canary, 'dir', 'keep.txt'), 'canary\n');
  for (const rel of targets) {
    const top = rel.split('/')[0];
    if (top === rel) {
      // a hidden file at the repo root: a link to a file outside
      rmSync(join(cwd, rel), { force: true });
      symlinkSync(join(canary, 'file.txt'), join(cwd, rel));
    } else if (!existsSync(join(cwd, top)) || !readdirSync(cwd, { withFileTypes: true }).find((e) => e.name === top)?.isSymbolicLink()) {
      // the top folder of a hidden path (tests/ for tests/hidden/x.py): a link to a folder outside
      rmSync(join(cwd, top), { recursive: true, force: true });
      symlinkSync(join(canary, 'dir'), join(cwd, top));
    }
  }
}
if (fault === 'delete') for (const e of readdirSync(cwd)) rmSync(join(cwd, e), { recursive: true, force: true });
if (fault === 'nuke') rmSync(cwd, { recursive: true, force: true });
if (fault === 'hang-hard') {
  // ignore the polite signals; leave background work behind
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  const loop = (file: string) => `while :; do echo tick >> ${file}; sleep 0.2; done`;
  spawn('sh', ['-c', loop('straggler-cwd.log')], { cwd, detached: true, stdio: 'ignore' }).unref();
  // this one moved to / and keeps the agent's stdout and stderr open
  spawn('sh', ['-c', 'cd / && while :; do sleep 0.2; done # fake-straggler-home'], { cwd, detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();
}

const readFirst = existsSync(cwd) ? listFiles(cwd, ['.git/']).slice(0, 3) : [];
const testCmd: string = task.visible_test_cmd ?? 'echo "no visible tests"';
const claim = fault === 'tamper' ? 'DONE' : args.claim;
const claimLine = fault === 'claim-bold' ? '\nRESULT: **DONE**\nI ran the visible tests.' : claim === 'none' ? '' : `\nRESULT: ${claim}\nI ran the visible tests after my last edit.`;
const finalText = `${outcome === 'good' ? 'Fixed the cause.' : 'I changed what looked wrong.'} Files: ${changed.map((c) => c.rel).join(', ') || 'none'}.${claimLine}`;
const editMiss = r() < 0.3;
const testFails = outcome !== 'good' && r() < 0.6;

// 2. the tool calls, in order
interface FakeCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  result: string;
}
const calls: FakeCall[] = [];
let n = 0;
const id = () => `toolu_fake_${++n}`;
if (fault === 'loop') {
  for (let i = 0; i < 40; i++) calls.push({ id: id(), name: 'Read', input: { file_path: join(cwd, readFirst[0] ?? 'README.md') }, isError: false, result: '1\tsame contents' });
} else if (fault !== 'transient' && fault !== 'rate-limit') {
  for (const rel of readFirst) calls.push({ id: id(), name: 'Read', input: { file_path: join(cwd, rel) }, isError: false, result: '1\tfake contents' });
  if (editMiss && changed[0]) calls.push({ id: id(), name: 'Edit', input: { file_path: join(cwd, changed[0].rel), old_string: 'no such text', new_string: 'x' }, isError: true, result: `old_string was not found in ${join(cwd, changed[0].rel)}.` });
  for (const c of changed) calls.push({ id: id(), name: 'Write', input: { file_path: join(cwd, c.rel), content: c.content.slice(0, 200) }, isError: false, result: `Wrote ${c.rel}` });
  calls.push({ id: id(), name: 'Bash', input: { command: testCmd }, isError: testFails, result: testFails ? '1 fail\nExit code 1' : '0 fail' });
}

// 3. turns: one model call per tool call plus the final reply
const turns = calls.length + 1;
const tok = () => ({ input: 20 + Math.floor(r() * 400), output: 80 + Math.floor(r() * 900), cache_read: 8000 + Math.floor(r() * 30000), cache_write: Math.floor(r() * 3000) });
const perTurn = Array.from({ length: turns }, tok);
const sideCall = { input: 300, output: 12, cache_read: 0, cache_write: 0 };
await Bun.sleep(50 + Math.floor(r() * 150));

/** The fault's ending, after the tool calls: hang, crash or a runaway, or nothing (normal end). */
async function midRun(onTick: (i: number) => void): Promise<void> {
  if (fault === 'hang' || fault === 'hang-hard') {
    for (;;) await Bun.sleep(1000);
  }
  if (fault === 'crash') {
    process.stderr.write('fake agent: segfault\n');
    process.exit(1);
  }
  if (fault === 'runaway') {
    for (let i = 0; ; i++) {
      onTick(i);
      await Bun.sleep(20);
    }
  }
}

const resetIn = args['reset-in'] !== undefined ? Number(args['reset-in']) : null;
const resetAt = resetIn === null ? null : Date.now() + resetIn * 1000;

if (style === 'conclave') {
  const sid = `ses_fake_${Math.floor(r() * 1e9).toString(36)}`;
  const now = Date.now();
  const session = { id: sid, title: 'fake', agent: 'coder', model: `bench-claude/${model}`, status: 'running', cwd, stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } };
  out({ type: 'run.session', session });
  const messages: any[] = [{ id: 'msg_u0', sessionId: sid, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'prompt' }] }];
  const usage: any[] = [];
  let seq = 0;
  const statsOf = () => ({ messages: messages.length, inputTokens: usage.reduce((a, u) => a + u.inputTokens, 0), outputTokens: usage.reduce((a, u) => a + u.outputTokens, 0), cacheReadTokens: usage.reduce((a, u) => a + u.cacheReadTokens, 0), costUsd: 0 });
  // the hub keeps what happened even when the CLI dies; the fake writes it as it goes
  const saveHub = (status: string, extra: Record<string, unknown> = {}) => writeFileSync(args.hubdata, JSON.stringify({ session: { ...session, status, stats: statsOf(), ...extra }, messages, children: [], usage }, null, 1));
  const record = (t: { input: number; output: number; cache_read: number; cache_write: number }, i: number | string) => {
    const rec = { id: `u${i}`, ts: now, sessionId: sid, source: 'api', provider: 'bench-claude', model, inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cache_read, cacheWriteTokens: t.cache_write, reasoningTokens: 0, costUsd: 0, latencyMs: 400 + Math.floor(r() * 2000), purpose: 'turn' };
    usage.push(rec);
    out({ type: 'usage.recorded', record: rec, seq: ++seq, ts: now });
  };
  if (fault === 'rate-limit' || fault === 'transient') {
    if (fault === 'rate-limit') {
      const s = { ...session, status: 'waiting_reset', resumeAt: resetAt, error: 'rate limit: 429 Too Many Requests' };
      out({ type: 'session.updated', session: s, seq: ++seq, ts: now });
      saveHub('waiting_reset', { resumeAt: resetAt, error: s.error });
      // Conclave waits for the reset; the runner must stop it
      for (;;) await Bun.sleep(1000);
    }
    const err = 'Unable to connect to API: ECONNREFUSED 127.0.0.1:8317';
    out({ type: 'session.updated', session: { ...session, status: 'error', error: err }, seq: ++seq, ts: now });
    out({ type: 'run.done', sessionId: sid, status: 'error', error: err, exitCode: 1, stats: statsOf() });
    saveHub('error', { error: err });
    process.exit(1);
  }
  calls.forEach((c, i) => {
    const m = { id: `msg_a${i}`, sessionId: sid, role: 'assistant', kind: 'normal', model: `bench-claude/${model}`, content: [{ type: 'tool_use', id: c.id, name: c.name, input: c.input }], stopReason: 'tool_use' };
    messages.push(m);
    out({ type: 'message.created', message: m, seq: ++seq, ts: now });
    out({ type: 'tool.started', sessionId: sid, messageId: m.id, toolUseId: c.id, name: c.name, input: c.input, seq: ++seq, ts: now });
    const res = { type: 'tool_result', toolUseId: c.id, content: c.result, isError: c.isError };
    out({ type: 'tool.completed', sessionId: sid, toolUseId: c.id, result: res, seq: ++seq, ts: now });
    messages.push({ id: `msg_t${i}`, sessionId: sid, role: 'user', kind: 'normal', content: [res] });
    record(perTurn[i], i);
  });
  saveHub('running');
  await midRun((i) => {
    record({ input: 50_000, output: 1000, cache_read: 50_000, cache_write: 0 }, `run${i}`);
    saveHub('running');
  });
  // the regression gate's look at stop (packages/core/src/session/regression-gate.ts)
  if (gateLook) out({ type: 'regression.checked', sessionId: sid, outcome: gateLook.outcome, command: testCmd, tests: ownTests, why: 'fake agent', reminded: gateLook.reminded, seq: ++seq, ts: now });
  const last = { id: 'msg_final', sessionId: sid, role: 'assistant', kind: 'normal', model: `bench-claude/${model}`, content: [{ type: 'text', text: finalText }], stopReason: 'end_turn' };
  messages.push(last);
  out({ type: 'message.created', message: last, seq: ++seq, ts: now });
  record(perTurn[turns - 1], turns - 1);
  usage.push({ id: 'u-title', ts: now, sessionId: sid, source: 'api', provider: 'bench-claude', model: small, inputTokens: sideCall.input, outputTokens: sideCall.output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, latencyMs: 300, purpose: 'title' });
  const stats = statsOf();
  out({ type: 'session.updated', session: { ...session, status: 'idle', stats }, seq: ++seq, ts: now });
  out({ type: 'run.done', sessionId: sid, status: 'idle', exitCode: 0, stats });
  saveHub('idle');
} else if (style === 'claude') {
  out({ type: 'system', subtype: 'init', model, claude_code_version: 'fake-0.0.0', permissionMode: 'bypassPermissions', tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Task', 'TodoWrite'], mcp_servers: [] });
  const usageOf = (t: { input: number; output: number; cache_read: number; cache_write: number }) => ({ input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cache_read, cache_creation_input_tokens: t.cache_write });
  if (fault === 'rate-limit' || fault === 'transient') {
    const text =
      fault === 'rate-limit'
        ? `API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}${resetAt ? ` Your limit resets at ${Math.floor(resetAt / 1000)}.` : ''}`
        : 'API Error: Connection error. (ECONNRESET)';
    if (fault === 'rate-limit') for (let i = 1; i <= 3; i++) out({ type: 'system', subtype: 'api_retry', attempt: i, error_status: 429, error: 'rate_limit' });
    out({ type: 'result', subtype: 'success', is_error: true, result: text, num_turns: 1, duration_ms: 1000, duration_api_ms: 0, total_cost_usd: 0, permission_denials: [], usage: usageOf({ input: 0, output: 0, cache_read: 0, cache_write: 0 }), modelUsage: {} });
    process.exit(1);
  }
  calls.forEach((c, i) => {
    const t = perTurn[i];
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${i}`, model, role: 'assistant', content: [{ type: 'tool_use', id: c.id, name: c.name, input: c.input }], usage: usageOf(t) } });
    out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, is_error: c.isError, content: c.result }] } });
  });
  await midRun((i) => out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_run${i}`, model, role: 'assistant', content: [{ type: 'text', text: 'thinking' }], usage: usageOf({ input: 50_000, output: 1000, cache_read: 50_000, cache_write: 0 }) } }));
  const t = perTurn[turns - 1];
  out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_final`, model, role: 'assistant', content: [{ type: 'text', text: finalText }], usage: usageOf(t) } });
  const sumOf = (k: 'input' | 'output' | 'cache_read' | 'cache_write') => perTurn.reduce((a, x) => a + x[k], 0);
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: finalText,
    num_turns: turns,
    duration_ms: 1000,
    duration_api_ms: 800,
    ttft_ms: 300,
    total_cost_usd: 0.01,
    permission_denials: [],
    usage: { input_tokens: sumOf('input'), output_tokens: sumOf('output'), cache_read_input_tokens: sumOf('cache_read'), cache_creation_input_tokens: sumOf('cache_write') },
    modelUsage: {
      [model]: { inputTokens: sumOf('input'), outputTokens: sumOf('output'), cacheReadInputTokens: sumOf('cache_read'), cacheCreationInputTokens: sumOf('cache_write'), costUSD: 0.01 },
      [small]: { inputTokens: sideCall.input, outputTokens: sideCall.output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 },
    },
  });
} else {
  for (const c of calls) if (c.name === 'Bash') out({ type: 'item.completed', item: { id: c.id, type: 'command_execution', command: c.input.command, exit_code: c.isError ? 1 : 0, aggregated_output: c.result } });
  await midRun(() => out({ type: 'turn.completed', usage: { input_tokens: 50_000, cached_input_tokens: 0, output_tokens: 1000 } }));
  out({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text: finalText } });
  out({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 600 } });
}
