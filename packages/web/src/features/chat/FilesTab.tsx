/**
 * The Files tab of the session panel (ContextPanel.tsx): every file of the
 * conversation, newest first, as Generated (shared files, generated pictures,
 * pages in replies), Screenshots (pictures from tools) and Uploaded (what you
 * attached). Pictures and videos are a grid of thumbnails, the rest compact
 * rows. A tap opens the media viewer, whose Left and Right move through this
 * list; a file it cannot show downloads.
 *
 * The list comes from the loaded transcript (core session/files.ts). A big
 * chat loads in pages, so when older messages are not loaded the hub's list
 * (GET /api/sessions/:id/files) is used, and each file's bytes are fetched
 * only when its thumbnail scrolls into view or it opens.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, Session } from '@conclave/core/types';
import { filesOf, newestFirst, pagesIn, type FileGroup, type SessionFile } from '@conclave/core/session/files';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { dayTime } from '@/lib/format';
import { useHub } from '@/store/store';
import { toast } from '@/store/store';
import { Segmented } from '@/components/ui/Field';
import { MediaButton, mediaKind, type MediaItem } from '@/components/ui/ImageViewer';
import { saveFile } from '@/lib/saveFile';
import { DownloadIcon, FileIcon, fileBlob } from '@/features/files/FileCard';
import { sizeWords } from '@/features/files/words';
import { revealToolRow } from './ToolRows';

export const GROUPS: Array<{ id: FileGroup; label: string }> = [
  { id: 'generated', label: 'Generated' },
  { id: 'screenshot', label: 'Screenshots' },
  { id: 'uploaded', label: 'Uploaded' },
];

/** The files of the loaded transcript; the hub's list instead when older messages are not loaded. */
export function useSessionFiles(sessionId: string): SessionFile[] {
  const messages = useHub((s) => s.messages[sessionId]);
  const older = useHub((s) => !!s.messagesOlder[sessionId]);
  const local = useMemo(() => newestFirst(filesOf(messages ?? [])), [messages]);
  // asked again only when the loaded list grows: a new file, not every streamed word
  const hub = useLoad(() => (older ? api().sessionFiles(sessionId) : Promise.resolve(undefined)), [sessionId, older, local.length]);
  return useMemo(() => mergeFiles(local, older ? hub.data : undefined), [local, older, hub.data]);
}

/** The hub's list with what the app has that the hub has not yet saved, newest first. */
export function mergeFiles(local: SessionFile[], hub: SessionFile[] | undefined): SessionFile[] {
  if (!hub) return local;
  const keys = new Set(hub.map((f) => f.key));
  return [...hub, ...local.filter((f) => !keys.has(f.key))].sort((a, b) => b.at - a.at);
}

function b64Blob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** The block a file is in: from the loaded message when it is whole, else from the hub. */
async function blockOf(sessionId: string, f: SessionFile, messages: readonly Message[] | undefined) {
  const m = messages?.find((x) => x.id === f.messageId);
  const cut = (m?.meta?.trimmed as Array<{ index: number }> | undefined)?.some((t) => t.index === f.index);
  return m && !cut ? m.content[f.index] : api().messageBlock(sessionId, f.messageId, f.index);
}

/** Opens the call's row in the transcript; false when it is not loaded on screen. */
export function revealInTranscript(toolUseId: string | undefined): boolean {
  if (!toolUseId) return false;
  const row = revealToolRow(toolUseId);
  if (!row) return false;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
  row.style.transition = 'background-color 240ms var(--ease)';
  row.style.backgroundColor = 'var(--bg-hover)';
  setTimeout(() => (row.style.backgroundColor = ''), 1400);
  return true;
}

/** A file as the viewer's item: a URL when the app holds the bytes, else a load from the hub. */
export function fileItem(sessionId: string, f: SessionFile, messages: readonly Message[] | undefined): MediaItem {
  const call = f.call ?? f.toolUseId;
  const jump = call ? () => void (revealInTranscript(call) || toast({ title: 'That message is not loaded. Scroll up in the chat to load it.' })) : undefined;
  const base = { key: f.key, name: f.name, mediaType: f.mediaType, size: f.size, ...(jump ? { jump } : {}) };
  if (f.toolUseId) return { ...base, load: () => fileBlob(sessionId, { toolUseId: f.toolUseId!, name: f.name, mediaType: f.mediaType, size: f.size ?? 0, ...(f.image !== undefined ? { image: f.image } : {}) }) };
  if (f.url) return { ...base, src: f.url };
  // the loaded message's bytes, when it has them, show at once
  const held = messages?.find((x) => x.id === f.messageId)?.content[f.index];
  const part = held?.type === 'tool_result' && Array.isArray(held.content) && f.part !== undefined ? held.content[f.part] : held;
  if (f.page === undefined && part && (part.type === 'image' || part.type === 'document') && part.data) return { ...base, src: `data:${part.mediaType};base64,${part.data}` };
  const id = `${sessionId}/${f.key}`;
  return {
    ...base,
    load: () => {
      let p = loads.get(id);
      if (!p) {
        p = fetchBytes(sessionId, f, messages);
        p.catch(() => loads.delete(id));
        loads.set(id, p);
      }
      return p;
    },
  };
}

/** One fetch per file for the page's life, as FileCard.tsx fileBlob: a thumbnail and the viewer share it. */
const loads = new Map<string, Promise<{ url: string; blob: Blob }>>();

async function fetchBytes(sessionId: string, f: SessionFile, messages: readonly Message[] | undefined): Promise<{ url: string; blob: Blob }> {
  const b = await blockOf(sessionId, f, messages);
  let blob: Blob | undefined;
  if (f.page !== undefined && b?.type === 'text') {
    const page = pagesIn(b.text)[f.page];
    if (page) blob = new Blob([page.code], { type: f.mediaType });
  } else {
    const p = b?.type === 'tool_result' && Array.isArray(b.content) && f.part !== undefined ? b.content[f.part] : b;
    if (p && (p.type === 'image' || p.type === 'document') && p.data) blob = b64Blob(p.data, f.mediaType);
  }
  if (!blob) throw new Error(`${f.name} is no longer in the chat.`);
  return { url: URL.createObjectURL(blob), blob };
}

async function download(item: MediaItem) {
  try {
    await saveFile(item.name, item.src ?? (await item.load!()).blob);
  } catch (e) {
    toast({ title: `Could not download ${item.name}. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
  }
}

const isMedia = (f: SessionFile) => /^(image|video)\//.test(f.mediaType);

/** A thumbnail that fetches its bytes only once it scrolls into view. */
function Thumb({ item, video }: { item: MediaItem; video: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [loaded, setSrc] = useState<string>();
  const src = item.src ?? loaded;
  const [failed, setFailed] = useState(false);
  // per file, not per render: the item is made again as the transcript streams
  useEffect(() => {
    if (item.src || !item.load || typeof IntersectionObserver === 'undefined') return;
    let live = true;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      item.load!().then(
        (r) => live && setSrc(r.url),
        () => live && setFailed(true),
      );
    }, { rootMargin: '200px' });
    if (ref.current) io.observe(ref.current);
    return () => {
      live = false;
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key]);
  return (
    <span ref={ref} className="block aspect-square w-full overflow-hidden bg-sunk">
      {src && !video && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-cover" />}
      {src && video && <video src={src} muted preload="metadata" className="size-full object-cover" />}
      {!src && <span className="flex size-full items-center justify-center">{failed ? <span className="px-2 text-center text-[11.5px] text-fg-3">Not loaded</span> : <FileIcon mediaType={item.mediaType} name={item.name} className="text-fg-4" />}</span>}
    </span>
  );
}

function Section({ files, sessionId, messages, title }: { files: SessionFile[]; sessionId: string; messages: readonly Message[] | undefined; title?: string }) {
  const media = files.filter(isMedia);
  const rest = files.filter((f) => !isMedia(f));
  const item = (f: SessionFile) => fileItem(sessionId, f, messages);
  return (
    <section className="mb-4" data-files-group={title ?? ''}>
      {title && <h4 className="m-0 mb-2 px-1 text-[12px] font-normal text-fg-3 phone:text-[13px]">{title}</h4>}
      {media.length > 0 && (
        <ul className="m-0 grid list-none grid-cols-3 gap-1.5 p-0">
          {media.map((f) => {
            const it = item(f);
            return (
              <li key={f.key} className="group/card relative overflow-hidden rounded-[var(--r-1)] shadow-[0_0_0_1px_var(--rule)]">
                <MediaButton item={it} label={`Open ${f.name}`} className="block w-full p-0">
                  <Thumb item={it} video={f.mediaType.startsWith('video/')} />
                </MediaButton>
                <DownloadIcon name={f.name} onClick={() => void download(it)} over small />
              </li>
            );
          })}
        </ul>
      )}
      {rest.length > 0 && (
        <ul className={cn('m-0 list-none p-0', media.length > 0 && 'mt-2')}>
          {rest.map((f) => {
            const it = item(f);
            const words = (
              <>
                <FileIcon mediaType={f.mediaType} name={f.name} className="size-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg phone:text-[14px]">{f.name}</span>
                  <span className="block truncate text-[12px] text-fg-3">{[f.size !== undefined ? sizeWords(f.size) : '', dayTime(f.at)].filter(Boolean).join(', ')}</span>
                </span>
              </>
            );
            const row = '-mx-1 flex min-h-11 w-[calc(100%+8px)] items-center gap-2.5 rounded-[var(--r-1)] px-1 py-1.5 text-left transition-colors duration-[var(--dur-1)] hov:bg-hover';
            return (
              <li key={f.key} className="group/card flex items-center">
                {mediaKind(f.mediaType, f.name) !== 'other' ? (
                  <MediaButton item={it} label={`Open ${f.name}`} className={cn(row, 'cursor-pointer')}>
                    {words}
                  </MediaButton>
                ) : (
                  <button type="button" aria-label={`Download ${f.name}`} onClick={() => void download(it)} className={row}>
                    {words}
                  </button>
                )}
                <DownloadIcon name={f.name} onClick={() => void download(it)} className="ml-1 size-7 opacity-0 group-hover/card:opacity-100 coarse:opacity-100" />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function FilesTab({ session }: { session: Session }) {
  const files = useSessionFiles(session.id);
  const messages = useHub((s) => s.messages[session.id]);
  const [group, setGroup] = useState<FileGroup | 'all'>('all');
  const count = (g: FileGroup) => files.filter((f) => f.group === g).length;
  const shown = group === 'all' ? files : files.filter((f) => f.group === group);
  return (
    <div data-media-scope="" data-files-tab="">
      <Segmented
        label="Show"
        size="sm"
        full
        value={group}
        onChange={setGroup}
        className="mb-3"
        options={[{ value: 'all', label: 'All' }, ...GROUPS.map((g) => ({ value: g.id, label: g.label, disabled: !count(g.id) }))]}
      />
      {files.length === 0 && <p className="m-0 px-1 py-1 text-[13px] leading-[1.45] text-fg-3">Files shared in this chat, pictures from tools and what you attach show up here.</p>}
      {group === 'all'
        ? GROUPS.map((g) => {
            const list = files.filter((f) => f.group === g.id);
            return list.length ? <Section key={g.id} title={g.label} files={list} sessionId={session.id} messages={messages} /> : null;
          })
        : <Section files={shown} sessionId={session.id} messages={messages} />}
    </div>
  );
}
