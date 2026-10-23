/**
 * Chat page state that lives in this tab only: what was just sent and is
 * not on the hub yet, replies fading out before an edit or a retry, the
 * open preview, the rail, and the switches new chats start with.
 */
import { create } from 'zustand';
import type { ChatSettings } from '@conclave/core/types';
import { isEffortSetting } from '@conclave/core/providers/effort';

export type Thinking = NonNullable<ChatSettings['thinking']>;

/** A message on its way: shown at once, until the hub's copy arrives. */
export interface Pending {
  text: string;
  /** Images as data URLs, for the bubble. */
  images: string[];
  /** Other files, by name. */
  files: string[];
  /** Message ids that existed when it was sent. The first new user message resolves it. */
  known: Set<string>;
  /** Message ids being replaced (edit, retry). Hidden until the hub drops them. */
  hide: Set<string>;
  /** Client time it was sent, for the Thinking counter. */
  at: number;
  /** Replaces a message on screen (edit, retry): reuse its place, no entrance. */
  key?: string;
  /** The hub's copy has arrived (its id); the bubble gives way to it. */
  arrived?: string;
  arrivedAt?: number;
}

/** A second opinion on its way. */
export interface Asking {
  model: string;
  replyId: string;
  known: Set<string>;
  at: number;
}

export interface PreviewDoc {
  key: string;
  lang: 'html' | 'svg';
  code: string;
}

interface ChatUi {
  pending: Record<string, Pending>;
  /** Message ids fading out (120ms) before they are replaced. */
  leaving: Set<string>;
  asking: Record<string, Asking>;
  /** The message being edited in place, per chat. */
  editing: Record<string, string | undefined>;
  /** Text to put back in a chat's composer (queued messages a Stop dropped). */
  restore: Record<string, string | undefined>;
  preview?: PreviewDoc;
  /** Desktop: the rail is in the layout. Remembered per device. */
  railOpen: boolean;
  /** The conversation has scrolled: the header shows its rule. */
  scrolled: boolean;
  /** The chat to open the Continue as a session dialog for. */
  continuing?: string;
}

const RAIL_KEY = 'conclave.chat.rail';
const ASIDES_KEY = 'conclave.chat.asides';
const DEFAULTS_KEY = 'conclave.chat.defaults';
/** Fired when the defaults change outside the composer, so the new chat's composer reads them again. */
export const DEFAULTS_EVENT = 'conclave:chat-defaults';

function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) !== '0';
  } catch {
    return true;
  }
}

export const useChatUi = create<ChatUi>(() => ({
  pending: {},
  leaving: new Set(),
  asking: {},
  editing: {},
  restore: {},
  railOpen: readRail(),
  scrolled: false,
}));

const set = useChatUi.setState;
const get = useChatUi.getState;

export function setPending(chatId: string, p: Pending | undefined) {
  set((s) => {
    const next = { ...s.pending };
    if (p) next[chatId] = p;
    else delete next[chatId];
    return { pending: next };
  });
}

export function patchPending(chatId: string, p: Partial<Pending>) {
  const cur = get().pending[chatId];
  if (!cur) return;
  set((s) => ({ pending: { ...s.pending, [chatId]: { ...cur, ...p } } }));
}

/** Move what was sent on /chat to the chat the hub just made. */
export function movePending(from: string, to: string) {
  const p = get().pending[from];
  if (!p) return;
  set((s) => {
    const next = { ...s.pending, [to]: p };
    delete next[from];
    return { pending: next };
  });
}

export function setLeaving(ids: Iterable<string>, on: boolean) {
  set((s) => {
    const next = new Set(s.leaving);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return { leaving: next };
  });
}

export function setAsking(chatId: string, a: Asking | undefined) {
  set((s) => {
    const next = { ...s.asking };
    if (a) next[chatId] = a;
    else delete next[chatId];
    return { asking: next };
  });
}

export function setEditing(chatId: string, messageId: string | undefined) {
  set((s) => ({ editing: { ...s.editing, [chatId]: messageId } }));
}

export function setRestore(chatId: string, text: string | undefined) {
  set((s) => ({ restore: { ...s.restore, [chatId]: text } }));
}

export function openPreview(doc: PreviewDoc) {
  set({ preview: doc });
}

export function closePreview() {
  set({ preview: undefined });
}

export function setRailOpen(open: boolean) {
  set({ railOpen: open });
  try {
    localStorage.setItem(RAIL_KEY, open ? '1' : '0');
  } catch {
    /* private mode: keep it for this tab */
  }
}

export function setScrolled(v: boolean) {
  if (get().scrolled !== v) set({ scrolled: v });
}

export function openContinue(chatId: string | undefined) {
  set({ continuing: chatId });
}

// ---------------------------------------------------------------------------
// The switches a new chat starts with (spec 2.5)
// ---------------------------------------------------------------------------

export interface ChatDefaults {
  model?: string;
  webSearch: boolean;
  memory: boolean;
  thinking?: Thinking;
}

export function readDefaults(): ChatDefaults {
  try {
    const raw = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}') as Partial<ChatDefaults>;
    return {
      model: typeof raw.model === 'string' ? raw.model : undefined,
      webSearch: raw.webSearch !== false,
      memory: raw.memory !== false,
      thinking: isEffortSetting(raw.thinking) ? raw.thinking : undefined,
    };
  } catch {
    return { webSearch: true, memory: true };
  }
}

/** Remember the switches the owner used last on this device. */
export function saveDefaults(patch: Partial<ChatDefaults>) {
  try {
    const next = { ...readDefaults(), ...patch };
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

// ---------------------------------------------------------------------------
// Which reply each second opinion answers (the hub's aside does not say)
// ---------------------------------------------------------------------------

let asides: Record<string, string> | undefined;

export function asideTargets(): Record<string, string> {
  if (asides) return asides;
  try {
    asides = JSON.parse(localStorage.getItem(ASIDES_KEY) || '{}') as Record<string, string>;
  } catch {
    asides = {};
  }
  return asides;
}

/** Remember that aside `asideId` answers reply message `replyId`, so it stays under that reply after a reload. */
export function rememberAside(asideId: string, replyId: string) {
  const next = { ...asideTargets(), [asideId]: replyId };
  // keep the newest 200
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete next[k];
  asides = next;
  try {
    localStorage.setItem(ASIDES_KEY, JSON.stringify(next));
  } catch {
    /* private mode: this tab only */
  }
}
