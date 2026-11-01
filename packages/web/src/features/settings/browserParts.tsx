/**
 * Settings > Browser, the parts besides signing in: the engines with Install
 * on the hub, each profile's engine, and the hub's proxy. The proxy is used
 * once per blocked request, in the hub's country, or when the owner asks for
 * one in a chat. The hub keeps its login and
 * password as secrets; this page sends them once and never gets them back.
 */
import { useEffect, useState } from 'react';
import { ApiError, type BrowserEngineDto, type BrowserLibsDto, type BrowserLibsResult, type BrowserSetupOffer, type BrowserSetupResult, type BrowserStatusDto } from '@conclave/core/client';
import { canRunBrowserSetup } from '@conclave/core/browser/setup-plan';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { Input, Segmented, Select } from '@/components/ui/Field';
import { errText, Group, Outcome, SettingRow } from './parts';
import { engineHelp, engineStatus, libsChoices, libsConfirmWords, libsResultWords, libsWords, newProfileWords, PROXY_HELP, providerWords, setupConfirmWords, setupResultWords, testWords, whereWords } from './browserWords';

type Status = BrowserStatusDto;
type Profile = Status['profiles'][number];

// ---------------------------------------------------------------------------
// Engines and Install on the hub
// ---------------------------------------------------------------------------

export function EnginesGroup({ s, onStatus }: { s: Status; onStatus: (s: Status) => void }) {
  const [installing, setInstalling] = useState<BrowserEngineDto>();
  const [libsOpen, setLibsOpen] = useState(false);
  const phone = useIsMobile();
  return (
    <Group title="Engines" help="Each profile runs on one of these. Install them here: the hub downloads pinned builds into its own folder, checks each against its hash, and needs no root.">
      {(s.engines ?? []).map((e) => {
        const st = engineStatus(e);
        const can = canRunBrowserSetup(e.setup);
        return (
          <SettingRow key={e.engine} label={e.label} help={engineHelp(e)}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:justify-end">
              <Outcome word={st.word} tone={st.tone}>
                {st.detail}
              </Outcome>
              {can && (
                <Button variant="outline" size={phone ? 'touch' : 'sm'} onClick={() => setInstalling(e)}>
                  Install on the hub
                </Button>
              )}
              {!e.installed && !can && e.setup.why && <span className="text-[12px] text-fg-3 phone:text-[13px]">{e.setup.why}</span>}
            </div>
          </SettingRow>
        );
      })}
      {s.libs && libsWords(s.libs) && <LibsNote libs={s.libs} onInstall={() => setLibsOpen(true)} />}
      {libsOpen && s.libs?.setup && (
        <LibsDialog
          libs={s.libs}
          onClose={(next) => {
            setLibsOpen(false);
            if (next) onStatus(next);
          }}
        />
      )}
      {installing && (
        <SetupDialog
          engine={installing}
          onClose={(next) => {
            setInstalling(undefined);
            if (next) onStatus(next);
          }}
        />
      )}
    </Group>
  );
}

/** The confirm with every step as it will run, then the result. */
function SetupDialog({ engine, onClose }: { engine: BrowserEngineDto; onClose: (next?: Status) => void }) {
  const phone = useIsMobile();
  const size = phone ? 'touch' : 'md';
  const [offer, setOffer] = useState<BrowserSetupOffer>(engine.setup);
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [result, setResult] = useState<BrowserSetupResult>();
  const [error, setError] = useState<string>();
  const [next, setNext] = useState<Status>();

  const run = async () => {
    setPhase('running');
    setError(undefined);
    try {
      const r = await api().browserSetup(engine.engine, offer.lines);
      setResult(r);
      setNext(await api().browserStatus().catch(() => undefined));
      setPhase('done');
    } catch (e) {
      const fresh = e instanceof ApiError ? (e.body as { setup?: BrowserSetupOffer } | undefined)?.setup : undefined;
      if (fresh) setOffer(fresh);
      setPhase('confirm');
      setError(errText(e));
    }
  };
  const close = () => {
    if (phase !== 'running') onClose(next);
  };
  const can = canRunBrowserSetup(offer);
  const words = result ? setupResultWords(result, engine.label) : undefined;
  return (
    <Dialog
      open
      onClose={close}
      title={`Install ${engine.label} on the hub`}
      description={phase === 'done' ? undefined : can ? setupConfirmWords(offer) : offer.why}
      width={640}
      footer={
        phase === 'done' ? (
          <Button variant="solid" size={size} onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="quiet" size={size} disabled={phase === 'running'} onClick={close}>
              Cancel
            </Button>
            {can && (
              <Button variant="solid" size={size} busy={phase === 'running' ? 'Installing' : false} onClick={() => void run()}>
                Install
              </Button>
            )}
          </>
        )
      }
    >
      {phase !== 'done' && (
        <>
          {error && (
            <p className="m-0 mb-3 text-[13px] leading-[1.5] text-fault phone:text-[14px]" role="alert">
              {error}
            </p>
          )}
          {offer.steps.map((st, i) => (
            <div key={offer.lines[i]} className={cn('py-2', i > 0 && 'border-t border-rule')}>
              <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
                {i + 1}. {st.say}
              </p>
              <CodeBlock code={offer.lines[i]} shell={st.kind === 'run'} wrap copy className="mt-2 [&>pre]:pr-9" />
            </div>
          ))}
          {phase === 'running' && (
            <p className="m-0 mt-3 text-[13px] text-signal phone:text-[14px]" aria-live="polite">
              Installing on the hub. The downloads are a few hundred MB, so this can take some minutes.
            </p>
          )}
        </>
      )}
      {phase === 'done' && result && words && (
        <>
          <p className={cn('m-0 text-[14px] leading-[1.5]', words.ok ? 'text-ok' : 'text-fault')} aria-live="polite">
            {words.text}
          </p>
          {result.tail && <CodeBlock code={result.tail} copy wrap maxLines={words.ok ? 6 : 16} className="mt-3" />}
          {words.ok && next?.libs && libsWords(next.libs) && (
            <div className="mt-3">
              <LibsNote libs={next.libs} />
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// System libraries: the root helper's button, or the two ways to do it as root
// ---------------------------------------------------------------------------

/**
 * What the browsers miss and what to do: the Install system libraries button
 * when the root helper can do it, else the helper's one-time install and the
 * apt-get line, with where to run them. Without onInstall (inside another
 * dialog) the button is a pointer to it.
 */
export function LibsNote({ libs, onInstall }: { libs: BrowserLibsDto; onInstall?: () => void }) {
  const phone = useIsMobile();
  const head = libsWords(libs);
  if (!head) return null;
  const choices = libsChoices(libs);
  const where = !libs.docker && !libs.setup ? whereWords(libs.place, libs.helper?.install ?? 'conclave system-helper install') : undefined;
  return (
    <div className="py-3" role="note" data-testid="browser-libs">
      <p className="m-0 text-[13px] leading-[1.5] text-warn phone:text-[14px]">{head}</p>
      {libs.setup &&
        (onInstall ? (
          <Button variant="outline" size={phone ? 'touch' : 'sm'} className="mt-2" onClick={onInstall}>
            Install system libraries
          </Button>
        ) : (
          <p className="m-0 mt-1 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Close this, then press Install system libraries under Engines.</p>
        ))}
      {choices.length > 0 && (
        <ol className="m-0 mt-2 list-none space-y-3 p-0">
          {choices.map((c, i) => (
            <li key={c.title}>
              <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
                <span className="font-medium text-fg">
                  {choices.length > 1 ? `${String.fromCharCode(97 + i)}. ` : ''}
                  {c.title}.
                </span>{' '}
                {c.text}
              </p>
              <CodeBlock code={c.command} shell wrap copy className="mt-1.5" />
            </li>
          ))}
        </ol>
      )}
      {where && choices.length > 0 && (
        <div className="mt-3 border-t border-rule pt-3">
          <p className="m-0 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">{where.text}</p>
          {where.example && <CodeBlock code={where.example} shell wrap copy className="mt-1.5" />}
          {where.hint && <p className="m-0 mt-1.5 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">{where.hint}</p>}
        </div>
      )}
    </div>
  );
}

/** The confirm with the helper's one line, then the answer and a fresh check of the libraries. */
function LibsDialog({ libs, onClose }: { libs: BrowserLibsDto; onClose: (next?: Status) => void }) {
  const phone = useIsMobile();
  const size = phone ? 'touch' : 'md';
  const [setup, setSetup] = useState(libs.setup!);
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [result, setResult] = useState<BrowserLibsResult>();
  const [error, setError] = useState<string>();
  const [next, setNext] = useState<Status>();
  const run = async () => {
    setPhase('running');
    setError(undefined);
    try {
      const r = await api().browserLibs(setup.lines);
      setResult(r);
      setNext(await api().browserStatus().catch(() => undefined));
      setPhase('done');
    } catch (e) {
      const fresh = e instanceof ApiError ? (e.body as { libs?: BrowserLibsDto } | undefined)?.libs?.setup : undefined;
      if (fresh) setSetup(fresh);
      setPhase('confirm');
      setError(errText(e));
    }
  };
  const close = () => {
    if (phase !== 'running') onClose(next);
  };
  const words = result ? libsResultWords(result) : undefined;
  return (
    <Dialog
      open
      onClose={close}
      title="Install system libraries"
      description={phase === 'done' ? undefined : libsConfirmWords(libs)}
      width={640}
      footer={
        phase === 'done' ? (
          <Button variant="solid" size={size} onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="quiet" size={size} disabled={phase === 'running'} onClick={close}>
              Cancel
            </Button>
            <Button variant="solid" size={size} busy={phase === 'running' ? 'Installing' : false} onClick={() => void run()}>
              Install
            </Button>
          </>
        )
      }
    >
      {phase !== 'done' && (
        <>
          {error && (
            <p className="m-0 mb-3 text-[13px] leading-[1.5] text-fault phone:text-[14px]" role="alert">
              {error}
            </p>
          )}
          {setup.lines.map((line, i) => (
            <div key={line} className={cn('py-2', i > 0 && 'border-t border-rule')}>
              <p className="m-0 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
                {i + 1}. {setup.say}
              </p>
              <CodeBlock code={line} shell wrap copy className="mt-2 [&>pre]:pr-9" />
            </div>
          ))}
          {phase === 'running' && (
            <p className="m-0 mt-3 text-[13px] text-signal phone:text-[14px]" aria-live="polite">
              Installing on the hub. apt-get downloads about 150 MB, so this can take a few minutes.
            </p>
          )}
        </>
      )}
      {phase === 'done' && result && words && (
        <>
          <p className={cn('m-0 text-[14px] leading-[1.5]', words.tone === 'ok' ? 'text-ok' : words.tone === 'warn' ? 'text-warn' : 'text-fault')} aria-live="polite">
            {words.text}
          </p>
          {result.tail && <CodeBlock code={result.tail} copy wrap maxLines={words.tone === 'ok' ? 6 : 16} className="mt-3" />}
        </>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Profiles: the engine of each
// ---------------------------------------------------------------------------

export function ProfileEngine({ p, s, onStatus }: { p: Profile; s: Status; onStatus: (s: Status) => void }) {
  const [asking, setAsking] = useState<'chromium' | 'cloak'>();
  const cloak = s.engines?.find((e) => e.engine === 'cloak');
  const set = async (engine: 'chromium' | 'cloak') => {
    try {
      onStatus(await api().updateBrowserProfile(p.name, { engine }));
    } catch (e) {
      toast({ title: `Could not change the engine. ${errText(e)}`, level: 'error' });
    }
  };
  const pick = (v: string) => {
    const engine = v as 'chromium' | 'cloak';
    if (engine === p.engine) return;
    // an old profile keeps its cookies, but the sites see another browser
    if (p.folder) setAsking(engine);
    else void set(engine);
  };
  return (
    <>
      <div className="w-full md:w-[220px]">
        <Select value={p.engine} onChange={(e) => pick(e.target.value)} aria-label={`Engine of ${p.name}`}>
          <option value="cloak" disabled={!cloak?.installed}>
            CloakBrowser{cloak?.installed ? '' : ' (not installed)'}
          </option>
          <option value="chromium">Chromium</option>
        </Select>
      </div>
      <ConfirmDialog
        open={!!asking}
        onClose={() => setAsking(undefined)}
        onConfirm={async () => {
          if (asking) await set(asking);
          setAsking(undefined);
        }}
        title={`Move ${p.name} to ${asking === 'cloak' ? 'CloakBrowser' : 'Chromium'}?`}
        body="The profile keeps its cookies, but the sites see a different browser and may ask you to sign in again or check you. Its open browser closes. A new profile is the cleaner way to start on another engine."
        confirm="Move"
        tone="neutral"
      />
    </>
  );
}

export function profileHelp(p: Profile, sites: string): string {
  return `${p.label}${p.open ? ', open now' : ''}. ${sites}`;
}

export { newProfileWords };

// ---------------------------------------------------------------------------
// The hub's proxy: for a blocked request, or when the owner asks in a chat
// ---------------------------------------------------------------------------

type Provider = 'none' | 'dataimpulse' | 'custom';

export function ProxyGroup({ s, onStatus }: { s: Status; onStatus: (s: Status) => void }) {
  const phone = useIsMobile();
  const px = s.proxy;
  const [provider, setProvider] = useState<Provider>(px?.provider ?? 'none');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState(px?.dataimpulse.country ?? '');
  const [host, setHost] = useState(px?.dataimpulse.host ?? 'gw.dataimpulse.com');
  const [port, setPort] = useState(String(px?.dataimpulse.port ?? 823));
  const [url, setUrl] = useState(px?.custom.url ?? '');
  const [customPw, setCustomPw] = useState('');
  const [testCountry, setTestCountry] = useState('');
  const [busy, setBusy] = useState<'save' | 'test'>();
  const [line, setLine] = useState<{ text: string; ok: boolean }>();
  useEffect(() => setProvider(px?.provider ?? 'none'), [px?.provider]);

  const save = async (next: Provider = provider) => {
    setBusy('save');
    setLine(undefined);
    try {
      const portN = Number(port);
      const st = await api().updateBrowserProxy({
        provider: next,
        ...(next === 'dataimpulse'
          ? { dataimpulse: { host: host.trim() || null, port: Number.isInteger(portN) && portN > 0 ? portN : null, country: country.trim() || null, ...(login ? { login } : {}), ...(password ? { password } : {}) } }
          : {}),
        ...(next === 'custom' ? { custom: { url: url.trim() || null, ...(customPw ? { password: customPw } : {}) } } : {}),
      });
      onStatus(st);
      setLogin('');
      setPassword('');
      setCustomPw('');
      setLine({ text: next === 'none' ? 'The proxy is off. Chats cannot use one until you pick a provider.' : 'Saved.', ok: true });
    } catch (e) {
      setLine({ text: errText(e), ok: false });
    }
    setBusy(undefined);
  };
  const choose = (p: Provider) => {
    setProvider(p);
    setLine(undefined);
    // None saves at once; a provider saves with its fields
    if (p === 'none' && px?.provider !== 'none') void save('none');
  };
  const test = async () => {
    setBusy('test');
    setLine(undefined);
    try {
      const r = await api().testBrowserProxy(testCountry.trim() || undefined);
      setLine({ text: testWords(r), ok: r.ok });
    } catch (e) {
      setLine({ text: errText(e), ok: false });
    }
    setBusy(undefined);
  };
  const btn = phone ? 'touch' : 'sm';
  const saved = px?.provider !== 'none' && px?.provider === provider;
  return (
    <Group title="Proxy" help={PROXY_HELP}>
      <SettingRow label="Provider" help={providerWords(px)}>
        <Segmented<Provider>
          value={provider}
          onChange={choose}
          size={phone ? 'touch' : 'sm'}
          full={phone}
          label="Proxy provider"
          options={[
            { value: 'none', label: 'None' },
            { value: 'dataimpulse', label: 'DataImpulse' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
      </SettingRow>
      {provider === 'dataimpulse' && (
        <>
          <SettingRow label="Login" help={px?.dataimpulse.login ? 'Saved as a hub secret. Type to change it.' : 'The proxy login from your DataImpulse dashboard. Kept as a hub secret.'}>
            <Input size="sm" value={login} onChange={(e) => setLogin(e.target.value)} placeholder={px?.dataimpulse.login ? 'Saved' : 'Login'} aria-label="DataImpulse login" autoComplete="off" spellCheck={false} className="md:max-w-[260px]" />
          </SettingRow>
          <SettingRow label="Password" help={px?.dataimpulse.password ? 'Saved as a hub secret. Type to change it.' : 'Kept as a hub secret.'}>
            <Input size="sm" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={px?.dataimpulse.password ? 'Saved' : 'Password'} aria-label="DataImpulse password" autoComplete="new-password" className="md:max-w-[260px]" />
          </SettingRow>
          <SettingRow label="Default country" help="For a chat that asks for a proxy without a country. Empty: DataImpulse picks.">
            <Input size="sm" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="JP, or Japan" aria-label="Default country" autoComplete="off" spellCheck={false} className="md:max-w-[160px]" />
          </SettingRow>
          <SettingRow label="Address" help="DataImpulse's HTTP gateway. Change it only if DataImpulse tells you to.">
            <div className="flex gap-2 md:justify-end">
              <div className="min-w-0 flex-1 md:w-[220px] md:flex-none">
                <Input mono size="sm" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Proxy host" spellCheck={false} />
              </div>
              <div className="w-[84px] shrink-0">
                <Input mono size="sm" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} aria-label="Proxy port" inputMode="numeric" />
              </div>
            </div>
          </SettingRow>
        </>
      )}
      {provider === 'custom' && (
        <>
          <SettingRow label="Address" help="One proxy: socks5://user@host:port or http://user@host:port. A SOCKS5 login goes through a small relay on the hub, since Chromium cannot send it.">
            <Input mono size="sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="socks5://user@203.0.113.5:1080" aria-label="Proxy address" spellCheck={false} autoComplete="off" className="md:max-w-[320px]" />
          </SettingRow>
          <SettingRow label="Password" help={px?.custom.password ? 'Saved as a hub secret. Type to change it.' : 'If it has one. Kept as a hub secret.'}>
            <Input size="sm" type="password" value={customPw} onChange={(e) => setCustomPw(e.target.value)} placeholder={px?.custom.password ? 'Saved' : 'Password'} aria-label="Proxy password" autoComplete="new-password" className="md:max-w-[260px]" />
          </SettingRow>
        </>
      )}
      {provider !== 'none' && (
        <SettingRow label="Save" help={saved ? 'Saved settings stay until you change them.' : 'Nothing is used until you save.'}>
          <Button variant="outline" size={btn} busy={busy === 'save' ? 'Saving' : false} onClick={() => void save()}>
            Save
          </Button>
        </SettingRow>
      )}
      {saved && (
        <SettingRow label="Test" help="Goes out through the proxy once and shows the address and country a site would see. Opens no browser.">
          <div className="flex gap-2 md:justify-end">
            <div className="min-w-0 flex-1 md:w-[170px] md:flex-none">
              <Input size="sm" value={testCountry} onChange={(e) => setTestCountry(e.target.value)} placeholder={provider === 'dataimpulse' ? 'Country, or empty' : 'No country choice'} disabled={provider !== 'dataimpulse'} aria-label="Country to test" />
            </div>
            <Button variant="outline" size={btn} busy={busy === 'test' ? 'Testing' : false} onClick={() => void test()}>
              Test
            </Button>
          </div>
        </SettingRow>
      )}
      {line && (
        <p className={cn('m-0 pb-3 text-[12px] leading-[1.45] phone:text-[13px]', line.ok ? 'text-ok' : 'text-fault')} aria-live="polite">
          {line.text}
        </p>
      )}
    </Group>
  );
}
