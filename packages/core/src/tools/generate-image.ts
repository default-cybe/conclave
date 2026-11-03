/**
 * GenerateImage: make pictures with an image model (docs/design/IMAGE-GENERATION.md).
 * The host sends the call through the session account's own providers and
 * writes the usage row (images/generate.ts); this tool maps the plain tiers,
 * reads reference images, and saves each result in the session's outputs
 * folder with a .json sidecar (prompt, model, size, quality, revised prompt).
 * The runner's turn-end pass gives every new outputs file a card, so the
 * pictures show in the reply. Opt-in: the chat and the assistant name it.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { insideFolder, mediaTypeOf, SHARE_MAX_BYTES, usesOutputs } from '../files/share';
import type { ImageRequest } from '../providers/types';
import { ProviderError } from '../providers/types';
import type { Tool } from './types';
import { fail } from './util';

export interface GenerateImageInput {
  prompt: string;
  size?: 'square' | 'portrait' | 'landscape';
  quality?: 'standard' | 'best';
  n?: number;
  images?: string[];
}

/** The shapes the tool offers, as sizes gpt-image models take. */
export const IMAGE_SIZES = { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' } as const;

/** standard is the owner's normal (medium); best, only when the owner asks for it, is the highest quality the tool exposes. */
export const IMAGE_QUALITY = { standard: 'medium', best: 'high' } as const;

const MAX_REFS = 16;
const REF_MAX_BYTES = 20 * 1024 * 1024;
const REF_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const DESCRIPTION = `Make pictures with an image model and show them in your reply. Call it whenever the user asks for an image in plain words, for example:
- "generate an image of a fox in the snow", "make me a picture of our cabin at sunset"
- "draw a cat in a space suit", "sketch a robot"
- "a logo for my coffee shop", "an icon for the app"
- "a wallpaper for my phone" (portrait), "a desktop wallpaper" (landscape)
- "make it darker" or "same but blue" about an image you made before: pass it in images.

Write a full, concrete prompt from the user's words: subject, style, setting, light, colors, any text to render. Do not call it for charts, diagrams or text layouts: write SVG or HTML and use RenderFile for those.

- size: square (default), portrait or landscape.
- quality: standard (default). Use best only when the user asks for the best, highest quality or maximum detail.
- n: 1 to 4 versions (default 1).
- images: optional references or the picture to edit: file names in your outputs folder (images you made earlier), or "attached:1" for the newest picture the user attached in this chat, "attached:2" for the one before.

The pictures are saved in your outputs folder and shown to the user as cards; you do not need ShareFile. If the provider refuses, tell the user what it said; do not reword the prompt to get around a refusal.`;

export const GenerateImageTool: Tool<GenerateImageInput> = {
  name: 'GenerateImage',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to draw, in full' },
      size: { type: 'string', enum: ['square', 'portrait', 'landscape'] },
      quality: { type: 'string', enum: ['standard', 'best'] },
      n: { type: 'integer', minimum: 1, maximum: 4 },
      images: { type: 'array', items: { type: 'string' }, maxItems: MAX_REFS, description: 'Outputs file names or "attached:N" to use as references or to edit' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  readOnly: false,
  // acceptEdits lets it run like Write: it only writes new files in the outputs folder
  editsFiles: true,
  optIn: true,
  timeoutMs: 300_000,
  summarize: (i) => `Make an image: ${String(i.prompt ?? '').slice(0, 60)}`,
  async run(input, ctx) {
    if (!ctx.host.generateImage) return fail('Image generation is not available on this hub.');
    if (!usesOutputs(ctx.session) || !ctx.host.outputsDir) return fail('GenerateImage works only in a chat or a session that keeps files in its outputs folder on the hub.');
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) return fail('Give a prompt: what to draw.');
    if (prompt.length > 4000) return fail('The prompt is over 4000 characters. Make it shorter.');
    const sizeWord = input.size && input.size in IMAGE_SIZES ? input.size : 'square';
    const size = IMAGE_SIZES[sizeWord];
    const quality = IMAGE_QUALITY[input.quality === 'best' ? 'best' : 'standard'];
    const n = Math.min(4, Math.max(1, Math.floor(Number(input.n) || 1)));
    const dir = ctx.host.outputsDir();
    const refs = await readRefs(input.images, dir, ctx.host.chatImages?.() ?? []);
    if ('error' in refs) return fail(refs.error);
    const full = ctx.host.diskRefusal?.(n * 4 * 1024 * 1024);
    if (full) return fail(full);
    ctx.progress('Making an image');
    const req: Omit<ImageRequest, 'model'> = { prompt, size, quality, n, signal: ctx.signal, ...(refs.list.length ? { images: refs.list } : {}) };
    let out;
    try {
      out = await ctx.host.generateImage(req);
    } catch (e) {
      if (ctx.signal.aborted) return fail('Stopped.');
      const msg = e instanceof Error ? e.message : String(e);
      return fail(e instanceof ProviderError ? `The image provider said: ${msg}` : msg);
    }
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const saved: string[] = [];
    for (const [i, img] of out.images.entries()) {
      if (img.bytes.length > SHARE_MAX_BYTES) return fail(`Image ${i + 1} came out at ${(img.bytes.length / 1024 / 1024).toFixed(1)} MB, over the 30 MB file limit.`);
      const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime === 'image/webp' ? 'webp' : 'png';
      const path = await freeName(dir, `image-${stamp}${out.images.length > 1 ? `-${i + 1}` : ''}`, ext);
      await writeFile(path, img.bytes);
      const sidecar = { prompt, model: out.ref, size, quality, ...(img.revisedPrompt ? { revisedPrompt: img.revisedPrompt } : {}), ...(refs.names.length ? { references: refs.names } : {}), createdAt: new Date().toISOString() };
      await writeFile(`${path}.json`, `${JSON.stringify(sidecar, null, 2)}\n`);
      saved.push(path);
    }
    const revised = out.images.find((x) => x.revisedPrompt)?.revisedPrompt;
    const secs = Math.round(out.latencyMs / 1000);
    const words = `Saved ${saved.length} image${saved.length > 1 ? 's' : ''}: ${saved.map((p) => basename(p)).join(', ')} (${out.ref}, ${size}, ${quality}, ${secs} s). They show to the user as cards in your reply.${revised ? `\nRevised prompt: ${revised}` : ''}`;
    return { content: words, meta: { images: saved, model: out.ref, size, quality, latencyMs: out.latencyMs } };
  },
};

/** A name not taken yet: image-20261103-101500.png, then -2, -3. */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  for (let k = 1; ; k++) {
    const p = join(dir, `${base}${k > 1 ? `-${k}` : ''}.${ext}`);
    if (!(await stat(p).catch(() => undefined))) return p;
  }
}

type Ref = NonNullable<ImageRequest['images']>[number];

/** Reference pictures: outputs files (never outside the folder, never a URL) or the chat's attachments. */
async function readRefs(raw: unknown, dir: string, attached: Ref[]): Promise<{ list: Ref[]; names: string[] } | { error: string }> {
  if (raw === undefined || raw === null) return { list: [], names: [] };
  if (!Array.isArray(raw)) return { error: 'images must be a list of file names.' };
  if (raw.length > MAX_REFS) return { error: `At most ${MAX_REFS} reference images.` };
  const list: Ref[] = [];
  const names: string[] = [];
  for (const item of raw) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (!s) continue;
    const at = /^attached:(\d+)$/i.exec(s);
    if (at) {
      const img = attached[Number(at[1]) - 1];
      if (!img) return { error: `No attached picture ${s}: this chat has ${attached.length}.` };
      list.push(img);
      names.push(s);
      continue;
    }
    if (/^[a-z]+:\/\//i.test(s)) return { error: 'images takes outputs file names or attached:N, not URLs.' };
    const path = isAbsolute(s) ? resolve(s) : resolve(dir, s);
    if (!insideFolder(dir, path)) return { error: `Refused: reference images come only from the outputs folder (${dir}) or the chat's attachments.` };
    const mime = mediaTypeOf(path);
    if (!REF_TYPES.has(mime)) return { error: `${basename(path)} is not a PNG, JPEG or WebP picture.` };
    const st = await stat(path).catch(() => undefined);
    if (!st?.isFile()) return { error: `No file ${basename(path)} in the outputs folder.` };
    if (st.size > REF_MAX_BYTES) return { error: `${basename(path)} is over 20 MB.` };
    list.push({ bytes: new Uint8Array(await readFile(path)), mime, name: basename(path) });
    names.push(basename(path));
  }
  return { list, names };
}
