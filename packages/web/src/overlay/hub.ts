/**
 * The meeting routes of docs/design/MEETING-MODE.md 3.1 over one request
 * function, so the overlay (plain fetch, no ConclaveClient) and the app
 * (api().request) call them the same way.
 */
import type { AnswerNowInput, CreateMeetingInput, Meeting, MeetingCalendarEvent, MeetingChatInput, MeetingDetail, MeetingFolder, MeetingNotes, MeetingListView, MeetingPatch, PrepView, SteeringPreset } from './wire';

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
const qs = (q: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v === undefined || v === '' ? [] : [[k, String(v)]]))).toString();
  return s ? `?${s}` : '';
};

export function meetingApi(req: Req) {
  return {
    list: (projectId?: string) => req<{ meetings: Meeting[] }>('GET', `/api/meetings${qs({ projectId })}`).then((r) => r.meetings),
    /** 11.6: one section of the Meetings page; `before` pages Past. */
    view: (view: MeetingListView, opts: { limit?: number; before?: number } = {}) => req<{ meetings: Meeting[] }>('GET', `/api/meetings${qs({ view, limit: opts.limit, before: opts.before })}`).then((r) => r.meetings),
    create: (input: CreateMeetingInput) => req<Meeting>('POST', '/api/meetings', input),
    get: (id: string) => req<MeetingDetail>('GET', m(id)),
    patch: (id: string, patch: MeetingPatch) => req<Meeting>('PATCH', m(id), patch),
    answer: (id: string, input: AnswerNowInput) => req<{ answerId: string; messageId: string }>('POST', `${m(id)}/answer`, input),
    cancel: (id: string, answerId: string) => req<void>('POST', `${m(id)}/answers/${encodeURIComponent(answerId)}/cancel`),
    end: (id: string) => req<Meeting>('POST', `${m(id)}/end`),
    notes: (id: string) => req<MeetingNotes>('GET', `${m(id)}/notes`),
    remove: (id: string) => req<void>('DELETE', m(id)),
    // scheduled meetings and prep (11.6)
    folders: (q?: string) => req<{ folders: MeetingFolder[] }>('GET', `/api/meetings/folders${qs({ q })}`).then((r) => r.folders),
    calendar: (from: number, to: number) => req<{ events: MeetingCalendarEvent[]; errors: string[] }>('GET', `/api/meetings/calendar${qs({ from, to })}`),
    presets: () => req<{ presets: SteeringPreset[] }>('GET', '/api/meetings/presets').then((r) => r.presets),
    arm: (id: string) => req<Meeting>('POST', `${m(id)}/arm`),
    prep: (id: string) => req<PrepView>('GET', `${m(id)}/prep`),
    runPrep: (id: string, approve?: true) => req<{ state: 'queued' }>('POST', `${m(id)}/prep`, approve ? { approve } : {}),
    cancelPrep: (id: string) => req<void>('POST', `${m(id)}/prep/cancel`),
    savePrep: (id: string, markdown: string) => req<PrepView>('PUT', `${m(id)}/prep`, { markdown }),
    revertPrep: (id: string) => req<void>('DELETE', `${m(id)}/prep/edit`),
    prepExtra: (id: string, sessionIds: string[]) => req<void>('PUT', `${m(id)}/prep/extra`, { sessionIds }),
    // after the meeting: memory and chat
    saveMemory: (id: string) => req<Meeting>('POST', `${m(id)}/memory`),
    toChat: (id: string, input: MeetingChatInput) => req<{ id: string; kind?: string }>('POST', `${m(id)}/chat`, input),
    /** The session's messages: the brief and the answers' text. */
    messages: (sessionId: string) => req<{ id: string; content: { type: string; text?: string }[] }[]>('GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages`),
  };
}

export type MeetingApi = ReturnType<typeof meetingApi>;
