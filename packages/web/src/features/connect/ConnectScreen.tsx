/**
 * Connect (spec 11.12): shown whenever there is no saved connection. The
 * Welcome layout with the hero band and no procedure strip; the wordmark at
 * 64px on the left, the form on the right.
 *
 * Phones (the iPhone app, docs/design/MOBILE-V2.md 8): the mark, "Connect to
 * your hub" and one line of help, then Scan QR code, which opens the camera
 * full screen and pairs with what the code carries, and Use address and
 * password as a text button. The forms (a pairing code typed, the address
 * and password, a token) stay as they were, with the way back to the scan
 * at their foot. While it pairs, the mark on top is the knot that runs, and
 * it plays success before the app opens (docs/design/KNOT-MOTION.md).
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Connection } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import type { PairLink } from '@/lib/pairLink';
import { Mark } from '@/components/brand/Mark';
import { AsciiField } from '@/components/ascii/AsciiField';
import { KnotRope, useRopeMoment } from '@/components/motion';
import { Button } from '@/components/ui/Button';
import { Help } from '@/components/ui/Field';
import { ConnectForm, pairFromLink, servedFrom, type ConnectMode } from './ConnectForm';
import { explainConnectError } from './errors';
import { IntroFrame } from './IntroFrame';
import { QrScan } from './QrScan';

export function ConnectScreen({
  onConnected,
  title = 'Connect to a hub',
  lede = 'Pair this device with your hub. Only the token is kept here; keys and history stay on the hub.',
}: {
  onConnected: (c: Connection) => Promise<void>;
  /** Another reason to sign in, such as an app's request waiting on the consent page. */
  title?: string;
  lede?: string;
}) {
  const mobile = useIsMobile();
  // while a password login shows the fingerprint, its "Logged in to madx" is the one heading
  const [checking, setChecking] = useState(false);
  // another reason to sign in keeps its own words; plain Connect gets the phone's
  const own = title !== 'Connect to a hub';
  // the web app served by the hub itself: a plain sign in, the address is this page
  if (!own && servedFrom()) {
    title = 'Sign in to Conclave';
    lede = 'Use your hub password. No password yet? Set one in Settings, Remote access, on a device that is signed in.';
  }
  if (mobile) return <PhoneConnect onConnected={onConnected} title={own || servedFrom() ? title : undefined} lede={own || servedFrom() ? lede : undefined} />;
  return (
    <IntroFrame label="Connect" wordmark={64} align="start" hero={<AsciiField size={13} className="absolute inset-0 h-full" />}>
      {!checking && (
        <>
          <h2 className="t-title m-0 text-fg">{title}</h2>
          <p className="mt-1.5 text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">{lede}</p>
        </>
      )}
      <ConnectForm className={checking ? undefined : 'mt-6'} autoFocus onFingerprint={() => setChecking(true)} onConnected={({ conn }) => onConnected(conn)} />
    </IntroFrame>
  );
}

const LEDE: Record<ConnectMode, string> = {
  code: 'Open Devices on your hub and enter the pairing code it shows.',
  password: 'Use the address and the password from Settings, Remote access on your hub.',
  token: 'Paste the address and the token that conclave serve prints.',
};

/** The first screen's line of help. */
const START = "Scan the QR code on your hub's Devices page.";

/** The other ways in, at the foot of a form: the scan first, then the other form as a quiet link. */
const QUIET: Record<ConnectMode, { mode: ConnectMode; label: string }> = {
  code: { mode: 'password', label: 'Use address and password' },
  password: { mode: 'token', label: 'Use a token instead' },
  token: { mode: 'password', label: 'Use address and password' },
};

/**
 * iOS keeps the page's size when the keyboard opens (Safari and the iPhone
 * app's WebView ignore interactive-widget=resizes-content), so the button
 * under the fields would sit behind the keyboard. While a field here has
 * focus, the page gets the keyboard's height as room at its foot and
 * scrolls the button up into what is still visible.
 */
function useSubmitAboveKeyboard(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = root.current;
    if (!vv || !el) return;
    const fit = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const open = covered > 80;
      el.style.paddingBottom = open ? `${covered}px` : '';
      const field = document.activeElement;
      if (!open || !(field instanceof HTMLInputElement) || !el.contains(field)) return;
      const button = el.querySelector<HTMLElement>('button[type="submit"]');
      const over = button ? button.getBoundingClientRect().bottom + 12 - (vv.offsetTop + vv.height) : 0;
      if (over > 0) el.scrollTop += over;
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    el.addEventListener('focusin', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
      el.removeEventListener('focusin', fit);
      el.style.paddingBottom = '';
    };
  }, [root]);
}

function PhoneConnect({ onConnected, title, lede }: { onConnected: (c: Connection) => Promise<void>; title?: string; lede?: string }) {
  // start: the scan and the address and password; a form after that. At the
  // hub's own address the password form comes first, the address is this page.
  const [mode, setMode] = useState<ConnectMode | 'start'>(servedFrom() ? 'password' : 'start');
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  // while a password login shows the fingerprint, the other ways in step aside
  const [checking, setChecking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useSubmitAboveKeyboard(root);
  const rope = useRopeMoment();

  const scanned = async (link: PairLink) => {
    setScanning(false);
    setPairing(true);
    setError(null);
    rope.run();
    try {
      const c = await pairFromLink(link);
      await rope.succeed();
      await onConnected(c.conn);
    } catch (err) {
      rope.clear();
      setError(explainConnectError(err, link.urls[0], 'code'));
      setPairing(false);
    }
  };
  const go = (m: ConnectMode | 'start') => {
    setMode(m);
    setError(null);
  };

  const scan = (
    // filled on the first screen; under a form, whose own button is the filled one, an outline
    <Button variant={mode === 'start' ? 'solid' : 'outline'} size="touch" full busy={pairing ? 'Connecting' : false} onClick={() => setScanning(true)} className="h-[52px]! rounded-[14px]! text-[16px]!">
      Scan QR code
    </Button>
  );

  return (
    <div ref={root} className="h-full overflow-y-auto bg-bg pt-safe pb-safe">
      <main className="flex min-h-full flex-col px-6 pt-[clamp(28px,8vh,72px)] pb-6">
        <div className={cn('flex flex-col items-center text-center', mode === 'start' && 'my-auto pb-10')}>
          {/* the mark is the hub of the ASCII conclave; the art sits around it and takes no room */}
          <div className="relative grid place-items-center">
            <AsciiField hub={false} size={11} className="pointer-events-none absolute top-1/2 left-1/2 h-[104px] w-screen -translate-x-1/2 -translate-y-1/2" />
            <div className="relative">
              {rope.moment ? (
                <KnotRope moment={rope.moment} size={mode === 'start' ? 36 : 30} onDone={rope.onDone} label={rope.moment === 'run' ? 'Connecting' : 'Connected'} />
              ) : (
                <Mark height={mode === 'start' ? 24 : 20} />
              )}
            </div>
          </div>
          <h1 className="mt-7 text-[28px] leading-[34px] font-semibold tracking-[-0.01em] text-balance text-fg" style={{ fontStretch: '104%' }}>
            {title ?? 'Connect to your hub'}
          </h1>
          {!checking && <p className="mt-2 max-w-[34ch] text-[15px] leading-[22px] text-balance text-fg-2">{lede ?? (mode === 'start' ? START : LEDE[mode])}</p>}
          {error && (
            <Help error className="mt-4 max-w-[40ch] text-pretty anim-fade">
              <span role="alert">{error}</span>
            </Help>
          )}
        </div>

        {mode !== 'start' && <ConnectForm mode={mode} hideModes className="mt-8" rope={rope} onFingerprint={() => setChecking(true)} onConnected={({ conn }) => onConnected(conn)} />}

        {mode !== 'start' && <div className="min-h-8 flex-1" />}
        <div className={cn('flex flex-col items-center gap-1', checking && 'hidden')}>
          {scan}
          {mode === 'start' ? (
            <button type="button" onClick={() => go('password')} className="h-11 px-3 text-[16px] font-medium text-fg-2">
              Use address and password
            </button>
          ) : (
            <button type="button" onClick={() => go(QUIET[mode].mode)} className="h-11 px-3 text-[15px] text-fg-2">
              {QUIET[mode].label}
            </button>
          )}
        </div>
      </main>
      {scanning && (
        <QrScan
          onLink={(link) => void scanned(link)}
          onClose={() => setScanning(false)}
          onCode={() => {
            setScanning(false);
            go('code');
          }}
        />
      )}
    </div>
  );
}
