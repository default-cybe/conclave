/**
 * Files pasted into a message box, the same for every composer.
 *
 * Browsers put a pasted picture in clipboardData.files. WKWebView (the macOS
 * desktop app) often does not: a picture copied in Preview or Photos comes
 * only as an item, often as TIFF, and a screenshot or a file copied in Finder
 * comes with no file at all. So: files, else file items, else (desktop app,
 * and the paste is not plain text) the app reads the clipboard (desktop
 * main.rs paste_files). A copied file comes back as its path and is read
 * through read_dropped like a drop. TIFF (and any picture no model reads)
 * becomes PNG, which every model takes.
 *
 * Chromium on Windows lists a picture only when the clipboard has a DIB
 * (clipboard_win.cc), so a picture copied as "PNG" alone comes empty too: the
 * Windows app asks paste_files. A Chromium browser with a paste that came
 * without file or text reads navigator.clipboard once more (a file item
 * whose getAsFile gave nothing); it sees the same formats, so it cannot
 * rescue a "PNG"-only copy. A copied web picture that left only <img src> in
 * the HTML is not fetched: the page cannot read another site's picture, and
 * the hub has no safe fetch for it.
 */
import { desktop, type Desktop } from '@/overlay/desktop';
import { toast } from '@/store/store';
import { droppedFiles, readDropped } from './fileDrop';
import { isModelImage, SNIFF_BYTES, sniffImageType } from '@conclave/core/attachments/image';

type Clip = Pick<DataTransfer, 'types' | 'files' | 'items' | 'getData'>;

/** Worth asking the app: no plain text, or the paste names files (Finder adds the names as text). */
export function mayHoldFiles(dt: Clip): boolean {
  const types = Array.from(dt.types ?? []);
  return !types.includes('text/plain') || types.includes('Files') || types.includes('text/uri-list');
}

/** A file's picture type: by its first bytes (core attachments/image.ts), else the type it declares; undefined for no picture. */
export async function pictureType(f: File): Promise<string | undefined> {
  const head = await f.slice(0, SNIFF_BYTES).arrayBuffer().then((b) => new Uint8Array(b), () => new Uint8Array());
  return sniffImageType(head) ?? (f.type.startsWith('image/') ? f.type : undefined);
}

/**
 * A picture no model reads (TIFF from a Mac paste, BMP, HEIC, AVIF, SVG) as
 * PNG, drawn through a canvas; a JPEG, PNG, GIF or WebP, any other file, or a
 * picture the page cannot draw, as it was (the hub then refuses it by name).
 */
export async function asPng(f: File): Promise<File> {
  const type = await pictureType(f);
  if (!type || isModelImage(type)) return f;
  try {
    const bmp = await createImageBitmap(f);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d')?.drawImage(bmp, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return f;
    return new File([blob], f.name.replace(/\.[^./\\]+$/, '') + '.png', { type: 'image/png' });
  } catch {
    return f;
  }
}

/**
 * The desktop app, whose webview can hand over a picture paste with no file:
 * WKWebView and WebKitGTK for a screenshot, WebView2 for a picture copied
 * only as "PNG". Not Android, whose app has its own box.
 */
export const pasteApp = (ua = navigator.userAgent) => iosClipboard() ?? (/Mac OS X|Macintosh|Linux|Windows/.test(ua) && !/Android/.test(ua) ? desktop() : undefined);

type AppPaste = { paths?: string[]; image?: string | null; mime?: string | null };

/** What the app finds on the clipboard: copied files read through read_dropped, or the picture. */
export async function clipboardFiles(app: Desktop): Promise<File[]> {
  const got = await app.invoke<AppPaste>('paste_files').catch(() => undefined);
  if (got?.paths?.length) return readDropped(got.paths, app);
  if (!got?.image || !got.mime) return [];
  const bytes = Uint8Array.from(atob(got.image), (c) => c.charCodeAt(0));
  return [new File([bytes], `pasted.${got.mime.split('/')[1]}`, { type: got.mime })];
}

type Board = Pick<Clipboard, 'read'>;

/** The pictures on the clipboard, through the async Clipboard API (a browser); none when it refuses. */
export async function clipboardImages(board: Board): Promise<File[]> {
  try {
    const out: File[] = [];
    for (const item of await board.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) out.push(new File([await item.getType(type)], `pasted.${type.split('/')[1].split('+')[0]}`, { type }));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The iPhone and iPad app (packages/mobile): its Clipboard plugin reads a
 * picture, as the desktop app's paste_files does. WKWebView on iOS offers no
 * Paste in a <textarea> when the clipboard holds only a picture
 * (WKContentViewInteraction canPerformAction:paste: takes text and URLs
 * outside rich editing), so no paste event comes: Cmd+V (onPasteKey) and
 * Paste picture in the + menu ask the app instead.
 */
export function iosClipboard(w: unknown = globalThis): Desktop | undefined {
  const cap = (w as { Capacitor?: { isPluginAvailable?(n: string): boolean; nativePromise?<T>(p: string, m: string, o: object): Promise<T> } }).Capacitor;
  if (typeof cap?.nativePromise !== 'function' || !cap.isPluginAvailable?.('Clipboard')) return undefined;
  const read = cap.nativePromise.bind(cap);
  return {
    invoke: (async (cmd: string) => {
      if (cmd !== 'paste_files') throw new Error(`${cmd} is not in the iOS app`);
      const r = await read<{ type?: string; value?: string }>('Clipboard', 'read', {});
      return r.type?.startsWith('image/') && r.value ? { image: r.value.replace(/^data:[^,]*,/, ''), mime: r.type } : {};
    }) as Desktop['invoke'],
    listen: async () => () => undefined,
  };
}

/** The pictures the app finds on the clipboard, attached; false when there were none. */
export async function pasteFromApp(app: Desktop, add: (files: File[]) => void): Promise<boolean> {
  const files = await Promise.all((await clipboardFiles(app)).map(asPng));
  if (files.length) add(files);
  return files.length > 0;
}

/** Paste picture in a + menu, in the iOS app only. */
export function pastePictureItem(add: (files: File[]) => void, app = iosClipboard()) {
  return app ? [{ label: 'Paste picture', onSelect: () => void pasteFromApp(app, add).then((ok) => ok || toast({ title: 'There is no picture to paste. Copy one first.' })) }] : [];
}

/**
 * onKeyDown for a message box in the iOS app: Cmd+V with no paste event
 * after it (a picture alone on the clipboard) reads the picture through the
 * app. A paste that came (text) is left alone.
 */
export function onPasteKey(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; currentTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> },
  add: (files: File[]) => void,
  app: Desktop | undefined = iosClipboard(),
  wait = 120,
): void {
  if (!app || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'v') return;
  const box = e.currentTarget;
  let pasted = false;
  const saw = () => void (pasted = true);
  box.addEventListener('paste', saw);
  setTimeout(() => {
    box.removeEventListener('paste', saw);
    if (!pasted) void pasteFromApp(app, add);
  }, wait);
}

/**
 * onPaste for a message box: attaches what the paste carries and keeps text
 * pasting as text.
 */
export function onPasteFiles(
  e: { clipboardData: Clip; preventDefault(): void; currentTarget: EventTarget },
  add: (files: File[]) => void,
  app: Desktop | undefined = pasteApp(),
  // Chromium only: Firefox and Safari show their own Paste popup for read()
  board: Board | undefined = /Chrome\//.test(globalThis.navigator?.userAgent ?? '') ? globalThis.navigator?.clipboard : undefined,
): void {
  const dt = e.clipboardData;
  // the paste's own files: dataTransfer.files, or its file items
  const own = droppedFiles(dt);
  if (own.length) {
    e.preventDefault();
    void Promise.all(own.map(asPng)).then(add);
    return;
  }
  // a browser asks only when the paste has no text at all: Chromium hands over copied files itself
  const ask = app ? mayHoldFiles(dt) : typeof board?.read === 'function' && !Array.from(dt.types ?? []).includes('text/plain');
  if (!ask) return;
  const read = () => (app ? clipboardFiles(app) : clipboardImages(board!));
  // the text is read now: the event's clipboard is gone after the await
  const text = dt.getData('text/plain');
  const webPicture = /<img\b/i.test(dt.getData('text/html') ?? '');
  const box = e.currentTarget as HTMLTextAreaElement;
  e.preventDefault();
  void read()
    .then((files) => Promise.all(files.map(asPng)))
    .then((files) => {
      if (files.length) return add(files);
      // nothing to attach: paste the text after all, undoable like a normal paste
      if (text) {
        box.focus?.();
        document.execCommand('insertText', false, text);
      } else if (webPicture) {
        toast({ title: 'Could not read the copied picture. Save it, then attach it with +.', level: 'error' });
      }
    });
}
