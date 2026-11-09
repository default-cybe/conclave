/**
 * A picture the API could not decode (session/bad-image.ts): the provider
 * answers 400 "Could not process image"; the runner takes the newest picture
 * out of the stored history, says so in the turn and retries once, so the
 * chat is not stuck resending it.
 *
 *   bun test packages/core/test/engine/bad-image.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG, b64 } from '../attachments/zipkit';
import { startTestEngine, type TestEngine } from './harness';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** Answers "Could not process image" while a request carries an image, at most `times` times. */
function refuseImages(times: number) {
  let left = times;
  return (_b: unknown, text: string) => (text.includes('"type":"image"') && left-- > 0 ? { status: 400, error: 'Could not process image' } : undefined);
}

async function send(t: TestEngine, id: string, text: string, attachments?: Array<{ mediaType: string; data: string; name: string }>) {
  const runner = t.engine.runnerFor(id);
  await t.engine.send(id, { text, ...(attachments ? { attachments } : {}) });
  await Promise.race([runner.waitIdle(), Bun.sleep(30_000)]);
}

const notices = (t: TestEngine, id: string) =>
  t.engine.repos.messages
    .list(id)
    .flatMap((m) => m.content)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .filter((s) => s.startsWith('An image could not be read'));

describe('a picture the model could not read', () => {
  test('an attached picture is replaced in the history and the turn completes', async () => {
    t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ text: 'Done without it.' }], [{ text: 'Next answer.' }]], route: refuseImages(1) });
    const s = await t.engine.createSession({ title: 'pic', agent: 'coder', cwd: t.cwd, model: 'mock/claude-sonnet-5-5' });
    await send(t, s.id, 'What is this?', [{ mediaType: 'image/png', data: b64(PNG), name: 'broken.png' }]);

    expect(t.requests.length).toBe(2);
    expect(t.requests[0]).toContain('"type":"image"');
    expect(t.requests[1]).not.toContain('"type":"image"');
    expect(t.requests[1]).toContain('[image broken.png left out: not a format the model can read]');
    const stored = t.engine.repos.messages.list(s.id);
    expect(stored.some((m) => m.content.some((b) => b.type === 'image'))).toBe(false);
    expect(notices(t, s.id)).toEqual(['An image could not be read by the model and was left out: broken.png.']);
    const last = stored.filter((m) => m.role === 'assistant').at(-1);
    expect(last?.stopReason).not.toBe('error');

    // the next send carries no picture, so it goes through
    await send(t, s.id, 'And now?');
    expect(t.requests.length).toBe(3);
    expect(t.requests[2]).not.toContain('"type":"image"');
  });

  test("a Read tool result's image is the newest picture, so it leaves and the attachment stays", async () => {
    t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ tool: 'Read', input: { file_path: 'shot.png' } }], [{ text: 'Read it.' }]], route: refuseImages(1) });
    writeFileSync(join(t.cwd, 'shot.png'), PNG);
    const s = await t.engine.createSession({ title: 'pic', agent: 'coder', cwd: t.cwd, model: 'mock/claude-sonnet-5-5' });
    await send(t, s.id, 'Look at shot.png');
    expect(t.requests.at(-1)).toContain('[image shot.png left out: not a format the model can read]');
    expect(notices(t, s.id)).toEqual(['An image could not be read by the model and was left out: shot.png.']);
  });

  test('retried once per turn: a second refusal ends the turn with the error', async () => {
    t = await startTestEngine({ models: ['claude-sonnet-5-5'], script: [[{ text: 'never' }]], route: () => ({ status: 400, error: 'Could not process image' }) });
    const s = await t.engine.createSession({ title: 'pic', agent: 'coder', cwd: t.cwd, model: 'mock/claude-sonnet-5-5' });
    await send(t, s.id, 'Two pictures', [
      { mediaType: 'image/png', data: b64(PNG), name: 'a.png' },
      { mediaType: 'image/png', data: b64(PNG), name: 'b.png' },
    ]);
    expect(t.requests.length).toBe(2);
    expect(notices(t, s.id)).toEqual(['An image could not be read by the model and was left out: b.png.']);
  });
});
