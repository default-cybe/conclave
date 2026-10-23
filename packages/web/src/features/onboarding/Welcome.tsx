/**
 * Welcome (spec 11.11): the brand moment. Hero wave, the wordmark, one
 * paragraph on what Conclave is, Start setup, and the eleven steps as a
 * procedure strip along the bottom.
 */
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { isOnboarded } from '@/lib/onboarding';
import { IntroFrame } from '../connect/IntroFrame';
import { RestoreDialog } from '../settings/backup';
import { STEPS, stepDef, stepNumber, type StepId } from './steps';
import { useProgress } from './progress';
import { useContinueKeys } from './StepLayout';

export function Welcome({ onStart, onSkip }: { onStart: (at: StepId) => void; onSkip: () => void }) {
  const hub = useHub((s) => s.hub);
  const progress = useProgress();
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const [restoring, setRestoring] = useState(false);
  const resume = progress.step && progress.step !== 'hub' && progress.done.length ? progress.step : undefined;
  const start = () => onStart(resume ?? 'hub');
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
        Your models, agents, routines and usage limits in one place, served from <span className="font-[560] text-fg">a hub you run</span>. Setup takes about five minutes and every choice can be changed later.
      </p>
      {resume && <p className="m-0 mt-3 text-[13px] text-fg-3 phone:text-[14px]">You stopped at {stepDef(resume).name}. Your answers so far are saved on the hub.</p>}
      <div className="mt-6 flex flex-wrap items-center gap-3 phone:flex-col phone:items-stretch">
        <Button variant="solid" size={mobile ? 'touch' : 'lg'} onClick={start}>
          {resume ? 'Continue setup' : 'Start setup'}
        </Button>
        <Button variant="outline" size={mobile ? 'touch' : 'lg'} onClick={() => navigate('/connect')}>
          I have a pairing code
        </Button>
        <span className="ml-2 text-[13px] text-fg-3 coarse:hidden">
          Press <Kbd>↵</Kbd> to start
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

/** Cells in the first row of the two row strip; the second row starts under the first cell. */
const ROW = Math.ceil(STEPS.length / 2);

function ProcedureStrip({ done }: { done: StepId[] }) {
  const mobile = useIsMobile();
  const [all, setAll] = useState(false);
  if (mobile) {
    const shown = all ? STEPS : STEPS.slice(0, 5);
    return (
      <nav aria-label="Setup steps" className="border-t border-rule px-4 pb-8">
        <ol className="m-0 list-none p-0">
          {shown.map((s) => (
            <li key={s.id} className="border-b border-rule last:border-b-0">
              <Link href={`/setup/${s.id}`} className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-baseline gap-x-1 py-3 text-[15px]">
                <span className="font-mono text-[11px] text-fg-3">{stepNumber(s.id)}</span>
                <span className="font-medium text-fg">{s.name}</span>
                <span className="text-[13px] text-fg-3">{done.includes(s.id) ? 'done' : s.line}</span>
              </Link>
            </li>
          ))}
        </ol>
        {!all && (
          <button type="button" onClick={() => setAll(true)} className="mt-1 min-h-11 py-2 text-[14px] text-fg-3 underline decoration-rule-2 underline-offset-[3px]">
            and {STEPS.length - 5} more
          </button>
        )}
      </nav>
    );
  }
  return (
    <nav aria-label="Setup steps" className="border-t border-rule">
      {/* the list's left padding plus each cell's own 12px puts the first column on the page gutter, and every column keeps the same width.
          The first cell of a row reaches back over that padding so its rule and hover run to the window edge. */}
      <ol className="m-0 grid list-none grid-cols-6 py-0 pr-0 pl-7 md:max-lg:pl-3 xl:grid-cols-11">
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            className={cn(
              'min-w-0 border-rule',
              i % ROW !== 0 && 'border-l',
              'xl:border-l xl:first:border-l-0',
              i >= ROW && 'border-t xl:border-t-0',
              (i === 0 || i === ROW) && '-ml-7 md:max-lg:-ml-3',
              i === ROW && 'xl:ml-0',
            )}
          >
            <Link
              href={`/setup/${s.id}`}
              className={cn('block h-full py-3.5 pr-1 pb-[18px] transition-colors duration-[var(--dur-1)] hov:bg-hover', i === 0 || i === ROW ? 'pl-10 md:max-lg:pl-6' : 'pl-3', i === ROW && 'xl:pl-3')}
            >
              <span className="mb-[7px] block font-mono text-[11px] font-[450] text-fg-3">{stepNumber(s.id)}</span>
              <span className="block text-[13px] font-medium text-fg">{s.name}</span>
              <span className="mt-0.5 block text-[12px] leading-[1.35] text-fg-3">{done.includes(s.id) ? 'Done' : s.line}</span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
