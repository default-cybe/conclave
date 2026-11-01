/**
 * What friends put in the Inbox (docs/design/FRIENDS.md 6): a request to
 * accept, a key change to confirm, notes not read yet (one row per friend
 * with the newest), and a share a friend sent, with Accept and Decline in
 * place. A row opens the friend, or the share; reading a friend's notes
 * takes them off the count on every device.
 */
import { Link } from 'wouter';
import { cn } from '@/lib/text';
import { relTime } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import type { FriendInboxItem } from '@/lib/friendInbox';
import { Section } from '@/components/ui/Section';
import { InboxShareRow, PhoneShareRow } from './ShareCards';
import { InboxProjectRow, PhoneProjectRow } from './ProjectCards';

/** A row on a phone: the friend's name, then one line. A share or a project invite has Decline and Accept at its right. */
export function PhoneFriendRow({ item }: { item: FriendInboxItem }) {
  if (item.share) return <PhoneShareRow s={item.share} />;
  if (item.project) return <PhoneProjectRow item={item} />;
  return (
    <Link href={item.href} className="flex min-h-[60px] items-center gap-3 px-5 py-2.5 active:bg-hover">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="block truncate text-[16px] leading-[1.35] text-fg">{item.name}</span>
        <span className={cn('mt-0.5 block truncate text-[14px] leading-[1.35]', item.kind === 'key' ? 'text-fault' : 'text-fg-2')}>{item.line}</span>
      </span>
      {item.kind === 'note' && (
        <span className="num shrink-0 text-[15px] font-medium text-warn">
          {item.count}
          <span className="sr-only"> new</span>
        </span>
      )}
    </Link>
  );
}

/** From friends, on a desktop: a row each, the time at the right. `inset`: under the wide list, whose titles sit past a checkbox gutter. */
export function FriendsInboxSection({ items, inset, className }: { items: FriendInboxItem[]; inset?: boolean; className?: string }) {
  const now = useNow(60_000);
  const count = items.reduce((n, i) => n + i.count, 0);
  return (
    <Section title="From friends" count={count || undefined} countTone="warn" className={className} id="inbox-friends">
      {items.map((it) =>
        it.share ? (
          <InboxShareRow key={it.id} s={it.share} inset={inset} />
        ) : it.project ? (
          <InboxProjectRow key={it.id} item={it} inset={inset} />
        ) : (
          <Link key={it.id} href={it.href} className={cn('group flex items-start gap-3 py-[10px] pr-3 transition-colors duration-[var(--dur-1)] hover:bg-hover', inset ? 'pl-9' : 'pl-3')}>
            <span className="min-w-0 flex-1">
              <span className="t-row block truncate text-fg">{it.name}</span>
              <span className={cn('mt-0.5 line-clamp-2 text-[12px] leading-[1.45]', it.kind === 'key' ? 'text-fault' : 'text-fg-2')}>{it.line}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-[12px] leading-[1.4]">
              <span className="num text-fg-3">{relTime(it.at, now)}</span>
              {it.kind === 'note' ? <span className="num text-warn">{it.count} new</span> : <span className="text-warn">{it.kind === 'request' ? 'Request' : 'New key'}</span>}
            </span>
          </Link>
        ),
      )}
    </Section>
  );
}
