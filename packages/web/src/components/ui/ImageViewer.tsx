/**
 * The media viewer: one full-screen layer for every picture, video, PDF and
 * text file the app shows (your attached pictures, file cards, generated
 * pictures, pictures from tools). A dark, blurred backdrop; a slim bar at the
 * top with the name, type and size, Download, Copy (pictures), Open in new
 * tab and Close. Escape and a click on the backdrop close it; Left and Right
 * (or a swipe) move between the media of the same conversation. A picture
 * zooms with the wheel or a pinch, a double-click toggles fit and 100%, and a
 * drag pans it when zoomed. Video and audio use the browser's own controls, a
 * PDF its built-in viewer, a text or code file the code highlighter.
 *
 * Every thumbnail is a MediaButton: it keeps its item on its element, so a
 * click gathers the items of the buttons in the same transcript (role=log, or a
 * [data-media-scope]) in page order, without any list kept by hand. Motion follows
 * the app's reduced-motion rule (index.css), focus stays inside while it is
 * open and goes back to the thumbnail after.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/text';
import { langFromPath } from '@/lib/highlight';
import { isDesktopApp } from '@/lib/notify';
import { toast } from '@/store/store';
import { kindWord, opensInTab, sizeWords } from '@/features/files/words';
import { CodeBlock } from './Code';
import { useEscape, useFocusTrap, useLockScroll } from './Overlay';

export interface MediaItem {
  /** Same media, same key: a picture shown twice on the page is one stop in the viewer. */
  key: string;
  name: string;
  mediaType: string;
  size?: number;
  /** A URL to show it from (data:, blob: or the hub's). */
  src?: string;
  /** Or the bytes, fetched when the viewer needs them (a file card's). */
  load?: () => Promise<{ url: string; blob: Blob }>;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other';

export function mediaKind(mediaType: string, name = ''): MediaKind {
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('video/')) return 'video';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType.startsWith('text/') || /^application\/([\w.-]+\+)?(json|xml|javascript|x-javascript|typescript|yaml|x-yaml|toml|x-sh|sql)$/.test(mediaType) || langFromPath(name)) return 'text';
  return 'other';
}

/** The most of a text file the viewer reads; past it the view says it is cut. */
const TEXT_MAX = 512 * 1024;
/** Past this the text shows plain: highlighting it would freeze the page. */
const HIGHLIGHT_MAX = 160 * 1024;
const ZOOM_MAX = 8;

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

const items = new WeakMap<Element, MediaItem>();

/** The media of the buttons in the same scope as `el`, in page order, each once, and where `item` is among them. */
export function galleryOf(el: Element, item: MediaItem): { list: MediaItem[]; at: number } {
  const scope = el.closest('[data-media-scope],[role="log"]') ?? el.ownerDocument.body;
  const list: MediaItem[] = [];
  const seen = new Set<string>();
  let at = -1;
  for (const e of scope.querySelectorAll('[data-media]')) {
    const it = items.get(e);
    if (!it || seen.has(it.key)) continue;
    seen.add(it.key);
    if (it.key === item.key) at = list.length;
    list.push(it);
  }
  return at < 0 ? { list: [item], at: 0 } : { list, at };
}

/** A thumbnail or a View button that opens `item` in the viewer, with the scope's other media a swipe away. */
export function MediaButton({ item, label, className, children }: { item: MediaItem; label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ list: MediaItem[]; at: number } | null>(null);
  useEffect(() => {
    if (ref.current) items.set(ref.current, item);
  });
  return (
    <>
      <button ref={ref} type="button" data-media="" aria-label={label} aria-haspopup="dialog" onClick={() => ref.current && setOpen(galleryOf(ref.current, item))} className={cn('tap cursor-zoom-in', className)}>
        {children}
      </button>
      {open && <MediaViewer items={open.list} start={open.at} onClose={() => setOpen(null)} />}
    </>
  );
}

/** A picture you attached (or any picture by URL), as a thumbnail that opens in the viewer. */
export function ImageThumb({ src, alt = 'Attached image', className, name = 'image' }: { src: string; alt?: string; className?: string; name?: string }) {
  const mediaType = /^data:([^;,]+)/.exec(src)?.[1] ?? 'image/png';
  return (
    <MediaButton item={{ key: src.length > 200 ? `${src.length}:${src.slice(-64)}` : src, name, mediaType, src }} label={`Open ${alt.toLowerCase()} full size`} className="block rounded-[var(--r-2)] p-0">
      <img src={src} alt={alt} className={className} loading="lazy" decoding="async" draggable={false} />
    </MediaButton>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function blobOf(item: MediaItem): Promise<Blob> {
  if (item.load) return (await item.load()).blob;
  if (!item.src) throw new Error('Nothing to save.');
  return (await fetch(item.src)).blob();
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function download(item: MediaItem) {
  // a plain anchor with download: the browser (and the desktop app's webview) saves it the way every other download in the app does
  const url = item.src ?? (await item.load!()).url;
  const a = document.createElement('a');
  a.href = url;
  a.download = item.name;
  a.click();
}

/** PNG bytes of a picture: the clipboard takes PNG everywhere. */
async function pngOf(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not read the picture.'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function copyImage(item: MediaItem) {
  const clip = navigator.clipboard;
  if (!clip?.write || typeof ClipboardItem === 'undefined') {
    toast({ title: 'This browser cannot copy pictures. Use Download.', level: 'error' });
    return;
  }
  // the promise goes into the item at once, inside the click, as Safari asks
  clip
    .write([new ClipboardItem({ 'image/png': blobOf(item).then(pngOf) })])
    .then(() => toast({ title: 'Copied the picture', level: 'success' }))
    .catch((e: unknown) => toast({ title: `Could not copy the picture. ${message(e)}`, level: 'error' }));
}

/** Types a new tab shows as themselves and never as a page of the app's origin (no SVG, no HTML). */
function tabSafe(mediaType: string): boolean {
  return opensInTab(mediaType) || /^(video|audio)\//.test(mediaType) || mediaType === 'text/plain';
}

async function openInTab(item: MediaItem) {
  // a blob typed as the card says, so it opens as nothing else; a data: URL would be blocked as a top frame
  const blob = await blobOf(item);
  const url = URL.createObjectURL(new Blob([blob], { type: item.mediaType }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

type Loaded = { url?: string; text?: string; cut?: boolean; error?: string };

function useLoaded(item: MediaItem, kind: MediaKind): Loaded {
  const direct = !!item.src && kind !== 'text';
  const [state, setState] = useState<Loaded>(direct ? { url: item.src } : {});
  useEffect(() => {
    setState(direct ? { url: item.src } : {});
    if (direct || kind === 'other') return;
    let alive = true;
    const p = item.load ? item.load() : blobOf(item).then((blob) => ({ url: item.src!, blob }));
    p.then(async ({ url, blob }) => {
      if (kind !== 'text') return alive && setState({ url });
      const text = await blob.slice(0, TEXT_MAX).text();
      if (alive) setState({ url, text, cut: blob.size > TEXT_MAX });
    }).catch((e: unknown) => alive && setState({ error: message(e) }));
    return () => {
      alive = false;
    };
  }, [item, kind, direct]);
  return state;
}

const BAR_BTN = 'inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-1)] text-white/75 transition-colors duration-[var(--dur-1)] hov:bg-white/10 hov:text-white focus-visible:outline-2 focus-visible:outline-white/70 phone:size-11 [&_svg]:size-[18px] [&_svg]:stroke-[1.75]';

function BarButton({ label, onClick, children, close }: { label: string; onClick: () => void; children: ReactNode; close?: boolean }) {
  return (
    <button type="button" title={label} onClick={onClick} className={BAR_BTN} data-close={close ? '' : undefined}>
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

const SIDE_BTN = 'absolute top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-[var(--r-2)] bg-black/45 text-white/80 transition-colors duration-[var(--dur-1)] hov:bg-black/70 hov:text-white disabled:opacity-0 focus-visible:outline-2 focus-visible:outline-white/70 phone:hidden [&_svg]:size-5';

export function MediaViewer({ items: list, start, onClose }: { items: MediaItem[]; start: number; onClose: () => void }) {
  const [at, setAt] = useState(start);
  const ref = useRef<HTMLDivElement>(null);
  const item = list[at] ?? list[0];
  const kind = mediaKind(item.mediaType, item.name);
  const loaded = useLoaded(item, kind);
  const n = list.length;
  const go = (d: number) => setAt((i) => Math.min(n - 1, Math.max(0, i + d)));
  useEscape(true, onClose);
  useFocusTrap(ref, true, { initial: ref });
  useLockScroll(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // a focused video, audio or text field keeps its own arrows
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('video,audio,input,textarea,iframe')) return;
      e.preventDefault();
      go(e.key === 'ArrowRight' ? 1 : -1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const facts = [kindWord(item.mediaType), item.size !== undefined ? sizeWords(item.size) : '', n > 1 ? `${at + 1} of ${n}` : ''].filter(Boolean).join(', ');
  const act = (f: () => Promise<void>) => () => void f().catch((e: unknown) => toast({ title: message(e), level: 'error' }));

  let body: ReactNode;
  if (loaded.error) body = <p className="text-[14px] text-white/75">Could not load {item.name}. {loaded.error}</p>;
  else if (kind === 'other') body = <p className="text-[14px] text-white/75">No preview for this type of file. Download it to open it.</p>;
  else if (!loaded.url && loaded.text === undefined) body = <p className="text-[14px] text-white/60">Loading</p>;
  else if (kind === 'image') body = <ZoomImage key={item.key} src={loaded.url!} alt={item.name} onSwipe={go} onBackdrop={onClose} />;
  else if (kind === 'video') body = <video key={item.key} src={loaded.url} controls playsInline aria-label={item.name} className="max-h-full max-w-full rounded-[var(--r-2)] bg-black" />;
  else if (kind === 'audio') body = <audio key={item.key} src={loaded.url} controls aria-label={item.name} className="w-[min(520px,100%)]" />;
  else if (kind === 'pdf') body = <iframe key={item.key} src={loaded.url} title={item.name} className="size-full max-w-[1100px] rounded-[var(--r-2)] border-0 bg-white" />;
  else
    body = (
      <div className="h-full w-full max-w-[1100px] overflow-auto rounded-[var(--r-2)]">
        <CodeBlock code={loaded.text ?? ''} lang={(loaded.text?.length ?? 0) <= HIGHLIGHT_MAX ? langFromPath(item.name) : undefined} title={item.name} wrap={!langFromPath(item.name)} className="min-h-full" />
        {loaded.cut && <p className="mt-2 text-[12.5px] text-white/60">Showing the first {sizeWords(TEXT_MAX)}. Download it for the rest.</p>}
      </div>
    );

  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-label={item.name} aria-describedby="media-viewer-facts" tabIndex={-1} data-media-viewer={kind} className="fixed inset-0 z-[80] flex flex-col outline-none">
      {/* the fade sits on each layer, not the root: an animated ancestor would keep the blur from seeing the page */}
      <div aria-hidden onClick={onClose} className="absolute inset-0 bg-black/92 backdrop-blur-xl anim-fade" />
      <div className="relative z-10 flex h-14 anim-fade shrink-0 items-center gap-1 border-b border-white/10 bg-black/40 pr-2 pl-4 text-white pt-safe phone:h-auto phone:min-h-14 phone:pr-1">
        <div className="min-w-0 flex-1 pr-2">
          <h2 className="truncate text-[14px] leading-5 font-medium text-white">{item.name}</h2>
          <p id="media-viewer-facts" className="truncate text-[12.5px] leading-4 text-white/60" aria-live="polite">
            {facts}
          </p>
        </div>
        {item.src ? (
          // a plain anchor: a data: or hub URL downloads where a router Link would navigate
          <a href={item.src} download={item.name} title="Download" className={BAR_BTN}>
            <Download aria-hidden />
            <span className="sr-only">Download</span>
          </a>
        ) : (
          <BarButton label="Download" onClick={act(() => download(item))}>
            <Download aria-hidden />
          </BarButton>
        )}
        {kind === 'image' && (
          <BarButton label="Copy picture" onClick={() => copyImage(item)}>
            <Copy aria-hidden />
          </BarButton>
        )}
        {/* the desktop app has no tabs and would hand the file to another app */}
        {tabSafe(item.mediaType) && !isDesktopApp() && (
          <BarButton label="Open in new tab" onClick={act(() => openInTab(item))}>
            <ExternalLink aria-hidden />
          </BarButton>
        )}
        <span aria-hidden className="mx-1 h-5 w-px bg-white/15" />
        <BarButton label="Close" onClick={onClose} close>
          <X aria-hidden />
        </BarButton>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-4 anim-fade phone:p-2"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {body}
        {n > 1 && (
          <>
            <button type="button" aria-label="Previous" title="Previous" disabled={at === 0} onClick={() => go(-1)} className={cn(SIDE_BTN, 'left-3')}>
              <ChevronLeft aria-hidden />
            </button>
            <button type="button" aria-label="Next" title="Next" disabled={at === n - 1} onClick={() => go(1)} className={cn(SIDE_BTN, 'right-3')}>
              <ChevronRight aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Zoom and pan
// ---------------------------------------------------------------------------

type View = { s: number; x: number; y: number };

/**
 * A picture fitted to the stage. The wheel or a pinch zooms around the
 * pointer, a double-click toggles fit and 100% (twice the fit for a picture
 * smaller than the stage), a drag pans when zoomed. At fit, a sideways swipe
 * moves to the next or previous item and a click beside the picture closes.
 */
function ZoomImage({ src, alt, onSwipe, onBackdrop }: { src: string; alt: string; onSwipe: (d: number) => void; onBackdrop: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [moving, setMoving] = useState(false);
  const cur = useRef(view);
  cur.current = view;
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; v: View; dist: number; moved: boolean } | null>(null);

  const zoomAt = (s: number, cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect();
    const px = cx - r.left - r.width / 2;
    const py = cy - r.top - r.height / 2;
    const o = cur.current;
    const n = Math.min(ZOOM_MAX, Math.max(1, s));
    setView(n === 1 ? { s: 1, x: 0, y: 0 } : { s: n, x: px - (px - o.x) * (n / o.s), y: py - (py - o.y) * (n / o.s) });
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // not passive, so the page under the layer does not zoom or scroll
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(cur.current.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const spread = () => {
    const [a, b] = [...pts.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  return (
    <div
      ref={box}
      className={cn('absolute inset-0 flex touch-none items-center justify-center overflow-hidden p-4 select-none phone:p-2', view.s > 1 ? (moving ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in')}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        box.current!.setPointerCapture?.(e.pointerId);
        pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const p = pts.current.size === 2 ? spread() : { dist: 0, x: e.clientX, y: e.clientY };
        gesture.current = { x: p.x, y: p.y, v: cur.current, dist: p.dist, moved: pts.current.size > 1 };
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (!g || !pts.current.has(e.pointerId)) return;
        pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.current.size === 2) {
          const p = spread();
          setMoving(true);
          zoomAt((g.v.s * p.dist) / (g.dist || 1), p.x, p.y);
          return;
        }
        const dx = e.clientX - g.x;
        const dy = e.clientY - g.y;
        if (Math.hypot(dx, dy) > 4) g.moved = true;
        if (g.v.s > 1 && g.moved) {
          setMoving(true);
          setView({ s: g.v.s, x: g.v.x + dx, y: g.v.y + dy });
        }
      }}
      onPointerUp={(e) => {
        const g = gesture.current;
        pts.current.delete(e.pointerId);
        if (pts.current.size) return;
        gesture.current = null;
        setMoving(false);
        if (!g) return;
        const dx = e.clientX - g.x;
        const dy = e.clientY - g.y;
        if (g.v.s === 1 && cur.current.s === 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1);
        // a plain click beside the picture closes, as on the rest of the backdrop
        else if (!g.moved && e.target === box.current && cur.current.s === 1) onBackdrop();
      }}
      onPointerCancel={(e) => {
        pts.current.delete(e.pointerId);
        gesture.current = null;
        setMoving(false);
      }}
      onDoubleClick={(e) => {
        if (cur.current.s > 1) return setView({ s: 1, x: 0, y: 0 });
        const el = img.current;
        const full = el && el.clientWidth ? el.naturalWidth / el.clientWidth : 1;
        zoomAt(full > 1.05 ? full : 2, e.clientX, e.clientY);
      }}
    >
      <img
        ref={img}
        src={src}
        alt={alt}
        draggable={false}
        decoding="async"
        className={cn('max-h-full max-w-full object-contain will-change-transform', !moving && 'transition-transform duration-[var(--dur-2)] ease-[var(--ease)]')}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
      />
    </div>
  );
}
