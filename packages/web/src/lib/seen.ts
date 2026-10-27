/**
 * Opening a conversation clears its bold title (core session/unread.ts): the
 * open chat or session tells the hub it was seen whenever it reads unread
 * while the page is on screen, so a reply that lands while the owner watches
 * never turns bold. The hub keeps seenAt, so the phone agrees.
 */
import { useEffect, useState } from 'react';
import { isUnread } from '@conclave/core/session/unread';
import { api } from './api';
import { upsertSession, useHub } from '@/store/store';

/** The conversation an address opens: /s/:id or /chat/:id. */
export function openedSessionId(loc: string): string | undefined {
  const m = /^\/(?:s|chat)\/([^/?#]+)/.exec(loc);
  return m?.[1];
}

function useOnScreen(): boolean {
  const [on, setOn] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setOn(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return on;
}

export function useMarkSeen(loc: string): void {
  const id = openedSessionId(loc);
  const unread = useHub((s) => (id && s.sessions[id] ? isUnread(s.sessions[id]) : false));
  const on = useOnScreen();
  useEffect(() => {
    if (!id || !unread || !on) return;
    // quiet on failure: the title stays bold and the next open tries again
    api()
      .markSeen(id)
      .then(upsertSession)
      .catch(() => {});
  }, [id, unread, on]);
}
