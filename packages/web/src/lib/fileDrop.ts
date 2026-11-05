/**
 * Files dropped on the page, the same for every drop zone (composer, chat
 * column, meeting files).
 *
 * WebKit (the macOS and Linux desktop app, Safari) asks only dragenter when
 * the pointer moves onto a new element, and takes that answer for the drop
 * (WebCore EventHandler::updateDragAndDrop): a zone that accepts only
 * dragover loses the drop. So both accept the drag (acceptFileDrag).
 *
 * WebKitGTK hands the page a file manager's drop without the files, so on
 * Linux the desktop app's own handler takes the drop and sends the paths
 * (desktop main.rs page_drops). installDesktopDrop reads them through the
 * app and drops them as Files where the pointer was, so the zones see a
 * normal drop.
 */
import { mediaTypeFor } from '@conclave/core/attachments/limits';
import { desktop, type Desktop } from '@/overlay/desktop';
import { toast } from '@/store/store';

type Carrier = Pick<DataTransfer, 'types' | 'files' | 'items'> | null | undefined;

/** A drag that carries files: the Files type, or a file item (a WebKit drag may list only items). */
export function carriesFiles(dt: Carrier): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes('Files') || Array.from(dt.items ?? []).some((i) => i.kind === 'file');
}

/** The files of a drop: dataTransfer.files, or its file items when files is empty. */
export function droppedFiles(dt: Carrier): File[] {
  if (!dt) return [];
  if (dt.files?.length) return Array.from(dt.files);
  return Array.from(dt.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

/** For onDragEnter and onDragOver: accepts a drag with files. True when it did. */
export function acceptFileDrag(e: { dataTransfer: Carrier; preventDefault(): void }): boolean {
  if (!carriesFiles(e.dataTransfer)) return false;
  e.preventDefault();
  return true;
}

/** The dropped paths as Files, read through the app; a file it refuses (too big, a folder) is a toast. */
export async function readDropped(paths: string[], app: Desktop): Promise<File[]> {
  const out: File[] = [];
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() || 'file';
    try {
      const bytes = await app.invoke<ArrayBuffer>('read_dropped', { path });
      out.push(new File([bytes], name, { type: typeOf(name) }));
    } catch (e) {
      toast({ title: typeof e === 'string' ? e : `Could not read ${name}. Try attaching it again.`, level: 'error' });
    }
  }
  return out;
}

/** A path has no media type; pictures by extension (mediaTypeFor knows the rest), so they preview and go as images. */
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const typeOf = (name: string) => IMAGE_TYPES[/\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? ''] ?? mediaTypeFor('', name);

type DropPayload = { paths?: string[]; position?: { x: number; y: number } };

/** Desktop app only: a drop the app took (Linux) reaches the page as a drop event at the pointer. */
export async function installDesktopDrop(app: Desktop | undefined = desktop()): Promise<void> {
  if (!app) return;
  await app.listen<DropPayload>('tauri://drag-drop', (e) => {
    const { paths, position } = e.payload ?? {};
    if (!paths?.length) return;
    void readDropped(paths, app).then((files) => {
      if (!files.length) return;
      const dataTransfer = new DataTransfer();
      for (const f of files) dataTransfer.items.add(f);
      // WebKitGTK reports the point in CSS pixels; off the page, the body gets it
      const target = (position && document.elementFromPoint(position.x, position.y)) || document.body;
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
  });
}
