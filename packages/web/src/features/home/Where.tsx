/**
 * Where Code works, as one small chip in the composer's quiet row (design
 * review #6): the folder ("Choose folder" until one is set, then its path,
 * and always open to change) and, when there is more than one place to run,
 * the device after a dot: "~/code/conclave · arch-desktop". Its popover
 * holds both. The hub is always one of the places, by its name: "madx (hub)".
 */
import { useMemo, useRef, useState } from 'react';
import { Folder } from 'lucide-react';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { shortPath } from '@/lib/format';
import { Popover, type MenuItem } from '@/components/ui/Overlay';
import { PickerButton } from '@/components/ui/Select';
import { placeName } from './start';
import { FolderMenu, useOpenFolder } from './FolderPicker';

const CHIP = 'h-[24px] text-[12px] phone:text-[13px]';

/**
 * The folder and device chip. `cwd` undefined reads "Choose folder"; a pick
 * calls onCwd with the path ("~" for No folder). The menu is FolderMenu
 * (FolderPicker.tsx), with the device as its "On <device>" row. No `onCwd`:
 * the folder is not this chip's to change (a repository), so it is the
 * device only, "on MacBook". `onDevice` adds the device while there is more
 * than one place to run. Nothing to show: no chip.
 */
export function FolderChip({ device, cwd, onCwd, onDevice, open: openProp, onOpenChange }: { device: string; cwd?: string; onCwd?: (cwd: string) => void; onDevice?: (id: string) => void; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setOwn(v));
  const name = useHub((s) => s.devices[device]?.name ?? device);
  const d = useHub((s) => s.devices[device]);
  const member = useHub((s) => s.me?.role === 'member');
  // as Device and folder (pickers.tsx): a member's code never runs on the hub
  const list = useComputers().filter((x) => !member || x.id !== 'local');
  const devices = !!onDevice && list.length > 1;
  const set = (p: string) => {
    onCwd?.(p.trim() || '~');
    setOpen(false);
  };
  // Open folder…: native on this desktop's paired device, then the shared validation and project browser.
  const browse = useOpenFolder(device, cwd, (p) => onCwd?.(p));
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
          <FolderMenu
            device={device}
            cwd={cwd}
            onPick={set}
            onDevice={onDevice}
            onClose={() => setOpen(false)}
            onOpenFolder={() => {
              setOpen(false);
              browse.open();
            }}
          />
        )}
        {devices && !onCwd && (
          <div role="listbox" aria-label="Device" className="p-1">
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
      {onCwd && browse.browser}
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
