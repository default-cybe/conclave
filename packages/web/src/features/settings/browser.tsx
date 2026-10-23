/**
 * Settings > Browser: the hub's browser profiles, the sites the owner signed
 * in to with each, and Sign in to a site. That opens a remote view of a
 * profile's page on the hub: the newest frame of the page as a picture,
 * with clicks, scrolling, keys and text sent back. The owner signs in once
 * (Facebook for a Marketplace watch); the login stays in the profile, and
 * watches and the assistant browse with it.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type TouchEvent, type WheelEvent } from 'react';
import type { BrowserInputEvent, BrowserStatusDto, SignInFrameDto, SignInViewDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Overlay';
import { Field, Input, Select } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { agoWords, errText, Group, SettingRow } from './parts';
import { EnginesGroup, newProfileWords, profileHelp, ProfileEngine, ProxyGroup } from './browserParts';
import { SitesAndLogins } from './sitesLogins';

/** Keys the view sends as key presses; everything printable goes as text. */
const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** "Signed in to facebook.com 2d ago" or "No sites yet". */
export function sitesWords(p: BrowserStatusDto['profiles'][number], now = Date.now()): string {
  if (!p.sites.length) return 'No sites signed in yet';
  const [first, ...rest] = p.sites;
  return `Signed in to ${first.host} ${agoWords(first.at, now)}${rest.length ? `, and ${rest.map((s) => s.host).slice(0, 3).join(', ')}` : ''}`;
}

export function BrowserSection() {
  const [s, setS] = useState<BrowserStatusDto>();
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [view, setView] = useState<SignInViewDto>();
  const load = () =>
    api()
      .browserStatus()
      .then(setS)
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void load();
  }, []);
  if (error) return <p className="text-[13px] text-fault">Could not load the browser settings. {error}</p>;
  if (!s) return <LoadingRows loading rows={3} />;
  return (
    <div className="space-y-9">
      {s.engines && <EnginesGroup s={s} onStatus={setS} />}

      <Group
        title="Profiles"
        count={s.profiles.length}
        help={`The assistant and watches browse with these. Each keeps its own logins. A watch that needs a login uses the profile you signed in with.${s.newProfileEngine ? ` ${newProfileWords(s.newProfileEngine)}` : ''}`}
      >
        {s.profiles.map((p) => (
          <SettingRow key={p.name} label={p.name} help={profileHelp(p, sitesWords(p))}>
            {s.engines ? <ProfileEngine p={p} s={s} onStatus={setS} /> : <span className="text-[13px] text-fg-2 phone:text-[14px]">{sitesWords(p)}</span>}
          </SettingRow>
        ))}
        {!s.available && <p className="py-3 text-[13px] text-fault">{s.reason ?? 'The browser is not available on this hub.'}</p>}
      </Group>

      <SitesAndLogins s={s} onStatus={setS} />

      {s.proxy && <ProxyGroup s={s} onStatus={setS} />}

      <Group title="Sign in to a site" help="Opens the site in a profile on the hub and shows it here. Click and type as you would, then press Done. Good for sites with a puzzle or a check. What you type goes to the site only: the hub keeps the cookies, not the password. A saved login, above, is kept on the hub, encrypted.">
        <SettingRow label="Sign in" help="Use your personal account. Watches check at most a few times a day; sites limit automated use, and a watch can stop working when a site changes.">
          <Button variant="solid" size="sm" disabled={!s.available} onClick={() => setPicking(true)}>
            Sign in to a site
          </Button>
        </SettingRow>
      </Group>

      <OpenDialog
        open={picking}
        profiles={s.profiles.map((p) => p.name)}
        onClose={() => setPicking(false)}
        onOpen={(v) => {
          setPicking(false);
          setView(v);
        }}
      />
      {view && (
        <SignInDialog
          view={view}
          onClose={(next) => {
            setView(undefined);
            if (next) setS(next);
            else void load();
          }}
        />
      )}
    </div>
  );
}

function OpenDialog({ open, profiles, onClose, onOpen }: { open: boolean; profiles: string[]; onClose: () => void; onOpen: (v: SignInViewDto) => void }) {
  const phone = useIsMobile();
  // an existing profile by default (default first), so Open never makes a profile the owner did not name
  const [profile, setProfile] = useState(profiles.includes('default') ? 'default' : (profiles[0] ?? ''));
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const chosen = profile || name.trim();
  const go = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      onOpen(await api().openSignIn(chosen, url.trim()));
    } catch (e) {
      setProblem(errText(e));
    }
    setBusy(false);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Sign in to a site"
      description="Pick the profile to keep the login in and the site to open."
      footer={
        <>
          <Button variant="quiet" size={phone ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={phone ? 'touch' : 'md'} busy={busy ? 'Opening' : false} disabled={!chosen || !url.trim()} onClick={() => void go()}>
            Open
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Profile">
          <Select value={profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="">New profile</option>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        {!profile && (
          <Field label="Name of the new profile" help="Letters, digits, dot, dash or underscore.">
            <Input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} placeholder="marketplace" />
          </Field>
        )}
        <Field label="Site">
          <Input mono value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} inputMode="url" placeholder="https://www.facebook.com/" />
        </Field>
        {problem && <p className="text-[13px] text-fault">{problem}</p>}
      </div>
    </Dialog>
  );
}

/** The remote view: the page's newest frame, clicks and keys back to it. */
function SignInDialog({ view, onClose }: { view: SignInViewDto; onClose: (status?: BrowserStatusDto) => void }) {
  const phone = useIsMobile();
  const [frame, setFrame] = useState<SignInFrameDto>();
  const [problem, setProblem] = useState<string>();
  const [text, setText] = useState('');
  const [address, setAddress] = useState(view.url);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const wheel = useRef(0);

  // poll the newest frame; the hub answers 204 when nothing changed
  useEffect(() => {
    let live = true;
    const tick = async () => {
      while (live) {
        try {
          const f = await api().signInFrame(view.id, seq.current);
          if (!live) return;
          if (f) {
            seq.current = f.seq;
            setFrame(f);
            setProblem(undefined);
          }
        } catch (e) {
          if (!live) return;
          setProblem(errText(e));
        }
        await new Promise((r) => setTimeout(r, 450));
      }
    };
    void tick();
    return () => {
      live = false;
    };
  }, [view.id]);

  useEffect(() => {
    if (frame?.url) setAddress(frame.url);
  }, [frame?.url]);

  const send = (events: BrowserInputEvent[]) =>
    api()
      .signInInput(view.id, events)
      .catch((e) => setProblem(errText(e)));

  // a phone gets the page at a phone's width, so the site lays it out to be read at that size
  useEffect(() => {
    if (phone) void send([{ type: 'resize', width: 400, height: 720 }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id, phone]);

  const point = (e: MouseEvent | WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = frame?.width ?? r.width;
    const h = frame?.height ?? r.height;
    return { x: Math.round(((e.clientX - r.left) / r.width) * w), y: Math.round(((e.clientY - r.top) / r.height) * h) };
  };
  const onClick = (e: MouseEvent) => {
    const p = point(e);
    box.current?.focus();
    void send([
      { type: 'mouse', action: 'move', ...p },
      { type: 'mouse', action: 'down', ...p, button: 'left' },
      { type: 'mouse', action: 'up', ...p, button: 'left' },
    ]);
  };
  const onWheel = (e: WheelEvent) => {
    const now = Date.now();
    if (now - wheel.current < 120) return;
    wheel.current = now;
    void send([{ type: 'mouse', action: 'wheel', ...point(e), deltaX: e.deltaX, deltaY: e.deltaY }]);
  };
  // a phone has no wheel: a swipe on the picture scrolls the page on the hub
  const swipe = useRef<number | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    swipe.current = e.touches[0]?.clientY ?? null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = swipe.current;
    swipe.current = null;
    const end = e.changedTouches[0];
    if (start === null || !end) return;
    const dy = start - end.clientY;
    if (Math.abs(dy) < 24) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const scale = (frame?.height ?? r.height) / r.height;
    void send([{ type: 'mouse', action: 'wheel', x: Math.round((frame?.width ?? r.width) / 2), y: Math.round((frame?.height ?? r.height) / 2), deltaX: 0, deltaY: Math.round(dy * scale) }]);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length === 1) {
      e.preventDefault();
      void send([{ type: 'text', text: e.key }]);
    } else if (KEYS.has(e.key)) {
      e.preventDefault();
      void send([
        { type: 'key', action: 'down', key: e.key },
        { type: 'key', action: 'up', key: e.key },
      ]);
    }
  };
  const press = (key: string) =>
    void send([
      { type: 'key', action: 'down', key },
      { type: 'key', action: 'up', key },
    ]);
  const typeText = () => {
    if (!text) return;
    void send([{ type: 'text', text }]);
    setText('');
  };
  const done = async () => {
    setBusy(true);
    try {
      const next = await api().signInDone(view.id);
      toast({ title: `Signed in. Profile ${view.profile} keeps the login.` });
      onClose(next);
    } catch (e) {
      setProblem(errText(e));
      setBusy(false);
    }
  };
  const cancel = () => {
    void api()
      .closeSignIn(view.id)
      .catch(() => undefined);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={cancel}
      title={`Sign in, profile ${view.profile}`}
      width={980}
      top="5vh"
      bodyClassName="px-4 pb-4 phone:px-3"
      footer={
        <>
          <Button variant="quiet" size={phone ? 'touch' : 'md'} onClick={cancel}>
            Cancel
          </Button>
          <Button variant="solid" size={phone ? 'touch' : 'md'} busy={busy ? 'Saving' : false} onClick={() => void done()}>
            Done, I am signed in
          </Button>
        </>
      }
    >
      <form
        className="mb-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send([{ type: 'navigate', url: address }]);
        }}
      >
        <Input mono size="sm" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Address" spellCheck={false} inputMode="url" />
        <Button size="sm" type="submit">
          Go
        </Button>
      </form>
      <div
        ref={box}
        tabIndex={0}
        role="application"
        aria-label="The page on the hub. Click to focus, then type."
        onKeyDown={onKey}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (t) void send([{ type: 'text', text: t }]);
        }}
        className="relative flex min-h-[200px] justify-center overflow-hidden rounded-[var(--r-2)] border border-rule-2 bg-sunk outline-none focus-visible:border-signal"
      >
        {frame ? (
          // the picture keeps the page's shape and fits the dialog; clicks map from its own box
          <img
            src={`data:image/jpeg;base64,${frame.data}`}
            alt="The page on the hub"
            draggable={false}
            onClick={onClick}
            onWheel={onWheel}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            className="block h-auto w-auto max-w-full cursor-default touch-pan-x select-none"
            style={{ maxHeight: phone ? '44dvh' : '44vh', aspectRatio: `${frame.width} / ${frame.height}` }}
          />
        ) : (
          <p className="absolute inset-0 grid place-items-center text-[13px] text-fg-3">Opening the page</p>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className={cn('min-w-0 flex-1', phone && 'basis-full')}>
          <Input
            size="sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                typeText();
              }
            }}
            placeholder="Type here, then Send"
            aria-label="Text to type into the page"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button size="sm" onClick={typeText} disabled={!text}>
          Send
        </Button>
        <Button size="sm" variant="quiet" onClick={() => press('Enter')}>
          Enter
        </Button>
        <Button size="sm" variant="quiet" onClick={() => press('Tab')}>
          Tab
        </Button>
        <Button size="sm" variant="quiet" onClick={() => press('Backspace')}>
          Delete
        </Button>
      </div>
      <p className="mt-2 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
        {problem ? <span className="text-fault">{problem}</span> : 'Click the page, then type, or type in the box and press Send. The picture follows the page about twice a second.'}
      </p>
    </Dialog>
  );
}
