/**
 * Images for a model without vision (GLM-5.3): before a request, each image
 * in the active messages (attachments and tool results) gets a transcription
 * from a model that sees images, stored in its message's meta.imageText by a
 * hash of the image. The transcript build sends that text in place of the
 * image (transcript.ts imageText), so every later request sends the same
 * bytes and each image is read once. A note with the reason is stored when
 * the image is too large, the request has too many, or the call fails, so it
 * is never retried. No usable vision model: nothing is stored and the
 * provider sends its usual "not readable" note.
 */
import { basename } from 'node:path';
import type { ImageBlock, Message } from '../types';
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

export const VISION_PROMPT =
  'Transcribe all visible text in this image exactly, keeping its line breaks. Then briefly describe the image: its layout, any charts or diagrams and their values, and any UI. Reply with the transcription and the description only.';

/** The model that reads images for this account: models.vision, else the first of the small and default models with vision. Only models the account may use. */
export function visionModelFor(engine: Engine, accountId: string | undefined): string | undefined {
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
      if (!r.acp && (named ? seesImages(r.model, r.info, cfg.providers[r.provider]) : r.info.vision)) return ref;
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
  let model: string | null | undefined;
  let made = 0;
  for (const m of activeMessages(all)) {
    if (m.role !== 'user') continue;
    const found: Array<{ img: ImageBlock; name?: string }> = [];
    for (const b of m.content) {
      if (b.type === 'image') found.push({ img: b });
      else if (b.type === 'tool_result' && typeof b.content !== 'string' && !b.meta?.cleared) {
        for (const c of b.content) if (c.type === 'image') found.push({ img: c, name: files.get(b.toolUseId) });
      }
    }
    const own = textsOf(m);
    const add: Record<string, string> = {};
    for (const { img, name } of found) {
      const key = imageKey(img);
      if (own[key] || add[key]) continue;
      let text = known.get(key);
      if (text === undefined) {
        model ??= visionModelFor(engine, accountId) ?? null;
        if (!model) return;
        const label = name ? `image ${name} (${img.mediaType})` : `image (${img.mediaType})`;
        const note = (why: string) => `[${label} not readable by this model: ${why}]`;
        if ((img.data?.length ?? 0) > VISION_MAX_CHARS) text = note('too large to transcribe');
        else if (made >= VISION_MAX_PER_REQUEST) text = note(`more than ${VISION_MAX_PER_REQUEST} new images in one request`);
        else {
          made++;
          text = await transcribe(engine, model, img, sessionId, accountId, signal).then(
            (out) => (out ? `[${label}, transcribed by ${model}:\n${defuseFrameworkTags(out)}\n]` : note('the transcription came back empty')),
            (err) => {
              if (signal?.aborted || (err instanceof ProviderError && err.kind === 'aborted')) throw err;
              const why = oneLine((err as Error)?.message ?? String(err), 160);
              log.warn(`${sessionId}: ${model} could not transcribe an image: ${why}`);
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

async function transcribe(engine: Engine, model: string, img: ImageBlock, sessionId: string, accountId: string | undefined, signal?: AbortSignal): Promise<string> {
  const res = await streamCompletion(
    engine,
    model,
    { system: [], messages: [{ role: 'user', content: [img, { type: 'text', text: VISION_PROMPT }] }], maxTokens: 2000, signal },
    { purpose: 'vision', sessionId, ...(accountId ? { accountId } : {}) },
  );
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')
    .trim();
}
