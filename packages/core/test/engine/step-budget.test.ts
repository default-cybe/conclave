import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgentsFromDir } from '../../src/extensions/loader';
import type { Message, TextBlock } from '../../src/types';
import { firstUserText, startTestEngine, toolResults, type Block } from './harness';
import { tempDir, cleanup } from '../extensions/_helpers';

/**
 * Step budget: a note at 80 percent, a toolless wrap-up call at the cap, and
 * a smaller default budget for subagents.
 */

// the input is read when a request is answered, so each test can point it at its own cwd
const readInput = { file_path: '' };
const read: Block = { tool: 'Read', input: readInput };
function prep(cwd: string): void {
  readInput.file_path = join(cwd, 'a.txt');
  writeFileSync(readInput.file_path, 'hello');
}
const notices = (msgs: Message[]) => msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text);
const lastReply = (msgs: Message[]) => [...msgs].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal');

describe('step budget', () => {
  test('a note at 80 percent, then a wrap-up call with tool_choice none whose reply is text', async () => {
    const t = await startTestEngine({
      script: [[read]],
      route: (body) => (body.tool_choice ? [{ text: 'Finished: read a.txt three times. Left: nothing. Next: stop.' }] : undefined),
      overrides: { limits: { maxSteps: 3 } } as never,
    });
    try {
      prep(t.cwd);
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'keep reading');
      expect(t.requests.length).toBe(4);
      expect(t.requests[1]).not.toContain('Step budget');
      expect(t.requests[2]).toContain('Step budget: you have used 2 of 3 steps in this turn.');
      expect(t.requests[2]).not.toContain('tool_choice');
      const wrap = JSON.parse(t.requests[3]);
      expect(wrap.tool_choice).toEqual({ type: 'none' });
      expect(wrap.tools.length).toBeGreaterThan(0);
      expect(t.requests[3]).toContain('You reached the step limit for this turn (3 steps). Do not call tools.');
      // the note goes in once
      expect(t.requests[3].split('Step budget:').length - 1).toBe(1);

      const msgs = t.engine.getMessages(s.id);
      expect(toolResults(t.engine, s.id)).toHaveLength(3);
      const last = lastReply(msgs)!;
      expect(last.content.every((b) => b.type === 'text')).toBe(true);
      expect((last.content[0] as TextBlock).text).toContain('Finished: read a.txt');
      expect(notices(msgs)).toContain('Stopped after 3 steps.');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('tool calls in the wrap-up reply are dropped and never run', async () => {
    const t = await startTestEngine({ script: [[read]], overrides: { limits: { maxSteps: 2 } } as never });
    try {
      prep(t.cwd);
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'keep reading');
      expect(t.requests.length).toBe(3);
      expect(toolResults(t.engine, s.id)).toHaveLength(2);
      const msgs = t.engine.getMessages(s.id);
      // every stored tool call has a result
      const uses = msgs.flatMap((m) => m.content.filter((b) => b.type === 'tool_use'));
      expect(uses).toHaveLength(2);
      expect(notices(msgs)).toContain('Stopped after 2 steps.');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a provider that rejects the tool choice gets one retry without tools', async () => {
    const t = await startTestEngine({
      script: [[read]],
      route: (body) => (body.tool_choice ? 400 : undefined),
      chore: (_body, text) => (text.includes('You reached the step limit') ? [{ text: 'Wrap-up without tools.' }] : undefined),
      overrides: { limits: { maxSteps: 2, maxRetries: 0 } } as never,
    });
    try {
      prep(t.cwd);
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'keep reading');
      expect(t.requests.length).toBe(3);
      const retry = t.chores.find((c) => c.includes('You reached the step limit'))!;
      expect(retry).toBeDefined();
      // without tool definitions the earlier calls go as text
      expect(retry).not.toContain('"type":"tool_use"');
      expect(retry).toContain(`[Read: ${readInput.file_path}]`);
      expect((lastReply(t.engine.getMessages(s.id))!.content[0] as TextBlock).text).toBe('Wrap-up without tools.');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('subagents get a smaller budget and the parent hears that the child hit it', async () => {
    const isChild = (body: { messages?: unknown[] }) => firstUserText(body).includes('CHILD-BRIEF');
    const t = await startTestEngine({
      script: [[{ tool: 'Task', input: { description: 'read', prompt: 'CHILD-BRIEF read a.txt forever', subagent_type: 'general-purpose' } }], [{ text: 'parent done' }]],
      route: (body) => (isChild(body) ? (body.tool_choice ? [{ text: 'child summary: read twice' }] : [read]) : undefined),
      overrides: { limits: { subagentMaxSteps: 2 } } as never,
    });
    try {
      prep(t.cwd);
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      expect(t.engine.runnerFor(s.id).stepBudget()).toBe(250);
      await t.run(s.id, 'delegate');
      const child = t.engine.listSessions({ parentId: s.id })[0]!;
      expect(t.engine.runnerFor(child.id).stepBudget()).toBe(2);
      const parentRequests = t.requests.filter((r) => !isChild(JSON.parse(r)));
      expect(parentRequests).toHaveLength(2);
      expect(parentRequests[1]).toContain('child summary: read twice');
      expect(parentRequests[1]).toContain('(the subagent stopped at its step limit)');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('defaults: 250 for sessions, 100 for subagents', async () => {
    const t = await startTestEngine({ script: [[{ text: 'x' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      const r = t.engine.runnerFor(s.id);
      expect(r.stepBudget()).toBe(250);
      r.depth = 1;
      expect(r.stepBudget()).toBe(100);
    } finally {
      await t.close();
    }
  });

  test('agent frontmatter maxSteps or maxTurns sets the agent budget', () => {
    const dir = tempDir('conclave-agents-');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'quick.md'), '---\nname: quick\ndescription: d\nmaxSteps: 12\n---\nBody');
      writeFileSync(join(dir, 'claude.md'), '---\nname: claude\ndescription: d\nmaxTurns: 30\n---\nBody');
      writeFileSync(join(dir, 'bad.md'), '---\nname: bad\ndescription: d\nmaxSteps: -1\n---\nBody');
      const defs = loadAgentsFromDir(dir, 'user', (m) => m);
      const by = Object.fromEntries(defs.map((d) => [d.name, d.maxSteps]));
      expect(by).toEqual({ quick: 12, claude: 30, bad: undefined });
    } finally {
      cleanup(dir);
    }
  });
});
