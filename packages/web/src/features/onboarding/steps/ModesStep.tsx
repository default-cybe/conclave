/**
 * Step 7, Modes: Chat, Assistant and Code are always on; Security, Canvas
 * and Meetings are boxes, off for a new account (features/home/modes.tsx).
 * Saved on the person's account, so every device of theirs agrees.
 */
import { useState } from 'react';
import { Checkbox } from '@/components/ui/Field';
import { useHub } from '@/store/store';
import { modeOn } from '@conclave/core/client';
import { MODE_WORDS, OPTIONAL_MODES, saveModes } from '@/features/home/modes';
import { StepFrame } from '../StepLayout';

export function ModesStep() {
  const prefs = useHub((s) => s.me?.preferences);
  // a new account has all three saved off; setup run again shows what is on now
  const [picks, setPicks] = useState(() => ({ security: modeOn(prefs, 'security'), canvas: modeOn(prefs, 'canvas'), meetings: modeOn(prefs, 'meetings') }));
  const count = Number(picks.security) + Number(picks.canvas);
  const summary = `${count ? `${3 + count} modes on` : 'Chat, Assistant and Code on'}${picks.meetings ? ', and Meetings' : ''}.`;
  return (
    <StepFrame summary={summary} onContinue={() => saveModes(picks)}>
      <div className="space-y-1">
        {(['chat', 'assistant', 'code'] as const).map((m) => (
          <Checkbox key={m} checked disabled onChange={() => undefined} label={m === 'chat' ? 'Chat' : m === 'assistant' ? 'Assistant' : 'Code'} description="Always on." />
        ))}
        {OPTIONAL_MODES.map((m) => (
          <Checkbox key={m} checked={picks[m]} onChange={(v) => setPicks((p) => ({ ...p, [m]: v }))} label={MODE_WORDS[m].label} description={MODE_WORDS[m].line} />
        ))}
      </div>
    </StepFrame>
  );
}
