import { describe, expect, test } from 'bun:test';
import { alertsOf, liveAlerts } from '../../src/alerts/attached';
import type { AlertItem } from '../../src/client/alerts';
import type { EngineEventEnvelope, Notice } from '../../src/types';
import { firstUserText, startTestEngine, toolResults, until, type TestEngine } from './harness';
import { noHarnesses, svcOf } from '../workflows/helpers';

/**
 * Stuck turns on the scripted engine (docs/DESIGN.md 28): no progress for the
 * threshold, a tool inside its own time limit, Keep waiting, the loop rule,
 * and the item clearing itself. The checks call tick() with a clock moved
 * forward instead of waiting minutes.
 */

const MIN = 60_000;

function watch(t: TestEngine) {
  const raised: AlertItem[] = [];
  const cleared: string[] = [];
  const notices: Notice[] = [];
  t.engine.bus.on((e: EngineEventEnvelope) => {
    if (e.type === 'alert.raised') raised.push(e.alert);
    if (e.type === 'alert.cleared') cleared.push(e.id);
    if (e.type === 'notice' && e.notice.alertId) notices.push(e.notice);
  });
  return { raised, cleared, notices };
}

/** Start a turn without waiting for it, and wait until the session runs. `done` resolves when the turn ends. */
async function start(t: TestEngine, sessionId: string, text: string): Promise<{ done: Promise<void> }> {
  const runner = t.engine.runnerFor(sessionId);
  await runner.enqueue({ text });
  await until(() => t.engine.getSession(sessionId)?.status === 'running', 5_000);
  return { done: runner.waitIdle() };
}

describe('stuck turns', () => {
  test('no progress past the threshold raises one item and a notification; progress clears it', async () => {
    const t = await startTestEngine({
      // the model takes a while before its first token
      script: [{ blocks: [{ text: 'here you go' }], delayMs: 1_500 }],
    });
    try {
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      const s = await t.engine.createSession({ title: 'Fix login', cwd: t.cwd });
      const turn = await start(t, s.id, 'go');

      svc.tick(Date.now() + 4 * MIN);
      expect(w.raised).toHaveLength(0);
      svc.tick(Date.now() + 6 * MIN);
      expect(w.raised).toHaveLength(1);
      const item = w.raised[0];
      expect(item).toMatchObject({ kind: 'stuck', reason: 'idle', sessionId: s.id, text: "No progress in 'Fix login' for 6 min", thresholdMs: 5 * MIN });
      expect(w.notices).toHaveLength(1);
      expect(w.notices[0]).toMatchObject({ title: s.title, alertId: item.id, sessionId: s.id });
      expect(w.notices[0].body).toStartWith('No progress for ');
      expect(liveAlerts(t.engine).stuck[s.id]).toEqual({ stuckSince: item.since!, reason: 'idle' });
      // one item: later checks do not raise another
      svc.tick(Date.now() + 9 * MIN);
      expect(w.raised).toHaveLength(1);

      // the first streamed token is progress: the item clears itself
      await turn.done;
      expect(w.cleared).toEqual([item.id]);
      expect(svc.list()).toHaveLength(0);
      expect(liveAlerts(t.engine).stuck).toEqual({});
    } finally {
      await t.close();
    }
  }, 60_000);

  test('the turn ending clears the item, and a model can have its own threshold', async () => {
    const t = await startTestEngine({
      script: [{ blocks: [{ text: 'late' }], delayMs: 1_500 }],
      overrides: { limits: { autoResume: true, resumePrompt: '', fallbacks: {}, maxRetries: 0, stuck: { minutes: 5, models: { 'mock/claude-sonnet-5-5': 20 } } } },
    });
    try {
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      expect(svc.thresholdMs('mock/claude-sonnet-5-5')).toBe(20 * MIN);
      expect(svc.thresholdMs('other/model')).toBe(5 * MIN);
      const s = await t.engine.createSession({ title: 'Slow model', cwd: t.cwd });
      const turn = await start(t, s.id, 'go');
      svc.tick(Date.now() + 10 * MIN);
      expect(w.raised).toHaveLength(0);
      svc.tick(Date.now() + 21 * MIN);
      expect(w.raised).toHaveLength(1);
      // Stop ends the turn; the item goes with it
      expect(svc.act(w.raised[0].id, 'dismiss')).toBe('bad');
      expect(svc.act(w.raised[0].id, 'stop')).toBe('ok');
      await turn.done;
      expect(t.engine.getSession(s.id)!.status).toBe('idle');
      expect(w.cleared).toEqual([w.raised[0].id]);
      expect(svc.list()).toHaveLength(0);
      // after the turn nothing is watched
      svc.tick(Date.now() + 60 * MIN);
      expect(w.raised).toHaveLength(1);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a tool still running inside its own time limit is not stuck', async () => {
    const t = await startTestEngine({
      script: [[{ tool: 'Bash', input: { command: 'sleep 2', timeout: 600_000, description: 'Wait' } }], [{ text: 'done' }]],
    });
    try {
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      const s = await t.engine.createSession({ title: 'Long build', cwd: t.cwd, permissionMode: 'bypass' });
      const turn = await start(t, s.id, 'build');
      expect(await until(() => t.engine.getMessages(s.id).some((m) => m.content.some((b) => b.type === 'tool_use')), 5_000)).toBe(true);
      // 6 minutes in, the command is inside its 10 minute limit
      svc.tick(Date.now() + 6 * MIN);
      expect(w.raised).toHaveLength(0);
      // past its own limit it counts as stuck
      svc.tick(Date.now() + 11 * MIN);
      expect(w.raised).toHaveLength(1);
      await turn.done;
      expect(svc.list()).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('Keep waiting doubles the threshold for that turn', async () => {
    const t = await startTestEngine({
      script: [{ blocks: [{ text: 'ok' }], delayMs: 1_500 }],
    });
    try {
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      const s = await t.engine.createSession({ title: 'Fix login', cwd: t.cwd });
      const turn = await start(t, s.id, 'go');
      svc.tick(Date.now() + 6 * MIN);
      expect(w.raised).toHaveLength(1);
      expect(svc.act(w.raised[0].id, 'wait')).toBe('ok');
      expect(svc.list()).toHaveLength(0);
      expect(w.cleared).toEqual([w.raised[0].id]);
      // the threshold is 10 minutes now
      svc.tick(Date.now() + 9 * MIN);
      expect(w.raised).toHaveLength(1);
      svc.tick(Date.now() + 11 * MIN);
      expect(w.raised).toHaveLength(2);
      expect(w.raised[1]).toMatchObject({ thresholdMs: 10 * MIN, text: "No progress in 'Fix login' for 11 min" });
      await turn.done;
      expect(svc.list()).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('waiting on an approval is not stuck', async () => {
    const t = await startTestEngine({ script: [[{ text: 'done' }]] });
    try {
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      // the statuses a turn goes through while an approval waits (the harness answers approvals at once)
      const s = await t.engine.createSession({ title: 'Ask first', cwd: t.cwd });
      t.engine.setStatus(s.id, 'running');
      t.engine.setStatus(s.id, 'waiting_approval');
      svc.tick(Date.now() + 30 * MIN);
      expect(w.raised).toHaveLength(0);
      // back to work: the clock starts over
      t.engine.setStatus(s.id, 'running');
      svc.tick(Date.now() + 4 * MIN);
      expect(w.raised).toHaveLength(0);
      svc.tick(Date.now() + 6 * MIN);
      expect(w.raised).toHaveLength(1);
      t.engine.setStatus(s.id, 'idle');
      expect(svc.list()).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('the same tool failing the same way 3 times in a row is a loop; another outcome clears it', async () => {
    const fail = { tool: 'Bash', input: { command: 'exit 3', description: 'Try' } };
    const t = await startTestEngine({
      script: [[fail], [fail], [fail], [{ tool: 'Bash', input: { command: 'true', description: 'Pass' } }], [{ text: 'done' }]],
    });
    try {
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      const s = await t.engine.createSession({ title: 'Fix login', cwd: t.cwd, permissionMode: 'bypass' });
      await t.run(s.id, 'go');
      const loops = w.raised.filter((a) => a.reason === 'loop');
      expect(loops).toHaveLength(1);
      expect(loops[0]).toMatchObject({ kind: 'stuck', sessionId: s.id, tool: 'Bash', count: 3, text: "'Fix login' may be in a loop: Bash failed the same way 3 times" });
      expect(loops[0].error).toContain('Exit code 3');
      expect(w.notices.find((n) => n.alertId === loops[0].id)?.body).toStartWith('Possible loop: ');
      // the passing call cleared it
      expect(w.cleared).toContain(loops[0].id);
      expect(svc.list()).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('Keep waiting on a loop waits for twice as many failures, and the turn ending clears it', async () => {
    // six different commands that fail the same way (the loop guard stops a repeat of one call before that)
    const fails = ['exit 4', 'exit  4', '(exit 4)', 'exit 4;', 'sh -c "exit 4"', '{ exit 4; }'].map((command) => [{ tool: 'Bash', input: { command, description: 'Try' } }]);
    const t = await startTestEngine({ script: [...fails, { blocks: [{ text: 'giving up' }], delayMs: 800 }] });
    try {
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      // Keep waiting the moment the first loop item lands
      t.engine.bus.on((e: EngineEventEnvelope) => {
        if (e.type === 'alert.raised' && e.alert.reason === 'loop' && e.alert.count === 3) queueMicrotask(() => svc.act(e.alert.id, 'wait'));
      });
      const s = await t.engine.createSession({ title: 'Fix login', cwd: t.cwd, permissionMode: 'bypass' });
      const turn = await start(t, s.id, 'go');
      expect(await until(() => w.raised.length === 2, 10_000)).toBe(true);
      expect(w.raised.map((a) => a.count)).toEqual([3, 6]);
      await turn.done;
      expect(w.cleared).toEqual(w.raised.map((a) => a.id));
      expect(svc.list()).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  describe('a subagent whose provider never answers', () => {
    const isChild = (body: { messages?: unknown[] }) => firstUserText(body).includes('CHILD-JOB');
    const hang = { blocks: [{ text: 'never sent' }], delayMs: 600_000 };
    // verifier is model: deep; the deep tier is the provider that goes quiet, the parent runs on mock
    const setup = (route: (provider: string) => typeof hang | { blocks: Array<{ text: string }> }) =>
      startTestEngine({
        script: [[{ tool: 'Task', input: { description: 'child job', prompt: 'CHILD-JOB: check it', subagent_type: 'verifier' } }], [{ text: 'parent done' }]],
        extraProviders: { quiet: ['claude-sonnet-5-5'] },
        overrides: { models: { tiers: { fast: 'mock/claude-sonnet-5-5', deep: 'quiet/claude-sonnet-5-5' } } } as never,
        route: (body, _text, provider) => (isChild(body) ? route(provider) : undefined),
      });
    const childCalls = (t: TestEngine, provider: string) => t.requests.filter((r, i) => t.requestProviders[i] === provider && r.includes('CHILD-JOB')).length;

    test('fails over to the parent model once, with no Inbox item', async () => {
      const t = await setup((provider) => (provider === 'quiet' ? hang : { blocks: [{ text: 'VERDICT: confirmed' }] }));
      try {
        const w = watch(t);
        const svc = alertsOf(t.engine)!;
        const s = await t.engine.createSession({ title: 'Parent', cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass' });
        const turn = await start(t, s.id, 'verify it');
        expect(await until(() => childCalls(t, 'quiet') === 1, 10_000)).toBe(true);
        svc.tick(Date.now() + 6 * MIN);
        expect(await Promise.race([turn.done.then(() => true), Bun.sleep(15_000).then(() => false)])).toBe(true);
        const child = t.engine.listSessions({ parentId: s.id })[0];
        expect(child.model).toBe('mock/claude-sonnet-5-5');
        const warnings = t.engine.getMessages(child.id).filter((m) => m.kind === 'notice' && m.meta?.level === 'warning');
        expect(JSON.stringify(warnings.map((m) => m.content))).toContain('quiet/claude-sonnet-5-5 made no progress');
        const res = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
        expect(res.isError).toBe(false);
        expect(res.content).toContain('VERDICT: confirmed');
        expect(w.raised).toHaveLength(0);
      } finally {
        await t.close();
      }
    }, 60_000);

    test('when the fallback is quiet too, the parent gets an error result', async () => {
      const t = await setup(() => hang);
      try {
        const w = watch(t);
        const svc = alertsOf(t.engine)!;
        const s = await t.engine.createSession({ title: 'Parent', cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass' });
        const turn = await start(t, s.id, 'verify it');
        expect(await until(() => childCalls(t, 'quiet') === 1, 10_000)).toBe(true);
        svc.tick(Date.now() + 6 * MIN);
        expect(await until(() => childCalls(t, 'mock') === 1, 10_000)).toBe(true);
        // the fallback gets a full threshold of its own, counted from the failover
        svc.tick(Date.now() + 10 * MIN);
        expect(childCalls(t, 'mock')).toBe(1);
        svc.tick(Date.now() + 13 * MIN);
        expect(await Promise.race([turn.done.then(() => true), Bun.sleep(15_000).then(() => false)])).toBe(true);
        const res = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
        expect(res.isError).toBe(true);
        expect(res.content).toContain('made no progress past the stuck threshold');
        expect(t.engine.listSessions({ parentId: s.id })[0].status).toBe('idle');
        expect(w.raised).toHaveLength(0);
      } finally {
        await t.close();
      }
    }, 60_000);

    test('a stall while a tool with no time limit runs names the tool and does not fail over', async () => {
      const t = await setup((provider) => (provider === 'quiet' ? hang : { blocks: [{ text: 'VERDICT: confirmed' }] }));
      try {
        const w = watch(t);
        const svc = alertsOf(t.engine)!;
        const s = await t.engine.createSession({ title: 'Parent', cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass' });
        const turn = await start(t, s.id, 'verify it');
        expect(await until(() => childCalls(t, 'quiet') === 1, 10_000)).toBe(true);
        const child = t.engine.listSessions({ parentId: s.id })[0];
        // a tool with no timeoutMs (an MCP tool) still running when the check comes
        t.engine.bus.emit({ type: 'tool.started', sessionId: child.id, messageId: 'msg_x', toolUseId: 'tu_slow', name: 'mcp__slow__op', input: {} });
        svc.tick(Date.now() + 6 * MIN);
        expect(await Promise.race([turn.done.then(() => true), Bun.sleep(15_000).then(() => false)])).toBe(true);
        expect(t.engine.getSession(child.id)!.model).toBe('quiet/claude-sonnet-5-5');
        const res = toolResults(t.engine, s.id).find((r) => r.name === 'Task')!;
        expect(res.isError).toBe(true);
        expect(res.content).toContain('the mcp__slow__op tool made no progress past the stuck threshold');
        expect(w.raised).toHaveLength(0);
      } finally {
        await t.close();
      }
    }, 60_000);

    test('when the cut does not end the loop, the next check raises the Inbox item', async () => {
      const t = await setup(() => hang);
      try {
        const w = watch(t);
        const svc = alertsOf(t.engine)!;
        const s = await t.engine.createSession({ title: 'Parent', cwd: t.cwd, agent: 'general-purpose', permissionMode: 'bypass' });
        await start(t, s.id, 'verify it');
        expect(await until(() => childCalls(t, 'quiet') === 1, 10_000)).toBe(true);
        const child = t.engine.listSessions({ parentId: s.id })[0];
        // as if an earlier cut had not ended the loop (a tool that ignores its signal)
        t.engine.runnerFor(child.id).stalled = {};
        svc.tick(Date.now() + 6 * MIN);
        expect(w.raised).toHaveLength(1);
        expect(w.raised[0]).toMatchObject({ kind: 'stuck', reason: 'idle', sessionId: child.id });
        t.engine.runnerFor(child.id).abort();
      } finally {
        await t.close();
      }
    }, 60_000);
  });

  test('a workflow agent that stalls fails its call with the stall', async () => {
    const t = await startTestEngine({
      script: [[{ text: 'fallback' }]],
      route: (body) => (firstUserText(body).includes('WF-JOB') ? { blocks: [{ text: 'never sent' }], delayMs: 600_000 } : undefined),
    });
    try {
      noHarnesses(t.engine);
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      const wf = svcOf(t.engine);
      const s = await t.engine.createSession({ cwd: t.cwd, permissionMode: 'bypass' });
      const run = await wf.startRun({ script: `export const meta = { name: 'stall', description: 'one call' }\nreturn await agent('WF-JOB: check it')`, sessionId: s.id });
      expect(await until(() => t.requests.some((r) => r.includes('WF-JOB')), 10_000)).toBe(true);
      svc.tick(Date.now() + 6 * MIN);
      const done = await Promise.race([wf.wait(run.id), Bun.sleep(15_000).then(() => undefined)]);
      expect(done?.status).toBe('done');
      const call = wf.store.calls(run.id).find((c) => c.prompt?.includes('WF-JOB'));
      expect(call?.state).toBe('failed');
      expect(call?.error).toContain('made no progress past the stuck threshold');
      expect(w.raised).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a background subagent that stalls reports an error to its parent', async () => {
    const t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'bg job', prompt: 'BG-JOB: check it', subagent_type: 'general-purpose', run_in_background: true } }], [{ text: 'waiting' }], [{ text: 'saw the failure' }]],
      route: (body) => (firstUserText(body).includes('BG-JOB') ? { blocks: [{ text: 'never sent' }], delayMs: 600_000 } : undefined),
    });
    try {
      const w = watch(t);
      const svc = alertsOf(t.engine)!;
      const s = await t.engine.createSession({ title: 'Parent', cwd: t.cwd, permissionMode: 'bypass' });
      t.engine.runnerFor(s.id).noteDelayMs = 50;
      await t.run(s.id, 'start');
      expect(await until(() => t.requests.some((r) => r.includes('BG-JOB')), 10_000)).toBe(true);
      // the child runs on the parent's model: nothing to fail over to
      svc.tick(Date.now() + 6 * MIN);
      const child = t.engine.listSessions({ parentId: s.id })[0];
      expect(await until(() => (child && (t.engine.getSession(child.id)?.meta?.background as { state?: string })?.state) === 'error', 10_000)).toBe(true);
      const notices = t.engine.getMessages(s.id).filter((m) => m.kind === 'notice');
      expect(JSON.stringify(notices.map((m) => m.content))).toContain('Background task failed: bg job');
      expect(await until(() => t.requests.some((r) => !firstUserText(JSON.parse(r)).includes('BG-JOB') && r.includes('made no progress past the stuck threshold')), 10_000)).toBe(true);
      expect(w.raised).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);

  test('a threshold of 0 turns the check off', async () => {
    const t = await startTestEngine({
      script: [{ blocks: [{ text: 'ok' }], delayMs: 1_000 }],
      overrides: { limits: { autoResume: true, resumePrompt: '', fallbacks: {}, maxRetries: 0, stuck: { minutes: 0 } } },
    });
    try {
      const w = watch(t);
      const s = await t.engine.createSession({ title: 'Quiet', cwd: t.cwd });
      const turn = await start(t, s.id, 'go');
      alertsOf(t.engine)!.tick(Date.now() + 120 * MIN);
      await turn.done;
      expect(w.raised).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 60_000);
});
