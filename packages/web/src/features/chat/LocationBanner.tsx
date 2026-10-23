/**
 * The location banner (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.13): one line above
 * the composer, only when the session's folder needs the owner.
 *
 * - offline: "arch-desktop is offline. Your folder is also on macbook at
 *   ~/Developer/portfolio (Syncthing)." Run on macbook, Wait.
 * - missing: the folder is not on the device. Choose folder, Clone here,
 *   Continue without files. After Continue without files the line stays
 *   (Look again, Hide) until the project's folder is found.
 * - stale: the copy here is behind the old one. Check again, Continue.
 * - mismatch: the folder has another git history. Choose folder.
 *
 * It also hosts the Choose folder sheet for this chat.
 */
import { useEffect, useState } from 'react';
import type { SessionLocationDto } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Overlay';
import { useIsMobile } from '@/lib/hooks';
import { FolderChooserHost, moveSessionTo, useFolderChooser } from './FolderChooser';
import { sessionRepo } from '@/lib/github';

/** A state the owner set aside ("Wait", "Continue") stays hidden until it changes. */
function stateKey(loc: SessionLocationDto): string {
  return `${loc.sessionId}:${loc.device}:${loc.cwd}:${loc.state}:${loc.line ?? ''}`;
}

const HIDDEN_KEY = 'conclave.location.hidden';

/** States set aside in this browser, so Continue holds when the chat is opened again. */
function loadHidden(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveHidden(set: Set<string>): void {
  try {
    // the newest 100 are enough
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set].slice(-100)));
  } catch {
    /* private window or blocked storage: it holds until the chat closes */
  }
}

export function LocationBanner({ session }: { session: Session }) {
  const online = useHub((s) => s.devices[session.device]?.online);
  const devices = useHub((s) => s.devices);
  const mobile = useIsMobile();
  const [loc, setLoc] = useState<SessionLocationDto>();
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [busy, setBusy] = useState<string | false>(false);
  const [tick, setTick] = useState(0);
  const parked = session.status === 'waiting_input';

  useEffect(() => {
    if (session.kind === 'chat') return;
    let alive = true;
    api()
      .sessionLocation(session.id, tick > 0)
      .then((l) => alive && setLoc(l))
      .catch(() => alive && setLoc(undefined));
    return () => {
      alive = false;
    };
  }, [session.id, session.device, session.cwd, session.kind, online, parked, tick]);

  // a repo session that was cleaned up has no worktree by design: nothing to find
  const show = loc && loc.state !== 'ok' && loc.sessionId === session.id && !hidden.has(stateKey(loc)) && !sessionRepo(session)?.cleaned;
  const hide = () =>
    loc &&
    setHidden((h) => {
      const next = new Set(h).add(stateKey(loc));
      saveHidden(next);
      return next;
    });
  const size = mobile ? 'touch' : 'sm';
  const choose = (intent: 'choose' | 'clone' = 'choose') =>
    useFolderChooser.getState().show({ sessionId: session.id, device: session.device, start: loc?.browseFrom, intent, projectName: loc?.projectName, result: loc?.cloneUrl ? { resolved: false, reason: 'not-found', line: loc.line ?? '', candidates: [], cloneUrl: loc.cloneUrl, browseFrom: loc.browseFrom } : undefined });
  const move = async (device: string, extra: Parameters<typeof moveSessionTo>[2] = {}) => {
    setBusy(device);
    await moveSessionTo(session, device, extra);
    setBusy(false);
  };

  let actions: React.ReactNode = null;
  if (loc?.state === 'offline') {
    const others = Object.values(devices).filter((d) => d.online && d.id !== session.device && d.info?.platform !== 'ios' && d.info?.platform !== 'android');
    actions = (
      <>
        <Button variant="quiet" size={size} onClick={hide}>
          Wait
        </Button>
        {loc.suggestion ? (
          <Button variant="solid" size={size} className="phone:order-first" busy={busy === loc.suggestion.device ? 'Moving' : false} onClick={() => void move(loc.suggestion!.device)}>
            Run on {loc.suggestion.deviceName}
          </Button>
        ) : others.length ? (
          <Menu
            label="Run on another device"
            items={others.map((d) => ({ label: d.name, onSelect: () => void move(d.id) }))}
            trigger={({ ref, props }) => (
              <Button ref={ref} variant="outline" size={size} {...props}>
                Run on another device
              </Button>
            )}
          />
        ) : null}
      </>
    );
  } else if (loc?.state === 'missing') {
    actions = (
      <>
        {loc.suggestion && (
          <Button variant="outline" size={size} busy={busy === loc.suggestion.device ? 'Moving' : false} onClick={() => void move(loc.suggestion!.device)}>
            Run on {loc.suggestion.deviceName}
          </Button>
        )}
        {loc.exists ? (
          // already without the project files: look for the folder again, or set the line aside
          <>
            <Button variant="quiet" size={size} onClick={hide}>
              Hide
            </Button>
            <Button variant="outline" size={size} busy={busy === 'again' ? 'Looking' : false} onClick={() => void (setBusy('again'), moveSessionTo(session, session.device).finally(() => setBusy(false)))}>
              Look again
            </Button>
          </>
        ) : (
          <Button variant="quiet" size={size} busy={busy === 'without' ? 'Moving' : false} onClick={() => void (setBusy('without'), moveSessionTo(session, session.device, { withoutFiles: true }).finally(() => setBusy(false)))}>
            Continue without files
          </Button>
        )}
        {loc.cloneUrl && (
          <Button variant="outline" size={size} onClick={() => choose('clone')}>
            Clone here
          </Button>
        )}
        <Button variant="solid" size={size} className="phone:order-first" onClick={() => choose()}>
          Choose folder
        </Button>
      </>
    );
  } else if (loc?.state === 'stale') {
    actions = (
      <>
        <Button variant="quiet" size={size} onClick={() => setTick((t) => t + 1)}>
          Check again
        </Button>
        <Button variant="outline" size={size} className="phone:order-first" onClick={hide}>
          Continue
        </Button>
      </>
    );
  } else if (loc?.state === 'mismatch') {
    actions = (
      <Button variant="outline" size={size} onClick={() => choose()}>
        Choose folder
      </Button>
    );
  }

  return (
    <>
      {show && (
        <div className="mx-auto w-full max-w-[924px] px-8 phone:px-4" data-location-banner={loc.state}>
          <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule py-2.5 phone:py-3">
            <p className="m-0 min-w-0 flex-[1_1_320px] text-[13px] leading-[1.45] text-fg phone:text-[14px]">{loc.line}</p>
            <div className="flex flex-wrap items-center gap-2 phone:w-full">{actions}</div>
          </div>
        </div>
      )}
      <FolderChooserHost />
    </>
  );
}
