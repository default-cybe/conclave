import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, toolResults } from './harness';
import { cleanup, tempDir } from '../extensions/_helpers';

/**
 * Every tool_use in a reply gets exactly one tool_result in the next user
 * turn, in order, whatever happened to the call. The mock API rejects a bad
 * shape the way the Messages API does (harness apiShapeError).
 */

type Wire = { role: string; content: Array<Record<string, any>> };
const wire = (body: string): Wire[] => JSON.parse(body).messages;

/** tool_use ids of every assistant message and tool_result ids of the user message after it. */
function pairs(body: string): Array<{ uses: string[]; results: string[] }> {
  const msgs = wire(body);
  const out: Array<{ uses: string[]; results: string[] }> = [];
  msgs.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    const uses = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (!uses.length) return;
    const next = msgs[i + 1];
    out.push({ uses, results: (next?.content ?? []).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) });
  });
  return out;
}

describe('tool result pairing', () => {
  test('r4e37h: an Edit, a MultiEdit with edits as a JSON string and an unknown tool in one reply; the run goes on', async () => {
    const cwd = tempDir('conclave-pair-');
    const t = await startTestEngine({
      approve: 'allow',
      script: [
        [{ tool: 'Read', input: { file_path: join(cwd, 'src/entry.ts') } }],
        [
          { text: 'Making the changes.' },
          { tool: 'Edit', input: { file_path: join(cwd, 'src/entry.ts'), old_string: 'one', new_string: 'uno' } },
          { tool: 'MultiEdit', input: { file_path: join(cwd, 'src/entry.ts'), edits: JSON.stringify([{ old_string: 'two', new_string: 'dos' }]) } },
          { tool: 'x', input: {} },
        ],
        [{ text: 'Done.' }],
      ],
    });
    try {
      mkdirSync(join(cwd, 'src'));
      writeFileSync(join(cwd, 'src/entry.ts'), 'one\ntwo\n');
      const s = await t.engine.createSession({ title: 't', cwd });
      await t.run(s.id, 'go');
      expect(t.rejected.map((r) => r.error)).toEqual([]);
      expect(t.engine.getSession(s.id)!.status).toBe('idle');
      expect(t.requests).toHaveLength(3);
      // the third request: three calls, three results, same order, nothing after the calls
      const third = wire(t.requests[2]);
      const reply = third[third.length - 2];
      expect(reply.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use', 'tool_use']);
      expect(reply.content.filter((b) => b.type === 'tool_use').map((b) => b.name)).toEqual(['Edit', 'MultiEdit', 'x']);
      expect(pairs(t.requests[2])).toEqual([
        { uses: ['toolu_1_0'], results: ['toolu_1_0'] },
        { uses: ['toolu_2_1', 'toolu_2_2', 'toolu_2_3'], results: ['toolu_2_1', 'toolu_2_2', 'toolu_2_3'] },
      ]);
      const results = toolResults(t.engine, s.id);
      expect(results.map((r) => r.name)).toEqual(['Read', 'Edit', 'MultiEdit', 'x']);
      expect(results[3].content).toContain('Unknown tool: x');
      // edits sent as a JSON string are read as the array (coerceInput)
      expect(results[2].isError).toBe(false);
      expect(readFileSync(join(cwd, 'src/entry.ts'), 'utf8')).toBe('uno\ndos\n');
    } finally {
      await t.close();
      cleanup(cwd);
    }
  }, 30_000);

  test('valid, invalid, unknown, denied and hook-blocked calls in one reply each get one result, in order', async () => {
    const cwd = tempDir('conclave-pair-');
    const deny = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no globbing"}}'`;
    const t = await startTestEngine({
      approve: 'allow',
      overrides: { permissions: { mode: 'default', allow: [], deny: ['Bash(rm *)'], ask: [], additionalDirectories: [] } } as never,
      hooks: () => ({ PreToolUse: [{ matcher: 'Glob', hooks: [{ type: 'command', command: deny, timeout: 10 }] }] }),
      script: [
        [
          { tool: 'Read', input: { file_path: join(cwd, 'a.txt') } },
          { tool: 'Read', input: {} },
          { tool: 'NoSuchTool', input: { q: 1 } },
          { tool: 'Bash', input: { command: 'rm -rf a.txt' } },
          { tool: 'Glob', input: { pattern: '*' } },
        ],
        { blocks: [{ tool: 'Write', input: { file_path: join(cwd, 'b.txt'), content: 'cut' } }], stop: 'max_tokens' },
        [{ text: 'Done.' }],
      ],
    });
    try {
      writeFileSync(join(cwd, 'a.txt'), 'hello\n');
      const s = await t.engine.createSession({ title: 't', cwd });
      await t.run(s.id, 'go');
      expect(t.rejected.map((r) => r.error)).toEqual([]);
      expect(t.requests).toHaveLength(3);
      const p = pairs(t.requests[2]);
      expect(p).toHaveLength(2);
      for (const x of p) expect(x.results).toEqual(x.uses);
      const results = toolResults(t.engine, s.id);
      expect(results.map((r) => [r.name, r.isError])).toEqual([
        ['Read', false],
        ['Read', true],
        ['NoSuchTool', true],
        ['Bash', true],
        ['Glob', true],
        ['Write', true],
      ]);
      expect(results[1].content).toContain('Missing required parameter: file_path');
      expect(results[3].content).toContain('Permission denied');
      expect(results[4].content).toContain('no globbing');
      expect(results[5].content).toContain('Not run');
    } finally {
      await t.close();
      cleanup(cwd);
    }
  }, 30_000);

  test('calls stopped by the user get results, so the next turn sends a valid transcript', async () => {
    const cwd = tempDir('conclave-pair-');
    const t = await startTestEngine({
      approve: 'allow',
      script: [
        [
          { tool: 'Bash', input: { command: 'sleep 5' } },
          { tool: 'Read', input: { file_path: join(cwd, 'a.txt') } },
        ],
        [{ text: 'Back again.' }],
      ],
    });
    try {
      writeFileSync(join(cwd, 'a.txt'), 'hello\n');
      const s = await t.engine.createSession({ title: 't', cwd });
      const runner = t.engine.runnerFor(s.id);
      const off = t.engine.bus.on((e: { type: string; name?: string }) => {
        if (e.type === 'tool.started' && e.name === 'Bash') setTimeout(() => runner.abort(), 200);
      });
      await t.run(s.id, 'go');
      off();
      const stored = toolResults(t.engine, s.id);
      expect(stored.map((r) => [r.name, r.isError])).toEqual([['Bash', true], ['Read', true]]);
      expect(stored[0].content).toContain('interrupted');
      expect(stored[1].content).toContain('Interrupted: the turn was stopped');
      await t.run(s.id, 'and now?');
      expect(t.rejected.map((r) => r.error)).toEqual([]);
      expect(t.requests).toHaveLength(2);
      const p = pairs(t.requests[1]);
      expect(p).toEqual([{ uses: ['toolu_1_0', 'toolu_1_1'], results: ['toolu_1_0', 'toolu_1_1'] }]);
      const last = wire(t.requests[1]).at(-1)!;
      expect(last.role).toBe('user');
    } finally {
      await t.close();
      cleanup(cwd);
    }
  }, 30_000);

  test('a tool name that differs only in case runs that tool and stays a paired call', async () => {
    const cwd = tempDir('conclave-pair-');
    const t = await startTestEngine({
      approve: 'allow',
      overrides: { permissions: { mode: 'default', allow: ['Bash(echo *)'], deny: [], ask: [], additionalDirectories: [] } } as never,
      script: [[{ tool: 'bash', input: { command: 'echo case-ok' } }], [{ text: 'Done.' }]],
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd });
      await t.run(s.id, 'go');
      expect(t.rejected).toEqual([]);
      const results = toolResults(t.engine, s.id);
      expect(results[0].isError).toBe(false);
      expect(results[0].content).toContain('case-ok');
      expect(pairs(t.requests[1])).toEqual([{ uses: ['toolu_1_0'], results: ['toolu_1_0'] }]);
    } finally {
      await t.close();
      cleanup(cwd);
    }
  }, 30_000);

  test('a 400 about prefill gets one repair and retry, not a crash', async () => {
    const cwd = tempDir('conclave-pair-');
    let failed = 0;
    const t = await startTestEngine({
      approve: 'allow',
      route: () => {
        if (failed++ === 1) return { status: 400, error: 'This model does not support assistant message prefill. The conversation must end with a user message.' };
        return undefined;
      },
      script: [[{ tool: 'Read', input: { file_path: join(cwd, 'a.txt') } }], [{ text: 'Done.' }]],
    });
    try {
      writeFileSync(join(cwd, 'a.txt'), 'hello\n');
      const s = await t.engine.createSession({ title: 't', cwd });
      await t.run(s.id, 'go');
      expect(t.engine.getSession(s.id)!.status).toBe('idle');
      expect(t.requests).toHaveLength(3);
      // the retry sends the last call and its result as text
      const retry = wire(t.requests[2]);
      expect(retry.at(-1)!.role).toBe('user');
      expect(JSON.stringify(retry)).toContain('[Read:');
      expect(pairs(t.requests[2])).toEqual([]);
    } finally {
      await t.close();
      cleanup(cwd);
    }
  }, 30_000);

  test('a second shape 400 in the same turn is reported, not retried forever', async () => {
    const cwd = tempDir('conclave-pair-');
    let n = 0;
    const t = await startTestEngine({
      approve: 'allow',
      route: () => (n++ >= 1 ? { status: 400, error: 'messages.1: `tool_use` ids were found without `tool_result` blocks immediately after' } : undefined),
      script: [[{ tool: 'Read', input: { file_path: join(cwd, 'a.txt') } }], [{ text: 'Done.' }]],
    });
    try {
      writeFileSync(join(cwd, 'a.txt'), 'hello\n');
      const s = await t.engine.createSession({ title: 't', cwd });
      await t.run(s.id, 'go');
      expect(t.engine.getSession(s.id)!.status).toBe('error');
      expect(t.requests.length).toBeLessThanOrEqual(3);
    } finally {
      await t.close();
      cleanup(cwd);
    }
  }, 30_000);
});
