/**
 * A page of the hub's owner opened by a member from a link or an old
 * bookmark (docs/design/ACCOUNTS.md 10): Extensions, Shares and shared
 * projects. The member gets one plain sentence in place of the page, and
 * nothing asks the hub for what it would refuse.
 */
import type { ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useIsOwner } from '@/lib/people';
import { Page, PageHeader } from './ui/Page';
import { EmptyState } from './ui/EmptyState';

export function OwnerOnly({ title, line, children }: { title: string; line?: string; children: ReactNode }) {
  const owner = useIsOwner();
  const [, navigate] = useLocation();
  if (owner) return <>{children}</>;
  return (
    <Page width="column">
      <PageHeader title={title} />
      <EmptyState wave={false} action={{ label: 'Home', onClick: () => navigate('/') }}>
        {line ?? `${title} belong to the owner of this hub. Your own chats, memory and devices are on Home and in Settings.`}
      </EmptyState>
    </Page>
  );
}
