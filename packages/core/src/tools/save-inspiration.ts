/**
 * SaveInspiration: the owner's inspiration board. A design reference (an X
 * post, a video, a site) becomes a memory of kind "inspiration": its URL, tags,
 * the owner's note, the post's text and the paths of its contact sheets or
 * screenshot. ReadPost reads X posts and videos; Capture takes one 1440 px
 * light shot of a site. The files are copied to <home>/inspiration/<item>, so
 * they outlive the session's outputs folder. MemorySearch with kind
 * "inspiration" finds items again and fences their text as untrusted.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { captureUrl } from '../browser/capture';
import { OWNER_ID } from '../people/context';
import { parsePostUrl, ReadPostTool } from './read-post';
import type { Tool, ToolContext, ToolOutput } from './types';
import { fail } from './util';

export const INSPIRATION_LIMITS = { tags: 12, noteChars: 1000, textChars: 6000 };
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
/** The first line of every inspiration memory; MemorySearch reads the URL back from it. */
export const INSPIRATION_PREFIX = 'Inspiration: ';

/** Tests replace ReadPost (fxtwitter and ffmpeg are not reachable there). */
let readPost: (input: { url: string }, ctx: ToolContext) => Promise<ToolOutput> = (input, ctx) => ReadPostTool.run(input, ctx);
export function setSaveInspirationReadPost(f?: typeof readPost): void {
  readPost = f ?? ((input, ctx) => ReadPostTool.run(input, ctx));
}

export function inspirationTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const tags = list.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')).filter(Boolean);
  return [...new Set(tags)].slice(0, INSPIRATION_LIMITS.tags);
}

/** The text inside ReadPost's <untrusted_web_content> block, still defused; it is fenced again when read back. */
function postWords(text: string): string {
  return /<untrusted_web_content source="[^"]*">\n([\s\S]*?)\n<\/untrusted_web_content>/.exec(text)?.[1] ?? '';
}

function textOf(out: ToolOutput): string {
  return typeof out.content === 'string' ? out.content : out.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/** The page title from a Capture report, best effort. */
function pageTitle(report: string): string | undefined {
  try {
    const page = String(JSON.parse(readFileSync(report, 'utf8')).page ?? '');
    const m = /"title":\s*"((?:[^"\\]|\\.)*)"/.exec(page);
    return m ? String(JSON.parse(`"${m[1]}"`)).slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/** The memory's text: the facts first, the outside words last. */
export function inspirationContent(o: { url: string; source: string; tags: string[]; note?: string; files: string[]; title?: string; text?: string }): string {
  const lines = [`${INSPIRATION_PREFIX}${o.url}`, `Source: ${o.source}`];
  if (o.tags.length) lines.push(`Tags: ${o.tags.join(', ')}`);
  if (o.note) lines.push(`Owner's note: ${o.note}`);
  if (o.title) lines.push(`Title: ${o.title}`);
  lines.push(`Files: ${o.files.length ? o.files.join(', ') : 'none'}`);
  if (o.text) lines.push('', o.text.length > INSPIRATION_LIMITS.textChars ? `${o.text.slice(0, INSPIRATION_LIMITS.textChars)}\n[... cut]` : o.text);
  return lines.join('\n');
}

const DESCRIPTION = `Save a design reference to the owner's inspiration board: an x.com post, a video file or any web page.

- url: the link. X posts and videos are read with ReadPost (text, contact sheets of the motion); a site gets one 1440 px light screenshot with Capture.
- tags: a few short words for what it shows, e.g. ascii, scroll, 3d, typography, hero, login, dashboard, motion, colour.
- note: optional, what the owner likes about it.
- The text, tags and file paths are stored as a memory of kind "inspiration"; the files are kept in the hub's inspiration folder. Saving the same URL again replaces the old item.
- To find items for a design brief: MemorySearch with kind "inspiration".`;

export const SaveInspirationTool: Tool<{ url: string; tags?: string[]; note?: string }> = {
  name: 'SaveInspiration',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'An x.com post, a .mp4/.webm/.mov URL, or any http(s) page' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Short keywords: ascii, scroll, 3d, typography, hero, login, dashboard, motion, colour...' },
      note: { type: 'string', description: 'What the owner likes about it' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  readOnly: false,
  optIn: true,
  timeoutMs: 300_000,
  summarize: (input) => `Save inspiration ${input.url}`,
  async run(input, ctx) {
    // the board is the owner's: a member never gets the tool (engine MEMBER_DENY), and this stops a stray call
    if (ctx.session.accountId && ctx.session.accountId !== OWNER_ID) return fail("The inspiration board is the hub owner's; a member's session cannot save to it.");
    const home = ctx.host.inspirationDir?.();
    if (!home) return fail('The inspiration board works only on the hub.');
    const tags = inspirationTags(input.tags);
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, INSPIRATION_LIMITS.noteChars) : '';

    const post = parsePostUrl(input.url);
    let url: string;
    let source: string;
    let found: string[] = [];
    let title: string | undefined;
    let text: string | undefined;
    if (!('error' in post)) {
      url = post.url;
      source = post.kind === 'post' ? 'x.com post (ReadPost)' : 'video (ReadPost)';
      const out = await readPost({ url: input.url }, ctx);
      if (out.isError) return fail(`ReadPost could not read it: ${textOf(out).slice(0, 500)}`);
      text = postWords(textOf(out)) || undefined;
      const dir = typeof out.meta?.dir === 'string' ? out.meta.dir : undefined;
      if (dir) found = readdirSync(dir).filter((f) => IMAGE.test(f)).sort().map((f) => join(dir, f));
    } else {
      const u = captureUrl(input.url);
      if ('error' in u) return fail(u.error);
      if (!ctx.host.capture) return fail('Saving a site needs the hub browser (Capture).');
      url = u.href;
      source = 'web page (Capture, 1440 px light)';
      try {
        const r = await ctx.host.capture(u.href, { widths: [1440], themes: ['light'], browsers: ['chromium'], scroll: false }, ctx.signal);
        const b = r.results.find((x) => x.shots.length);
        if (!b) return fail(`Capture made no screenshot: ${r.results.map((x) => x.error).filter(Boolean).join('; ') || 'no browser ran'}`);
        found = [b.shots[0].png];
        title = pageTitle(b.report);
      } catch (e) {
        return fail(`Capture failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // a stable folder per URL, so a second save replaces the first
    const item = `${'error' in post ? 'site' : post.kind}-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
    const dest = join(home, item);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const files = found.map((f) => {
      const to = join(dest, basename(f));
      copyFileSync(f, to);
      return to;
    });

    try {
      const old = (await ctx.host.memory.search(url, { kinds: ['inspiration'], limit: 50 })).filter((h) => h.content.split('\n', 1)[0] === `${INSPIRATION_PREFIX}${url}`);
      for (const h of old) await ctx.host.memory.remove(h.id);
      const entry = await ctx.host.memory.save({ content: inspirationContent({ url, source, tags, note: note || undefined, files, title, text }), kind: 'inspiration', scope: 'global', tags, sourceSessionId: ctx.sessionId });
      return {
        content: [`Saved inspiration ${entry.id}${old.length ? ' (replaced the earlier save)' : ''}: ${url}`, `Tags: ${tags.join(', ') || 'none'}`, `Files: ${files.join(', ') || 'none'}`].join('\n'),
        meta: { memoryId: entry.id, dir: dest, files },
      };
    } catch (err) {
      return fail(`Could not save the item: ${(err as Error).message}`);
    }
  },
};
