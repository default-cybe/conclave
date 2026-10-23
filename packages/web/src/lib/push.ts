/** Web Push: subscribe this browser and hand the subscription to the hub. */
import { api } from './api';
import { clientLog } from './clientLog';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The desktop app's webview has no Web Push; it shows notices itself (lib/notify.ts). */
function inDesktopApp(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w;
}

export function pushSupported(): boolean {
  return !inDesktopApp() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<'unsupported' | 'denied' | 'on' | 'off'> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await currentSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** This browser's push endpoint, when it has one. */
export async function pushEndpoint(): Promise<string | undefined> {
  if (!pushSupported()) return undefined;
  return (await currentSubscription())?.endpoint;
}

/** The hub key a subscription was made for, base64url like the hub sends it. */
function keyOf(sub: PushSubscription): string | undefined {
  const key = sub.options.applicationServerKey;
  if (!key) return undefined;
  return btoa(String.fromCharCode(...new Uint8Array(key)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function toJson(sub: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  return { endpoint: json.endpoint, keys: json.keys };
}

export async function enablePush(deviceName?: string): Promise<void> {
  if (!pushSupported()) throw new Error('This browser cannot get notifications. On an iPhone, add Conclave to the Home Screen and open it from there.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser settings, then reload.');
  const { publicKey } = await api().vapidKey();
  if (!publicKey) throw new Error('The hub has no Web Push key yet. Restart the hub, then try again.');
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // a subscription made for another hub's key cannot be reused
  if (sub && keyOf(sub) && keyOf(sub) !== publicKey.replace(/=+$/, '')) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api().pushSubscribe(toJson(sub), deviceName);
}

/**
 * Hand an existing subscription to the hub again (it may have dropped it, or
 * have new keys after a restore). Quiet: no prompt, no throw.
 */
export async function resyncPush(deviceName?: string): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration();
    let sub = (await reg?.pushManager.getSubscription()) ?? null;
    if (!reg || !sub) return;
    const { publicKey } = await api().vapidKey();
    // made for other hub keys: pushes would be refused, so subscribe again (permission is already granted)
    if (publicKey && keyOf(sub) && keyOf(sub) !== publicKey.replace(/=+$/, '')) {
      await sub.unsubscribe().catch(() => false);
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    }
    await api().pushSubscribe(toJson(sub), deviceName);
  } catch (e) {
    /* the next visit to Settings tries again */
    clientLog('warn', 'push.resync.failed', undefined, e);
  }
}

export async function disablePush(): Promise<void> {
  const sub = pushSupported() ? await currentSubscription() : null;
  if (!sub) return;
  // tell the hub first; the endpoint is gone once the browser unsubscribes
  await api()
    .pushUnsubscribe(sub.endpoint)
    .catch(() => undefined);
  await sub.unsubscribe();
}

/** Same id the hub uses for a push endpoint (sha256, first 16 hex characters). */
export async function endpointId(endpoint: string): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  } catch {
    return undefined;
  }
}
