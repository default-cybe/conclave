/**
 * Send to friend (docs/design/FRIENDS.md, phase 2): pick friends, review
 * what goes, send, then the sent state (SendDialog.tsx, loaded when it
 * first opens, so the conversation screens stay light).
 *
 * It opens from the conversation's sheet on a phone (SendToFriendAction,
 * after Rename) and from the session and chat menus on a desktop
 * (SendToFriendDialog). On a phone the dialog is a sheet from the bottom.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import type { SentShareDto } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';

const SendDialog = lazy(() => import('./SendDialog'));

/** A session can go to a friend: not a subagent (it goes with its parent) and not a friend's reference. */
export function canSend(s: Session): boolean {
  return !s.parentId && (s.meta?.friendShare as { role?: string } | undefined)?.role !== 'reference';
}

/**
 * The row in a conversation's sheet on a phone, after Rename. The sheet
 * closes and opens SendToFriendDialog, which it keeps outside itself.
 */
export function SendToFriendAction({ session, onOpen }: { session: Session; onOpen: () => void }) {
  if (!canSend(session)) return null;
  return (
    <button type="button" onClick={onOpen} className="flex min-h-12 w-full items-center rounded-[10px] px-2 text-left text-[16px] text-fg active:bg-hover">
      Send to friend
    </button>
  );
}

/** What the dialog needs of the session it sends. */
export type ShareSource = Pick<Session, 'id' | 'title' | 'kind'>;

/** The session a sent share came from, or enough of it for Update when the store does not hold it. */
export function sourceOf(share: SentShareDto, sessions: Record<string, Session>): ShareSource {
  return sessions[share.sessionId] ?? { id: share.sessionId, title: share.title, kind: share.kind === 'chat' ? 'chat' : 'agent' };
}

export interface SendDialogProps {
  session: ShareSource;
  open: boolean;
  onClose: () => void;
  /** A share sent before: the review starts from its choices, and Send is a new revision. */
  update?: SentShareDto;
}

/** Pick friends, review, send; with `update`, a new revision. Loaded the first time it opens. */
export function SendToFriendDialog(props: SendDialogProps) {
  const [wanted, setWanted] = useState(props.open);
  useEffect(() => {
    if (props.open) setWanted(true);
  }, [props.open]);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <SendDialog {...props} />
    </Suspense>
  );
}
