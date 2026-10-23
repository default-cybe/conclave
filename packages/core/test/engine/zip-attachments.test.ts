/**
 * A zip sent with a message, through the real engine (src/attachments):
 * a chat gets its listing, text and pictures in the message the model
 * reads; a Code session gets the zip saved in its folder and a note; a
 * bad zip or a 16th file is refused before the turn starts.
 *
 *   bun test packages/core/test/engine/zip-attachments.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '../../src/types';
import { TOO_MANY_FILES } from '../../src/attachments/limits';
import { b64, makeZip, PNG, unb64 } from '../attachments/zipkit';
import { startTestEngine, until, type TestEngine } from './harness';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const zip = makeZip([
  { name: 'notes/plan.md', data: '# Plan\nShip the zip support.', method: 8 },
  { name: 'shot.png', data: PNG },
]);

function userBlocks(t: TestEngine, id: string): ContentBlock[] {
  const m = t.engine.getMessages(id).find((x) => x.role === 'user');
  return m?.content ?? [];
}

describe('a zip with a message', () => {
  test('in a chat: the hub reads it; the model gets the listing, the text and the picture', async () => {
    t = await startTestEngine({ script: [[{ text: 'Got it.' }]] });
    const chat = await t.engine.createSession({ kind: 'chat' });
    await t.engine.send(chat.id, { text: 'What is in here?', attachments: [{ mediaType: 'application/zip', data: b64(zip), name: 'project.zip' }] });
    expect(await until(() => t!.engine.getMessages(chat.id).some((m) => m.role === 'assistant'), 10_000)).toBe(true);
    const blocks = userBlocks(t, chat.id);
    const doc = blocks.find((b) => b.type === 'document') as Extract<ContentBlock, { type: 'document' }>;
    expect(doc.title).toBe('project.zip');
    expect(doc.mediaType).toBe('text/plain');
    const text = unb64(doc.data!);
    expect(text).toContain('project.zip holds 2 files');
    expect(text).toContain('--- notes/plan.md ---\n# Plan\nShip the zip support.');
    expect(blocks.some((b) => b.type === 'image' && b.mediaType === 'image/png')).toBe(true);
    // and the model read it as a document (a turn with no tools offered counts as a chore in the harness)
    // the reply row can show before the request is recorded, so wait for it
    const read = () =>
      [...t!.requests, ...t!.chores]
        .map((b) => JSON.parse(b) as { messages?: Array<{ content: string | Array<{ type: string; text?: string }> }> })
        .some((req) => (req.messages ?? []).some((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'text' && b.text?.startsWith('<document name="project.zip"') && b.text.includes('Ship the zip support.'))));
    expect(await until(read, 10_000)).toBe(true);
  });

  test('in a Code session: saved under uploads/ in its folder, and the model is told where', async () => {
    t = await startTestEngine({ script: [[{ text: 'Unzipping.' }]] });
    const code = await t.engine.createSession({ title: 'code', agent: 'coder', cwd: t.cwd });
    await t.engine.send(code.id, { text: 'Look at this', attachments: [{ mediaType: 'application/x-zip-compressed', data: b64(zip), name: 'project.zip' }] });
    expect(await until(() => t!.engine.getMessages(code.id).some((m) => m.role === 'assistant'), 10_000)).toBe(true);
    const saved = join(t.cwd, 'uploads', 'project.zip');
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved).equals(zip)).toBe(true);
    const doc = userBlocks(t, code.id).find((b) => b.type === 'document') as Extract<ContentBlock, { type: 'document' }>;
    const text = unb64(doc.data!);
    expect(text).toContain(`project.zip is saved at ${saved}.`);
    expect(text).toContain('notes/plan.md');
    expect(userBlocks(t, code.id).some((b) => b.type === 'image')).toBe(false);

    // a second one with the same name does not overwrite the first
    await t.engine.send(code.id, { text: 'Again', attachments: [{ mediaType: 'application/zip', data: b64(zip), name: 'project.zip' }] });
    expect(await until(() => existsSync(join(t!.cwd, 'uploads', 'project-2.zip')), 10_000)).toBe(true);
  });

  test('a zip with a path outside, or a 16th file, is refused before the turn', async () => {
    t = await startTestEngine({ script: [[{ text: 'never' }]] });
    const chat = await t.engine.createSession({ kind: 'chat' });
    const evil = makeZip([{ name: '../../escape.sh', data: 'rm -rf ~' }]);
    await expect(t.engine.send(chat.id, { text: 'x', attachments: [{ mediaType: 'application/zip', data: b64(evil), name: 'evil.zip' }] })).rejects.toThrow('evil.zip has a file outside its folder');
    const files = Array.from({ length: 16 }, (_, i) => ({ mediaType: 'text/plain', data: b64(new TextEncoder().encode(`${i}`)), name: `${i}.txt` }));
    await expect(t.engine.send(chat.id, { text: 'x', attachments: files })).rejects.toThrow(TOO_MANY_FILES);
    expect(t.engine.getMessages(chat.id).length).toBe(0);
    expect(t.requests.length).toBe(0);
  });
});
