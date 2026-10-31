/**
 * The meeting routes of docs/design/MEETING-MODE.md 3.1 over one request
 * function, so the overlay (plain fetch, no ConclaveClient) and the app
 * (api().request) call them the same way.
 */
import type { AnswerNowInput, CreateMeetingInput, Meeting, MeetingDetail, MeetingNotes } from './wire';

export type Req = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export class HubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A request function on fetch with the account's token. Errors carry the hub's own words. */
export function fetchReq(baseUrl: string, token: string, f: typeof fetch = fetch): Req {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await f(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) throw new HubError(res.status, (data as { error?: string } | undefined)?.error ?? (res.statusText || `HTTP ${res.status}`));
    return data as T;
  };
}

const m = (id: string) => `/api/meetings/${encodeURIComponent(id)}`;

export function meetingApi(req: Req) {
  return {
    list: (projectId?: string) => req<{ meetings: Meeting[] }>('GET', `/api/meetings${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) => r.meetings),
    create: (input: CreateMeetingInput) => req<Meeting>('POST', '/api/meetings', input),
    get: (id: string) => req<MeetingDetail>('GET', m(id)),
    patch: (id: string, patch: { title?: string; agenda?: string; autoAnswer?: Meeting['autoAnswer']; status?: 'live' | 'paused' }) => req<Meeting>('PATCH', m(id), patch),
    answer: (id: string, input: AnswerNowInput) => req<{ answerId: string; messageId: string }>('POST', `${m(id)}/answer`, input),
    cancel: (id: string, answerId: string) => req<void>('POST', `${m(id)}/answers/${encodeURIComponent(answerId)}/cancel`),
    end: (id: string) => req<Meeting>('POST', `${m(id)}/end`),
    notes: (id: string) => req<MeetingNotes>('GET', `${m(id)}/notes`),
    remove: (id: string) => req<void>('DELETE', m(id)),
    /** The session's messages: the brief and the answers' text. */
    messages: (sessionId: string) => req<{ id: string; content: { type: string; text?: string }[] }[]>('GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages`),
  };
}

export type MeetingApi = ReturnType<typeof meetingApi>;
