/**
 * Delegated work in a session's own view (docs/DESIGN.md 43). A Delegate
 * call's session opens as a normal session; while it is in Delegated work,
 * the header says where it came from and offers Move to main list (on a
 * phone, a line under the bar). Moved, it is a normal session of its kind,
 * and the header keeps "from Capstone chat" as history.
 *
 * Move to main list is the same call from the sidebar's row menu, the
 * session's ... menu, the header and the phone's sheet; the hub's
 * session.updated moves the row from Delegated work into the list. A chat's
 * reply draws its Delegate calls with a link to the session
 * (DelegateCallLine).
 */
import { Link } from 'wouter';
import type { Session, ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { isDelegated, movedToMain } from '@conclave/core/session/delegated';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { hrefOf } from '@/lib/recents';
import { delegateWho, fromWords } from '@/lib/sidebar';
import { attempt, upsertSession, useHub, type ToolRun } from '@/store/store';
import { TextAction } from '@/components/ui/Section';
import { AgentGlyph, glyphState, useLiveSlot } from '@/components/motion';
import { useSubagent } from './ToolRows';
import { subagentLead } from './liveTasks';

/** The words of the action, the same on every surface and on Android. */
export const MOVE_TO_MAIN = 'Move to main list';

export async function moveToMainList(id: string): Promise<Session | undefined> {
  const s = await attempt(() => api().moveToMainList(id), 'Moved to the main list.');
  if (s) upsertSession(s);
  return s;
}

/** The conversation a delegated (or moved) session came from, and "from Capstone chat". Undefined for any other session. */
export function useDelegatedFrom(session: Session): { parent?: Session; words?: string } | undefined {
  const parent = useHub((s) => (session.parentId ? s.sessions[session.parentId] : undefined));
  if (!isDelegated(session) && !movedToMain(session)) return undefined;
  return { parent, words: fromWords(parent) };
}

/** "from Capstone chat" as a link to it, for the header's meta line. */
export function FromLink({ parent, words, className }: { parent?: Session; words?: string; className?: string }) {
  if (!parent || !words) return null;
  return (
    <Link href={hrefOf(parent)} className={cn('link', className)}>
      {words}
    </Link>
  );
}

/** The phone's line under the bar while the session is in Delegated work: who did it, where it came from, and Move to main list. */
export function DelegatedLine({ session, className }: { session: Session; className?: string }) {
  const from = useDelegatedFrom(session);
  const devices = useHub((s) => s.devices);
  if (!from || !isDelegated(session)) return null;
  return (
    <div data-delegated-line="" className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]', className)}>
      <span className="min-w-0">
        Delegated work, {delegateWho(session, { devices })}
        {from.parent && from.words && (
          <>
            , <FromLink parent={from.parent} words={from.words} />
          </>
        )}
        .
      </span>
      <TextAction label={MOVE_TO_MAIN} onClick={() => void moveToMainList(session.id)} />
    </div>
  );
}

/**
 * A Delegate call in a chat's reply (the Chat page draws calls as quiet
 * lines): "Code on MadX Arch: Find names in the capstone PDFs" and a link to
 * its session, while it works and after, moved to the main list or not.
 */
export function DelegateCallLine({ tool, result, run, sessionId }: { tool: ToolUseBlock; result?: ToolResultBlock; run?: ToolRun; sessionId: string }) {
  const sub = useSubagent({ tool, result, run }, sessionId);
  const lead = subagentLead(sub);
  const state = glyphState(sub.state);
  // only LIVE_ROWS running lines move at once; the rest draw their still frame
  const still = useLiveSlot(state === 'running');
  return (
    <div data-delegate-line="" className="flex min-h-[25px] min-w-0 items-center gap-3 py-0.5 tx-12.5 text-fg-3 phone:tx-13.5">
      <span className={cn('cv-state flex min-w-0 items-center gap-1.5', sub.state === 'failed' && 'text-fault')}>
        <AgentGlyph type="delegate" state={state} still={still} />
        <span className="min-w-0 truncate">
        {lead.verb} {sub.description}
        {sub.state === 'running' ? ', working' : sub.state === 'failed' ? ', failed' : ''}
        </span>
      </span>
      {sub.childId && (
        <Link href={`/s/${sub.childId}`} className="link shrink-0">
          Open session
        </Link>
      )}
    </div>
  );
}
