import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiGenerateImage } from '../../src/providers/openai-shared';
import { generateImageFor, type ImageDeps } from '../../src/images/generate';
import { GenerateImageTool, IMAGE_QUALITY } from '../../src/tools/generate-image';
import { lookupModel } from '../../src/providers/catalog';
import type { Provider } from '../../src/providers/types';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cv-img-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeServer(reply: (body: Record<string, unknown>, origin: string) => unknown) {
  const seen: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/pic.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ path: url.pathname, auth: req.headers.get('authorization'), ...body });
      const r = reply(body, url.origin);
      return r instanceof Response ? r : Response.json(r);
    },
  });
  return { base: `http://localhost:${server.port}/v1`, seen, stop: () => server.stop(true) };
}

const http = { provider: 'cliproxy' } as never;

describe('openaiGenerateImage', () => {
  test('posts /images/generations and reads b64_json', async () => {
    const s = fakeServer(() => ({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a red fox' }] }));
    const out = await openaiGenerateImage(s.base, { authorization: 'Bearer k' }, http, { model: 'gpt-image-2.5', prompt: 'fox', size: '1024x1024', quality: 'medium', n: 9 });
    s.stop();
    expect(s.seen[0]).toMatchObject({ path: '/v1/images/generations', model: 'gpt-image-2.5', prompt: 'fox', size: '1024x1024', quality: 'medium', n: 4 });
    expect(Buffer.from(out.images[0].bytes)).toEqual(PNG);
    expect(out.images[0].revisedPrompt).toBe('a red fox');
  });

  test('fetches a url answer', async () => {
    const s = fakeServer((_b, origin) => ({ data: [{ url: `${origin}/pic.png` }] }));
    const out = await openaiGenerateImage(s.base, {}, http, { model: 'gpt-image-2.5', prompt: 'fox' });
    s.stop();
    expect(Buffer.from(out.images[0].bytes)).toEqual(PNG);
    expect(out.images[0].mime).toBe('image/png');
  });

  test('a refusal shows as the provider error', async () => {
    const s = fakeServer(() => new Response(JSON.stringify({ error: { message: 'Your request was rejected by the safety system' } }), { status: 400 }));
    await expect(openaiGenerateImage(s.base, {}, http, { model: 'gpt-image-2.5', prompt: 'x' })).rejects.toThrow(/safety system/);
    s.stop();
  });
});

test('image models are kind image (kept out of the chat picker)', () => {
  expect(lookupModel('cliproxy', 'gpt-image-2.5').kind).toBe('image');
  expect(lookupModel('openai', 'gpt-5.5').kind).toBeUndefined();
});

function deps(opts: { source?: 'hub' | 'own' | 'none'; provider?: Partial<Provider> } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const calls: unknown[] = [];
  const provider = { generateImage: async (r: unknown) => (calls.push(r), { images: [{ bytes: new Uint8Array(PNG), mime: 'image/png', revisedPrompt: 'rp' }] }), ...opts.provider } as unknown as Provider;
  const d: ImageDeps = {
    config: { get: () => ({ providers: { cliproxy: { type: 'openai', subscription: 'chatgpt' } } as never }) },
    providersFor: () => ({ get: (id) => (id === 'cliproxy' ? provider : undefined) }),
    access: { source: () => opts.source ?? 'hub' },
    usage: { record: (r) => void rows.push(r as never) },
  };
  return { d, rows, calls };
}

describe('generateImageFor', () => {
  test('owner call on the default model writes an image usage row', async () => {
    const { d, rows, calls } = deps();
    const out = await generateImageFor(d, { prompt: 'fox', quality: 'medium', size: '1024x1024', accountId: 'owner', sessionId: 's1' });
    expect(out.ref).toBe('cliproxy/gpt-image-2.5');
    expect(calls[0]).toMatchObject({ model: 'gpt-image-2.5', prompt: 'fox' });
    expect(rows[0]).toMatchObject({ purpose: 'image', provider: 'cliproxy', model: 'gpt-image-2.5', sessionId: 's1', costUsd: 0, apiValueUsd: 0.042 });
  });

  test('a member with their own key uses it; without one is refused', async () => {
    const own = deps({ source: 'own' });
    await generateImageFor(own.d, { prompt: 'fox', accountId: 'acct_m1' });
    expect(own.rows[0]).toMatchObject({ paidBy: 'own', accountId: 'acct_m1' });
    const none = deps({ source: 'hub' });
    await expect(generateImageFor(none.d, { prompt: 'fox', accountId: 'acct_m1' })).rejects.toThrow(/never the hub owner's/);
    expect(none.calls.length).toBe(0);
  });
});

describe('GenerateImage tool', () => {
  const ctxFor = (dir: string, gen: (r: Record<string, unknown>) => unknown) =>
    ({
      session: { kind: 'chat', device: 'local', cwd: dir, id: 's1' },
      host: { outputsDir: () => dir, generateImage: gen, chatImages: () => [] },
      signal: new AbortController().signal,
      progress: () => {},
    }) as never;

  test('saves the picture and its sidecar; best maps to high', async () => {
    expect(IMAGE_QUALITY.best).toBe('high');
    const dir = tmp();
    let asked: Record<string, unknown> = {};
    const res = await GenerateImageTool.run({ prompt: 'a fox', quality: 'best', size: 'landscape' }, ctxFor(dir, async (r) => ((asked = r), { ref: 'cliproxy/gpt-image-2.5', latencyMs: 1200, images: [{ bytes: new Uint8Array(PNG), mime: 'image/png', revisedPrompt: 'a red fox' }] })));
    expect(res.isError).toBeFalsy();
    expect(asked).toMatchObject({ quality: 'high', size: '1536x1024', n: 1 });
    const files = readdirSync(dir).sort();
    expect(files.length).toBe(2);
    const png = files.find((f) => f.endsWith('.png'))!;
    expect(readFileSync(join(dir, png))).toEqual(PNG);
    expect(JSON.parse(readFileSync(join(dir, `${png}.json`), 'utf8'))).toMatchObject({ prompt: 'a fox', model: 'cliproxy/gpt-image-2.5', size: '1536x1024', quality: 'high', revisedPrompt: 'a red fox' });
    expect((res.meta?.images as string[])[0]).toBe(join(dir, png));
  });

  test('standard is medium; provider errors show plainly', async () => {
    const dir = tmp();
    let asked: Record<string, unknown> = {};
    const { ProviderError } = await import('../../src/providers/types');
    const res = await GenerateImageTool.run({ prompt: 'x' }, ctxFor(dir, async (r) => {
      asked = r;
      throw new ProviderError('quota', 'insufficient_quota');
    }));
    expect(asked.quality).toBe('medium');
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('The image provider said: insufficient_quota');
  });

  test('a reference outside the outputs folder is refused', async () => {
    const res = await GenerateImageTool.run({ prompt: 'x', images: ['/etc/passwd'] }, ctxFor(tmp(), async () => ({})));
    expect(res.isError).toBe(true);
  });
});
