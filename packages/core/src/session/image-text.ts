/**
 * Images and PDFs for a model without vision (GLM-5.3): before a request, each
 * image or PDF in the active messages (attachments and tool results) gets a transcription
 * from a model that sees images, stored in its message's meta.imageText by a
 * hash of the image. The transcript build sends that text in place of the
 * image (transcript.ts imageText), so every later request sends the same
 * bytes and each image is read once. A note with the reason is stored when
 * the image is too large, the request has too many, or the call fails, so it
 * is never retried. No usable vision model: nothing is stored and the
 * provider sends its usual "not readable" note.
 */
import { basename } from 'node:path';
import type { ContentBlock, DocumentBlock, ImageBlock, Message } from '../types';
import { mediaTypeFor } from '../attachments/limits';
import type { Engine } from '../engine/engine';
import { ProviderError } from '../providers/types';
import { seesImages } from '../providers/common';
import { isMember } from '../people/context';
import { logger } from '../util/log';
import { oneLine } from '../util/text';
import { activeMessages, imageKey } from './transcript';
import { defuseFrameworkTags } from './untrusted';
import { streamCompletion } from './stream';

const log = logger('image-text');

/** Larger images (base64 characters, about 3.75 MB) keep a note. */
export const VISION_MAX_CHARS = 5 * 1024 * 1024;
/** New transcriptions one request makes at most; the images past it keep a note. */
export const VISION_MAX_PER_REQUEST = 8;
/** New PDF transcriptions one request makes at most: each can take a 16k-token call before the main request. */
export const VISION_MAX_PDFS_PER_REQUEST = 2;
/** Output room for one transcription; a PDF holds pages of text, so it gets more than a picture. */
const MAX_TOKENS = { image: 2000, PDF: 16_000 };

export const VISION_PROMPT =
  'Transcribe all visible text in this image exactly, keeping its line breaks. Then briefly describe the image: its layout, any charts or diagrams and their values, and any UI. Reply with the transcription and the description only.';

export const PDF_PROMPT =
  'Transcribe all text in this PDF exactly, page by page, keeping its line breaks and tables. Briefly describe any figures, charts and their values where they appear. Reply with the transcription only.';

/** An image, or a PDF with its bytes: what the vision model reads for a model without vision. */
function readable(b: ContentBlock): b is ImageBlock | DocumentBlock {
  return b.type === 'image' || (b.type === 'document' && !!b.data && mediaTypeFor(b.mediaType, b.title) === 'application/pdf');
}

/**
 * The model that reads images for this account: models.vision, else the first of the small and default models with vision. Only models the account may use.
 * For a PDF the catalog must say vision, even for the named model: the Chat Completions wire sends PDFs only to those (openai.ts chatMessages).
 */
export function visionModelFor(engine: Engine, accountId: string | undefined, pdf = false): string | undefined {
  const cfg = engine.config.get();
  const prefs = accountId && isMember(accountId) ? engine.accountPrefs(accountId) : {};
  const picks: Array<[string | undefined, boolean]> = [
    [cfg.models?.vision, true],
    [prefs.smallModel ?? cfg.smallModel, false],
    [prefs.defaultModel ?? cfg.defaultModel, false],
  ];
  for (const [ref, named] of picks) {
    if (!ref || !engine.isUsable(ref, accountId)) continue;
    try {
      const r = engine.providersFor(accountId).resolve(ref);
      // the owner's named model is trusted the way the providers trust an unknown one; a guess needs the catalog's word
      if (!r.acp && (named && !pdf ? seesImages(r.model, r.info, cfg.providers[r.provider]) : r.info.vision)) return ref;
    } catch {
      // not resolvable for this account: the next one
    }
  }
  return undefined;
}

/** Give every image in the session's active messages a stored transcription (or a note). Throws only when aborted. */
export async function transcribeImages(engine: Engine, sessionId: string, accountId: string | undefined, signal?: AbortSignal): Promise<void> {
  const all = engine.repos.messages.list(sessionId);
  const known = new Map<string, string>();
  for (const m of all) for (const [k, v] of Object.entries(textsOf(m))) known.set(k, v);
  const files = new Map<string, string>();
  for (const m of all) {
    for (const b of m.content) {
      const p = b.type === 'tool_use' ? (b.input.file_path ?? b.input.path) : undefined;
      if (b.type === 'tool_use' && typeof p === 'string') files.set(b.id, basename(p));
    }
  }
  const models: Partial<Record<'image' | 'PDF', string | null>> = {};
  const made = { image: 0, PDF: 0 };
  const cap = { image: VISION_MAX_PER_REQUEST, PDF: VISION_MAX_PDFS_PER_REQUEST };
  for (const m of activeMessages(all)) {
    if (m.role !== 'user') continue;
    const found: Array<{ img: ImageBlock | DocumentBlock; name?: string }> = [];
    for (const b of m.content) {
      if (readable(b)) found.push({ img: b, name: b.type === 'document' ? b.title : undefined });
      else if (b.type === 'tool_result' && typeof b.content !== 'string' && !b.meta?.cleared) {
        for (const c of b.content) if (readable(c)) found.push({ img: c, name: files.get(b.toolUseId) });
      }
    }
    const own = textsOf(m);
    const add: Record<string, string> = {};
    for (const { img, name } of found) {
      const key = imageKey(img);
      if (own[key] || add[key]) continue;
      let text = known.get(key);
      if (text === undefined) {
        const kind = img.type === 'document' ? 'PDF' : 'image';
        const model = (models[kind] ??= visionModelFor(engine, accountId, kind === 'PDF') ?? null);
        if (!model) continue;
        const label = name ? `${kind} ${name} (${img.mediaType})` : `${kind} (${img.mediaType})`;
        const note = (why: string) => `[${label} not readable by this model: ${why}]`;
        if ((img.data?.length ?? 0) > VISION_MAX_CHARS) text = note('too large to transcribe');
        else if (made[kind] >= cap[kind]) text = note(`more than ${cap[kind]} new ${kind}s in one request`);
        else {
          made[kind]++;
          text = await transcribe(engine, model, img, sessionId, accountId, signal).then(
            (out) => (out ? `[${label}, transcribed by ${model}:\n${defuseFrameworkTags(out)}\n]` : note('the transcription came back empty')),
            (err) => {
              if (signal?.aborted || (err instanceof ProviderError && err.kind === 'aborted')) throw err;
              const why = oneLine((err as Error)?.message ?? String(err), 160);
              log.warn(`${sessionId}: ${model} could not transcribe an ${kind}: ${why}`);
              return note(`transcription by ${model} failed: ${why}`);
            },
          );
        }
      }
      add[key] = text;
      known.set(key, text);
    }
    if (Object.keys(add).length) engine.updateMessage(m.id, { meta: { ...m.meta, imageText: { ...own, ...add } } });
  }
}

function textsOf(m: Message): Record<string, string> {
  return (m.meta?.imageText as Record<string, string> | undefined) ?? {};
}

async function transcribe(engine: Engine, model: string, img: ImageBlock | DocumentBlock, sessionId: string, accountId: string | undefined, signal?: AbortSignal): Promise<string> {
  const pdf = img.type === 'document';
  const maxTokens = MAX_TOKENS[pdf ? 'PDF' : 'image'];
  const res = await streamCompletion(
    engine,
    model,
    { system: [], messages: [{ role: 'user', content: [img, { type: 'text', text: pdf ? PDF_PROMPT : VISION_PROMPT }] }], maxTokens, signal },
    { purpose: 'vision', sessionId, ...(accountId ? { accountId } : {}) },
  );
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')
    .trim();
  // stored for good, so the reader must know it is not the whole thing
  if (text && res.stopReason === 'max_tokens') return `${text}\n[transcription cut at ${maxTokens} tokens, ${pdf ? 'later pages' : 'the rest'} missing]`;
  return text;
}
