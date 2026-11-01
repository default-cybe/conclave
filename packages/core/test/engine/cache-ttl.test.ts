import { describe, expect, test } from 'bun:test';
import { startTestEngine } from './harness';
import { cacheTtlFor } from '../../src/session/runner';

/** Prompt cache lifetime: 5m where nobody waits on the turn, 1h in interactive sessions, or what config says. */
const ttls = (body: string) => [...new Set((body.match(/"cache_control":\{[^}]*\}/g) ?? []).map((m) => JSON.parse(m.slice('"cache_control":'.length)).ttl ?? 'none'))];

describe('cache ttl', () => {
  test('auto: headless and unattended runs get 5m, interactive sessions 1h; a set value wins', () => {
    expect(cacheTtlFor('auto', true)).toBe('5m');
    expect(cacheTtlFor(undefined, false)).toBe('1h');
    expect(cacheTtlFor('5m', false)).toBe('5m');
    expect(cacheTtlFor('1h', true)).toBe('1h');
  });

  test('a conclave run session sends 5m on every breakpoint; an interactive one sends 1h', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      const headless = await t.engine.createSession({ title: 't', cwd: t.cwd, tags: ['cli-run'] });
      await t.run(headless.id, 'hi');
      expect(ttls(t.requests[0])).toEqual(['5m']);
      const app = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(app.id, 'hi');
      expect(ttls(t.requests[1])).toEqual(['1h']);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a workflow step (tagged workflow) sends 5m', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      const step = await t.engine.createSession({ title: 't', cwd: t.cwd, tags: ['subagent', 'workflow'] });
      await t.run(step.id, 'hi');
      expect(ttls(t.requests[0])).toEqual(['5m']);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('cache.ttl 5m applies to interactive sessions too', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]], overrides: { cache: { ttl: '5m' } } as never });
    try {
      const app = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(app.id, 'hi');
      expect(ttls(t.requests[0])).toEqual(['5m']);
    } finally {
      await t.close();
    }
  }, 30_000);
});
