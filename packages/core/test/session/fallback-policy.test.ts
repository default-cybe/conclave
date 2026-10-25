/**
 * The per-task fallback policy (ideas item 8; session/limit-tree.ts): the
 * policy a task carries (its own meta.limits.fallback, else the nearest
 * ancestor's, else the config for its place in the tree), what checkFallback
 * allows (destination providers, paid keys, the cost ceiling over the whole
 * tree), the record an automatic switch leaves, and the refusal walk's
 * usable() honouring it.
 */
import { describe, expect, test } from 'bun:test';
import { checkFallback, fallbackPolicyFor, recordAutoSwitch } from '../../src/session/limit-tree';
import { RefusalWalk, usable, type FallbackTarget } from '../../src/session/refusal-fallback';
import { streamCompletion, completeText } from '../../src/session/stream';
import { ProviderError } from '../../src/providers/types';
import { firstUserText, startTestEngine, toolResults, type TestEngine } from '../engine/harness';

describe('the fallback policy', () => {
  let t: TestEngine;
  let sid: string;

  const policy = (fallback: Record<string, unknown>) => t.engine.patchMeta(sid, { limits: { fallback } });

  test('the node nearest the work wins: its own, an ancestor\'s, else none', async () => {
    t = await startTestEngine({ script: [[{ text: 'done' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      sid = s.id;
      expect(fallbackPolicyFor(t.engine, s)).toBeUndefined();
      policy({ paid: false });
      expect(fallbackPolicyFor(t.engine, t.engine.getSession(sid)!)).toMatchObject({ paid: false });
      // a child without its own policy runs under its parent's
      const child = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'general-purpose', parentId: sid });
      expect(fallbackPolicyFor(t.engine, t.engine.getSession(child.id)!)).toMatchObject({ paid: false });
      // its own wins over the parent's
      t.engine.patchMeta(child.id, { limits: { fallback: { providers: ['mock'] } } });
      expect(fallbackPolicyFor(t.engine, t.engine.getSession(child.id)!)).toMatchObject({ providers: ['mock'] });
    } finally {
      await t.close();
    }
  });

  test('allowed destinations, paid keys and the ceiling decide; a destination whose cost cannot be bounded is not allowed', async () => {
    t = await startTestEngine({ script: [[{ text: 'done' }]], models: ['claude-sonnet-5-5', 'custom-x'], extraProviders: { mock2: ['claude-sonnet-5-5'] } });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      sid = s.id;
      // no policy: anything goes
      expect(checkFallback(t.engine, t.engine.getSession(sid)!, 'mock/claude-sonnet-5-5', 1000)).toMatchObject({ ok: true });
      // a ref that does not resolve is not denied without a policy, only under one
      expect(checkFallback(t.engine, t.engine.getSession(sid)!, 'nope/missing', 1000)).toMatchObject({ ok: true, costUnknown: true });
      policy({ paid: false });
      expect(checkFallback(t.engine, t.engine.getSession(sid)!, 'nope/missing', 1000).why).toContain('cannot be resolved');
      // destinations are named by provider
      policy({ providers: ['mock'] });
      expect(checkFallback(t.engine, t.engine.getSession(sid)!, 'mock/claude-sonnet-5-5', 1000)).toMatchObject({ ok: true });
      expect(checkFallback(t.engine, t.engine.getSession(sid)!, 'mock2/claude-sonnet-5-5', 1000)).toMatchObject({ ok: false });
      // a pay-per-token key (no signed in plans on it) is a paid destination
      policy({ paid: false });
      expect(checkFallback(t.engine, t.engine.getSession(sid)!, 'mock2/claude-sonnet-5-5', 1000)).toMatchObject({ ok: false, paid: true });
      // the ceiling counts the tree's spend plus the switch's estimate
      policy({ costUsd: 0.5 });
      expect(checkFallback(t.engine, t.engine.getSession(sid)!, 'mock/claude-sonnet-5-5', 1000)).toMatchObject({ ok: true, estimateUsd: expect.any(Number) });
      const dear = checkFallback(t.engine, t.engine.getSession(sid)!, 'mock/claude-sonnet-5-5', 1_000_000);
      expect(dear.ok).toBe(false);
      expect(dear.why).toContain('fallback ceiling');
      // a model with no price cannot be bounded under a ceiling
      expect(checkFallback(t.engine, t.engine.getSession(sid)!, 'mock/custom-x', 1000).why).toContain('cannot be bounded');
      // neither can a switch whose input is not known
      policy({ costUsd: 0.5 });
      expect(checkFallback(t.engine, t.engine.getSession(sid)!, 'mock/claude-sonnet-5-5', undefined).why).toContain('cannot be estimated');
    } finally {
      await t.close();
    }
  });

  test('zero, invalid ceilings, ancestor restrictions, and estimates without a policy', async () => {
    t = await startTestEngine({ script: [[{ text: 'done' }]], extraProviders: { mock2: ['claude-sonnet-5-5'] } });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      sid = s.id;
      expect(checkFallback(t.engine, s, s.model, 10)).toMatchObject({ ok: true, paid: true, estimateUsd: expect.any(Number) });
      for (const costUsd of [0, -1, NaN, Infinity]) {
        policy({ costUsd });
        expect(checkFallback(t.engine, t.engine.getSession(sid)!, s.model, 10).ok).toBe(false);
      }
      policy({ paid: false, costUsd: 0.0001 });
      const child = await t.engine.createSession({ title: 'c', cwd: t.cwd, agent: 'general-purpose', parentId: sid });
      t.engine.patchMeta(child.id, { limits: { fallback: { providers: ['mock2'] } } });
      expect(checkFallback(t.engine, t.engine.getSession(child.id)!, 'mock2/claude-sonnet-5-5', 1_000_000).ok).toBe(false);
    } finally { await t.close(); }
  });

  test('refusal selection under a ceiling remains available and never records a probe', async () => {
    t = await startTestEngine({ script: [[{ text: 'done' }]], extraProviders: { mock2: ['claude-sonnet-5-5'] } });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      sid = s.id;
      policy({ costUsd: 10 });
      const walk = new RefusalWalk(t.engine, t.engine.getSession(sid)!, { entries: [{ model: 'mock2/claude-sonnet-5-5' }], auto: false, stay: false, source: 'config', tagged: false });
      expect(walk.next({ provider: 'mock', model: 'claude-sonnet-5-5' })?.ref).toBe('mock2/claude-sonnet-5-5');
      expect(t.engine.getSession(sid)!.meta?.autoSwitches).toBeUndefined();
    } finally { await t.close(); }
  });

  test('a ceiling bounds every concurrent call and counts failed attempts before retries', async () => {
    t = await startTestEngine({ script: [[{ text: 'done' }]], chore: () => ({ blocks: [{ text: 'ok' }], delayMs: 30 }), modelOverrides: { 'claude-sonnet-5-5': { contextWindow: 100, maxOutput: 10, inputPrice: 1, outputPrice: 1000, cacheWritePrice: 1 } } });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      sid = s.id;
      policy({ costUsd: 0.015 });
      const req = { system: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], maxTokens: 10 };
      const results = await Promise.allSettled([1, 2].map(() => streamCompletion(t.engine, s.model, req, { sessionId: sid, purpose: 'test' })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(t.chores).toHaveLength(1);
      expect(JSON.parse(t.chores[0]).max_tokens).toBe(10);
      policy({ costUsd: 0 });
      await expect(streamCompletion(t.engine, s.model, req, { sessionId: sid, purpose: 'test' })).rejects.toMatchObject({ code: 'fallback_policy' });
    } finally { await t.close(); }
  });

  test('the reservation is bounded by the request, not the context window', async () => {
    // a 1M window at $10/M would reserve $10 a call; this request reads a few tokens
    t = await startTestEngine({ script: [[{ text: 'done' }]], modelOverrides: { 'claude-sonnet-5-5': { contextWindow: 1_000_000, maxOutput: 100, inputPrice: 10, outputPrice: 10, cacheWritePrice: 10 } } });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      sid = s.id;
      policy({ costUsd: 1 });
      const req = { system: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], maxTokens: 100 };
      await expect(streamCompletion(t.engine, s.model, req, { sessionId: sid, purpose: 'test' })).resolves.toBeDefined();
    } finally { await t.close(); }
  });

  test('a provider spend cap still falls back through the limit chain, with no policy pause', async () => {
    const calls: string[] = [];
    t = await startTestEngine({
      script: [], extraProviders: { other: ['claude-sonnet-5-5'] },
      overrides: { limits: { maxRetries: 0, fallbacks: { 'mock/claude-sonnet-5-5': ['other/claude-sonnet-5-5'] } } } as never,
      route: (_body, _text, provider) => {
        calls.push(provider);
        return provider === 'mock' ? { status: 400, type: 'invalid_request_error', error: 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' } : [{ text: 'answered by other' }];
      },
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: 'mock/claude-sonnet-5-5' });
      await t.run(s.id, 'answer');
      expect(calls).toEqual(['mock', 'other']);
      expect(JSON.stringify(t.engine.getMessages(s.id).at(-1)?.content)).toContain('answered by other');
      expect(JSON.stringify(t.engine.getMessages(s.id))).not.toContain('Task paused');
      expect(t.engine.requireSession(s.id).status).not.toBe('paused');
    } finally { await t.close(); }
  }, 30_000);

  test('a limit fallback the policy does not allow is not taken: the turn stops at the limit', async () => {
    const calls: string[] = [];
    t = await startTestEngine({
      script: [], extraProviders: { other: ['claude-sonnet-5-5'] },
      overrides: { limits: { maxRetries: 0, fallbacks: { 'mock/claude-sonnet-5-5': ['other/claude-sonnet-5-5'] } } } as never,
      route: (_body, _text, provider) => { calls.push(provider); return provider === 'mock' ? 429 : [{ text: 'answered by other' }]; },
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: 'mock/claude-sonnet-5-5' });
      t.engine.patchMeta(s.id, { limits: { fallback: { providers: ['mock'] } } });
      await t.run(s.id, 'answer');
      expect(calls).toEqual(['mock']);
      expect(JSON.stringify(t.engine.getMessages(s.id))).toContain('Not falling back to other/claude-sonnet-5-5');
      expect(t.engine.getSession(s.id)!.meta?.autoSwitches).toBeUndefined();
    } finally { await t.close(); }
  }, 30_000);

  test('a call the policy denies parks the task as paused', async () => {
    const calls: string[] = [];
    t = await startTestEngine({ script: [], route: (_b, _t, provider) => { calls.push(provider); return [{ text: 'should not run' }]; } });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: 'mock/claude-sonnet-5-5' });
      t.engine.patchMeta(s.id, { limits: { fallback: { costUsd: 0 } } });
      await t.run(s.id, 'answer');
      expect(calls).toEqual([]);
      expect(JSON.stringify(t.engine.getMessages(s.id))).toContain('Task paused');
      expect(t.engine.requireSession(s.id).status).toBe('paused');
    } finally { await t.close(); }
  }, 30_000);

  test('a subagent fallback the policy does not allow leaves the error standing', async () => {
    const isChild = (body: { messages?: unknown[] }) => firstUserText(body as never).includes('CHILD-JOB');
    t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'child job', prompt: 'CHILD-JOB: check it', subagent_type: 'verifier' } }], [{ text: 'done' }]],
      extraProviders: { gone: ['claude-opus-5-5'] },
      overrides: { models: { tiers: { fast: 'mock/claude-sonnet-5-5', deep: 'gone/claude-opus-5-5' } } } as never,
      route: (body, _text, provider) => {
        if (!isChild(body)) return undefined;
        return provider === 'gone' ? { status: 404, type: 'not_found_error', error: 'model: claude-opus-5-5' } : [{ text: 'VERDICT: confirmed' }];
      },
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass' });
      t.engine.patchMeta(s.id, { limits: { fallback: { providers: ['gone'] } } });
      await t.run(s.id, 'verify it');
      const child = t.engine.listSessions({ parentId: s.id })[0];
      expect(child.model).toBe('gone/claude-opus-5-5');
      expect(JSON.stringify(t.engine.getMessages(child.id))).toContain('Not moving to mock/claude-sonnet-5-5');
      expect(t.requestProviders.filter((p, i) => p === 'mock' && isChild(JSON.parse(t.requests[i])))).toHaveLength(0);
      expect(toolResults(t.engine, s.id).find((r) => r.name === 'Task')!.isError).toBe(true);
    } finally { await t.close(); }
  }, 30_000);

  test('chores cannot retry onto a disallowed paid destination', async () => {
    t = await startTestEngine({ script: [[{ text: 'done' }]], chore: () => 429, extraProviders: { mock2: ['claude-sonnet-5-5'] } });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      sid = s.id;
      t.engine.config.update({ limits: { ...t.engine.config.get().limits, maxRetries: 0, fallbacks: { mock: ['mock2/claude-sonnet-5-5'] } } });
      policy({ providers: ['mock'] });
      await expect(completeText(t.engine, { model: s.model, prompt: 'hi', sessionId: sid })).rejects.toBeInstanceOf(ProviderError);
      expect(t.chores).toHaveLength(1);
      expect(t.engine.getSession(sid)!.meta?.autoSwitches).toBeUndefined();
    } finally { await t.close(); }
  });

  test('an automatic switch is recorded on the session and in the audit log', async () => {
    t = await startTestEngine({ script: [[{ text: 'done' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      sid = s.id;
      recordAutoSwitch(t.engine, sid, 'mock/claude-sonnet-5-5', 'mock2/claude-sonnet-5-5', { estimateUsd: 0.12, paid: true });
      recordAutoSwitch(t.engine, sid, 'mock2/claude-sonnet-5-5', 'mock/claude-sonnet-5-5');
      const meta = t.engine.getSession(sid)!.meta!.autoSwitches as Array<Record<string, unknown>>;
      expect(meta).toHaveLength(2);
      expect(meta[0]).toMatchObject({ from: 'mock/claude-sonnet-5-5', to: 'mock2/claude-sonnet-5-5', estimateUsd: 0.12, paid: true });
      expect(t.engine.listAudit({ sessionId: sid }).some((a) => a.action === 'switch' && a.detail.includes('mock2/claude-sonnet-5-5'))).toBe(true);
    } finally {
      await t.close();
    }
  });

  test('the refusal walk skips a destination the policy does not allow', async () => {
    t = await startTestEngine({ script: [[{ text: 'done' }]], extraProviders: { mock2: ['claude-sonnet-5-5'] } });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      sid = s.id;
      const target: FallbackTarget = { index: 0, entry: { model: 'mock2/claude-sonnet-5-5' }, ref: 'mock2/claude-sonnet-5-5', label: '' };
      expect(usable(t.engine, s, target)).toBe(true);
      policy({ providers: ['mock'] });
      expect(usable(t.engine, t.engine.getSession(sid)!, target)).toBe(false);
    } finally {
      await t.close();
    }
  });
});
