/**
 * Settings > Providers (spec 11.10): coding agents as engines first (Claude
 * Code, Codex, Gemini CLI, OpenCode: off until turned on here, since
 * Conclave runs its own agent loop), then API keys on the shared provider
 * row (company logo, sign in method, key, result in words). Details open
 * under a row: base URL, the models shown in pickers, and the plan its
 * usage counts toward.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { ModelGroup } from '@conclave/core/client';
import { api } from '@/lib/api';
import { reloadConfig, reloadModels, toast, useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { contextLabel } from '@/lib/models';
import { HARNESS_LOGINS, PROVIDERS, providerInfo } from '@/lib/providers';
import { ProviderHeader, ProviderRow, PROVIDER_COLS } from '@/components/providers/ProviderRow';
import { CompanyMark, HarnessMark, ModelName } from '@/components/logo';
import { LiveStatus } from '@/components/motion';
import { Button, IconButton } from '@/components/ui/Button';
import { Checkbox, Input, OnOff } from '@/components/ui/Field';
import { ConfirmDialog, Menu, type MenuItem } from '@/components/ui/Overlay';
import { errText, Group, Outcome, save } from './parts';

interface ProviderCfg {
  type?: string;
  name?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  models?: string[];
  enabled?: boolean;
  subscription?: string;
  command?: string;
  args?: string[];
}

const NO_KEYS: string[] = [];

export function ProvidersSection() {
  const config = useHub((s) => s.config);
  const keys = useHub((s) => s.secrets?.providers ?? NO_KEYS);
  const hub = useHub((s) => s.hub);
  const [epoch, setEpoch] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const providers = (config?.providers ?? {}) as Record<string, ProviderCfg>;

  const harness = HARNESS_LOGINS.filter((l) => providers[l.id]?.type === 'acp' || !providers[l.id]);
  const keyed = useMemo(() => {
    const ids = PROVIDERS.filter((p) => (providers[p.id] && providers[p.id].type !== 'acp') || keys.includes(p.id) || added.includes(p.id)).map((p) => p.id);
    const extra = Object.entries(providers)
      .filter(([id, p]) => p && p.type !== 'acp' && !providerInfo(id) && !HARNESS_LOGINS.some((h) => h.id === id))
      .map(([id]) => id);
    return [...ids, ...extra];
  }, [providers, keys, added]);
  const addable = PROVIDERS.filter((p) => !keyed.includes(p.id));

  const remount = (id: string) => setEpoch((e) => ({ ...e, [id]: (e[id] ?? 0) + 1 }));

  const menuFor = (id: string): MenuItem[] => {
    const cfg = providers[id];
    const off = cfg?.enabled === false;
    const items: MenuItem[] = [
      { label: 'Test again', onSelect: () => remount(id) },
      {
        label: open === id ? 'Hide details' : 'Base URL and models',
        onSelect: () => setOpen(open === id ? null : id),
      },
      {
        label: off ? 'Turn on' : 'Turn off',
        onSelect: async () => {
          if (await save({ providers: { [id]: { enabled: off } } })) void reloadModels();
        },
      },
    ];
    if (keys.includes(id)) items.push({ separator: true, label: '' }, { label: 'Remove key', danger: true, onSelect: () => setRemoving(id) });
    return items;
  };

  const removingName = removing ? (providers[removing]?.name ?? providerInfo(removing)?.name ?? removing) : '';

  return (
    <div className="space-y-9">
      {harness.length > 0 && (
        <Group title="Coding agents as engines" count={harness.length} help="Optional. Conclave runs its own agent loop. Turn one on to use Claude Code or Codex as the engine for a session, with its own login. Off, it is not in the model pickers. Importing its past chats works either way.">
          {harness.map((h) => (
            <HarnessLoginRow key={`${h.id}:${epoch[h.id] ?? 0}`} login={h} cfg={providers[h.id]} onRetest={() => remount(h.id)} />
          ))}
        </Group>
      )}

      <section aria-labelledby="prov-keys">
        <div className="flex items-baseline gap-2 border-b border-rule-2 pb-[9px]">
          <h2 id="prov-keys" className="t-section text-fg">
            API keys
          </h2>
          <span className="num text-[13px] font-[450] text-fg-3">{keyed.length}</span>
          {addable.length > 0 && (
            <span className="ml-auto">
              <Menu
                width={300}
                label="Add a provider"
                items={addable.map((p) => ({
                  label: p.name,
                  lead: <CompanyMark provider={p.id} size={16} tone="brand" fallbackName={p.name} />,
                  detail: p.description,
                  onSelect: () => {
                    setAdded((a) => [...a, p.id]);
                    setTimeout(() => document.querySelector<HTMLInputElement>(`[aria-label="${p.name} API key"]`)?.focus(), 80);
                  },
                }))}
                trigger={({ ref, props }) => (
                  <button ref={ref} type="button" className="text-[12px] font-[450] text-fg-3 hover:text-fg phone:text-[13px]" {...props}>
                    Add a provider
                  </button>
                )}
              />
            </span>
          )}
        </div>
        <ProviderHeader className="pt-2.5" />
        <div className="rows">
          {keyed.map((id) => {
            const cfg = providers[id];
            const info = providerInfo(id);
            const off = cfg?.enabled === false;
            // a turned off provider is not tested: its row says Off, not a stale Works
            if (off) return <OffProviderRow key={id} id={id} name={cfg?.name ?? info?.name ?? id} menu={menuFor(id)} />;
            return (
              <ProviderRow
                key={`${id}:${epoch[id] ?? 0}`}
                provider={id}
                name={cfg?.name && !info ? cfg.name : undefined}
                description={!info ? (cfg?.baseUrl?.replace(/^https?:\/\//, '') ?? 'Custom endpoint') : undefined}
                testOnMount
                menu={menuFor(id)}
              >
                {open === id && <ProviderDetail id={id} cfg={cfg} onClose={() => setOpen(null)} />}
              </ProviderRow>
            );
          })}
        </div>
        <div className="mt-4 grid gap-x-8 gap-y-3 border-t border-rule pt-4 text-[12px] leading-[1.45] text-fg-3 sm:grid-cols-2 phone:text-[13px]">
          <p className="m-0">
            <span className="font-medium text-fg-2">Where keys live.</span> On {hub?.name ?? 'the hub'} only, encrypted with the hub key. Phones and other computers never receive them.
          </p>
          <p className="m-0">
            <span className="font-medium text-fg-2">Testing.</span> Each key is checked when this page opens: a list of models, never a paid request.
          </p>
        </div>
      </section>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove the ${removingName} key?`}
        body={`Sessions on ${removingName} models stop until you add a key again.`}
        confirm="Remove key"
        busy="Removing"
        onConfirm={async () => {
          const id = removing!;
          try {
            await api().setSecret('providers', id, null);
            await reloadConfig();
            void reloadModels();
            remount(id);
          } catch (e) {
            toast({
              title: `Could not remove the key. ${errText(e)}`,
              level: 'error',
            });
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// A provider that is turned off
// ---------------------------------------------------------------------------

function OffProviderRow({ id, name, menu }: { id: string; name: string; menu: MenuItem[] }) {
  const mobile = useIsMobile();
  const info = providerInfo(id);
  const ident = (
    <span className="flex min-w-0 items-center gap-3.5">
      <CompanyMark provider={id} size={22} tone="mono" fallbackName={name} className="text-fg-3" />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-medium text-fg-2 phone:text-[15px]">{name}</span>
        <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">Its models are hidden from pickers.</span>
      </span>
    </span>
  );
  const menuCell = (
    <Menu
      items={menu}
      label={`${name} actions`}
      trigger={({ ref, props }) => (
        <IconButton ref={ref} label="More actions" size={mobile ? 'touch' : 'sm'} {...props}>
          <MoreHorizontal />
        </IconButton>
      )}
    />
  );
  if (mobile)
    return (
      <div className="flex items-center gap-3 py-3">
        <span className="min-w-0 flex-1">{ident}</span>
        <Outcome word="Off" tone="dim" />
        {menuCell}
      </div>
    );
  return (
    <div className={cn('grid items-center gap-x-4 py-3', PROVIDER_COLS)}>
      {ident}
      <span className="text-[13px] text-fg-3">{info?.signIn === 'none' ? 'No key' : 'API key'}</span>
      <span className="text-[13px] text-fg-3">Turned off</span>
      <Outcome word="Off" tone="dim" />
      {menuCell}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A plan signed in through a CLI
// ---------------------------------------------------------------------------

type LoginState = { state: 'testing' } | { state: 'ok'; detail: string } | { state: 'missing'; detail: string } | { state: 'off' };

function HarnessLoginRow({ login, cfg, onRetest }: { login: (typeof HARNESS_LOGINS)[number]; cfg?: ProviderCfg; onRetest: () => void }) {
  const mobile = useIsMobile();
  const devices = useHub((s) => s.devices);
  const hubName = useHub((s) => s.hub?.name ?? 'the hub');
  const off = cfg?.enabled === false;
  const [r, setR] = useState<LoginState>(off ? { state: 'off' } : { state: 'testing' });
  const on = Object.values(devices).filter((d) => d.info?.clis?.[login.cli]);

  useEffect(() => {
    if (off) return;
    let alive = true;
    api()
      .testProvider(login.id)
      .then((x) => alive && setR(x.ok ? { state: 'ok', detail: x.detail } : { state: 'missing', detail: x.detail }))
      .catch((e) => alive && setR({ state: 'missing', detail: errText(e) }));
    return () => {
      alive = false;
    };
  }, [login.id, off]);

  const result: ReactNode =
    r.state === 'testing' ? (
      <LiveStatus state="tool" label="Checking" />
    ) : r.state === 'ok' ? (
      <span title={r.detail}>
        <Outcome word="Signed in" tone="ok" />
      </span>
    ) : r.state === 'off' ? (
      <Outcome word="Off" tone="dim" />
    ) : (
      <Outcome word={on.length ? `Not on ${hubName}` : 'Not found'} tone="dim" />
    );

  const setOn = (on: boolean) => void save({ providers: { [login.id]: { enabled: on } } }).then((ok) => ok && (reloadModels(), onRetest()));
  const menu: MenuItem[] = [{ label: 'Check again', onSelect: onRetest, disabled: off }];
  const toggle = <OnOff label={`Use ${login.name} as an engine`} size={mobile ? 'touch' : 'sm'} checked={!off} onChange={setOn} />;

  const ident = (
    <span className="flex min-w-0 items-center gap-3.5">
      <HarnessMark harness={login.id} size={22} />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{login.name}</span>
        <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">With your {login.plan} login</span>
      </span>
    </span>
  );
  const where = on.length ? `On ${on.map((d) => d.name).join(', ')}` : 'Not on a paired machine';
  const menuCell = (
    <Menu
      items={menu}
      label={`${login.plan} actions`}
      trigger={({ ref, props }) => (
        <IconButton ref={ref} label="More actions" size={mobile ? 'touch' : 'sm'} {...props}>
          <MoreHorizontal />
        </IconButton>
      )}
    />
  );

  return (
    <div className="py-3">
      {mobile ? (
        <>
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1">{ident}</span>
            {toggle}
          </div>
          <div className="mt-1.5 flex items-center gap-2 pl-[36px] text-[13px] text-fg-3">
            <span className="min-w-0 flex-1 truncate">{where}</span>
            <span className="shrink-0">{result}</span>
            {menuCell}
          </div>
        </>
      ) : (
        <div className={cn('grid items-center gap-x-4', PROVIDER_COLS)}>
          {ident}
          <span className="text-[13px] text-fg-3">CLI login</span>
          <span className="min-w-0 truncate text-[13px] text-fg-3" title={on.map((d) => `${d.name} ${d.info?.clis?.[login.cli] ?? ''}`).join(', ')}>
            {where}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="min-w-0 truncate">{result}</span>
            {toggle}
          </span>
          {menuCell}
        </div>
      )}
      {r.state === 'missing' && <p className={cn('mt-1.5 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]', !mobile && 'pl-[36px]')}>{r.detail}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details under a provider row
// ---------------------------------------------------------------------------

function ProviderDetail({ id, cfg, onClose }: { id: string; cfg?: ProviderCfg; onClose: () => void }) {
  const groups = useHub((s) => s.models);
  const limits = useHub((s) => s.limits);
  const info = providerInfo(id);
  const group: ModelGroup | undefined = groups.find((g) => g.provider === id);
  const [baseUrl, setBaseUrl] = useState(cfg?.baseUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [extra, setExtra] = useState('');
  const chosen = cfg?.models ?? [];
  const ids = useMemo(() => {
    const fromGroup = (group?.models ?? []).map((m) => m.ref.slice(id.length + 1));
    return [...new Set([...fromGroup, ...chosen])];
  }, [group, chosen, id]);
  const isOn = (m: string) => !chosen.length || chosen.includes(m);
  const plan = cfg?.subscription ? limits[cfg.subscription] : undefined;

  const setModels = (next: string[]) => {
    // every model checked means "all of them": clear the list so new ones appear on their own
    const all = next.length === ids.length && ids.every((m) => next.includes(m));
    void save({ providers: { [id]: { models: all ? [] : next } } }).then((ok) => {
      if (ok) void reloadModels();
    });
  };

  const saveUrl = async () => {
    setSaving(true);
    const ok = await save({
      providers: { [id]: { baseUrl: baseUrl.trim() || undefined } },
    });
    setSaving(false);
    if (ok) {
      toast({ title: `Base URL for ${info?.name ?? id} saved.` });
      void reloadModels();
    }
  };

  return (
    <div className="space-y-5 border-l border-rule-2 pb-2 pl-4 anim-fade">
      <div>
        <label htmlFor={`url-${id}`} className="text-[12px] font-medium text-fg-2 phone:text-[13px]">
          Base URL
        </label>
        <div className="mt-1.5 flex gap-2">
          <Input
            id={`url-${id}`}
            mono
            size="sm"
            value={baseUrl}
            placeholder={info ? `https://${info.host}` : 'https://'}
            onChange={(e) => setBaseUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveUrl()}
          />
          <Button size="sm" variant="outline" disabled={(cfg?.baseUrl ?? '') === baseUrl.trim()} busy={saving ? 'Saving' : false} onClick={() => void saveUrl()}>
            Save
          </Button>
        </div>
        <p className="mt-1.5 text-[12px] text-fg-3">Leave empty for the provider's own address. Set it for a proxy or a compatible server.</p>
      </div>

      {ids.length > 0 && (
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Models in pickers</span>
            <span className="num text-[12px] text-fg-3">{chosen.length ? `${chosen.length} of ${ids.length}` : `all ${ids.length}`}</span>
          </div>
          <div className="mt-1 rows">
            {ids.map((m) => {
              const info = group?.models.find((x) => x.ref === `${id}/${m}`);
              return (
                <div key={m} className="flex items-center gap-3 py-1.5">
                  <Checkbox
                    checked={isOn(m)}
                    onChange={(v) => setModels(v ? [...(chosen.length ? chosen : ids.filter(isOn)), m] : (chosen.length ? chosen : ids).filter((x) => x !== m))}
                    label={<ModelName model={`${id}/${m}`} as="model" size={14} tone="brand" />}
                    className="min-w-0 flex-1 py-0"
                  />
                  <span className="font-mono text-[11.5px] text-fg-3">{m}</span>
                  {info && (
                    <span className="num w-[120px] shrink-0 text-right text-[12px] text-fg-3 phone:hidden">
                      {contextLabel(info.contextWindow)}
                      {info.inputPrice || info.outputPrice ? `, $${info.inputPrice} / $${info.outputPrice}` : ', plan'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = extra.trim();
              if (!v || ids.includes(v)) return setExtra('');
              setModels([...(chosen.length ? chosen : ids), v]);
              setExtra('');
            }}
          >
            <Input mono size="sm" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Add a model id" aria-label="Model id to add" />
            <Button type="submit" size="sm" variant="outline" disabled={!extra.trim()}>
              Add
            </Button>
          </form>
        </div>
      )}

      {(plan || cfg?.apiKeyEnv) && (
        <div className="space-y-1 text-[12px] text-fg-3 phone:text-[13px]">
          {plan && <p className="m-0">Usage counts toward the {plan.label.replace(/\s*·\s*/g, ', ')} limits.</p>}
          {cfg?.apiKeyEnv && (
            <p className="m-0">
              Without a saved key, the hub reads <span className="mono text-fg-2">${cfg.apiKeyEnv}</span>.
            </p>
          )}
        </div>
      )}
      <button type="button" className="text-[12px] text-fg-3 hover:text-fg" onClick={onClose}>
        Hide details
      </button>
    </div>
  );
}
