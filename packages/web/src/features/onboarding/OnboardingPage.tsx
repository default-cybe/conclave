/**
 * First-run setup (spec 11.11, design review #8). Routes, rendered outside the shell:
 *   /welcome            the Welcome screen, step 1 of 4
 *   /setup/<step>       Hub, Connect a model or Make it yours (also /welcome/<step>)
 *   /setup/<later>      a "Set up later" page (extensions, agents, defaults, import, devices, notifications, routines)
 *   /setup/<old step>   a step folded into the four opens that step (subscriptions, providers, modes, memory, done)
 *   /setup              resumes where the owner stopped
 *   /setup?again=1      "Run setup again": opens Connect a model with answers prefilled
 * Progress is saved to the hub config (ui.onboardingSteps, setup.progress)
 * so a reload or another device resumes at the same step.
 */
import { useCallback, useEffect, useMemo, useRef, type ComponentType } from 'react';
import { Redirect, useLocation, useSearch } from 'wouter';
import { skipOnboarding } from '@/lib/onboarding';
import { attempt } from '@/store/store';
import { setStartMode } from '@/features/home/start';
import { FlowCtx, StepShell, useContinueKeys, type Flow } from './StepLayout';
import { Welcome } from './Welcome';
import { STEPS, isLaterId, pageFor, stepDef, stepHref, stepIndex, type PageId, type StepId } from './steps';
import { recordStep, useProgress } from './progress';
import { HubStep } from './steps/HubStep';
import { ModelStep } from './steps/ModelStep';
import { YoursStep } from './steps/YoursStep';
import { ExtensionsStep } from './steps/ExtensionsStep';
import { AgentsStep } from './steps/AgentsStep';
import { DefaultsStep } from './steps/DefaultsStep';
import { ImportStep } from './steps/ImportStep';
import { DevicesStep } from './steps/DevicesStep';
import { NotificationsStep } from './steps/NotificationsStep';
import { RoutinesStep } from './steps/RoutinesStep';

const VIEWS: Record<Exclude<PageId, 'welcome'>, ComponentType> = {
  hub: HubStep,
  model: ModelStep,
  yours: YoursStep,
  extensions: ExtensionsStep,
  agents: AgentsStep,
  defaults: DefaultsStep,
  import: ImportStep,
  devices: DevicesStep,
  notifications: NotificationsStep,
  routines: RoutinesStep,
};

export default function OnboardingPage() {
  const [loc, navigate] = useLocation();
  const search = useSearch();
  const progress = useProgress();
  const seg = loc.split('/').filter(Boolean);
  const raw = seg[1];
  const page = pageFor(raw);

  const leave = useCallback(async () => {
    await attempt(() => skipOnboarding());
    navigate('/');
  }, [navigate]);

  // /setup without a step: resume, or open Connect a model when run again from Settings
  if (seg[0] === 'setup' && !raw) {
    const again = new URLSearchParams(search).has('again');
    return <Redirect to={stepHref(again ? 'model' : (progress.step ?? 'hub'))} replace />;
  }
  // an old step's address, or /setup/welcome: the page it is now
  if (page && page !== raw) return <Redirect to={`${stepHref(page)}${search ? `?${search}` : ''}`} replace />;
  if (!page || page === 'welcome') return <Welcome onStart={(at) => navigate(stepHref(at))} onSkip={() => void leave()} />;
  return <Steps step={page} leave={leave} completed={progress.completed} />;
}

function Steps({ step, leave, completed }: { step: Exclude<PageId, 'welcome'>; leave: () => Promise<void>; completed: boolean }) {
  const [, navigate] = useLocation();
  const cont = useRef<(() => void) | null>(null);
  const i = stepIndex(step);

  const flow = useMemo<Flow>(() => {
    const go = (id: PageId) => navigate(stepHref(id));
    // a "Set up later" page goes back where it came from: Home once setup is done, else the setup that waits
    const out = () => navigate(completed ? '/' : '/setup');
    if (isLaterId(step))
      return {
        step,
        go,
        next: async () => {
          void recordStep(step, 'done');
          out();
        },
        skip: async () => out(),
        back: out,
        leave,
        register: (fn) => {
          cont.current = fn;
        },
        runContinue: () => cont.current?.(),
      };
    const last = i === STEPS.length - 1;
    const after = STEPS[Math.min(i + 1, STEPS.length - 1)].id as StepId;
    return {
      step,
      go,
      next: async () => {
        void recordStep(step, 'done', after);
        if (!last) return go(after);
        // four steps, then Chat opens
        setStartMode('chat');
        navigate('/');
      },
      skip: async () => {
        void recordStep(step, 'skipped', after);
        go(after);
      },
      back: () => go(STEPS[Math.max(i - 1, 0)].id),
      leave,
      register: (fn) => {
        cont.current = fn;
      },
      runContinue: () => cont.current?.(),
    };
  }, [step, i, navigate, leave, completed]);

  const runContinue = useCallback(() => cont.current?.(), []);
  useContinueKeys(runContinue);

  useEffect(() => {
    document.title = `${stepDef(step).name}, Conclave setup`;
    return () => {
      document.title = 'Conclave';
    };
  }, [step]);

  const View = VIEWS[step];
  return (
    <FlowCtx.Provider value={flow}>
      <StepShell step={step}>
        <View key={step} />
      </StepShell>
    </FlowCtx.Provider>
  );
}
