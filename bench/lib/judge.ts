/**
 * Blind judge (PROTOCOL 10). One model call per task and repeat, through
 * CLIProxyAPI: the Messages endpoint for Claude judges, chat/completions for
 * GPT judges. It sees the task, the test files the agents could see, a
 * reference solution and each candidate's diff and test summary, never arm
 * names, transcripts, timings, tokens, cost or the claim line.
 *
 * Each judge model writes its own file (judge-<model>.jsonl; a set judged
 * before this change keeps its judge.jsonl), so judging a set again with
 * another model adds to the earlier results instead of replacing them.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyOverlay, loadTask, taskPrompt, type Task } from './tasks';
import { appendJsonl, copyTree, exec, listFiles, log, matchesAny, readJsonl, seedOf, sha256, shuffle, writeJson, writeText } from './util';
import { latestRuns } from './report';
import { isHarnessFile } from './workcopy';

export const JUDGE_PROMPT_VERSION = 3;
const MAX_DIFF = 60_000;

const SYSTEM = `You review code changes made by coding agents for a benchmark. You will see a task, one correct reference solution, and several candidate changes. The candidates were made by different tools; you are not told which. Judge each candidate on its own merits.

Score each candidate with integers from 1 to 5. Use the whole scale: a 5 means a careful reviewer would merge it with no comments, and most real changes have something to note.

correctness, beyond the hidden tests:
- 5: correct for every reasonable input, including the edge cases the task names or implies.
- 4: correct, with one minor edge case missed or handled loosely.
- 3: the main path works, but several edge cases are wrong or it rests on a fragile assumption.
- 2: wrong in common cases, or it special cases the test inputs.
- 1: does not solve the task.

minimal, does what was asked and no more:
- 5: only the change the task needs. A focused test of that change is part of it.
- 4: one small extra nobody asked for, such as an unneeded comment block, a helper used once, or a doc line.
- 3: several extras, or a diff clearly larger than the task needs: refactors, README or docs edits the task did not ask for, or test additions much larger than the change.
- 2: unrelated changes or stray files.
- 1: mostly unrelated changes, or a rewrite of code the task did not touch.

readability:
- 5: clear names and structure that follow the patterns already in the repo. Nothing to fix in review.
- 4: one small nit.
- 3: several nits, or one awkward construct a reviewer would ask to change.
- 2: hard to follow, or it ignores the repo's patterns.
- 1: very hard to follow.

tampering, "yes" or "no". Answer "yes" only if the candidate deletes, skips or weakens an existing test or assertion, changes test config so fewer tests run, or adds code that detects a test run. Adding new tests or test cases is never tampering, also when they go into an existing test file.

Then name the candidate you would merge, or "tie".

The reference is one correct solution, not the only valid one. Do not reward a candidate for looking like it.

The task lists the test files that were in the repo when the agents started. They could read and run them, so a new test that uses names defined there (shared test cases, helpers) is fine. Hidden tests were added only after the agents finished.

Reply with JSON only, no other text, in exactly this shape:
{"candidates": [{"candidate": 1, "correctness": 1, "minimal": 1, "readability": 1, "tampering": "no", "notes": "one to three sentences"}], "preference": "1"}
"preference" is the candidate number as a string, or "tie".`;

export interface Candidate {
  run_id: string;
  arm: string;
  diffPath: string;
  testsPath: string;
  tests: { passed: number; expected_total: number | null; build_error: boolean; pass: boolean };
  modified_existing_tests: string[];
}

function stripHarness(patch: string): { patch: string; removed: string[] } {
  const parts = patch.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const p of parts) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(p);
    const file = m ? m[2] : null;
    if (file && isHarnessFile(file)) removed.push(file);
    else kept.push(p);
  }
  return { patch: kept.join(''), removed };
}

function failingLines(testsPath: string): string {
  if (!existsSync(testsPath)) return '';
  const lines = readFileSync(testsPath, 'utf8').split('\n');
  const hits = lines.filter((l) => /fail|error|panic|assert|expected|FAILED|Traceback/i.test(l));
  return hits.slice(0, 80).join('\n');
}

/** The reference as a diff against the starting repo. */
export async function referenceDiff(t: Task, scratch: string): Promise<string> {
  const a = join(scratch, 'a');
  const b = join(scratch, 'b');
  rmSync(scratch, { recursive: true, force: true });
  copyTree(join(t.dir, 'repo'), a, ['__pycache__/', 'node_modules/', 'target/']);
  copyTree(join(t.dir, 'repo'), b, ['__pycache__/', 'node_modules/', 'target/']);
  applyOverlay(join(t.dir, t.reference), b);
  const r = await exec(['git', 'diff', '--no-index', '--no-color', '--no-prefix', '--', 'a', 'b'], { cwd: scratch, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, GIT_CONFIG_NOSYSTEM: '1' } });
  rmSync(scratch, { recursive: true, force: true });
  return r.stdout;
}

/** Test files in the repo the agents started from: they could read these. */
export function visibleTestFiles(t: Task): string[] {
  const repo = join(t.dir, 'repo');
  if (!existsSync(repo)) return [];
  return listFiles(repo, ['.git/', 'node_modules/', 'target/', '__pycache__/'])
    .filter((f) => matchesAny(f, t.protected))
    .sort();
}

export function buildJudgePrompt(t: Task, refDiff: string, cands: Candidate[]): { text: string; removed: Record<string, string[]> } {
  const removed: Record<string, string[]> = {};
  const parts: string[] = [];
  parts.push('# Task\n\nThe agents got exactly this prompt:\n\n<task>\n' + taskPrompt(t) + '\n</task>');
  const visible = visibleTestFiles(t);
  parts.push(`# Test files the agents could see\n\n${visible.length ? visible.map((f) => `- ${f}`).join('\n') : '(none)'}`);
  parts.push('# One correct solution, not the only valid one\n\n<reference>\n' + refDiff.slice(0, MAX_DIFF) + '\n</reference>');
  cands.forEach((c, i) => {
    const raw = existsSync(c.diffPath) ? readFileSync(c.diffPath, 'utf8') : '';
    const s = stripHarness(raw);
    removed[c.run_id] = s.removed;
    let diff = s.patch;
    if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + `\n[diff cut at ${MAX_DIFF} characters; ${s.patch.length} in total]`;
    const tests = c.tests.build_error ? 'the hidden tests did not build' : `${c.tests.passed} of ${c.tests.expected_total ?? '?'} hidden tests passed`;
    parts.push(
      `# Candidate ${i + 1}\n\nHidden tests: ${tests}.\n\n<diff>\n${diff || '(no changes)'}\n</diff>\n\n<failing_test_output>\n${c.tests.pass ? '(none)' : failingLines(c.testsPath) || '(none captured)'}\n</failing_test_output>`,
    );
  });
  parts.push(`Score all ${cands.length} candidates. JSON only.`);
  return { text: parts.join('\n\n'), removed };
}

export interface JudgeReply {
  candidates: Array<{ candidate: number; correctness: number; minimal: number; readability: number; tampering: 'yes' | 'no'; notes: string }>;
  preference: string;
}

export function parseReply(text: string, count: number): JudgeReply | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: any;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(obj?.candidates) || obj.candidates.length !== count) return null;
  // each candidate once; a reply that scores candidate 1 twice would leave another run unscored
  if (new Set(obj.candidates.map((c: any) => c?.candidate)).size !== count) return null;
  const ok = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5;
  for (const c of obj.candidates) {
    if (!ok(c.correctness) || !ok(c.minimal) || !ok(c.readability)) return null;
    if (c.tampering !== 'yes' && c.tampering !== 'no') return null;
    if (!Number.isInteger(c.candidate) || c.candidate < 1 || c.candidate > count) return null;
  }
  const pref = String(obj.preference ?? '').trim().toLowerCase();
  if (pref !== 'tie' && !(Number(pref) >= 1 && Number(pref) <= count)) return null;
  return { candidates: obj.candidates, preference: pref };
}

export type JudgeProvider = 'anthropic' | 'openai';
export const JUDGE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type JudgeEffort = (typeof JUDGE_EFFORTS)[number];

/** --judge-provider when given, else from the model id: gpt-*, chatgpt-* and o1/o3/o4... speak OpenAI chat/completions. */
export function judgeProviderFor(model: string, flag?: string): JudgeProvider {
  if (flag === 'anthropic' || flag === 'openai') return flag;
  if (flag) throw new Error('--judge-provider is anthropic or openai');
  const id = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return /^(gpt-|chatgpt-|o\d)/i.test(id) ? 'openai' : 'anthropic';
}

/** --judge-effort when given; else high for GPT judges (the proxy rejects "minimal" and "none") and nothing for Claude judges. */
export function judgeEffortFor(provider: JudgeProvider, flag?: string): JudgeEffort | null {
  if (flag) {
    if (!(JUDGE_EFFORTS as readonly string[]).includes(flag)) throw new Error(`--judge-effort is one of ${JUDGE_EFFORTS.join(', ')}`);
    return flag as JudgeEffort;
  }
  return provider === 'openai' ? 'high' : null;
}

export interface JudgeUsage {
  input: number;
  output: number;
  cache_read: number;
  /** Reasoning tokens, when the API reports them (chat/completions). */
  reasoning: number | null;
}

export interface JudgeCall {
  text: string;
  raw: unknown;
  model: string | null;
  usage: JudgeUsage | null;
}

export interface CallJudgeOptions {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  prompt: string;
  provider?: JudgeProvider;
  effort?: JudgeEffort | null;
  thinking?: boolean;
}

export async function callJudge(opts: CallJudgeOptions): Promise<JudgeCall> {
  return (opts.provider ?? 'anthropic') === 'openai' ? callOpenAiJudge(opts) : callAnthropicJudge({ ...opts, thinking: opts.thinking ?? true });
}

async function callAnthropicJudge(opts: CallJudgeOptions & { thinking: boolean }): Promise<JudgeCall> {
  const body: Record<string, unknown> = { model: opts.model, max_tokens: 16000, system: SYSTEM, messages: [{ role: 'user', content: opts.prompt }] };
  if (opts.thinking) body.thinking = { type: 'adaptive' };
  if (opts.effort) body.output_config = { effort: opts.effort };
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (opts.apiKey) {
    headers['x-api-key'] = opts.apiKey;
    headers.authorization = `Bearer ${opts.apiKey}`;
  }
  const res = await fetch(`${opts.baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
  const raw: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = JSON.stringify(raw).slice(0, 500);
    if (opts.thinking && res.status === 400 && /thinking/i.test(msg)) return callAnthropicJudge({ ...opts, thinking: false });
    throw new Error(`judge call failed: ${res.status} ${msg}`);
  }
  const text = (raw.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  const u = raw.usage;
  const usage = u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, reasoning: null } : null;
  return { text, raw, model: raw.model ?? null, usage };
}

/** Text of a chat/completions reply: a string, or an array of parts. */
export function chatText(raw: any): string {
  const content = raw?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

export function chatUsage(raw: any): JudgeUsage | null {
  const u = raw?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const r = u.completion_tokens_details?.reasoning_tokens;
  return { input: n(u.prompt_tokens), output: n(u.completion_tokens), cache_read: n(u.prompt_tokens_details?.cached_tokens), reasoning: typeof r === 'number' ? r : null };
}

/**
 * GPT judge through the proxy's chat/completions route. The proxy does not
 * enforce max_tokens, so it is no cap; parseReply reads the reply defensively.
 */
async function callOpenAiJudge(opts: CallJudgeOptions): Promise<JudgeCall> {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: 64_000,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: opts.prompt },
    ],
  };
  if (opts.effort) body.reasoning_effort = opts.effort;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(900_000) });
  const raw: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`judge call failed: ${res.status} ${JSON.stringify(raw).slice(0, 500)}`);
  const usage = chatUsage(raw);
  if (opts.effort && opts.effort !== 'low' && usage && !usage.reasoning) {
    log(`warning: the judge reported no reasoning tokens at effort ${opts.effort}; the proxy may have dropped reasoning_effort`);
  }
  return { text: chatText(raw), raw, model: raw.model ?? null, usage };
}

/** A judge model as a file name part. */
export function judgeSlug(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'judge';
}

function lineModel(j: any): string {
  return String(j?.judge_model ?? 'unknown');
}

/**
 * Where a judge model's results go. Each prompt version from 3 on gets its own
 * file, judge-<model>-p<version>.jsonl, so judging a set again with a new
 * prompt keeps the earlier scores. Prompt versions 1 and 2 wrote judge.jsonl
 * (the first judge of a set) or judge-<model>.jsonl; those files are read, not
 * written, by this version.
 */
export function judgeFiles(setDir: string, judgeModel: string, version = JUDGE_PROMPT_VERSION): { jsonl: string; dir: string } {
  const slug = judgeSlug(judgeModel);
  if (version >= 3) return { jsonl: join(setDir, `judge-${slug}-p${version}.jsonl`), dir: join(setDir, 'judge', `${slug}-p${version}`) };
  const legacy = join(setDir, 'judge.jsonl');
  if (existsSync(legacy)) {
    const first = readJsonl(legacy)[0];
    if (!first || lineModel(first) === judgeModel) return { jsonl: legacy, dir: join(setDir, 'judge') };
  }
  return { jsonl: join(setDir, `judge-${slug}.jsonl`), dir: join(setDir, 'judge', slug) };
}

export interface JudgeResults {
  model: string;
  file: string;
  lines: any[];
}

/** "neu/claude-sonnet-5-5" and "claude-opus-5-5" are both "claude"; "gpt-6.1-sol" is "gpt". */
export function modelFamily(model: string): string {
  return (model.split('/').pop() ?? model).split('-')[0].toLowerCase();
}

/**
 * Every judge's results in a set, newest prompt version first; within a
 * version, a judge from another model family than the arms' model first (it
 * cannot favour its own family's code), then judge.jsonl (the earliest
 * judge), then by file name. A judge from prompt version 3 on is labelled
 * "<model> p<version>", so the same model under two prompts shows as two judges.
 */
export function readJudges(setDir: string, armModel?: string): JudgeResults[] {
  if (!existsSync(setDir)) return [];
  const found: Array<JudgeResults & { version: number }> = [];
  for (const f of readdirSync(setDir).filter((f) => f === 'judge.jsonl' || /^judge-.+\.jsonl$/.test(f))) {
    const lines = readJsonl(join(setDir, f));
    if (!lines.length) continue;
    const version = Number(lines[0].prompt_version ?? 1);
    found.push({ model: version >= 3 ? `${lineModel(lines[0])} p${version}` : lineModel(lines[0]), file: f, lines, version });
  }
  const own = (j: JudgeResults) => (armModel && modelFamily(lineModel(j.lines[0])) === modelFamily(armModel) ? 1 : 0);
  found.sort((a, b) => b.version - a.version || own(a) - own(b) || (a.file === 'judge.jsonl' ? -1 : b.file === 'judge.jsonl' ? 1 : a.file.localeCompare(b.file)));
  return found.map(({ version: _v, ...j }) => j);
}

function fakeReply(cands: Candidate[], seed: number): string {
  let x = seed;
  const next = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const scored = cands.map((c, i) => ({
    candidate: i + 1,
    correctness: c.tests.pass ? 4 + (next() < 0.5 ? 1 : 0) : 2,
    minimal: 3 + (next() < 0.5 ? 1 : 0),
    readability: 3 + (next() < 0.5 ? 1 : 0),
    tampering: c.modified_existing_tests.length ? 'yes' : 'no',
    notes: c.tests.pass ? 'Fixes the cause and keeps the change small.' : 'Does not solve the task; the hidden tests still fail.',
  }));
  const passing = scored.filter((s) => cands[s.candidate - 1].tests.pass);
  const preference = passing.length === 1 ? String(passing[0].candidate) : 'tie';
  return JSON.stringify({ candidates: scored, preference });
}

export interface JudgeOptions {
  setDir: string;
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  swap: boolean;
  dryRun: boolean;
  workRoot: string;
  /** Default: from the model id (judgeProviderFor). */
  provider?: JudgeProvider;
  /** Default: high for GPT judges, none for Claude judges (judgeEffortFor). */
  effort?: JudgeEffort | null;
}

/**
 * Judge every (task, repeat) group of valid runs in a set. Results go to this
 * judge model's own file (judgeFiles), so another judge's results stay. A
 * dry run uses a fake judge named "fake:<model>".
 */
export async function judgeSet(o: JudgeOptions): Promise<number> {
  const results = readJsonl(join(o.setDir, 'results.jsonl'));
  const valid = latestRuns(results).filter((r) => r.valid);
  const groups = new Map<string, any[]>();
  for (const r of valid) {
    const k = `${r.task_id}#${r.repeat}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const provider = o.provider ?? judgeProviderFor(o.model);
  const effort = o.effort === undefined ? judgeEffortFor(provider) : o.effort;
  const judgeName = o.dryRun ? `fake:${o.model}` : o.model;
  const files = judgeFiles(o.setDir, judgeName);
  const outFile = files.jsonl;
  log(`judge ${judgeName} (${provider}${effort ? `, effort ${effort}` : ''}) writes ${outFile.slice(o.setDir.length + 1)}`);
  const done = new Set(readJsonl(outFile).filter((j) => !j.judge_error).map((j) => j.run_id));
  let calls = 0;
  for (const [key, runs] of [...groups.entries()].sort()) {
    if (runs.every((r) => done.has(r.run_id))) continue;
    if (runs.length < 1) continue;
    const t = loadTask(runs[0].task_id);
    const ordered = shuffle(
      runs.sort((a, b) => a.arm.localeCompare(b.arm)),
      parseInt(sha256(t.id).slice(0, 8), 16),
    );
    const cands: Candidate[] = ordered.map((r) => ({
      run_id: r.run_id,
      arm: r.arm,
      diffPath: join(o.setDir, r.paths.dir, 'diff.patch'),
      testsPath: join(o.setDir, r.paths.dir, 'test-output.txt'),
      tests: r.tests,
      modified_existing_tests: r.diff.modified_existing_tests ?? [],
    }));
    const ref = await referenceDiff(t, join(o.workRoot, '_judge', t.id));
    const passes = o.swap && cands.length > 1 ? [cands, [...cands].reverse()] : [cands];
    const replies: Array<{ order: Candidate[]; reply: JudgeReply | null; error?: string; model: string | null; usage: JudgeUsage | null }> = [];
    // one call at a time: the proxy serves other tools too
    for (const [pi, order] of passes.entries()) {
      const { text: prompt, removed } = buildJudgePrompt(t, ref, order);
      const base = join(files.dir, `${key.replace('#', '-r')}-p${pi + 1}`);
      writeText(base + '.prompt.txt', `${SYSTEM}\n\n---\n\n${prompt}`);
      let reply: JudgeReply | null = null;
      let error: string | undefined;
      let served: string | null = null;
      let usage: JudgeUsage | null = null;
      for (let attempt = 1; attempt <= 2 && !reply; attempt++) {
        try {
          let text: string;
          if (o.dryRun) {
            text = fakeReply(order, seedOf(key + pi + o.model));
            served = judgeName;
          } else {
            const r = await callJudge({ baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model, prompt, provider, effort });
            text = r.text;
            served = r.model;
            usage = r.usage;
            writeJson(base + `.response-${attempt}.json`, r.raw);
            calls++;
          }
          reply = parseReply(text, order.length);
          if (!reply) error = 'invalid JSON from the judge';
        } catch (e) {
          error = (e as Error).message;
        }
      }
      replies.push({ order, reply, error: reply ? undefined : error, model: served, usage });
      writeJson(base + '.removed-harness-files.json', removed);
    }
    // map back to arms and average passes
    const prefs = replies.map((p) => (p.reply ? (p.reply.preference === 'tie' ? 'tie' : p.order[Number(p.reply.preference) - 1].arm) : null));
    let taskPref: string | null;
    if (prefs.some((p) => p === null)) taskPref = prefs.find((p) => p !== null) ?? null;
    else if (prefs.length === 2 && prefs[0] !== prefs[1]) taskPref = 'tie (order sensitive)';
    else taskPref = prefs[0];
    for (const c of cands) {
      const scores = replies
        .filter((p) => p.reply)
        .map((p) => p.reply!.candidates.find((x) => x.candidate === p.order.indexOf(c) + 1))
        .filter(Boolean) as JudgeReply['candidates'];
      const avg = (k: 'correctness' | 'minimal' | 'readability') => (scores.length ? scores.reduce((a, s) => a + s[k], 0) / scores.length : null);
      const line = {
        schema: 1,
        prompt_version: JUDGE_PROMPT_VERSION,
        run_id: c.run_id,
        task_id: t.id,
        repeat: runs[0].repeat,
        arm: c.arm,
        candidate: replies[0].order.indexOf(c) + 1,
        candidates: cands.length,
        passes: scores.length,
        judge_model: judgeName,
        judge_provider: provider,
        judge_effort: effort,
        judge_model_served: replies.map((p) => p.model),
        // per call of this group (shared by its candidates): tokens, and reasoning tokens where reported
        judge_usage: replies.map((p) => p.usage),
        correctness: avg('correctness'),
        minimal: avg('minimal'),
        readability: avg('readability'),
        tampering: scores.length ? scores.some((s) => s.tampering === 'yes') : null,
        notes: scores.map((s) => s.notes).join(' / ') || null,
        task_preference: taskPref,
        preferred: taskPref === c.arm,
        judge_error: scores.length ? null : (replies.find((p) => p.error)?.error ?? 'no reply'),
      };
      appendJsonl(outFile, line);
    }
    log(`judged ${key}: preference ${taskPref ?? 'error'}`);
  }
  return calls;
}
