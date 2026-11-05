/**
 * Mixed-model review panels (lib.panel, lib.judgePanel): voters spread over
 * the distinct usable models of the tier, round robin, one model when only
 * one is usable, o.models pins the list, and a member's panel never runs on
 * the owner's providers. Confirmers that share an untested assumption mark
 * the finding low confidence. Scripted providers only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { afterToolResult, noHarnesses, runScript, svcOf } from './helpers';
import { panelModels } from '../../src/workflows/agents';

const so = (input: Record<string, unknown>) => (body: RequestBody): Step => (afterToolResult(body) ? [{ text: 'done' }] : [{ tool: 'StructuredOutput', input }]);
const LENS = ['Your lens: Trace the input', 'Your lens: Intended behavior', 'Your lens: Impact'];
const FINDING = `{ file: 'a.ts', line: 2, quote: 'x', title: 't', scenario: 's' }`;

function engineWith(extraProviders?: Record<string, string[]>) {
  const answers = new Map<string, (body: RequestBody) => Step | undefined>();
  // the model each voter ran on, by its lens or judge label
  const seen = new Map<string, string>();
  let t!: TestEngine;
  return {
    answers,
    seen,
    get t() {
      return t;
    },
    async start() {
      t = await startTestEngine({
        script: [[{ text: 'fallback' }]],
        route: (body, _text, provider) => {
          const first = firstUserText(body);
          for (const [word, fn] of answers)
            if (first.includes(word)) {
              if (!afterToolResult(body)) seen.set(word, `${provider}/${(body as { model?: string }).model}`);
              return fn(body);
            }
          return undefined;
        },
        overrides: { limits: { maxRetries: 0 } } as never,
        ...(extraProviders ? { extraProviders } : {}),
      });
      noHarnesses(t.engine);
    },
  };
}

describe('two or more usable models of the tier', () => {
  const e = engineWith({ alt: ['claude-opus-5-5'], other: ['claude-fable-5'] });
  beforeAll(() => e.start());
  afterAll(() => e.t?.close());

  test('the voters get different models, round robin, and the log says which model cast each vote', async () => {
    for (const l of LENS) e.answers.set(l, so({ verdict: 'confirmed', severity: 'P2', evidence: ['a.ts:2'], note: 'real', untested: [] }));
    const run = await runScript(e.t, `export const meta = { name: 'mix', description: 'x', runtime: 'conclave' }
return await lib.panel(${FINDING})`);
    const r = run.result as { kept: boolean; models: string[]; confidence: string; sharedUntested: string[]; flag?: string };
    expect(r.models).toEqual(['mock/claude-sonnet-5-5', 'alt/claude-opus-5-5', 'other/claude-fable-5']);
    expect(LENS.map((l) => e.seen.get(l))).toEqual(['mock/claude-sonnet-5-5', 'alt/claude-opus-5-5', 'other/claude-fable-5']);
    expect(r).toMatchObject({ kept: true, confidence: 'high', sharedUntested: [] });
    expect(r.flag).toBeUndefined();
    const logs = svcOf(e.t.engine).store.logs(run.id).map((l) => l.text);
    expect(logs).toContain('panel for a.ts:2: #1 mock/claude-sonnet-5-5 confirmed, #2 alt/claude-opus-5-5 confirmed, #3 other/claude-fable-5 confirmed');
  });

  test('o.models pins the list; o.model still puts every voter on one model', async () => {
    const pinned = await runScript(e.t, `export const meta = { name: 'pin', description: 'x', runtime: 'conclave' }
return await lib.panel(${FINDING}, { models: ['other/claude-fable-5', 'alt/claude-opus-5-5', 'nowhere/x'] })`);
    expect((pinned.result as { models: string[] }).models).toEqual(['other/claude-fable-5', 'alt/claude-opus-5-5', 'other/claude-fable-5']);
    const one = await runScript(e.t, `export const meta = { name: 'one', description: 'x', runtime: 'conclave' }
return await lib.panel(${FINDING}, { model: 'alt/claude-opus-5-5' })`);
    expect((one.result as { models: string[] }).models).toEqual(['alt/claude-opus-5-5', 'alt/claude-opus-5-5', 'alt/claude-opus-5-5']);
    expect(LENS.map((l) => e.seen.get(l))).toEqual(['alt/claude-opus-5-5', 'alt/claude-opus-5-5', 'alt/claude-opus-5-5']);
  });

  test('confirmers that all lean on one untested assumption: sharedUntested, confidence low, agreed-without-evidence', async () => {
    e.answers.set(LENS[0], so({ verdict: 'confirmed', severity: 'P1', evidence: ['a.ts:2'], note: 'real', untested: ['The caller passes user input', 'the cache is cold'] }));
    e.answers.set(LENS[1], so({ verdict: 'confirmed', severity: 'P1', evidence: ['a.ts:2'], note: 'real', untested: ['the caller passes  user input.'] }));
    e.answers.set(LENS[2], so({ verdict: 'confirmed', severity: 'P1', evidence: ['a.ts:2'], note: 'real', untested: ['THE CALLER PASSES USER INPUT'] }));
    const run = await runScript(e.t, `export const meta = { name: 'shared', description: 'x', runtime: 'conclave' }
return await lib.panel(${FINDING})`);
    expect(run.result).toMatchObject({ kept: true, confidence: 'low', flag: 'agreed-without-evidence', sharedUntested: ['The caller passes user input'] });
    // a refuter's assumptions do not count, and one confirmer without it clears the flag
    e.answers.set(LENS[2], so({ verdict: 'refuted', evidence: ['a.ts:9'], note: 'guarded', untested: [] }));
    e.answers.set(LENS[1], so({ verdict: 'confirmed', severity: 'P1', evidence: ['a.ts:2'], note: 'checked', untested: [] }));
    const clear = await runScript(e.t, `export const meta = { name: 'shared2', description: 'x', runtime: 'conclave' }
return await lib.panel(${FINDING})`);
    expect(clear.result).toMatchObject({ kept: true, confidence: 'medium', sharedUntested: [] });
  });

  test('lib.judgePanel puts each judge on its own model, both orders on the same one', async () => {
    const byLabel: string[] = [];
    e.answers.set('Score each candidate', (body) => {
      if (!afterToolResult(body)) byLabel.push(e.seen.get('Score each candidate')!);
      return so({ scores: [{ id: 'A', score: 5 }, { id: 'B', score: 5 }], best: 'A', untested: [] })(body);
    });
    const run = await runScript(e.t, `export const meta = { name: 'judges', description: 'x', runtime: 'conclave' }
return await lib.judgePanel(['one', 'two'], { judges: 2 })`);
    expect((run.result as { models: string[] }).models).toEqual(['mock/claude-sonnet-5-5', 'alt/claude-opus-5-5']);
    expect(byLabel.sort()).toEqual(['alt/claude-opus-5-5', 'alt/claude-opus-5-5', 'mock/claude-sonnet-5-5', 'mock/claude-sonnet-5-5']);
  });

  test("a member's panel never lists the owner's providers", async () => {
    const memberId = e.t.engine.people.create({ name: 'pat' }).id;
    const s = await e.t.engine.createSession({ cwd: e.t.cwd, title: 'member panel' } as never, memberId);
    const list = await panelModels(e.t.engine, s.id, 'deep');
    expect(list.filter((m) => /^(mock|alt|other)\//.test(m))).toEqual([]);
    expect(await panelModels(e.t.engine, s.id, 'deep', ['alt/claude-opus-5-5'])).toEqual([]);
  });
});

describe('one usable model of the tier', () => {
  const e = engineWith();
  beforeAll(() => e.start());
  afterAll(() => e.t?.close());

  test('every voter runs on it', async () => {
    for (const l of LENS) e.answers.set(l, so({ verdict: 'confirmed', severity: 'P2', evidence: ['a.ts:2'], note: 'real' }));
    const run = await runScript(e.t, `export const meta = { name: 'single', description: 'x', runtime: 'conclave' }
return await lib.panel(${FINDING})`);
    expect((run.result as { models: string[] }).models).toEqual(['mock/claude-sonnet-5-5', 'mock/claude-sonnet-5-5', 'mock/claude-sonnet-5-5']);
    expect(LENS.map((l) => e.seen.get(l))).toEqual(['mock/claude-sonnet-5-5', 'mock/claude-sonnet-5-5', 'mock/claude-sonnet-5-5']);
  });
});
