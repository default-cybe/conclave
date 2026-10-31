/**
 * Meeting routes for the app (docs/design/MEETING-MODE.md 3.1), on the app's
 * client so the token, the hub key check and the mock all apply. The overlay
 * uses the same functions over plain fetch (src/overlay/hub.ts).
 */
import { api } from '@/lib/api';
import { ipc } from '@/overlay/desktop';
import { meetingApi } from '@/overlay/hub';

export const meetings = () => meetingApi((method, path, body) => api().request(method, path, body));

/** Open the overlay window on a meeting (desktop app only; returns false elsewhere). */
export async function openOverlay(meetingId: string): Promise<boolean> {
  const p = ipc.open(meetingId);
  if (!p) return false;
  await p;
  return true;
}
