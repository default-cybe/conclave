/**
 * What the Chat page asks the hub to do (docs/design/CHAT-AND-MOTION.md 2.6,
 * 2.9, 3.2). Each action shows its result at once (the message enters as you
 * send it) and toasts the reason when the hub refuses.
 */
import type { Attachment } from '@conclave/core/client';
import type { ChatSettings, Message, Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, loadMessages, sendQueued, toast, upsertSession, useHub } from '@/store/store';
import { msgText } from '@/features/chat/util';
import { DEFAULTS_EVENT, movePending, patchPending, saveDefaults, setLeaving, setPending, setRestore, type Pending } from './state';
import { timeGroup } from './units';

export type Navigate = (to: string, opts?: { replace?: boolean }) => void;

/** The hub's 409 when a send would lose a file it could not read (attachments/prepare.ts ATTACHMENT_LOST; not imported: that module pulls Bun-only code into the web build). */
const ATTACHMENT_LOST = 'Attachment not included: ';

export interface Outgoing {
  text: string;
  attachments: Attachment[];
  /** A shared chat: your words to the others, no AI turn (SHARED-WITH-MEMBERS.md 10.1). */
  justTalk?: boolean;
}

const FADE_MS = 120;

/**
 * Keep the newest copy of a session. The hub's events can land before the
 * HTTP answer that carried an older copy (a new chat would read as idle while
 * it runs, or a chat that failed at once as fine), so an answer replaces the
 * store's copy only when it is strictly newer. Two writes in the same
 * millisecond happen (created, then running), and the event stream has them
 * in order, so a tie keeps the store's copy.
 */
export function keepSession(s: Session) {
  const cur = useHub.getState().sessions[s.id];
  if (!cur || s.updatedAt > cur.updatedAt) upsertSession(s);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send into the account's one assistant thread (GET /api/assistant/home), the
 * way Home, Plan my day and Goals talk to the assistant: no new session per
 * message. While it works, the message waits in its queue. A model picked on
 * Home switches the thread's model first, as on Android; permission mode and
 * effort from Home are not applied. The thread, or undefined when the hub
 * refused (the toast says why).
 */
export async function sendToAssistant(out: Outgoing | { text: string }, opts: { model?: string } = {}): Promise<Session | undefined> {
  let home = await attempt(() => api().assistantHome());
  if (!home) return undefined;
  if (opts.model && opts.model !== home.model) {
    const id = home.id;
    home = await attempt(() => api().updateSession(id, { model: opts.model }));
    if (!home) return undefined;
  }
  const thread = home;
  keepSession(thread);
  const sent = await attempt(() => api().send(thread.id, out));
  return sent ? thread : undefined;
}

function pendingFor(out: Outgoing, known: Iterable<string>, hide: Iterable<string> = []): Pending {
  return {
    text: out.text,
    images: out.attachments.filter((a) => a.mediaType.startsWith('image/') && a.data).map((a) => `data:${a.mediaType};base64,${a.data}`),
    files: out.attachments.filter((a) => !a.mediaType.startsWith('image/')).map((a) => a.name ?? 'File'),
    known: new Set(known),
    hide: new Set(hide),
    at: Date.now(),
  };
}

/** The attachments a message was sent with, so Edit and Retry send them again. */
export function attachmentsOf(m: Message): Attachment[] {
  const out: Attachment[] = [];
  for (const b of m.content) {
    if (b.type === 'image' && b.data) out.push({ mediaType: b.mediaType, data: b.data, name: 'image' });
    if (b.type === 'document' && b.data) out.push({ mediaType: b.mediaType, data: b.data, name: b.title ?? 'document' });
  }
  return out;
}

/**
 * The first message of a new chat: one call makes the chat and sends it, then the URL becomes /chat/:id.
 * Sent from somewhere else (Home), the Chat page opens at once with your message and the Thinking mark,
 * so the reply never starts on an empty page; /chat then becomes /chat/:id in place, and Back goes home.
 * Left before the hub answered, the chat still starts and waits in the list.
 */
export async function startChat(out: Outgoing, opts: { model?: string; chat: Partial<ChatSettings> }, navigate: Navigate): Promise<boolean> {
  setPending('new', pendingFor(out, []));
  if (window.location.pathname !== '/chat') navigate('/chat');
  const withFiles = out.attachments.length > 0;
  const s = await attempt(() => api().createSession({ kind: 'chat', model: opts.model, chat: opts.chat, prompt: withFiles ? undefined : out.text }));
  if (!s) {
    setPending('new', undefined);
    return false;
  }
  keepSession(s);
  movePending('new', s.id);
  // only while the new chat is still on screen: Back or a link during the call must not pull you into it
  if (window.location.pathname === '/chat') navigate(`/chat/${s.id}`, { replace: true });
  if (withFiles) {
    const r = await sendChosen(s.id, { text: out.text, attachments: out.attachments }, () => setPending(s.id, undefined));
    if (!r) setPending(s.id, undefined);
  }
  return true;
}

/**
 * Send, and when the hub names a file it could not read, put the choice to
 * the owner instead of dropping it silently: "Send without it" sends the
 * message with the loss accepted. Undefined while the choice waits.
 */
async function sendChosen(sessionId: string, input: { text: string; attachments?: Attachment[]; justTalk?: boolean }, onRefused: () => void) {
  try {
    return await api().send(sessionId, input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (!msg.startsWith(ATTACHMENT_LOST)) {
      // as attempt(): the refusal says why, the message stays unsent
      toast({ title: msg, level: 'error' });
      return undefined;
    }
    onRefused();
    toast({
      title: msg.slice(ATTACHMENT_LOST.length),
      level: 'error',
      sticky: true,
      action: {
        label: 'Send without it',
        run: () => {
          void api()
            .send(sessionId, { ...input, attachmentLoss: 'drop' })
            .catch((err) => toast({ title: err instanceof Error ? err.message : String(err), level: 'error' }));
        },
      },
    });
    return undefined;
  }
}

/** A message in an open chat. While a reply runs it queues and sends when the reply ends. */
export async function sendTo(session: Session, out: Outgoing): Promise<boolean> {
  // a reply in flight (running, or held on an approval or a question): the message waits behind it
  const running = session.status === 'running' || session.status === 'waiting_approval' || session.status === 'waiting_input';
  const known = (useHub.getState().messages[session.id] ?? []).map((m) => m.id);
  const attachments = out.attachments.length ? out.attachments : undefined;
  // while a reply runs it shows at once at the end, Queued, until its turn takes it (CHAT-AND-MOTION 2.11)
  // Just talk starts no turn, so it never waits behind one
  if (running && !out.justTalk) return !!(await sendQueued(session.id, { text: out.text, attachments, whenBusy: 'queue' }));
  setPending(session.id, pendingFor(out, known));
  const r = await sendChosen(session.id, { text: out.text, attachments, ...(out.justTalk ? { justTalk: true } : {}) }, () => setPending(session.id, undefined));
  if (!r) {
    setPending(session.id, undefined);
    return false;
  }
  // the hub was busy after all: it waits there and session.queue shows it, not the bubble shown at send
  if (r.queued) setPending(session.id, undefined);
  return true;
}

/**
 * Stop the reply that is running (Stop, esc). The hub keeps what was queued
 * behind it, held: each shows "Stopped" with Send and Remove (CHAT-AND-MOTION 2.11).
 */
export async function stopChat(chatId: string) {
  await attempt(() => api().abort(chatId));
}

/**
 * Replace everything from `from` on with a new message (Edit and Retry): the
 * replies after it fade out together, the new message shows at once, then
 * the hub drops the old ones and runs the new one.
 */
export async function replaceFrom(session: Session, from: Message, out: Outgoing): Promise<boolean> {
  const list = useHub.getState().messages[session.id] ?? [];
  const after = list.filter((m) => m.seq > from.seq).map((m) => m.id);
  const gone = [from.id, ...after];
  if (session.status === 'running') await attempt(() => api().abort(session.id));
  // the message shows its new text at once, in place; the replies after it fade out together
  setPending(session.id, { ...pendingFor(out, list.map((m) => m.id)), key: from.id });
  setLeaving(after, true);
  await sleep(FADE_MS);
  patchPending(session.id, { hide: new Set(gone) });
  setLeaving(after, false);
  // the hub keeps messages up to the seq it is given and drops the rest
  const s = await attempt(() => api().rewind(session.id, from.seq - 1));
  if (!s) {
    setPending(session.id, undefined);
    return false;
  }
  keepSession(s);
  await loadMessages(session.id, true);
  const r = await attempt(() => api().send(session.id, { text: out.text, attachments: out.attachments.length ? out.attachments : undefined }));
  if (!r) {
    setPending(session.id, undefined);
    // the old message is already gone from the hub: its new text waits in the composer to send again
    setRestore(session.id, out.text);
    return false;
  }
  return true;
}

/** Retry a reply: send the message that asked for it again. */
export function retryFrom(session: Session, user: Message) {
  return replaceFrom(session, user, { text: msgText(user), attachments: attachmentsOf(user) });
}

/**
 * Branch: a new chat with everything up to `fromSeq`, named "<title>, branch".
 * It opens the branch, or with `stay` keeps you here (Branch before an edit).
 */
export async function branchChat(session: Session, fromSeq: number | undefined, navigate: Navigate, opts: { stay?: boolean } = {}) {
  const fork = await attempt(() => api().forkSession(session.id, fromSeq));
  if (!fork) return;
  keepSession(fork);
  const title = `${session.title}, branch`;
  const named = await attempt(() => api().updateSession(fork.id, { title }));
  if (named) keepSession(named);
  if (opts.stay) {
    toast({ title: `Branched. The old replies are in ${title}.`, level: 'info', action: { label: 'Open', run: () => navigate(`/chat/${fork.id}`) } });
    return;
  }
  navigate(`/chat/${fork.id}`);
  const where = timeGroup(session.updatedAt).label;
  toast({ title: `Branched. The original is in ${where}.`, level: 'info', action: { label: 'Open', run: () => navigate(`/chat/${session.id}`) } });
}

export async function patchChat(id: string, patch: Parameters<ReturnType<typeof api>['updateSession']>[1]) {
  const s = await attempt(() => api().updateSession(id, patch));
  if (s) keepSession(s);
  return s;
}

/** Undo a "Saved to memory" row: the note leaves memory. */
export async function forgetNote(id: string) {
  const ok = await attempt(() => api().deleteMemory(id));
  if (ok) toast({ title: 'Removed from memory.', level: 'info' });
  return !!ok;
}

/** A model picked outside the composer (the command palette): the open chat switches; on /chat the next chat starts with it. */
export function chooseChatModel(chatId: string | undefined, model: string) {
  saveDefaults({ model });
  if (chatId) void patchChat(chatId, { model });
  else window.dispatchEvent(new Event(DEFAULTS_EVENT));
}
