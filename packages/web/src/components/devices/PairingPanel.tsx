/**
 * Pair a phone or another machine (spec 11.9 pairing, 11.11 step 7). The QR
 * code in a white well (the one box allowed for it), the code in mono at
 * stat size, a ticking "Expires in 9:42", the hub's fingerprint (a code
 * typed by hand carries none, so the other device can compare it here), the
 * install command for a device agent, and "Waiting for the device" with a
 * strip until it pairs.
 *
 * A phone pairs as an app, not a device (lib/apps.ts): the app that shows
 * up in the hub's apps after the code was made is the one that paired, and
 * a computer is the device that came online after it. When the hub's
 * addresses change while the code is shown (remote access set, a tunnel
 * moved), the same code comes back with the new list, so the QR always
 * carries every address the hub has now.
 */
import { useEffect, useRef, useState } from 'react';
import type { PairingInfo } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { pairingStale } from '@/lib/remote';
import { useHub } from '@/store/store';
import { useNow } from '@/lib/hooks';
import { elapsedClock } from '@/lib/format';
import { KnotRope, LiveStatus } from '../motion';
import { Button } from '../ui/Button';
import { CodeBlock } from '../ui/Code';
import { Fingerprint } from '@/features/connect/Fingerprint';

/** The Conclave installer for Linux and macOS (docs/INSTALL.md, section 5). */
const INSTALL = 'curl -fsSL https://github.com/default-cybe/conclave/releases/latest/download/install.sh | sh';

/** What paired: a computer's device id, or a phone's app id, and its name. */
export interface Paired {
  id: string;
  name: string;
}

export function PairingPanel({ kind = 'client', onPaired, className }: { kind?: 'client' | 'device'; onPaired?: (p: Paired) => void; className?: string }) {
  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [error, setError] = useState<string>();
  const [paired, setPaired] = useState<Paired | null>(null);
  const known = useRef<Set<string> | null>(null);
  const devices = useHub((s) => s.devices);
  const apps = useHub((s) => s.apps);
  const remote = useHub((s) => s.remote);
  const hubUrl = useHub((s) => s.hub?.publicUrl) || location.origin;
  const now = useNow(1000);
  /** The address list a refresh was asked for, so one change asks once. */
  const refreshedFor = useRef('');

  const create = async () => {
    setError(undefined);
    setInfo(null);
    setPaired(null);
    // machines online now, and every app signed in before (a phone pairs as a new app each time)
    const st = useHub.getState();
    known.current = new Set([...Object.values(st.devices).filter((d) => d.online).map((d) => d.id), ...Object.keys(st.apps)]);
    try {
      setInfo(await api().createPairing(kind));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // the hub's addresses changed while the code is shown: the same code, with the list the hub has now
  const addressKey = remote?.addresses.map((a) => a.url).join(' ') ?? '';
  useEffect(() => {
    if (!info || paired || info.expiresAt <= Date.now() || !pairingStale(info, remote)) return;
    const ask = `${info.code} ${addressKey}`;
    if (refreshedFor.current === ask) return;
    refreshedFor.current = ask;
    let live = true;
    api()
      .createPairing(kind, info.code)
      .then((next) => live && setInfo(next))
      .catch(() => {
        /* the shown code still works on the addresses it has */
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressKey, info?.code, paired]);

  useEffect(() => {
    void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  // a computer that came online after the code was made is the one that paired; for a phone (or a browser), an app that is new
  useEffect(() => {
    if (!info || paired || !known.current) return;
    const seen = known.current;
    const d = kind === 'client' ? Object.values(apps).find((a) => !a.revoked && !seen.has(a.id)) : Object.values(devices).find((x) => x.online && !seen.has(x.id));
    if (d) {
      const p = { id: d.id, name: d.name };
      setPaired(p);
      onPaired?.(p);
    }
  }, [devices, apps, info, paired, onPaired, kind]);

  const left = info ? info.expiresAt - now : 0;
  const expired = !!info && left <= 0 && !paired;
  // the address the code carries (the hub's best one), not what hub info said when the page loaded
  const base = (info?.url || hubUrl).replace(/\/+$/, '');
  const install = info ? [INSTALL, `conclave daemon pair ${base} ${info.code}`, 'conclave daemon install --start'].join('\n') : '';

  return (
    <div className={cn('flex flex-col gap-6 sm:flex-row sm:items-start', className)}>
      {!paired && (
        <div className="grid size-[232px] shrink-0 place-items-center rounded-[var(--r-2)] bg-white p-4" aria-label={info ? `QR code for pairing code ${info.code}` : 'Making a pairing code'} role="img">
          {info && !expired && <div className="size-[200px] [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: info.qrSvg }} />}
        </div>
      )}
      <div className="min-w-0 flex-1">
        {error ? (
          <>
            <p className="text-[14px] text-fault">Could not make a pairing code. {error}</p>
            <Button className="mt-3" variant="outline" onClick={create}>
              Try again
            </Button>
          </>
        ) : paired ? (
          <p className="flex items-center gap-2 text-[15px] text-fg">
            <KnotRope moment="success" size={20} />
            <span>
              <span className="text-ok">Paired</span> {paired.name}.
            </span>
          </p>
        ) : (
          <>
            <div className="text-[12px] text-fg-3">Pairing code</div>
            <div className="mt-1 font-mono text-[20px] font-[540] tracking-[0.04em] text-fg select-all">{info?.code ?? ' '}</div>
            <div className="mt-1 text-[12px] text-fg-3">
              {expired ? (
                <>
                  Expired.{' '}
                  <button type="button" className="text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg" onClick={create}>
                    Make a new code
                  </button>
                </>
              ) : (
                info && (
                  <>
                    Expires in <span className="num">{elapsedClock(left)}</span>
                  </>
                )
              )}
            </div>
            {info?.fingerprint && !expired && (
              <div className="mt-4">
                <div className="text-[12px] text-fg-3 phone:text-[13px]">Hub fingerprint</div>
                <Fingerprint value={info.fingerprint} size="sm" className="mt-1" />
              </div>
            )}
            {kind === 'device' && info && (
              <div className="mt-4">
                <div className="mb-1.5 text-[12px] text-fg-3">Or run this on the machine. The last line starts it at login.</div>
                <CodeBlock code={install} shell wrap />
              </div>
            )}
            {info && !expired && (
              <div className="mt-5 text-[13px]">
                <span className="inline-flex items-center gap-2">
                  <KnotRope moment="run" size={16} />
                  <LiveStatus state="tool" mark={false} label={kind === 'client' ? 'Waiting for the phone' : 'Waiting for the device'} startedAt={info.expiresAt - 10 * 60_000} />
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
