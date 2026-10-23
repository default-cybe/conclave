/**
 * Settings > Models > Subscriptions: CLIProxyAPI on the hub, or the one the
 * owner already runs. The status in words, how the hub reaches it (run it
 * here, use yours, off), the sign-in rows, the signed in accounts, the
 * models per account, and the version with Update. The same rows as setup
 * step 2 (components/subscriptions).
 */
import { useEffect, useState } from 'react';
import type { SubscriptionsMode, SubscriptionsStatus } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { useSubscriptions } from '@/lib/subscriptions';
import { toast, useHub } from '@/store/store';
import { LiveStatus } from '@/components/motion';
import { TextAction } from '@/components/ui/Section';
import { Button } from '@/components/ui/Button';
import { Radio } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { LoadingRows } from '@/components/ui/EmptyState';
import { AccountRows, ExternalForm, ModelGroups, SubscriptionRows, SubscriptionsStatusLine } from '@/components/subscriptions/Subscriptions';
import { errText, Group, SettingRow } from './parts';

const MODE_LABEL: Record<SubscriptionsMode, string> = {
  builtin: 'Run it on the hub',
  external: 'I already run CLIProxyAPI',
  off: 'Off',
};

function modeHelp(s: SubscriptionsStatus): Record<SubscriptionsMode, string> {
  return {
    builtin: `The hub downloads CLIProxyAPI ${s.pinned.version}, runs it on 127.0.0.1 and keeps it running. Sign-ins stay on the hub.`,
    external: 'Use the one you run on another computer. The hub needs its address and a client key; its management key adds sign-in from here.',
    off: 'Nothing runs. Models from subscriptions are not in the picker. Accounts already signed in stay in CLIProxyAPI for next time.',
  };
}

export function SubscriptionsSection() {
  const { status, set, error, reload } = useSubscriptions();
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [choice, setChoice] = useState<SubscriptionsMode | undefined>(status?.mode);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  useEffect(() => {
    if (status) setChoice((c) => c ?? status.mode);
  }, [status]);

  if (!status) return error ? <p className="m-0 text-[14px] text-fault">{error}</p> : <LoadingRows loading rows={6} />;

  const pick = async (mode: SubscriptionsMode) => {
    setChoice(mode);
    // external saves from its form; the others switch at once
    if (mode === 'external' || mode === status.mode) return;
    if (mode === 'off' && status.mode !== 'off') {
      setConfirmOff(true);
      return;
    }
    await apply(mode);
  };
  const apply = async (mode: SubscriptionsMode) => {
    setBusy(mode);
    try {
      set(await api().setSubscriptions({ mode }));
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
      setChoice(status.mode);
    }
    setBusy(null);
  };
  const update = async () => {
    setBusy('update');
    try {
      set(await api().updateSubscriptions());
      toast({ title: 'CLIProxyAPI is up to date.' });
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
      reload();
    }
    setBusy(null);
  };

  // Refresh models: CLIProxyAPI's list and each account's own, and each coding agent that is on (core engine.refreshModels)
  const refreshModels = async () => {
    setBusy('models');
    try {
      const { groups, failed } = await api().refreshModels();
      useHub.setState({ models: groups });
      reload();
      const count = groups.find((g) => g.provider === status.provider)?.models.length ?? 0;
      toast(failed.length ? { title: `Read again. Could not ask ${failed.map((f) => f.split(':')[0]).join(', ')}.`, level: 'warning' } : { title: `Read again. ${count} ${count === 1 ? 'model' : 'models'} from your accounts.` });
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
    }
    setBusy(null);
  };

  const help = modeHelp(status);
  const modelCount = status.models.reduce((n, g) => n + g.models.length, 0);

  return (
    <div className="space-y-9">
      <SubscriptionsStatusLine s={status} onRetry={() => void apply(status.mode)} />

      <Group title="How the hub reaches it" className="[&_.rows]:pt-1.5">
        <div className="space-y-2.5 py-3">
          {(['builtin', 'external', 'off'] as const).map((m) => (
            <Radio key={m} name="subscriptions-mode" checked={choice === m} onChange={() => void pick(m)} label={MODE_LABEL[m]} description={busy === m ? 'Switching' : help[m]}>
              {m === 'external' && (
                <div className="max-w-[460px] pb-2">
                  <ExternalForm status={status} onSaved={set} />
                </div>
              )}
            </Radio>
          ))}
        </div>
      </Group>

      {status.mode !== 'off' && (
        <Group title="Sign in" help="Each one opens the provider's own sign-in page in a new tab. Sign in to as many accounts as you like.">
          <SubscriptionRows status={status} />
        </Group>
      )}

      {status.mode === 'off' && (
        <Group title="Sign in" help="Pick Run it on the hub to sign in. These are the subscriptions it signs in to.">
          <SubscriptionRows status={status} />
        </Group>
      )}

      <Group title="Accounts" count={status.accounts.length || undefined}>
        <AccountRows status={status} onChange={set} empty={status.management || status.mode === 'off' ? 'No account is signed in.' : (status.managementNote ?? 'Accounts show here once sign-in is available.')} />
      </Group>

      <Group
        title="Models"
        count={modelCount || undefined}
        right={busy === 'models' ? <LiveStatus state="tool" label="Asking the accounts" /> : <TextAction label="Refresh models" onClick={() => void refreshModels()} />}
        help="They show in the model picker under CLIProxyAPI. Each account is asked for its own list, so new models show without an update. Claude models use the Anthropic wire; the rest use Chat Completions."
      >
        <ModelGroups groups={status.models} />
      </Group>

      <Group title="CLIProxyAPI">
        <SettingRow label="Version" help={status.update ? `Version ${status.update.version} is ready to install. The hub goes back to this one if it does not start.` : status.mode === 'builtin' ? 'The version this hub pins.' : 'The version that answers.'}>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[13px] text-fg">{status.version ?? 'none'}</span>
            {status.update && (
              <Button variant="outline" size={size} busy={busy === 'update' ? 'Updating' : false} onClick={() => void update()}>
                Update to {status.update.version}
              </Button>
            )}
          </div>
        </SettingRow>
        {status.binary && (
          <SettingRow label="Program" help={status.binary.managed ? (status.binary.verified ? 'Its SHA-256 matched the release checksums and the pin in Conclave.' : 'Downloaded, but its checksum was not confirmed.') : 'Your own copy (models.cliproxy.binary).'}>
            <span className="block truncate font-mono text-[12.5px] text-fg-2" title={status.binary.path}>
              {status.binary.path}
            </span>
          </SettingRow>
        )}
        <SettingRow label="Where it comes from" help={`A separate open source project under the MIT license. The hub downloads release ${status.pinned.version} from GitHub.`}>
          <a href={`https://${status.pinned.repo}`} target="_blank" rel="noreferrer" className="font-mono text-[12.5px] text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
            {status.pinned.repo}
          </a>
        </SettingRow>
      </Group>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => {
          setConfirmOff(false);
          setChoice(status.mode);
        }}
        onConfirm={async () => {
          await apply('off');
          setConfirmOff(false);
        }}
        title="Turn subscriptions off?"
        body={status.mode === 'builtin' ? 'CLIProxyAPI stops on the hub and its models leave the picker. The accounts stay signed in for when you turn it on again.' : 'The hub stops using your CLIProxyAPI. It keeps running for your other tools.'}
        confirm="Turn off"
        busy="Turning off"
      />
    </div>
  );
}
