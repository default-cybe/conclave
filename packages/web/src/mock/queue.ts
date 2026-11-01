/**
 * Messages sent while a mock session works, as the hub keeps them (core
 * session/runner.ts, docs/design/CHAT-AND-MOTION.md 2.11): each gets an id
 * (the app's pendingId when it is good), session.queue lists them in the
 * order they will run (steering first), the user message that takes one's
 * place carries meta.pendingIds, and Stop holds them until Send or the x. Shared by the
 * session routes (index.ts) and the chat routes (chat.ts).
 */
import type { ContentBlock, EngineEvent, QueuedMessage } from '@conclave/core/types';

export interface WaitingInput {
  text: string;
  attachments?: Array<{ mediaType?: string; data?: string; name?: string }>;
}

type Waiting = QueuedMessage & { input: WaitingInput };

const PENDING_ID = /^[A-Za-z0-9_-]{6,64}$/;

export function createMockQueue(emit: (e: EngineEvent) => void, uid: (p: string) => string) {
  const waiting = new Map<string, Waiting[]>();

  const ordered = (sessionId: string) => {
    const all = waiting.get(sessionId) ?? [];
    return [...all.filter((w) => w.whenBusy === 'steer'), ...all.filter((w) => w.whenBusy !== 'steer')];
  };
  const list = (sessionId: string): QueuedMessage[] => ordered(sessionId).map(({ input: _i, ...q }) => q);
  const changed = (sessionId: string) => emit({ type: 'session.queue', sessionId, queue: list(sessionId) });

  return {
    list,
    /** A message sent while busy: it waits, and the app hears of it. */
    wait(sessionId: string, body: { text?: unknown; attachments?: unknown; whenBusy?: unknown; pendingId?: unknown }): { queued: true; pendingId: string } {
      const all = waiting.get(sessionId) ?? [];
      const asked = body.pendingId;
      const id = typeof asked === 'string' && PENDING_ID.test(asked) && !all.some((w) => w.id === asked) ? asked : uid('q');
      const files = (Array.isArray(body.attachments) ? body.attachments : []) as NonNullable<WaitingInput['attachments']>;
      const attachments = files.map((a) => ({ mediaType: a.mediaType ?? 'application/octet-stream', ...(a.name ? { name: a.name } : {}) }));
      const text = String(body.text ?? '');
      all.push({ id, text, at: Date.now(), whenBusy: body.whenBusy === 'steer' ? 'steer' : 'queue', ...(attachments.length ? { attachments } : {}), input: { text, attachments: files } });
      waiting.set(sessionId, all);
      changed(sessionId);
      return { queued: true, pendingId: id };
    },
    /** Steering for the running turn's next step: taken off the list. Write each as a user message, then call `done`. */
    takeSteering(sessionId: string): Waiting[] {
      const all = waiting.get(sessionId) ?? [];
      const steer = all.filter((w) => w.whenBusy === 'steer');
      if (steer.length) waiting.set(sessionId, all.filter((w) => w.whenBusy !== 'steer'));
      return steer;
    },
    /** The next message to run once a turn ends (steering that came too late runs first, as queued). Listed until `done`. */
    next(sessionId: string): Waiting | undefined {
      const late = (waiting.get(sessionId) ?? []).some((w) => w.whenBusy === 'steer');
      const all = ordered(sessionId).map((w) => (w.whenBusy === 'steer' ? { ...w, whenBusy: 'queue' as const } : w));
      waiting.set(sessionId, all);
      if (late) changed(sessionId);
      // one Stop held waits for Send
      return all.find((w) => !w.held);
    },
    /** Send on one Stop held: it runs in its place. */
    release(sessionId: string, id: string): boolean {
      const all = waiting.get(sessionId) ?? [];
      if (!all.some((w) => w.id === id)) return false;
      waiting.set(sessionId, all.map((w) => (w.id === id ? { ...w, held: undefined } : w)));
      changed(sessionId);
      return true;
    },
    /** The message took its place in the transcript (or was dropped): the list without it. */
    done(sessionId: string, ids: string[]) {
      const all = waiting.get(sessionId) ?? [];
      waiting.set(sessionId, all.filter((w) => !ids.includes(w.id)));
      changed(sessionId);
    },
    remove(sessionId: string, id: string): boolean {
      const all = waiting.get(sessionId) ?? [];
      if (!all.some((w) => w.id === id)) return false;
      waiting.set(sessionId, all.filter((w) => w.id !== id));
      changed(sessionId);
      return true;
    },
    /** Stop: what waits is held (steering first, as queued) until Send or the x, and the app hears of it. */
    hold(sessionId: string) {
      if (!waiting.get(sessionId)?.length) return;
      waiting.set(sessionId, ordered(sessionId).map((w) => ({ ...w, whenBusy: 'queue' as const, held: true })));
      changed(sessionId);
    },
    /** The user message for one that waited, as the hub writes it. */
    content(w: Waiting, steer = false): ContentBlock[] {
      const blocks: ContentBlock[] = w.text ? [{ type: 'text', text: w.text }] : [];
      for (const a of w.input.attachments ?? []) {
        if (a.mediaType?.startsWith('image/')) blocks.push({ type: 'image', mediaType: a.mediaType, data: a.data });
        else blocks.push({ type: 'document', mediaType: a.mediaType ?? 'application/octet-stream', data: a.data, title: a.name });
      }
      // the hub tells the model a steering message came while it worked; apps do not show it
      if (steer) blocks.push({ type: 'text', text: '<system-reminder>\nSent while you were working.\n</system-reminder>' });
      return blocks;
    },
  };
}

export type MockQueue = ReturnType<typeof createMockQueue>;
