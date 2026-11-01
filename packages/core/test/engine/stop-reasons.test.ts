import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, TextBlock } from '../../src/types';
import { CONTINUE_AFTER_EMPTY_REPLY } from '../../src/session/runner';
import { startTestEngine, toolResults } from './harness';

/**
 * Replies that end oddly: cut by the output limit, refused, or empty. Calls
 * in such replies never run; empty replies are retried once.
 */

const notices = (msgs: Message[]) => msgs.filter((m) => m.kind === 'notice').map((m) => (m.content[0] as TextBlock).text);

describe('output limit, refusal and empty replies', () => {
  test('a Write in a reply cut by max_tokens does not run; the loop continues with a "Not run" result', async () => {
    const t = await startTestEngine({
      approve: 'allow',
      script: [
        { blocks: [{ tool: 'Write', input: { file_path: 'cut.txt', content: 'half of the fi' } }], stop: 'max_tokens' },
        [{ text: 'I will send it in parts.' }],
      ],
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'write the file');
      expect(existsSync(join(t.cwd, 'cut.txt'))).toBe(false);
      expect(t.requests.length).toBe(2);
      expect(t.requests[1]).toContain('Not run: your reply hit the output token limit');
      expect(t.requests[1]).toContain('"is_error":true');
      const results = toolResults(t.engine, s.id);
      expect(results).toHaveLength(1);
      expect(results[0].isError).toBe(true);
      const msgs = t.engine.getMessages(s.id);
      const carrier = msgs.find((m) => m.content.some((b) => b.type === 'tool_result'))!;
      expect((carrier.content[0] as { meta?: Record<string, unknown> }).meta?.notRun).toBe('max_tokens');
      expect(t.approvals).toHaveLength(0);
      expect(t.engine.getSession(s.id)!.status).toBe('idle');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('three cut replies with calls in a row stop the loop with a notice', async () => {
    const cut = { blocks: [{ tool: 'Write', input: { file_path: 'x.txt', content: 'x' } }], stop: 'max_tokens' };
    const t = await startTestEngine({ approve: 'allow', script: [cut, cut, cut, [{ text: 'never' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'go');
      expect(t.requests.length).toBe(3);
      expect(notices(t.engine.getMessages(s.id)).some((n) => n.includes('3 times in a row'))).toBe(true);
      expect(existsSync(join(t.cwd, 'x.txt'))).toBe(false);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('calls in a refused reply do not run and the turn ends', async () => {
    const t = await startTestEngine({
      approve: 'allow',
      script: [{ blocks: [{ text: 'I cannot help with that.' }, { tool: 'Write', input: { file_path: 'r.txt', content: 'r' } }], stop: 'refusal' }, [{ text: 'never' }]],
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'go');
      expect(t.requests.length).toBe(1);
      expect(existsSync(join(t.cwd, 'r.txt'))).toBe(false);
      expect(toolResults(t.engine, s.id)[0].content).toContain('refusal');
      expect(notices(t.engine.getMessages(s.id)).some((n) => n.includes('refused'))).toBe(true);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('two empty replies: one retry, then a notice, and no empty message is kept', async () => {
    const empty = { blocks: [], usage: { output: 0 } };
    const t = await startTestEngine({ script: [empty, empty, [{ text: 'never' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'hello');
      expect(t.requests.length).toBe(2);
      // the retry is not the same request again: it carries a note to continue
      expect(t.requests[0]).not.toContain(CONTINUE_AFTER_EMPTY_REPLY);
      expect(t.requests[1]).toContain(CONTINUE_AFTER_EMPTY_REPLY);
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs)).toContain('The model returned an empty reply.');
      expect(msgs.filter((m) => m.role === 'assistant' && m.kind === 'normal')).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 30_000);

  test('an empty reply after tool results gets the note after the results and the turn goes on', async () => {
    const t = await startTestEngine({
      script: [[{ tool: 'Glob', input: { pattern: '*.none' } }], { blocks: [], usage: { output: 0 } }, [{ text: 'All done.' }]],
    });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'look around');
      expect(t.requests.length).toBe(3);
      const retry = JSON.parse(t.requests[2]) as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
      const last = retry.messages.at(-1)!;
      expect(last.role).toBe('user');
      // tool results first, then the note, in one user message
      expect(last.content[0].type).toBe('tool_result');
      expect(JSON.stringify(last.content.slice(1))).toContain(CONTINUE_AFTER_EMPTY_REPLY);
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs)).toHaveLength(0);
      expect((msgs.filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)!.content[0] as TextBlock).text).toBe('All done.');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('an empty reply followed by a real one ends normally', async () => {
    const t = await startTestEngine({ script: [{ blocks: [], usage: { output: 0 } }, [{ text: 'hello back' }]] });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, 'hello');
      expect(t.requests.length).toBe(2);
      const msgs = t.engine.getMessages(s.id);
      expect(notices(msgs)).toHaveLength(0);
      const replies = msgs.filter((m) => m.role === 'assistant' && m.kind === 'normal');
      expect(replies).toHaveLength(1);
      expect((replies[0].content[0] as TextBlock).text).toBe('hello back');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('a cut text reply gets a continuation note in a routine session, and only a notice in an interactive one', async () => {
    const cut = { blocks: [{ text: 'part one' }], stop: 'max_tokens' };
    const t = await startTestEngine({ script: [cut, [{ text: 'part two' }], cut] });
    try {
      const routine = await t.engine.createSession({ title: 'routine', cwd: t.cwd, tags: ['routine'] });
      await t.run(routine.id, 'write a long report');
      expect(t.requests.length).toBe(2);
      expect(t.requests[1]).toContain('hit the output token limit and was cut off');

      const chat = await t.engine.createSession({ title: 'interactive', cwd: t.cwd });
      await t.run(chat.id, 'write a long report');
      expect(t.requests.length).toBe(3);
      expect(notices(t.engine.getMessages(chat.id))).toContain('The reply hit the output token limit.');
    } finally {
      await t.close();
    }
  }, 30_000);
});
