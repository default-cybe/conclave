/**
 * Settings > Models > Subscriptions for a member (docs/design/ACCOUNTS.md 12):
 * their own plans, on a CLIProxyAPI the hub runs for them alone. The same
 * rows as the owner's page (components/subscriptions), without how the hub
 * reaches CLIProxyAPI and its version: those are the owner's. The first
 * sign-in starts it; signing out the last plan stops it and deletes it.
 */
import { api } from '@/lib/api';
import { useSubscriptions } from '@/lib/subscriptions';
import { LoadingRows } from '@/components/ui/EmptyState';
import { AccountRows, ModelGroups, SubscriptionRows, SubscriptionsStatusLine } from '@/components/subscriptions/Subscriptions';
import { Group } from './parts';

export function MemberSubscriptionsSection() {
  const { status, set, error, reload } = useSubscriptions();
  if (!status) return error ? <p className="m-0 text-[14px] text-fault">{error}</p> : <LoadingRows loading rows={4} />;
  const modelCount = status.models.reduce((n, g) => n + g.models.length, 0);
  return (
    <div className="space-y-9">
      {status.mode !== 'off' && <SubscriptionsStatusLine s={status} onRetry={() => void api().setSubscriptions({ mode: 'builtin' }).then(set, reload)} />}
      <Group title="Sign in" help="Your plans are yours: only your chats use them, and the owner sees only how many you have. Each one opens the provider's own sign-in page in a new tab.">
        <SubscriptionRows status={status} />
      </Group>
      <Group title="Your plans" count={status.accounts.length || undefined}>
        <AccountRows status={status} onChange={set} empty="No plan of yours is signed in." />
      </Group>
      {modelCount > 0 && (
        <Group title="Models" count={modelCount} help="They show in the model picker under CLIProxyAPI. Your calls use your own plans first.">
          <ModelGroups groups={status.models} />
        </Group>
      )}
    </div>
  );
}
