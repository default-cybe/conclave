/**
 * File cards in the chat: a file a ShareFile call handed the owner (core
 * files/share.ts). Name, type and size, a preview for images, PDFs and
 * plain text, and Download. The bytes come from
 * GET /api/sessions/:id/files/:toolUseId with the token, as a Blob, the way
 * a map card's picture does (MapsCard.tsx). SVG and HTML never render here.
 */
import { useEffect, useState } from 'react';
import { Download, ExternalLink, FileText } from 'lucide-react';
import type { ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { useIsMobile } from '@/lib/hooks';
import { fileCardOf, fileFacts, previewOf, shareCards, TEXT_PREVIEW_BYTES, type FileCardData } from './words';

const BOX = 'rounded-[var(--r-2)] border border-rule-2 bg-raise';

/** One object URL per shared file for the page's life, so scrolling back does not ask the hub again. */
const blobs = new Map<string, Promise<{ url: string; blob: Blob }>>();

function fileBlob(sessionId: string, card: FileCardData): Promise<{ url: string; blob: Blob }> {
  const key = `${sessionId}/${card.toolUseId}`;
  let p = blobs.get(key);
  if (!p) {
    // typed from the card, so a blob URL never opens as anything but what the hub said it is
    p = api()
      .sessionFile(sessionId, card.toolUseId)
      .then((b) => {
        const blob = new Blob([b], { type: card.mediaType });
        return { url: URL.createObjectURL(blob), blob };
      });
    p.catch(() => blobs.delete(key));
    blobs.set(key, p);
  }
  return p;
}

function usePreview(sessionId: string, card: FileCardData): { src?: string; text?: string; error?: string } {
  const kind = previewOf(card.mediaType);
  const [state, setState] = useState<{ src?: string; text?: string; error?: string }>({});
  useEffect(() => {
    if (!kind) return;
    let alive = true;
    fileBlob(sessionId, card)
      .then(async ({ url, blob }) => {
        const text = kind === 'text' ? await blob.slice(0, TEXT_PREVIEW_BYTES).text() : undefined;
        if (alive) setState({ src: url, text });
      })
      .catch((e: unknown) => alive && setState({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [sessionId, card.toolUseId, kind]);
  return state;
}

export function FileCard({ card, sessionId, className }: { card: FileCardData; sessionId: string; className?: string }) {
  const kind = previewOf(card.mediaType);
  const { src, text, error } = usePreview(sessionId, card);
  const [failed, setFailed] = useState<string>();
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
      {kind === 'image' && src && <img src={src} alt={card.title ?? card.name} className="block max-h-96 w-full bg-sunk object-contain" draggable={false} />}
      {kind === 'pdf' && src && <iframe src={src} sandbox="" title={card.name} className="block h-96 w-full border-0 bg-sunk" />}
      {kind === 'text' && text !== undefined && <pre className="m-0 max-h-72 overflow-auto bg-sunk px-3.5 py-2.5 text-[12px] leading-[1.5] text-fg-2 whitespace-pre-wrap">{text}</pre>}
      <div className="flex items-center gap-3 px-3.5 py-3 phone:px-4">
        <FileText className="size-5 shrink-0 text-fg-3" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="t-row truncate text-fg">{card.title ?? card.name}</div>
          <div className="truncate text-[12.5px] text-fg-3 phone:text-[13.5px]">{card.title ? `${card.name}, ` : ''}{fileFacts(card)}</div>
        </div>
        {(kind === 'pdf' || kind === 'image') && src && (
          <Button size="sm" variant="quiet" icon={<ExternalLink className="size-4" />} onClick={() => window.open(src, '_blank', 'noopener')}>
            Open
          </Button>
        )}
        <Button size="sm" variant="outline" icon={<Download className="size-4" />} onClick={() => void download()}>
          Download
        </Button>
      </div>
      {(failed ?? error) && <p className="px-3.5 pb-2.5 text-[12.5px] text-fault">Could not load the file. {failed ?? error}</p>}
    </div>
  );
}

/** The cards of a turn's ShareFile calls, in order: what sits under a phone's folded tool line. */
export function FileCards({ calls, sessionId, className }: { calls: Array<{ name: string; result?: ToolResultBlock }>; sessionId: string; className?: string }) {
  const cards = shareCards(calls);
  if (!cards.length) return null;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
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
