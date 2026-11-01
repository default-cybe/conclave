/**
 * Step 2, Providers (spec 11.11, graft 9): CLI logins found on the owner's
 * machines first, then API keys. Keys are write only: a paste saves with
 * setSecret and tests with testProvider, and the result shows in words.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Device } from '@conclave/core/types';
import { api } from '@/lib/api';
import { HARNESS_LOGINS, PROVIDERS } from '@/lib/providers';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { reloadConfig, reloadModels, updateConfig, useHub } from '@/store/store';
import { HarnessMark } from '@/components/logo';
import { Button } from '@/components/ui/Button';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { PROVIDER_COLS, ProviderHeader, ProviderRow, type ProviderResult } from '@/components/providers/ProviderRow';
import { StepFrame } from '../StepLayout';
import { andList, errText, Footnote, LINK, OutcomeWords, useCtlSize, type Outcome } from '../parts';
import { readProgress, saveProgressAnswer } from '../progress';

type Login = (typeof HARNESS_LOGINS)[number];

/** One CLI login found on a machine: "Claude Max, through Claude Code". */
function LoginRow({ login, devices, used, onUsed }: { login: Login; devices: Device[]; used: boolean; onUsed: (id: string, ok: boolean) => void }) {
  const mobile = useIsMobile();
  const ctl = useCtlSize('sm');
  const [outcome, setOutcome] = useState<Outcome>({ state: 'idle' });
  const d = devices[0];
  const version = d.info?.clis?.[login.cli];

  const check = async () => {
    setOutcome({ state: 'working', word: 'Checking' });
    try {
      const r = await api().testProvider(login.id);
      setOutcome(r.ok ? { state: 'ok', word: 'Works', detail: r.detail.replace(/^Signed in,\s*/, 'Signed in to ').replace(/^Found [\d.]+,\s*uses/, 'Uses') } : { state: 'fail', word: 'Not signed in', detail: r.detail });
      onUsed(login.id, r.ok);
    } catch (e) {
      setOutcome({ state: 'fail', word: 'Failed', detail: errText(e) });
    }
  };

  useEffect(() => {
    if (used) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ident = (
    <span className="flex min-w-0 items-center gap-3.5">
      <HarnessMark harness={login.id} size={22} className="text-fg" />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{login.plan}</span>
        <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">Through {login.name}</span>
      </span>
    </span>
  );
  const where = (
    <span className="block truncate text-[13px] text-fg-2 phone:text-[14px]">
      Found {login.name}
      {version && <> {version}</>} on {andList(devices.map((x) => x.name))}
    </span>
  );
  const result =
    outcome.state === 'idle' ? (
      <Button variant="outline" size={ctl} onClick={() => void check()}>
        Use as an engine
      </Button>
    ) : (
      <span className="block min-w-0 truncate" title={outcome.state !== 'working' && typeof outcome.detail === 'string' ? outcome.detail : undefined}>
        <OutcomeWords outcome={outcome} />
      </span>
    );

  if (mobile)
    return (
      <div className="flex items-center gap-3 py-3">
        <HarnessMark harness={login.id} size={22} className="text-fg" />
        <span className="min-w-0 flex-1 pl-0.5">
          <span className="block truncate text-[15px] font-medium text-fg">{login.plan}</span>
          <span className="block truncate text-[13px] text-fg-3">
            {login.name}
            {version && <> {version}</>}, {andList(devices.map((x) => x.name))}
          </span>
        </span>
        <span className="max-w-[46%] shrink-0 text-right">{result}</span>
      </div>
    );
  return (
    <div className={cn('grid items-center gap-x-4 py-3', PROVIDER_COLS)}>
      {ident}
      <span className="text-[13px] text-fg-3">Login</span>
      {where}
      <span className="min-w-0">{result}</span>
      <span />
    </div>
  );
}

export function ProvidersStep() {
  const devices = useHub((s) => s.devices);
  const keys = useHub((s) => s.secrets?.providers);
  const config = useHub((s) => s.config);
  const hub = useHub((s) => s.hub);
  const progress = readProgress(config);
  const [more, setMore] = useState(() => PROVIDERS.some((p) => p.more && keys?.includes(p.id)));
  const [results, setResults] = useState<Record<string, ProviderResult['state']>>({});
  const [logins, setLogins] = useState<string[]>(progress.logins ?? []);
  const [epoch, setEpoch] = useState<Record<string, number>>({});
  const loginsRef = useRef(logins);
  loginsRef.current = logins;

  const found = useMemo(() => {
    const list = Object.values(devices).filter((d) => d.online || d.info);
    return HARNESS_LOGINS.map((l) => ({ login: l, on: list.filter((d) => d.info?.clis?.[l.cli]) })).filter((x) => x.on.length);
  }, [devices]);

  const shown = PROVIDERS.filter((p) => !p.more || more);

  const onResult = (id: string) => (r: ProviderResult) => {
    setResults((m) => ({ ...m, [id]: r.state }));
    // a local runtime that answered is ready to use
    const p = PROVIDERS.find((x) => x.id === id);
    if (p?.signIn === 'none' && r.state === 'found') {
      const cur = (config?.providers as Record<string, { enabled?: boolean }> | undefined)?.[id];
      if (cur?.enabled !== true) void updateConfig({ providers: { [id]: { enabled: true } } }).catch(() => undefined);
    }
  };

  const onUsed = (id: string, ok: boolean) => {
    const next = ok ? [...new Set([...loginsRef.current, id])] : loginsRef.current.filter((x) => x !== id);
    setLogins(next);
    void saveProgressAnswer({ logins: next });
    // the harnesses are off until turned on: using the login turns it on as an engine (Settings, Providers turns it off)
    if (ok) void updateConfig({ providers: { [id]: { enabled: true } } }).then(() => reloadModels()).catch(() => undefined);
  };

  const remount = (id: string) => setEpoch((e) => ({ ...e, [id]: (e[id] ?? 0) + 1 }));

  const states = Object.entries(results);
  const ready = states.filter(([, s]) => s === 'works' || s === 'found').length + logins.length;
  const bad = states.filter(([, s]) => s === 'rejected').length;
  const parts: ReactNode[] = [];
  if (ready) parts.push(<span key="r" className="font-[560] text-ok">{ready} ready</span>);
  if (bad) parts.push(<span key="b">{bad === 1 ? '1 needs a new key' : `${bad} need a new key`}</span>);
  const summary = parts.length ? parts.flatMap((p, i) => (i ? [<span key={`c${i}`}>, </span>, p] : [p])) : 'Nothing added yet.';

  return (
    <StepFrame summary={<>{summary}</>}>
      {found.length > 0 && (
        <section className="mb-10">
          <SectionHeading count={found.length}>Coding agents found on your machines</SectionHeading>
          <p className="m-0 mt-2 text-[12px] text-fg-3 phone:text-[13px]">Optional. Conclave runs its own agent loop; use one of these as the engine for a session with the login it already has.</p>
          <div className="rows">
            {found.map(({ login, on }) => (
              <LoginRow key={login.id} login={login} devices={on} used={logins.includes(login.id)} onUsed={onUsed} />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeading rule={false} className="pb-3">
          API keys
        </SectionHeading>
        <ProviderHeader />
        <div className="rows border-b border-rule">
          {shown.map((p) => (
            <ProviderRow
              key={`${p.id}:${epoch[p.id] ?? 0}`}
              provider={p.id}
              testOnMount
              onResult={onResult(p.id)}
              menu={
                keys?.includes(p.id)
                  ? [
                      { label: 'Test again', onSelect: () => remount(p.id) },
                      {
                        label: 'Remove key',
                        danger: true,
                        onSelect: async () => {
                          await api().setSecret('providers', p.id, null);
                          await reloadConfig();
                          void reloadModels();
                          setResults((m) => ({ ...m, [p.id]: 'notset' }));
                          remount(p.id);
                        },
                      },
                    ]
                  : p.signIn === 'none'
                    ? [{ label: 'Look again', onSelect: () => remount(p.id) }]
                    : undefined
              }
            />
          ))}
        </div>
        {!more && (
          <div className="pt-3">
            <TextAction className={LINK} label={`More providers: ${andList(PROVIDERS.filter((p) => p.more).map((p) => p.name))}`} onClick={() => setMore(true)} />
          </div>
        )}
      </section>

      <div className="mt-10 grid gap-x-12 gap-y-6 md:grid-cols-2">
        <Footnote title="Where keys live">On {hub?.name ?? 'the hub'} only, in a file that only the hub can read. The hub never sends a key back, not even to this page.</Footnote>
        <Footnote title="Subscriptions">Claude Max and ChatGPT Pro run through their own CLIs. Conclave reads their limits so Home can show what is left.</Footnote>
      </div>
    </StepFrame>
  );
}
