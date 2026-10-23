/**
 * Updates in the shell (docs/DESIGN.md, Updates):
 *
 *   "Conclave was updated. Reload"   a quiet line under the top of the page:
 *                                    the hub's version changed while this page
 *                                    was open (the web app and the iPhone home
 *                                    screen app are served by the hub); once per
 *                                    new version
 *   "Conclave 0.5.0 is ready"        the owner only: a popup at app start for a
 *                                    newer release, with what is new, Update now
 *                                    (or How to update when the hub updates
 *                                    another way), Skip this version and "Don't
 *                                    show at startup". Skipped, it waits for a
 *                                    newer version; turned off, the release
 *                                    shows only as a dot on the account row and
 *                                    in Settings > About, whose switch turns the
 *                                    popup back on.
 *
 * The hub's update status is read here once for the shell (and each hour,
 * and every 2s while an update runs) and kept in useHubUpdate, so the
 * popup, the account row's dot and About agree.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { create } from 'zustand';
import type { UpdateStatusDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useHub, toast } from '@/store/store';
import { useIsOwner } from '@/lib/people';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button, buttonClass } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Overlay';
import { LiveStatus } from '@/components/motion';
import { hubBanner, jobRunning, jobWords, popupFor, popupTitle, RELOAD_WORDS, showReload, updateDot, type UpdatePrefs } from '@/lib/updates';

const SKIP_KEY = 'conclave.update.skip';
/** The old banner's Later: the version it was put off for counts as skipped. */
const LATER_KEY = 'conclave.update.later';
const STARTUP_KEY = 'conclave.update.startup';

function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a private window: it comes back next time */
  }
}

export function readUpdatePrefs(): UpdatePrefs {
  const skipped = read(SKIP_KEY) ?? read(LATER_KEY);
  return { ...(skipped ? { skipped } : {}), startup: read(STARTUP_KEY) !== '0' };
}

interface HubUpdate {
  /** The hub's update status, for the owner; undefined until read (and always for a member). */
  status?: UpdateStatusDto;
  prefs: UpdatePrefs;
}

export const useHubUpdate = create<HubUpdate>(() => ({ prefs: readUpdatePrefs() }));

/** Skip this version: no popup and no dot until a newer one. */
export function skipVersion(version: string) {
  write(SKIP_KEY, version);
  useHubUpdate.setState((s) => ({ prefs: { ...s.prefs, skipped: version } }));
}

/** Show the popup at app start, or not (Settings > About has the switch). */
export function setUpdateStartup(on: boolean) {
  write(STARTUP_KEY, on ? '1' : '0');
  useHubUpdate.setState((s) => ({ prefs: { ...s.prefs, startup: on } }));
}

/** The status About read: the shell's copy follows it. */
export function setHubUpdateStatus(status: UpdateStatusDto) {
  useHubUpdate.setState({ status });
}

/** The dot on the account row: a newer release waits, not skipped (or an update runs). */
export function useUpdateDot(): boolean {
  return useHubUpdate((s) => updateDot(s.status, s.prefs));
}

// ---------------------------------------------------------------------------
// Conclave was updated
// ---------------------------------------------------------------------------

/** The line the reload banner uses: words, then the buttons. */
export function BannerLine({ words, children }: { words: ReactNode; children?: ReactNode }) {
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-rule bg-raise px-[var(--gutter)] py-1.5 anim-fade phone:py-1">
      <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.4] text-fg phone:text-[14px]">{words}</p>
      {children}
    </div>
  );
}

/** "Conclave was updated." with Reload, as it renders (tests render it too). */
export function ReloadLine({ onReload, onLater, size = 'sm' }: { onReload: () => void; onLater: () => void; size?: 'sm' | 'touch' }) {
  return (
    <BannerLine words={RELOAD_WORDS}>
      <Button variant="ghost" size={size} onClick={onLater}>
        Later
      </Button>
      <Button variant="solid" size={size} onClick={onReload}>
        Reload
      </Button>
    </BannerLine>
  );
}

export function ReloadBanner() {
  const version = useHub((s) => s.hub?.version);
  const mobile = useIsMobile();
  const [loaded, setLoaded] = useState<string>();
  const [closedFor, setClosedFor] = useState<string>();
  // the version this page was loaded with is the first one the hub says
  useEffect(() => {
    if (version && !loaded) setLoaded(version);
  }, [version, loaded]);
  if (!showReload(loaded, version, closedFor)) return null;
  return <ReloadLine size={mobile ? 'touch' : 'sm'} onReload={() => location.reload()} onLater={() => setClosedFor(version)} />;
}

// ---------------------------------------------------------------------------
// The hub's update: read for the shell, and the popup at start
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

/** Reads the hub's update status for the owner: at start, each hour, after the hub restarted, and every 2s while an update runs. */
function useHubUpdateStatus(): boolean {
  const owner = useIsOwner();
  const booted = useHub((s) => s.booted);
  const member = useHub((s) => s.me?.role === 'member');
  const hubVersion = useHub((s) => s.hub?.version);
  const show = booted && owner && !member;
  const running = useHubUpdate((s) => jobRunning(s.status?.job));

  useEffect(() => {
    if (!show) return;
    let stop = false;
    const load = () =>
      void api()
        .hubUpdate()
        .then((s) => !stop && setHubUpdateStatus(s))
        .catch(() => {});
    load();
    const t = setInterval(load, HOUR);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [show, hubVersion]);

  useEffect(() => {
    if (!show || !running) return;
    const t = setInterval(() => {
      void api()
        .hubUpdate()
        .then(setHubUpdateStatus)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [show, running]);
  return show;
}

/** The popup opens once per start of the app, on the first status the hub gives. */
let decided = false;

/** What the popup shows: the release, or the update it started. Tests render it. */
export function UpdatePopupBody({
  status,
  started,
  onUpdate,
  onSkip,
  onClose,
  hideAtStart,
  onHideAtStart,
  size = 'md',
}: {
  status: UpdateStatusDto;
  /** Update now was pressed here: the popup follows the update. */
  started: boolean;
  onUpdate: () => void;
  onSkip: () => void;
  onClose: () => void;
  hideAtStart: boolean;
  onHideAtStart: (v: boolean) => void;
  size?: 'md' | 'touch';
}) {
  const job = status.job;
  if (started && job) {
    const live = jobRunning(job);
    return (
      <div className="space-y-4">
        {live ? <LiveStatus state="tool" label={jobWords(job)} /> : <p className="m-0 text-[14px] leading-[1.5] text-fg">{jobWords(job)}</p>}
        <p className="m-0 text-[13px] leading-[1.5] text-fg-3">{live ? 'The hub restarts on the new version. This page reloads when it is back.' : 'Settings, About has the details.'}</p>
        <div className="flex justify-end">
          <Button variant={live ? 'quiet' : 'solid'} size={size} onClick={onClose}>
            {live ? 'Hide' : 'Close'}
          </Button>
        </div>
      </div>
    );
  }
  const p = popupFor(status, { startup: true });
  const b = hubBanner(status, undefined);
  if (!p || !b) return null;
  const phone = size === 'touch';
  const update = p.canUpdate ? (
    <Button variant="solid" size={size} onClick={onUpdate} data-autofocus className={cn(phone && 'w-full')}>
      Update now
    </Button>
  ) : (
    <Link href="/settings/about" onClick={onClose} data-autofocus className={buttonClass('solid', size, phone ? 'w-full' : undefined)}>
      How to update
    </Link>
  );
  const skip = (
    <Button variant="quiet" size={size} onClick={onSkip} className={cn(phone && 'w-full')}>
      Skip this version
    </Button>
  );
  const hide = <Checkbox checked={hideAtStart} onChange={onHideAtStart} label="Don't show at startup" className={cn(!phone && 'mr-auto')} />;
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="m-0 text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">{p.notes ?? `You have ${status.current}. The new version is signed and ready.`}</p>
        {!p.canUpdate && <p className="m-0 text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">This hub updates another way. Settings, About says how.</p>}
      </div>
      {phone ? (
        <div className="flex flex-col gap-2">
          {update}
          {skip}
          <div className="pt-2">{hide}</div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {hide}
          {skip}
          {update}
        </div>
      )}
    </div>
  );
}

/** The owner's popup at start, and the status the account row's dot and About read. */
export function HubUpdatePopup() {
  const show = useHubUpdateStatus();
  const status = useHubUpdate((s) => s.status);
  const prefs = useHubUpdate((s) => s.prefs);
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const [version, setVersion] = useState<string>();

  // at start: the first status the hub gives decides, once per start of the app
  useEffect(() => {
    if (!show || !status || decided) return;
    decided = true;
    const p = popupFor(status, prefs);
    if (p) {
      setVersion(p.version);
      setOpen(true);
    }
  }, [show, status, prefs]);

  if (!show || !status) return null;
  const close = () => setOpen(false);
  return (
    <Dialog open={open} onClose={close} title={popupTitle(version ?? status.latest?.version ?? status.current)} width={460}>
      <UpdatePopupBody
        status={status}
        started={started}
        size={mobile ? 'touch' : 'md'}
        hideAtStart={!prefs.startup}
        onHideAtStart={(v) => setUpdateStartup(!v)}
        onClose={close}
        onSkip={() => {
          if (version) skipVersion(version);
          close();
        }}
        onUpdate={() => {
          if (!version) return;
          setStarted(true);
          void api()
            .applyHubUpdate(version)
            .then(setHubUpdateStatus)
            .catch((e: Error) => {
              setStarted(false);
              toast({ title: e.message, level: 'error' });
            });
        }}
      />
    </Dialog>
  );
}

export function UpdateBanners() {
  return (
    <>
      <ReloadBanner />
      <HubUpdatePopup />
    </>
  );
}
