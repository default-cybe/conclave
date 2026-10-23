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

/** The preview a card shows: SVG and HTML never render (they could run). */
export function previewOf(mediaType: string): 'image' | 'pdf' | 'text' | undefined {
  if (mediaType === 'application/pdf') return 'pdf';
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType)) return 'image';
  if (['text/markdown', 'text/csv', 'text/plain'].includes(mediaType)) return 'text';
  return undefined;
}

/** Text previews read this much of the file. */
export const TEXT_PREVIEW_BYTES = 200_000;
