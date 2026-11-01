/**
 * Meeting routes for the app (docs/design/MEETING-MODE.md 3.1), on the app's
 * client so the token, the hub key check and the mock all apply. The overlay
 * uses the same functions over plain fetch (src/overlay/hub.ts).
 */
import { ApiError } from '@conclave/core/client';
import { api, MOCK } from '@/lib/api';
import { ipc } from '@/overlay/desktop';
import { meetingApi } from '@/overlay/hub';
import type { MeetingFile } from '@/overlay/wire';

export const meetings = () => meetingApi((method, path, body) => api().request(method, path, body));

/** POST /api/meetings/:id/files as multipart (the JSON client cannot send it). Returns the meeting's files after the upload. */
export async function uploadMeetingFiles(id: string, files: File[]): Promise<MeetingFile[]> {
  const c = api();
  const body = new FormData();
  for (const f of files) body.append('file', f, f.name);
  const f = MOCK ? (await import('@/mock')).mockFetch : fetch;
  const res = await f(`${c.baseUrl}/api/meetings/${encodeURIComponent(id)}/files`, { method: 'POST', headers: c.token ? { authorization: `Bearer ${c.token}` } : {}, body });
  const data = (await res.json().catch(() => undefined)) as { files?: MeetingFile[]; error?: string } | undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data);
  return data?.files ?? [];
}

export const OLD_DESKTOP = 'This desktop app is older than meeting mode (0.4.51). Update it in Settings > About, then start the meeting again.';

/** Open the overlay window on a meeting (desktop app only; returns false elsewhere). */
export async function openOverlay(meetingId: string): Promise<boolean> {
  const p = ipc.open(meetingId);
  if (!p) return false;
  try {
    await p;
  } catch (e) {
    // an app from before meeting mode has no meeting_open, and its ACL says so
    if (/not allowed by ACL|not found/i.test(String(e))) throw new Error(OLD_DESKTOP);
    throw e;
  }
  return true;
}
