/**
 * Pictures a tool returned (browser_screenshot, a Read of a PNG, a notebook's
 * plot) as a row of thumbnails under the tool's row, so a screenshot is seen
 * without opening the fold. Appearance > "Show pictures from tools in the
 * transcript" (store/ui.ts toolImages, on by default) turns the row outside
 * the fold off; inside an open row the pictures always show (`always`).
 * Fixed-size boxes and lazy, async-decoded images keep scrolling smooth. A tap
 * opens the media viewer (components/ui/ImageViewer.tsx).
 */
import { memo } from 'react';
import type { ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { cn } from '@/lib/text';
import { useUi } from '@/store/ui';
import { MediaButton, type MediaItem } from '@/components/ui/ImageViewer';

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
  const pics = result.content.filter((b): b is Extract<typeof b, { type: 'image' }> => b.type === 'image' && !!(b.url || b.data));
  return pics.map((b, i) => {
    const ext = b.mediaType.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png';
    const name = /\.\w+$/.test(base) && pics.length === 1 ? base : `${base.replace(/\.\w+$/, '')}-${i + 1}.${ext}`;
    return { key: `${result.toolUseId}:${i}`, name, mediaType: b.mediaType, src: b.url ?? `data:${b.mediaType};base64,${b.data}` };
  });
}

export const ToolImages = memo(function ToolImages({ items, always, className }: { items: MediaItem[]; always?: boolean; className?: string }) {
  const on = useUi((s) => s.toolImages);
  if (!items.length || (!on && !always)) return null;
  return (
    <div className={cn('flex flex-wrap gap-2', className)} data-tool-images={items.length}>
      {items.map((it) => (
        <MediaButton key={it.key} item={it} label={`Open ${it.name}`} className="block overflow-hidden rounded-[var(--r-2)] border border-rule bg-sunk p-0 hov:border-rule-2">
          <img src={it.src} alt={it.name} loading="lazy" decoding="async" draggable={false} className="block h-[96px] w-[152px] object-cover object-top phone:h-[104px] phone:w-[164px]" />
        </MediaButton>
      ))}
    </div>
  );
});
