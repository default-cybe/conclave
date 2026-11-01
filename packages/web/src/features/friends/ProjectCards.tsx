/**
 * Shared projects in the Inbox: an invite with Accept and Decline in place
 * ("Alice invited you to 'Site'"), and a project with items from members not
 * read yet, which opens it. A phone row and a desktop row, like share cards.
 */
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { SharedProjectDto } from '@conclave/core/client';
import { cn } from '@/lib/text';
import { relTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { projectHref } from '@/lib/sharedProjects';
import type { FriendInboxItem } from '@/lib/friendInbox';
import { Button } from '@/components/ui/Button';
import { Swap } from '@/components/motion';
import { acceptProject, declineProject } from './projectActions';

/** Accept and Decline with their busy words; Accept opens the project. */
export function useProjectAnswer(p: SharedProjectDto) {
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [, navigate] = useLocation();
  const run = async (what: 'accept' | 'decline') => {
    setBusy(what);
    if (what === 'accept') {
      if (await acceptProject(p)) navigate(projectHref(p.id));
    } else await declineProject(p);
    setBusy(null);
  };
  return { busy, run };
}

const repoWords = (p: SharedProjectDto) => (p.repo ? `On GitHub: ${p.repo}. ` : '');

/** On a phone: the line, then Decline and Accept at the right, where an approval's Deny and Allow sit. */
export function PhoneProjectRow({ item }: { item: FriendInboxItem }) {
  const p = item.project!;
  const { busy, run } = useProjectAnswer(p);
  if (p.state !== 'invited')
    return (
      <Link href={item.href} className="flex min-h-[60px] items-center gap-3 px-5 py-2.5 active:bg-hover">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="block truncate text-[16px] leading-[1.35] text-fg">{p.name}</span>
          <span className="mt-0.5 block truncate text-[14px] leading-[1.35] text-fg-2">{item.line}</span>
        </span>
        <span className="num shrink-0 text-[15px] font-medium text-warn">
          {item.count}
          <span className="sr-only"> new</span>
        </span>
      </Link>
    );
  return (
    <div className="pt-2.5 pb-1 active:bg-hover">
      <Link href={item.href} className="flex min-h-11 min-w-0 flex-col px-5">
        <span className="line-clamp-2 text-[16px] leading-[1.35] text-fg">
          {p.owner.name} invited you to '{p.name}'
        </span>
        <span className="mt-0.5 block text-[14px] leading-[1.35] text-fg-2">{repoWords(p)}A shared project. Nothing of it comes before you accept.</span>
      </Link>
      <div className="flex items-center justify-end gap-1 pr-2.5">
        <button type="button" disabled={!!busy} onClick={() => void run('decline')} className="h-11 shrink-0 rounded-full px-2.5 text-[15px] text-fg-2 active:bg-hover disabled:text-fg-3">
          <Swap on={busy === 'decline'} off="Decline">
            Declining
          </Swap>
        </button>
        <button type="button" disabled={!!busy} onClick={() => void run('accept')} className="h-11 shrink-0 rounded-full px-2.5 text-[15px] font-semibold text-fg active:bg-hover disabled:text-fg-3">
          <Swap on={busy === 'accept'} off="Accept">
            Joining
          </Swap>
        </button>
      </div>
    </div>
  );
}

/** In the desktop Inbox's From friends: the line, the time, and Accept and Decline for an invite. */
export function InboxProjectRow({ item, inset }: { item: FriendInboxItem; inset?: boolean }) {
  const p = item.project!;
  const now = useNow(60_000);
  const { busy, run } = useProjectAnswer(p);
  return (
    <div className={cn('flex items-start gap-3 py-[10px] pr-3', inset ? 'pl-9' : 'pl-3')}>
      <div className="min-w-0 flex-1">
        <Link href={item.href} className="t-row block text-fg underline decoration-transparent underline-offset-[3px] hover:decoration-rule-2">
          {p.state === 'invited' ? `${p.owner.name} invited you to '${p.name}'` : p.name}
        </Link>
        <p className="m-0 mt-0.5 text-[12px] leading-[1.45] text-fg-2">{p.state === 'invited' ? `${repoWords(p)}A shared project. Nothing of it comes before you accept.` : item.line}</p>
        {p.state === 'invited' && (
          <div className="mt-1.5 -ml-2 flex gap-1">
            <Button variant="quiet" size="sm" disabled={!!busy} busy={busy === 'decline' ? 'Declining' : false} onClick={() => void run('decline')}>
              Decline
            </Button>
            <Button variant="solid" size="sm" disabled={!!busy} busy={busy === 'accept' ? 'Joining' : false} onClick={() => void run('accept')}>
              Accept
            </Button>
          </div>
        )}
      </div>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-[12px] leading-[1.4]">
        <span className="num text-fg-3">{relTime(item.at, now)}</span>
        <span className="text-warn">{p.state === 'invited' ? 'Project invite' : `${item.count} new`}</span>
      </span>
    </div>
  );
}
