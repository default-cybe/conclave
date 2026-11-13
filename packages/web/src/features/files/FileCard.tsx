/**
 * File cards in the chat: a file a ShareFile call handed the owner (core
 * files/share.ts). Name, type and size, an inline picture for a PNG, JPEG,
 * GIF or SVG (a generated chart or graph), and Download. The bytes come from
 * GET /api/sessions/:id/files/:toolUseId with the token, as a Blob, the way
 * a map card's picture does (MapsCard.tsx). Text, code, PDF and the rest stay
 * a card. An SVG only ever draws as an <img> (the browser runs no script and
 * loads nothing in one), from a data: URL so even "open image in new tab" is an
 * opaque origin, never the app's; it has no Open. HTML never renders here.
 * A tap opens it, as on Android: the picture itself, or the whole card of a
 * PDF, video, text or code file, opens the media viewer
 * (components/ui/ImageViewer.tsx); HTML shows as code there. A card the viewer
 * cannot show downloads on a tap. One small download icon sits in the corner
 * (on a picture: on hover, always on touch); in the desktop app it saves
 * through the app (lib/saveFile.ts).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Download, File, FileArchive, FileCode, FileImage, FileText, FileVideo, Music } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { saveFile } from '@/lib/saveFile';
import { toast } from '@/store/store';
import { MediaButton, mediaKind, type MediaItem } from '@/components/ui/ImageViewer';
import { fileCardOf, fileFacts, generatedCards, generatedNames, previewOf, shareCards, SVG_PREVIEW_MAX, type FileCardData } from './words';

const BOX = 'rounded-[var(--r-2)] border border-rule-2 bg-raise';

/** One object URL per shared file for the page's life, so scrolling back does not ask the hub again. */
const blobs = new Map<string, Promise<{ url: string; blob: Blob }>>();

export function fileBlob(sessionId: string, card: FileCardData): Promise<{ url: string; blob: Blob }> {
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
export function mediaItem(sessionId: string, card: FileCardData, src?: string): MediaItem {
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

/** An icon for the kind of file: picture, video, sound, archive, code, text or a plain file. */
export function FileIcon({ mediaType, name, className }: { mediaType: string; name: string; className?: string }) {
  const kind = mediaKind(mediaType, name);
  const Icon = kind === 'image' ? FileImage : kind === 'video' ? FileVideo : kind === 'audio' ? Music : /zip|tar|gzip|7z|rar/.test(mediaType) ? FileArchive : kind === 'text' && !/^text\/(plain|markdown|csv)/.test(mediaType) ? FileCode : kind === 'pdf' || kind === 'text' ? FileText : File;
  return <Icon className={cn('size-5 shrink-0 text-fg-3', className)} strokeWidth={1.75} aria-hidden />;
}

/**
 * The one small download icon of a card. `over`: it sits on a picture, shown
 * on hover or focus and always on touch, light on a dark disc so it reads on
 * any picture.
 */
export function DownloadIcon({ name, onClick, over, small, className }: { name: string; onClick: () => void; over?: boolean; small?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`Download ${name}`}
      title="Download"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center transition-[opacity,color,background-color] duration-[var(--dur-1)] focus-visible:opacity-100 [&_svg]:size-4 [&_svg]:stroke-[1.75]',
        over
          ? cn('absolute rounded-full bg-black/55 text-white/90 opacity-0 group-hover/card:opacity-100 hov:bg-black/75 hov:text-white coarse:opacity-100', small ? 'top-1 right-1 size-6 [&_svg]:!size-3.5' : 'top-2 right-2 size-8 phone:size-9')
          : 'size-8 rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg phone:size-10',
        className,
      )}
    >
      <Download aria-hidden />
    </button>
  );
}

/** Saves a card's file: the browser's download, or the desktop app's (lib/saveFile.ts). */
export function downloadCard(sessionId: string, card: FileCardData): Promise<void> {
  return fileBlob(sessionId, card)
    .then(({ blob }) => saveFile(card.name, blob))
    .catch((e: unknown) => void toast({ title: `Could not download ${card.name}. ${e instanceof Error ? e.message : String(e)}`, level: 'error' }));
}

const ROW = 'flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left phone:px-4';

export function FileCard({ card, sessionId, className }: { card: FileCardData; sessionId: string; className?: string }) {
  const kind = previewOf(card);
  const { src, svg, error } = usePreview(sessionId, card);
  const alt = card.title ?? card.name;
  const item = mediaItem(sessionId, card, kind === 'svg' ? svg : src);
  const viewable = mediaKind(card.mediaType, card.name) !== 'other';
  const mobile = useIsMobile();
  const download = () => void downloadCard(sessionId, card);
  const words = (
    <span className="min-w-0 flex-1">
      <span className="t-row block truncate text-fg">{alt}</span>
      <span className="block truncate text-[12.5px] text-fg-3 phone:text-[13.5px]">
        {card.title ? `${card.name}, ` : ''}
        {fileFacts(card)}
      </span>
      {error && kind && <span className="block truncate text-[12.5px] text-fault">Could not load the preview. {error}</span>}
    </span>
  );
  const picture = (kind === 'image' && src) || (kind === 'svg' && svg);
  if (picture)
    return (
      <div className={cn(BOX, 'group/card relative max-w-[420px] overflow-hidden', className)} data-file-card={card.mediaType}>
        <MediaButton item={item} label={`Open ${alt}`} className="block w-full p-0 text-left">
          <img src={picture} alt={alt} className="block max-h-96 w-full bg-sunk object-contain" draggable={false} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
          <span className="flex items-baseline gap-2 px-3 py-2 text-[12.5px] phone:text-[13.5px]">
            <span className="min-w-0 truncate text-fg-2">{alt}</span>
            <span className="ml-auto shrink-0 text-fg-3">{fileFacts(card)}</span>
          </span>
        </MediaButton>
        <DownloadIcon name={card.name} onClick={download} over />
      </div>
    );
  // a picture still loading or too big shows as a row too: the row opens it
  const row: ReactNode = (
    <>
      <FileIcon mediaType={card.mediaType} name={card.name} />
      {words}
    </>
  );
  return (
    <div className={cn(BOX, 'group/card flex max-w-[480px] items-center overflow-hidden pr-1.5 transition-colors duration-[var(--dur-1)] hov:bg-hover', className)} data-file-card={card.mediaType}>
      {viewable ? (
        <MediaButton item={item} label={`Open ${card.name}`} className={cn(ROW, 'cursor-pointer')}>
          {row}
        </MediaButton>
      ) : (
        // no preview for it: the whole card is the download, the icon only says so
        <button type="button" aria-label={`Download ${card.name}`} onClick={download} className={ROW}>
          {row}
          <Download aria-hidden strokeWidth={1.75} className="mr-1 size-4 shrink-0 text-fg-3 group-hover/card:text-fg" />
        </button>
      )}
      {viewable && <DownloadIcon name={card.name} onClick={download} className={mobile ? undefined : 'opacity-70 group-hover/card:opacity-100'} />}
    </div>
  );
}

function GridCell({ card, sessionId, one }: { card: FileCardData; sessionId: string; one: boolean }) {
  const { src, error } = usePreview(sessionId, card);
  const box = cn('w-full rounded-[var(--r-2)] border border-rule bg-sunk object-cover', one ? 'max-h-[420px] object-contain' : 'aspect-square');
  if (error) return <div className={cn(box, 'flex aspect-square items-center justify-center p-3 text-center text-[12.5px] text-fault')}>Could not load {card.name}</div>;
  if (!src) return <div className={cn(box, 'aspect-square animate-pulse')} aria-label={`Loading ${card.name}`} />;
  return (
    <div className="group/card relative">
      <MediaButton item={mediaItem(sessionId, card, src)} label={`Open ${(card.title ?? 'generated image').toLowerCase()} full size`} className="block w-full rounded-[var(--r-2)] p-0">
        <img src={src} alt={card.title ?? 'Generated image'} className={box} loading="lazy" decoding="async" draggable={false} />
      </MediaButton>
      <DownloadIcon name={card.name} onClick={() => void downloadCard(sessionId, card)} over />
    </div>
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
