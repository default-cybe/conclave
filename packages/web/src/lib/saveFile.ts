/**
 * Saving and opening a file the app holds (a shared file, a picture, an
 * export), for every Download button.
 *
 * A browser saves it from a plain <a download>. The desktop app cannot:
 * WebKitGTK (Linux) drops an <a download> of a blob: or data: URL, and the
 * app denies window.open of anything but http, https and mailto (desktop
 * main.rs new_window). So in the desktop app, on every OS, the bytes go to
 * the app (desktop download.rs save_download), which writes them to
 * Downloads under a name that replaces nothing, and a toast says where with
 * Show in folder. Open in app works the same way (open_download), for
 * pictures, video, PDF and text only.
 */
import { desktop } from '@/overlay/desktop';
import { toast } from '@/store/store';

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  // in slices: one String.fromCharCode of a big file overflows the stack
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** "~/Downloads/x.png" for a path in the home folder, else the path. */
export function homePath(path: string): string {
  return path.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\])/, '~');
}

/** Saves `file` as `name`: the browser's download, or the desktop app writes it to Downloads. */
export async function saveFile(name: string, file: Blob | string): Promise<void> {
  const app = desktop();
  if (!app) {
    const url = typeof file === 'string' ? file : URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    // in the page, as Firefox asks
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (typeof file !== 'string') setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  let path: string;
  try {
    const blob = typeof file === 'string' ? await (await fetch(file)).blob() : file;
    path = await app.invoke<string>('save_download', { name, data: await base64(blob) });
  } catch (e) {
    // the app answers with a sentence (download.rs), the page with an Error
    toast({ title: `Could not save ${name}. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
    return;
  }
  toast({ title: `Saved to ${homePath(path)}`, level: 'success', action: { label: 'Show in folder', run: () => void app.invoke('reveal_download', { path }).catch((e: unknown) => toast({ title: String(e), level: 'error' })) } });
}

/** Desktop app only: opens `blob` in its default app (pictures, video, PDF, text). False outside the app. */
export async function openInApp(name: string, blob: Blob): Promise<boolean> {
  const app = desktop();
  if (!app) return false;
  await app.invoke('open_download', { name, data: await base64(blob) });
  return true;
}
