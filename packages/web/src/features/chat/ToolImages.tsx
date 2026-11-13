/**
 * The pictures of a stretch of work as one row of thumbnails per group of
 * calls, outside the fold (as Android's ToolFold.kt ThumbRow): first the
 * pictures the tools returned (browser_screenshot, a Read of a PNG, a
 * notebook's plot), then the pictures and videos ShareFile handed the owner.
 * A picture is never shown twice, and a shared one is never a big card
 * (pictureRows). Appearance > "Show pictures from tools in the transcript"
 * (store/ui.ts toolImages, on by default) turns the tools' pictures off; the
 * shared ones always show. Fixed-size boxes and lazy, async-decoded images
 * keep scrolling smooth. A tap opens the media viewer
 * (components/ui/ImageViewer.tsx), where Download is; Left and Right step
 * through every thumbnail around it.
 */
import { memo, useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { cn } from '@/lib/text';
import { MediaButton, type MediaItem } from '@/components/ui/ImageViewer';
import { mediaItem } from '@/features/files/FileCard';
import { captionOf, fileCardOf, generatedNames, sharedThumb, type FileCardData } from '@/features/files/words';

type Call = { tool: Pick<ToolUseBlock, 'name' | 'input'>; result?: ToolResultBlock };

/** Per result, so a redraw of the transcript never builds the big data: URLs again. */
const made = new WeakMap<ToolResultBlock, MediaItem[]>();

/** The pictures in the calls' results, as viewer items: "browser_screenshot-1.png", or the file name a Read was given. */
export function toolImageItems(calls: readonly Call[]): MediaItem[] {
  return calls.flatMap(({ tool, result }) => {
    if (!result || typeof result.content === 'string') return [];
    let list = made.get(result);
    if (!list) made.set(result, (list = picturesOf(tool, result)));
    return list;
  });
}

function picturesOf(tool: Call['tool'], result: ToolResultBlock): MediaItem[] {
  if (typeof result.content === 'string') return [];
  const path = tool.input?.file_path ?? tool.input?.path ?? tool.input?.notebook_path;
  const base = typeof path === 'string' && path ? path.split(/[\\/]/).pop()! : tool.name.replace(/^mcp__/, '').replace(/__/g, '-');
  // a url from an imported file goes into <img> and a Download link: web and picture data only
  const pics = result.content.filter((b): b is Extract<typeof b, { type: 'image' }> => b.type === 'image' && (b.url ? /^(https?:|data:image\/|blob:)/i.test(b.url) : !!b.data));
  return pics.map((b, i) => {
    const ext = b.mediaType.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png';
    const name = /\.\w+$/.test(base) && pics.length === 1 ? base : `${base.replace(/\.\w+$/, '')}-${i + 1}.${ext}`;
    return { key: `${result.toolUseId}:${i}`, name, mediaType: b.mediaType, src: b.url ?? `data:${b.mediaType};base64,${b.data}` };
  });
}

/** The path or URL a call names, without a query or fragment, with forward slashes. */
function named(input: Record<string, unknown> | undefined): string | undefined {
  for (const k of ['file_path', 'path', 'filePath', 'notebook_path', 'url']) {
    const v = input?.[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    // "./a.png" and "x/./a.png" are "a.png" and "x/a.png", so a relative Read matches the share
    const p = v.trim().split(/[?#]/)[0].replace(/\\/g, '/').replace(/\/+$/, '').replace(/(^|\/)(\.\/)+/g, '$1');
    if (p) return p;
  }
  return undefined;
}

/** A file as a row matches it: its name, lowercased, and the path it came by when known (as Android: two folders that differ in case are two files). */
type Source = { name: string; path?: string };
const source = (name: string, path?: string): Source => ({ name: name.split(/[\\/]/).pop()!.trim().toLowerCase(), path });

/** One name, and one path, or one path the end of the other (a relative Read of an absolute share), or a path unknown. */
export function sameFile(a: Source, b: Source): boolean {
  return a.name === b.name && (!a.path || !b.path || a.path === b.path || a.path.endsWith(`/${b.path}`) || b.path.endsWith(`/${a.path}`));
}

/**
 * The thumbnail rows of a stretch of work, one per group of calls (Android
 * Media.rows): the group's tool pictures first, while `tools` is on, then
 * the pictures and videos its ShareFile calls handed the owner (a picture
 * GenerateImage made stays in its grid). Each file shows once in the stretch,
 * matched by file name and, when both calls give one, path: a shared picture
 * a call also returned (a Read of the PNG, then ShareFile) is one thumbnail
 * at the tool picture's place, which opens the shared file and carries its
 * name, size and caption. Two files of one name in different folders both
 * show. Other shared files stay cards (FileCard.tsx FileCards).
 */
export function pictureRows(groups: readonly (readonly Call[])[], sessionId: string, tools: boolean): MediaItem[][] {
  const calls = groups.flat();
  const madeNames = generatedNames(calls.map((c) => ({ name: c.tool.name, result: c.result })));
  const shared: Array<{ card: FileCardData; src: Source }> = [];
  for (const c of calls) {
    const card = c.tool.name === 'ShareFile' ? fileCardOf(c.result) : undefined;
    if (!card || madeNames.has(card.name) || !sharedThumb(card)) continue;
    const src = source(card.name, named(c.tool.input));
    if (!shared.some((s) => sameFile(s.src, src))) shared.push({ card, src });
  }
  const item = (card: FileCardData): MediaItem => ({ ...mediaItem(sessionId, card), caption: captionOf(card) });
  const claimed = new Set<FileCardData>();
  const shown: Source[] = [];
  const rows = groups.map((group) =>
    (tools ? group : []).flatMap((c) => {
      const path = named(c.tool.input);
      const file = path && /\.(png|jpe?g|webp|gif)$/i.test(path) ? path : undefined;
      return toolImageItems([c]).flatMap((it, i) => {
        // only the first picture of a call is the file it names
        const src = file && i === 0 ? source(file, path) : undefined;
        if (!src) return [it];
        if (shown.some((s) => sameFile(s, src))) return [];
        shown.push(src);
        const match = shared.find((s) => !claimed.has(s.card) && sameFile(s.src, src));
        if (!match) return [it];
        claimed.add(match.card);
        return [item(match.card)];
      });
    }),
  );
  for (const s of shared) {
    if (claimed.has(s.card) || shown.some((x) => sameFile(x, s.src))) continue;
    const g = groups.findIndex((group) => group.some((c) => c.tool.name === 'ShareFile' && c.result?.toolUseId === s.card.toolUseId));
    rows[g < 0 ? rows.length - 1 : g]?.push(item(s.card));
  }
  return rows;
}

/** One group's row (pictureRows of one group). */
export function pictureRow(calls: readonly Call[], sessionId: string, tools: boolean): MediaItem[] {
  return pictureRows([calls], sessionId, tools)[0];
}

/** The picture of a thumbnail: the bytes it carries, or a shared file's from the hub (FileCard.tsx fileBlob, one fetch per file). */
function useSrc(it: MediaItem): { src?: string; failed?: boolean } {
  const video = it.mediaType.startsWith('video/');
  const [got, setGot] = useState<{ key: string; src?: string; failed?: boolean }>();
  useEffect(() => {
    if (it.src || video || !it.load) return;
    let alive = true;
    it.load().then(
      (r) => alive && setGot({ key: it.key, src: r.url }),
      () => alive && setGot({ key: it.key, failed: true }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it.key, it.src, video]);
  return it.src ? { src: it.src } : got?.key === it.key ? got : {};
}

function Thumb({ it }: { it: MediaItem }) {
  const { src, failed } = useSrc(it);
  return (
    <div className="w-[152px] phone:w-[164px]">
      <MediaButton item={it} label={`Open ${it.caption ?? it.name}`} className="flex h-[96px] w-full items-center justify-center overflow-hidden rounded-[var(--r-2)] border border-rule bg-sunk p-0 hov:border-rule-2 phone:h-[104px]">
        {src ? (
          <img src={src} alt={it.caption ?? it.name} loading="lazy" decoding="async" draggable={false} className="block size-full object-cover object-top" />
        ) : it.mediaType.startsWith('video/') ? (
          <Play aria-hidden strokeWidth={1.75} className="size-7 text-fg-3" />
        ) : failed ? (
          <span className="px-2 text-center tx-12 text-fault">Could not load</span>
        ) : null}
      </MediaButton>
      {it.caption && (
        <p title={it.caption} className="mt-1 truncate tx-12 text-fg-3 phone:tx-13">
          {it.caption}
        </p>
      )}
    </div>
  );
}

export const ToolImages = memo(function ToolImages({ items, className }: { items: MediaItem[]; className?: string }) {
  if (!items.length) return null;
  return (
    <div className={cn('flex flex-wrap items-start gap-2', className)} data-tool-images={items.length}>
      {items.map((it) => (
        <Thumb key={it.key} it={it} />
      ))}
    </div>
  );
}, same);

/** A fresh array of the same thumbnails is no change (the rows are built again each render). */
function same(a: { items: MediaItem[]; className?: string }, b: typeof a): boolean {
  return a.className === b.className && a.items.length === b.items.length && a.items.every((it, i) => it.key === b.items[i].key && it.src === b.items[i].src && it.caption === b.items[i].caption);
}
