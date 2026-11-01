/**
 * Chat pickers. Agent and model pickers come from components/pickers; this
 * file adds the ones only the composer and the new session sheet need:
 * device and folder, permission mode, mode, jurors, debaters and loop.
 */
import { useRef, useState } from 'react';
import type { DebateConfig, JuryConfig, LoopConfig, PermissionMode, SessionMode } from '@conclave/core/types';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { modelName } from '@/lib/models';
import { MarkStack } from '@/components/logo';
import { Button } from '@/components/ui/Button';
import { Checkbox, Input, Segmented } from '@/components/ui/Field';
import { Popover } from '@/components/ui/Overlay';
import { PickerButton, SelectMenu } from '@/components/ui/Select';
import { ModelList, ModelPicker } from '@/components/pickers/ModelPicker';
import { placeName } from '@/features/home/start';
import { computerList } from '@/features/home/Where';
import { MODES, PERMISSION_MODES } from './modes';

export { AgentPicker } from '@/components/pickers/Pickers';

// ---------------------------------------------------------------------------
// Device and folder: "On arch-desktop ~/code/conclave"
// ---------------------------------------------------------------------------

export function DeviceFolderPicker({
  device,
  cwd,
  onDevice,
  onCwd,
  look = 'text',
  className,
  bare,
  showCwd = true,
  closeOnDevice = false,
}: {
  device: string | undefined;
  cwd?: string;
  onDevice: (id: string) => void;
  onCwd?: (cwd: string) => void;
  look?: 'text' | 'field';
  className?: string;
  /** No "On" prefix (narrow composer bars). */
  bare?: boolean;
  /** Show the folder after the device. */
  showCwd?: boolean;
  /** Close once a device is picked: a session moves and its folder is found there (FolderChooser.tsx). */
  closeOnDevice?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const devices = useHub((s) => s.devices);
  const d = device ? devices[device] : undefined;
  const [path, setPath] = useState(cwd ?? '');
  // the hub first, by its name ("madx (hub)"), then the computers
  const list = computerList(devices);
  return (
    <>
      <PickerButton
        ref={ref}
        look={look}
        prefix={look === 'text' && !bare ? 'On' : undefined}
        data-picker="device"
        aria-label="Device and folder"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={className}
        onClick={() => {
          setPath(cwd ?? '');
          setOpen((o) => !o);
        }}
      >
        {device ? placeName(d, device) : 'hub'}
        {showCwd && cwd && cwd !== '~' && <span className="mono ml-1.5 text-fg-3">{cwd.length > 22 ? `…${cwd.slice(-20)}` : cwd}</span>}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={340} label="Device and folder" sheetTitle="Device and folder">
        <div role="listbox" aria-label="Device" className="p-1">
          <div className="px-2 pt-1.5 pb-1 text-[12px] text-fg-3">Device</div>
          {list.map((dev) => (
            <button
              key={dev.id}
              type="button"
              role="option"
              aria-selected={device === dev.id}
              onClick={() => {
                if (dev.id === device && closeOnDevice) return setOpen(false);
                onDevice(dev.id);
                if (!onCwd || closeOnDevice) setOpen(false);
              }}
              className={cn('flex min-h-[30px] w-full items-center gap-2 rounded-[var(--r-1)] px-2 text-left text-[13px] hov:bg-hover phone:min-h-11 phone:text-[15px]', device === dev.id ? 'text-fg' : 'text-fg-2')}
            >
              <span className={cn('min-w-0 flex-1 truncate', device === dev.id && 'font-medium')}>{placeName(dev)}</span>
              <span className={cn('text-[12px]', dev.online ? 'text-ok' : 'text-fg-3')}>{dev.online ? 'online' : 'offline'}</span>
            </button>
          ))}
        </div>
        {onCwd && (
          <form
            className="border-t border-rule p-2"
            onSubmit={(e) => {
              e.preventDefault();
              onCwd(path.trim() || '~');
              setOpen(false);
            }}
          >
            <label className="mb-1.5 block px-1 text-[12px] text-fg-3" htmlFor="chat-folder">
              Folder
            </label>
            <div className="flex gap-1.5">
              <Input id="chat-folder" mono size="sm" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/project" className="flex-1" />
              <Button type="submit" size="md" variant="outline">
                Set
              </Button>
            </div>
            {d?.roots?.length ? (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 px-1">
                {d.roots.map((r) => (
                  <button key={r} type="button" onClick={() => setPath(r)} className="mono text-[12px] text-fg-3 hover:text-fg">
                    {r}
                  </button>
                ))}
              </div>
            ) : null}
          </form>
        )}
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Permission mode and session mode as text selects
// ---------------------------------------------------------------------------

export function PermissionPicker({ value, onChange, look = 'text', className }: { value: PermissionMode; onChange: (m: PermissionMode) => void; look?: 'text' | 'field'; className?: string; placement?: string }) {
  return (
    <SelectMenu
      look={look}
      label="Permissions"
      className={cn(value === 'bypass' && look === 'text' && 'text-fault hov:text-fault', className)}
      value={value}
      onChange={onChange}
      width={280}
      options={PERMISSION_MODES.map((p) => ({ value: p.value, label: p.value === 'bypass' ? <span className="text-fault">{p.label}</span> : p.label, text: p.label, detail: p.description }))}
    />
  );
}

export function ModePicker({ value, onChange, look = 'text', className, bare }: { value: SessionMode; onChange: (m: SessionMode) => void; look?: 'text' | 'field'; className?: string; bare?: boolean }) {
  return (
    <SelectMenu
      look={look}
      label="Mode"
      prefix={look === 'text' && !bare ? 'Mode' : undefined}
      className={className}
      value={value}
      onChange={onChange}
      width={300}
      options={MODES.map((m) => ({ value: m.value, label: m.label, text: m.label, detail: m.description }))}
    />
  );
}

export interface ModeValue {
  mode: SessionMode;
  jury?: JuryConfig;
  debate?: DebateConfig;
  loop?: LoopConfig;
}

export const DEFAULT_JURY: JuryConfig = { jurors: ['anthropic/claude-sonnet-5-5', 'openai/gpt-5.5', 'zai/glm-5', 'google/gemini-3-pro'], strategy: 'synthesize', anonymize: true, jurorTools: 'none' };
export const DEFAULT_DEBATE: DebateConfig = { a: 'openai/gpt-5.5', b: 'anthropic/claude-opus-5-5', rounds: 2 };
export const DEFAULT_LOOP: LoopConfig = { untilCommand: 'bun test', maxIterations: 8 };

// ---------------------------------------------------------------------------
// Jury: "[logos] 4 jurors" and "Judge Opus 5.5"
// ---------------------------------------------------------------------------

export function JurorsPicker({ value, onChange, look = 'text', className }: { value: JuryConfig | undefined; onChange: (v: JuryConfig) => void; look?: 'text' | 'field'; className?: string }) {
  const v = value ?? DEFAULT_JURY;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PickerButton ref={ref} look={look} lead={<MarkStack models={v.jurors} />} aria-label="Jurors" aria-haspopup="dialog" aria-expanded={open} className={className} onClick={() => setOpen((o) => !o)}>
        {v.jurors.length} {v.jurors.length === 1 ? 'juror' : 'jurors'}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={380} maxHeight={560} label="Jurors" sheetTitle="Jurors">
        <ModelList values={v.jurors} onChange={() => undefined} onChangeMany={(jurors) => onChange({ ...v, jurors })} harnesses={false} />
        <div className="shrink-0 space-y-2 border-t border-rule px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-fg-3">How the judge decides</span>
            <Segmented
              size="sm"
              label="Strategy"
              value={v.strategy}
              onChange={(strategy) => onChange({ ...v, strategy })}
              options={[
                { value: 'synthesize', label: 'Merge' },
                { value: 'vote', label: 'Vote' },
                { value: 'rank', label: 'Rank' },
              ]}
            />
          </div>
          <Checkbox checked={v.anonymize} onChange={(anonymize) => onChange({ ...v, anonymize })} label="Hide model names from the judge" />
          <Checkbox checked={v.jurorTools === 'readonly'} onChange={(on) => onChange({ ...v, jurorTools: on ? 'readonly' : 'none' })} label="Jurors may read files" />
        </div>
      </Popover>
    </>
  );
}

export function JudgePicker({ value, onChange, look = 'text', className, fallback, bare }: { value: string | undefined; onChange: (m: string | undefined) => void; look?: 'text' | 'field'; className?: string; fallback?: string; bare?: boolean }) {
  return <ModelPicker value={value ?? fallback} onChange={onChange} look={look} prefix={look === 'text' && !bare ? 'Judge' : undefined} label="Judge" className={className} harnesses={false} />;
}

// ---------------------------------------------------------------------------
// Debate: "GPT-5.5 vs Opus 5.5" with stances and rounds
// ---------------------------------------------------------------------------

export function DebatersPicker({ value, onChange, look = 'text', className }: { value: DebateConfig | undefined; onChange: (v: DebateConfig) => void; look?: 'text' | 'field'; className?: string }) {
  const v = value ?? DEFAULT_DEBATE;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PickerButton ref={ref} look={look} lead={<MarkStack models={[v.a, v.b]} />} aria-label="Debaters" aria-haspopup="dialog" aria-expanded={open} className={className} onClick={() => setOpen((o) => !o)}>
        {modelName(v.a)} vs {modelName(v.b)}, {v.rounds} {v.rounds === 1 ? 'round' : 'rounds'}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={360} label="Debaters" sheetTitle="Debaters">
        <div className="space-y-3 p-3">
          {(['a', 'b'] as const).map((k) => (
            <div key={k}>
              <div className="mb-1 text-[12px] font-medium text-fg-2">{k === 'a' ? 'First speaker' : 'Second speaker'}</div>
              <div className="flex gap-2">
                <ModelPicker value={v[k]} onChange={(m) => onChange({ ...v, [k]: m })} look="field" harnesses={false} className="flex-1" />
                <Input
                  size="md"
                  value={(k === 'a' ? v.stanceA : v.stanceB) ?? ''}
                  onChange={(e) => onChange({ ...v, [k === 'a' ? 'stanceA' : 'stanceB']: e.target.value || undefined })}
                  placeholder="Argues for"
                  aria-label="Argues for"
                  className="w-28"
                />
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium text-fg-2">Rounds</span>
            <Segmented size="sm" label="Rounds" value={String(v.rounds)} onChange={(r) => onChange({ ...v, rounds: Number(r) })} options={['1', '2', '3', '4'].map((r) => ({ value: r, label: r }))} />
          </div>
        </div>
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Loop: "Until bun test passes"
// ---------------------------------------------------------------------------

export function LoopPicker({ value, onChange, look = 'text', className }: { value: LoopConfig | undefined; onChange: (v: LoopConfig) => void; look?: 'text' | 'field'; className?: string }) {
  const v = value ?? DEFAULT_LOOP;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PickerButton ref={ref} look={look} prefix={look === 'text' ? 'Until' : undefined} aria-label="Loop until" aria-haspopup="dialog" aria-expanded={open} className={className} onClick={() => setOpen((o) => !o)}>
        {v.untilCommand ? <span className="mono">{v.untilCommand}</span> : v.untilText ? `output has “${v.untilText}”` : 'done'}
        <span className="ml-1.5 text-fg-3">max {v.maxIterations}</span>
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={340} label="Loop until" sheetTitle="Loop until">
        <div className="space-y-3 p-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-fg-2" htmlFor="loop-cmd">
              Until this command exits 0
            </label>
            <Input id="loop-cmd" mono value={v.untilCommand ?? ''} onChange={(e) => onChange({ ...v, untilCommand: e.target.value || undefined })} placeholder="bun test" />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-fg-2" htmlFor="loop-text">
              Or until the output contains
            </label>
            <Input id="loop-text" value={v.untilText ?? ''} onChange={(e) => onChange({ ...v, untilText: e.target.value || undefined })} placeholder="All checks passed" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium text-fg-2">At most</span>
            <Segmented size="sm" label="Max iterations" value={String(v.maxIterations)} onChange={(n) => onChange({ ...v, maxIterations: Number(n) })} options={['4', '8', '16', '32'].map((n) => ({ value: n, label: `${n} runs` }))} />
          </div>
        </div>
      </Popover>
    </>
  );
}
