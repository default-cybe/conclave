/**
 * Devices > Folders (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.13): where each
 * project lives on this device and how Conclave found it, the path pairs it
 * learned ("~/code on arch-desktop is ~/Developer here"), mappings it
 * suggests from imported sessions (Confirm), and one Syncthing line.
 */
import { useState } from 'react';
import type { DeviceFoldersDto, LocationVia, PathPrefixDto } from '@conclave/core/client';
import type { Device } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, useHub } from '@/store/store';
import { useLoad } from '@/lib/hooks';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { tildePath } from '../chat/FolderChooser';
import { ShareProjectButton } from '../friends/ShareProject';

export const VIA_WORDS: Record<LocationVia, string> = {
  origin: 'where it started',
  'same-path': 'same path',
  pinned: 'pinned',
  syncthing: 'Syncthing',
  prefix: 'path pair',
  search: 'found by search',
  chosen: 'chosen',
};

export function Folders({ d }: { d: Device }) {
  const devices = useHub((s) => s.devices);
  const [busy, setBusy] = useState<string>();
  const data = useLoad<DeviceFoldersDto | undefined>(() => api().deviceFolders(d.id).catch(() => undefined), [d.id, d.online]);
  const f = data.data;
  const home = (id: string) => devices[id]?.info?.home;
  const show = (id: string, p: string) => tildePath(p, home(id));
  const nameOf = (id: string) => devices[id]?.name ?? id;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    const ok = await attempt(fn);
    setBusy(undefined);
    if (ok !== undefined) data.reload();
  };

  const pair = (p: PathPrefixDto) => {
    const here = p.toDevice === d.id ? { mine: p.toPrefix, other: p.fromDevice, theirs: p.fromPrefix } : { mine: p.fromPrefix, other: p.toDevice, theirs: p.toPrefix };
    return (
      <div key={p.id} className="flex items-baseline gap-3 py-2.5">
        <span className="min-w-0 flex-1 text-[13px] text-fg-2 phone:text-[14px]">
          <span className="mono text-fg">{show(here.other, here.theirs)}</span> on {nameOf(here.other)} is <span className="mono text-fg">{show(d.id, here.mine)}</span> here
          <span className="text-fg-3">, {p.confirmations === 1 ? 'confirmed once' : `confirmed ${p.confirmations} times`}</span>
        </span>
        <TextAction label={busy === p.id ? 'Removing' : 'Remove'} onClick={() => void run(p.id, () => api().deletePathPrefix(p.id))} />
      </div>
    );
  };

  return (
    <section aria-labelledby={`folders-${d.id}`} className="space-y-6">
      <div>
        <SectionHeading id={`folders-${d.id}`} count={f?.locations.length || undefined}>
          Folders
        </SectionHeading>
        <p className="mt-2.5 mb-1 text-[12px] text-fg-3 phone:text-[13px]">Where each project lives on {d.name}. A session that moves here opens the same project in its folder.</p>
        {!f ? (
          <LoadingRows loading={data.loading} rows={3} />
        ) : f.locations.length ? (
          <div className="rows">
            {f.locations.map((l) => (
              <div key={`${l.projectId}:${l.path}`} className="flex items-baseline gap-3 py-2.5">
                <span className="w-[110px] shrink-0 truncate text-[13.5px] font-medium text-fg phone:w-auto phone:max-w-[40%] phone:text-[15px]">{l.projectName}</span>
                <span className="mono min-w-0 flex-1 truncate text-[13px] text-fg-2">{show(d.id, l.path)}</span>
                <span className="shrink-0 text-[12px] text-fg-3 phone:hidden">{VIA_WORDS[l.via]}</span>
                <ShareProjectButton projectId={l.projectId} name={l.projectName} />
                <TextAction label={busy === `${l.projectId}:${l.path}` ? 'Removing' : 'Remove'} onClick={() => void run(`${l.projectId}:${l.path}`, () => api().unpinLocation(l.projectId, d.id, l.path))} />
              </div>
            ))}
          </div>
        ) : (
          <p className="py-2.5 text-[13px] text-fg-2 phone:text-[14px]">No project folders known on {d.name} yet. They appear when a session runs or moves here.</p>
        )}
      </div>

      {f && f.suggestions.length > 0 && (
        <div>
          <SectionHeading count={f.suggestions.length} countTone="warn">
            Suggested
          </SectionHeading>
          <div className="rows">
            {f.suggestions.map((s) => (
              <div key={s.id} className="flex items-baseline gap-3 py-2.5">
                <span className="min-w-0 flex-1 text-[13px] text-fg-2 phone:text-[14px]">
                  <span className="mono text-fg">{show(d.id, s.toPath)}</span> is {s.projectName} from {nameOf(s.fromDevice)} (<span className="mono">{show(s.fromDevice, s.fromPath)}</span>)
                  <span className="block text-[12px] text-fg-3 phone:text-[13px]">{s.reason}</span>
                </span>
                {d.online ? (
                  <TextAction label={busy === s.id ? 'Checking' : 'Confirm'} onClick={() => void run(s.id, () => api().pinLocation(s.projectId, d.id, s.toPath))} />
                ) : (
                  <span className="shrink-0 text-[12px] text-fg-3">confirm when online</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {f && f.prefixes.length > 0 && (
        <div>
          <SectionHeading count={f.prefixes.length}>Path pairs</SectionHeading>
          <div className="rows">{f.prefixes.map(pair)}</div>
        </div>
      )}

      {f && (
        <p className="m-0 text-[13px] text-fg-2 phone:text-[14px]">
          <span className="text-fg-3">Syncthing</span> {f.syncthing.line}
        </p>
      )}
    </section>
  );
}
