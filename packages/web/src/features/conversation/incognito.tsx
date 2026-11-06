/**
 * Incognito and the memory setting for a new chat or Code session (core
 * session/incognito.ts). Incognito is picked before the first send and never
 * changes after; it starts the memory setting at "Use only". The header of an
 * incognito conversation carries the mark for as long as it lasts.
 *
 * One place sets it: the toggle at the top right of a new chat or Code
 * session (IncognitoToggle), with the memory picker beside it while it is
 * on. Without incognito, "+" (the phone's options) keeps the memory setting.
 * The toggle goes once the first message is on its way.
 */
import { useState } from 'react';
import { HatGlasses } from 'lucide-react';
import { create } from 'zustand';
import type { ChatSettings } from '@conclave/core/types';
import type { MenuItem } from '@/components/ui/Overlay';
import { IconButton } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/text';

export type MemoryMode = 'save' | 'use' | 'off';
export interface Privacy {
  incognito: boolean;
  memory: MemoryMode;
}

export const INCOGNITO_LINE = 'Not kept: no history, search or summaries, deleted when closed. Messages still go to the model provider.';
export const CODE_INCOGNITO_LINE = 'Only the conversation is not kept: file changes and commands on the device are real and stay.';

const MODES: Array<{ value: MemoryMode; label: string; detail: string }> = [
  { value: 'save', label: 'Use and save', detail: 'Recall what it knows and save what you tell it' },
  { value: 'use', label: 'Use only', detail: 'Recall what it knows, save nothing' },
  { value: 'off', label: 'Off', detail: 'No recall, nothing saved' },
];

/** Incognito on starts memory at "Use only"; off goes back to "Use and save". */
export const toggleIncognito = (p: Privacy): Privacy => ({ incognito: !p.incognito, memory: p.incognito ? 'save' : 'use' });

/** The chat switches a memory setting sends to the hub. */
export function memoryChat(m: MemoryMode): Partial<ChatSettings> {
  return m === 'off' ? { memory: false } : m === 'use' ? { memory: true, memorySave: false } : { memory: true };
}

/** The next new chat's or Code session's incognito and its memory; `sending` while its first message goes. */
export const useIncognito = create<Privacy & { sending: boolean }>(() => ({ incognito: false, memory: 'use', sending: false }));

/** The header toggle, and Ctrl/Cmd+Shift+N with `true`. */
export const setIncognito = (on?: boolean) => {
  const now = useIncognito.getState();
  if (on === undefined || on !== now.incognito) useIncognito.setState(toggleIncognito(now));
};

/** The first message is on its way (`undefined`), went (`true`) or failed (`false`): incognito is not kept for the next one, a failure keeps it for the retry. */
export function firstSend(ok?: boolean) {
  useIncognito.setState(ok === undefined ? { sending: true } : ok ? { incognito: false, memory: 'use', sending: false } : { sending: false });
}

/** A new chat's or session's privacy: the toggle's while incognito is on, else the memory setting picked in "+" (from `start`). */
export function usePrivacy(start: MemoryMode): [Privacy, (m: MemoryMode) => void] {
  const [memory, setMemory] = useState(start);
  const on = useIncognito((s) => s.incognito);
  const kept = useIncognito((s) => s.memory);
  return [on ? { incognito: true, memory: kept } : { incognito: false, memory }, setMemory];
}

/** "+" rows: the memory setting of a new chat or session that is not incognito (the toggle holds it while it is). */
export function memoryItems(m: MemoryMode, set: (m: MemoryMode) => void): MenuItem[] {
  return [{ group: true, label: 'Memory' }, ...MODES.map((x) => ({ label: x.label, detail: x.detail, checked: m === x.value, keep: true, onSelect: () => set(x.value) }))];
}

/** The same choices in a phone's options sheet. */
export function MemoryField({ value, onChange }: { value: MemoryMode; onChange: (m: MemoryMode) => void }) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-fg-2">Memory</div>
      <Segmented full label="Memory" value={value} onChange={onChange} options={MODES.map((m) => ({ value: m.value, label: m.label, title: m.detail }))} />
    </div>
  );
}

function MemoryPicker({ className }: { className?: string }) {
  const memory = useIncognito((s) => s.memory);
  return (
    <SelectMenu
      look="text"
      label="Memory in incognito"
      prefix="Memory"
      width={260}
      value={memory}
      onChange={(m) => useIncognito.setState({ memory: m })}
      options={MODES.map((m) => ({ value: m.value, label: m.label, text: m.label, detail: m.detail }))}
      className={className}
    />
  );
}

/**
 * The top right of a new chat or Code session: Incognito, a ghost icon while
 * off; on, it is pressed, the memory picker sits beside it and the line says
 * what is not kept. Phones (`bar`): the icon only, in the bar; IncognitoBarLine
 * goes under it. Gone once the first message is on its way.
 */
export function IncognitoToggle({ code, bar, className }: { code: boolean; bar?: boolean; className?: string }) {
  const on = useIncognito((s) => s.incognito);
  const sending = useIncognito((s) => s.sending);
  if (sending) return null;
  const button = (
    <IconButton
      label="Incognito"
      size={bar ? 'touch' : 'lg'}
      active={on}
      onClick={() => setIncognito()}
      className={cn(bar && 'rounded-full [&_svg]:size-[22px]')}
    >
      <HatGlasses aria-hidden />
    </IconButton>
  );
  if (bar) return button;
  return (
    <div className={cn('flex flex-col items-end gap-1', className)}>
      <div className="flex items-center gap-1">
        {on && <MemoryPicker />}
        {button}
      </div>
      {on && (
        <p className="max-w-[300px] text-right text-[12px] text-fg-3">
          <span className="font-medium text-fg-2">Incognito.</span> {code ? CODE_INCOGNITO_LINE : INCOGNITO_LINE}
        </p>
      )}
    </div>
  );
}

/** Phones: under the bar while incognito is on, the mark and the memory picker. */
export function IncognitoBarLine({ code }: { code: boolean }) {
  const on = useIncognito((s) => s.incognito);
  const sending = useIncognito((s) => s.sending);
  if (!on || sending) return null;
  return (
    <div className="flex shrink-0 items-center justify-center gap-3 py-1">
      <IncognitoMark code={code} />
      <MemoryPicker className="text-[14px]" />
    </div>
  );
}

/** The header's mark on an incognito conversation. */
export function IncognitoMark({ code, className }: { code?: boolean; className?: string }) {
  return (
    <Tooltip content={code ? CODE_INCOGNITO_LINE : INCOGNITO_LINE}>
      <span tabIndex={0} aria-label="Incognito: this conversation is not kept" className={cn('inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-fg-2', className)}>
        <HatGlasses aria-hidden className="size-3.5" />
        Incognito
      </span>
    </Tooltip>
  );
}
