/**
 * Where Code works, as one small chip in the composer's quiet row (design
 * review #6): the folder ("Choose folder" until one is set, then its path,
 * and always open to change) and, when there is more than one place to run,
 * the device after a dot: "~/code/conclave · arch-desktop". Its popover
 * holds both. The hub is always one of the places, by its name: "madx (hub)".
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
import { StateWord } from '@/components/ui/List';
import { placeName } from './start';
import { FolderCheckNote, useFolderCheck, useMissingFolders } from '@/features/chat/folderCheck';

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

/**
 * The folder and device chip. `cwd` undefined reads "Choose folder"; a pick
 * calls onCwd with the path ("~" for the home folder). No `onCwd`: the folder
 * is not this chip's to change (a repository), so it is the device only, "on
 * MacBook". `onDevice` adds the device while there is more than one place to
 * run. Nothing to show: no chip.
 */
export function FolderChip({ device, cwd, onCwd, onDevice, open: openProp, onOpenChange }: { device: string; cwd?: string; onCwd?: (cwd: string) => void; onDevice?: (id: string) => void; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setOwn(v));
  const name = useHub((s) => s.devices[device]?.name ?? device);
  const d = useHub((s) => s.devices[device]);
  const list = useComputers();
  const devices = !!onDevice && list.length > 1;
  const known = useKnownFolders(device);
  const [path, setPath] = useState(cwd ?? '');
  useEffect(() => {
    if (open) setPath(cwd && cwd !== '~' ? cwd : '');
  }, [open, cwd]);
  const set = (p: string) => {
    onCwd?.(p.trim() || '~');
    setOpen(false);
  };
  // a typed path is asked of the device; a recent one that is gone is marked, not offered (features/chat/folderCheck.tsx)
  const check = useFolderCheck(device, open ? path : '');
  const gone = useMissingFolders(device, open ? known : []);
  if (!onCwd && !devices) return null;
  const shown = cwd && cwd !== '~' ? shortPath(cwd, 2) : undefined;
  const place = placeName(d, device);
  const folderWords = shown ? `Folder, ${cwd}` : 'Choose folder';
  return (
    <>
      <PickerButton
        ref={ref}
        look="text"
        prefix={onCwd ? undefined : 'on'}
        lead={onCwd ? <Folder className="size-3.5 text-fg-3" strokeWidth={1.75} aria-hidden /> : undefined}
        aria-label={onCwd ? (devices ? `${folderWords}, on ${place}` : folderWords) : `Device, ${place}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={cwd}
        className={cn(CHIP, onCwd && !shown && 'text-fg')}
        data-picker="folder"
        onClick={() => setOpen(!open)}
      >
        {onCwd && <span className={cn(shown && 'mono')}>{shown ?? 'Choose folder'}</span>}
        {onCwd && devices && <span className="text-fg-3"> · </span>}
        {devices && <span className={cn(onCwd && 'text-fg-3')}>{place}</span>}
      </PickerButton>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement="top-start" width={340} label={onCwd ? 'Folder' : 'Device'} sheetTitle={onCwd ? `Folder on ${name}` : 'Device'}>
        {onCwd && (
        <form
          className="p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (check.ready) set(path);
          }}
        >
          <label className="mb-1.5 block px-1 text-[12px] text-fg-3 phone:hidden" htmlFor="where-folder">
            Folder on {name}
          </label>
          <div className="flex gap-1.5">
            <Input id="where-folder" autoFocus mono size="sm" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/code/project" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="flex-1" />
            <Button type="submit" size="md" variant="outline" disabled={!check.ready}>
              Use
            </Button>
          </div>
          <FolderCheckNote check={check} className="mt-1.5 px-1" />
        </form>
        )}
        {onCwd && known.length > 0 && (
          <div className="border-t border-rule p-1" role="listbox" aria-label="Recent folders">
            {known.map((k) => (
              <button key={k} type="button" role="option" aria-selected={k === cwd} aria-disabled={gone.has(k) || undefined} onClick={() => !gone.has(k) && set(k)} className={cn('flex min-h-[30px] w-full items-center gap-2 rounded-[var(--r-1)] px-2 text-left font-mono text-[12.5px] phone:min-h-11 phone:text-[14px]', gone.has(k) ? 'cursor-default text-fg-3' : 'hov:bg-hover', !gone.has(k) && (k === cwd ? 'text-fg' : 'text-fg-2'))}>
                <span className="min-w-0 flex-1 truncate">{k}</span>
                {gone.has(k) && <StateWord tone="warn">missing</StateWord>}
              </button>
            ))}
          </div>
        )}
        {devices && (
          <div role="listbox" aria-label="Device" className={cn('p-1', onCwd && 'border-t border-rule')}>
            {onCwd && <div role="presentation" className="px-2 pt-1 pb-0.5 text-[12px] text-fg-3 phone:text-[13px]">Run on</div>}
            {list.map((dev) => (
              <button
                key={dev.id}
                type="button"
                role="option"
                aria-selected={device === dev.id}
                onClick={() => {
                  if (dev.id !== device) onDevice!(dev.id);
                  setOpen(false);
                }}
                className={cn('flex min-h-[30px] w-full items-center gap-2 rounded-[var(--r-1)] px-2 text-left text-[13px] hov:bg-hover phone:min-h-11 phone:text-[15px]', device === dev.id ? 'text-fg' : 'text-fg-2')}
              >
                <span className={cn('min-w-0 flex-1 truncate', device === dev.id && 'font-medium')}>{placeName(dev)}</span>
                <span className={cn('text-[12px]', dev.online ? 'text-ok' : 'text-fg-3')}>{dev.online ? 'online' : 'offline'}</span>
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
