/**
 * What the Meetings row in the sidebar and the phone drawer shows at its
 * right edge (docs/design/MEETING-MODE.md 11.1): a live meeting, else one due
 * within the hour. One fetch and one event listener for every row mounted.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useNow } from '@/lib/hooks';
import { onHubEvent } from '@/store/store';
import type { Meeting } from '@/overlay/wire';
import { meetings } from './api';
import { sideCountdown, sideHint } from './time';

let list: Meeting[] = [];
let users = 0;
let off: (() => void) | undefined;
const subs = new Set<() => void>();
const ping = () => subs.forEach((f) => f());

function start() {
  void meetings()
    .list()
    .then(
      (l) => {
        list = l;
        ping();
      },
      () => undefined,
    );
  off = onHubEvent((e) => {
    if (e.type === 'meeting.updated') {
      const m = (e as unknown as { meeting: Meeting }).meeting;
      list = [m, ...list.filter((x) => x.id !== m.id)];
      ping();
    } else if (e.type === 'session.deleted') {
      // deleting a meeting deletes its session; there is no meeting.deleted event
      list = list.filter((x) => x.sessionId !== e.sessionId);
      ping();
    }
  });
}

/** { live } while one listens, { next, text: "in 42m" } when one is due within 60 minutes, else {}. */
export function useMeetingHint(): { live?: Meeting; next?: Meeting; text?: string } {
  useEffect(() => {
    if (users++ === 0) start();
    return () => {
      if (--users === 0) {
        off?.();
        off = undefined;
      }
    };
  }, []);
  const l = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => list,
  );
  const now = useNow(60_000);
  const h = sideHint(l, now);
  return h.next ? { next: h.next, text: sideCountdown(h.next.scheduledAt!, now) } : h;
}
