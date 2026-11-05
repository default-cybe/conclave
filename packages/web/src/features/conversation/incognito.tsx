/**
 * Incognito and the memory setting for a new chat or Code session (core
 * session/incognito.ts). Incognito is picked before the first send and never
 * changes after; it starts the memory setting at "Use only". The header of an
 * incognito conversation carries the mark for as long as it lasts.
 */
import { HatGlasses } from 'lucide-react';
import type { ChatSettings } from '@conclave/core/types';
import type { MenuItem } from '@/components/ui/Overlay';
import { Checkbox, Segmented } from '@/components/ui/Field';
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

/** "+" rows: Incognito, then the three memory settings. */
export function privacyItems(p: Privacy, set: (p: Privacy) => void, code: boolean): MenuItem[] {
  return [
    { group: true, label: 'Privacy' },
    { label: 'Incognito', detail: code ? CODE_INCOGNITO_LINE : INCOGNITO_LINE, checked: p.incognito, keep: true, onSelect: () => set(toggleIncognito(p)) },
    { group: true, label: 'Memory' },
    ...MODES.map((m) => ({ label: m.label, detail: m.detail, checked: p.memory === m.value, keep: true, onSelect: () => set({ ...p, memory: m.value }) })),
  ];
}

/** The same choices in a phone's options sheet. */
export function PrivacyFields({ value, onChange, code }: { value: Privacy; onChange: (p: Privacy) => void; code: boolean }) {
  return (
    <div className="space-y-3">
      <Checkbox checked={value.incognito} onChange={() => onChange(toggleIncognito(value))} label="Incognito" description={code ? CODE_INCOGNITO_LINE : INCOGNITO_LINE} />
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-fg-2">Memory</div>
        <Segmented full label="Memory" value={value.memory} onChange={(m) => onChange({ ...value, memory: m })} options={MODES.map((m) => ({ value: m.value, label: m.label, title: m.detail }))} />
      </div>
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
