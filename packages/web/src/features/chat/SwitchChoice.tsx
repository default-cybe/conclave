/**
 * The step a model switch takes in a big chat (docs/DESIGN.md 44,
 * docs/design/CHAT-AND-MOTION.md 2.12): what the switch costs once and when
 * it pays back, Full history (the default) or Short handover, and Ask once,
 * one second opinion from that model, as the cheap way to put one question
 * to it. Under the hub's switch size, or for a cheap model, a pick switches
 * at once as before.
 */
import { useRef, useState } from 'react';
import type { Session } from '@conclave/core/types';
import type { SwitchEstimate } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt } from '@/store/store';
import { compact } from '@/lib/format';
import { modelName } from '@/lib/models';
import { Button } from '@/components/ui/Button';
import { Radio } from '@/components/ui/Field';
import { ModelList } from '@/components/pickers/ModelPicker';
import { briefSaving, priceLine, rememberBrief, rememberedBrief, switchEstimate, switchSession, usdWords } from './switch';

export function SwitchChoice({
  session,
  model,
  estimate,
  onBack,
  onDone,
  onSwitched,
}: {
  session: Session;
  model: string;
  estimate: SwitchEstimate;
  onBack?: () => void;
  onDone: () => void;
  /** After the switch went through (not after Ask once). */
  onSwitched?: (s: Session) => void;
}) {
  const [brief, setBrief] = useState(() => !!estimate.brief && rememberedBrief());
  const [busy, setBusy] = useState<'switch' | 'ask' | null>(null);
  const name = modelName(model);
  const saving = briefSaving(estimate);
  const go = async () => {
    setBusy('switch');
    if (estimate.brief) rememberBrief(brief);
    const s = await switchSession(session, model, brief && !!estimate.brief);
    setBusy(null);
    if (s) onSwitched?.(s);
    onDone();
  };
  const ask = async () => {
    setBusy('ask');
    await attempt(() => api().secondOpinion(session.id, { reviewer: model, includeTranscript: true }), `Asked ${name} once.`);
    setBusy(null);
    onDone();
  };
  return (
    <div className="space-y-3 px-3 pt-2.5 pb-3" data-switch-choice>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-[13px] font-semibold text-fg phone:text-[15px]">Switch to {name}</h3>
        {onBack && (
          <button type="button" onClick={onBack} className="link text-[12px] phone:text-[13px]">
            Back
          </button>
        )}
      </div>
      <p className="m-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
        This chat holds about {compact(estimate.tokens)} tokens. {name} reads them with no cache on its first reply.
      </p>
      <div role="radiogroup" aria-label="How to switch">
        <Radio name="switch-how" checked={!brief} onChange={() => setBrief(false)} label="Full history" description={`${priceLine(estimate.full)}.`} className="phone:py-2" />
        {estimate.brief && (
          <Radio
            name="switch-how"
            checked={brief}
            onChange={() => setBrief(true)}
            label="Short handover"
            description={`${priceLine(estimate.brief)}. A summary and the recent turns, with old tool output cleared. The full chat stays stored.`}
            className="phone:py-2"
          />
        )}
      </div>
      {estimate.suggestBrief && !brief && <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">A short handover would save about {usdWords(saving)} here.</p>}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button variant="solid" busy={busy === 'switch' ? 'Switching' : false} disabled={!!busy} onClick={() => void go()}>
          Switch
        </Button>
        <Button variant="quiet" busy={busy === 'ask' ? 'Asking' : false} disabled={!!busy} onClick={() => void ask()}>
          Ask once
        </Button>
        <span className="text-[12px] text-fg-3 phone:text-[13px]">
          One answer from {name}, about {usdWords(estimate.askUsd)}
        </span>
      </div>
    </div>
  );
}

/**
 * The model list for a switch: a pick switches at once, unless the hub says
 * the chat is big enough to show the price first (estimate.confirm).
 */
export function SwitchModelList({
  session,
  harnesses,
  onDone,
  autoFocus,
  onStep,
  onSwitched,
}: {
  session: Session;
  harnesses?: boolean;
  onDone: () => void;
  autoFocus?: boolean;
  /** The price step opened (true) or went back to the list (false). */
  onStep?: (open: boolean) => void;
  /** After a switch went through (the limit notice then sends "Continue"). */
  onSwitched?: (s: Session) => void;
}) {
  const [step, setStepState] = useState<{ model: string; estimate: SwitchEstimate } | null>(null);
  const setStep = (s: { model: string; estimate: SwitchEstimate } | null) => {
    setStepState(s);
    onStep?.(!!s);
  };
  const waiting = useRef(false);
  const pick = (model: string) => {
    if (model === session.model) return;
    waiting.current = true;
    void switchEstimate(session, model).then(async (estimate) => {
      waiting.current = false;
      if (estimate?.confirm) return setStep({ model, estimate });
      const s = await switchSession(session, model);
      if (s) onSwitched?.(s);
      onDone();
    });
  };
  if (step) return <SwitchChoice session={session} model={step.model} estimate={step.estimate} onBack={() => setStep(null)} onDone={onDone} onSwitched={onSwitched} />;
  // the list closes after a pick, except while the estimate is on its way
  const done = () => {
    if (!waiting.current) onDone();
  };
  return <ModelList value={session.model} harnesses={harnesses} autoFocus={autoFocus} onChange={pick} onDone={done} />;
}
