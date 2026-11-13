/**
 * Welcome (spec 11.11): the brand moment. Hero wave, the wordmark, one
 * paragraph on what Conclave is, then the first choice (branch.ts): set up
 * a hub, or connect to an existing hub as a client. A hub on this computer
 * was already chosen as the hub, so it gets no client choice. The four
 * steps (this is the first) run along the bottom as a procedure strip.
 */
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { MOCK, loadConnection } from '@/lib/api';
import { isOnboarded } from '@/lib/onboarding';
import { Radio } from '@/components/ui/Field';
import { IntroFrame } from '../connect/IntroFrame';
import { RestoreDialog } from '../settings/backup';
import { STEPS, stepDef, stepHref, stepNumber, type PageId, type StepId } from './steps';
import { useProgress } from './progress';
import { useContinueKeys } from './StepLayout';
import { branchChoices, branchTarget, hubIsHere, type SetupBranch } from './branch';

export function Welcome({ onStart, onSkip }: { onStart: (at: StepId) => void; onSkip: () => void }) {
  const hub = useHub((s) => s.hub);
  const progress = useProgress();
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const [restoring, setRestoring] = useState(false);
  const resume = progress.step && progress.step !== 'hub' && progress.done.length ? progress.step : undefined;
  const address = MOCK ? (hub?.publicUrl ?? location.origin) : (loadConnection()?.baseUrl ?? location.origin);
  const here = hubIsHere(address);
  // a setup already under way is the hub branch: no choice to make again
  const choices = resume ? (['hub'] as SetupBranch[]) : branchChoices(address);
  const [branch, setBranch] = useState<SetupBranch>('hub');
  const start = () => (branch === 'client' ? navigate(branchTarget('client')) : onStart(resume ?? 'hub'));
  useContinueKeys(start);

  return (
    <IntroFrame
      topRight={
        <>
          {hub?.version && (
            <span className="phone:hidden">
              Version <span className="font-mono text-[12.5px]">{hub.version}</span>
            </span>
          )}
          <button type="button" onClick={() => setRestoring(true)} className="underline decoration-rule-2 underline-offset-[3px] hover:text-fg phone:hidden">
            Restore from a backup
          </button>
          <button type="button" onClick={onSkip} className="underline decoration-rule-2 underline-offset-[3px] hover:text-fg phone:-my-3 phone:py-3">
            Skip setup
          </button>
        </>
      }
      bottom={<ProcedureStrip done={progress.done} />}
    >
      <p className="m-0 text-[17px] leading-[1.5] text-fg-2 phone:text-[16px]">
        Models, agents, routines and usage limits in one place. <span className="font-[560] text-fg">A hub</span> keeps your chats, keys and memory; your other devices connect to it.
      </p>
      {resume ? (
        <p className="m-0 mt-3 text-[13px] text-fg-3 phone:text-[14px]">Setup stopped at {stepDef(resume).name}. Your answers are saved on the hub.</p>
      ) : choices.length === 1 ? (
        <p className="m-0 mt-3 text-[13px] text-fg-3 phone:text-[14px]">This computer runs the hub. Setup is four short steps.</p>
      ) : (
        <fieldset className="m-0 mt-6 border-0 p-0">
          <legend className="mb-2 p-0 text-[13px] text-fg-3 phone:text-[14px]">How this device uses Conclave</legend>
          <Radio
            name="setup-branch"
            checked={branch === 'hub'}
            onChange={() => setBranch('hub')}
            label="Set up a hub"
            description={here || !hub?.name ? 'This computer runs Conclave for you and your devices.' : `${hub.name} runs Conclave for you and your devices.`}
            className="phone:py-2"
          />
          {choices.includes('client') && (
            <Radio
              name="setup-branch"
              checked={branch === 'client'}
              onChange={() => setBranch('client')}
              label="Connect to an existing hub"
              description="This device is a client. Use a pairing code, or an address and password."
              className="mt-2 phone:py-2"
            />
          )}
        </fieldset>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3 phone:flex-col phone:items-stretch">
        <Button variant="solid" size={mobile ? 'touch' : 'lg'} onClick={start}>
          {resume ? 'Continue setup' : branch === 'client' ? 'Connect' : 'Start setup'}
        </Button>
        <span className="ml-2 text-[13px] text-fg-3 coarse:hidden">
          Press <Kbd>↵</Kbd> to continue
        </span>
      </div>
      {mobile && (
        <button type="button" onClick={() => setRestoring(true)} className="mt-2 min-h-11 text-[14px] text-fg-3 underline decoration-rule-2 underline-offset-[3px]">
          Restore from a backup
        </button>
      )}
      <RestoreDialog
        open={restoring}
        onClose={() => setRestoring(false)}
        done={() => (isOnboarded(useHub.getState().config) ? { label: 'Open Home', run: () => navigate('/') } : { label: 'Continue setup', run: () => {} })}
      />
    </IntroFrame>
  );
}

function ProcedureStrip({ done }: { done: PageId[] }) {
  const mobile = useIsMobile();
  // Welcome is the step on screen
  const line = (s: (typeof STEPS)[number]) => (s.id === 'welcome' ? 'You are here' : done.includes(s.id) ? 'Done' : s.line);
  if (mobile)
    return (
      <nav aria-label="Setup steps" className="border-t border-rule px-4 pb-8">
        <ol className="m-0 list-none p-0">
          {STEPS.map((s) => (
            <li key={s.id} className="border-b border-rule last:border-b-0">
              <Link href={stepHref(s.id)} aria-current={s.id === 'welcome' ? 'step' : undefined} className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-baseline gap-x-1 py-3 text-[15px]">
                <span className="font-mono text-[11px] text-fg-3">{stepNumber(s.id as StepId)}</span>
                <span className="font-medium text-fg">{s.name}</span>
                <span className="text-[13px] text-fg-3">{line(s)}</span>
              </Link>
            </li>
          ))}
        </ol>
      </nav>
    );
  return (
    <nav aria-label="Setup steps" className="border-t border-rule">
      {/* the list's left padding plus each cell's own 12px puts the first column on the page gutter, and every column keeps the same width.
          The first cell reaches back over that padding so its rule and hover run to the window edge. */}
      <ol className="m-0 grid list-none grid-cols-4 py-0 pr-0 pl-7 md:max-lg:pl-3">
        {STEPS.map((s, i) => (
          <li key={s.id} className={cn('min-w-0 border-rule', i > 0 && 'border-l', i === 0 && '-ml-7 md:max-lg:-ml-3')}>
            <Link
              href={stepHref(s.id)}
              aria-current={s.id === 'welcome' ? 'step' : undefined}
              className={cn('block h-full py-3.5 pr-1 pb-[18px] transition-colors duration-[var(--dur-1)] hov:bg-hover', i === 0 ? 'pl-10 md:max-lg:pl-6' : 'pl-3')}
            >
              <span className="mb-[7px] block font-mono text-[11px] font-[450] text-fg-3">{stepNumber(s.id as StepId)}</span>
              <span className="block text-[13px] font-medium text-fg">{s.name}</span>
              <span className="mt-0.5 block text-[12px] leading-[1.35] text-fg-3">{line(s)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
