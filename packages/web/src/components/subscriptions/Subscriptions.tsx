/**
 * Subscription sign-in, shared by setup step 2 and Settings > Models >
 * Subscriptions: one row per subscription the running CLIProxyAPI signs in
 * to (Claude, ChatGPT, Google, Grok, Kimi, Muse, then More), the sign-in
 * itself under its row, the accounts, the models per account, the form for
 * a CLIProxyAPI the owner already runs, and the status line.
 *
 * Signing in opens the provider's page in a new tab and polls the hub. The
 * provider ends on a localhost page. When the browser is on the hub's own
 * computer the hub catches it and nothing else is asked; otherwise one line
 * says that page will not load and asks for its address from the browser
 * bar.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, MoreHorizontal } from 'lucide-react';
import type { SignInStartDto, SubscriptionAccountDto, SubscriptionModelGroupDto, SubscriptionProviderDto, SubscriptionsStatus } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useCopy, useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { ACCOUNT_WORD, SUB_LOGO, TONE_CLASS, accountLabel, statusSentence, untilOn } from '@/lib/subscriptions';
import { toast, useHub } from '@/store/store';
import { Logo, ModelMark } from '@/components/logo';
import { LiveStatus } from '@/components/motion';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { Field, Help, Input } from '@/components/ui/Field';
import { ConfirmDialog, Menu } from '@/components/ui/Overlay';

const LINK = 'underline decoration-rule-2 underline-offset-[3px] hover:decoration-fg-3 phone:-my-3 phone:inline-block phone:py-3';

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

function useCtl(): 'sm' | 'touch' {
  return useIsMobile() ? 'touch' : 'sm';
}

/** The company mark for a sign-in, or a monogram for one the hub does not know (a plugin's). */
export function SubMark({ id, name, size = 22 }: { id: string; name: string; size?: number }) {
  return <Logo id={SUB_LOGO[id]} tone="brand" size={size} fallbackName={name} label={name} />;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

/** "On. CLIProxyAPI 8.0.32 runs on the hub. 2 accounts are signed in.", or what is happening, or what went wrong. */
export function SubscriptionsStatusLine({ s, onRetry, compact }: { s: SubscriptionsStatus; onRetry?: () => void; compact?: boolean }) {
  const t = statusSentence(s);
  const size = useCtl();
  const working = s.state === 'installing' || s.state === 'starting';
  return (
    <div>
      <p className={cn('m-0 leading-[1.45] text-fg', compact ? 'text-[15px]' : 'text-[17px] phone:text-[16px]')}>
        <span className={cn('state-word', TONE_CLASS[t.tone])}>{t.word}</span> {working ? (s.state === 'installing' ? 'Getting CLIProxyAPI for the hub.' : 'CLIProxyAPI is starting.') : t.rest}
      </p>
      {working && (
        <div className="mt-2 text-[13px]">
          <LiveStatus state="tool" label={s.state === 'installing' ? 'Downloading' : 'Starting'} detail={s.detail} startedAt={s.since} />
        </div>
      )}
      {s.state === 'error' && s.detail && <p className="m-0 mt-1.5 text-[13px] text-fg-3">{s.detail}</p>}
      {s.state === 'error' && onRetry && (
        <div className="mt-3">
          <Button variant="outline" size={size} onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One sign-in
// ---------------------------------------------------------------------------

type Phase =
  | { at: 'idle' }
  | { at: 'preparing'; since: number }
  | { at: 'starting' }
  | { at: 'waiting'; start: SignInStartDto; since: number; paste?: boolean }
  | { at: 'done'; label?: string }
  | { at: 'failed'; error: string };

function CopyCode({ code }: { code: string }) {
  const [copied, copy] = useCopy();
  return (
    <IconButton label={copied ? 'Copied' : 'Copy the code'} size={useIsMobile() ? 'touch' : 'sm'} onClick={() => copy(code)}>
      {copied ? <Check className="text-ok" /> : <Copy />}
    </IconButton>
  );
}

/** What to do while a sign-in is open: finish on the provider's page, type the code, or paste the address. */
function SignInPanel({ p, phase, onPaste, onCancel, onShowPaste }: { p: SubscriptionProviderDto; phase: Extract<Phase, { at: 'waiting' }>; onPaste: (url: string) => Promise<string | undefined>; onCancel: () => void; onShowPaste: () => void }) {
  const size = useCtl();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { start } = phase;
  const paste = start.flow === 'redirect' && (!start.caught || phase.paste);
  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(undefined);
    setError(await onPaste(url.trim()));
    setBusy(false);
  };
  return (
    <div className="space-y-3 pt-1 pb-1">
      {start.flow === 'device' ? (
        <>
          <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">Type this code on the {p.name} page that opened. This updates by itself when you are done.</p>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[20px] tracking-[0.04em] text-fg">{start.userCode}</span>
            {start.userCode && <CopyCode code={start.userCode} />}
          </div>
        </>
      ) : paste ? (
        <>
          <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
            {p.name} ends on a <span className="font-mono text-[12.5px]">{start.callbackHost ?? 'localhost'}</span> page that will not load here, because the hub is on another computer. Paste that page&apos;s address from the browser bar.
          </p>
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="min-w-0 flex-1 basis-[260px]">
              <Input
                mono
                aria-label="Address from the browser bar"
                aria-describedby={error ? `${start.state}-err` : undefined}
                invalid={!!error}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={`http://${start.callbackHost ?? 'localhost'}/callback?code=…`}
                autoComplete="off"
                spellCheck={false}
              />
              {error && (
                <Help id={`${start.state}-err`} error className="mt-1.5">
                  {error}
                </Help>
              )}
            </div>
            <Button type="submit" variant="solid" size={size === 'sm' ? 'md' : 'touch'} busy={busy ? 'Finishing' : false} disabled={!url.trim()} className="mt-0.5 phone:mt-0">
              Finish sign-in
            </Button>
          </form>
        </>
      ) : (
        <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">The {p.name} sign-in opened in a new tab. Finish there and come back; this updates by itself.</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <LiveStatus state="tool" label={`Waiting for ${p.name}`} startedAt={phase.since} />
        <span className="flex-1" />
        <ButtonLink href={start.url} external variant="outline" size={size}>
          Open the sign-in page
        </ButtonLink>
        <Button variant="quiet" size={size} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {start.flow === 'redirect' && !paste && (
        <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">
          <button type="button" className={LINK} onClick={onShowPaste}>
            The last page did not load?
          </button>{' '}
          Paste its address instead.
        </p>
      )}
    </div>
  );
}

/** A subscription row: logo, name and plan, who is signed in, Sign in. The sign-in opens under it. Accounts reuses it for Sign in again (`action`). */
export function ProviderLine({ p, status, ensureOn, action: actionWord }: { p: SubscriptionProviderDto; status: SubscriptionsStatus; ensureOn: () => Promise<SubscriptionsStatus | undefined>; action?: string }) {
  const mobile = useIsMobile();
  const size = useCtl();
  const [phase, setPhase] = useState<Phase>({ at: 'idle' });
  const alive = useRef(true);
  const poll = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    // StrictMode mounts twice: set it again on the second mount
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(poll.current);
    };
  }, []);
  const accounts = status.accounts.filter((a) => a.provider === p.id);
  const usable = status.mode === 'off' || status.management;

  const watch = (state: string) => {
    clearTimeout(poll.current);
    poll.current = setTimeout(async () => {
      if (!alive.current) return;
      try {
        const r = await api().signInStatus(state);
        if (!alive.current) return;
        if (r.status === 'ok') setPhase({ at: 'done', label: r.account?.label });
        else if (r.status === 'error') setPhase({ at: 'failed', error: r.error ?? 'The sign-in failed.' });
        else if (r.status === 'cancelled') setPhase({ at: 'idle' });
        else watch(state);
      } catch (e) {
        if (alive.current) setPhase({ at: 'failed', error: errText(e) });
      }
    }, 1200);
  };

  const begin = async () => {
    let s: SubscriptionsStatus | undefined = status;
    if (status.mode === 'off' || status.state !== 'on') {
      setPhase({ at: 'preparing', since: Date.now() });
      s = await ensureOn();
      if (!alive.current) return;
      if (!s || s.state !== 'on') {
        setPhase({ at: 'failed', error: s?.error ?? 'CLIProxyAPI did not start on the hub.' });
        return;
      }
    }
    setPhase({ at: 'starting' });
    try {
      const start = await api().startSignIn(p.id);
      if (!alive.current) return;
      // within the click's moment browsers allow a new tab; the button under the row opens it again
      try {
        window.open(start.url, '_blank', 'noopener,noreferrer');
      } catch {
        /* blocked: the Open the sign-in page button is there */
      }
      setPhase({ at: 'waiting', start, since: Date.now() });
      watch(start.state);
    } catch (e) {
      setPhase({ at: 'failed', error: errText(e) });
    }
  };

  const cancel = async () => {
    clearTimeout(poll.current);
    if (phase.at === 'waiting') await api().cancelSignIn(phase.start.state).catch(() => undefined);
    setPhase({ at: 'idle' });
  };

  const paste = async (url: string): Promise<string | undefined> => {
    if (phase.at !== 'waiting') return;
    try {
      const r = await api().finishSignIn(phase.start.state, url);
      if (r.status === 'ok') {
        clearTimeout(poll.current);
        setPhase({ at: 'done', label: r.account?.label });
      } else if (r.status === 'error') {
        clearTimeout(poll.current);
        setPhase({ at: 'failed', error: r.error ?? 'The sign-in failed.' });
      }
      return undefined;
    } catch (e) {
      return errText(e);
    }
  };

  const who = accounts.length === 0 ? <span className="text-fg-3">Not signed in</span> : accounts.length === 1 ? <span className="text-fg-2">{accountLabel(accounts[0])}</span> : <span className="text-fg-2">{accounts.length} accounts</span>;

  const action =
    phase.at === 'preparing' ? (
      <LiveStatus state="tool" label="Getting ready" startedAt={phase.since} />
    ) : phase.at === 'starting' ? (
      <LiveStatus state="tool" label="Opening" />
    ) : phase.at === 'waiting' ? null : phase.at === 'done' ? (
      <span className="state-word text-[13px] text-fg-3 phone:text-[14px]">
        <span className="text-ok">Signed in</span>
      </span>
    ) : (
      <Button variant="outline" size={size} onClick={() => void begin()} disabled={!usable} title={usable ? undefined : status.managementNote}>
        {actionWord ?? (accounts.length ? 'Add account' : 'Sign in')}
      </Button>
    );

  return (
    <div className="py-3">
      <div className={cn('grid items-center gap-x-4', mobile ? 'grid-cols-[minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_150px]')}>
        <span className="flex min-w-0 items-center gap-3.5">
          <SubMark id={p.id} name={p.name} />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{p.name}</span>
            <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">{mobile ? (accounts.length ? (accounts.length === 1 ? accountLabel(accounts[0]) : `${accounts.length} accounts`) : p.plan) : p.plan}</span>
          </span>
        </span>
        {!mobile && <span className="min-w-0 truncate text-[13px]">{who}</span>}
        <span className="flex min-w-0 justify-end text-[13px]">{action}</span>
      </div>
      {phase.at === 'preparing' && status.mode !== 'off' && status.state !== 'on' && <p className="m-0 mt-2 pl-[36px] text-[12px] text-fg-3 phone:pl-0 phone:text-[13px]">{status.detail ?? 'CLIProxyAPI is starting on the hub.'}</p>}
      {phase.at === 'preparing' && status.mode === 'off' && <p className="m-0 mt-2 pl-[36px] text-[12px] text-fg-3 phone:pl-0 phone:text-[13px]">Starting CLIProxyAPI on the hub first. The first time it downloads it, about 22 MB.</p>}
      {phase.at === 'waiting' && (
        <div className="mt-2 pl-[36px] phone:pl-0">
          <SignInPanel p={p} phase={phase} onPaste={paste} onCancel={() => void cancel()} onShowPaste={() => setPhase({ ...phase, paste: true })} />
        </div>
      )}
      {phase.at === 'failed' && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 pl-[36px] phone:pl-0">
          <p className="m-0 min-w-0 flex-1 text-[13px] text-fg-2 phone:text-[14px]">
            <span className="text-fault">Failed.</span> {phase.error}
          </p>
          <Button variant="outline" size={size} onClick={() => void begin()}>
            Try again
          </Button>
        </div>
      )}
      {phase.at === 'done' && (
        <p className="m-0 mt-1.5 pl-[36px] text-[12px] text-fg-3 phone:pl-0 phone:text-[13px]">
          {phase.label ? `${phase.label} is signed in. ` : ''}Its models are in the model picker under CLIProxyAPI.{' '}
          <button type="button" className={LINK} onClick={() => setPhase({ at: 'idle' })}>
            Add another
          </button>
        </p>
      )}
    </div>
  );
}

/** Turn the built-in CLIProxyAPI on when it is off, and wait until it answers. */
export async function ensureBuiltinOn(status: SubscriptionsStatus): Promise<SubscriptionsStatus | undefined> {
  try {
    if (status.mode === 'off') {
      const s = await api().setSubscriptions({ mode: 'builtin' });
      useHub.setState({ subscriptions: { ...s, local: status.local } });
      if (s.state === 'on') return s;
    }
    // events keep the store current; poll too, in case this client missed one
    const timer = setInterval(() => {
      void api()
        .subscriptions()
        .then((s) => useHub.setState({ subscriptions: s }))
        .catch(() => undefined);
    }, 1500);
    try {
      return await untilOn();
    } finally {
      clearInterval(timer);
    }
  } catch (e) {
    toast({ title: `Failed. ${errText(e)}`, level: 'error' });
    return undefined;
  }
}

/** The subscription rows: the main six, then More (Kimi on kimi.ai, Devin, plugins). */
export function SubscriptionRows({ status }: { status: SubscriptionsStatus }) {
  const main = status.providers.filter((p) => !p.more);
  const extra = status.providers.filter((p) => p.more);
  const [more, setMore] = useState(() => extra.some((p) => p.accounts > 0));
  const shown = more ? status.providers : main;
  return (
    <div>
      {status.mode === 'external' && !status.management && status.managementNote && <p className="m-0 mb-1 py-2 text-[13px] text-warn phone:text-[14px]">{status.managementNote}</p>}
      <div className="rows border-b border-rule">
        {shown.map((p) => (
          <ProviderLine key={p.id} p={p} status={status} ensureOn={() => ensureBuiltinOn(status)} />
        ))}
      </div>
      {!more && extra.length > 0 && (
        <div className="pt-3 text-[13px] text-fg-3 phone:text-[14px]">
          <button type="button" className={LINK} onClick={() => setMore(true)}>
            More: {extra.map((p) => (p.id === 'kimi-ai' ? 'Kimi on kimi.ai' : p.name)).join(', ')}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function AccountLine({ a, onChange }: { a: SubscriptionAccountDto; onChange: (s: SubscriptionsStatus) => void }) {
  const mobile = useIsMobile();
  const size = useCtl();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'remove' | null>(null);
  const word = ACCOUNT_WORD[a.state];
  const refresh = async () => {
    setBusy('refresh');
    try {
      onChange(await api().refreshSubscriptionAccount(a.name));
      toast({ title: `${a.providerName}, ${accountLabel(a)}: refreshed.` });
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
    }
    setBusy(null);
  };
  const remove = async () => {
    setBusy('remove');
    try {
      onChange(await api().removeSubscriptionAccount(a.name));
      setConfirm(false);
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
    }
    setBusy(null);
  };
  return (
    <div className="flex items-center gap-3 py-2.5">
      <SubMark id={a.provider} name={a.providerName} size={18} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-fg phone:text-[15px]">{accountLabel(a)}</span>
        <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">
          {a.providerName}
          {a.detail ? `, ${a.detail}` : ''}
        </span>
      </span>
      <span className={cn('state-word shrink-0 text-[13px] phone:text-[14px]', TONE_CLASS[word.tone])}>{word.word}</span>
      {mobile ? (
        <Menu
          label={`${accountLabel(a)} actions`}
          items={[...(a.canRefresh ? [{ label: 'Refresh', onSelect: () => void refresh() }] : []), { label: 'Remove', danger: true, onSelect: () => setConfirm(true) }]}
          trigger={({ ref, props }) => (
            <IconButton ref={ref} label="Account actions" size="touch" className="-mr-3" {...props}>
              <MoreHorizontal />
            </IconButton>
          )}
        />
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          {a.canRefresh && (
            <Button variant="quiet" size={size} busy={busy === 'refresh' ? 'Refreshing' : false} onClick={() => void refresh()}>
              Refresh
            </Button>
          )}
          <Button variant="danger" size={size} onClick={() => setConfirm(true)}>
            Remove
          </Button>
        </span>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={remove}
        busy="Removing"
        title={`Remove the ${a.providerName} account ${accountLabel(a)}?`}
        body="CLIProxyAPI forgets its sign-in, and its models leave the model picker. Sessions that use them stop until you sign in again."
        confirm="Remove"
      />
    </div>
  );
}

export function AccountRows({ status, onChange, empty }: { status: SubscriptionsStatus; onChange: (s: SubscriptionsStatus) => void; empty?: ReactNode }) {
  if (!status.accounts.length) return empty ? <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[14px]">{empty}</p> : null;
  return (
    <div className="rows">
      {status.accounts.map((a) => (
        <AccountLine key={a.name} a={a} onChange={onChange} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models per account
// ---------------------------------------------------------------------------

export function ModelGroups({ groups }: { groups: SubscriptionModelGroupDto[] }) {
  const mobile = useIsMobile();
  if (!groups.length) return <p className="m-0 py-3 text-[13px] text-fg-3 phone:text-[14px]">Models show up here once an account is signed in.</p>;
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.account}>
          <p className="m-0 pt-3 pb-1 text-[12px] text-fg-3 phone:text-[13px]">
            {g.account ? `Second account, ids start with ${g.account}/` : g.label}
          </p>
          <div className="rows">
            {g.models.map((m) => (
              <div key={m.id} className="flex items-center gap-3 py-2">
                <ModelMark model={m.id} tone="brand" size={16} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg phone:text-[14px]">{m.name}</span>
                {!mobile && <span className="min-w-0 max-w-[50%] truncate font-mono text-[12px] text-fg-3">{m.ref}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One the owner already runs
// ---------------------------------------------------------------------------

export function ExternalForm({ status, onSaved, onCancel }: { status: SubscriptionsStatus; onSaved: (s: SubscriptionsStatus) => void; onCancel?: () => void }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'md';
  const [url, setUrl] = useState(status.external?.url ?? status.suggested?.url ?? '');
  const [key, setKey] = useState('');
  const [mk, setMk] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const haveKey = !!status.external?.key || !!status.suggested?.key;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const s = await api().setSubscriptions({ mode: 'external', url: url.trim(), ...(key.trim() ? { key: key.trim() } : {}), ...(mk.trim() ? { managementKey: mk.trim() } : {}) });
      setKey('');
      setMk('');
      onSaved(s);
      if (s.state === 'error') setError(s.error);
    } catch (e) {
      setError(errText(e));
    }
    setBusy(false);
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Address" help="Where it listens, for example http://192.168.1.10:8317. The /v1 part is optional.">
        <Input mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.10:8317" autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Client key" help={haveKey ? 'A key is saved on the hub. Paste a new one to replace it.' : 'One of access.api-keys in its config.yaml.'}>
        <Input mono type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={haveKey ? 'Saved' : 'Paste the client key'} autoComplete="off" />
      </Field>
      <Field label="Management key" optional help={status.external?.managementKey ? 'Saved. Sign-in and accounts work from here.' : 'Lets you sign in and see accounts from here. Its config.yaml needs management.allow-remote: true unless it runs on the hub.'}>
        <Input mono type="password" value={mk} onChange={(e) => setMk(e.target.value)} placeholder={status.external?.managementKey ? 'Saved' : 'management.secret-key'} autoComplete="off" />
      </Field>
      {error && <p className="m-0 text-[13px] text-fault phone:text-[14px]">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="solid" size={size} busy={busy ? 'Connecting' : false} disabled={!url.trim()}>
          Connect
        </Button>
        {onCancel && (
          <Button variant="quiet" size={size} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <p className="m-0 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Your other tools keep using it as before. Models you already call as cliproxy/&lt;model&gt; keep working.</p>
    </form>
  );
}
