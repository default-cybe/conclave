/**
 * First-run setup (spec 11.11). Routes, rendered outside the shell:
 *   /welcome            the Welcome screen
 *   /setup/<step>       one of the eleven steps (also /welcome/<step>)
 *   /setup              resumes where the owner stopped
 *   /setup?again=1      "Run setup again": opens step 2 (Subscriptions) with answers prefilled
 * Progress is saved to the hub config (ui.onboardingSteps, setup.progress)
 * so a reload or another device resumes at the same step.
 */
import { useCallback, useEffect, useMemo, useRef, type ComponentType } from 'react';
import { Redirect, useLocation, useSearch } from 'wouter';
import { skipOnboarding } from '@/lib/onboarding';
import { attempt } from '@/store/store';
import { FlowCtx, StepShell, useContinueKeys, type Flow } from './StepLayout';
import { Welcome } from './Welcome';
import { STEPS, isStepId, stepIndex, type StepId } from './steps';
import { recordStep, useProgress } from './progress';
import { HubStep } from './steps/HubStep';
import { SubscriptionsStep } from './steps/SubscriptionsStep';
import { ProvidersStep } from './steps/ProvidersStep';
import { AgentsStep } from './steps/AgentsStep';
import { DefaultsStep } from './steps/DefaultsStep';
import { MemoryStep } from './steps/MemoryStep';
import { ImportStep } from './steps/ImportStep';
import { DevicesStep } from './steps/DevicesStep';
import { NotificationsStep } from './steps/NotificationsStep';
import { RoutinesStep } from './steps/RoutinesStep';
import { DoneStep } from './steps/DoneStep';

const VIEWS: Record<StepId, ComponentType> = {
  hub: HubStep,
  subscriptions: SubscriptionsStep,
  providers: ProvidersStep,
  agents: AgentsStep,
  defaults: DefaultsStep,
  memory: MemoryStep,
  import: ImportStep,
  devices: DevicesStep,
  notifications: NotificationsStep,
  routines: RoutinesStep,
  done: DoneStep,
};

export default function OnboardingPage() {
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const progress = useProgress();
  const seg = loc.split('/').filter(Boolean);
  const raw = seg[1];
  const step: StepId | undefined = isStepId(raw) ? raw : undefined;

  const leave = useCallback(async () => {
    await attempt(() => skipOnboarding());
    navigate('/');
  }, [navigate]);

  // /setup without a step: resume, or open step 2 when run again from Settings
  if (seg[0] === 'setup' && !step) {
    const again = new URLSearchParams(search).has('again');
    return <Redirect to={`/setup/${again ? 'subscriptions' : (progress.step ?? 'hub')}`} replace />;
  }
  if (!step) return <Welcome onStart={(at) => navigate(`/setup/${at}`)} onSkip={() => void leave()} />;
  return <Steps step={step} leave={leave} />;
}

function Steps({ step, leave }: { step: StepId; leave: () => Promise<void> }) {
  const [, navigate] = useLocation();
  const cont = useRef<(() => void) | null>(null);
  const i = stepIndex(step);

  const flow = useMemo<Flow>(() => {
    const go = (id: StepId) => navigate(`/setup/${id}`);
    const after = STEPS[Math.min(i + 1, STEPS.length - 1)].id;
    return {
      step,
      go,
      next: async () => {
        void recordStep(step, 'done', after);
        if (step !== 'done') go(after);
      },
      skip: async () => {
        void recordStep(step, 'skipped', after);
        go(after);
      },
      back: () => (i === 0 ? navigate('/welcome') : go(STEPS[i - 1].id)),
      leave,
      register: (fn) => {
        cont.current = fn;
      },
      runContinue: () => cont.current?.(),
    };
  }, [step, i, navigate, leave]);

  const runContinue = useCallback(() => cont.current?.(), []);
  useContinueKeys(runContinue);

  useEffect(() => {
    document.title = `${STEPS[i].name}, Conclave setup`;
    return () => {
      document.title = 'Conclave';
    };
  }, [i]);

  const View = VIEWS[step];
  return (
    <FlowCtx.Provider value={flow}>
      <StepShell step={step}>
        <View key={step} />
      </StepShell>
    </FlowCtx.Provider>
  );
}
