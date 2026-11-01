/**
 * Devices (spec 11.9): every computer that runs the device agent, what it
 * runs and where sessions may work on it. Phones and browsers only talk to
 * the hub and run no work, so they are not here: a quiet line at the foot
 * counts them and opens Settings, Your account, Signed in (lib/apps.ts).
 * A list on the left, the selected machine on the right (on phones the list
 * opens each machine as its own view). The selection lives in the URL
 * (?d=arch-desktop) so back works everywhere.
 *
 * A computer paired for the first time with past chats on it shows the offer
 * to import them (features/import/OfferCard.tsx) until it is imported or
 * dismissed, the same one the Inbox has.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { MoreHorizontal } from 'lucide-react';
import type { Device, Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, removeKey, toast, useHub, useIsOwner } from '@/store/store';
import { useIsOwner as useIsOwnerRole } from '@/lib/people';
import { useIsDesktop, useIsMobile, useNow } from '@/lib/hooks';
import { signedInWords, useSignedIn } from '@/lib/apps';
import { cn } from '@/lib/text';
import { shortDate } from '@/lib/format';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { Input, Segmented } from '@/components/ui/Field';
import { ConfirmDialog, Dialog, Menu } from '@/components/ui/Overlay';
import { Aside, KV, Section, SectionHeading, TextAction } from '@/components/ui/Section';
import { ListRow, StateWord } from '@/components/ui/List';
import { EmptyState } from '@/components/ui/EmptyState';
import { HarnessMark, HarnessName } from '@/components/logo';
import { harnessLabel } from '@/lib/models';
import { Elapsed } from '@/components/motion';
import { PairingPanel, type Paired } from '@/components/devices/PairingPanel';
import { PairAddressLine } from '../settings/remote';
import { agoWords } from '../settings/parts';
import { capabilityWords, deviceKind, harnessesOn, MAIN_HARNESSES, otherTools } from './words';
import { FilesView } from './FilesView';
import { Folders } from './Folders';
import { ImportOfferCard } from '@/features/import/OfferCard';
import { DaemonUpdate, useDeviceUpdates } from './DaemonUpdate';
import type { DeviceUpdateDto } from '@conclave/core/client';

const RUNNING: Session['status'][] = ['running', 'waiting_approval', 'waiting_input'];

function daysAgo(ts: number, now: number) {
  const days = Math.floor((now - ts) / 86_400_000);
  if (days < 1) return 'today';
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export default function DevicesPage() {
  const params = useParams<{ id?: string }>();
  const [loc] = useLocation();
  if (params.id && loc.endsWith('/files')) return <FilesView deviceId={params.id} />;
  return <DeviceIndex />;
}

function useSorted() {
  const map = useHub((s) => s.devices);
  return useMemo(() => Object.values(map).sort((a, b) => Number(b.id === 'local') - Number(a.id === 'local') || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)), [map]);
}

function useRunning() {
  const sessions = useHub((s) => s.sessions);
  return useMemo(() => {
    const by: Record<string, Session[]> = {};
    for (const s of Object.values(sessions)) if (RUNNING.includes(s.status) && !s.archived) (by[s.device ?? 'local'] ??= []).push(s);
    return by;
  }, [sessions]);
}

function DeviceIndex() {
  const desktop = useIsDesktop();
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const search = useSearch();
  const devices = useSorted();
  const running = useRunning();
  const offers = useHub((s) => s.importOffers);
  const now = useNow(60_000);
  const [pair, setPair] = useState(false);
  const picked = new URLSearchParams(search).get('d');
  const selected = devices.find((d) => d.id === picked) ?? (desktop ? devices[0] : undefined);
  const online = devices.filter((d) => d.online).length;
  const sub = devices.length ? `${online} online${devices.length > online ? `, ${devices.length - online} offline` : ''}` : undefined;
  const select = (id: string) => navigate(`/devices?d=${encodeURIComponent(id)}`, { replace: desktop });

  // a phone opening one machine gets a back link to the list
  usePageHeader(!desktop && selected ? selected.name : undefined, '/devices');

  const pairButton = (
    <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={() => setPair(true)}>
      Pair a device
    </Button>
  );

  const list = (
    <div className="rows" role="list" aria-label="Devices">
      {devices.map((d) => {
        const n = running[d.id]?.length ?? 0;
        const agents = harnessesOn(d);
        return (
          <div role="listitem" key={d.id}>
            <ListRow
              inset={desktop}
              selected={desktop && selected?.id === d.id}
              onClick={() => select(d.id)}
              title={
                <>
                  {d.name}
                  {d.id === 'local' && <span className="ml-2 font-normal text-fg-3">hub</span>}
                </>
              }
              meta={
                <span className="block min-w-0 truncate">
                  {deviceKind(d)}
                  {agents.length > 0 && ', '}
                  {agents.length > 0 && <AgentWords ids={agents.map((a) => a.id)} />}
                  {offers[d.id] && <span className="text-warn">, past chats to import</span>}
                </span>
              }
              time={d.online ? (n ? `${n} running` : undefined) : d.lastSeenAt ? agoWords(d.lastSeenAt, now) : undefined}
              state={d.online ? 'online' : 'offline'}
              stateTone={d.online ? 'ok' : 'dim'}
            />
          </div>
        );
      })}
    </div>
  );

  const dialog = (
    <PairDialog
      open={pair}
      onClose={() => setPair(false)}
      onShow={(id) => {
        setPair(false);
        select(id);
      }}
    />
  );

  if (!desktop && selected)
    return (
      <Page width="wide">
        <DeviceDetail d={selected} running={running[selected.id] ?? []} />
        {dialog}
      </Page>
    );

  if (!desktop)
    return (
      <Page width="wide">
        <PageHeader title="Devices" sub={sub} actions={pairButton} />
        {list}
        {devices.length <= 2 && <PairHint />}
        <SignedInLine />
        {dialog}
      </Page>
    );

  return (
    <Page width="wide">
      <div className="grid min-h-[calc(100dvh-var(--bar-h,48px)-4rem)] grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="min-w-0 border-r border-rule pr-7">
          <PageHeader title="Devices" sub={sub} actions={pairButton} />
          <div className="-mx-3">{list}</div>
          {devices.length <= 2 && <PairHint />}
          <SignedInLine />
        </div>
        <div className="min-w-0 pl-10">{selected && <DeviceDetail key={selected.id} d={selected} running={running[selected.id] ?? []} />}</div>
      </div>
      {dialog}
    </Page>
  );
}

/** "Claude Code", "Claude Code and Codex", "4 coding agents": names in words, the mark before a lone one. */
function AgentWords({ ids }: { ids: string[] }) {
  if (ids.length === 1)
    return (
      <span className="whitespace-nowrap">
        <HarnessMark harness={ids[0]} size={13} className="mr-[5px]" />
        {harnessLabel(ids[0])}
      </span>
    );
  if (ids.length === 2) return <>{`${harnessLabel(ids[0])} and ${harnessLabel(ids[1])}`}</>;
  return <>{`${ids.length} coding agents`}</>;
}

/** The apps signed in (phones, browsers): not devices, so one line that opens their list. */
function SignedInLine() {
  const n = useSignedIn().length;
  if (!n) return null;
  return (
    <p className="mt-5 mb-0 text-[13px] text-fg-3 phone:text-[14px]">
      <Link href="/settings/account#signed-in" className="hover:text-fg-2 hover:underline hover:underline-offset-[3px]">
        {signedInWords(n)}
      </Link>
    </p>
  );
}

/** First day: the hub and this computer only. Say what pairing buys; Pair a device above is the one button for it. */
function PairHint() {
  return (
    <EmptyState wave={false} className="mt-4">
      Pair your phone to approve commands and get notifications away from the desk. Pair another machine to run sessions there.
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------
// One machine
// ---------------------------------------------------------------------------

function DeviceDetail({ d, running }: { d: Device; running: Session[] }) {
  const [, navigate] = useLocation();
  const offer = useHub((s) => s.importOffers[d.id]);
  const mobile = useIsMobile();
  const now = useNow(60_000);
  const [renaming, setRenaming] = useState(false);
  const [roots, setRoots] = useState(false);
  const [remove, setRemove] = useState(false);
  const hub = d.id === 'local';
  // the hub's own device: only the owner names it, and its folders are not set here
  const owner = useIsOwner();
  const ownerRole = useIsOwnerRole();
  const canRename = !hub || owner;
  // a member's tools never run on the hub's own computer (docs/design/ACCOUNTS.md 5): no files or folders of it to show
  const usable = !hub || ownerRole;
  const found = harnessesOn(d);
  const missing = MAIN_HARNESSES.filter((id) => !found.some((f) => f.id === id));
  const tools = otherTools(d);
  const files = `/devices/${encodeURIComponent(d.id)}/files`;
  // its daemon against the hub's version (the owner's; DaemonUpdate.tsx)
  const updates = useDeviceUpdates();
  const [sent, setSent] = useState<DeviceUpdateDto>();
  const fromHub = updates?.devices.find((u) => u.deviceId === d.id);
  const update = sent?.deviceId === d.id && (!fromHub?.at || (sent.at ?? 0) >= fromHub.at) ? sent : fromHub;

  const menu = [
    ...(canRename ? [{ label: 'Rename', onSelect: () => setRenaming(true) }] : []),
    ...(hub
      ? []
      : [
          { label: 'Edit roots', onSelect: () => setRoots(true) },
          { separator: true, label: '' },
          { label: 'Remove', danger: true, onSelect: () => setRemove(true) },
        ]),
  ];

  return (
    <div className="pb-8">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3 pt-6 pb-5">
        <div className="min-w-0 grow">
          {renaming ? (
            <Rename d={d} onDone={() => setRenaming(false)} />
          ) : mobile ? (
            <h2 className="sr-only">{d.name}</h2>
          ) : (
            <h2 className="t-page m-0 text-fg">
              {canRename ? (
                <button type="button" className="rounded-[var(--r-1)] text-left hover:text-fg-2" title="Rename" onClick={() => setRenaming(true)}>
                  {d.name}
                </button>
              ) : (
                d.name
              )}
              {hub && <span className="ml-2 text-[13px] font-normal tracking-normal text-fg-3">hub</span>}
            </h2>
          )}
          <p className="mt-1 text-[13px] text-fg-3 phone:mt-0 phone:text-[15px]">
            {deviceKind(d)},{' '}
            {d.online ? (
              <StateWord tone="ok">online</StateWord>
            ) : (
              <StateWord tone="dim">
                offline
                {d.lastSeenAt ? `, last seen ${agoWords(d.lastSeenAt, now)}` : ''}
              </StateWord>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {usable && (
            <ButtonLink
              href={files}
              variant="outline"
              size={mobile ? 'touch' : 'md'}
              aria-disabled={!d.online || undefined}
              onClick={(e) => !d.online && e.preventDefault()}
              className={cn(!d.online && 'text-fg-3 hov:bg-transparent')}
            >
              Browse files
            </ButtonLink>
          )}
          {menu.length > 0 && (
            <Menu
              items={menu}
              label={`${d.name} actions`}
              trigger={({ ref, props }) => (
                <IconButton ref={ref} label="More actions" size={mobile ? 'touch' : 'md'} {...props}>
                  <MoreHorizontal />
                </IconButton>
              )}
            />
          )}
        </div>
      </header>

      {offer && <ImportOfferCard offer={offer} className="mb-8 max-w-[760px]" />}

      <div className="grid gap-x-12 gap-y-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
        <div className="min-w-0 space-y-8">
          <Section title="Coding agents" count={found.length || undefined}>
            {found.map((h) => (
              <div key={h.id} className="flex items-center gap-3 py-2.5">
                <HarnessName harness={h.id} size={16} className="min-w-0 flex-1 text-[13.5px] font-medium text-fg phone:text-[15px]" />
                <span className="font-mono text-[12px] text-fg-3">{h.version}</span>
              </div>
            ))}
            {missing.length > 0 && (
              <p className="m-0 py-2.5 text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">
                {found.length ? 'Not installed: ' : 'No coding agents found. Install '}
                {missing.map((id, i) => (
                  <span key={id}>
                    {harnessLabel(id)}
                    {i < missing.length - 2 ? ', ' : i === missing.length - 2 ? (found.length ? ' and ' : ' or ') : ''}
                  </span>
                ))}
                {found.length ? '.' : ` on ${d.name} to run sessions with it.`}
              </p>
            )}
          </Section>

          <section aria-labelledby={`roots-${d.id}`}>
            <SectionHeading id={`roots-${d.id}`} count={d.roots.length || undefined} action={hub ? undefined : { label: 'Edit', onClick: () => setRoots(true) }}>
              Roots
            </SectionHeading>
            <p className="mt-2.5 mb-1 text-[12px] text-fg-3 phone:text-[13px]">Sessions on {d.name} may only read and write inside these folders.</p>
            <div className="rows">
              {(d.roots.length ? d.roots : [d.info?.home ?? '~']).map((r) => (
                <div key={r} className="flex items-baseline gap-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{r}</span>
                  {!d.roots.length && <span className="text-[12px] text-fg-3">home folder, no roots set</span>}
                  {d.online && usable && <TextAction label="Browse" href={`${files}?path=${encodeURIComponent(r)}`} />}
                </div>
              ))}
            </div>
          </section>

          {usable && <Folders d={d} />}

          <Section title="Running here" count={running.length}>
            {running.length ? (
              running.map((s) => (
                <ListRow
                  key={s.id}
                  inset={false}
                  href={`/s/${s.id}`}
                  title={s.title}
                  meta={
                    <span className="truncate">
                      {s.agent}, {s.cwd && <span className="mono">{s.cwd}</span>}
                    </span>
                  }
                  state={
                    s.status === 'running' ? (
                      <Elapsed since={s.createdAt} format="short" className="text-signal" />
                    ) : (
                      <StateWord tone="warn">{s.status === 'waiting_input' ? 'answer' : 'approve'}</StateWord>
                    )
                  }
                />
              ))
            ) : (
              <p className="py-3 text-[14px] text-fg-2">Nothing running on {d.name}.</p>
            )}
          </Section>
        </div>

        <div className="min-w-0 space-y-8">
          <Aside title="Machine">
            {d.info ? (
              <>
                <KV k="Hostname" mono>
                  {d.info.hostname}
                </KV>
                <KV k="System">
                  {d.info.platform === 'darwin' ? 'macOS' : d.info.platform === 'linux' ? 'Linux' : d.info.platform}, {d.info.arch}
                </KV>
                <KV k="Shell" mono>
                  {d.info.shell}
                </KV>
                {d.info.capabilities.length > 0 && <KV k="Can use">{capabilityWords(d.info.capabilities)}</KV>}
                {d.info.daemon && (
                  <KV k="Device agent">
                    {d.info.daemon.impl === 'rust' ? 'Rust' : d.info.daemon.impl} {d.info.daemon.version}
                  </KV>
                )}
                {!hub && <DaemonUpdate d={d} update={update} onChange={setSent} />}
              </>
            ) : (
              <p className="py-1.5 text-[13px] text-fg-3">Not reported yet. The device agent sends this when it connects.</p>
            )}
            <KV k="Paired">
              {shortDate(d.createdAt)}, {daysAgo(d.createdAt, now)}
            </KV>
          </Aside>
          {tools.length > 0 && (
            <section>
              <SectionHeading count={tools.length}>Other tools</SectionHeading>
              <p className="mt-2.5 text-[13px] leading-[1.7] text-fg-2">
                {tools.map(([k, v], i) => (
                  <span key={k}>
                    <span className="whitespace-nowrap">
                      {k} <span className="font-mono text-[12px] text-fg-3">{v}</span>
                    </span>
                    {i < tools.length - 1 && ', '}
                  </span>
                ))}
              </p>
            </section>
          )}
        </div>
      </div>

      <RootsDialog d={d} open={roots} onClose={() => setRoots(false)} />
      <ConfirmDialog
        open={remove}
        onClose={() => setRemove(false)}
        title={`Remove ${d.name}?`}
        body="Its device agent disconnects and sessions can no longer run there. Pair it again to bring it back."
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          if (await attempt(() => api().deleteDevice(d.id))) {
            removeKey('devices', d.id);
            navigate('/devices', { replace: true });
          }
        }}
      />
    </div>
  );
}

function Rename({ d, onDone }: { d: Device; onDone: () => void }) {
  const [name, setName] = useState(d.name);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const save = async () => {
    const v = name.trim();
    if (!v || v === d.name) return onDone();
    setBusy(true);
    const r = await attempt(() => api().updateDevice(d.id, { name: v }));
    setBusy(false);
    if (r)
      useHub.setState((s) => ({
        devices: { ...s.devices, [d.id]: { ...s.devices[d.id], ...r } },
      }));
    onDone();
  };
  return (
    <form
      className="flex max-w-[420px] items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Input
        ref={ref}
        value={name}
        aria-label="Device name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
        className="font-medium"
      />
      <Button type="submit" variant="solid" busy={busy ? 'Saving' : false}>
        Save
      </Button>
      <Button variant="quiet" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

function RootsDialog({ d, open, onClose }: { d: Device; open: boolean; onClose: () => void }) {
  const [list, setList] = useState<string[]>(d.roots);
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  // only when it opens: the device reconnecting mid-edit must not wipe the edits
  useEffect(() => {
    if (open) {
      setList(d.roots);
      setNext('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const add = () => {
    const v = next.trim();
    if (v && !list.includes(v)) setList([...list, v]);
    setNext('');
  };
  const save = async () => {
    const pending = next.trim();
    const roots = pending && !list.includes(pending) ? [...list, pending] : list;
    setBusy(true);
    const r = await attempt(() => api().updateDevice(d.id, { roots }));
    setBusy(false);
    if (r) {
      useHub.setState((s) => ({
        devices: { ...s.devices, [d.id]: { ...s.devices[d.id], ...r } },
      }));
      toast({ title: `Roots on ${d.name} saved.` });
      onClose();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Roots on ${d.name}`}
      description="Sessions may only read and write inside these folders. With none, they use the home folder."
      width={520}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" busy={busy ? 'Saving' : false} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="rows border-y border-rule">
        {list.map((r) => (
          <div key={r} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{r}</span>
            <TextAction label="Remove" onClick={() => setList(list.filter((x) => x !== r))} />
          </div>
        ))}
        {!list.length && <p className="py-2.5 text-[13px] text-fg-3">No roots. Sessions use the home folder.</p>}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input mono value={next} onChange={(e) => setNext(e.target.value)} placeholder="~/code" aria-label="Folder to add" />
        <Button type="submit" variant="outline" disabled={!next.trim()}>
          Add
        </Button>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

function PairDialog({ open, onClose, onShow }: { open: boolean; onClose: () => void; onShow: (id: string) => void }) {
  const mobile = useIsMobile();
  const [kind, setKind] = useState<'client' | 'device'>('client');
  const [paired, setPaired] = useState<Paired | null>(null);
  useEffect(() => {
    if (open) setPaired(null);
  }, [open, kind]);
  // a phone or a browser is an app, listed in Settings, Your account; a computer is a device here
  const footer: ReactNode = paired ? (
    kind === 'device' ? (
      <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={() => onShow(paired.id)}>
        Show {paired.name}
      </Button>
    ) : (
      <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={onClose}>
        Done
      </Button>
    )
  ) : (
    <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
      Cancel
    </Button>
  );
  return (
    <Dialog open={open} onClose={onClose} title="Pair a device" width={560} footer={footer}>
      <div className="flex flex-col gap-5 pt-1">
        <Segmented
          label="What to pair"
          value={kind}
          onChange={setKind}
          full
          size={mobile ? 'touch' : 'md'}
          options={[
            // a phone or a browser only talks to the hub (Settings, Your account lists it); a computer runs the work and is listed here
            { value: 'client', label: mobile ? 'App' : 'App or browser' },
            { value: 'device', label: mobile ? 'Command line' : 'Computer, command line' },
          ]}
        />
        <p className="text-[13px] text-fg-2 phone:text-[14px]">
          {kind === 'client'
            ? mobile
              ? // a phone showing the code cannot scan it: typing comes first here
                'Type this code on the other device, or scan it with the Conclave app there. It gets approvals, notifications and every session.'
              : 'For the Conclave app on a phone or a computer, or a browser. Scan the code or type it. On a computer, the desktop app then offers Let the hub use this computer, so work can run there.'
            : 'For a computer without the desktop app: install the conclave command there, then pair it with this code. With the desktop app, use App or browser instead.'}
        </p>
        {open && !paired && <PairAddressLine />}
        {/* a new hub address (a tunnel came up, remote access set) comes into the same code's QR */}
        {open && <PairingPanel key={kind} kind={kind} onPaired={setPaired} />}
        {paired && kind === 'client' && (
          <p className="m-0 text-[13px] text-fg-2 phone:text-[14px]">
            Phones and browsers are not devices: {paired.name} is under{' '}
            <Link href="/settings/account#signed-in" className="link" onClick={onClose}>
              Settings, Your account
            </Link>
            .
          </p>
        )}
      </div>
    </Dialog>
  );
}
