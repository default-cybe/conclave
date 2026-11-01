/**
 * Step 8, Devices (spec 11.11): this computer (its name and the folders
 * sessions may use), the phone (QR code from createPairing), and the command
 * that pairs another computer with a fresh device code. A phone pairs as an
 * app, so the phones here come from the hub's apps (lib/apps.ts); they are
 * not devices, so the summary names them apart from the computers.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Device } from '@conclave/core/types';
import type { PairingInfo } from '@conclave/core/client';
import { api, MOCK, loadConnection } from '@/lib/api';
import { elapsedClock, relTime } from '@/lib/format';
import { harnessLabel } from '@/lib/models';
import { useNow } from '@/lib/hooks';
import { phoneApps } from '@/lib/apps';
import { reloadDevices, toast, useHub } from '@/store/store';
import { PairingPanel } from '@/components/devices/PairingPanel';
import { Button, IconButton } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { Input } from '@/components/ui/Field';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { LiveStatus } from '@/components/motion';
import { StepFrame } from '../StepLayout';
import { andList, errText, LINK, SettingRow, useCtlSize } from '../parts';
import { harnessesOn } from '../progress';

const INSTALL_CLI = 'curl -fsSL https://github.com/default-cybe/conclave/releases/latest/download/install.sh | sh';

async function patchDevice(id: string, patch: { name?: string; roots?: string[] }) {
  try {
    const d = await api().updateDevice(id, patch);
    useHub.setState((s) => ({ devices: { ...s.devices, [d.id]: d } }));
  } catch (e) {
    toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    void reloadDevices();
  }
}

function ComputerEditor({ device }: { device: Device }) {
  const [name, setName] = useState(device.name);
  const [adding, setAdding] = useState('');
  const ctl = useCtlSize();
  const roots = device.roots;
  const found = harnessesOn(device).map((h) => harnessLabel(h.id) ?? h.id);

  const add = () => {
    const p = adding.trim();
    if (!p || roots.includes(p)) return;
    setAdding('');
    void patchDevice(device.id, { roots: [...roots, p] });
  };

  return (
    <>
      <p className="m-0 pt-3.5 pb-1 text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">
        <span className="font-medium text-fg">{device.name}</span> is paired and <span className={device.online ? 'text-ok' : 'text-fg-3'}>{device.online ? 'online' : 'offline'}</span>
        {found.length ? `. ${andList(found)} ${found.length === 1 ? 'is' : 'are'} installed there.` : '.'}
      </p>
      <div className="rows">
        <SettingRow label="Name" help="How sessions, Devices and the audit log refer to it." htmlFor="device-name">
          <Input
            id="device-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== device.name && void patchDevice(device.id, { name: name.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </SettingRow>
        <SettingRow label="Folders sessions may use" help="Sessions here can only read and write inside these. With none, the home folder." top>
          <div>
            {roots.length > 0 && (
              <ul className="m-0 mb-2 list-none p-0">
                {roots.map((r) => (
                  <li key={r} className="flex h-[30px] items-center justify-between gap-2 border-b border-rule last:border-b-0 phone:h-11">
                    <span className="truncate font-mono text-[12.5px] text-fg">{r}</span>
                    <IconButton label={`Remove ${r}`} size={ctl === 'touch' ? 'touch' : 'sm'} className="phone:-mr-3" onClick={() => void patchDevice(device.id, { roots: roots.filter((x) => x !== r) })}>
                      <X />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Input
                mono
                size="sm"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && add()}
                placeholder="~/code"
                aria-label="Folder to add"
                spellCheck={false}
                autoCapitalize="off"
              />
              <Button variant="outline" size={ctl} onClick={add} disabled={!adding.trim()}>
                Add
              </Button>
            </div>
          </div>
        </SettingRow>
      </div>
    </>
  );
}

/** The device agent commands with a fresh device code, waiting until the machine shows up. */
function ComputerPairing({ onPaired }: { onPaired?: (d: Device) => void }) {
  const hub = useHub((s) => s.hub);
  const devices = useHub((s) => s.devices);
  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [error, setError] = useState<string>();
  const [paired, setPaired] = useState<Device | null>(null);
  const [cli, setCli] = useState(false);
  const ctl = useCtlSize();
  const known = useRef<Set<string> | null>(null);
  const now = useNow(1000);
  const hubUrl = (MOCK ? hub?.publicUrl : loadConnection()?.baseUrl) ?? hub?.publicUrl ?? location.origin;

  const create = async () => {
    setError(undefined);
    setInfo(null);
    known.current = new Set(Object.values(useHub.getState().devices).filter((d) => d.online).map((d) => d.id));
    try {
      setInfo(await api().createPairing('device'));
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => {
    void create();
  }, []);
  useEffect(() => {
    if (!info || paired || !known.current) return;
    const d = Object.values(devices).find((x) => x.online && !known.current!.has(x.id));
    if (d) {
      setPaired(d);
      onPaired?.(d);
    }
  }, [devices, info, paired, onPaired]);

  if (error)
    return (
      <div className="pt-4">
        <p className="m-0 text-[13px] text-fault">Could not make a pairing code. {error}</p>
        <Button className="mt-3" variant="outline" size={ctl} onClick={() => void create()}>
          Try again
        </Button>
      </div>
    );
  if (paired)
    return (
      <p className="m-0 pt-4 text-[14px] text-fg phone:text-[15px]">
        <span className="text-ok">Paired</span> {paired.name}. Sessions can run there now.
      </p>
    );
  const left = info ? info.expiresAt - now : 0;
  const expired = !!info && left <= 0;
  const cmd = info ? `conclave daemon pair ${hubUrl.replace(/\/$/, '')} ${info.code}\nconclave daemon install --start` : '';
  return (
    <div className="pt-4">
      <p className="m-0 mb-2.5 text-[13px] text-fg-2 phone:text-[14px]">Run these on the computer. The first pairs it, the second starts the agent at login.</p>
      {info ? <CodeBlock code={cmd} shell wrap /> : <div className="h-[66px] rounded-[var(--r-2)] border border-rule bg-sunk" aria-hidden />}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-fg-3 phone:text-[13px]">
        {info && !expired && (
          <>
            <LiveStatus state="tool" label="Waiting for the computer" />
            <span>
              Code <span className="font-mono text-fg-2">{info.code}</span>, expires in <span className="num">{elapsedClock(left)}</span>
            </span>
          </>
        )}
        {expired && (
          <span>
            The code expired. <TextAction className={LINK} label="Make a new code" onClick={() => void create()} />
          </span>
        )}
      </div>
      <div className="mt-3">
        {cli ? (
          <div className="anim-fade">
            <p className="m-0 mb-2 text-[12px] text-fg-3 phone:text-[13px]">Install the CLI first, then run the two lines above.</p>
            <CodeBlock code={INSTALL_CLI} shell wrap />
          </div>
        ) : (
          <TextAction className={LINK} label="No conclave CLI on that computer yet?" onClick={() => setCli(true)} />
        )}
      </div>
    </div>
  );
}

export function DevicesStep() {
  const devices = useHub((s) => s.devices);
  const apps = useHub((s) => s.apps);
  const ctl = useCtlSize();
  const list = useMemo(() => Object.values(devices), [devices]);
  const computers = list.filter((d) => d.id !== 'local');
  const phones = useMemo(() => phoneApps(apps), [apps]);
  // the computer running setup: the newest computer online when the step opened. Kept, so a
  // machine paired from this step never takes its place.
  const hereId = useRef<string | undefined>(undefined);
  if (!hereId.current) hereId.current = [...computers].filter((d) => d.online).sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
  const here = hereId.current ? devices[hereId.current] : undefined;
  // one pairing code at a time, so a machine that pairs is never taken for the phone
  const [pairing, setPairing] = useState<'phone' | 'computer' | null>(() => (phones.length ? null : 'phone'));
  const others = list.filter((d) => d.id !== here?.id);

  // a phone counts once it paired: the app connects only while it is open. It is an app, not a device: said apart
  const named = computers.filter((d) => d.online).map((d) => d.name);
  const phoneNames = phones.map((p) => p.name);
  const machines = named.length ? `${andList(named)} ${named.length === 1 ? 'is' : 'are'} paired.` : '';
  const signed = phoneNames.length ? `${andList(phoneNames)} ${phoneNames.length === 1 ? 'is' : 'are'} signed in.` : '';
  const summary = pairing === 'phone' && !phones.length ? [machines, 'Waiting for the phone.'].filter(Boolean).join(' ') : machines || signed ? [machines, signed].filter(Boolean).join(' ') : 'Nothing paired yet.';

  return (
    <StepFrame summary={summary}>
      <section>
        <SectionHeading>This computer</SectionHeading>
        {here ? <ComputerEditor device={here} /> : <ComputerPairing />}
      </section>

      <section className="mt-10">
        <SectionHeading count={phones.length > 1 ? phones.length : undefined}>Your phone</SectionHeading>
        {phones.length > 0 && (
          <div className="rows">
            {phones.map((p) => (
              <div key={p.id} className="flex items-baseline justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{p.name}</div>
                  <div className="text-[12px] text-fg-3 phone:text-[13px]">Paired {relTime(p.createdAt) === 'now' ? 'just now' : `${relTime(p.createdAt)} ago`}, gets approvals and notifications</div>
                </div>
                <span className={p.online ? 'text-[13px] text-ok' : 'text-[13px] text-fg-3'}>{p.online ? 'online' : 'offline'}</span>
              </div>
            ))}
          </div>
        )}
        {pairing === 'phone' ? (
          <div className="pt-5">
            <p className="m-0 mb-4 max-w-[60ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">Open the Conclave app on your phone and scan the code, or type the code under it. On the same Wi-Fi it works now. To use it away from home, turn on remote access in step 1 first.</p>
            <PairingPanel kind="client" onPaired={() => setPairing(null)} />
          </div>
        ) : (
          <div className={phones.length ? 'pt-2' : 'pt-4'}>
            {phones.length ? (
              <TextAction className={LINK} label="Pair another phone" onClick={() => setPairing('phone')} />
            ) : (
              <Button variant="outline" size={ctl} onClick={() => setPairing('phone')}>
                Show the pairing code
              </Button>
            )}
          </div>
        )}
      </section>

      <section className="mt-10">
        <SectionHeading count={others.length > 1 ? others.length : undefined} action={pairing === 'computer' ? undefined : { label: 'Pair another computer', onClick: () => setPairing('computer') }}>
          Other machines
        </SectionHeading>
        <div className="rows">
          {others.map((d) => (
            <div key={d.id} className="flex items-baseline justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-medium text-fg phone:text-[15px]">
                  {d.name}
                  {d.id === 'local' && <span className="ml-2 font-normal text-fg-3">hub</span>}
                </div>
                <div className="truncate text-[12px] text-fg-3 phone:text-[13px]">
                  {[d.info?.platform === 'linux' ? 'Linux' : d.info?.platform === 'darwin' ? 'macOS' : d.info?.platform, d.info?.hostname !== d.name && d.info?.hostname, harnessesOn(d).length ? andList(harnessesOn(d).map((h) => harnessLabel(h.id) ?? h.id)) : undefined].filter(Boolean).join(', ')}
                </div>
              </div>
              <span className={d.online ? 'text-[13px] text-ok' : 'text-[13px] text-fg-3'}>{d.online ? 'online' : `offline, ${relTime(d.lastSeenAt)}`}</span>
            </div>
          ))}
        </div>
        {pairing === 'computer' && <ComputerPairing />}
      </section>
    </StepFrame>
  );
}
