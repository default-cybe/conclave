/**
 * Settings > Calendar and mail (docs/DESIGN.md, Calendar and mail): the
 * accounts the assistant reads, which calendars it may read and propose
 * events in, drafts and sending per mail account, and how to add more:
 * CalDAV with an app password (Nextcloud, iCloud, Fastmail), Sign in with
 * Google or Microsoft, or IMAP with an app password. Passwords and tokens go
 * to the hub's secret store and never come back to this page.
 */
import { useIsOwner } from '@/lib/people';
import { useEffect, useRef, useState } from 'react';
import type { CaldavPreset, CalendarPick, MailPreset, MailSecurity, OAuthFlowDto, PimAccountDto, PimSettingsDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { toast } from '@/store/store';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Checkbox, Field, Input, OnOff, Segmented } from '@/components/ui/Field';
import { CodeBlock } from '@/components/ui/Code';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { LoadingRows } from '@/components/ui/EmptyState';
import { errText, Group, Outcome, SettingRow, agoWords } from './parts';
import { AUTO_DRAFT_HELP, accountKind, checkWords, googleChoice, googleWaitWords, hubOrigin, pastedCallback, scopeWords } from './calmailWords';

export function CalMailSection() {
  const [s, setS] = useState<PimSettingsDto>();
  const [error, setError] = useState<string>();
  const reload = () =>
    api()
      .pimSettings()
      .then((x) => {
        setS(x);
        setError(undefined);
      })
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void reload();
  }, []);
  if (error) return <p className="text-[13px] text-fault">Could not load calendar and mail. {error}</p>;
  if (!s) return <LoadingRows loading rows={6} />;
  return <Body s={s} reload={reload} />;
}

function Body({ s, reload }: { s: PimSettingsDto; reload: () => Promise<void> }) {
  return (
    <div className="space-y-9">
      <Group title="Accounts" count={s.accounts.length || undefined} help="The assistant reads only the calendars marked Read, and proposes events only in the ones marked Write. Every new event, change and message waits for your approval on Home or the phone. Mail is read only by the email agent, as untrusted text.">
        {s.accounts.length === 0 && <p className="m-0 py-3.5 text-[13px] text-fg-3 phone:text-[14px]">No calendar or mail yet. Add one below.</p>}
        {s.accounts.map((a) => (
          <AccountRow key={a.id} a={a} reload={reload} />
        ))}
      </Group>
      <AddCaldav s={s} reload={reload} />
      <GoogleSignIn s={s} reload={reload} />
      <MicrosoftSignIn s={s} reload={reload} />
      <AddImap s={s} reload={reload} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// an account
// ---------------------------------------------------------------------------

function AccountRow({ a, reload }: { a: PimAccountDto; reload: () => Promise<void> }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [busy, setBusy] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const check = checkWords(a);
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast({ title: ok, level: 'info' });
      await reload();
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    }
    setBusy(undefined);
  };
  const setCal = (c: CalendarPick, patch: { read?: boolean; write?: boolean }) => run(`cal:${c.remoteId}`, () => api().updatePimAccount(a.id, { calendars: [{ remoteId: c.remoteId, ...patch }] }));
  const granted = scopeWords(a.scopes);
  return (
    <div className="py-3.5" data-account={a.id}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="m-0 text-[13.5px] leading-[1.35] font-medium text-fg phone:text-[15px]">{a.label}</p>
          <p className="m-0 mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">
            {accountKind(a)}
            {granted.length ? `. May ${granted.join(', ')}` : ''}
          </p>
          <p className="m-0 mt-1">
            <Outcome word={check.word} tone={check.tone}>
              {[check.detail?.replace(/\.$/, ''), a.lastCheck ? agoWords(a.lastCheck.at) : ''].filter(Boolean).join(', ')}
            </Outcome>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size={size} busy={busy === 'test' ? 'Testing' : false} onClick={() => void run('test', () => api().testPimAccount(a.id))}>
            Test
          </Button>
          <Button variant="quiet-fault" size={size} onClick={() => setRemoving(true)}>
            {a.kind === 'google' || a.kind === 'microsoft' ? 'Disconnect' : 'Remove'}
          </Button>
        </div>
      </div>
      {a.calendar && (a.calendars ?? []).length > 0 && (
        <div className="mt-3 rows border-t border-rule" role="group" aria-label={`Calendars of ${a.label}`}>
          {(a.calendars ?? []).map((c) => (
            <div key={c.remoteId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
              <span className="min-w-0 text-[13px] text-fg phone:text-[15px]">
                {c.color && <span aria-hidden className="mr-2 inline-block size-2 rounded-full align-middle" style={{ background: c.color }} />}
                {c.name}
                {!c.writable && <span className="text-fg-3">, read only</span>}
              </span>
              <span className="flex items-center gap-4">
                <Checkbox label="Read" checked={c.read} disabled={!!busy} onChange={(v) => void setCal(c, { read: v })} />
                <Checkbox label="Write" checked={c.write} disabled={!!busy || !c.writable || !c.read} onChange={(v) => void setCal(c, { write: v })} />
              </span>
            </div>
          ))}
        </div>
      )}
      {a.mail && (
        <div className="mt-2">
          <SettingRow label="Drafts" help={a.kind === 'imap' ? 'Approved messages go to the Drafts folder. You send them yourself.' : 'Needs more access from the provider: sign in again to change it.'}>
            <OnOff label="Drafts" size={size} checked={!!a.drafts} disabled={!!busy || a.kind !== 'imap'} onChange={(v) => void run('drafts', () => api().updatePimAccount(a.id, { drafts: v }))} />
          </SettingRow>
          <SettingRow label="Save drafts without asking" help={AUTO_DRAFT_HELP}>
            <OnOff label="Save drafts without asking" size={size} checked={!!a.autoDraft} disabled={!!busy || !(a.drafts || a.kind === 'imap')} onChange={(v) => void run('autoDraft', () => api().updatePimAccount(a.id, { autoDraft: v }))} />
          </SettingRow>
          <SettingRow label="Sending" help="Off: the assistant can only save drafts. On: an approved message may go out at once. Each message still needs your approval.">
            <OnOff label="Sending" size={size} checked={!!a.send} disabled={!!busy} onChange={(v) => void run('send', () => api().updatePimAccount(a.id, { send: v }), v ? 'Sending is on. Each message still waits for your approval.' : undefined)} />
          </SettingRow>
        </div>
      )}
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={`${a.kind === 'google' || a.kind === 'microsoft' ? 'Disconnect' : 'Remove'} ${a.label}?`}
        body={a.kind === 'google' ? 'The hub revokes its access at Google and forgets the token.' : a.kind === 'microsoft' ? 'The hub forgets the token. Microsoft has no revoke for one app; remove it in your Microsoft account too.' : 'The hub forgets the account and its app password. Nothing changes on the server.'}
        confirm={a.kind === 'google' || a.kind === 'microsoft' ? 'Disconnect' : 'Remove'}
        onConfirm={async () => {
          const out = await api().removePimAccount(a.id);
          if (out.note) toast({ title: out.note, level: 'info' });
          setRemoving(false);
          await reload();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CalDAV
// ---------------------------------------------------------------------------

function AddCaldav({ s, reload }: { s: PimSettingsDto; reload: () => Promise<void> }) {
  const mobile = useIsMobile();
  const [preset, setPreset] = useState<CaldavPreset>('nextcloud');
  const info = s.presets.caldav.find((p) => p.id === preset)!;
  const [url, setUrl] = useState(info.url);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const pick = (p: CaldavPreset) => {
    setPreset(p);
    setUrl(s.presets.caldav.find((x) => x.id === p)!.url);
    setErr(undefined);
  };
  const add = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const a = await api().addCaldav({ preset, serverUrl: url, username: user, password: pass });
      setPass('');
      setUser('');
      toast({ title: `${a.label} connected. ${a.lastCheck?.detail ?? ''}`.trim(), level: 'info' });
      await reload();
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };
  return (
    <Group title="Add a calendar" help="CalDAV with an app password. One set of calendars synced to several services needs adding only once. Google Calendar no longer takes app passwords: use Sign in with Google below.">
      <div className="space-y-4 py-3.5">
        <Segmented<CaldavPreset> label="Server" size={mobile ? 'touch' : 'sm'} value={preset} onChange={pick} options={s.presets.caldav.map((p) => ({ value: p.id, label: p.id === 'other' ? 'Other' : p.label }))} />
        <Field label="Server address" help={preset === 'nextcloud' ? 'Your Nextcloud address with /remote.php/dav at the end.' : undefined}>
          <Input mono value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoCapitalize="off" inputMode="url" />
        </Field>
        <Field label="User name" help={info.username}>
          <Input value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="off" autoComplete="username" spellCheck={false} />
        </Field>
        <Field label="App password" help={info.password} error={err}>
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" />
        </Field>
        <Button variant="solid" size={mobile ? 'touch' : 'sm'} disabled={!url.trim() || !user.trim() || !pass} busy={busy ? 'Finding calendars' : false} onClick={() => void add()}>
          Connect
        </Button>
      </div>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// OAuth: Google and Microsoft
// ---------------------------------------------------------------------------

/** Poll a sign-in until it is done or failed. */
function useFlow(onDone: () => void) {
  const [flow, setFlow] = useState<OAuthFlowDto>();
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => () => clearInterval(timer.current), []);
  const watch = (f: OAuthFlowDto) => {
    setFlow(f);
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const next = await api().pimSignIn(f.id);
        setFlow(next);
        if (next.state !== 'waiting') {
          clearInterval(timer.current);
          if (next.state === 'done') onDone();
        }
      } catch {
        clearInterval(timer.current);
      }
    }, 2_000);
  };
  return { flow, watch, clear: () => (clearInterval(timer.current), setFlow(undefined)) };
}

function GoogleSignIn({ s, reload }: { s: PimSettingsDto; reload: () => Promise<void> }) {
  const owner = useIsOwner();
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const g = s.oauth.google;
  const [mail, setMail] = useState(true);
  const [drafts, setDrafts] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const [calWrite, setCalWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(!g.ready);
  const { flow, watch } = useFlow(() => void reload());
  const choice = googleChoice(g, location.hostname);
  const [pasted, setPasted] = useState('');
  const [finishing, setFinishing] = useState(false);
  // away from the hub machine Google lands on 127.0.0.1, which does not load here; its address carries the code
  const finish = async () => {
    const cb = pastedCallback(pasted);
    if (!cb) {
      toast({ title: 'That is not the address Google opened. Copy the whole address of the page that did not load.', level: 'error' });
      return;
    }
    setFinishing(true);
    try {
      watch(await api().finishGoogleSignIn(cb));
      setPasted('');
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    }
    setFinishing(false);
  };
  const start = async () => {
    if (!('client' in choice)) return;
    setBusy(true);
    try {
      // the relay page sends the browser back to the hub address this page uses; the hub checks it is its own
      const back = choice.client === 'relay' ? { origin: hubOrigin(api().baseUrl, location.origin) } : {};
      const f = await api().startGoogleSignIn({ client: choice.client, ...back, mail, drafts: mail && drafts, calendar, calendarWrite: calendar && calWrite });
      watch(f);
      window.open(f.url, '_blank', 'noopener');
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    }
    setBusy(false);
  };
  return (
    <Group title="Sign in with Google" help={`Gmail, and Google Calendar if you want it. ${g.how}`}>
      <div className="space-y-3 py-3.5">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Checkbox label="Read mail" checked={mail} onChange={setMail} />
          <Checkbox label="Save drafts" description="Adds gmail.compose" checked={mail && drafts} disabled={!mail} onChange={setDrafts} />
          <Checkbox label="Calendar" checked={calendar} onChange={setCalendar} />
          <Checkbox label="Propose events" checked={calendar && calWrite} disabled={!calendar} onChange={setCalWrite} />
        </div>
        {'client' in choice ? (
          <Button variant="solid" size={size} disabled={!mail && !calendar} busy={busy ? 'Opening Google' : false} onClick={() => void start()}>
            Sign in with Google
          </Button>
        ) : (
          <p className="m-0 text-[13px] text-fg-2 phone:text-[14px]">{choice.why}</p>
        )}
        {flow?.state === 'waiting' && 'client' in choice && choice.paste && (
          <div className="space-y-2">
            <Field label="Address of the page Google opened" help="After you allow, Google opens a page at 127.0.0.1 that does not load. Copy its whole address from the address bar and paste it here.">
              <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://127.0.0.1:…/api/pim/oauth/google/callback?state=…" mono spellCheck={false} autoCapitalize="off" autoCorrect="off" />
            </Field>
            <Button variant="solid" size={size} disabled={!pasted.trim()} busy={finishing ? 'Finishing' : false} onClick={() => void finish()}>
              Finish sign-in
            </Button>
          </div>
        )}
        {flow && (
          <p className="m-0 text-[13px] phone:text-[14px]">
            {flow.state === 'waiting' ? (
              <span className="text-fg-2">{googleWaitWords(choice)}</span>
            ) : flow.state === 'done' ? (
              <span className="text-ok">Signed in.</span>
            ) : (
              <span className="text-fault">{flow.error}</span>
            )}
          </p>
        )}
        {/* the hub's own Google app is the owner's to set up (docs/design/ACCOUNTS.md) */}
        {owner ? (
          <button type="button" className="text-[12px] text-fg-3 underline decoration-rule-2 underline-offset-[3px] hover:text-fg phone:min-h-11 phone:text-[13px]" onClick={() => setSetup(!setup)}>
            {setup ? 'Hide the setup steps' : g.ready ? 'Use your own Google app instead' : 'Show the setup steps'}
          </button>
        ) : (
          !g.ready && <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">The owner of this hub sets up its Google app first.</p>
        )}
        {owner && setup && <GoogleSetup s={s} reload={reload} />}
      </div>
    </Group>
  );
}

function GoogleSetup({ s, reload }: { s: PimSettingsDto; reload: () => Promise<void> }) {
  const g = s.oauth.google;
  const mobile = useIsMobile();
  const [webId, setWebId] = useState(g.hub.webClientId ?? '');
  const [webSecret, setWebSecret] = useState('');
  const [deskId, setDeskId] = useState(g.hub.desktopClientId ?? '');
  const [deskSecret, setDeskSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api().setOAuthClients({ googleWebClientId: webId, googleDesktopClientId: deskId, ...(webSecret ? { googleWebSecret: webSecret } : {}), ...(deskSecret ? { googleDesktopSecret: deskSecret } : {}) });
      setWebSecret('');
      setDeskSecret('');
      await reload();
      toast({ title: 'Saved. The secrets are in the hub secret store.', level: 'info' });
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    }
    setBusy(false);
  };
  return (
    <div className="space-y-3 rounded-[var(--r-2)] border border-rule p-4 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
      <p className="m-0 font-medium text-fg">Your own Google app, once per hub</p>
      <ol className="m-0 list-decimal space-y-1.5 pl-5">
        <li>
          In console.cloud.google.com create a project, then enable the Gmail API (and the Google Calendar API for calendars).
        </li>
        <li>OAuth consent screen: External. Add yourself as a test user, or publish it. Add the scopes below.</li>
        <li>Credentials, Create OAuth client ID. With an https hub address: type Web application, with the redirect URI below. Without one: type Desktop app.</li>
        <li>Paste the client id and secret here. The secret goes to the hub secret store.</li>
      </ol>
      {g.redirect.web ? (
        <Field label="Redirect URI for a Web application client">
          <CodeBlock code={g.redirect.web} copy />
        </Field>
      ) : (
        <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">This hub has no https address, so a Web application client cannot work here yet. A Desktop app client works from a browser on the hub machine: its loopback address is {g.redirect.loopback}.</p>
      )}
      <Field label="Scopes">
        <CodeBlock code={['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'].join('\n')} copy />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Web client id" optional>
          <Input mono value={webId} onChange={(e) => setWebId(e.target.value)} spellCheck={false} />
        </Field>
        <Field label={g.hub.webSecret ? 'Web client secret (stored)' : 'Web client secret'} optional>
          <Input type="password" value={webSecret} onChange={(e) => setWebSecret(e.target.value)} placeholder={g.hub.webSecret ? 'Leave empty to keep it' : ''} />
        </Field>
        <Field label="Desktop client id" optional>
          <Input mono value={deskId} onChange={(e) => setDeskId(e.target.value)} spellCheck={false} />
        </Field>
        <Field label={g.hub.desktopSecret ? 'Desktop client secret (stored)' : 'Desktop client secret'} optional>
          <Input type="password" value={deskSecret} onChange={(e) => setDeskSecret(e.target.value)} placeholder={g.hub.desktopSecret ? 'Leave empty to keep it' : ''} />
        </Field>
      </div>
      <Button variant="outline" size={mobile ? 'touch' : 'sm'} busy={busy ? 'Saving' : false} onClick={() => void save()}>
        Save the Google app
      </Button>
    </div>
  );
}

function MicrosoftSignIn({ s, reload }: { s: PimSettingsDto; reload: () => Promise<void> }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const m = s.oauth.microsoft;
  const [drafts, setDrafts] = useState(false);
  const [send, setSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState(m.hubClientId ?? '');
  const [setup, setSetup] = useState(!m.ready);
  const { flow, watch } = useFlow(() => void reload());
  const start = async () => {
    setBusy(true);
    try {
      watch(await api().startMicrosoftSignIn({ mail: true, drafts: drafts || send, send }));
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    }
    setBusy(false);
  };
  return (
    <Group title="Sign in with Microsoft" help="Outlook.com, Hotmail and Microsoft 365 mail. Outlook.com no longer allows IMAP with a password, so this is the way in for Outlook. It works from any device: you type a code at Microsoft.">
      <div className="space-y-3 py-3.5">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Checkbox label="Save drafts" description="Adds Mail.ReadWrite" checked={drafts || send} disabled={send} onChange={setDrafts} />
          <Checkbox label="Send" description="Adds Mail.Send" checked={send} onChange={setSend} />
        </div>
        {m.ready && (
          <Button variant="solid" size={size} busy={busy ? 'Asking Microsoft' : false} onClick={() => void start()}>
            Sign in with Microsoft
          </Button>
        )}
        {flow?.userCode && flow.state === 'waiting' && (
          <div className="space-y-2">
            <p className="m-0 text-[13px] text-fg-2 phone:text-[14px]">Open the page below on any device, type this code and sign in. This page updates when it is done.</p>
            <CodeBlock code={flow.userCode} copy />
            <ButtonLink href={flow.verificationUri ?? 'https://microsoft.com/devicelogin'} external variant="outline" size={size}>
              Open microsoft.com/devicelogin
            </ButtonLink>
          </div>
        )}
        {flow && flow.state !== 'waiting' && <p className={flow.state === 'done' ? 'm-0 text-[13px] text-ok' : 'm-0 text-[13px] text-fault'}>{flow.state === 'done' ? 'Signed in.' : flow.error}</p>}
        <button type="button" className="text-[12px] text-fg-3 underline decoration-rule-2 underline-offset-[3px] hover:text-fg phone:min-h-11 phone:text-[13px]" onClick={() => setSetup(!setup)}>
          {setup ? 'Hide the setup steps' : 'Use your own Microsoft app instead'}
        </button>
        {setup && (
          <div className="space-y-3 rounded-[var(--r-2)] border border-rule p-4 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
            <ol className="m-0 list-decimal space-y-1.5 pl-5">
              <li>In entra.microsoft.com, App registrations, New registration. Accounts in any organizational directory and personal Microsoft accounts.</li>
              <li>Authentication: turn on Allow public client flows. No redirect URI and no secret are needed.</li>
              <li>API permissions, Microsoft Graph, delegated: Mail.Read and offline_access; Mail.ReadWrite for drafts, Mail.Send for sending.</li>
              <li>Paste the Application (client) id here.</li>
            </ol>
            <Field label="Application (client) id">
              <Input mono value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} />
            </Field>
            <Button
              variant="outline"
              size={size}
              onClick={async () => {
                try {
                  await api().setOAuthClients({ microsoftClientId: clientId });
                  await reload();
                } catch (e) {
                  toast({ title: errText(e), level: 'error' });
                }
              }}
            >
              Save the Microsoft app
            </Button>
          </div>
        )}
      </div>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

function AddImap({ s, reload }: { s: PimSettingsDto; reload: () => Promise<void> }) {
  const mobile = useIsMobile();
  const [preset, setPreset] = useState<MailPreset>('icloud');
  const info = s.presets.mail.find((p) => p.id === preset)!;
  const [host, setHost] = useState(info.imap.host);
  const [port, setPort] = useState(String(info.imap.port));
  const [security, setSecurity] = useState<MailSecurity>(info.imap.security);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [address, setAddress] = useState('');
  const [send, setSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const pick = (p: MailPreset) => {
    const x = s.presets.mail.find((m) => m.id === p)!;
    setPreset(p);
    setHost(x.imap.host);
    setPort(String(x.imap.port));
    setSecurity(x.imap.security);
    setErr(undefined);
  };
  const add = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const a = await api().addImap({ preset, host, port: Number(port), security, username: user, password: pass, ...(address ? { address } : {}), ...(send ? { send: true, smtp: { host: info.smtp.host, port: info.smtp.port, security: info.smtp.security } } : {}) });
      setPass('');
      toast({ title: `${a.label} connected. ${a.lastCheck?.detail ?? ''}`.trim(), level: 'info' });
      await reload();
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };
  return (
    <Group title="Add mail over IMAP" help="For any other provider, and for Gmail without a Google app: IMAP with an app password. Read only. Approved drafts go to the Drafts folder.">
      <div className="space-y-4 py-3.5">
        <Segmented<MailPreset> label="Provider" size={mobile ? 'touch' : 'sm'} value={preset} onChange={pick} options={s.presets.mail.map((p) => ({ value: p.id, label: p.id === 'other' ? 'Other' : p.id === 'gmail' ? 'Gmail' : p.label.replace(' Mail', '') }))} />
        {info.note && <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">{info.note}</p>}
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_96px_140px]">
          <Field label="IMAP server">
            <Input mono value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} autoCapitalize="off" />
          </Field>
          <Field label="Port">
            <Input mono inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Security">
            <Segmented<MailSecurity> label="Security" size={mobile ? 'touch' : 'sm'} value={security} onChange={setSecurity} options={[{ value: 'tls', label: 'TLS' }, { value: 'starttls', label: 'STARTTLS' }]} />
          </Field>
        </div>
        <Field label="User name" help={info.username}>
          <Input value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="off" autoComplete="username" spellCheck={false} />
        </Field>
        <Field label="Email address" help="The From line of drafts. Left empty, the user name when it is an address." optional>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} autoCapitalize="off" inputMode="email" spellCheck={false} />
        </Field>
        <Field label="App password" help={info.password} error={err}>
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" />
        </Field>
        <Checkbox label="Allow sending" description={`Over SMTP at ${info.smtp.host || 'the provider'}. Off, approved messages are saved as drafts.`} checked={send} onChange={setSend} />
        <Button variant="solid" size={mobile ? 'touch' : 'sm'} disabled={!host.trim() || !user.trim() || !pass} busy={busy ? 'Logging in' : false} onClick={() => void add()}>
          Connect
        </Button>
      </div>
    </Group>
  );
}
