/**
 * Choose folder (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.6): when a session moves
 * to a device where Conclave did not find its project, this sheet browses
 * that device, starting at the best guess, and says in one line how each
 * folder compares with the old copy ("Same git history and remote as the
 * arch-desktop copy"). A different history offers Use once and Use and
 * remember. Clone here and Continue without files are the way out when the
 * folder is not there at all.
 *
 * moveSessionTo() is what the device picker, /device and the location
 * banner call: it moves the session and opens this sheet when the move
 * could not find a folder.
 */
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { ChevronLeft } from 'lucide-react';
import type { FileEntryDto, FolderCandidate, IdentifyResult, MatchLevel, MoveInput, MoveResult } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, toast, upsertSession, useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Button, IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Overlay';
import { StateWord } from '@/components/ui/List';
import { LoadingRows } from '@/components/ui/EmptyState';

type NotResolved = Extract<MoveResult, { resolved: false }>;

/** Show a path with ~ for the device's home. */
export function tildePath(path: string, home?: string): string {
  if (!home || home === '/' || home === '~') return path;
  const h = home.replace(/\/+$/, '');
  if (path === h) return '~';
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

export const LEVEL_WORD: Record<MatchLevel, string> = {
  exact: 'exact match',
  strong: 'strong match',
  weak: 'name only',
  none: 'no match',
  mismatch: 'different history',
};

export const LEVEL_TONE: Record<MatchLevel, 'ok' | 'neutral' | 'dim' | 'warn' | 'fault'> = {
  exact: 'ok',
  strong: 'ok',
  weak: 'dim',
  none: 'dim',
  mismatch: 'warn',
};

interface ChooserRequest {
  sessionId: string;
  device: string;
  /** The move that found nothing (candidates, clone URL, where to start). */
  result?: NotResolved;
  /** Start browsing here when there is no result. */
  start?: string;
  /** What the sheet is for: choose a folder, or pick where to clone. */
  intent?: 'choose' | 'clone';
  /** The project's name, for the folder a clone goes into. */
  projectName?: string;
}

export const useFolderChooser = create<{ req?: ChooserRequest; show: (r: ChooserRequest) => void; hide: () => void }>((set) => ({
  req: undefined,
  show: (req) => set({ req }),
  hide: () => set({ req: undefined }),
}));

/**
 * After a move. The hub writes the one line ("Moved to macbook at
 * ~/Developer/portfolio (Syncthing).") into the transcript, so a toast is
 * needed only when the chat is not on screen.
 */
function announce(r: Extract<MoveResult, { resolved: true }>) {
  if (location.pathname === `/s/${r.session.id}`) return;
  const stale = r.freshness?.stale && r.freshness.line;
  toast({ title: r.line, body: stale || undefined, level: stale || r.level === 'mismatch' ? 'warning' : 'success' });
}

/**
 * Move a session to a device (and folder). A move that cannot find the
 * folder opens Choose folder with what it found.
 */
export async function moveSessionTo(session: Pick<Session, 'id' | 'device'>, device: string, extra: Partial<MoveInput> = {}): Promise<MoveResult | undefined> {
  const r = await attempt(() => api().moveSession(session.id, { device, ...extra }));
  if (!r) return undefined;
  if (r.resolved) {
    upsertSession(r.session);
    announce(r);
    if (useFolderChooser.getState().req?.sessionId === session.id) useFolderChooser.getState().hide();
  } else if (r.reason === 'offline') {
    toast({ title: r.line, body: 'Moving needs the device online, to find the folder there.', level: 'warning' });
  } else {
    useFolderChooser.getState().show({ sessionId: session.id, device, result: r });
  }
  return r;
}

function parentOf(path: string): string | undefined {
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  if (i < 0) return undefined;
  if (i === 0) return p === '/' ? undefined : '/';
  return p.slice(0, i);
}

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

/** Mounted once per chat (LocationBanner): the sheet, when something asked for it. */
export function FolderChooserHost() {
  const req = useFolderChooser((s) => s.req);
  const hide = useFolderChooser((s) => s.hide);
  if (!req) return null;
  return <FolderChooser key={`${req.sessionId}:${req.device}:${req.intent ?? 'choose'}`} req={req} onClose={hide} />;
}

function FolderChooser({ req, onClose }: { req: ChooserRequest; onClose: () => void }) {
  const session = useHub((s) => s.sessions[req.sessionId]);
  const device = useHub((s) => s.devices[req.device]);
  const home = device?.info?.home;
  const deviceName = device?.name ?? req.device;
  const roots = device?.roots ?? [];
  const startAt = req.result?.browseFrom ?? req.start ?? roots[0] ?? home ?? '~';
  const [path, setPath] = useState(startAt);
  const [typed, setTyped] = useState(tildePath(startAt, home));
  const [entries, setEntries] = useState<FileEntryDto[] | undefined>();
  const [browseError, setBrowseError] = useState<string>();
  const [check, setCheck] = useState<IdentifyResult | undefined>();
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | false>(false);
  const [mismatch, setMismatch] = useState<string | undefined>();
  const candidates: FolderCandidate[] = req.result?.candidates ?? [];
  const cloneUrl = req.result?.cloneUrl;
  // the cwd may be a folder inside the project, so the project's own name comes first
  const projectName = useMemo(() => req.projectName || baseName(session?.cwd ?? ''), [req.projectName, session?.cwd]);
  const cloning = req.intent === 'clone';

  // list the folder
  useEffect(() => {
    let alive = true;
    setEntries(undefined);
    setBrowseError(undefined);
    api()
      .browse(req.device, path)
      .then((list) => alive && setEntries(list.filter((e) => e.type === 'dir' || e.type === 'symlink').sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => alive && setBrowseError(e instanceof Error ? e.message : String(e)));
    setTyped(tildePath(path, home));
    setMismatch(undefined);
    return () => {
      alive = false;
    };
  }, [req.device, path, home]);

  // how the folder compares with the old copy, a moment after the owner stops moving
  useEffect(() => {
    if (cloning) return;
    let alive = true;
    setCheck(undefined);
    setChecking(true);
    const t = setTimeout(() => {
      api()
        .identifyFolder({ device: req.device, path, sessionId: req.sessionId })
        .then((r) => alive && setCheck(r))
        .catch(() => alive && setCheck(undefined))
        .finally(() => alive && setChecking(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [req.device, req.sessionId, path, cloning]);

  const use = async (opts: { remember?: boolean; allowMismatch?: boolean }) => {
    if (!session) return;
    setBusy(opts.remember ? 'Saving' : 'Moving');
    const r = await attempt(() => api().moveSession(session.id, { device: req.device, cwd: path, ...opts }));
    setBusy(false);
    if (!r) return;
    if (r.resolved) {
      upsertSession(r.session);
      announce(r);
      onClose();
    } else if (r.reason === 'mismatch') setMismatch(r.line);
    else toast({ title: r.line, level: 'warning' });
  };

  const clone = async () => {
    if (!session || !cloneUrl) return;
    setBusy('Cloning');
    const into = `${path.replace(/\/+$/, '')}/${projectName}`;
    const r = await attempt(() => api().moveSession(session.id, { device: req.device, clone: { url: cloneUrl, into } }));
    setBusy(false);
    if (r?.resolved) {
      upsertSession(r.session);
      announce(r);
      onClose();
    }
  };

  const withoutFiles = async () => {
    if (!session) return;
    setBusy('Moving');
    const r = await moveSessionTo(session, req.device, { withoutFiles: true });
    setBusy(false);
    if (r?.resolved) onClose();
  };

  const differs = check?.level === 'mismatch' || !!mismatch;
  const up = parentOf(path);
  const title = cloning ? `Clone ${projectName} on ${deviceName}` : `Choose the folder on ${deviceName}`;
  const description = cloning ? `Pick the folder to clone into. The copy goes in ${tildePath(path, home)}/${projectName}.` : (req.result?.line ?? `Pick the folder this session should use on ${deviceName}.`);

  const footer = differs ? (
    <>
      <Button variant="quiet" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="outline" busy={busy === 'Moving' ? 'Moving' : false} onClick={() => void use({ allowMismatch: true })}>
        Use once
      </Button>
      <Button variant="solid" busy={busy === 'Saving' ? 'Saving' : false} onClick={() => void use({ allowMismatch: true, remember: true })}>
        Use and remember
      </Button>
    </>
  ) : cloning ? (
    <>
      <Button variant="quiet" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="solid" busy={busy === 'Cloning' ? 'Cloning' : false} disabled={!cloneUrl} onClick={() => void clone()}>
        Clone here
      </Button>
    </>
  ) : (
    <>
      <Button variant="quiet" busy={busy === 'Moving' ? 'Moving' : false} onClick={() => void withoutFiles()} className="mr-auto phone:mr-0">
        Continue without files
      </Button>
      {cloneUrl && (
        <Button variant="outline" busy={busy === 'Cloning' ? 'Cloning' : false} onClick={() => void clone()}>
          Clone here
        </Button>
      )}
      <Button variant="solid" busy={busy === 'Moving' || busy === 'Saving' ? busy : false} onClick={() => void use({})}>
        Use this folder
      </Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title={title} description={description} width={600} footer={footer} bodyClassName="pb-3">
      {!cloning && candidates.length > 0 && (
        <section aria-label="Closest folders" className="mb-4">
          <h3 className="mb-1 text-[12px] font-medium text-fg-3 phone:text-[13px]">Closest folders</h3>
          <div className="rows">
            {candidates.map((c) => (
              <button
                key={c.path}
                type="button"
                onClick={() => setPath(c.path)}
                className={cn('flex w-full items-baseline gap-3 py-2 text-left hov:bg-hover phone:py-2.5', path === c.path && 'bg-raise')}
              >
                <span className="min-w-0 flex-1">
                  <span className="mono block truncate text-[13px] text-fg phone:text-[14px]">{tildePath(c.path, home)}</span>
                  <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">{c.line}</span>
                </span>
                <StateWord tone={LEVEL_TONE[c.level]}>{LEVEL_WORD[c.level]}</StateWord>
              </button>
            ))}
          </div>
        </section>
      )}

      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const t = typed.trim();
          if (t) setPath(t.startsWith('~') && home ? `${home}${t.slice(1)}` : t);
        }}
      >
        <IconButton label="Up one folder" size="md" variant="quiet" disabled={!up} onClick={() => up && setPath(up)}>
          <ChevronLeft />
        </IconButton>
        <Input mono size="sm" aria-label="Folder path" value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 flex-1" />
        <Button type="submit" variant="outline" size="md">
          Go
        </Button>
      </form>

      {!cloning && (
        <p aria-live="polite" className="mt-2 flex min-h-[20px] items-baseline gap-3 text-[13px] phone:text-[14px]">
          <span className={cn('min-w-0 flex-1', differs ? 'text-warn' : 'text-fg-2')}>{mismatch ?? check?.line ?? (checking ? 'Checking this folder' : '')}</span>
          {check && <StateWord tone={LEVEL_TONE[check.level]}>{LEVEL_WORD[check.level]}</StateWord>}
        </p>
      )}

      <div className="mt-2 max-h-[38vh] min-h-[120px] overflow-y-auto border-t border-rule phone:max-h-[34vh]">
        {browseError ? (
          <p className="py-3 text-[13px] text-fault">{browseError}</p>
        ) : !entries ? (
          <LoadingRows loading rows={4} />
        ) : entries.length ? (
          <div className="rows">
            {entries.map((e) => (
              <button key={e.path} type="button" onClick={() => setPath(e.path)} className="mono flex w-full items-center py-1.5 text-left text-[13px] text-fg-2 hov:bg-hover hov:text-fg phone:py-2.5 phone:text-[14px]">
                <span className="min-w-0 flex-1 truncate">{e.name}/</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="py-3 text-[13px] text-fg-3">No folders in here.</p>
        )}
      </div>
      {roots.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-3 phone:text-[13px]">
          Roots on {deviceName}:
          {roots.map((r) => (
            <button key={r} type="button" className="mono text-fg-3 hover:text-fg" onClick={() => setPath(home && r.startsWith('~') ? `${home}${r.slice(1)}` : r)}>
              {r}
            </button>
          ))}
        </p>
      )}
    </Dialog>
  );
}
