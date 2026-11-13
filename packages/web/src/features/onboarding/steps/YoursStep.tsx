/**
 * Step 4, Make it yours: memory on or off (asked once here: memory is the
 * core promise), learning from sessions, and the modes. Chat, Assistant and
 * Code are always on; Security, Canvas and Meetings are boxes, off for a new
 * account (features/home/modes.tsx), saved on the person's account so every
 * device of theirs agrees. Where notes live and the profile are in Memory.
 * Continue finishes setup (ui.onboarded, setup.completedAt) and Chat opens.
 */
import { useState } from 'react';
import { Checkbox, OnOff } from '@/components/ui/Field';
import { SectionHeading } from '@/components/ui/Section';
import { finishOnboarding } from '@/lib/onboarding';
import { toast, updateConfig, useHub } from '@/store/store';
import { modeOn } from '@conclave/core/client';
import { MODE_WORDS, OPTIONAL_MODES, saveModes } from '@/features/home/modes';
import { StepFrame } from '../StepLayout';
import { errText, SettingRow, useCtlSize } from '../parts';

export function YoursStep() {
  const prefs = useHub((s) => s.me?.preferences);
  const config = useHub((s) => s.config);
  const ctl = useCtlSize();
  const mem = (config?.memory ?? {}) as { enabled?: boolean; autoExtract?: boolean };
  const enabled = mem.enabled !== false;
  const learning = mem.autoExtract !== false;
  // a new account has all three saved off; setup run again shows what is on now
  const [picks, setPicks] = useState(() => ({ security: modeOn(prefs, 'security'), canvas: modeOn(prefs, 'canvas'), meetings: modeOn(prefs, 'meetings') }));
  const count = Number(picks.security) + Number(picks.canvas);
  const modes = `${count ? `${3 + count} modes on` : 'Chat, Assistant and Code on'}${picks.meetings ? ', and Meetings' : ''}`;
  const summary = `Memory ${enabled ? 'on' : 'off'}. ${modes}.`;

  const save = (patch: Record<string, unknown>) => void updateConfig(patch).catch((e) => toast({ title: `Could not save. ${errText(e)}`, level: 'error' }));

  const finish = async () => {
    await saveModes(picks);
    try {
      await finishOnboarding();
    } catch (e) {
      toast({ title: `Could not save that setup is done. ${errText(e)}`, level: 'error' });
      return false;
    }
  };

  return (
    <StepFrame summary={summary} onContinue={finish} continueLabel="Open Chat" continueBusy="Opening">
      <section>
        <SectionHeading>Memory</SectionHeading>
        <div className="rows border-b border-rule">
          <SettingRow label="Remember me" help="Conclave keeps notes about you and your work, and each conversation gets the ones that matter.">
            <OnOff label="Memory" size={ctl === 'touch' ? 'touch' : 'sm'} checked={enabled} onChange={(v) => save({ memory: { enabled: v } })} />
          </SettingRow>
          <SettingRow label="Learn from sessions" help="When a session ends, save the facts and procedures it found.">
            <OnOff label="Learn from sessions" size={ctl === 'touch' ? 'touch' : 'sm'} checked={enabled && learning} disabled={!enabled} onChange={(v) => save({ memory: { autoExtract: v } })} />
          </SettingRow>
        </div>
      </section>

      <section className="mt-10">
        <SectionHeading>Modes</SectionHeading>
        <div className="space-y-1 pt-3">
          {(['chat', 'assistant', 'code'] as const).map((m) => (
            <Checkbox key={m} checked disabled onChange={() => undefined} label={m === 'chat' ? 'Chat' : m === 'assistant' ? 'Assistant' : 'Code'} description="Always on." />
          ))}
          {OPTIONAL_MODES.map((m) => (
            <Checkbox key={m} checked={picks[m]} onChange={(v) => setPicks((p) => ({ ...p, [m]: v }))} label={MODE_WORDS[m].label} description={MODE_WORDS[m].line} />
          ))}
        </div>
      </section>
    </StepFrame>
  );
}
