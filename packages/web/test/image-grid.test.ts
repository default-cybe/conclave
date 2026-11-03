/** Generated pictures (features/files/words.ts) and image models kept out of the chat picker. */
import { expect, test } from 'bun:test';
import { generatedCards, generatedNames } from '../src/features/files/words';
import { buildPicker } from '../src/components/pickers/ModelPicker';

const share = (id: string, name: string) => ({ name: 'ShareFile', result: { toolUseId: id, meta: { file: { name, mediaType: 'image/png', size: 10 } } } });

test('a GenerateImage call collects the cards the turn end gave its files', () => {
  const calls = [{ name: 'GenerateImage', result: { toolUseId: 'g', meta: { images: ['/o/a.png', '/o/b.png'] } } }, share('s1', 'a.png'), share('s2', 'b.png'), share('s3', 'other.png')];
  const names = generatedNames(calls);
  expect([...names]).toEqual(['a.png', 'b.png']);
  expect(generatedCards(calls, names).map((c) => c.toolUseId)).toEqual(['s1', 's2']);
});

test('image models stay out of the chat picker', () => {
  const models = [{ provider: 'cliproxy', name: 'CLIProxyAPI', enabled: true, models: [
    { ref: 'cliproxy/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5', provider: 'cliproxy' },
    { ref: 'cliproxy/gpt-image-2.5', id: 'gpt-image-2.5', name: 'GPT Image 2.5', provider: 'cliproxy', kind: 'image' },
    { ref: 'cliproxy/pixel-maker', id: 'pixel-maker', name: 'Pixel', provider: 'cliproxy', kind: 'image' },
  ] }] as never;
  const p = buildPicker({ models, sessions: {}, devices: {}, limits: {}, harnesses: false });
  const refs = p.groups.flatMap((g) => g.rows.map((r) => r.ref));
  expect(refs).toContain('cliproxy/gpt-5.5');
  expect(refs).not.toContain('cliproxy/gpt-image-2.5');
  expect(refs).not.toContain('cliproxy/pixel-maker');
});
