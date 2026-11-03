/**
 * GenerateImage through the engine: the result carries the saved files, so a
 * client draws the grid as soon as the call ends and fetches each picture by
 * the call's id and its index (engine sharedFile, GET
 * /api/sessions/:id/files/:toolUseId?image=N). And "attached:N" reads the
 * chat as the turn's starter may see it (host chatImages, engine.turnMessages).
 *
 *   bun test packages/core/test/images/generate-image-engine.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { ChatParticipantStore } from '../../src/people/shared-chats';
import { OWNER_ID } from '../../src/people/context';
import type { Provider } from '../../src/providers/types';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** The cliproxy provider answers image calls with n tiny PNGs; every other provider is the harness's own. */
function fakeImages(engine: TestEngine['engine']) {
  const fake = { generateImage: async (r: { n?: number }) => ({ images: Array.from({ length: r.n ?? 1 }, (_, i) => ({ bytes: new Uint8Array([...PNG, i]), mime: 'image/png' })) }) } as unknown as Provider;
  const orig = engine.providersFor.bind(engine);
  (engine as unknown as { providersFor: typeof orig }).providersFor = (acct) => {
    const reg = orig(acct);
    return new Proxy(reg, {
      get(target, p) {
        if (p === 'get') return (id: string) => (id === 'cliproxy' ? fake : target.get(id));
        const v = Reflect.get(target, p);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
}

test("a GenerateImage result carries its files, and each one downloads by the call's id and index", async () => {
  t = await startTestEngine({ script: [[{ tool: 'GenerateImage', input: { prompt: 'a fox', n: 2 } }], [{ text: 'done' }]] });
  fakeImages(t.engine);
  const s = await t.engine.createSession({ title: 'Pics', kind: 'chat', permissionMode: 'acceptEdits' });
  await t.run(s.id, 'draw two foxes');
  const blocks = t.engine.repos.messages.list(s.id).flatMap((m) => m.content);
  const call = blocks.find((b) => b.type === 'tool_use' && b.name === 'GenerateImage') as { id: string };
  const res = blocks.find((b) => b.type === 'tool_result' && b.toolUseId === call.id) as { isError?: boolean; content: unknown; meta?: { files?: Array<Record<string, unknown>> } };
  expect(res.isError ? res.content : undefined).toBeUndefined();
  expect(res.meta?.files?.length).toBe(2);
  expect(res.meta?.files?.[0]).toMatchObject({ device: 'local', mediaType: 'image/png', size: PNG.length + 1 });
  const second = await t.engine.sharedFile(s.id, call.id, 1);
  expect([...second.bytes].at(-1)).toBe(1);
  expect(second).toMatchObject({ name: res.meta!.files![1]!.name, mediaType: 'image/png' });
  // a GenerateImage call is no ShareFile card, and an index past its pictures is unknown
  await expect(t.engine.sharedFile(s.id, call.id)).rejects.toThrow('unknown session');
  await expect(t.engine.sharedFile(s.id, call.id, 3)).rejects.toThrow('unknown session');
  // the turn-end card for the same picture is a ShareFile call, no GenerateImage one
  const card = blocks.find((b) => b.type === 'tool_use' && b.name === 'ShareFile') as { id: string };
  expect((await t.engine.sharedFile(s.id, card.id)).mediaType).toBe('image/png');
  await expect(t.engine.sharedFile(s.id, card.id, 0)).rejects.toThrow('unknown session');
}, 30_000);

const image = (byte: number) => ({ type: 'image' as const, mediaType: 'image/png', data: Buffer.from([...PNG, byte]).toString('base64') });

test("attached pictures in a seat turn are only the ones its starter may see", async () => {
  t = await startTestEngine({ script: [[{ text: 'ok' }]] });
  const { engine } = t;
  const chat = await engine.createSession({ kind: 'chat', title: 'Shared' }, OWNER_ID);
  // the owner's picture from before she joined: hers to never see
  engine.addMessage(chat.id, { role: 'user', kind: 'normal', content: [image(7), { type: 'text', text: 'before' }] });
  const acct = engine.people.create({ name: 'alice', displayName: 'alice' });
  const store = new ChatParticipantStore(engine.repos.db);
  store.invite(chat.id, OWNER_ID, acct.id, {});
  const seat = await engine.createSession({ kind: 'chat', title: 'Shared', chat: { memory: false } }, acct.id, { byPerson: true });
  engine.repos.sessions.update({ ...seat, meta: { ...seat.meta, seat: { chatId: chat.id } } });
  store.accept(chat.id, acct.id, engine.requireSession(seat.id));
  // her own picture, posted through her seat into the shared chat
  engine.addMessage(seat.id, { role: 'user', kind: 'normal', content: [image(9), { type: 'text', text: 'mine' }] });

  const last = (id: string) => engine.toolHost(engine.runnerFor(id)).chatImages().map((i) => i.bytes.at(-1));
  expect(last(seat.id)).toEqual([9]);
  expect(last(chat.id)).toEqual([9, 7]);
}, 30_000);
