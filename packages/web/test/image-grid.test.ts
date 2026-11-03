/** Generated pictures (features/files/words.ts) and image models kept out of the chat picker. */
import { expect, test } from 'bun:test';
import { generatedCards, generatedNames } from '../src/features/files/words';
import { buildPicker } from '../src/components/pickers/ModelPicker';
import { groupSummary, toolLine, toolRowWords, workingWords } from '../src/lib/toolLine';

test('the folded phone line says what GenerateImage made', () => {
  const two = { name: 'GenerateImage', input: { prompt: 'a fox', n: 2 } };
  const one = { name: 'GenerateImage', input: { prompt: 'a fox' } };
  expect(toolLine([two])).toBe('Made 2 images');
  expect(toolLine([one])).toBe('Made an image');
  expect(workingWords(one)).toBe('Making an image');
  expect(workingWords(two)).toBe('Making 2 images');
  expect(toolRowWords(two)).toEqual({ verb: 'Made 2 images', target: 'a fox', mono: false });
  expect(groupSummary([{ name: 'Read', input: { file_path: '/a.ts' } }, one])).toBe('Read 1 file, made an image');
});

const share = (id: string, name: string) => ({ name: 'ShareFile', result: { toolUseId: id, meta: { file: { name, mediaType: 'image/png', size: 10 } } } });

const file = (name: string, mediaType = 'image/png') => ({ path: `/o/${name}`, device: 'local', name, mediaType, size: 10 });

test('a GenerateImage result draws its grid from meta.files, before any turn-end card', () => {
  const calls = [{ name: 'GenerateImage', result: { toolUseId: 'g', meta: { images: ['/o/a.png', '/o/b.png'], files: [file('a.png'), file('b.png')] } } }];
  const cards = generatedCards(calls);
  expect(cards.map((c) => [c.toolUseId, c.image, c.name])).toEqual([['g', 0, 'a.png'], ['g', 1, 'b.png']]);
});

test('the turn-end cards for generated files are known by name and kept out of the file cards', () => {
  const calls = [{ name: 'GenerateImage', result: { toolUseId: 'g', meta: { images: ['/o/a.png'], files: [file('a.png')] } } }, share('s1', 'a.png'), share('s3', 'other.png')];
  expect([...generatedNames(calls)]).toEqual(['a.png']);
  expect(generatedCards(calls).map((c) => c.toolUseId)).toEqual(['g']);
});

test('a failed call, a ShareFile call or a non-picture file makes no grid cell', () => {
  expect(generatedCards([{ name: 'GenerateImage', result: { toolUseId: 'g', isError: true, meta: { files: [file('a.png')] } } }])).toEqual([]);
  expect(generatedCards([{ name: 'ShareFile', result: { toolUseId: 's', meta: { files: [file('a.png')] } } }])).toEqual([]);
  expect(generatedCards([{ name: 'GenerateImage', result: { toolUseId: 'g', meta: { files: [file('a.txt', 'text/plain'), { bad: 1 }] } } }])).toEqual([]);
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
