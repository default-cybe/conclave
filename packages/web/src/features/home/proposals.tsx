/**
 * Proposal cards (docs/DESIGN.md, Calendar and mail): a calendar change or a
 * message the assistant proposed, waiting for the owner. The card shows
 * exactly what the hub will write: for an event the title, the day and time,
 * the calendar and the attendees; for a message the account, to, subject
 * and body. Approve writes it once; Decline tells the assistant no.
 *
 * Like the approval card it is the one filled card on its page. On a phone
 * (docs/design/MOBILE-V2.md 5) the buttons stack at full width.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import type { ProposalDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast } from '@/store/store';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { approveWords, eventWhen, inviteWords, outcomeWords, proposalQuestion } from './proposalWords';

export function ProposalCard({ p, zone, phone, onDone }: { p: ProposalDto; zone?: string; phone?: boolean; onDone?: (p: ProposalDto) => void }) {
  const [busy, setBusy] = useState<'approve' | 'decline'>();
  const [done, setDone] = useState<ProposalDto>();
  const cur = done ?? p;
  const decide = async (what: 'approve' | 'decline') => {
    setBusy(what);
    try {
      const next = what === 'approve' ? await api().approveProposal(p.id) : await api().declineProposal(p.id);
      setDone(next);
      if (next.status === 'failed') toast({ title: outcomeWords(next), level: 'error' });
      onDone?.(next);
    } catch (e) {
      toast({ title: `Could not ${what} it. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };
  const e = cur.event;
  const m = cur.mail;
  const invites = inviteWords(cur);
  const size = phone ? 'touch' : 'sm';
  const settled = cur.status !== 'pending';
  return (
    <div id={`proposal-${p.id}`} aria-label={`Proposal: ${cur.summary}`} className={cn('relative overflow-hidden rounded-[var(--r-2)] border border-rule-2 bg-raise px-4 pt-3.5 pb-4 anim-rise', phone && 'rounded-[18px] p-4')}>
      <p className="m-0 text-[12px] font-medium text-fg-3 phone:text-[13px]">{proposalQuestion(cur)}</p>
      {e && (
        <div className="mt-1.5">
          <p className={cn('m-0 text-[15px] leading-[1.35] font-medium text-fg phone:text-[17px]', cur.action === 'delete' && 'line-through decoration-fg-3')}>{e.title}</p>
          <p className="m-0 mt-0.5 text-[13px] text-fg-2 phone:text-[15px]">
            <span className="num">{eventWhen(e, zone)}</span>
          </p>
          {cur.before && cur.action === 'update' && (
            <p className="m-0 mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">
              Was <span className="num">{eventWhen(cur.before, zone)}</span>
              {cur.before.title !== e.title ? `, ${cur.before.title}` : ''}
            </p>
          )}
          <p className="m-0 mt-1 text-[12px] text-fg-3 phone:text-[13px]">
            {e.calendar}, {e.account}
            {e.location ? `. ${e.location}` : ''}
            {e.project ? `. Booked on ${e.project}` : ''}
          </p>
          {e.description && <p className="m-0 mt-1 line-clamp-2 text-[12px] text-fg-3 phone:text-[13px]">{e.description}</p>}
          {invites && <p className="m-0 mt-1 text-[12px] text-fg-2 phone:text-[13px]">{invites}</p>}
        </div>
      )}
      {m && (
        <div className="mt-1.5 space-y-1">
          <p className="m-0 text-[13px] text-fg-2 phone:text-[15px]">
            <span className="text-fg-3">To </span>
            {m.to.join(', ')}
            {m.cc.length ? <span className="text-fg-3">, cc {m.cc.join(', ')}</span> : null}
          </p>
          <p className="m-0 text-[15px] leading-[1.35] font-medium text-fg phone:text-[17px]">{m.subject}</p>
          <p className="m-0 max-h-[12em] overflow-y-auto rounded-[12px] bg-surface-2 px-3.5 py-3 text-[13.5px] leading-[1.5] whitespace-pre-wrap text-fg phone:text-[15px]">{m.body}</p>
          <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">From {m.from}</p>
        </div>
      )}
      {settled ? (
        <p className={cn('m-0 mt-3 text-[13px] font-medium phone:text-[15px]', cur.status === 'applied' ? 'text-ok' : cur.status === 'failed' ? 'text-fault' : 'text-fg-3')}>{outcomeWords(cur)}</p>
      ) : (
        <div className={cn('mt-3 flex gap-2', phone ? 'flex-col' : 'flex-wrap items-center')}>
          <Button variant="solid" size={size} full={phone} disabled={!!busy} busy={busy === 'approve' ? 'Writing' : false} onClick={() => void decide('approve')} className={phone ? 'h-12! rounded-[12px]! text-[16px]!' : undefined}>
            {approveWords(cur)}
          </Button>
          <Button variant="outline" size={size} full={phone} disabled={!!busy} busy={busy === 'decline' ? 'Declining' : false} onClick={() => void decide('decline')} className={phone ? 'h-12! rounded-[12px]! text-[16px]!' : undefined}>
            Decline
          </Button>
          {cur.sessionId && !phone && (
            <Link href={`/s/${cur.sessionId}`} className="ml-auto text-[12px] text-fg-3 underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
              Open the chat
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
