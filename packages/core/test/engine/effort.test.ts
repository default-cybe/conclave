import { describe, expect, test } from 'bun:test';
import { startTestEngine } from './harness';
import { takesEffort } from '../../src/providers/anthropic';

/**
 * Coding agents run at medium effort on models that take an effort level,
 * as Claude Code sends; the agent's own `thinking` and the session's
 * chat.thinking override it.
 */
const effortOf = (body: string) => JSON.parse(body).output_config?.effort ?? null;
const toolsOf = (body: string) => (JSON.parse(body).tools as Array<{ name: string }>).map((t) => t.name);

describe('default effort', () => {
  test('which models take an effort level', () => {
    expect(takesEffort('claude-sonnet-5-5')).toBe(true);
    expect(takesEffort('bench-claude/claude-opus-4-8')).toBe(true);
    expect(takesEffort('claude-sonnet-4-5-20250929')).toBe(false);
    expect(takesEffort('glm-5')).toBe(false);
  });

  test('coder: medium by default, the session switch wins, and its tool list leaves out LS, MultiEdit, RepoMap and EnterPlanMode', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    try {
      const coder = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'coder' });
      await t.run(coder.id, 'hi');
      expect(effortOf(t.requests[0])).toBe('medium');
      const tools = toolsOf(t.requests[0]);
      for (const gone of ['LS', 'MultiEdit', 'RepoMap', 'EnterPlanMode']) expect(tools).not.toContain(gone);
      for (const kept of ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'Task']) expect(tools).toContain(kept);

      t.engine.updateSession(coder.id, { chat: { thinking: 'high' } } as never);
      await t.run(coder.id, 'again');
      expect(effortOf(t.requests[1])).toBe('high');

      const quiet = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'coder', chat: { thinking: 'off' } } as never);
      await t.run(quiet.id, 'hi');
      expect(effortOf(t.requests[2])).toBeNull();

      const assistant = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'assistant' });
      await t.run(assistant.id, 'hi');
      expect(effortOf(t.requests[3])).toBeNull();
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a level the model lacks goes as the nearest one; Off is the model own switch', async () => {
    const t = await startTestEngine({ script: [[{ text: 'ok' }], [{ text: 'ok' }], [{ text: 'ok' }], [{ text: 'ok' }]] });
    const thinkingOf = (body: string) => JSON.parse(body).thinking ?? null;
    try {
      // Opus 4.6 has no xhigh
      const old = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'coder', model: 'mock/claude-opus-4-6', chat: { thinking: 'xhigh' } } as never);
      await t.run(old.id, 'hi');
      expect(effortOf(t.requests[0])).toBe('high');
      // Sonnet 5.5 turns thinking off with between_tools only
      const off = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'coder', chat: { thinking: 'off' } } as never);
      await t.run(off.id, 'hi');
      expect(thinkingOf(t.requests[1])).toEqual({ type: 'between_tools' });
      expect(effortOf(t.requests[1])).toBeNull();
      // Opus 5.5 cannot stop thinking: Off runs at low
      const opus = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'coder', model: 'mock/claude-opus-5-5', chat: { thinking: 'off' } } as never);
      await t.run(opus.id, 'hi');
      expect(thinkingOf(t.requests[2]).type).toBe('adaptive');
      expect(effortOf(t.requests[2])).toBe('low');
      // max on Sonnet 5.5 stays max
      t.engine.updateSession(off.id, { chat: { thinking: 'max' } } as never);
      await t.run(off.id, 'again');
      expect(effortOf(t.requests[3])).toBe('max');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('harness models: the levels the harness offered are kept and announced once; a turn asks for the session or agent level', async () => {
    const t = await startTestEngine({ script: [] });
    try {
      const seen: string[] = [];
      t.engine.bus.on((e) => void (e.type === 'models.updated' && seen.push(e.type)));
      const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
      t.engine.noteHarnessEffort('claude-code/opus', [...levels]);
      t.engine.noteHarnessEffort('claude-code/opus', [...levels]);
      expect(seen).toHaveLength(1);
      expect(t.engine.harnessEffort('claude-code/opus')).toEqual([...levels]);
      // a harness without an Effort option: none offered
      t.engine.noteHarnessEffort('claude-code/opus', []);
      expect(t.engine.harnessEffort('claude-code/opus')).toBeUndefined();
      expect(seen).toHaveLength(2);

      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'verifier' });
      expect(t.engine.harnessEffortFor(s)).toBe('xhigh');
      t.engine.updateSession(s.id, { chat: { thinking: 'low' } } as never);
      expect(t.engine.harnessEffortFor(t.engine.getSession(s.id)!)).toBe('low');
    } finally {
      await t.close();
    }
  }, 30_000);
});
