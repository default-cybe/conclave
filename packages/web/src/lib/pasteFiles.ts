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
 */
import { desktop, type Desktop } from '@/overlay/desktop';
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

/** The macOS desktop app; elsewhere the paste event holds the picture and paste_files answers empty. */
const macApp = () => (/Mac OS X|Macintosh/.test(navigator.userAgent) ? desktop() : undefined);

type AppPaste = { paths?: string[]; image?: string | null; mime?: string | null };

/** What the app finds on the clipboard: copied files read through read_dropped, or the picture. */
export async function clipboardFiles(app: Desktop): Promise<File[]> {
  const got = await app.invoke<AppPaste>('paste_files').catch(() => undefined);
  if (got?.paths?.length) return readDropped(got.paths, app);
  if (!got?.image || !got.mime) return [];
  const bytes = Uint8Array.from(atob(got.image), (c) => c.charCodeAt(0));
  return [new File([bytes], got.mime === 'image/tiff' ? 'pasted.tiff' : 'pasted.png', { type: got.mime })];
}

/**
 * onPaste for a message box: attaches what the paste carries and keeps text
 * pasting as text.
 */
export function onPasteFiles(e: { clipboardData: Clip; preventDefault(): void; currentTarget: EventTarget }, add: (files: File[]) => void, app: Desktop | undefined = macApp()): void {
  const dt = e.clipboardData;
  // the paste's own files: dataTransfer.files, or its file items
  const own = droppedFiles(dt);
  if (own.length) {
    e.preventDefault();
    void Promise.all(own.map(asPng)).then(add);
    return;
  }
  if (!app || !mayHoldFiles(dt)) return;
  // the text is read now: the event's clipboard is gone after the await
  const text = dt.getData('text/plain');
  const box = e.currentTarget as HTMLTextAreaElement;
  e.preventDefault();
  void clipboardFiles(app)
    .then((files) => Promise.all(files.map(asPng)))
    .then((files) => {
      if (files.length) return add(files);
      // nothing to attach: paste the text after all, undoable like a normal paste
      if (text) {
        box.focus?.();
        document.execCommand('insertText', false, text);
      }
    });
}
