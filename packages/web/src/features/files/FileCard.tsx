/**
 * File cards in the chat: a file a ShareFile call handed the owner (core
 * files/share.ts). Name, type and size, an inline picture for a PNG, JPEG,
 * GIF or SVG (a generated chart or graph), and Download. The bytes come from
 * GET /api/sessions/:id/files/:toolUseId with the token, as a Blob, the way
 * a map card's picture does (MapsCard.tsx). Text, code, PDF and the rest stay
 * a card. An SVG only ever draws as an <img> (the browser runs no script and
 * loads nothing in one), from a data: URL so even "open image in new tab" is an
 * opaque origin, never the app's; it has no Open. HTML never renders here.
 * The picture and View open the media viewer (components/ui/ImageViewer.tsx):
 * pictures, video, audio, PDF and text or code files; HTML shows as code there.
 */
import { useEffect, useState } from 'react';
import { Download, FileText, Maximize2 } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { Button, buttonClass, IconButton } from '@/components/ui/Button';
import { useIsMobile } from '@/lib/hooks';
import { MediaButton, mediaKind, type MediaItem } from '@/components/ui/ImageViewer';
import { fileCardOf, fileFacts, generatedCards, generatedNames, previewOf, shareCards, SVG_PREVIEW_MAX, type FileCardData } from './words';

const BOX = 'rounded-[var(--r-2)] border border-rule-2 bg-raise';

/** One object URL per shared file for the page's life, so scrolling back does not ask the hub again. */
const blobs = new Map<string, Promise<{ url: string; blob: Blob }>>();

function fileBlob(sessionId: string, card: FileCardData): Promise<{ url: string; blob: Blob }> {
  const key = `${sessionId}/${card.toolUseId}/${card.image ?? ''}`;
  let p = blobs.get(key);
  if (!p) {
    // typed from the card, so a blob URL never opens as anything but what the hub said it is
    p = api()
      .sessionFile(sessionId, card.toolUseId, false, card.image)
      .then((b) => {
        const blob = new Blob([b], { type: card.mediaType });
        return { url: URL.createObjectURL(blob), blob };
      });
    p.catch(() => blobs.delete(key));
    blobs.set(key, p);
  }
  return p;
}

/** An SVG as a data: URL: in an <img> it is inert, and opened on its own it is no origin's page (a blob: one would be the app's). */
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}

/** The card as the media viewer's item: the bytes come when it opens; an SVG as a data: URL, as inline. */
function mediaItem(sessionId: string, card: FileCardData, src?: string): MediaItem {
  const svg = card.mediaType === 'image/svg+xml';
  return {
    key: `${sessionId}/${card.toolUseId}/${card.image ?? ''}`,
    name: card.name,
    mediaType: card.mediaType,
    size: card.size,
    src,
    load: () => fileBlob(sessionId, card).then(async (r) => (svg ? { url: await dataUrl(r.blob), blob: r.blob } : r)),
  };
}

function usePreview(sessionId: string, card: FileCardData): { src?: string; svg?: string; error?: string } {
  const kind = previewOf(card);
  const [state, setState] = useState<{ src?: string; svg?: string; error?: string }>({});
  useEffect(() => {
    // a PDF, video or text file loads only when the viewer opens it
    if (!kind) return;
    let alive = true;
    fileBlob(sessionId, card)
      .then(async ({ url, blob }) => {
        if (kind === 'svg') {
          if (blob.size > SVG_PREVIEW_MAX) return; // the file grew since it was shared: a card only
          const svg = await dataUrl(blob);
          if (alive) setState({ svg });
        } else if (alive) setState({ src: url });
      })
      .catch((e: unknown) => alive && setState({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [sessionId, card.toolUseId, card.image, kind]);
  return state;
}

export function FileCard({ card, sessionId, className }: { card: FileCardData; sessionId: string; className?: string }) {
  const kind = previewOf(card);
  const { src, svg, error } = usePreview(sessionId, card);
  const alt = card.title ?? card.name;
  const [failed, setFailed] = useState<string>();
  const item = mediaItem(sessionId, card, kind === 'svg' ? svg : src);
  const viewable = mediaKind(card.mediaType, card.name) !== 'other';
  // phones: icon-only actions, so the name keeps the row's width
  const mobile = useIsMobile();
  const download = () =>
    fileBlob(sessionId, card)
      .then(({ url }) => {
        const a = document.createElement('a');
        a.href = url;
        a.download = card.name;
        a.click();
      })
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  return (
    <div className={cn(BOX, 'max-w-[560px] overflow-hidden', className)} data-file-card={card.mediaType}>
      {((kind === 'image' && src) || (kind === 'svg' && svg)) && (
        <MediaButton item={item} label={`Open ${alt} full size`} className="block w-full p-0">
          <img src={kind === 'svg' ? svg : src} alt={alt} className="block max-h-96 w-full bg-sunk object-contain" draggable={false} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
        </MediaButton>
      )}
      <div className="flex items-center gap-3 px-3.5 py-3 phone:px-4">
        <FileText className="size-5 shrink-0 text-fg-3" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="t-row truncate text-fg">{card.title ?? card.name}</div>
          <div className="truncate text-[12.5px] text-fg-3 phone:text-[13.5px]">{card.title ? `${card.name}, ` : ''}{fileFacts(card)}</div>
        </div>
        {viewable && (
          <MediaButton item={item} label={`View ${card.name}`} className={mobile ? 'inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg' : buttonClass('quiet', 'sm', 'cursor-pointer')}>
            <Maximize2 className={mobile ? 'size-[18px]' : 'size-4'} aria-hidden />
            {!mobile && 'View'}
          </MediaButton>
        )}
        {mobile ? (
          <IconButton label={`Download ${card.name}`} size="touch" tooltip={false} onClick={() => void download()}>
            <Download />
          </IconButton>
        ) : (
          <Button size="sm" variant="outline" icon={<Download className="size-4" />} onClick={() => void download()}>
            Download
          </Button>
        )}
      </div>
      {(failed ?? error) && <p className="px-3.5 pb-2.5 text-[12.5px] text-fault">Could not load the file. {failed ?? error}</p>}
    </div>
  );
}

function GridCell({ card, sessionId, one }: { card: FileCardData; sessionId: string; one: boolean }) {
  const { src, error } = usePreview(sessionId, card);
  const box = cn('w-full rounded-[var(--r-2)] border border-rule bg-sunk object-cover', one ? 'max-h-[420px] object-contain' : 'aspect-square');
  if (error) return <div className={cn(box, 'flex aspect-square items-center justify-center p-3 text-center text-[12.5px] text-fault')}>Could not load {card.name}</div>;
  if (!src) return <div className={cn(box, 'aspect-square animate-pulse')} aria-label={`Loading ${card.name}`} />;
  return (
    <MediaButton item={mediaItem(sessionId, card, src)} label={`Open ${(card.title ?? 'generated image').toLowerCase()} full size`} className="block rounded-[var(--r-2)] p-0">
      <img src={src} alt={card.title ?? 'Generated image'} className={box} loading="lazy" decoding="async" draggable={false} />
    </MediaButton>
  );
}

/** Pictures GenerateImage made, as a grid: one shows large, two to four in two columns. A tap opens one full screen with Download. */
export function ImageGrid({ cards, sessionId, className }: { cards: FileCardData[]; sessionId: string; className?: string }) {
  if (!cards.length) return null;
  const one = cards.length === 1;
  return (
    <div className={cn('grid gap-2', one ? 'max-w-[420px] grid-cols-1' : 'max-w-[560px] grid-cols-2', className)} data-image-grid={cards.length}>
      {cards.map((c) => (
        <GridCell key={`${c.toolUseId}/${c.image ?? ''}`} card={c} sessionId={sessionId} one={one} />
      ))}
    </div>
  );
}

/** The cards of a turn's ShareFile calls, in order: what sits under a phone's folded tool line. Generated pictures go in one grid instead. */
export function FileCards({ calls, sessionId, className }: { calls: Array<{ name: string; result?: ToolResultBlock }>; sessionId: string; className?: string }) {
  const made = generatedNames(calls);
  const pics = generatedCards(calls);
  const cards = shareCards(calls).filter((c) => !made.has(c.name));
  if (!cards.length && !pics.length) return null;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <ImageGrid cards={pics} sessionId={sessionId} />
      {cards.map((c) => (
        <FileCard key={c.toolUseId} card={c} sessionId={sessionId} />
      ))}
    </div>
  );
}

/** A ShareFile call on the Chat page: one quiet line, and its card unless a phone shows the cards under the fold. */
export function FileLine({ tool, result, sessionId, card = true }: { tool: ToolUseBlock; result?: ToolResultBlock; sessionId: string; card?: boolean }) {
  const mobile = useIsMobile();
  const c = fileCardOf(result);
  if (result?.isError)
    return (
      <div className="py-0.5">
        <div className="flex min-h-[25px] items-center text-[12.5px] text-fault phone:text-[13.5px]">Sharing a file failed</div>
        <p className="mb-1 max-w-[72ch] text-[13px] leading-[1.5] text-fg-2">{typeof result.content === 'string' ? result.content : ''}</p>
      </div>
    );
  return (
    <div className="py-0.5">
      <div className="flex min-h-[25px] items-center text-[12.5px] text-fg-3 phone:text-[13.5px]">Shared {c?.name ?? String(tool.input?.path ?? 'a file').split('/').pop()}</div>
      {card && !mobile && c && <FileCard card={c} sessionId={sessionId} className="mt-1 mb-1.5" />}
    </div>
  );
}
