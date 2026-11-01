import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionRunner } from '../../src/session/runner';
import { SUMMARY_HEADINGS } from '../../src/session/prompt';
import { startTestEngine, toolResults } from './harness';

/** HARNESS-REVIEW item 17 in the engine: read marks live on the messages. */

const shaped = `done\n\n${SUMMARY_HEADINGS.map((h) => `## ${h}\nnone`).join('\n')}`;

describe('read marks in the session', () => {
  test('a hub restart keeps them; a compaction that drops the Read refuses the edit; a refused payload goes out once', async () => {
    const file = { file_path: '' };
    const big = 'B'.repeat(5_000);
    let phase = 'read';
    const t = await startTestEngine({
      modelOverrides: { 'claude-sonnet-5-5': { contextWindow: 200_000 } },
      script: [[{ text: 'unused' }]],
      approve: 'allow',
      route: (body) => {
        const n = JSON.stringify(body.messages).split('"tool_result"').length - 1;
        if (phase === 'read') return n === 0 ? [{ tool: 'Read', input: file }] : [{ text: 'read it' }];
        if (phase === 'write') return n === 0 ? [{ tool: 'Write', input: { ...file, content: big } }] : [{ text: 'refused' }];
        return [{ text: 'ok' }];
      },
      chore: (_b, text) => (text.includes('Conversation to summarize') ? [{ text: shaped }] : undefined),
    });
    try {
      file.file_path = join(t.cwd, 'a.txt');
      writeFileSync(file.file_path, 'hello\n');
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      await t.run(s.id, 'read a.txt');
      // a new runner (as after a restart) finds the mark on the stored Read result
      expect(new SessionRunner(t.engine, s.id).readMark(file.file_path)?.sha256).toMatch(/^[0-9a-f]{64}$/);

      // push the Read out of the kept tail, then compact
      for (let i = 0; i < 3; i++) {
        t.engine.addMessage(s.id, { role: 'user', kind: 'normal', content: [{ type: 'text', text: `more ${i}` }] });
        t.engine.addMessage(s.id, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: 'x'.repeat(30_000) }] });
      }
      await t.engine.compact(s.id);
      expect(t.engine.getMessages(s.id).some((m) => m.kind === 'summary')).toBe(true);

      phase = 'write';
      const before = t.requests.length;
      await t.run(s.id, 'overwrite it');
      const write = toolResults(t.engine, s.id).at(-1)!;
      expect(write.name).toBe('Write');
      expect(write.isError).toBe(true);
      expect(write.content).toContain('has not been read yet');
      // the request after the refusal sends the path and a stub, not the 5,000 chars again
      const after = t.requests.slice(before);
      expect(after).toHaveLength(2);
      expect(after[0]).not.toContain('"tool_use"');
      expect(after[1]).not.toContain(big);
      expect(after[1]).toContain('[5000 chars cleared to save context]');
    } finally {
      await t.close();
    }
  }, 30_000);

  test('an Edit of a file never read goes through on an exact match, unless a Read deny rule covers the file', async () => {
    const edits = [
      { file_path: 'notes.md', old_string: 'draft', new_string: 'final' },
      { file_path: 'secret.env', old_string: 'TOKEN=', new_string: 'KEY=' },
    ];
    const t = await startTestEngine({
      script: [[{ text: 'unused' }]],
      approve: 'allow',
      route: (body) => {
        const n = JSON.stringify(body.messages).split('"tool_result"').length - 1;
        return n < edits.length ? [{ tool: 'Edit', input: edits[n] }] : [{ text: 'done' }];
      },
    });
    try {
      writeFileSync(join(t.cwd, 'notes.md'), 'a draft\n');
      writeFileSync(join(t.cwd, 'secret.env'), 'TOKEN=abc\n');
      mkdirSync(join(t.cwd, '.conclave'), { recursive: true });
      writeFileSync(join(t.cwd, '.conclave', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(**/*.env)'] } }));
      t.engine.setProjectTrust(t.cwd, true);
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd, agent: 'general-purpose' });
      await t.run(s.id, 'edit both');
      const [notes, secret] = toolResults(t.engine, s.id);
      expect(notes.isError).toBeFalsy();
      expect(readFileSync(join(t.cwd, 'notes.md'), 'utf8')).toBe('a final\n');
      expect(secret.isError).toBe(true);
      expect(secret.content).toContain('has not been read yet');
      expect(readFileSync(join(t.cwd, 'secret.env'), 'utf8')).toBe('TOKEN=abc\n');
    } finally {
      await t.close();
    }
  }, 30_000);
});
