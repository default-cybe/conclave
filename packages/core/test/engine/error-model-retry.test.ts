import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestEngine } from './harness';
import { createEngine } from '../../src/engine';

const FROM = 'mock/claude-sonnet-5-5';
const TO = 'other/claude-sonnet-5-5';

describe('provider inference retry', () => {
  test('credential failures never offer alternate retry or masquerade as refusals', async () => {
    const t = await startTestEngine({ script: [], route: () => 401, overrides: { limits: { maxRetries: 0 } } as never });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM });
      await t.run(s.id, 'answer');
      const notice = t.engine.getMessages(s.id).at(-1)!;
      expect(notice.meta?.type).not.toBe('provider_error');
      expect(notice.meta?.type).not.toBe('refusal');
      await expect(t.engine.retryProvider(s.id, notice.id, FROM)).rejects.toThrow('no longer available');
    } finally { await t.close(); }
  }, 30_000);

  test('same session, full transcript, no duplicate prompt or completed side effect replay; stale retry rejected', async () => {
    let n = 0;
    const t = await startTestEngine({
      script: [], approve: 'allow', extraProviders: { other: ['claude-sonnet-5-5'] },
      overrides: { limits: { maxRetries: 0 } } as never,
      route: (_body, _text, provider) => {
        if (provider === 'other') return [{ text: 'continued' }];
        if (++n === 1) return [{ tool: 'Bash', input: { command: "printf x >> count", description: 'Write one side effect marker' } }];
        return { status: 400, error: 'thinking blocks cannot be modified' };
      },
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM, permissionMode: 'bypass' });
      await t.run(s.id, 'Write marker then answer');
      const before = t.engine.getMessages(s.id);
      const notice = before.at(-1)!;
      expect(notice.meta).toMatchObject({ type: 'provider_error', canRetry: true });
      const toolResults = before.filter((m) => m.content.some((b) => b.type === 'tool_result'));
      expect(toolResults).toHaveLength(1);
      expect(await readFile(join(t.cwd, 'count'), 'utf8')).toBe('x');
      await t.engine.handoff(s.id, TO);
      t.engine.notice(s.id, 'Incidental status update', 'info');
      expect(await t.engine.retryProvider(s.id, notice.id, TO)).toEqual({ model: TO, label: t.engine.displayModel(TO) });
      await expect(t.engine.retryProvider(s.id, notice.id, TO)).rejects.toThrow('no longer available');
      await t.engine.runnerFor(s.id).waitIdle();
      const after = t.engine.getMessages(s.id);
      expect(after.filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text === 'Write marker then answer'))).toHaveLength(1);
      expect(after.filter((m) => m.content.some((b) => b.type === 'tool_result'))).toEqual(toolResults);
      expect(await readFile(join(t.cwd, 'count'), 'utf8')).toBe('x');
      expect(t.requests.at(-1)).toContain('tool_result');
      expect(t.requests.at(-1)).toContain('Write marker then answer');
      expect(t.engine.requireSession(s.id)).toMatchObject({ id: s.id, model: TO, permissionMode: 'bypass', mode: s.mode });
      await expect(t.engine.retryProvider(s.id, notice.id, TO)).rejects.toThrow('no longer available');
    } finally { await t.close(); }
  }, 30_000);

  test('a provider 500 retries once on the next fallback model; a second failure offers the button', async () => {
    const calls: string[] = [];
    let otherFails = false;
    const t = await startTestEngine({
      script: [], extraProviders: { other: ['claude-sonnet-5-5'] },
      overrides: { limits: { maxRetries: 0, fallbacks: { [FROM]: [TO] } } } as never,
      route: (_body, _text, provider) => {
        calls.push(provider);
        if (provider === 'other' && !otherFails) return [{ text: 'answered by other' }];
        return { status: 500, error: 'upstream exploded' };
      },
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM });
      await t.run(s.id, 'answer');
      await t.engine.runnerFor(s.id).waitIdle();
      expect(calls).toEqual(['mock', 'other']);
      const msgs = t.engine.getMessages(s.id);
      expect(msgs.find((m) => m.meta?.type === 'provider_retry')?.meta).toMatchObject({ from: FROM, to: TO });
      expect(msgs.some((m) => m.meta?.type === 'provider_error')).toBe(false);
      expect(JSON.stringify(msgs.at(-1)?.content)).toContain('answered by other');
      expect(t.engine.requireSession(s.id)).toMatchObject({ status: 'idle', model: FROM });

      calls.length = 0;
      otherFails = true;
      await t.run(s.id, 'again');
      await t.engine.runnerFor(s.id).waitIdle();
      expect(calls).toEqual(['mock', 'other']);
      expect(t.engine.getMessages(s.id).at(-1)?.meta).toMatchObject({ type: 'provider_error', canRetry: true });
      expect(t.engine.requireSession(s.id).status).toBe('error');
    } finally { await t.close(); }
  }, 30_000);

  test('no fallback configured: the button shows straight away', async () => {
    const calls: string[] = [];
    const t = await startTestEngine({
      script: [], extraProviders: { other: ['claude-sonnet-5-5'] },
      overrides: { limits: { maxRetries: 0 } } as never,
      route: (_body, _text, provider) => { calls.push(provider); return { status: 500, error: 'upstream exploded' }; },
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM });
      await t.run(s.id, 'answer');
      await t.engine.runnerFor(s.id).waitIdle();
      expect(calls).toEqual(['mock']);
      expect(t.engine.getMessages(s.id).some((m) => m.meta?.type === 'provider_retry')).toBe(false);
      expect(t.engine.getMessages(s.id).at(-1)?.meta).toMatchObject({ type: 'provider_error', canRetry: true });
    } finally { await t.close(); }
  }, 30_000);

  test('a source model the owner hid during the call never moves on its own', async () => {
    const calls: string[] = [];
    let hide = () => {};
    const t = await startTestEngine({
      script: [], extraProviders: { other: ['claude-sonnet-5-5'] },
      overrides: { limits: { maxRetries: 0, fallbacks: { [FROM]: [TO] } } } as never,
      route: (_body, _text, provider) => { calls.push(provider); hide(); return { status: 500, error: 'upstream exploded' }; },
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM });
      hide = () => t.engine.config.update({ models: { ...t.engine.config.get().models, hidden: [FROM] } } as never);
      await t.run(s.id, 'answer');
      await t.engine.runnerFor(s.id).waitIdle();
      expect(calls).toEqual(['mock']);
      expect(t.engine.getMessages(s.id).some((m) => m.meta?.type === 'provider_retry')).toBe(false);
      expect(t.engine.requireSession(s.id).status).toBe('error');
    } finally { await t.close(); }
  }, 30_000);

  test('the automatic retry skips a model that hit its limit earlier in the turn', async () => {
    const calls: string[] = [];
    const t = await startTestEngine({
      script: [], extraProviders: { other: ['claude-sonnet-5-5'] },
      overrides: { limits: { maxRetries: 0, fallbacks: { [FROM]: [TO], [TO]: [FROM] } } } as never,
      route: (_body, _text, provider) => { calls.push(provider); return provider === 'mock' ? 429 : { status: 500, error: 'upstream exploded' }; },
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM });
      await t.run(s.id, 'answer');
      await t.engine.runnerFor(s.id).waitIdle();
      expect(calls).toEqual(['mock', 'other']);
      expect(t.engine.getMessages(s.id).some((m) => m.meta?.type === 'provider_retry')).toBe(false);
      expect(t.engine.getMessages(s.id).at(-1)?.meta).toMatchObject({ type: 'provider_error', canRetry: true });
    } finally { await t.close(); }
  }, 30_000);

  test('steering sent during the failed call runs after the retry answers the turn', async () => {
    const calls: string[] = [];
    const t = await startTestEngine({
      script: [], extraProviders: { other: ['claude-sonnet-5-5'] },
      overrides: { limits: { maxRetries: 0, fallbacks: { [FROM]: [TO] } } } as never,
      route: (_body, _text, provider) => {
        calls.push(provider);
        return provider === 'other' ? [{ text: `answered ${calls.length}` }] : { status: 500, error: 'upstream exploded', delayMs: 300 };
      },
    });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM });
      await t.engine.send(s.id, { text: 'answer' });
      while (!calls.length) await Bun.sleep(10);
      await t.engine.send(s.id, { text: 'also this', whenBusy: 'steer' });
      await t.engine.runnerFor(s.id).waitIdle();
      expect(calls).toEqual(['mock', 'other', 'mock', 'other']);
      const texts = t.engine.getMessages(s.id).filter((m) => m.content.some((b) => b.type === 'text'))
        .map((m) => (m.content.find((b) => b.type === 'text') as { text: string }).text);
      expect(texts.filter((x) => ['answer', 'also this'].includes(x) || x.startsWith('answered'))).toEqual(['answer', 'answered 2', 'also this', 'answered 4']);
    } finally { await t.close(); }
  }, 30_000);

  test('disabled provider rejected without consuming a valid boundary', async () => {
    const t = await startTestEngine({ script: [], extraProviders: { other: ['claude-sonnet-5-5'] }, route: (_body, _text, provider) => provider === 'other' ? [{ text: 'continued' }] : 400 });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM });
      await t.run(s.id, 'answer');
      const notice = t.engine.getMessages(s.id).at(-1)!;
      const other = t.engine.config.get().providers.other;
      t.engine.config.update({ providers: { other: { ...other, enabled: false } } } as never);
      await expect(t.engine.retryProvider(s.id, notice.id, TO)).rejects.toThrow('disabled');
      expect(t.engine.getMessages(s.id).at(-1)?.meta?.canRetry).toBe(true);
      t.engine.config.update({ providers: { other: { ...other, enabled: true } } } as never);
      await t.engine.retryProvider(s.id, notice.id, TO);
      await t.engine.runnerFor(s.id).waitIdle();
      expect(t.engine.requireSession(s.id).status).toBe('idle');
    } finally { await t.close(); }
  }, 30_000);

  test('restart expires only advertised provider retry notices without rebuilding a boundary', async () => {
    const t = await startTestEngine({ script: [], route: () => 400 });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM });
      await t.run(s.id, 'answer');
      const before = t.engine.getMessages(s.id);
      const notice = before.at(-1)!;
      const providers = t.engine.config.get().providers;
      await t.engine.shutdown();
      const restarted = await createEngine({ home: t.home, noBackground: true, version: 'test', overrides: { providers } as never });
      try {
        const after = restarted.getMessages(s.id);
        expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
        expect(after.at(-1)?.meta).toMatchObject({ canRetry: false, retryExpired: true, type: 'provider_error' });
        expect(JSON.stringify(after.at(-1)?.content)).toContain('expired when the hub restarted');
        await expect(restarted.retryProvider(s.id, notice.id, FROM)).rejects.toThrow('no longer available');
      } finally { await restarted.shutdown(); }
    } finally { await t.close(); }
  }, 30_000);

  test('hidden models rejected before consuming retry; later messages invalidate notice', async () => {
    const t = await startTestEngine({ script: [], extraProviders: { other: ['claude-sonnet-5-5'] }, route: () => 400, overrides: { limits: { maxRetries: 0 } } as never });
    try {
      const s = await t.engine.createSession({ cwd: t.cwd, model: FROM });
      await t.run(s.id, 'answer');
      const notice = t.engine.getMessages(s.id).at(-1)!;
      t.engine.config.update({ models: { ...t.engine.config.get().models, hidden: [TO] } } as never);
      await expect(t.engine.retryProvider(s.id, notice.id, TO)).rejects.toThrow();
      expect(t.engine.getMessages(s.id).at(-1)?.meta?.canRetry).toBe(true);
      t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: 'new request' }] });
      await expect(t.engine.retryProvider(s.id, notice.id, FROM)).rejects.toThrow('no longer available');
    } finally { await t.close(); }
  }, 30_000);
});
