/**
 * Step 1, Hub (spec 11.11): this client is already talking to a hub, so the
 * step confirms it in words, asks the owner's name (their display name, saved
 * with PATCH /api/me, docs/design/ACCOUNTS.md; Home greets them by it, and
 * the sign-in name stays as it is), asks
 * how the phone should reach it away from this network (the same choice as
 * Settings, Remote access), and offers the connect form for a different hub.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MeDto } from '@conclave/core/client';
import { api, MOCK, loadConnection } from '@/lib/api';
import { durationShort } from '@/lib/format';
import { DISPLAY_NAME_MAX, displayNameProblem, personName, refreshAccount, tidyDisplayName } from '@/lib/people';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { SectionHeading } from '@/components/ui/Section';
import { ConnectForm } from '../../connect/ConnectForm';
import { transportWords } from '@/lib/remote';
import { RemoteChoice, RemoteStatusLine, useRemote } from '../../settings/remote';
import { StepFrame } from '../StepLayout';
import { andList, errText, useCtlSize } from '../parts';

function Row({ k, children, mono }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] items-baseline gap-4 py-2.5 phone:grid-cols-[110px_minmax(0,1fr)]">
      <dt className="text-[13px] text-fg-3 phone:text-[14px]">{k}</dt>
      <dd className={cn('m-0 min-w-0 text-[14px] text-fg phone:text-[15px]', mono && 'font-mono text-[13px] break-all')}>{children}</dd>
    </div>
  );
}

/** The name the account shows, or the one Home already greeted by when it could be a display name. */
function startingName(me: MeDto | undefined, uiName: unknown): string {
  const own = personName(me);
  if (own) return own;
  return typeof uiName === 'string' && uiName.trim() && !displayNameProblem(uiName) ? tidyDisplayName(uiName) : '';
}

export function HubStep() {
  const ctl = useCtlSize();
  const hub = useHub((s) => s.hub);
  const conn = useHub((s) => s.conn);
  const devices = useHub((s) => s.devices);
  const me = useHub((s) => s.me);
  const uiName = useHub((s) => (s.config?.ui as { name?: unknown } | undefined)?.name);
  const [ms, setMs] = useState<number>();
  const [other, setOther] = useState(false);
  const [name, setName] = useState(() => startingName(me, uiName));
  const [nameError, setNameError] = useState<string>();
  const typed = useRef(false);
  // who is signed in can load after the step opens: fill the field once, unless the owner typed
  useEffect(() => {
    if (!typed.current) setName(startingName(me, uiName));
  }, [me, uiName]);
  const owner = me?.role === 'owner';
  const address = MOCK ? (hub?.publicUrl ?? location.origin) : (loadConnection()?.baseUrl ?? location.origin);

  useEffect(() => {
    let alive = true;
    const t0 = performance.now();
    api()
      .info()
      .then(() => alive && setMs(Math.round(performance.now() - t0)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const online = Object.values(devices).filter((d) => d.online);
  const ok = conn !== 'closed' && !!hub;
  const remote = useRemote();
  const away = remote.status?.addresses.find((a) => a.kind !== 'lan');
  const summary = !ok ? 'The hub is not answering.' : away ? `Connected to ${hub!.name}, reachable from anywhere.` : `Connected to ${hub!.name}.`;

  /** Save the name as the owner's display name; the hub sets Home's greeting from it. Empty keeps what there is. */
  const saveName = async (): Promise<boolean> => {
    const n = tidyDisplayName(name);
    const shown = personName(me);
    // the same name again only when no app greets by it yet (the hub then sets the greeting)
    if (!owner || !me || !n || (n === shown && typeof uiName === 'string')) return true;
    const bad = displayNameProblem(n);
    if (bad) {
      setNameError(bad);
      return false;
    }
    // the same name as shown keeps the display name as it is ("riley" shows as Riley)
    const displayName = n === shown && me.displayName ? me.displayName : n;
    try {
      await api().updateMe({ displayName });
      const next = { ...me, displayName };
      useHub.setState({ me: next });
      refreshAccount(next);
      return true;
    } catch (e) {
      setNameError(`Could not save it. ${errText(e)}`);
      return false;
    }
  };

  return (
    <StepFrame summary={summary} onContinue={saveName}>
      <p className="m-0 text-[17px] leading-[1.4] text-fg phone:text-[17px]">
        {ok ? (
          <>
            <span className="text-ok">Connected</span> to {hub!.name}, version <span className="mono">{hub!.version}</span>
            {ms !== undefined && (
              <>
                , <span className="num">{ms}</span> ms
              </>
            )}
            .
          </>
        ) : (
          <>
            <span className="text-fault">Not connected.</span> The hub stopped answering. Check that <span className="mono">conclave serve</span> is running.
          </>
        )}
      </p>

      <dl className="rows m-0 mt-5 border-y border-rule">
        <Row k="Address" mono>
          {address}
        </Row>
        <Row k="Network">{transportWords(address)}</Row>
        <Row k="Machines">{online.length ? andList(online.map((d) => d.name)) + ' online' : 'None online'}</Row>
        {hub?.startedAt && <Row k="Up for">{durationShort(Date.now() - hub.startedAt)}</Row>}
      </dl>

      {ok && owner && (
        <section className="mt-10">
          <SectionHeading>You</SectionHeading>
          <Field className="max-w-[320px] pt-4" label="Your name" error={nameError} help="Home greets you by it. Spaces are fine.">
            <Input
              value={name}
              maxLength={DISPLAY_NAME_MAX}
              autoComplete="name"
              spellCheck={false}
              placeholder="Kai Ahir"
              invalid={!!nameError}
              onChange={(e) => {
                typed.current = true;
                setName(e.target.value);
                setNameError(undefined);
              }}
            />
          </Field>
        </section>
      )}

      {ok && (
        <section className="mt-10">
          <SectionHeading>Reach it from your phone</SectionHeading>
          {!away && (
            <p className="m-0 mt-3 max-w-[64ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
              On the same Wi-Fi a phone can connect now. To use it anywhere else, pick a way in. The quick tunnel needs nothing else installed.
            </p>
          )}
          {remote.status ? (
            <div className="mt-4">
              <RemoteStatusLine s={remote.status} set={remote.set} compact />
              <div className="mt-4">
                <RemoteChoice s={remote.status} set={remote.set} />
              </div>
            </div>
          ) : remote.error ? (
            <p className="m-0 mt-3 text-[13px] text-fault">Could not load remote access. {remote.error}</p>
          ) : null}
        </section>
      )}

      <section className="mt-10">
        <SectionHeading>A different hub</SectionHeading>
        {other ? (
          <div className="pt-5">
            <ConnectForm
              autoFocus
              initialUrl=""
              submitLabel="Connect and continue"
              onConnected={() => {
                // the app boots again with the saved connection and resumes setup there
                location.assign('/setup/providers');
              }}
              footer={
                <Button variant="quiet" size={ctl === 'touch' ? 'touch' : 'lg'} onClick={() => setOther(false)}>
                  Cancel
                </Button>
              }
            />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-4">
            <p className="m-0 max-w-[52ch] min-w-[280px] flex-1 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">If your hub runs somewhere else, connect to it with its address and token, or a pairing code from a device that already uses it.</p>
            <Button variant="outline" size={ctl} onClick={() => setOther(true)}>
              Connect to another hub
            </Button>
          </div>
        )}
      </section>
    </StepFrame>
  );
}
