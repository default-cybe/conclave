/**
 * Pause and Resume (engine.pauseSession, resumeSession): the tool call in
 * progress finishes, the turn stops before its next model call with status
 * paused, a restart keeps it, and Resume goes on with no new user message.
 */
import { describe, expect, test } from 'bun:test';
import type { Message } from '../../src/types';
import { INTERRUPTED } from '../../src/session/runner';
import { startTestEngine, until, type TestEngine } from '../engine/harness';
import { reopen } from '../workflows/helpers';

const bash = (command: string) => [{ tool: 'Bash', input: { command, description: 'wait' } }];

const userTexts = (msgs: Message[]) =>
  msgs.filter((m) => m.role === 'user' && m.kind === 'normal').flatMap((m) => m.content.filter((b) => b.type === 'text' && !b.text.startsWith('<system-reminder>')).map((b) => (b as { text: string }).text));

/** The last message of a request's transcript holds only tool results: no new user text came with it. */
function endsOnToolResults(body: string): boolean {
  const msgs = (JSON.parse(body).messages ?? []) as Array<{ role: string; content: unknown }>;
  const last = msgs[msgs.length - 1];
  return last?.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result') && !last.content.some((b) => b.type === 'text' && !String(b.text).startsWith('<system-reminder>'));
}

const resultText = (msgs: Message[]) =>
  msgs.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => String((b as { content: unknown }).content));

async function pausedMidTool(t: TestEngine): Promise<string> {
  const s = await t.engine.createSession({ title: 'pause', cwd: t.cwd });
  await t.engine.send(s.id, { text: 'go' });
  // the Bash call runs: the model's first reply is stored
  expect(await until(() => t.engine.getMessages(s.id).some((m) => m.content.some((b) => b.type === 'tool_use')), 10_000)).toBe(true);
  t.engine.pauseSession(s.id);
  expect(await until(() => t.engine.getSession(s.id)?.status === 'paused', 10_000)).toBe(true);
  return s.id;
}

describe('pause and resume a session', () => {
  test('pause lets the running call finish and stops before the next model call; resume goes on with no new user message', async () => {
    const t = await startTestEngine({ script: [bash('sleep 0.6; echo FIRST-DONE'), [{ text: 'step two' }], [{ text: 'queued answer' }]], approve: 'allow' });
    try {
      const id = await pausedMidTool(t);
      // the call finished on its own, not cut
      expect(resultText(t.engine.getMessages(id)).some((r) => r.includes('FIRST-DONE'))).toBe(true);
      await Bun.sleep(300);
      expect(t.requests.length).toBe(1);
      // a message sent while paused queues and does not run
      expect((await t.engine.send(id, { text: 'later' })).queued).toBe(true);
      await Bun.sleep(200);
      expect(t.requests.length).toBe(1);
      expect(t.engine.getSession(id)?.status).toBe('paused');

      await t.engine.resumeSession(id);
      expect(await until(() => t.requests.length === 3 && t.engine.getSession(id)?.status === 'idle', 10_000)).toBe(true);
      // the cut turn went on from the tool result; the queued message ran after it
      expect(endsOnToolResults(t.requests[1])).toBe(true);
      expect(userTexts(t.engine.getMessages(id))).toEqual(['go', 'later']);
    } finally {
      await t.close();
    }
  });

  test('a call past the grace time is cut and answered as interrupted', async () => {
    const t = await startTestEngine({ script: [bash('sleep 20'), [{ text: 'after' }]], approve: 'allow' });
    try {
      const s = await t.engine.createSession({ title: 'pause', cwd: t.cwd });
      await t.engine.send(s.id, { text: 'go' });
      expect(await until(() => t.engine.getMessages(s.id).some((m) => m.content.some((b) => b.type === 'tool_use')), 10_000)).toBe(true);
      const started = Date.now();
      t.engine.runnerFor(s.id).pause(200);
      expect(await until(() => t.engine.getSession(s.id)?.status === 'paused', 10_000)).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
      // Bash answers a cut command itself; a tool that does not gets INTERRUPTED
      expect(resultText(t.engine.getMessages(s.id)).some((r) => r === INTERRUPTED || /interrupted/i.test(r))).toBe(true);
      expect(t.requests.length).toBe(1);
      await t.engine.resumeSession(s.id);
      expect(await until(() => t.requests.length === 2 && t.engine.getSession(s.id)?.status === 'idle', 10_000)).toBe(true);
      expect(endsOnToolResults(t.requests[1])).toBe(true);
    } finally {
      await t.close();
    }
  });

  test('paused survives a restart: boot keeps it paused, and Resume goes on there', async () => {
    const t = await startTestEngine({ script: [bash('sleep 0.3; echo OK'), [{ text: 'resumed after restart' }]], approve: 'allow' });
    try {
      const id = await pausedMidTool(t);
      await t.engine.shutdown();
      t.engine = await reopen(t);
      expect(t.engine.getSession(id)?.status).toBe('paused');
      expect(t.engine.busyWork().some((w) => w.id === id)).toBe(false);
      expect(t.requests.length).toBe(1);
      await t.engine.resumeSession(id);
      expect(await until(() => t.requests.length === 2 && t.engine.getSession(id)?.status === 'idle', 10_000)).toBe(true);
      expect(endsOnToolResults(t.requests[1])).toBe(true);
      expect(userTexts(t.engine.getMessages(id))).toEqual(['go']);
    } finally {
      await t.close();
    }
  });

  test('Resume after Stop: a new turn on the stored transcript with a continue reminder and no new user text', async () => {
    const t = await startTestEngine({ script: [bash('sleep 20'), [{ text: 'continued' }]], approve: 'allow' });
    try {
      const s = await t.engine.createSession({ title: 'stop', cwd: t.cwd });
      await t.engine.send(s.id, { text: 'go' });
      expect(await until(() => t.engine.getMessages(s.id).some((m) => m.content.some((b) => b.type === 'tool_use')), 10_000)).toBe(true);
      t.engine.abort(s.id);
      expect(await until(() => t.engine.getSession(s.id)?.status === 'idle' && t.engine.getSession(s.id)?.meta?.stoppedTurn === true, 10_000)).toBe(true);
      expect(t.requests.length).toBe(1);
      await t.engine.resumeSession(s.id);
      expect(await until(() => t.requests.length === 2 && t.engine.getSession(s.id)?.status === 'idle', 10_000)).toBe(true);
      expect(t.requests[1]).toContain('has now resumed it');
      expect(userTexts(t.engine.getMessages(s.id))).toEqual(['go']);
      // the new turn used up the stop: a second Resume is refused
      expect(t.engine.getSession(s.id)?.meta?.stoppedTurn).toBeUndefined();
      await expect(t.engine.resumeSession(s.id)).rejects.toThrow(/not paused or stopped/);
    } finally {
      await t.close();
    }
  });

  test('a restart that cut a turn: Resume on the main session continues it, a Task child gets none', async () => {
    const t = await startTestEngine({ script: [[{ text: 'continued' }]] });
    try {
      const top = await t.engine.createSession({ title: 'top', cwd: t.cwd });
      const child = await t.engine.createSession({ title: 'child', cwd: t.cwd, parentId: top.id });
      // the hub went down mid-turn: boot finds both still running
      for (const s of [top, child]) t.engine.repos.sessions.update({ ...t.engine.getSession(s.id)!, status: 'running' });
      await t.engine.shutdown();
      t.engine = await reopen(t);
      expect(t.engine.getSession(top.id)?.meta?.stoppedTurn).toBe(true);
      expect(t.engine.getSession(child.id)?.status).toBe('idle');
      expect(t.engine.getSession(child.id)?.meta?.stoppedTurn).toBeUndefined();
      await expect(t.engine.resumeSession(child.id)).rejects.toThrow(/not paused or stopped/);
      await t.engine.resumeSession(top.id);
      expect(await until(() => t.requests.length === 1 && t.engine.getSession(top.id)?.status === 'idle', 10_000)).toBe(true);
      expect(t.requests[0]).toContain('has now resumed it');
    } finally {
      await t.close();
    }
  });

  test('rewind of a running turn leaves nothing for Resume after Stop', async () => {
    const t = await startTestEngine({ script: [bash('sleep 20')], approve: 'allow' });
    try {
      const s = await t.engine.createSession({ title: 'rewind', cwd: t.cwd });
      await t.engine.send(s.id, { text: 'go' });
      expect(await until(() => t.engine.getMessages(s.id).some((m) => m.content.some((b) => b.type === 'tool_use')), 10_000)).toBe(true);
      await t.engine.rewind(s.id, t.engine.getMessages(s.id)[0].seq);
      // the cut turn's catch has run by now
      expect(await until(() => !t.engine.busyWork().some((w) => w.id === s.id), 10_000)).toBe(true);
      await Bun.sleep(100);
      expect(t.engine.getSession(s.id)?.status).toBe('idle');
      expect(t.engine.getSession(s.id)?.meta?.stoppedTurn).toBeUndefined();
      await expect(t.engine.resumeSession(s.id)).rejects.toThrow(/not paused or stopped/);
    } finally {
      await t.close();
    }
  });

  test('pausing a session with nothing running is refused', async () => {
    const t = await startTestEngine({ script: [[{ text: 'hi' }]] });
    try {
      const s = await t.engine.createSession({ title: 'idle', cwd: t.cwd });
      expect(() => t.engine.pauseSession(s.id)).toThrow(/Nothing is running/);
      await expect(t.engine.resumeSession(s.id)).rejects.toThrow(/not paused/);
    } finally {
      await t.close();
    }
  });
});
