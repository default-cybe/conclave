/**
 * Notifications on this device.
 *
 * A browser or the installed web app uses Web Push (lib/push.ts), so the hub
 * reaches it while Conclave is closed. The desktop app has no Web Push; it
 * keeps its connection while it sits in the tray and shows the hub's notices
 * itself (window.Notification is the native one there). Notices marked
 * `alert` passed the owner's rules in Settings > Notifications.
 *
 * Every app also tells the hub whether Conclave is in use here, so the hub
 * holds notifications while someone is looking (Hold notifications).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { NotifyDeviceDto } from '@conclave/core/client';
import type { Notice } from '@conclave/core/types';
import { navigate } from 'wouter/use-browser-location';
import { api } from './api';
import { disablePush, enablePush, endpointId, pushEndpoint, pushState, resyncPush } from './push';
import { clientLog } from './clientLog';

/** insecure: a browser on a plain http address, where browsers turn Web Push off. */
export type DeviceNotifyState = 'checking' | 'unsupported' | 'insecure' | 'denied' | 'on' | 'off';

export function isDesktopApp(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w;
}

/** "Chrome on macOS", "Safari on iOS", "Desktop app on Linux". The hub shows it in the device list. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux|X11/.test(ua) ? 'Linux' : '';
  const app = isDesktopApp()
    ? 'Desktop app'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Edg\//.test(ua)
        ? 'Edge'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const installed = !isDesktopApp() && window.matchMedia?.('(display-mode: standalone)').matches;
  return `${app}${os ? ` on ${os}` : ''}${installed ? ', installed' : ''}`;
}

// ---------------------------------------------------------------------------
// Turning it on and off
// ---------------------------------------------------------------------------

const DESKTOP_KEY = 'conclave.desktopNotify';

function desktopPref(): boolean {
  try {
    return localStorage.getItem(DESKTOP_KEY) !== '0';
  } catch {
    return true;
  }
}

function setDesktopPref(on: boolean) {
  try {
    localStorage.setItem(DESKTOP_KEY, on ? '1' : '0');
  } catch {
    /* private mode: stays on for this window */
  }
}

function nativeNotification(): typeof Notification | undefined {
  return typeof window !== 'undefined' && 'Notification' in window ? window.Notification : undefined;
}

/** The desktop app has notifications on (sync, for summaries). Browsers: see deviceNotifyState. */
export function desktopNotifyOn(): boolean {
  return isDesktopApp() && nativeNotification()?.permission === 'granted' && desktopPref();
}

/** The desktop app learns its permission a moment after load; wait for it instead of reading "default". */
async function settledPermission(N: typeof Notification): Promise<NotificationPermission> {
  for (let i = 0; i < 10 && N.permission === 'default'; i++) await new Promise((r) => setTimeout(r, 50));
  return N.permission;
}

export async function deviceNotifyState(): Promise<Exclude<DeviceNotifyState, 'checking'>> {
  if (isDesktopApp()) {
    const N = nativeNotification();
    if (!N) return 'unsupported';
    const perm = await settledPermission(N);
    if (perm === 'denied') return 'denied';
    return perm === 'granted' && desktopPref() ? 'on' : 'off';
  }
  // browsers only offer Web Push on https (and on localhost)
  if (window.isSecureContext === false) return 'insecure';
  const state = await pushState();
  if (state === 'on') void resyncPush(deviceName());
  return state;
}

export async function enableDeviceNotify(): Promise<void> {
  if (isDesktopApp()) {
    const N = nativeNotification();
    if (!N) throw new Error('This version of the desktop app cannot show notifications. Update it, then try again.');
    const perm = (await settledPermission(N)) === 'granted' ? 'granted' : await N.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked for Conclave. Allow them in your system settings, then try again.');
    setDesktopPref(true);
    return;
  }
  if (window.isSecureContext === false) throw new Error(INSECURE_WORDS);
  await enablePush(deviceName());
}

export const INSECURE_WORDS = 'Browsers only allow notifications on an https address. Open Conclave at its https address (Settings, Remote access), then turn this on there.';

export async function disableDeviceNotify(): Promise<void> {
  if (isDesktopApp()) setDesktopPref(false);
  else await disablePush();
}

/** Send a test to this device only. Throws a message that says what to do. */
export async function testDeviceNotify(): Promise<void> {
  if (isDesktopApp()) {
    if (!show({ title: 'Conclave test', body: 'Notifications reach this device.', link: '/settings/notifications' })) {
      throw new Error('The system did not show the notification. Allow notifications for Conclave in your system settings, then try again.');
    }
    return;
  }
  const endpoint = await pushEndpoint();
  if (!endpoint) throw new Error('This browser is not set up yet. Turn on Notify this device, then send a test.');
  await api().testNotify('webpush', { endpoint });
}

// ---------------------------------------------------------------------------
// While the app runs
// ---------------------------------------------------------------------------

let synced = false;

/**
 * Once per load: a browser with notifications on hands its subscription to
 * the hub again, so one the hub dropped or made for old keys starts working
 * without a visit to Settings. Quiet: no prompt, nothing in the desktop app.
 */
export function syncDeviceNotify(): void {
  if (synced || isDesktopApp() || window.isSecureContext === false) return;
  synced = true;
  void resyncPush(deviceName());
}

/** True while this window is in front: visible and focused. */
export function appInUse(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Last time someone typed, clicked, scrolled or moved the pointer here. */
let lastInput = Date.now();
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
if (typeof window !== 'undefined') {
  for (const type of INPUT_EVENTS) window.addEventListener(type, () => (lastInput = Date.now()), { capture: true, passive: true });
}

/** A window in front that nobody touched for this long counts as left alone. */
const AWAY_MS = 60_000;

/** True while someone is using this window: in front, with input in the last minute. */
export function usedHere(): boolean {
  return appInUse() && Date.now() - lastInput < AWAY_MS;
}

/** How often input while in front tells the hub again that Conclave is in use. */
const HEARTBEAT_MS = 20_000;

/**
 * Keep the hub told whether Conclave is in use here: true on coming to the
 * front and again on input (at most every 20 seconds), false on going to the
 * background. The hub counts a window as in use for notifications.idleSeconds
 * after the last true, so one left in front with nobody at it stops holding.
 * Returns a function that stops.
 */
export function watchPresence(setActive: (active: boolean) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sentAt = Date.now();
  const report = (active: boolean) => {
    if (active) sentAt = Date.now();
    setActive(active);
  };
  // focus moves between windows in two steps; report where it settles
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => report(appInUse()), 150);
  };
  const onInput = () => {
    if (Date.now() - sentAt >= HEARTBEAT_MS && appInUse()) report(true);
  };
  document.addEventListener('visibilitychange', update);
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { passive: true });
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', update);
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput);
  };
}

/** The desktop app's quick ask window (?quick=1) runs the app too; the main window shows the notices. */
const QUICK_WINDOW = typeof location !== 'undefined' && new URLSearchParams(location.search).has('quick');

/** Run `fn` once per notice id across this app's windows. */
function onceAcrossWindows(id: string, fn: () => void) {
  const run = () => {
    try {
      if (localStorage.getItem('conclave.lastNotice') === id) return;
      localStorage.setItem('conclave.lastNotice', id);
    } catch {
      /* no storage: show it */
    }
    fn();
  };
  if (navigator.locks) void navigator.locks.request('conclave-notice', run).catch(run);
  else run();
}

/**
 * The desktop app shows a notice from the hub as a system notification when
 * nobody is using its window (in the background, or in front and left alone).
 */
export function deviceNotice(notice: Notice): void {
  if (!notice.alert || !isDesktopApp() || QUICK_WINDOW || !desktopPref() || usedHere()) return;
  onceAcrossWindows(notice.id, () => show(notice));
}

function show(n: Pick<Notice, 'title' | 'body'> & Partial<Pick<Notice, 'id' | 'link' | 'sessionId' | 'approvalId'>>): boolean {
  const N = nativeNotification();
  if (!N || N.permission !== 'granted') return false;
  try {
    const note = new N(n.title || 'Conclave', { body: n.body, tag: n.approvalId ? `approval-${n.approvalId}` : n.id });
    const to = n.link ?? (n.sessionId ? `/s/${n.sessionId}` : n.approvalId ? '/approvals' : undefined);
    // Tauri's notifications do not report clicks on every system; where they do, open the session
    note.onclick = () => {
      window.focus();
      if (to) navigate(to);
      note.close?.();
    };
    return true;
  } catch (e) {
    clientLog('warn', 'notify.show.failed', undefined, e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// React: this device, and the browsers the hub notifies
// ---------------------------------------------------------------------------

function words(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/** "Notify this device": its state, turning it on and off, and a test to this device only. */
export function useDeviceNotify() {
  const [state, setState] = useState<DeviceNotifyState>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const refresh = useCallback(async () => {
    const next = await deviceNotifyState().catch(() => 'off' as const);
    setState(next);
    return next;
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const turn = async (on: boolean) => {
    setBusy(true);
    setError(undefined);
    setTest('idle');
    try {
      if (on) await enableDeviceNotify();
      else await disableDeviceNotify();
    } catch (e) {
      setError(words(e));
      clientLog('warn', on ? 'notify.enable.failed' : 'notify.disable.failed', undefined, e);
    }
    await refresh();
    setBusy(false);
    reloadNotifyDevices();
  };

  const sendTest = async () => {
    setTest('sending');
    setError(undefined);
    try {
      await testDeviceNotify();
      setTest('sent');
    } catch (e) {
      setTest('failed');
      setError(words(e));
      clientLog('warn', 'notify.test.failed', undefined, e);
      void refresh();
    }
  };

  return { state, busy, error, test, turn, sendTest };
}

type DeviceList = { list: NotifyDeviceDto[]; loaded: boolean; mine?: string };
let devices: DeviceList = { list: [], loaded: false };
const devicesListeners = new Set<() => void>();
let loading: Promise<void> | undefined;

function setDevices(next: DeviceList) {
  devices = next;
  for (const fn of devicesListeners) fn();
}

/** Fetch the hub's list of browsers that get Web Push, and which one is this browser. */
export function reloadNotifyDevices(): Promise<void> {
  loading = (async () => {
    try {
      const [list, endpoint] = await Promise.all([api().notifyDevices(), pushEndpoint().catch(() => undefined)]);
      setDevices({ list, loaded: true, mine: endpoint ? await endpointId(endpoint) : undefined });
    } catch {
      setDevices({ ...devices, loaded: true });
    }
  })();
  return loading;
}

export async function removeNotifyDevice(id: string): Promise<void> {
  await api().removeNotifyDevice(id);
  setDevices({ ...devices, list: devices.list.filter((d) => d.id !== id) });
}

/** Browsers the hub notifies. `mine` is this browser's id when it is one of them. */
export function useNotifyDevices(): DeviceList {
  const snap = useSyncExternalStore(
    (fn) => {
      devicesListeners.add(fn);
      return () => devicesListeners.delete(fn);
    },
    () => devices,
  );
  useEffect(() => {
    if (!devices.loaded && !loading) void reloadNotifyDevices();
  }, []);
  return snap;
}
