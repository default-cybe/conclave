/**
 * Step layout (spec 11.11): a 300px rail on the left (mark and wordmark, the
 * small hero band, the numbered steps with what each one set up, the hub
 * connection in words) and the step in a 720px column with a sticky footer.
 * Below 1280px the rail folds into a header with a 3px progress meter.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { Brand } from '@/components/brand/Mark';
import { Wave } from '@/components/wave';
import { Button } from '@/components/ui/Button';
import { Meter } from '@/components/ui/Meter';
import { MOD } from '@/components/ui/Kbd';
import { MOCK, loadConnection } from '@/lib/api';
import { useIsMobile, useIsWide } from '@/lib/hooks';
import { modelName } from '@/lib/models';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { hubHost } from '../connect/errors';
import { transportWords } from '@/lib/remote';
import { STEPS, stepDef, stepIndex, stepNumber, type StepId } from './steps';
import { useProgress, useSetupFacts, type SetupFacts } from './progress';

export interface Flow {
  step: StepId;
  go: (id: StepId) => void;
  /** Finish this step and move on. */
  next: () => Promise<void>;
  skip: () => Promise<void>;
  back: () => void;
  leave: () => Promise<void>;
  /** The step's Continue, for the keyboard shortcut. */
  register: (fn: (() => void) | null) => void;
  /** Run the current step's Continue (what ↵ does). */
  runContinue: () => void;
}

export const FlowCtx = createContext<Flow | null>(null);

export function useFlow(): Flow {
  const f = useContext(FlowCtx);
  if (!f) throw new Error('useFlow outside the setup flow');
  return f;
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

/** What each finished step set up, in a few words ("madx", "3 ready"). */
function railValue(id: StepId, f: SetupFacts): string {
  switch (id) {
    case 'hub':
      return f.hubName ?? '';
    case 'subscriptions':
      return f.subscriptions ? `${f.subscriptions} signed in` : '';
    case 'providers': {
      const n = f.providers.length + f.logins.length;
      return n ? `${n} ready` : '';
    }
    case 'agents':
      return f.harnesses.length ? `${f.harnesses.length} found` : '';
    case 'defaults':
      return f.defaultModel ? modelName(f.defaultModel) : '';
    case 'memory':
      return !f.memoryOn ? 'Off' : f.vault ? 'Basic Memory' : 'In the hub';
    case 'import':
      return f.imported ? `${f.imported} sessions` : '';
    case 'devices': {
      const n = f.devices.filter((d) => d.id !== 'local').length;
      return n ? `${n} paired` : '';
    }
    case 'notifications':
      return f.channels.length > 1 ? `${f.channels.length} devices` : (f.channels[0] ?? '');
    case 'routines':
      return f.routines ? `${f.routines} added` : '';
    default:
      return '';
  }
}

/** " over a Cloudflare tunnel", " over Tailscale", " on this network", or nothing. */
function via(address: string): string {
  const t = transportWords(address);
  return t === 'Cloudflare quick tunnel' ? ' over a Cloudflare tunnel' : t === 'Tailscale' ? ' over Tailscale' : t === 'Same network' ? ' on this network' : '';
}

/** "Connected to madx at quiet-river-lamp.trycloudflare.com over a Cloudflare tunnel, online" */
export function HubLine({ className }: { className?: string }) {
  const hub = useHub((s) => s.hub);
  const conn = useHub((s) => s.conn);
  const address = MOCK ? (hub?.publicUrl ?? location.origin) : (loadConnection()?.baseUrl ?? location.origin);
  const state = conn === 'open' ? <span className="text-ok">online</span> : conn === 'connecting' ? <span className="text-fg-3">connecting</span> : <span className="text-fault">offline</span>;
  return (
    <p className={cn('m-0 text-[12px] leading-[1.5] text-fg-3', className)}>
      Connected to <span className="font-medium text-fg">{hub?.name ?? 'the hub'}</span> at <span className="mono text-fg-2">{hubHost(address)}</span>
      {via(address)}, {state}
    </p>
  );
}

function Rail({ step }: { step: StepId }) {
  const facts = useSetupFacts();
  const progress = useProgress();
  const flow = useFlow();
  return (
    <aside className="flex min-h-0 flex-col border-r border-rule" aria-label="Setup steps">
      <div className="flex h-14 shrink-0 items-center px-7">
        <Link href="/welcome" className="rounded-[var(--r-1)]" aria-label="Conclave, back to the start of setup">
          <Brand size={15} />
        </Link>
      </div>
      {/* one hero per screen: on Done the wave moves into the content */}
      {step === 'done' ? <div className="h-14 shrink-0" aria-hidden /> : <Wave variant="hero" gap={5} amplitude={0.5} speed={0.6} className="h-14 shrink-0" />}
      <ol className="m-0 mt-4 list-none p-0">
        {STEPS.map((s) => {
          const current = s.id === step;
          // setup run again: every step was finished once, so every step shows what it set up
          const done = progress.done.includes(s.id) || (progress.completed && s.id !== 'done');
          const skipped = !done && progress.skipped?.includes(s.id);
          const value = current ? '' : done || s.id === 'hub' ? railValue(s.id, facts) : skipped ? 'skipped' : '';
          return (
            <li key={s.id}>
              <Link
                href={`/setup/${s.id}`}
                aria-current={current ? 'step' : undefined}
                className={cn(
                  'relative grid grid-cols-[30px_minmax(0,1fr)_auto] items-baseline gap-x-1 px-7 py-[7px] text-[13px] transition-colors duration-[var(--dur-1)]',
                  current ? 'bg-raise font-[560] text-fg shadow-[inset_2px_0_0_var(--fg)]' : done ? 'text-fg-2 hov:bg-hover hov:text-fg' : 'text-fg-3 hov:bg-hover hov:text-fg',
                )}
              >
                <span className={cn('font-mono text-[11px] font-[450]', current ? 'text-fg-2' : 'text-fg-3')}>{stepNumber(s.id)}</span>
                <span className="truncate">{s.name}</span>
                <span className="max-w-[118px] truncate text-[12px] font-normal text-fg-3">{value}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      <div className="mt-auto border-t border-rule px-7 py-4">
        <HubLine />
        {/* on Done the way out is Open Home */}
        {step !== 'done' && (
          <button type="button" onClick={() => void flow.leave()} className="mt-2 text-[12px] text-fg-3 underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
            Finish later
          </button>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/** The rail plus the scrolling step column. */
export function StepShell({ step, children }: { step: StepId; children: ReactNode }) {
  // the rail needs 300px; below 1280 the tables get the width and the rail folds into a header
  const desktop = useIsWide();
  const flow = useFlow();
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [step]);
  const i = stepIndex(step);
  if (desktop)
    return (
      <div className="grid h-full grid-cols-[300px_minmax(0,1fr)] bg-bg">
        <Rail step={step} />
        <main ref={scroller} id="main" className="min-h-0 overflow-y-auto">
          <div className="flex min-h-full flex-col">{children}</div>
        </main>
      </div>
    );
  return (
    <div className="flex h-full flex-col bg-bg pt-safe">
      <header className="shrink-0">
        <div className="flex h-[52px] items-center gap-3 px-4 md:px-6 lg:h-14 lg:px-12">
          <Brand size={15} />
          {step !== 'done' && (
            <button type="button" onClick={() => void flow.leave()} className="-mr-2 ml-auto inline-flex h-11 items-center px-2 text-[14px] text-fg-3 hover:text-fg lg:h-9">
              Finish later
            </button>
          )}
        </div>
        <Meter value={i + 1} max={STEPS.length} label={`Step ${i + 1} of ${STEPS.length}`} className="rounded-none" />
      </header>
      <main ref={scroller} id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col">{children}</div>
      </main>
    </div>
  );
}

const INTERACTIVE = 'input, textarea, select, button, a, [role="radio"], [role="checkbox"], [role="menuitem"], [role="option"], [contenteditable="true"]';

/**
 * One step: "Step 2 of 11", the title, a one sentence lede, the content,
 * then the sticky footer (Back, a summary of this step, Skip for now,
 * Continue). ↵ on the page or ⌘↵ anywhere continues.
 */
export function StepFrame({
  children,
  summary,
  onContinue,
  continueLabel = 'Continue',
  continueBusy,
  hideContinue,
  aside,
}: {
  children: ReactNode;
  /** A sentence about this step's state, left of the buttons. */
  summary?: ReactNode;
  /** Runs before moving on; return false to stay. */
  onContinue?: () => Promise<boolean | void> | boolean | void;
  continueLabel?: string;
  continueBusy?: string;
  /** The step has its own primary action in the content (Done). */
  hideContinue?: boolean;
  /** Under the lede, before the content (rare). */
  aside?: ReactNode;
}) {
  const flow = useFlow();
  const def = stepDef(flow.step);
  const i = stepIndex(flow.step);
  const mobile = useIsMobile();
  const [working, setWorking] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);

  const go = async () => {
    if (working) return;
    setWorking(true);
    try {
      const ok = await onContinue?.();
      if (ok === false) return;
      await flow.next();
    } finally {
      setWorking(false);
    }
  };
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    flow.register(() => void goRef.current());
    return () => flow.register(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // focus the title when a step opens so keyboard and screen reader users start at the top
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
  }, [flow.step]);

  const size = mobile ? 'touch' : 'md';
  return (
    <>
      <div className="flex-1 px-12 pt-10 pb-16 phone:px-4 phone:pt-6 phone:pb-10 md:max-lg:px-6">
        <div className={cn('anim-rise', def.wide ? 'max-w-[980px]' : 'max-w-[720px]')}>
          <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">
            Step <span className="num">{i + 1}</span> of {STEPS.length}
          </p>
          <h1 ref={title} tabIndex={-1} className="t-step m-0 mt-1.5 text-fg outline-none">
            {def.title}
          </h1>
          <p className="m-0 mt-2 max-w-[64ch] text-[15px] leading-[1.5] text-fg-2 phone:text-[15.5px]">{def.lede}</p>
          {aside}
          <div className="mt-8 phone:mt-7">{children}</div>
        </div>
      </div>
      <footer className="sticky bottom-0 z-10 border-t border-rule bg-bg pb-safe">
        {/* the buttons line up with the content column, not the window edge */}
        <div className={cn('mx-12 flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 py-3 phone:mx-4 md:max-lg:mx-6', def.wide ? 'max-w-[980px]' : 'max-w-[720px]')}>
          {summary && <p className="m-0 hidden w-full text-[14px] text-fg-2 phone:block">{summary}</p>}
          <Button variant="quiet" size={size} onClick={flow.back} className="-ml-2 phone:ml-0">
            Back
          </Button>
          <span className="flex-1" />
          {summary && <p className="m-0 min-w-0 truncate text-[13px] text-fg-2 phone:hidden">{summary}</p>}
          {def.skippable && (
            <Button variant="outline" size={size} onClick={() => void flow.skip()}>
              {mobile ? 'Skip' : 'Skip for now'}
            </Button>
          )}
          {!hideContinue && (
            <Button variant="solid" size={size} onClick={() => void go()} busy={working ? (continueBusy ?? 'Saving') : false} kbd={mobile ? undefined : '↵'} title={`${continueLabel} (${MOD} ↵)`}>
              {continueLabel}
            </Button>
          )}
        </div>
      </footer>
    </>
  );
}

/** Enter on the page (not in a control) or ⌘↵ anywhere runs the current step's Continue. */
export function useContinueKeys(run: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      const t = e.target as HTMLElement | null;
      if (!mod && (e.shiftKey || e.altKey || t?.closest(INTERACTIVE) || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]'))) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);
}
