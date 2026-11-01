/**
 * Step 11, Done (spec 11.11): the pet's done hop beside an ambient wave band, then what is set up, one
 * row per step with its logos and a Change link back to it. Open Home writes
 * ui.onboarded and setup.completedAt.
 */
import type { ReactNode } from 'react';
import { useLocation } from 'wouter';
import { finishOnboarding } from '@/lib/onboarding';
import { useIsMobile } from '@/lib/hooks';
import { harnessLabel, modelName } from '@/lib/models';
import { providerInfo } from '@/lib/providers';
import { toast, useHub } from '@/store/store';
import { CompanyMark, HarnessMark, ModelMark } from '@/components/logo';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { TextAction } from '@/components/ui/Section';
import { Wave } from '@/components/wave';
import { Pet } from '@/components/motion';
import { StepFrame, useFlow } from '../StepLayout';
import { andList, errText, TAP } from '../parts';
import { loginPlans, useSetupFacts } from '../progress';
import { useImportJob } from '../importer';
import { useSubscriptions } from '@/lib/subscriptions';
import { SubMark } from '@/components/subscriptions/Subscriptions';
import type { StepId } from '../steps';

function Row({ label, marks, children, empty, step }: { label: string; marks?: ReactNode; children?: ReactNode; empty?: string; step: StepId }) {
  const flow = useFlow();
  const mobile = useIsMobile();
  const action = <TextAction className={TAP} label={children ? 'Change' : 'Set it up'} onClick={() => flow.go(step)} />;
  const value = <span className={children ? 'min-w-0 text-[14px] leading-[1.45] text-fg phone:text-[15px]' : 'text-[14px] text-fg-3 phone:text-[15px]'}>{children ?? empty}</span>;
  if (mobile)
    return (
      <div className="py-3">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-[13px] text-fg-3">{label}</span>
          {action}
        </div>
        <div className="mt-1.5 leading-[1.6]">
          {marks && <span className="mr-2.5 inline-flex items-center gap-2 align-[-6px] text-fg">{marks}</span>}
          {value}
        </div>
      </div>
    );
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)_auto] items-center gap-x-4 py-3">
      <span className="text-[13px] text-fg-3">{label}</span>
      <span className="flex min-w-0 items-center gap-3.5">
        {marks && <span className="flex shrink-0 items-center gap-2 text-fg">{marks}</span>}
        {value}
      </span>
      {action}
    </div>
  );
}

export function DoneStep() {
  const flow = useFlow();
  const f = useSetupFacts();
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const hub = useHub((s) => s.hub);
  const job = useImportJob();
  const subs = useSubscriptions().status;
  const subAccounts = subs?.accounts ?? [];
  const subNames = [...new Map(subAccounts.map((a) => [a.provider, a.providerName])).entries()];

  const open = async () => {
    try {
      await finishOnboarding();
    } catch (e) {
      toast({ title: `Could not save that setup is done. ${errText(e)}`, level: 'error' });
      return false;
    }
    navigate('/');
  };

  const providerNames = f.providers.map((id) => providerInfo(id)?.name ?? id);
  const plans = loginPlans(f.logins);
  const computers = f.devices;
  const harnessDevices = [...new Set(f.harnesses.flatMap((h) => h.devices))];

  return (
    <StepFrame summary={`Saved on ${hub?.name ?? 'the hub'}. Other devices see the same setup.`} onContinue={open} continueLabel="Open Home" continueBusy="Opening" hideContinue>
      {/* the pet hops once: setup is done (CHAT-AND-MOTION 1.11) */}
      <div className="-mt-2 mb-6 flex items-end gap-4">
        <Pet state="done" size={64} className="mb-1 text-fg" />
        <Wave variant="hero" gap={6} radius={1.2} amplitude={0.85} speed={0.8} className="h-[112px] min-w-0 flex-1 phone:h-20" />
      </div>

      <div className="rows border-y border-rule">
        <Row
          step="subscriptions"
          label="Subscriptions"
          empty="None signed in"
          marks={
            subNames.length ? (
              <>
                {subNames.slice(0, 5).map(([id, name]) => (
                  <SubMark key={id} id={id} name={name} />
                ))}
              </>
            ) : undefined
          }
        >
          {subAccounts.length ? `${andList(subNames.map(([, name]) => name))}, ${subAccounts.length === 1 ? 'one account' : `${subAccounts.length} accounts`}` : undefined}
        </Row>
        <Row
          step="providers"
          label="Providers"
          empty="No keys or logins yet"
          marks={
            f.providers.length || f.logins.length ? (
              <>
                {f.providers.slice(0, 5).map((id) => (
                  <CompanyMark key={id} provider={id} size={22} tone="brand" />
                ))}
                {f.logins.slice(0, Math.max(0, 5 - f.providers.length)).map((id) => (
                  <HarnessMark key={id} harness={id} size={22} />
                ))}
              </>
            ) : undefined
          }
        >
          {providerNames.length || plans.length ? andList([...providerNames, ...plans.map((p) => `${p} login`)]) : undefined}
        </Row>
        <Row
          step="agents"
          label="Coding agents"
          empty="None found"
          marks={
            f.harnesses.length ? (
              <>
                {f.harnesses.map((h) => (
                  <HarnessMark key={h.id} harness={h.id} size={22} />
                ))}
              </>
            ) : undefined
          }
        >
          {f.harnesses.length ? `${andList(f.harnesses.map((h) => harnessLabel(h.id) ?? h.id))} on ${andList(harnessDevices)}` : undefined}
        </Row>
        <Row step="defaults" label="Defaults" marks={f.defaultModel ? <ModelMark model={f.defaultModel} size={22} tone="brand" /> : undefined}>
          {f.defaultModel ? (
            <>
              {modelName(f.defaultModel)}
              <span className="text-fg-3">
                {f.smallModel && `, ${modelName(f.smallModel)} for small jobs`}
                {f.defaultAgent && `, agent ${f.defaultAgent}`}
              </span>
            </>
          ) : undefined}
        </Row>
        <Row step="memory" label="Memory">
          {!f.memoryOn ? (
            'Off'
          ) : (
            <>
              {f.vault ? 'Basic Memory vault' : 'Notes in the hub'}
              <span className="text-fg-3">{f.learning ? ', learning from sessions' : ', not learning from sessions'}</span>
            </>
          )}
        </Row>
        <Row step="import" label="Import" empty="Nothing imported">
          {job.running ? (
            <>
              Importing, <span className="num">{job.done}</span> of <span className="num">{job.total}</span>
            </>
          ) : f.imported ? (
            `${f.imported} past sessions, archived`
          ) : undefined}
        </Row>
        <Row step="devices" label="Devices" empty="Only the hub">
          {computers.length > 1 ? andList(computers.map((d) => d.name)) : undefined}
        </Row>
        <Row step="notifications" label="Notifications" empty="Inbox only">
          {f.channels.length ? andList(f.channels) : undefined}
        </Row>
        <Row step="routines" label="Routines" empty="None yet">
          {f.routineNames.length ? andList(f.routineNames) : undefined}
        </Row>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3 phone:flex-col phone:items-stretch">
        <Button variant="solid" size={mobile ? 'touch' : 'lg'} onClick={flow.runContinue}>
          Open Home
        </Button>
        <span className="text-[13px] text-fg-3 coarse:hidden">
          Press <Kbd>↵</Kbd> to open Home
        </span>
      </div>
    </StepFrame>
  );
}
