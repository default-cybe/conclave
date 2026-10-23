/**
 * A subagent runs in its parent's permission mode, and an agent whose model
 * the provider cannot serve falls back to the parent's model with one warning
 * instead of failing (engine/subagent.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { firstUserText, startTestEngine, toolResults, type RequestBody, type TestEngine } from './harness';
import { noHarnesses, runScript } from '../workflows/helpers';
import type { Session } from '../../src/types';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const isChild = (body: { messages?: unknown[] }) => firstUserText(body).includes('CHILD-JOB');
const task = (agent: string) => ({ tool: 'Task', input: { description: 'child job', prompt: 'CHILD-JOB: check it', subagent_type: agent } });

describe('a Task subagent', () => {
  for (const mode of ['bypass', 'default', 'acceptEdits'] as Session['permissionMode'][]) {
    test(`of a ${mode} session runs in ${mode}`, async () => {
      t = await startTestEngine({ script: [[task('general-purpose')], [{ text: 'done' }]], route: (body) => (isChild(body) ? [{ text: 'checked' }] : undefined) });
      const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose', permissionMode: mode });
      await t.run(s.id, 'go');
      const child = t.engine.listSessions({ parentId: s.id })[0];
      expect(child.permissionMode).toBe(mode);
      expect(child.mode).toBe('agent');
    });
  }
});

describe('an agent whose model the provider cannot serve', () => {
  test('falls back to the parent model with one warning, and the turn succeeds', async () => {
    t = await startTestEngine({
      script: [[task('verifier')], [{ text: 'done' }]],
      extraProviders: { gone: ['claude-fable-5-1'] },
      // verifier is model: deep; the deep tier names a model this provider lists but cannot serve
      overrides: { models: { tiers: { fast: 'mock/claude-sonnet-5-5', deep: 'gone/claude-fable-5-1' } } } as never,
      route: (body, _text, provider) => {
        if (!isChild(body)) return undefined;
        return provider === 'gone' ? { status: 404, type: 'not_found_error', error: 'model: claude-fable-5-1' } : [{ text: 'VERDICT: confirmed' }];
      },
    });
    const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass' });
    await t.run(s.id, 'verify it');
    const child = t.engine.listSessions({ parentId: s.id })[0];
    expect(child.agent).toBe('verifier');
    expect(child.model).toBe('mock/claude-sonnet-5-5');
    const warnings = t.engine.getMessages(child.id).filter((m) => m.kind === 'notice' && m.meta?.level === 'warning');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0].content)).toContain('gone/claude-fable-5-1 is not available');
    const res = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
    expect(res.isError).toBe(false);
    expect(res.content).toContain('VERDICT: confirmed');
  });

  test('a deep pick that 404s is skipped on the next resolution (Task, then a workflow agent)', async () => {
    // no models.tiers.deep: the pick is the first listed deep model, which the provider cannot serve
    const dead = (body: RequestBody) => (body as { model?: string }).model === 'claude-fable-5-1';
    t = await startTestEngine({
      script: [[task('verifier')], [task('verifier')], [{ text: 'done' }]],
      extraProviders: { gone: ['claude-fable-5-1', 'claude-opus-5-5'] },
      overrides: { models: { tiers: { fast: 'mock/claude-sonnet-5-5' } } } as never,
      route: (body, _text, provider) => {
        if (!isChild(body) && !firstUserText(body).includes('WF-JOB')) return undefined;
        return provider === 'gone' && dead(body) ? { status: 404, type: 'not_found_error', error: 'model: claude-fable-5-1' } : [{ text: 'VERDICT: confirmed' }];
      },
    });
    noHarnesses(t.engine);
    const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass' });
    await t.run(s.id, 'verify it twice');
    const [first, second] = t.engine.listSessions({ parentId: s.id }).sort((a, b) => a.createdAt - b.createdAt);
    expect(first.model).toBe('mock/claude-sonnet-5-5');
    expect(second.model).toBe('gone/claude-opus-5-5');
    const warnings = (id: string) => t!.engine.getMessages(id).filter((m) => m.kind === 'notice' && m.meta?.level === 'warning');
    expect(warnings(first.id)).toHaveLength(1);
    expect(warnings(second.id)).toHaveLength(0);
    // one failed call in all: the first child's
    const fails = t.requestProviders.filter((p, i) => p === 'gone' && dead(JSON.parse(t!.requests[i]))).length;
    expect(fails).toBe(1);
    // a workflow agent asking for deep resolves the same way: straight to the next candidate
    const run = await runScript(t, `export const meta = { name: 'deep', description: 'x' }\nreturn await agent('WF-JOB', { model: 'deep' })`);
    expect(run.result).toBe('VERDICT: confirmed');
    const wf = t.engine.listSessions({}).find((c) => c.tags?.includes('workflow'))!;
    expect(wf.model).toBe('gone/claude-opus-5-5');
  });

  test('a workflow agent whose model the provider cannot serve falls back to the session model', async () => {
    t = await startTestEngine({
      script: [[{ text: 'unused' }]],
      extraProviders: { gone: ['claude-fable-5-1'] },
      overrides: { models: { tiers: { fast: 'mock/claude-sonnet-5-5' } } } as never,
      route: (body, _text, provider) => {
        if (!firstUserText(body).includes('WF-JOB')) return undefined;
        return provider === 'gone' ? { status: 404, type: 'not_found_error', error: 'model: claude-fable-5-1' } : [{ text: 'fell back' }];
      },
    });
    noHarnesses(t.engine);
    const run = await runScript(t, `export const meta = { name: 'dead', description: 'x' }\nreturn await agent('WF-JOB', { model: 'gone/claude-fable-5-1' })`);
    expect(run.status).toBe('done');
    expect(run.result).toBe('fell back');
    const wf = t.engine.listSessions({}).find((c) => c.tags?.includes('workflow'))!;
    expect(wf.model).toBe('mock/claude-sonnet-5-5');
  });

  test('any other error still fails the call', async () => {
    t = await startTestEngine({
      script: [[task('verifier')], [{ text: 'done' }]],
      extraProviders: { gone: ['claude-fable-5-1'] },
      overrides: { models: { tiers: { fast: 'mock/claude-sonnet-5-5', deep: 'gone/claude-fable-5-1' } } } as never,
      route: (body, _text, provider) => (isChild(body) && provider === 'gone' ? { status: 401, error: 'bad key' } : isChild(body) ? [{ text: 'never' }] : undefined),
    });
    const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose' });
    await t.run(s.id, 'verify it');
    const child = t.engine.listSessions({ parentId: s.id })[0];
    expect(child.model).toBe('gone/claude-fable-5-1');
    expect(toolResults(t.engine, s.id).find((r) => r.name === 'Task')!.content).not.toContain('never');
  });
});
