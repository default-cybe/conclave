/**
 * File cards in words (FileCard.tsx): the card a ShareFile result carries
 * (meta.file, core files/share.ts), its size and type line, and which
 * preview it gets. Pure, so the tests read it.
 */

export interface FileCardData {
  toolUseId: string;
  name: string;
  mediaType: string;
  size: number;
  title?: string;
}

/** The card a ShareFile result carries, when it is one the app can draw. */
export function fileCardOf(result: { toolUseId?: string; meta?: Record<string, unknown>; isError?: boolean } | undefined): FileCardData | undefined {
  const f = result && !result.isError ? (result.meta?.file as Partial<FileCardData> | undefined) : undefined;
  if (!f || typeof f !== 'object' || typeof f.name !== 'string' || typeof f.mediaType !== 'string' || typeof f.size !== 'number' || !result?.toolUseId) return undefined;
  return { toolUseId: result.toolUseId, name: f.name, mediaType: f.mediaType, size: f.size, ...(typeof f.title === 'string' && f.title ? { title: f.title } : {}) };
}

/** The cards of a turn's tool calls: only a ShareFile call's result is a file card (meta.file on any other tool's is not). */
export function shareCards(calls: Array<{ name: string; result?: Parameters<typeof fileCardOf>[0] }>): FileCardData[] {
  return calls.flatMap((c) => {
    const card = c.name === 'ShareFile' ? fileCardOf(c.result) : undefined;
    return card ? [card] : [];
  });
}

/** "512 B", "14.2 KB", "3.1 MB". */
export function sizeWords(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const KIND: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/gif': 'GIF image',
  'image/webp': 'WebP image',
  'image/svg+xml': 'SVG image',
  'application/zip': 'ZIP archive',
  'text/csv': 'CSV',
  'text/markdown': 'Markdown',
  'text/plain': 'Text',
  'application/json': 'JSON',
  'text/html': 'HTML',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint deck',
};

/** "PDF, 14.2 KB". */
export function fileFacts(c: Pick<FileCardData, 'mediaType' | 'size'>): string {
  return `${KIND[c.mediaType] ?? 'File'}, ${sizeWords(c.size)}`;
}

/** Largest raster image a card shows inline (the phone's FileCards.INLINE_MAX). */
export const IMAGE_PREVIEW_MAX = 20 * 1024 * 1024;
/** Largest SVG a card shows inline (the phone's FileCards.SVG_MAX). */
export const SVG_PREVIEW_MAX = 2 * 1024 * 1024;

/**
 * The preview a card shows. A PNG, JPEG, GIF or WebP is an image; an SVG is
 * its own kind, drawn only as an <img> (no scripts, no loads) and never opened
 * on its own. Anything else (text, code, JSON, CSV, PDF, HTML) is a card with
 * Download, never a dump in the chat. Too big a file is a card only.
 */
export function previewOf(c: Pick<FileCardData, 'mediaType' | 'size'>): 'image' | 'svg' | undefined {
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(c.mediaType)) return c.size <= IMAGE_PREVIEW_MAX ? 'image' : undefined;
  if (c.mediaType === 'image/svg+xml') return c.size <= SVG_PREVIEW_MAX ? 'svg' : undefined;
  return undefined;
}

/** Types Open shows in a new tab: the browser's own image or PDF viewer. Never SVG or HTML (they could run as the app's page). */
export function opensInTab(mediaType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'].includes(mediaType);
}
