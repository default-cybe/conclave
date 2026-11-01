/**
 * The overlay's side of the desktop IPC (docs/design/MEETING-MODE.md 2.1.1,
 * 3.3). Every command returns at once on the Rust side; transcript and
 * answers come over the WebSocket, never through here. Outside the desktop
 * app (a browser, the mock) there is no desktop and calls return undefined.
 */
import type { DesktopMeetingStatus } from './wire';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;

export interface Desktop {
  invoke: Invoke;
  listen: Listen;
}

let override: Desktop | undefined;

/** The mock installs its fake desktop here (mock/meetings.ts). */
export function setDesktop(d: Desktop | undefined) {
  override = d;
}

export function desktop(): Desktop | undefined {
  if (override) return override;
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: Invoke }; event?: { listen?: Listen } }; __TAURI_INTERNALS__?: { invoke?: Invoke } };
  const invoke = w.__TAURI__?.core?.invoke ?? w.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return undefined;
  const listen: Listen = w.__TAURI__?.event?.listen ?? (async () => () => undefined);
  return { invoke, listen };
}

export const ipc = {
  open: (meetingId: string) => desktop()?.invoke<void>('meeting_open', { meetingId }),
  status: () => desktop()?.invoke<DesktopMeetingStatus>('meeting_status'),
  start: (meetingId: string) => desktop()?.invoke<void>('meeting_start', { meetingId }),
  pause: (paused: boolean) => desktop()?.invoke<void>('meeting_pause', { paused }),
  stop: () => desktop()?.invoke<void>('meeting_stop'),
  clickThrough: (on: boolean) => desktop()?.invoke<void>('meeting_click_through', { on }),
  hide: () => desktop()?.invoke<void>('meeting_hide'),
  focusable: (on: boolean) => desktop()?.invoke<void>('meeting_focusable', { on }),
};
