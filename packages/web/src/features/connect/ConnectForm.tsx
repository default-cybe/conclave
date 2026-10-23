/**
 * Connect this client to a hub (spec 11.12, 11.11 step 1). Shared by the
 * Connect screen and the onboarding Hub step so both feel like one flow:
 * a pairing code (the default on phones), the hub's address and password
 * (docs/design/HUB-LOGIN-AND-IDENTITY.md), or an address and token.
 *
 * Pairing and logging in reply with the hub's key, which is kept with the
 * token so the client can check the hub before it sends the token again.
 * A password login has no code to check the hub against, so the hub's
 * fingerprint shows once before the app opens, to compare with Settings on
 * the hub.
 *
 * While it waits on the hub the knot runs beside the button; when the hub
 * says yes it plays success, then the app opens (docs/design/KNOT-MOTION.md).
 * A screen that draws the knot itself (the phone's mark on top) passes its
 * own `rope`.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, fingerprintOf, type HubInfo, type PairResult } from '@conclave/core/client';
import { probeClient, saveConnection, type Connection } from '@/lib/api';
import { rememberAccount } from '@/lib/people';
import { isDesktopApp } from '@/lib/notify';
import { keepAddresses } from '@/lib/remote';
import type { PairLink } from '@/lib/pairLink';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Field, Help, Input, Segmented } from '@/components/ui/Field';
import { KnotRope, useRopeMoment } from '@/components/motion';
import { explainConnectError, hubHost, looksLikeHubUrl, normalizeHubUrl } from './errors';
import { Fingerprint } from './Fingerprint';

export type ConnectMode = 'code' | 'password' | 'token';

export interface Connected {
  conn: Connection;
  hub: HubInfo;
  /** Round trip of the info call, in ms. */
  ms: number;
}

/** "Chrome on Mac", "Firefox on Linux", "Desktop app on Windows": the name this browser pairs as. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = isDesktopApp() ? 'Desktop app' : /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'the web';
  return `${browser} on ${os}`;
}

/** What Settings, Your account, Signed in calls it (lib/apps.ts): the desktop app's window is not a browser. */
function platform(): string {
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : isDesktopApp() ? 'desktop' : 'web';
}

/** The page origin, when this page is served over http(s) by the hub itself. */
export function servedFrom(): string {
  const { protocol, origin, hostname } = window.location;
  if ((protocol === 'http:' || protocol === 'https:') && hostname !== 'tauri.localhost') return origin;
  return '';
}

/**
 * Pair with what a QR code carries: each address in turn until one answers,
 * then the hub's key must be the one the code names, or nothing is kept.
 * Throws what the last address answered.
 */
export async function pairFromLink(link: PairLink, name = defaultDeviceName()): Promise<Connected> {
  let last: unknown;
  for (const base of link.urls) {
    let reply: PairResult;
    try {
      reply = await (await probeClient(base)).pair(link.code, name, platform());
    } catch (err) {
      last = err;
      // the hub answered and said no (a used or wrong code): another address would say the same
      if (err instanceof ApiError) throw err;
      continue;
    }
    const key = reply.identity?.publicKey;
    if (link.fp && (!key || (await fingerprintOf(key)) !== link.fp)) throw new Error(`${hubHost(base)} answered with another key than the code's. Nothing was kept. Make a new code on the hub's Devices page.`);
    const conn: Connection = { baseUrl: base, token: reply.token, ...(key ? { hubKey: key } : {}), ...(reply.account ? { account: reply.account } : {}), clientId: reply.clientId };
    const c = await probeClient(conn.baseUrl, conn.token, conn.hubKey);
    const t0 = performance.now();
    const hub = await c.info();
    const ms = Math.round(performance.now() - t0);
    conn.hubName = hub.name;
    saveConnection(conn);
    rememberAccount(conn);
    keepAddresses(conn, reply.addresses ?? link.urls);
    return { conn, hub, ms };
  }
  throw last ?? new Error('No address in the code answered.');
}

/** Codes look like FVBX-SMSW: 8 characters from an alphabet without 0, 1, I and O. */
function formatCode(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export function ConnectForm({
  onConnected,
  initialMode,
  initialUrl,
  submitLabel = 'Connect',
  className,
  autoFocus,
  footer,
  mode: modeProp,
  hideModes,
  onFingerprint,
  rope: screenRope,
}: {
  onConnected: (c: Connected) => Promise<void> | void;
  initialMode?: ConnectMode;
  initialUrl?: string;
  submitLabel?: string;
  className?: string;
  autoFocus?: boolean;
  /** Extra line under the actions (version, "New here?"). */
  footer?: ReactNode;
  /** Set by a screen that switches modes itself (the phone Connect screen). */
  mode?: ConnectMode;
  /** No mode switch on top: the screen has its own. */
  hideModes?: boolean;
  /** A password login is showing the fingerprint, before Continue. */
  onFingerprint?: () => void;
  /** The screen draws the run and success knot itself (useRopeMoment); else it runs beside the button. */
  rope?: ReturnType<typeof useRopeMoment>;
}) {
  const mobile = useIsMobile();
  const origin = initialUrl ?? servedFrom();
  // opened at the hub's own address (hub.example.com): a sign in with the password, like any web app
  const [ownMode, setMode] = useState<ConnectMode>(initialMode ?? (mobile ? 'code' : origin ? 'password' : 'token'));
  const mode = modeProp ?? ownMode;
  const [url, setUrl] = useState(origin);
  const [editUrl, setEditUrl] = useState(!origin);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  // a hub with several people asks whose password it is (docs/design/ACCOUNTS.md 4)
  const [account, setAccount] = useState('');
  const [people, setPeople] = useState(false);
  const [show, setShow] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const ownRope = useRopeMoment();
  const rope = screenRope ?? ownRope;
  const knot = !screenRope && rope.moment && <KnotRope moment={rope.moment} size={mobile ? 24 : 28} onDone={rope.onDone} label={rope.moment === 'run' ? 'Connecting' : 'Connected'} />;
  const [error, setError] = useState<ReactNode>(null);
  // a password login waits here until the owner has seen the hub's fingerprint
  const [check, setCheck] = useState<Connected & { fingerprint: string }>();
  const urlRef = useRef<HTMLInputElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  // a phone keyboard would cover the form on open, so only a mouse and keyboard device focuses at once
  const focusOnOpen = autoFocus && typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches;
  const switched = useRef(false);

  // after switching modes, start in the first field of the new mode
  useEffect(() => {
    if (!switched.current) return;
    (mode === 'code' || origin ? firstRef : urlRef).current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  useEffect(() => {
    if (modeProp === undefined) return;
    switched.current = true;
    setError(null);
  }, [modeProp]);

  const base = normalizeHubUrl(url);

  // ask the hub whether it has more than one person, once the address settles
  useEffect(() => {
    if (mode !== 'password' || !base) return;
    let gone = false;
    const t = setTimeout(() => {
      void probeClient(base)
        .then((c) => c.health())
        .then((h) => !gone && setPeople(h.people === true))
        .catch(() => !gone && setPeople(false));
    }, 300);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [mode, base]);

  const codeReady = code.replace('-', '').length === 8;
  const ready = !!base && looksLikeHubUrl(url) && (mode === 'code' ? codeReady && !!name.trim() : mode === 'password' ? !!password && !!name.trim() && (!people || !!account.trim()) : !!token.trim());
  // a button that cannot be pressed yet says what it waits for (beside it, and to a screen reader)
  const missing = ready
    ? ''
    : !base
      ? 'Enter the hub address.'
      : !looksLikeHubUrl(url)
        ? 'That is not a hub address. Use the form https://hub.example.com.'
      : mode === 'code' && !codeReady
        ? 'Enter the pairing code.'
        : mode === 'password' && people && !account.trim()
          ? 'Enter your sign-in name or email.'
          : mode === 'password' && !password
            ? 'Enter the password.'
            : mode === 'token'
              ? 'Paste the token.'
              : 'Name this device.';
  const missingId = useId();

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    rope.run();
    try {
      let conn: Connection;
      let reply: PairResult | undefined;
      if (mode === 'token') {
        conn = { baseUrl: base, token: token.trim() };
      } else {
        const anon = await probeClient(base);
        reply = mode === 'code' ? await anon.pair(code, name.trim(), platform()) : await anon.login(password, name.trim(), platform(), people ? account.trim() : undefined);
        // the hub's key goes with the token: from now on the client checks the hub holds it before it sends the token
        conn = { baseUrl: base, token: reply.token, ...(reply.identity?.publicKey ? { hubKey: reply.identity.publicKey } : {}), ...(reply.account ? { account: reply.account } : {}), clientId: reply.clientId };
      }
      const c = await probeClient(conn.baseUrl, conn.token, conn.hubKey);
      const t0 = performance.now();
      const hub = await c.info();
      const ms = Math.round(performance.now() - t0);
      conn.hubName = hub.name;
      saveConnection(conn);
      rememberAccount(conn);
      keepAddresses(conn, reply?.addresses);
      const fingerprint = mode === 'password' ? (reply?.identity?.fingerprint ?? hub.fingerprint) : undefined;
      if (fingerprint) {
        rope.clear();
        setCheck({ conn, hub, ms, fingerprint });
        onFingerprint?.();
      } else {
        await rope.succeed();
        await onConnected({ conn, hub, ms });
      }
    } catch (err) {
      rope.clear();
      setError(explainConnectError(err, base, mode));
      if (mode === 'code') setCode('');
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  if (check)
    return (
      <div className={cn('flex flex-col', className)}>
        <h2 className="t-title m-0 text-fg">Logged in to {check.hub.name}</h2>
        <p className="mt-1.5 text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">This is your hub's fingerprint. Check that it matches the one in Settings, Remote access on the hub.</p>
        <Fingerprint value={check.fingerprint} className="mt-5" />
        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button
            variant="solid"
            size={mobile ? 'touch' : 'lg'}
            full={mobile}
            autoFocus
            busy={rope.moment === 'success'}
            onClick={async () => {
              await rope.succeed();
              await onConnected(check);
            }}
          >
            Continue
          </Button>
          {knot}
        </div>
      </div>
    );

  const addressField = (
    <Field
      label="Hub address"
      help={
        mode === 'code' ? (
          <>
            <span className="mono">conclave serve</span> prints it when it starts.
          </>
        ) : mode === 'password' ? (
          'Settings, Remote access on the hub shows it. Use the https one away from home.'
        ) : undefined
      }
    >
      <Input
        ref={urlRef}
        enterKeyHint="go"
        mono
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://hub.example.com"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        inputMode="url"
        autoComplete="url"
        autoFocus={focusOnOpen && mode !== 'code' && !origin}
      />
    </Field>
  );

  const showButton = (
    <button type="button" className="min-h-8 text-[12px] text-fg-3 hover:text-fg phone:min-h-11 phone:px-1 phone:text-[13px]" onClick={() => setShow((s) => !s)} aria-pressed={show}>
      {show ? 'Hide' : 'Show'}
    </button>
  );

  const nameField = (
    <Field label="Name for this device" help="Shown in Devices and in the audit log.">
      <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" enterKeyHint="go" />
    </Field>
  );

  return (
    // Return on any field submits (iOS shows Go): the button is aria-disabled, never disabled, so the form still submits and submit() checks it is ready
    <form onSubmit={submit} className={cn('flex flex-col', className)} noValidate>
      {!hideModes && (
        <Segmented
          label="How to connect"
          value={mode}
          onChange={(m) => {
            switched.current = true;
            setMode(m);
            setError(null);
          }}
          size={mobile ? 'touch' : 'md'}
          full={mobile}
          className="mb-5 self-start phone:self-stretch"
          options={[
            { value: 'code', label: 'Pairing code' },
            { value: 'password', label: 'Password' },
            { value: 'token', label: 'Token' },
          ]}
        />
      )}

      <div className="flex flex-col gap-4">
        {mode === 'code' ? (
          <>
            <Field label="Pairing code" help={<>Make one under Devices on a paired device, or run <span className="mono">conclave pair-phone</span> on the hub.</>}>
              <Input
                ref={firstRef}
                enterKeyHint="go"
                mono
                size="lg"
                value={code}
                onChange={(e) => setCode(formatCode(e.target.value))}
                placeholder="ABCD-EFGH"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={9}
                autoFocus={focusOnOpen}
                className="text-[16px] tracking-[0.01em]"
              />
            </Field>
            {editUrl ? (
              addressField
            ) : (
              <div className="flex items-baseline gap-3 text-[13px] phone:text-[14px]">
                <span className="text-fg-3">Hub</span>
                <span className="min-w-0 truncate font-mono text-[12.5px] text-fg-2">{hubHost(url)}</span>
                <button
                  type="button"
                  className="tap text-fg-3 underline decoration-rule-2 underline-offset-[3px] hover:text-fg"
                  onClick={() => {
                    setEditUrl(true);
                    setTimeout(() => urlRef.current?.focus(), 0);
                  }}
                >
                  Change
                </button>
              </div>
            )}
            {nameField}
          </>
        ) : mode === 'password' ? (
          <>
            {addressField}
            {people && (
              <Field label="Sign-in name or email" help="Your sign-in name, as the owner added you, or your email. Not your display name.">
                <Input value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="next" />
              </Field>
            )}
            <Field label="Password" help={people ? 'Your own password. The owner can set a new one in Settings, People.' : 'The owner sets it in Settings, Remote access on the hub, or with conclave password set.'}>
              <Input
                ref={firstRef}
                enterKeyHint="go"
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                spellCheck={false}
                autoCapitalize="off"
                autoFocus={focusOnOpen && !!origin}
                suffix={showButton}
              />
            </Field>
            {nameField}
          </>
        ) : (
          <>
            {addressField}
            <Field
              label="Token"
              help={
                <>
                  Printed by <span className="mono">conclave serve</span>, and kept as <span className="mono">server.token</span> in <span className="mono">~/.conclave/config.json</span>.
                </>
              }
            >
              <Input
                ref={firstRef}
                enterKeyHint="go"
                mono
                type={show ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="cnc_"
                autoComplete="current-password"
                spellCheck={false}
                autoFocus={focusOnOpen && !!origin}
                suffix={showButton}
              />
            </Field>
          </>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Button type="submit" variant="solid" size={mobile ? 'touch' : 'lg'} busy={busy ? (mode === 'password' ? 'Logging in' : 'Connecting') : false} disabled={!ready} full={mobile} aria-describedby={missing && !busy ? missingId : undefined}>
          {mode === 'password' && submitLabel === 'Connect' ? 'Log in' : submitLabel}
        </Button>
        {knot}
        {missing && !busy && (
          <span id={missingId} className="text-[13px] text-fg-3 phone:w-full phone:text-center phone:text-[14px]">
            {missing}
          </span>
        )}
        {footer}
      </div>
      {error && (
        <Help error className="mt-3 max-w-[52ch] anim-fade">
          <span role="alert">{error}</span>
        </Help>
      )}
    </form>
  );
}
