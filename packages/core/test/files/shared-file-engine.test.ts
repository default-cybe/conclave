/**
 * GET /api/sessions/:id/files/:toolUseId reads engine.sharedFile. A step's
 * tool results are stored only when every call in it is done, so a
 * ShareFile card the apps already show (tool.completed) must download while
 * a slower call in the same step (here AskUserQuestion) still waits.
 *
 *   bun test packages/core/test/files/shared-file-engine.test.ts
 */
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuestionRequest } from '../../src/types';
import { startTestEngine, until } from '../engine/harness';

test('a shared file downloads while another call in its step waits for the owner', async () => {
  const ask = { questions: [{ question: 'Ship it?', header: 'Ship', multiSelect: false, options: [{ label: 'Yes', description: 'ship' }, { label: 'No', description: 'wait' }] }] };
  const t = await startTestEngine({ script: [[{ tool: 'ShareFile', input: { path: 'pets.png' } }, { tool: 'AskUserQuestion', input: ask }], [{ text: 'done' }]] });
  const asked: QuestionRequest[] = [];
  let shareId = '';
  const off = t.engine.bus.on((e) => {
    if (e.type === 'question.asked') asked.push(e.question);
    if (e.type === 'tool.completed' && e.result.meta?.file) shareId = e.toolUseId;
  });
  try {
    writeFileSync(join(t.cwd, 'pets.png'), 'png!');
    const s = await t.engine.createSession({ title: 'Share', cwd: t.cwd });
    const turn = t.run(s.id, 'go');
    expect(await until(() => asked.length === 1 && !!shareId)).toBe(true);
    // the card is on screen; its result row is not stored yet
    const f = await t.engine.sharedFile(s.id, shareId);
    expect(new TextDecoder().decode(f.bytes)).toBe('png!');
    expect(f).toMatchObject({ name: 'pets.png', mediaType: 'image/png' });
    // a call id that is not a ShareFile call is still unknown
    await expect(t.engine.sharedFile(s.id, 'toolu_nope')).rejects.toThrow('unknown session');
    expect(t.engine.answerQuestion(asked[0]!.id, { 'Ship it?': 'Yes' })).toBe(true);
    await turn;
    expect((await t.engine.sharedFile(s.id, shareId)).size).toBe(4);
  } finally {
    off();
    await t.close();
  }
}, 30_000);
