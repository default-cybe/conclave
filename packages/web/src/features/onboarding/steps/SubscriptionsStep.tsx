/**
 * Step 2, Subscriptions: sign in to the plans the owner already pays for
 * (Claude, ChatGPT, Google, Grok, Kimi, Muse). Signing in starts CLIProxyAPI
 * on the hub the first time; every model from those accounts then shows up
 * under CLIProxyAPI in the model picker. "I already run CLIProxyAPI" connects
 * the one the owner runs elsewhere instead. Skippable.
 */
import { useState } from 'react';
import { api } from '@/lib/api';
import { subscriptionDefaults, useSubscriptions } from '@/lib/subscriptions';
import { updateConfig, useHub } from '@/store/store';
import { SectionHeading } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { AccountRows, ExternalForm, SubscriptionRows, SubscriptionsStatusLine } from '@/components/subscriptions/Subscriptions';
import { StepFrame } from '../StepLayout';
import { Footnote, LINK } from '../parts';

export function SubscriptionsStep() {
  const { status, set, error, reload } = useSubscriptions();
  const hub = useHub((s) => s.hub);
  const [external, setExternal] = useState(false);

  // a hub from before subscription sign-in: say so instead of an error
  const older = !!hub?.features?.length && !hub.features.includes('subscriptions');
  if (!status)
    return (
      <StepFrame summary={older ? 'Not available on this hub.' : 'Loading.'}>
        {older ? (
          <p className="m-0 max-w-[64ch] text-[14px] leading-[1.5] text-fg-2">This hub is older than subscription sign-in. Update the hub, then run setup again from Settings, About. Skip this step for now.</p>
        ) : error ? (
          <p className="m-0 text-[14px] text-fault">{error}</p>
        ) : (
          <LoadingRows loading rows={6} />
        )}
      </StepFrame>
    );

  const n = status.accounts.length;
  const summary = n ? (
    <>
      <span className="font-[560] text-ok">{n === 1 ? 'One account' : `${n} accounts`}</span> signed in
    </>
  ) : (
    'Nothing signed in yet.'
  );
  const showForm = external || status.mode === 'external';

  // with no key for the default model, the next step starts from a model these accounts give
  const adopt = async () => {
    const { config, models } = useHub.getState();
    const next = subscriptionDefaults(status, config, (p) => !!models.find((g) => g.provider === p && g.configured && g.enabled && !g.error));
    if (next) await updateConfig(next).catch(() => undefined);
  };

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
            Sign in
          </SectionHeading>
          <p className="m-0 pb-3 max-w-[64ch] text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Each one opens the provider&apos;s own sign-in page in a new tab. You can sign in to more than one account of the same plan.</p>
          <SubscriptionRows status={status} />
          <div className="pt-4 text-[13px] text-fg-3 phone:text-[14px]">
            <button type="button" className={LINK} onClick={() => setExternal(true)}>
              I already run CLIProxyAPI
            </button>
          </div>
        </section>
      )}

      {showForm && (
        <section>
          <SectionHeading rule={false} className="pb-1">
            Your CLIProxyAPI
          </SectionHeading>
          <p className="m-0 pb-4 max-w-[64ch] text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">The hub uses the one you run on another computer. Nothing is installed here.</p>
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

      <div className="mt-10 grid gap-x-12 gap-y-6 md:grid-cols-2">
        <Footnote title="Where sign-ins live">On {hub?.name ?? 'the hub'}, in CLIProxyAPI&apos;s own folder that only the hub reads. Keys and tokens never reach this page or your sessions.</Footnote>
        <Footnote title="CLIProxyAPI">
          A separate open source project (MIT) that the hub downloads, version {status.pinned.version}, and checks against its release checksums before it runs.
        </Footnote>
      </div>
    </StepFrame>
  );
}
