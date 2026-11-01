/**
 * One provider row, shared by Settings > Providers and the onboarding
 * Providers step (spec 0.3 graft 7, 11.10, 11.11 step 2): company logo 22 in
 * brand color, name and one line, how it signs in, the key field, and the
 * result in words. On paste or blur the key is saved with setSecret and
 * tested with testProvider; while testing the Knot and the words show the host.
 * A rejected key turns the field fault and explains why under the row.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { reloadConfig, reloadModels, useHub } from '@/store/store';
import { keyPlaceholder, providerInfo, type ProviderInfo } from '@/lib/providers';
import { useIsMobile } from '@/lib/hooks';
import { CompanyMark } from '../logo';
import { LiveStatus } from '../motion';
import { Input } from '../ui/Field';
import { IconButton } from '../ui/Button';
import { Menu, type MenuItem } from '../ui/Overlay';

export type ProviderState = 'notset' | 'set' | 'saving' | 'testing' | 'works' | 'rejected' | 'found';

export interface ProviderResult {
  state: ProviderState;
  /** Hub detail: "7 models", or the rejection sentence. */
  detail?: string;
  latencyMs?: number;
}

/** Save, test and remove a provider key; the state behind ProviderRow. */
export function useProviderKey(provider: string) {
  const info = providerInfo(provider);
  // a key saved here, or one the hub has from its config or environment
  const hasKey = useHub((s) => !!s.secrets?.providers.includes(provider) || !!s.secrets?.keyed?.includes(provider));
  const [result, setResult] = useState<ProviderResult>({ state: hasKey ? 'set' : info?.signIn === 'none' ? 'set' : 'notset' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setResult((r) => (r.state === 'notset' && hasKey ? { state: 'set' } : r));
  }, [hasKey]);

  const test = async (): Promise<ProviderResult> => {
    setResult({ state: 'testing' });
    let r: { ok: boolean; detail: string; latencyMs?: number };
    try {
      r = await api().testProvider(provider);
    } catch (e) {
      r = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    const next: ProviderResult = r.ok ? { state: info?.signIn === 'none' ? 'found' : 'works', detail: r.detail.replace(/^Found\s+/i, ''), latencyMs: r.latencyMs } : { state: /no key set/i.test(r.detail) ? 'notset' : 'rejected', detail: r.detail };
    if (alive.current) setResult(next);
    void reloadModels();
    return next;
  };

  const save = async (key: string): Promise<ProviderResult> => {
    setResult({ state: 'saving' });
    try {
      await api().setSecret('providers', provider, key);
    } catch (e) {
      const next: ProviderResult = { state: 'rejected', detail: e instanceof Error ? e.message : String(e) };
      if (alive.current) setResult(next);
      return next;
    }
    await reloadConfig();
    return test();
  };

  const remove = async () => {
    await api().setSecret('providers', provider, null);
    await reloadConfig();
    void reloadModels();
    if (alive.current) setResult({ state: 'notset' });
  };

  return { info, hasKey, result, setResult, test, save, remove };
}

/** The result as words: "Works  7 models, 212 ms", "Rejected  401", "Not set". */
export function ProviderResultWords({ result, host }: { result: ProviderResult; host?: string }) {
  switch (result.state) {
    case 'saving':
    case 'testing':
      return <LiveStatus state="tool" label={result.state === 'saving' ? 'Saving' : 'Testing'} detail={host} still />;
    case 'works':
      return (
        <span className="text-fg-3">
          <span className="text-ok">Works</span>&nbsp; {result.detail}
          {result.latencyMs !== undefined && (
            <>
              , <span className="num">{result.latencyMs}</span> ms
            </>
          )}
        </span>
      );
    case 'found':
      return (
        <span className="text-fg-3">
          <span className="text-ok">Found</span>&nbsp; {result.detail}
        </span>
      );
    case 'rejected': {
      const code = result.detail?.match(/\b([45]\d\d)\b/)?.[1];
      return (
        <span className="text-fg-3">
          <span className="text-fault">Rejected</span>
          {code && <>&nbsp; {code}</>}
        </span>
      );
    }
    case 'set':
      return <span className="text-fg-3">Key saved</span>;
    default:
      return <span className="text-fg-3">Not set</span>;
  }
}

const SIGN_IN_WORD: Record<string, string> = { key: 'API key', none: 'No key', login: 'Login' };

export interface ProviderRowProps {
  provider: string;
  /** Overrides from the catalog (lib/providers). */
  name?: ReactNode;
  description?: ReactNode;
  /** Settings passes its row menu (Test again, Change key, Base URL, Models, Remove). */
  menu?: MenuItem[];
  /** Expanded content under the row (Settings: base URL, models, plan). */
  children?: ReactNode;
  /** Test once on mount (Settings shows live state; onboarding tests on paste). */
  testOnMount?: boolean;
  onResult?: (r: ProviderResult) => void;
  className?: string;
}

/** Column template shared by the header and rows. */
export const PROVIDER_COLS = 'grid-cols-[minmax(0,1.25fr)_88px_minmax(0,1.35fr)_minmax(0,1fr)_30px]';

export function ProviderRow({ provider, name, description, menu, children, testOnMount, onResult, className }: ProviderRowProps) {
  const mobile = useIsMobile();
  const k = useProviderKey(provider);
  const info: ProviderInfo | undefined = k.info;
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(!k.hasKey);
  const last = useRef('');

  useEffect(() => {
    if (testOnMount && (k.hasKey || info?.signIn === 'none')) void k.test().then(onResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (key: string) => {
    const v = key.trim();
    if (!v || v === last.current) return;
    last.current = v;
    const r = await k.save(v);
    onResult?.(r);
    if (r.state === 'works') {
      setEditing(false);
      setValue('');
      last.current = '';
    }
  };

  const rejected = k.result.state === 'rejected';
  const keyCell =
    info?.signIn === 'none' ? (
      <span className="text-[13px] text-fg-3">No key needed</span>
    ) : editing ? (
      <Input
        mono
        size="sm"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        invalid={rejected}
        placeholder={keyPlaceholder(info)}
        aria-label={`${info?.name ?? provider} API key`}
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (t) {
            e.preventDefault();
            setValue(t.trim());
            void submit(t);
          }
        }}
        onBlur={() => void submit(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit(value);
        }}
      />
    ) : (
      <span className="flex items-center gap-3 text-[13px]">
        <span className="font-mono text-[12.5px] text-fg-3">••••••••</span>
        <button type="button" className="text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg" onClick={() => setEditing(true)}>
          Change
        </button>
      </span>
    );

  const menuCell = menu?.length ? (
    <Menu
      items={menu}
      label={`${info?.name ?? provider} actions`}
      trigger={({ ref, props }) => (
        <IconButton ref={ref} label="More actions" size={mobile ? 'touch' : 'sm'} {...props}>
          <MoreHorizontal />
        </IconButton>
      )}
    />
  ) : (
    <span />
  );

  const ident = (
    <span className="flex min-w-0 items-center gap-3.5">
      <CompanyMark provider={provider} size={22} tone="brand" fallbackName={info?.name} />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{name ?? info?.name ?? provider}</span>
        <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">{description ?? info?.description}</span>
      </span>
    </span>
  );

  return (
    <div className={cn('py-3', className)}>
      {mobile ? (
        <>
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1">{ident}</span>
            <span className="shrink-0 text-[13px]">
              <ProviderResultWords result={k.result} host={info?.host} />
            </span>
            {menuCell}
          </div>
          <div className="mt-2.5 pl-[36px]">{keyCell}</div>
        </>
      ) : (
        <div className={cn('grid items-center gap-x-4', PROVIDER_COLS)}>
          {ident}
          <span className="text-[13px] text-fg-3">{SIGN_IN_WORD[info?.signIn ?? 'key']}</span>
          <span className="min-w-0">{keyCell}</span>
          <span className="min-w-0 truncate text-[13px]">
            <ProviderResultWords result={k.result} host={info?.host} />
          </span>
          {menuCell}
        </div>
      )}
      {rejected && k.result.detail && <p className={cn('mt-2 text-[12px] leading-[1.4] text-fault phone:text-[13px]', !mobile && 'pl-[36px]')}>{k.result.detail}</p>}
      {children && <div className="mt-3 pl-[36px]">{children}</div>}
    </div>
  );
}

/** Column headers for a list of provider rows (onboarding shows them; Settings may not). */
export function ProviderHeader({ className }: { className?: string }) {
  return (
    <div className={cn('grid gap-x-4 border-b border-rule pb-[7px] text-[12px] text-fg-3 phone:hidden', PROVIDER_COLS, className)}>
      <span>Provider</span>
      <span>Sign in with</span>
      <span>Key</span>
      <span>Result</span>
      <span />
    </div>
  );
}
