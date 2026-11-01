/**
 * Settings > Remote access: how phones and paired computers reach the hub.
 * The state in words with the address, the way in (Quick tunnel, Stable
 * address with Cloudflare, Tailscale, My own URL, Local only), the same
 * network, every address, a pairing code, and what an outside address
 * exposes. Onboarding's hub step and the Devices pairing dialog use the same
 * choice (RemoteChoice, PairAddressLine).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { Link } from 'wouter';
import type { HubAddress, RemoteMode, RemoteStatus } from '@conclave/core/types';
import type { CloudflareZoneDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useCopy, useIsMobile } from '@/lib/hooks';
import { hhmm } from '@/lib/format';
import { cn } from '@/lib/text';
import { MODE_HELP, MODE_LABEL, MODES, outsideAddress, rememberAddresses, stateSentence } from '@/lib/remote';
import { toast, useHub } from '@/store/store';
import { Button, IconButton } from '@/components/ui/Button';
import { Input, OnOff, Radio } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { LoadingRows } from '@/components/ui/EmptyState';
import { PairingPanel } from '@/components/devices/PairingPanel';
import { LiveStatus } from '@/components/motion';
import { errText, Group, SettingRow } from './parts';
import { IdentityGroup } from './identity';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** The hub's remote access status: loaded once, then kept current by remote.updated events. */
export function useRemote(): { status: RemoteStatus | undefined; set: (s: RemoteStatus) => void; error?: string; reload: () => void } {
  const live = useHub((s) => s.remote);
  const [status, setStatus] = useState<RemoteStatus | undefined>(live);
  const [error, setError] = useState<string>();
  const load = () => {
    setError(undefined);
    api()
      .remote()
      .then((s) => {
        setStatus(s);
        useHub.setState({ remote: s });
        rememberAddresses(s);
      })
      .catch((e) => setError(errText(e)));
  };
  useEffect(load, []);
  useEffect(() => {
    if (live) setStatus(live);
  }, [live]);
  const set = (s: RemoteStatus) => {
    setStatus(s);
    useHub.setState({ remote: s });
  };
  return { status, set, error, reload: load };
}

/** Run a remote access call; on failure toast the hub's words and return undefined. */
async function call<T extends RemoteStatus>(fn: () => Promise<T>, set: (s: RemoteStatus) => void): Promise<T | undefined> {
  try {
    const s = await fn();
    set(s);
    return s;
  } catch (e) {
    toast({ title: errText(e), level: 'error' });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function CopyIcon({ text, label }: { text: string; label: string }) {
  const [copied, copy] = useCopy();
  const mobile = useIsMobile();
  return (
    <IconButton label={copied ? 'Copied' : label} size={mobile ? 'touch' : 'sm'} onClick={() => copy(text)} className="phone:-mr-3">
      {copied ? <Check className="text-ok" /> : <Copy />}
    </IconButton>
  );
}

const TONE = { ok: 'text-ok', fault: 'text-fault', dim: 'text-fg-3', live: 'text-signal' } as const;

/** A hub message with `commands` in it, the commands set in mono. */
export function HubText({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <span key={i} className="mono text-[0.92em]">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** A URL that wraps after its dots, slashes and dashes rather than inside a word. */
export function Url({ url, className }: { url: string; className?: string }) {
  const parts = url.split(/(?<=[./-])/);
  return (
    <span className={cn('font-mono [overflow-wrap:anywhere]', className)}>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <wbr />}
        </span>
      ))}
    </span>
  );
}

/** "On. Phones and computers reach the hub at https://...", with Copy, New address or Try again. */
export function RemoteStatusLine({ s, set, compact }: { s: RemoteStatus; set: (s: RemoteStatus) => void; compact?: boolean }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [busy, setBusy] = useState(false);
  const sentence = stateSentence(s);
  const out = outsideAddress(s);
  const working = s.state === 'starting' || s.state === 'installing';
  const tunnel = s.mode === 'quick' || s.mode === 'stable';
  const again = async () => {
    setBusy(true);
    await call(() => (tunnel ? api().restartRemote() : api().setRemote({ mode: s.mode })), set);
    setBusy(false);
  };
  return (
    <div>
      <p className={cn('m-0 leading-[1.45] text-fg', compact ? 'text-[15px]' : 'text-[17px] phone:text-[17px]')}>
        <span className={cn('state-word', TONE[sentence.tone])}>{sentence.word}</span> {s.state === 'on' && out ? 'Phones and computers reach the hub at this address.' : <HubText text={sentence.rest} />}
      </p>
      {s.state === 'on' && out && (
        <p className={cn('m-0 mt-1 text-fg', compact ? 'text-[13.5px]' : 'text-[15px] phone:text-[14px]')}>
          <Url url={out.url} />
        </p>
      )}
      {working && (
        <div className="mt-2 text-[13px]">
          <LiveStatus state="tool" label={s.state === 'installing' ? 'Downloading' : 'Waiting for Cloudflare'} startedAt={s.since} />
        </div>
      )}
      {s.state === 'on' && s.detail && <p className="m-0 mt-1.5 text-[13px] text-warn">{s.detail}</p>}
      {s.state === 'on' && s.mode === 'quick' && !compact && (
        <p className="m-0 mt-1.5 max-w-[64ch] text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">
          On since {hhmm(s.since)}. The address changes when the hub restarts. Paired apps and computers follow it while they are connected; one that was away scans a new code.
        </p>
      )}
      {s.state === 'error' && s.detail && <p className="m-0 mt-1.5 text-[13px] text-fg-3">{s.detail}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {s.state === 'on' && out && <CopyButton text={out.url} />}
        {s.state === 'on' && s.mode === 'quick' && (
          <Button variant="quiet" size={size} busy={busy ? 'Asking' : false} onClick={() => void again()}>
            New address
          </Button>
        )}
        {s.state === 'error' && (
          <Button variant="outline" size={size} busy={busy ? 'Trying' : false} onClick={() => void again()}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, copy] = useCopy();
  const mobile = useIsMobile();
  return (
    <Button variant="outline" size={mobile ? 'touch' : 'sm'} onClick={() => copy(text)}>
      {copied ? 'Copied' : 'Copy address'}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// The choice
// ---------------------------------------------------------------------------

function UrlForm({ s, set, mode, placeholder, find }: { s: RemoteStatus; set: (s: RemoteStatus) => void; mode: 'tailscale' | 'custom'; placeholder: string; find?: boolean }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'md';
  const own = s.addresses.find((a) => a.kind === 'own')?.url ?? '';
  const [url, setUrl] = useState(own);
  const [busy, setBusy] = useState<'save' | 'find' | null>(null);
  const [note, setNote] = useState<ReactNode>();
  useEffect(() => setUrl(own), [own]);
  const save = async () => {
    setBusy('save');
    await call(() => api().setRemote({ mode, url: url.trim() }), set);
    setBusy(null);
  };
  const lookup = async () => {
    setBusy('find');
    setNote(undefined);
    try {
      const ts = await api().tailscaleInfo();
      if (ts.url) {
        setUrl(ts.url);
        setNote(
          <>
            Found {ts.dnsName}. If it does not answer, run <span className="mono">{ts.command}</span> on the hub.
          </>,
        );
      } else
        setNote(
          ts.installed ? (
            <>
              Tailscale is not connected on the hub. Run <span className="mono">sudo tailscale up</span>, then <span className="mono">{ts.command}</span>.
            </>
          ) : (
            'Tailscale is not installed on the hub. Install it there, or pick another option.'
          ),
        );
    } catch (e) {
      setNote(errText(e));
    }
    setBusy(null);
  };
  const dirty = url.trim() !== own || s.mode !== mode;
  return (
    <div className="max-w-[520px]">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && dirty) void save();
        }}
      >
        {/* on a phone the address gets its own line, so it is not cut short */}
        <Input mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder={placeholder} aria-label={mode === 'tailscale' ? 'Tailscale address' : 'Your address'} spellCheck={false} autoCapitalize="off" className="min-w-0 flex-1 phone:basis-full" />
        {find && (
          <Button type="button" variant="outline" size={size} busy={busy === 'find' ? 'Looking' : false} onClick={() => void lookup()}>
            Find it
          </Button>
        )}
        <Button type="submit" variant="solid" size={size} disabled={!url.trim() || !dirty} busy={busy === 'save' ? 'Saving' : false}>
          Use it
        </Button>
      </form>
      {note && <p className="m-0 mt-2 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">{note}</p>}
    </div>
  );
}

function StableSetup({ s, set }: { s: RemoteStatus; set: (s: RemoteStatus) => void }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'md';
  const [token, setToken] = useState('');
  const [zones, setZones] = useState<CloudflareZoneDto[] | null>(null);
  const [zone, setZone] = useState<string>();
  const [name, setName] = useState('conclave');
  const [busy, setBusy] = useState<'token' | 'setup' | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!s.cloudflareToken || zones) return;
    api()
      .cloudflareZones()
      .then((r) => {
        setZones(r.zones);
        setZone((z) => z ?? r.zones[0]?.id);
      })
      .catch(() => undefined);
  }, [s.cloudflareToken, zones]);

  const check = async () => {
    setBusy('token');
    setError(undefined);
    try {
      const r = await api().cloudflareToken(token.trim());
      setZones(r.zones);
      setZone(r.zones[0]?.id);
      setToken('');
    } catch (e) {
      setError(errText(e));
    }
    setBusy(null);
  };
  const setup = async () => {
    if (!zone) return;
    setBusy('setup');
    setError(undefined);
    try {
      set(await api().setupStableTunnel({ zoneId: zone, name: name.trim() || 'conclave' }));
    } catch (e) {
      setError(errText(e));
    }
    setBusy(null);
  };
  const zoneName = zones?.find((z) => z.id === zone)?.name;

  if (!zones)
    return (
      <div className="max-w-[520px]">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void check();
          }}
        >
          <Input mono type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Cloudflare API token" aria-label="Cloudflare API token" autoComplete="off" spellCheck={false} className="min-w-0 flex-1" />
          <Button type="submit" variant="solid" size={size} disabled={!token.trim()} busy={busy === 'token' ? 'Checking' : false}>
            Check
          </Button>
        </form>
        <p className="m-0 mt-2 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">
          Make one in the Cloudflare dashboard under My Profile, API Tokens, with Account, Cloudflare Tunnel, Edit and Zone, DNS, Edit. The hub keeps it in its secrets store and never shows it again.
        </p>
        {error && <p className="m-0 mt-2 text-[13px] text-fault">{error}</p>}
      </div>
    );

  return (
    <div className="max-w-[520px]">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Input mono value={name} onChange={(e) => setName(e.target.value.toLowerCase())} aria-label="Name in front of the domain" spellCheck={false} autoCapitalize="off" suffix={zoneName ? `.${zoneName}` : undefined} />
        <SelectMenu label="Domain" value={zone} onChange={setZone} options={zones.map((z) => ({ value: z.id, label: z.name, text: z.name, detail: z.accountName }))} placeholder="Pick a domain" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="solid" size={size} disabled={!zone || !name.trim()} busy={busy === 'setup' ? 'Setting up' : false} onClick={() => void setup()}>
          Set up {name.trim() && zoneName ? `${name.trim()}.${zoneName}` : 'the address'}
        </Button>
        <span className="text-[12px] text-fg-3 phone:text-[13px]">Makes a tunnel and a DNS name on that domain. Nothing else changes.</span>
      </div>
      {error && <p className="m-0 mt-2 text-[13px] text-fault">{error}</p>}
    </div>
  );
}

function StableDone({ s, set }: { s: RemoteStatus; set: (s: RemoteStatus) => void }) {
  const mobile = useIsMobile();
  const [confirm, setConfirm] = useState(false);
  if (!s.stable) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-[13px] text-fg-2 phone:text-[14px]">
        <span className="mono text-fg">{s.stable.hostname}</span> on {s.stable.zone}
      </span>
      <Button variant="danger" size={mobile ? 'touch' : 'sm'} onClick={() => setConfirm(true)}>
        Remove
      </Button>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Remove ${s.stable.hostname}?`}
        body="The hub deletes the tunnel and the DNS name at Cloudflare and forgets the token. Remote access turns off; paired apps can still use the same network."
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          const r = await call(() => api().removeStableTunnel(), set);
          if (r?.warning) toast({ title: r.warning, level: 'error', sticky: true });
          setConfirm(false);
        }}
      />
    </div>
  );
}

/**
 * The way in, as radio rows with help. Quick and Local only apply at once;
 * the others ask for what they need first (a token and a domain, an address).
 */
export function RemoteChoice({ s, set, modes = MODES }: { s: RemoteStatus; set: (s: RemoteStatus) => void; modes?: RemoteMode[] }) {
  const [picked, setPicked] = useState<RemoteMode>(s.mode);
  useEffect(() => setPicked(s.mode), [s.mode]);
  const own = s.addresses.find((a) => a.kind === 'own');
  const pick = (m: RemoteMode) => {
    setPicked(m);
    const ready = m === 'quick' || m === 'off' || (m === 'stable' && !!s.stable) || ((m === 'tailscale' || m === 'custom') && !!own);
    if (ready && m !== s.mode) void call(() => api().setRemote({ mode: m }), set);
  };
  return (
    <div role="radiogroup" aria-label="How devices reach the hub" className="rows">
      {modes.map((m) => (
        <Radio
          key={m}
          name="remote-mode"
          checked={picked === m}
          onChange={() => pick(m)}
          label={
            <>
              {MODE_LABEL[m]}
              {m === 'quick' && <span className="ml-2 font-normal text-fg-3">suggested</span>}
            </>
          }
          description={MODE_HELP[m]}
          className="py-3"
        >
          {m === 'stable' ? s.stable ? <StableDone s={s} set={set} /> : <StableSetup s={s} set={set} /> : null}
          {m === 'tailscale' && <UrlForm s={s} set={set} mode="tailscale" placeholder="https://madx.tail4e2a.ts.net" find />}
          {m === 'custom' && <UrlForm s={s} set={set} mode="custom" placeholder="https://hub.example.com" />}
        </Radio>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pairing dialog's address line
// ---------------------------------------------------------------------------

/**
 * Which address a pairing code carries, and a way to make one that works
 * away from home. When it changes, the pairing panel shows the same code
 * with the new address (PairingPanel).
 */
export function PairAddressLine() {
  const { status: s, set } = useRemote();
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const first = s?.addresses[0];
  if (!s) return null;
  const out = outsideAddress(s);
  const working = s.state === 'starting' || s.state === 'installing';
  // a tunnel that is picked but failing gets another try, not a second "turn on"
  const failing = s.state === 'error' && (s.mode === 'quick' || s.mode === 'stable');
  return (
    <div className="text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
      {first ? (
        <p className="m-0">
          The code carries <Url url={first.url} className="text-[0.93em] text-fg" />
          <span className="text-fg-3">, {first.label.toLowerCase().startsWith('wi-fi') || first.kind === 'lan' ? 'this network' : first.label}</span>.
        </p>
      ) : (
        <p className="m-0">The code carries this computer's address, so only this computer can use it.</p>
      )}
      {!out && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          {working ? (
            <LiveStatus state="tool" label="Starting the quick tunnel" startedAt={s.since} />
          ) : (
            <>
              <span className="text-fg-3">{failing ? (first ? 'The tunnel is not working yet, so this code only works at home.' : 'The tunnel is not working yet.') : first ? 'Away from home it will not work.' : 'Phones cannot reach the hub yet.'}</span>
              <Button
                variant="outline"
                size={mobile ? 'touch' : 'sm'}
                busy={busy ? (failing ? 'Trying' : 'Turning on') : false}
                onClick={async () => {
                  setBusy(true);
                  await call(() => (failing ? api().restartRemote() : api().setRemote({ mode: 'quick' })), set);
                  setBusy(false);
                }}
              >
                {failing ? 'Try again' : 'Turn on the quick tunnel'}
              </Button>
              <Link href="/settings/remote" className="link text-[12px] text-fg-3 phone:text-[13px]">
                Other ways
              </Link>
            </>
          )}
        </div>
      )}
      {s.state === 'error' && s.error && !working && (
        <p className="m-0 mt-2 text-fault">
          <HubText text={s.error} />
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

function AddressRow({ a, first }: { a: HubAddress; first: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-fg phone:text-[15px]">
          {a.label}
          {first && <span className="ml-2 font-normal text-fg-3">in pairing codes</span>}
        </div>
        <div className="mt-0.5 text-[12.5px] text-fg-2">
          <Url url={a.url} />
        </div>
      </div>
      <CopyIcon text={a.url} label={`Copy ${a.url}`} />
    </div>
  );
}

const REACHABLE: Array<{ k: ReactNode; v: ReactNode }> = [
  { k: 'Web app', v: 'Anyone with the address sees the sign-in screen. Nothing in it works without a token.' },
  {
    k: (
      <>
        API and live updates, <span className="mono">/api</span>
      </>
    ),
    v: "Needs the hub token or a paired device's token.",
  },
  {
    k: (
      <>
        MCP server, <span className="mono">/mcp</span>
      </>
    ),
    v: 'Needs a token, a gateway key, or an OAuth token from an app you allowed. Each app can only do what you allowed.',
  },
  {
    k: (
      <>
        App sign in, <span className="mono">/oauth</span> and <span className="mono">/.well-known</span>
      </>
    ),
    v: 'Anyone can read the sign in details and register an app. An app gets nothing until you allow it on the consent page, signed in. Settings, Connected apps lists them.',
  },
  {
    k: (
      <>
        Model gateway, <span className="mono">/gw</span>
      </>
    ),
    v: 'Needs a gateway key. Calls from the internet cannot pass on their own provider login without one.',
  },
  { k: 'Pairing', v: 'One-time codes that expire after 10 minutes. Ten wrong codes from one address block it, for longer each time.' },
  { k: 'Password login', v: 'Off until you set a password under This hub. A wrong password counts as a wrong pairing code for the address.' },
  { k: 'Wrong tokens', v: 'Twenty different ones from one address in 10 minutes block it for a minute, then longer. An app retrying one old token counts once. Blocks, pairings and changes here go in the audit log.' },
];

export function RemoteSection() {
  const mobile = useIsMobile();
  const { status: s, set, error, reload } = useRemote();
  const [pairing, setPairing] = useState(false);
  const [lanBusy, setLanBusy] = useState(false);
  if (error && !s)
    return (
      <div>
        <p className="m-0 text-[14px] text-fault">Could not load remote access. {error}</p>
        <Button className="mt-3" variant="outline" size={mobile ? 'touch' : 'sm'} onClick={reload}>
          Try again
        </Button>
      </div>
    );
  if (!s) return <LoadingRows loading rows={5} />;
  const lan = s.addresses.filter((a) => a.kind === 'lan');
  const lanHelp = s.lan.fixedHost ? (
    <>
      The hub listens on <span className="mono">{s.lan.fixedHost}</span>, set by <span className="mono">--host</span> or <span className="mono">server.host</span>. Change it there. A hub the desktop app runs listens on this computer only until Let phones on this Wi-Fi connect is on in the app's Settings.
    </>
  ) : s.lan.on ? (
    lan.length ? (
      <>
        Phones on this Wi-Fi use <span className="mono">{lan[0].url}</span>. It is plain http, so keep it to networks you trust.
      </>
    ) : (
      'On, but this machine has no address on a home or office network right now.'
    )
  ) : (
    'Off: only this computer and the remote address reach the hub.'
  );

  return (
    <div className="space-y-9">
      <RemoteStatusLine s={s} set={set} />

      <Group title="How devices reach the hub" help="From anywhere, not only this network. Pairing codes and notification links use the address this gives.">
        <RemoteChoice s={s} set={set} />
      </Group>

      <Group title="Same network">
        <SettingRow label="Devices on this network" help={lanHelp}>
          <OnOff
            label="Devices on this network"
            size={mobile ? 'touch' : 'sm'}
            disabled={!!s.lan.fixedHost || lanBusy}
            checked={s.lan.on}
            onChange={async (v) => {
              setLanBusy(true);
              await call(() => api().setRemote({ lan: v }), set);
              setLanBusy(false);
            }}
          />
        </SettingRow>
      </Group>

      <Group title="Addresses" count={s.addresses.length || undefined} help={s.addresses.length ? 'Paired apps keep every one and try the next when one stops answering.' : undefined}>
        {s.addresses.length ? s.addresses.map((a, i) => <AddressRow key={a.url} a={a} first={i === 0} />) : <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[14px]">Only this computer reaches the hub. Turn on the quick tunnel, or devices on this network, to pair a phone.</p>}
      </Group>

      {/* with no address but this computer's, a code would not reach any phone: the Addresses line above says what to turn on */}
      {s.addresses.length > 0 && (
        <Group title="Pair a phone">
          {pairing ? (
            <div className="pt-4">
              {/* a new address comes into the same code's QR (PairingPanel) */}
              <PairingPanel kind="client" />
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pt-3.5">
              <p className="m-0 max-w-[52ch] min-w-0 flex-1 text-[13px] leading-[1.5] text-fg-2 phone:min-w-full phone:text-[14px]">Scan the code with the Conclave app. It carries the first address above and the others as fallbacks.</p>
              <Button variant="outline" size={mobile ? 'touch' : 'md'} onClick={() => setPairing(true)}>
                Show a pairing code
              </Button>
            </div>
          )}
        </Group>
      )}

      <IdentityGroup />

      <Group title="What an outside address exposes" help="Anyone who learns the address can reach these. Each one checks a token, a key or a code first.">
        {REACHABLE.map((r, i) => (
          <SettingRow key={i} label={r.k} help={r.v} stack />
        ))}
        <div className="py-3">
          <Link href="/settings/audit" className="link text-[13px] text-fg-2 phone:text-[14px]">
            Open the audit log
          </Link>
        </div>
      </Group>

      {s.cloudflared && (
        <p className="max-w-[64ch] border-t border-rule pt-4 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">
          cloudflared {s.cloudflared.version ?? ''} at <span className="mono break-all">{s.cloudflared.path}</span>
          {!s.cloudflared.managed
            ? '.'
            : s.cloudflared.verified
              ? ", downloaded by the hub from Cloudflare's releases on GitHub. Its SHA-256 matched the one GitHub publishes."
              : ", downloaded by the hub from Cloudflare's releases on GitHub. GitHub's checksum was not available then, so the hub checked its size and that it runs."}
        </p>
      )}
    </div>
  );
}
