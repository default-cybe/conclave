/**
 * Is the folder there? Every place a Code session's folder is chosen or
 * typed (the folder chip, the phone's place sheet, Device and folder, Choose
 * folder) asks the device a moment after the path stops changing, through
 * GET /api/devices/:device/folder. A missing folder shows "No folder at
 * <path> on <device>" under the field, keeps Choose or Start off and offers
 * Create folder (every daemon has mkdir). The hub refuses the same path when
 * a session is made with it (core machine/folder-check.ts), so no client
 * skips the check.
 *
 * An offline device cannot be asked: the line says so and Choose or Start
 * waits for an explicit "Use anyway". The session is made, and its folder
 * found, once the device is back.
 */
import { useEffect, useMemo, useState } from 'react';
import { noFolderLine, offlineFolderLine } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';

export type FolderState = 'ok' | 'checking' | 'missing' | 'offline';

export interface FolderCheck {
  state: FolderState;
  /** Choose or Start may go: the folder is there, no path yet (the home folder), or "Use anyway" on an offline device. */
  ready: boolean;
  line?: string;
  create: () => Promise<void>;
  useAnyway: () => void;
}

const useDevice = (device: string | undefined) => useHub((s) => (device ? s.devices[device] : undefined));

/** The check for one path on one device. An empty path is the home folder: always there. */
export function useFolderCheck(device: string | undefined, path: string, onMade?: () => void): FolderCheck {
  const dev = useDevice(device);
  const online = !!dev?.online;
  const name = dev?.name ?? device ?? '';
  const p = path.trim();
  const key = `${device}\n${p}`;
  // the answer for the path it was asked about; a newer path reads as checking until its own answer
  const [seen, setSeen] = useState<{ key: string; exists: boolean }>();
  const [anyway, setAnyway] = useState<string>();
  useEffect(() => {
    if (!device || !p || !online) return;
    let live = true;
    const t = setTimeout(() => {
      api()
        .folderCheck(device, p)
        .then((r) => live && setSeen({ key, exists: r.exists }))
        // a check that fails (no reply, a refused path) is not a missing folder: the hub has the last word
        .catch(() => live && setSeen({ key, exists: true }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [device, p, online, key]);

  const state: FolderState = !device || !p ? 'ok' : !online ? 'offline' : seen?.key !== key ? 'checking' : seen.exists ? 'ok' : 'missing';
  return {
    state,
    ready: state === 'ok' || (state === 'offline' && anyway === key),
    line: state === 'missing' ? noFolderLine(p, name) : state === 'offline' ? offlineFolderLine(name) : undefined,
    create: async () => {
      if (!device) return;
      const r = await attempt(() => api().makeFolder(device, p));
      if (r) {
        setSeen({ key, exists: r.exists });
        onMade?.();
      }
    },
    useAnyway: () => setAnyway(key),
  };
}

/** The line under a folder field: the missing folder with Create folder, or the offline device with Use anyway. */
export function FolderCheckNote({ check, className }: { check: FolderCheck; className?: string }) {
  if (check.state !== 'missing' && check.state !== 'offline') return null;
  const missing = check.state === 'missing';
  return (
    <div className={className} data-folder-check={check.state}>
      <p role={missing ? 'alert' : undefined} className={missing ? 'm-0 text-[12.5px] text-fault phone:text-[14px]' : 'm-0 text-[12.5px] text-fg-2 phone:text-[14px]'}>
        {check.line}
      </p>
      {missing ? (
        <Button size="sm" variant="outline" className="mt-1.5" onClick={() => void check.create()}>
          Create folder
        </Button>
      ) : (
        !check.ready && (
          <Button size="sm" variant="outline" className="mt-1.5" onClick={check.useAnyway}>
            Use anyway
          </Button>
        )
      )}
    </div>
  );
}

/**
 * Recent or remembered folders that are gone from the device, to mark them
 * "missing" in the list. Nothing is marked while the device is offline.
 */
export function useMissingFolders(device: string | undefined, paths: string[]): Set<string> {
  const online = !!useDevice(device)?.online;
  const key = paths.join('\n');
  const [missing, setMissing] = useState<{ key: string; set: Set<string> }>();
  useEffect(() => {
    if (!device || !online || !key) return;
    let live = true;
    const list = key.split('\n');
    void Promise.all(list.map((p) => api().folderCheck(device, p).then((r) => (r.exists ? undefined : p), () => undefined))).then((gone) => {
      if (live) setMissing({ key: `${device}\n${key}`, set: new Set(gone.filter((p): p is string => !!p)) });
    });
    return () => {
      live = false;
    };
  }, [device, online, key]);
  return useMemo(() => (missing?.key === `${device}\n${key}` ? missing.set : new Set<string>()), [missing, device, key]);
}
