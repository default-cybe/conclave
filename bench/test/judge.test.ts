import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJudgePrompt, callJudge, chatText, chatUsage, judgeEffortFor, judgeFiles, judgeProviderFor, judgeSet, readJudges, visibleTestFiles } from '../lib/judge';
import { judgeSummaries, writeReport } from '../lib/report';
import { loadTask } from '../lib/tasks';
import { appendJsonl, readJsonl, writeJson, writeText } from '../lib/util';

const dirs: string[] = [];
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const TASK = 'pg-go-forth';

/** A finished dry-run set with one task and two arms, as runset writes it. */
function makeSet(): string {
  const set = temp('conclave-bench-judge-');
  writeJson(join(set, 'manifest.json'), { set: 'judge-test', arms: ['A', 'B'], repeats: 1, model: 'claude-sonnet-5-5', small_model: 'claude-haiku-4-5-20251001', dry_run: true, seed: 1, work_root: set });
  for (const [arm, pass] of [['A', true], ['B', false]] as const) {
    const dir = `runs/${arm}1`;
    writeText(join(set, dir, 'diff.patch'), `diff --git a/forth.go b/forth.go\n--- a/forth.go\n+++ b/forth.go\n@@ -1 +1 @@\n-package forth\n+package forth // ${arm}\n`);
    writeText(join(set, dir, 'test-output.txt'), pass ? 'ok\n' : 'FAIL: TestForth\n');
    appendJsonl(join(set, 'results.jsonl'), {
      run_id: `${arm}1`, task_id: TASK, repeat: 1, arm, valid: true, kind: 'public', difficulty: 'hard',
      paths: { dir }, tests: { passed: pass ? 10 : 3, expected_total: 10, build_error: false, pass, partial: pass ? 1 : 0.3 },
      diff: { modified_existing_tests: [], files_changed: 1, lines_added: 1, lines_removed: 1 },
    });
  }
  return set;
}

describe('judge provider and effort', () => {
  test('GPT ids go to chat/completions, the rest to the Messages API; the flag wins', () => {
    expect(judgeProviderFor('gpt-6.1-sol')).toBe('openai');
    expect(judgeProviderFor('neu/gpt-5.5')).toBe('openai');
    expect(judgeProviderFor('o3-pro')).toBe('openai');
    expect(judgeProviderFor('claude-sonnet-5-5')).toBe('anthropic');
    expect(judgeProviderFor('my-gpt-proxy-name', 'openai')).toBe('openai');
    expect(() => judgeProviderFor('x', 'gemini')).toThrow();
  });

  test('GPT judges default to high effort; minimal and none are refused', () => {
    expect(judgeEffortFor('openai')).toBe('high');
    expect(judgeEffortFor('anthropic')).toBeNull();
    expect(judgeEffortFor('openai', 'xhigh')).toBe('xhigh');
    expect(() => judgeEffortFor('openai', 'minimal')).toThrow();
    expect(() => judgeEffortFor('openai', 'none')).toThrow();
  });

  test('chat/completions replies: text from a string or parts, usage with reasoning and cached tokens', () => {
    expect(chatText({ choices: [{ message: { content: '{"a":1}' } }] })).toBe('{"a":1}');
    expect(chatText({ choices: [{ message: { content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] } }] })).toBe('xy');
    expect(chatText({})).toBe('');
    expect(chatUsage({ usage: { prompt_tokens: 900, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 250 } } })).toEqual({ input: 900, output: 300, cache_read: 100, reasoning: 250 });
    expect(chatUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).toEqual({ input: 1, output: 2, cache_read: 0, reasoning: null });
  });

  test('the GPT judge call sends the system prompt, the effort and a bounded max_tokens to chat/completions', async () => {
    let body: any;
    let path = '';
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        path = new URL(req.url).pathname;
        body = await req.json();
        return Response.json({ model: 'gpt-6.1-sol', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 4 } } });
      },
    });
    try {
      const r = await callJudge({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: 'k', model: 'gpt-6.1-sol', prompt: 'judge this', provider: 'openai', effort: 'high' });
      expect(path).toBe('/v1/chat/completions');
      expect(body.reasoning_effort).toBe('high');
      expect(body.max_tokens).toBeLessThanOrEqual(128_000);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1]).toEqual({ role: 'user', content: 'judge this' });
      expect(r.text).toBe('ok');
      expect(r.usage?.reasoning).toBe(4);
    } finally {
      server.stop(true);
    }
  });
});

describe('judging a set with a second judge', () => {
  test('each judge keeps its own file; the report shows both and their agreement', async () => {
    const set = makeSet();
    const common = { setDir: set, baseUrl: 'http://127.0.0.1:1', apiKey: undefined, swap: true, dryRun: true, workRoot: set };
    await judgeSet({ ...common, model: 'claude-sonnet-5-5' });
    await judgeSet({ ...common, model: 'gpt-6.1-sol' });
    const judges = readJudges(set);
    expect(judges.map((j) => j.file)).toEqual(['judge-fake-claude-sonnet-5-5-p3.jsonl', 'judge-fake-gpt-6.1-sol-p3.jsonl']);
    expect(judges.map((j) => j.lines.length)).toEqual([2, 2]);
    expect(judges[1].lines[0].judge_provider).toBe('openai');
    expect(judges[1].lines[0].judge_effort).toBe('high');
    expect(existsSync(join(set, 'judge', 'fake-gpt-6.1-sol-p3', `${TASK}-r1-p1.prompt.txt`))).toBe(true);
    // judging again with the same model adds nothing
    await judgeSet({ ...common, model: 'gpt-6.1-sol' });
    expect(readJsonl(join(set, 'judge-fake-gpt-6.1-sol-p3.jsonl'))).toHaveLength(2);

    const results = readJsonl(join(set, 'results.jsonl'));
    const s = judgeSummaries(results, judges, ['A', 'B']);
    expect(s.judges).toHaveLength(2);
    expect(s.judges[0].perArm.A.n).toBe(1);
    // the fake judge prefers the only passing run
    expect(s.judges[0].preferences).toEqual({ A: 1 });
    expect(s.agreement).toEqual([{ a: 'fake:claude-sonnet-5-5 p3', b: 'fake:gpt-6.1-sol p3', groups: 1, sameArm: 1, bothTie: 0, oneTie: 0, opposite: 0 }]);
    const { md } = writeReport(set);
    expect(md).toContain('## Judges');
    expect(md).toContain('fake:gpt-6.1-sol p3 (openai)');
    expect(md).toContain('| fake:claude-sonnet-5-5 p3 vs fake:gpt-6.1-sol p3 | 1 | 1 | 0 | 0 | 0 |');
    expect(md).toContain('claude-haiku-4-5-20251001');
  }, 60_000);

  test('prompt versions 1 and 2 used judge.jsonl or judge-<model>.jsonl; version 3 writes its own file and sorts first', () => {
    const set = makeSet();
    appendJsonl(join(set, 'judge.jsonl'), { run_id: 'A1', task_id: TASK, repeat: 1, arm: 'A', judge_model: 'claude-sonnet-5-5', prompt_version: 1, task_preference: 'tie' });
    appendJsonl(join(set, 'judge-gpt-6.1-sol.jsonl'), { run_id: 'A1', task_id: TASK, repeat: 1, arm: 'A', judge_model: 'gpt-6.1-sol', prompt_version: 2, task_preference: 'tie' });
    expect(judgeFiles(set, 'claude-sonnet-5-5', 2).jsonl).toBe(join(set, 'judge.jsonl'));
    expect(judgeFiles(set, 'gpt-6.1-sol', 2).jsonl).toBe(join(set, 'judge-gpt-6.1-sol.jsonl'));
    expect(judgeFiles(set, 'claude-sonnet-5-5').jsonl).toBe(join(set, 'judge-claude-sonnet-5-5-p3.jsonl'));
    appendJsonl(join(set, 'judge-claude-sonnet-5-5-p3.jsonl'), { run_id: 'A1', task_id: TASK, repeat: 1, arm: 'A', judge_model: 'claude-sonnet-5-5', prompt_version: 3, task_preference: 'tie' });
    expect(readJudges(set).map((j) => j.model)).toEqual(['claude-sonnet-5-5 p3', 'gpt-6.1-sol', 'claude-sonnet-5-5']);
    // within a version, a judge of another family than the arms' model comes first
    appendJsonl(join(set, 'judge-gpt-6.1-sol-p3.jsonl'), { run_id: 'A1', task_id: TASK, repeat: 1, arm: 'A', judge_model: 'gpt-6.1-sol', prompt_version: 3, task_preference: 'tie' });
    expect(readJudges(set, 'neu/claude-sonnet-5-5').map((j) => j.model).slice(0, 2)).toEqual(['gpt-6.1-sol p3', 'claude-sonnet-5-5 p3']);
    expect(readJudges(set, 'gpt-6.1-sol').map((j) => j.model).slice(0, 2)).toEqual(['claude-sonnet-5-5 p3', 'gpt-6.1-sol p3']);
  });
});

describe('judge prompt', () => {
  test('it lists the test files the agents could see', () => {
    const t = loadTask(TASK);
    const visible = visibleTestFiles(t);
    expect(visible.some((f) => f.endsWith('cases_test.go'))).toBe(true);
    const { text } = buildJudgePrompt(t, '', []);
    expect(text).toContain('# Test files the agents could see');
    for (const f of visible) expect(text).toContain(`- ${f}`);
    expect(readFileSync(join(t.dir, 'repo', visible.find((f) => f.endsWith('cases_test.go'))!), 'utf8')).toContain('testCases');
  });

  test('it does not pass on the kit own changed-tests flag, which a judge read as tampering', () => {
    const t = loadTask(TASK);
    const cand = { run_id: 'A1', arm: 'A', diffPath: '/nonexistent', testsPath: '/nonexistent', tests: { passed: 1, expected_total: 1, build_error: false, pass: true }, modified_existing_tests: ['test/cli.test.ts'] };
    const { text } = buildJudgePrompt(t, '', [cand]);
    expect(text).toContain('# Candidate 1');
    expect(text).not.toContain('test/cli.test.ts');
    expect(text).not.toContain('changed or deleted');
  });
});
