/**
 * Pick a folder on a device (spec 11.5 "Folder ... with a browse button that
 * opens the device file browser in a dialog"). Folders only, marked with a
 * trailing slash; a mono breadcrumb on top; Enter or double click opens.
 */
import { Fragment, useEffect, useState } from 'react';
import type { FileEntryDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Overlay';
import { LoadingRows } from '@/components/ui/EmptyState';

function parent(p: string): string {
  const t = p.replace(/\/+$/, '');
  if (t === '~' || t === '' || t === '/') return t || '/';
  const i = t.lastIndexOf('/');
  if (i <= 0) return t.startsWith('/') ? '/' : '~';
  return t.slice(0, i);
}

function join(p: string, name: string): string {
  return `${p.replace(/\/+$/, '')}/${name}`;
}

export function FolderPicker({ open, onClose, device, value, onPick }: { open: boolean; onClose: () => void; device: string; value?: string; onPick: (path: string) => void }) {
  const dev = useHub((s) => s.devices[device]);
  const [path, setPath] = useState(value || '~');
  const [entries, setEntries] = useState<FileEntryDto[] | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) setPath(value || '~');
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setEntries(null);
    setError(undefined);
    api()
      .browse(device, path)
      .then((list) => live && setEntries(list))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not list this folder.'));
    return () => {
      live = false;
    };
  }, [open, device, path]);

  const dirs = (entries ?? []).filter((e) => e.type === 'dir' || e.type === 'symlink').sort((a, b) => a.name.localeCompare(b.name));
  const files = (entries ?? []).filter((e) => e.type === 'file').length;
  const parts = path.split('/').filter((x, i) => x || i === 0);
  const name = dev?.name ?? device;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Choose a folder"
      description={dev && !dev.online ? `${name} is offline, so the list may be out of date.` : `On ${name}.`}
      width={560}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="solid"
            onClick={() => {
              onPick(path);
              onClose();
            }}
          >
            Use this folder
          </Button>
        </>
      }
    >
      <nav aria-label="Path" className="flex flex-wrap items-baseline font-mono text-[12.5px] text-fg-3">
        {parts.map((seg, i) => {
          const to = parts.slice(0, i + 1).join('/') || '/';
          const last = i === parts.length - 1;
          return (
            <Fragment key={to}>
              {i > 0 && (parts[0] === '' && i === 1 ? <span className="px-0.5" /> : <span className="px-1 text-fg-4">/</span>)}
              <button type="button" onClick={() => setPath(to)} aria-current={last ? 'location' : undefined} className={cn('rounded-[2px] hover:text-fg', last ? 'text-fg' : 'text-fg-3')}>
                {seg || '/'}
              </button>
            </Fragment>
          );
        })}
      </nav>
      <div className="mt-3 h-[300px] overflow-y-auto border-y border-rule phone:h-[50vh]" role="listbox" aria-label="Folders">
        {path !== '~' && path !== '/' && (
          <FolderRow label=".." onOpen={() => setPath(parent(path))} />
        )}
        {error && <p className="py-3 text-[13px] text-fault">Failed. {error}</p>}
        {!entries && !error && <LoadingRows loading rows={5} />}
        {entries && dirs.map((d) => <FolderRow key={d.path} label={`${d.name}/`} onOpen={() => setPath(join(path, d.name))} />)}
        {entries && !dirs.length && !error && <p className="py-3 text-[13px] text-fg-3">No folders here{files ? `, ${files} ${files === 1 ? 'file' : 'files'}` : ''}.</p>}
      </div>
      {entries && dirs.length > 0 && files > 0 && <p className="mt-2 text-[12px] text-fg-3">{files === 1 ? '1 file' : `${files} files`} hidden. Only folders are listed.</p>}
    </Dialog>
  );
}

function FolderRow({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      onClick={onOpen}
      className="flex w-full items-center border-b border-rule px-1 py-[7px] text-left font-mono text-[12.5px] text-fg last:border-b-0 hover:bg-hover phone:py-3"
    >
      {label}
    </button>
  );
}
