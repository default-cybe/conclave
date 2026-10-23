/**
 * A conversation in a list: where it opens and the quiet state its row
 * shows. The sidebar and the phone's drawer list them with lib/sidebar.ts;
 * the Inbox, shares and the phone's Chats and Code lists use these too.
 */
import type { Session } from '@conclave/core/types';

/** running: a small dot that breathes. waiting: an approval or a question waits on the owner. */
export type LiveState = 'running' | 'waiting';

/** The state a list row shows: waiting wins over running, since it needs the owner. */
export function liveState(s: Session, waiting: ReadonlySet<string>): LiveState | undefined {
  if (waiting.has(s.id) || s.status === 'waiting_approval' || s.status === 'waiting_input') return 'waiting';
  if (s.status === 'running') return 'running';
  return undefined;
}

/** Where a session opens. */
export function hrefOf(s: Pick<Session, 'id' | 'kind'>): string {
  return s.kind === 'chat' ? `/chat/${s.id}` : `/s/${s.id}`;
}
