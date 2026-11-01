/**
 * Where the page that starts Code runs, and the desktop app's own computer.
 *
 * - The desktop app: its own paired device (the app names it) when "Let the
 *   hub use this computer" is on. Code starts there by default.
 * - A browser on a computer (the hub's web page): no computer of its own.
 *   Code starts on the hub, or on the device picked last in this browser.
 *   It used to take the computer the hub saw the browser on (a daemon at the
 *   same address, or one an app linked it to), which put Code on that
 *   computer with no word of the hub.
 * - A phone: Code starts on the last computer used.
 *
 * start.ts startDevice has the rule.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { isDesktopApp } from '@/lib/notify';
import { useHub } from '@/store/store';
import type { Surface } from './start';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function tauriInvoke(): Invoke | undefined {
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } }; __TAURI_INTERNALS__?: { invoke?: Invoke } };
  return w.__TAURI__?.core?.invoke ?? w.__TAURI_INTERNALS__?.invoke;
}

/** A phone or a tablet: its owner codes on a computer elsewhere. */
function onPhone(): boolean {
  return typeof navigator !== 'undefined' && /iPhone|iPad|Android/i.test(navigator.userAgent);
}

/** The desktop app, a browser on a computer, or a phone. */
export function startSurface(): Surface {
  if (isDesktopApp()) return 'desktop';
  return onPhone() ? 'phone' : 'browser';
}

const useHere = create<{ device?: string; asked: boolean }>(() => ({ asked: false }));

/** The desktop app's own computer among the hub's devices: the one named as the app's computer, when the hub may use it. */
async function find(names: Record<string, string>): Promise<string | undefined> {
  const invoke = tauriInvoke();
  if (!invoke) return undefined;
  const view = await invoke<{ enabled?: boolean; name?: string | null }>('computer_status').catch(() => undefined);
  return view?.enabled && view.name ? Object.entries(names).find(([, n]) => n === view.name)?.[0] : undefined;
}

/** The device id of the desktop app's own computer, once known; undefined in a browser or on a phone. */
export function useThisComputer(): string | undefined {
  const devices = useHub((s) => s.devices);
  const { device, asked } = useHere();
  const ready = Object.keys(devices).length > 0;
  useEffect(() => {
    if (asked || !ready || startSurface() !== 'desktop') return;
    useHere.setState({ asked: true });
    const names = Object.fromEntries(Object.values(devices).map((d) => [d.id, d.name]));
    void find(names).then((id) => useHere.setState({ device: id }));
  }, [asked, ready, devices]);
  return device && devices[device] ? device : undefined;
}
