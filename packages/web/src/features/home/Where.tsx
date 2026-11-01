/**
 * Where Code works, as two small chips in the composer's quiet row: the
 * folder ("Choose folder" until one is set, then its path, and always open
 * to change), and the device, shown unless it is the desktop app's own
 * computer. Changing the device is also under "+". The hub is always one of
 * the places, by its name: "madx (hub)".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder } from 'lucide-react';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { shortPath } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Popover, type MenuItem } from '@/components/ui/Overlay';
import { PickerButton } from '@/components/ui/Select';
import { placeName } from './start';

const CHIP = 'h-[24px] text-[12px] phone:text-[13px]';

/** Folders this device worked in lately, then its roots: the first few to pick from. */
export function useKnownFolders(device: string): string[] {
  const sessions = useHub((s) => s.sessions);
  const roots = useHub((s) => s.devices[device]?.roots);
  return useMemo(() => {
    const seen = new Set<string>();
    for (const s of Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt)) if (s.device === device && s.kind !== 'chat' && s.cwd && s.cwd !== '~' && !(s.meta as { repo?: unknown } | undefined)?.repo) seen.add(s.cwd);
    for (const r of roots ?? []) seen.add(r);
    return [...seen].slice(0, 5);
  }, [sessions, roots, device]);
}

/** The folder chip. `cwd` undefined reads "Choose folder"; a pick calls onCwd with the path ("~" for the home folder). */
export function FolderChip({ device, cwd, onCwd, open: openProp, onOpenChange }: { device: string; cwd?: string; onCwd: (cwd: string) => void; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setOwn(v));
  const name = useHub((s) => s.devices[device]?.name ?? device);
  const known = useKnownFolders(device);
  const [path, setPath] = useState(cwd ?? '');
  useEffect(() => {
    if (open) setPath(cwd && cwd !== '~' ? cwd : '');
  }, [open, cwd]);
  const set = (p: string) => {
    onCwd(p.trim() || '~');
    setOpen(false);
  };
  const shown = cwd && cwd !== '~' ? shortPath(cwd, 2) : undefined;
  return (
    <>
      <PickerButton ref={ref} look="text" lead={<Folder className="size-3.5 text-fg-3" strokeWidth={1.75} aria-hidden />} aria-label={shown ? `Folder, ${cwd}` : 'Choose folder'} aria-haspopup="dialog" aria-expanded={open} title={cwd} className={cn(CHIP, !shown && 'text-fg')} data-picker="folder" onClick={() => setOpen(!open)}>
        <span className={cn(shown && 'mono')}>{shown ?? 'Choose folder'}</span>
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="top-start" width={340} label="Folder" sheetTitle={`Folder on ${name}`}>
        <form
          className="p-2"
          onSubmit={(e) => {
            e.preventDefault();
            set(path);
          }}
        >
          <label className="mb-1.5 block px-1 text-[12px] text-fg-3 phone:hidden" htmlFor="where-folder">
            Folder on {name}
          </label>
          <div className="flex gap-1.5">
            <Input id="where-folder" autoFocus mono size="sm" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/project" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="flex-1" />
            <Button type="submit" size="md" variant="outline">
              Use
            </Button>
          </div>
        </form>
        {known.length > 0 && (
          <div className="border-t border-rule p-1" role="listbox" aria-label="Recent folders">
            {known.map((k) => (
              <button key={k} type="button" role="option" aria-selected={k === cwd} onClick={() => set(k)} className={cn('flex min-h-[30px] w-full items-center rounded-[var(--r-1)] px-2 text-left font-mono text-[12.5px] hov:bg-hover phone:min-h-11 phone:text-[14px]', k === cwd ? 'text-fg' : 'text-fg-2')}>
                <span className="truncate">{k}</span>
              </button>
            ))}
          </div>
        )}
      </Popover>
    </>
  );
}

/** Places a session can run: the hub first, always, then the computers (not phones), online ones first. */
export function useComputers() {
  const devices = useHub((s) => s.devices);
  return useMemo(() => computerList(devices), [devices]);
}

export function computerList<D extends { id: string; online: boolean; info?: { platform?: string } }>(devices: Record<string, D>): D[] {
  return Object.values(devices)
    .filter((x) => x.id === 'local' || (x.info?.platform !== 'ios' && x.info?.platform !== 'android'))
    .sort((a, b) => Number(b.id === 'local') - Number(a.id === 'local') || Number(b.online) - Number(a.online));
}

/** "+" lists the places as a group: run on the hub or one of the computers. */
export function deviceItems(list: ReturnType<typeof useComputers>, device: string, onDevice: (id: string) => void): MenuItem[] {
  return [{ group: true, label: 'Run on' }, ...list.map((d) => ({ label: placeName(d), detail: d.online ? undefined : 'offline', checked: d.id === device, onSelect: () => d.id !== device && onDevice(d.id) }))];
}

/** The device chip: "on MacBook" or "on madx (hub)", shown when the device is not the obvious one. */
export function DeviceChip({ device, onDevice }: { device: string; onDevice: (id: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const devices = useHub((s) => s.devices);
  const d = devices[device];
  const list = useComputers();
  return (
    <>
      <PickerButton ref={ref} look="text" prefix="on" aria-label={`Device, ${placeName(d, device)}`} aria-haspopup="listbox" aria-expanded={open} className={CHIP} data-picker="device" onClick={() => setOpen(!open)}>
        {placeName(d, device)}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="top-start" width={300} label="Device" sheetTitle="Device">
        <div role="listbox" aria-label="Device" className="p-1">
          {list.map((dev) => (
            <button
              key={dev.id}
              type="button"
              role="option"
              aria-selected={device === dev.id}
              onClick={() => {
                if (dev.id !== device) onDevice(dev.id);
                setOpen(false);
              }}
              className={cn('flex min-h-[30px] w-full items-center gap-2 rounded-[var(--r-1)] px-2 text-left text-[13px] hov:bg-hover phone:min-h-11 phone:text-[15px]', device === dev.id ? 'text-fg' : 'text-fg-2')}
            >
              <span className={cn('min-w-0 flex-1 truncate', device === dev.id && 'font-medium')}>{placeName(dev)}</span>
              <span className={cn('text-[12px]', dev.online ? 'text-ok' : 'text-fg-3')}>{dev.online ? 'online' : 'offline'}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
