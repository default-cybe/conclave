/**
 * Step 3, Connect a model: sign in to a plan the owner already pays for
 * (Claude, ChatGPT, Google, Grok, Kimi, Muse), or paste one API key. Signing
 * in starts CLIProxyAPI on the hub the first time; every model from those
 * accounts then shows up under CLIProxyAPI in the model picker. "Use an
 * existing CLIProxyAPI" connects the one the owner runs elsewhere instead.
 * On Continue, a default or small model that cannot run is replaced: by a
 * model from a signed-in plan, or else from the first provider whose key
 * works (lib/providers.ts keyDefaults). Coding CLIs are found in the
 * background and wait on the "Set up later" Coding agents page. Skippable.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { subscriptionDefaults, useSubscriptions } from '@/lib/subscriptions';
import { keyDefaults, providerReady } from '@/lib/providers';
import { reloadModels, updateConfig, useHub } from '@/store/store';
import { SectionHeading } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { AccountRows, ExternalForm, SubscriptionRows, SubscriptionsStatusLine } from '@/components/subscriptions/Subscriptions';
import { StepFrame } from '../StepLayout';
import { Footnote, LINK } from '../parts';
import { ProviderKeys } from './ProviderKeys';

/** "One account signed in, 2 providers ready", or what is missing. */
function summaryOf(accounts: number, keys: number, rejected: number): ReactNode {
  const parts: ReactNode[] = [];
  if (accounts)
    parts.push(
      <span key="a">
        <span className="font-[560] text-ok">{accounts === 1 ? 'One account' : `${accounts} accounts`}</span> signed in
      </span>,
    );
  if (keys)
    parts.push(
      <span key="k">
        <span className="font-[560] text-ok">{keys === 1 ? 'One provider' : `${keys} providers`}</span> ready
      </span>,
    );
  if (rejected) parts.push(<span key="r">{rejected === 1 ? '1 key needs replacing' : `${rejected} keys need replacing`}</span>);
  return parts.length ? parts.flatMap((p, i) => (i ? [<span key={`c${i}`}>, </span>, p] : [p])) : 'No model connected yet.';
}

export function ModelStep() {
  const { status, set, error, reload } = useSubscriptions();
  const hub = useHub((s) => s.hub);
  const [external, setExternal] = useState(false);
  const [keys, setKeys] = useState<[number, number]>([0, 0]);
  const onReady = useCallback((ready: number, rejected: number) => setKeys([ready, rejected]), []);
  const keyRows = (
    <div className="mt-10">
      <ProviderKeys onReady={onReady} />
    </div>
  );

  // with no working default model, a model these accounts give, or else the first working key's, becomes the default
  const adopt = async () => {
    // a key saved a moment ago: its provider's models may not be listed yet
    await reloadModels();
    const { config, models } = useHub.getState();
    const ready = providerReady(models);
    const next = (status && subscriptionDefaults(status, config, ready)) ?? keyDefaults(models, config, ready);
    if (next) await updateConfig(next).catch(() => undefined);
  };

  // a hub from before subscription sign-in: say so instead of an error
  const older = !!hub?.features?.length && !hub.features.includes('subscriptions');
  if (!status)
    return (
      <StepFrame summary={older ? summaryOf(0, ...keys) : 'Loading.'} onContinue={adopt}>
        {older ? (
          <p className="m-0 max-w-[64ch] text-[14px] leading-[1.5] text-fg-2">This hub does not support subscription sign-in. Paste an API key below, or update the hub and run setup again from Settings, About.</p>
        ) : error ? (
          <p className="m-0 text-[14px] text-fault">{error}</p>
        ) : (
          <LoadingRows loading rows={6} />
        )}
        {(older || error) && keyRows}
      </StepFrame>
    );

  const n = status.accounts.length;
  const summary = <>{summaryOf(n, ...keys)}</>;
  const showForm = external || status.mode === 'external';

  return (
    <StepFrame summary={summary} onContinue={adopt}>
      {status.mode !== 'off' && (
        <div className="mb-8">
          <SubscriptionsStatusLine s={status} compact onRetry={() => void api().setSubscriptions({ mode: status.mode }).then(set, reload)} />
        </div>
      )}

      {!showForm && (
        <section>
          <SectionHeading rule={false} className="pb-1">
            Sign in to a plan
          </SectionHeading>
          <p className="m-0 pb-3 max-w-[64ch] text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Each opens the provider&apos;s sign-in page in a new tab. More than one account per plan is allowed.</p>
          <SubscriptionRows status={status} />
          <div className="pt-4 text-[13px] text-fg-3 phone:text-[14px]">
            <button type="button" className={LINK} onClick={() => setExternal(true)}>
              Use an existing CLIProxyAPI
            </button>
          </div>
        </section>
      )}

      {showForm && (
        <section>
          <SectionHeading rule={false} className="pb-1">
            Your CLIProxyAPI
          </SectionHeading>
          <p className="m-0 pb-4 max-w-[64ch] text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">The hub uses a CLIProxyAPI that runs on another computer. Nothing is installed here.</p>
          <div className="max-w-[560px]">
            <ExternalForm
              status={status}
              onSaved={set}
              onCancel={
                status.mode === 'external'
                  ? async () => {
                      set(await api().setSubscriptions({ mode: 'off' }));
                      setExternal(false);
                    }
                  : () => setExternal(false)
              }
            />
          </div>
          {status.mode === 'external' && status.state === 'on' && (
            <div className="mt-8">
              <SectionHeading rule={false} className="pb-3">
                Sign in
              </SectionHeading>
              <SubscriptionRows status={status} />
            </div>
          )}
        </section>
      )}

      {n > 0 && (
        <section className="mt-10">
          <SectionHeading count={n}>Signed in</SectionHeading>
          <AccountRows status={status} onChange={set} />
        </section>
      )}

      {keyRows}

      <div className="mt-10 grid gap-x-12 gap-y-6 md:grid-cols-2">
        <Footnote title="Where sign-ins and keys are stored">On {hub?.name ?? 'the hub'}, in files only the hub reads. Tokens and keys never reach this page or your sessions.</Footnote>
        <Footnote title="CLIProxyAPI">
          An open source (MIT) program that signs in to these plans. The hub downloads version {status.pinned.version} and checks its release checksum before it runs.
        </Footnote>
      </div>
    </StepFrame>
  );
}
