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
 *
 * The iPhone and iPad app (packages/mobile, a WKWebView) has no downloads:
 * Capacitor hands an <a download> of a blob: URL to the system, which drops
 * it. There the bytes go to the app's cache (Capacitor Filesystem) and the
 * iOS share sheet opens on them (Capacitor Share): Save to Files, Save Image,
 * AirDrop or another app.
 */
import { desktop } from '@/overlay/desktop';
import { toast } from '@/store/store';

/**
 * The most the page hands the app in one call (desktop download.rs MAX_BYTES):
 * the bytes go over IPC as base64, a third bigger, and the webview holds both.
 */
export const APP_SAVE_MAX = 100 * 1024 * 1024;

/**
 * A file over APP_SAVE_MAX: the hub serves files only with the token in a
 * header, never in a URL, so there is no link to hand the system browser.
 * Instead the toast opens this chat in the browser (the app sends http links
 * there, main.rs new_window), where a normal download works.
 */
function tooBig(name: string) {
  toast({
    title: `${name} is too big to save from the app (over ${APP_SAVE_MAX / 1024 / 1024} MB). Download it from Conclave in your web browser.`,
    level: 'error',
    action: { label: 'Open in browser', run: () => void window.open(location.href, '_blank') },
  });
}

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

/** The native side of the iOS app (Capacitor's bridge, packages/mobile), when it has the Share plugin. */
export interface ShareApp {
  isPluginAvailable(name: string): boolean;
  nativePromise<T>(plugin: string, method: string, options: Record<string, unknown>): Promise<T>;
}

export function shareApp(w: unknown = globalThis): ShareApp | undefined {
  const cap = (w as { Capacitor?: Partial<ShareApp> }).Capacitor;
  return typeof cap?.nativePromise === 'function' && cap.isPluginAvailable?.('Share') && cap.isPluginAvailable('Filesystem') ? (cap as ShareApp) : undefined;
}

/** A name the cache folder takes as one file: no folders, no leading dots. */
export function shareName(name: string): string {
  return name.replace(/[/\\:\0]/g, '_').replace(/^\.+/, '') || 'file';
}

/** The iOS app: writes `blob` to the app's cache and opens the share sheet on it. Closing the sheet is no error. */
export async function shareFile(app: ShareApp, name: string, blob: Blob): Promise<void> {
  if (blob.size > APP_SAVE_MAX) {
    toast({ title: `${name} is too big to save from the app (over ${APP_SAVE_MAX / 1024 / 1024} MB). Download it from Conclave in Safari.`, level: 'error' });
    return;
  }
  try {
    const { uri } = await app.nativePromise<{ uri: string }>('Filesystem', 'writeFile', { path: `shared/${shareName(name)}`, data: await base64(blob), directory: 'CACHE', recursive: true });
    await app.nativePromise('Share', 'share', { title: name, files: [uri] });
  } catch (e) {
    const text = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e);
    if (/cancel/i.test(text)) return;
    toast({ title: `Could not save ${name}. ${text}`, level: 'error' });
  }
}

/** Saves `file` as `name`: the browser's download, the desktop app writes it to Downloads, the iOS app opens the share sheet. */
export async function saveFile(name: string, file: Blob | string): Promise<void> {
  const ios = shareApp();
  if (ios) {
    let blob: Blob;
    try {
      blob = typeof file === 'string' ? await (await fetch(file)).blob() : file;
    } catch (e) {
      toast({ title: `Could not save ${name}. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
      return;
    }
    return shareFile(ios, name, blob);
  }
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
    if (blob.size > APP_SAVE_MAX) return tooBig(name);
    path = await app.invoke<string>('save_download', { name, data: await base64(blob) });
  } catch (e) {
    // the app answers with a sentence (download.rs), the page with an Error
    toast({ title: `Could not save ${name}. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
    return;
  }
  toast({ title: `Saved to ${homePath(path)}`, level: 'success', action: { label: 'Show in folder', run: () => void app.invoke('reveal_download', { path }).catch((e: unknown) => toast({ title: String(e), level: 'error' })) } });
}

/** Desktop app: opens `blob` in its default app (pictures, video, PDF, text); the iOS app: the share sheet. False in a browser. */
export async function openInApp(name: string, blob: Blob): Promise<boolean> {
  const ios = shareApp();
  if (ios) {
    await shareFile(ios, name, blob);
    return true;
  }
  const app = desktop();
  if (!app) return false;
  if (blob.size > APP_SAVE_MAX) {
    tooBig(name);
    return true;
  }
  await app.invoke('open_download', { name, data: await base64(blob) });
  return true;
}
