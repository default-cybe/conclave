/**
 * Files pasted into a message box, the same for every composer.
 *
 * Browsers put a pasted picture in clipboardData.files. WKWebView (the macOS
 * desktop app) often does not: a picture copied in Preview or Photos comes
 * only as an item, often as TIFF, and a screenshot or a file copied in Finder
 * comes with no file at all. So: files, else file items, else (desktop app,
 * and the paste is not plain text) the app reads the clipboard (desktop
 * main.rs paste_files). A copied file comes back as its path and is read
 * through read_dropped like a drop. TIFF becomes PNG, which every model takes.
 */
import { desktop, type Desktop } from '@/overlay/desktop';
import { droppedFiles, readDropped } from './fileDrop';

type Clip = Pick<DataTransfer, 'types' | 'files' | 'items' | 'getData'>;

/** Worth asking the app: no plain text, or the paste names files (Finder adds the names as text). */
export function mayHoldFiles(dt: Clip): boolean {
  const types = Array.from(dt.types ?? []);
  return !types.includes('text/plain') || types.includes('Files') || types.includes('text/uri-list');
}

/** A TIFF as PNG, drawn through a canvas; anything else, or a TIFF the page cannot draw, as it was. */
export async function asPng(f: File): Promise<File> {
  if (f.type !== 'image/tiff') return f;
  try {
    const bmp = await createImageBitmap(f);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d')?.drawImage(bmp, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return f;
    return new File([blob], f.name.replace(/\.tiff?$/i, '') + '.png', { type: 'image/png' });
  } catch {
    return f;
  }
}

/**
 * The desktop app on macOS or Linux, whose webviews (WKWebView, WebKitGTK)
 * can hand over a screenshot paste with no file. Windows' WebView2 puts the
 * picture in the paste event, so it is not asked.
 */
export const pasteApp = (ua = navigator.userAgent) => (/Mac OS X|Macintosh|Linux/.test(ua) && !/Android/.test(ua) ? desktop() : undefined);

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
export function onPasteFiles(e: { clipboardData: Clip; preventDefault(): void; currentTarget: EventTarget }, add: (files: File[]) => void, app: Desktop | undefined = pasteApp()): void {
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
