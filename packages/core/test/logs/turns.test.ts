import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine } from '../engine/harness';
import { HubLogs, listLogFiles } from '../../src/logs';
import type { LogLine } from '../../src/client/logs';

const MESSAGE_TEXT = 'PLANTED-CHAT-TEXT the owner typed';
const FILE_TEXT = 'PLANTED-FILE-CONTENTS of a private file';
const REPLY_TEXT = 'PLANTED-REPLY-TEXT from the model';
const FAKE_KEY = 'sk-ant-api03-PLANTEDturnKEY0123456789abcdefXYZ';

/** A real engine and session runner with the hub's logs on: what lands in the files for a turn. */
describe('turn lines from a real engine', () => {
  test('a turn with a tool call and an approval: ids, model, tokens, cost and outcome, never the text', async () => {
    const t = await startTestEngine({
      script: [
        [{ tool: 'Read', input: { file_path: 'notes.txt' } }],
        [{ tool: 'Bash', input: { command: `touch made.txt && echo ${MESSAGE_TEXT} ${FAKE_KEY}` } }],
        [{ text: `${REPLY_TEXT} ${FAKE_KEY}` }],
      ],
      approve: 'deny',
    });
    const logs = new HubLogs({ config: t.engine.config, version: 'test' });
    logs.start({ bus: t.engine.bus });
    try {
      writeFileSync(join(t.cwd, 'notes.txt'), `${FILE_TEXT}\n`);
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, `${MESSAGE_TEXT} ${FAKE_KEY}`);
      logs.stop();
      const files = listLogFiles(logs.dir);
      const text = files.map((f) => readFileSync(f.path, 'utf8')).join('');
      for (const planted of [MESSAGE_TEXT, FILE_TEXT, REPLY_TEXT, FAKE_KEY, 'PLANTED']) expect(text).not.toContain(planted);
      const lines = text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine);
      const turn = lines.find((l) => l.component === 'session' && l.msg === 'turn')!;
      expect(turn.level).toBe('info');
      expect(turn.fields).toMatchObject({ sessionId: s.id, model: 'mock/claude-sonnet-5-5', provider: 'mock', stop: 'done', tools: 2 });
      expect(turn.fields!.calls).toBe(3);
      expect(turn.fields!.inputTokens).toBeGreaterThan(0);
      expect(turn.fields!.outputTokens).toBeGreaterThan(0);
      expect(typeof turn.fields!.durationMs).toBe('number');
      expect(typeof turn.fields!.costUsd).toBe('number');
      const tools = lines.filter((l) => l.component === 'tool').map((l) => [l.fields!.tool, l.fields!.ok]);
      expect(tools).toEqual([
        ['Read', true],
        ['Bash', false],
      ]);
      const asked = lines.find((l) => l.msg === 'approval asked')!;
      expect(asked.fields).toMatchObject({ sessionId: s.id, tool: 'Bash' });
      expect(lines.find((l) => l.msg === 'approval answered')!.fields).toMatchObject({ decision: 'deny' });
      expect(lines.some((l) => l.msg === 'session created' && l.fields?.sessionId === s.id)).toBe(true);
    } finally {
      logs.stop();
      await t.close();
    }
  }, 60_000);

  test('a turn the provider refuses: a warning with the error on the turn line, and one error line with the stack', async () => {
    const t = await startTestEngine({ script: [[{ text: 'never' }]], route: () => ({ status: 400, error: 'scripted refusal for the logs test' }) });
    const logs = new HubLogs({ config: t.engine.config, version: 'test' });
    logs.start({ bus: t.engine.bus });
    try {
      const s = await t.engine.createSession({ title: 't', cwd: t.cwd });
      await t.run(s.id, MESSAGE_TEXT);
      logs.stop();
      const lines = listLogFiles(logs.dir)
        .flatMap((f) => readFileSync(f.path, 'utf8').split('\n'))
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine);
      const turn = lines.find((l) => l.component === 'session' && l.msg === 'turn')!;
      expect(turn.level).toBe('warn');
      expect(turn.fields).toMatchObject({ sessionId: s.id, stop: 'error' });
      expect(String(turn.fields!.error)).toContain('scripted refusal');
      const errors = lines.filter((l) => l.level === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].component).toBe('runner');
      expect(typeof errors[0].fields?.stack).toBe('string');
      expect(JSON.stringify(lines)).not.toContain(MESSAGE_TEXT);
    } finally {
      logs.stop();
      await t.close();
    }
  }, 60_000);
});
