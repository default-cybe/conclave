/**
 * Settings > Web search (core tools/search-settings.ts): the engines
 * WebSearch can use with their free allowance, which one is in use, and
 * for the one picked here its sign-up steps, its keys (stored on the hub,
 * shown only by label and last 4 characters, with their state) in the order
 * WebSearch uses them, each with Test and Remove, or the SearXNG address.
 *
 * A member gets the same page on their own account: their own keys only
 * (the first one saved is the engine they use), whether the owner lets them
 * use the hub's search, and their own proxy for blocked requests. The engine
 * choice and the SearXNG address are the owner's, so those rows are hidden.
 */
import { useEffect, useState } from 'react';
import type { MemberProxyDto, SearchKeyDto, SearchProviderId, WebSearchSettingsDto, WebSearchTestResult } from '@conclave/core/client';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { useIsOwner } from '@/lib/people';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { Button, IconButton } from '@/components/ui/Button';
import { Input, SECRET_FIELD, Segmented } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { toast } from '@/store/store';
import { errText, Group, Outcome, SettingRow } from './parts';

export function WebSearchSection() {
  const [s, setS] = useState<WebSearchSettingsDto>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api()
      .webSearchSettings()
      .then(setS)
      .catch((e) => setError(errText(e)));
  }, []);
  if (error) return <p className="text-[13px] text-fault">Could not load the web search settings. {error}</p>;
  if (!s) return <LoadingRows loading rows={6} />;
  return <WebSearchBody s={s} onChange={setS} />;
}

/** "Brave Search, chosen here." or "Tavily, the first engine with a key." */
export function inUseWords(s: WebSearchSettingsDto): string {
  const name = s.providers.find((p) => p.id === s.active)?.name ?? s.active;
  if (s.hubAllowed !== undefined) {
    if (s.providers.some((p) => p.keyFrom === 'own')) return `${name}, on your own key.`;
    return s.hubAllowed ? `${name}, the hub's search, which the owner lets you use.` : `${name}, which needs no key. Add your own key for better results.`;
  }
  if (s.chosen !== 'auto') return `${name}, chosen here.`;
  return s.active === 'duckduckgo' ? `${name}, because no engine has a key or address yet.` : `${name}, the first engine with a key or address.`;
}

const STATUS: Record<SearchKeyDto['status'], string> = { working: 'Working', credit: 'Out of credit', cooloff: 'Rate limited', rejected: 'Rejected' };

/** "Out of credit until 01:00", "Rejected, replace it" */
export function keyStateWords(k: SearchKeyDto): string {
  if (k.status === 'rejected') return 'Rejected: the engine refused this key. Remove it or add a new one.';
  if (!k.until) return STATUS[k.status];
  const d = new Date(k.until);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `${STATUS[k.status]} until ${sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

/** An engine's saved keys in order: label, last 4 characters, state, Test, Remove, and drag or up and down to reorder. */
export function KeyRows({
  p,
  busy,
  size,
  mobile,
  call,
  onTest,
}: {
  p: WebSearchSettingsDto['providers'][number];
  busy?: string;
  size: 'touch' | 'sm';
  mobile: boolean;
  call: (what: string, fn: () => Promise<WebSearchSettingsDto>) => Promise<boolean>;
  onTest: (index: number) => void;
}) {
  const [drag, setDrag] = useState<number>();
  const [over, setOver] = useState<number>();
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= p.keys.length) return;
    const order = p.keys.map((_, i) => i);
    order.splice(to, 0, ...order.splice(from, 1));
    void call('order', () => api().patchWebSearchKeys({ provider: p.id, order }));
  };
  return (
    <ol className="m-0 list-none divide-y divide-line p-0" aria-label={`${p.name} keys`}>
      {p.keys.map((k, i) => (
        <li
          key={`${i}-${k.last4}-${k.label ?? ''}`}
          className={cn('flex items-center gap-3 py-2.5 phone:flex-wrap', drag === i && 'opacity-50', over === i && drag !== i && 'shadow-[inset_0_2px_0_var(--signal)]')}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(i);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (drag !== undefined) move(drag, i);
            setDrag(undefined);
            setOver(undefined);
          }}
        >
          <span className="num w-4 shrink-0 text-right text-[12.5px] text-fg-3" aria-label={`Key ${i + 1}`}>
            {i + 1}
          </span>
          {!mobile && (
            <span
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                setDrag(i);
              }}
              onDragEnd={() => (setDrag(undefined), setOver(undefined))}
              className="-ml-1 cursor-grab text-fg-4 hover:text-fg-2"
              aria-hidden
            >
              <GripVertical className="size-4" strokeWidth={1.75} />
            </span>
          )}
          {/* a phone keeps the label and state on one line and drops the buttons below */}
          <span className="min-w-0 flex-1 phone:min-w-[75%]">
            <span className="text-[13.5px] text-fg phone:text-[15px]">{k.label ?? `Key ${i + 1}`}</span>
            <span className="ml-2 whitespace-nowrap font-mono text-[12px] text-fg-3">{k.last4 ? `\u2026${k.last4}` : 'short key'}</span>
            <span className={cn('mt-0.5 block text-[12px] leading-[1.45] phone:text-[13px]', k.status === 'working' ? 'text-ok' : k.status === 'rejected' ? 'text-fault' : 'text-warn')}>{keyStateWords(k)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1 phone:ml-7">
            <Button size={size} busy={busy === `test${i}` ? 'Testing' : false} onClick={() => onTest(i)}>
              Test
            </Button>
            <IconButton label="Move up" size={mobile ? 'touch' : 'sm'} disabled={i === 0} onClick={() => move(i, i - 1)}>
              <ChevronUp />
            </IconButton>
            <IconButton label="Move down" size={mobile ? 'touch' : 'sm'} disabled={i === p.keys.length - 1} onClick={() => move(i, i + 1)}>
              <ChevronDown />
            </IconButton>
            <Button variant="danger" size={size} busy={busy === `rm${i}` ? 'Removing' : false} onClick={() => void call(`rm${i}`, () => api().setWebSearchKey(p.id, null, { index: i }))}>
              Remove
            </Button>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function WebSearchBody({ s, onChange, initial }: { s: WebSearchSettingsDto; onChange: (s: WebSearchSettingsDto) => void; initial?: SearchProviderId }) {
  const mobile = useIsMobile();
  const member = !useIsOwner();
  const size = mobile ? 'touch' : 'sm';
  const [open, setOpen] = useState<SearchProviderId>(initial ?? s.active);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  // the new-key row shows on its own when an engine has no key; with keys, behind "Add another key"
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState(s.url ?? '');
  const [busy, setBusy] = useState<string>();
  const [test, setTest] = useState<WebSearchTestResult>();
  const p = s.providers.find((x) => x.id === open) ?? s.providers[0];

  const call = async (what: string, fn: () => Promise<WebSearchSettingsDto>): Promise<boolean> => {
    setBusy(what);
    let done = false;
    try {
      onChange(await fn());
      done = true;
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
    return done;
  };
  const pick = (id: SearchProviderId) => {
    setOpen(id);
    setKey('');
    setLabel('');
    setAdding(false);
    setTest(undefined);
  };
  const paste = async () => {
    try {
      setKey((await navigator.clipboard.readText()).trim());
    } catch {
      toast({ title: 'The browser did not allow reading the clipboard. Paste into the field instead.', level: 'error' });
    }
  };
  /** index: one key's Test button; it also brings back that key's state, so the list reloads after. */
  const runTest = async (index?: number) => {
    setBusy(index === undefined ? 'test' : `test${index}`);
    setTest(undefined);
    try {
      setTest(await api().testWebSearch(p.id, index));
      if (index !== undefined) onChange(await api().webSearchSettings());
    } catch (e) {
      toast({ title: `The test did not run. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };

  return (
    <div className="space-y-9">
      <Group title="Engine" help={member ? 'WebSearch in your chats uses the first engine you saved a key for. Each one below has a free allowance for personal use. Pick one to see how to get its key.' : 'WebSearch in chats and sessions uses one engine for everyone on this hub. Each one below has a free allowance for personal use. Pick one to see how to get its key.'}>
        <SettingRow label="In use" help={inUseWords(s)}>
          {!member && s.chosen !== 'auto' && (
            <Button size={size} busy={busy === 'auto' ? 'Saving' : false} onClick={() => void call('auto', () => api().setWebSearchSettings({ provider: 'auto' }))}>
              Choose automatically
            </Button>
          )}
        </SettingRow>
        <ul className="m-0 list-none space-y-1 p-0 py-3" aria-label="Search engines">
          {s.providers.filter((x) => !member || x.needs === 'key').map((x) => (
            <li key={x.id}>
              <button
                type="button"
                aria-pressed={x.id === p.id}
                onClick={() => pick(x.id)}
                className={cn('w-full rounded-md px-3 py-2.5 text-left hover:bg-hover', x.id === p.id && 'bg-hover')}
              >
                <span className="text-[13.5px] font-medium text-fg phone:text-[15px]">{x.name}</span>
                {x.id === s.active && <span className="ml-2 text-[12px] text-ok">In use</span>}
                {x.keySet && <span className="ml-2 text-[12px] text-fg-3">{x.keys.length > 1 ? `${x.keys.length} keys` : 'Key saved'}</span>}
                {x.keys.length > 0 && x.keys.every((k) => k.status !== 'working') && <span className="ml-2 text-[12px] text-warn">No working key</span>}
                <span className="mt-0.5 block text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
                  {x.card && <span className="mr-1.5 font-medium text-warn">Needs a card.</span>}
                  {x.free}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Group>

      <Group title={p.name} help={p.card ? 'A card is needed to sign up, even for the free allowance.' : undefined}>
        {p.steps.length > 0 && (
          <div className="py-3.5">
            <div className="text-[13.5px] font-medium text-fg phone:text-[15px]">{p.needs === 'url' ? 'Set up a server' : 'Get a key'}</div>
            <ol className="mt-1.5 mb-0 list-decimal space-y-1 pl-5 text-[12.5px] leading-[1.5] text-fg-2 phone:text-[14px]">
              {p.steps.map((st, i) => (
                <li key={i}>
                  {st.text}
                  {st.url && (
                    <>
                      {' '}
                      <a href={st.url} target="_blank" rel="noreferrer" className="link">
                        {st.url.replace(/^https:\/\//, '')}
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
        {p.needs === 'key' && (
          <>
            <SettingRow
              label={p.keys.length > 1 ? 'Keys' : 'Key'}
              help={
                p.keys.length
                  ? `${p.keyFrom === 'own' ? 'Stored in your account' : 'Stored on the hub'}. WebSearch uses them in this order and moves to the next when one runs out of credit or is refused.`
                  : p.keySet
                    ? p.keyFrom === 'env'
                      ? `Set in the hub environment (${p.env?.join(' or ')}).`
                      : 'Set in config.json (search.apiKey).'
                    : `Not set.${p.keyHint ? ` ${p.keyHint}.` : ''}`
              }
              top
            >
              {p.keys.length > 0 && !adding && (
                <Button size={size} onClick={() => setAdding(true)}>
                  Add another key
                </Button>
              )}
            </SettingRow>
            {p.keys.length > 0 && <KeyRows p={p} busy={busy} size={size} mobile={mobile} call={call} onTest={(i) => void runTest(i)} />}
            {(adding || !p.keys.length) && (
              <SettingRow label={p.keys.length ? 'New key' : 'Add a key'} help="Paste the key, give it a label if you like, then Save." top>
                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, optional" aria-label={`${p.name} key label`} className="w-[140px]!" size="sm" maxLength={40} />
                  <Input mono {...SECRET_FIELD} value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" aria-label={`${p.name} API key`} className="w-[200px]!" size="sm" />
                  <Button size={size} onClick={() => void paste()}>
                    Paste
                  </Button>
                  <Button
                    variant="solid"
                    size={size}
                    disabled={!key.trim()}
                    busy={busy === 'key' ? 'Saving' : false}
                    onClick={async () => {
                      if (await call('key', () => api().setWebSearchKey(p.id, key.trim(), { add: true, ...(label.trim() ? { label: label.trim() } : {}) }))) {
                        setKey('');
                        setLabel('');
                        setAdding(false);
                      }
                    }}
                  >
                    Save
                  </Button>
                  {p.keys.length > 0 && (
                    <Button size={size} onClick={() => (setAdding(false), setKey(''), setLabel(''))}>
                      Cancel
                    </Button>
                  )}
                </div>
              </SettingRow>
            )}
          </>
        )}
        {!member && p.needs === 'url' && (
          <SettingRow label="Address" help={s.urlFrom === 'env' ? 'Set in the hub environment (SEARXNG_URL).' : 'The SearXNG server the hub asks, such as http://searxng.lan:8080.'} top>
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              <Input mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://searxng.lan:8080" aria-label="SearXNG address" className="w-[240px]!" size="sm" spellCheck={false} />
              {url.trim() !== (s.urlFrom === 'config' ? (s.url ?? '') : '') && (
                <Button variant="solid" size={size} busy={busy === 'url' ? 'Saving' : false} onClick={() => void call('url', () => api().setWebSearchSettings({ url: url.trim() || null }))}>
                  {url.trim() ? 'Save' : 'Clear'}
                </Button>
              )}
            </div>
          </SettingRow>
        )}
        <SettingRow label={member ? 'Test' : 'Use it'} help={member ? 'One real query on your key.' : s.chosen === p.id ? 'WebSearch uses this engine.' : 'Make WebSearch always use this engine.'}>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Button size={size} busy={busy === 'test' ? 'Testing' : false} onClick={() => void runTest()}>
              Test
            </Button>
            {!member && s.chosen !== p.id && (
              <Button variant="solid" size={size} busy={busy === 'use' ? 'Saving' : false} onClick={() => void call('use', () => api().setWebSearchSettings({ provider: p.id }))}>
                Use {p.name}
              </Button>
            )}
          </div>
        </SettingRow>
        {test && test.provider === p.id && (
          <p className="m-0 py-3" aria-label="Test result">
            <Outcome word={test.ok ? 'Works' : 'Failed'} tone={test.ok ? 'ok' : 'fault'}>
              {test.ok ? test.message.replace(/^Works\.\s*/, '') : test.message}
            </Outcome>
          </p>
        )}
      </Group>
      {member && <MemberProxyGroup />}
    </div>
  );
}

/** A member's own proxy: blocked WebFetch and WebSearch requests retry through it. The hub's proxy is never theirs. */
function MemberProxyGroup() {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [p, setP] = useState<MemberProxyDto>();
  const [kind, setKind] = useState<MemberProxyDto['provider']>('none');
  const [url, setUrl] = useState('');
  const [country, setCountry] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const load = (x: MemberProxyDto) => {
    setP(x);
    setKind(x.provider);
    setUrl(x.url ?? '');
    setCountry(x.country ?? '');
    setLogin('');
    setPassword('');
  };
  useEffect(() => {
    api()
      .memberProxy()
      .then(load)
      .catch(() => undefined);
  }, []);
  if (!p) return null;
  const save = async () => {
    setBusy(true);
    try {
      load(
        await api().setMemberProxy({
          provider: kind,
          ...(kind === 'custom' ? { url: url.trim() } : {}),
          ...(kind === 'dataimpulse' ? { country: country.trim() || null, ...(login ? { login } : {}) } : {}),
          ...(kind !== 'none' && password ? { password } : {}),
        }),
      );
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(false);
  };
  return (
    <Group title="Proxy" help="When a site blocks the hub's address, WebFetch and WebSearch retry once through your own proxy. The hub owner's proxy is never used for you. Your login and password stay in your account.">
      <SettingRow label="Proxy" help={p.provider === 'none' ? 'None: blocked requests are not retried.' : p.provider === 'custom' ? `Custom, ${p.url ?? ''}${p.passwordSet ? ', password saved' : ''}.` : `DataImpulse${p.country ? `, ${p.country}` : ''}${p.loginSet && p.passwordSet ? ', login saved' : ', login missing'}.`}>
        <Segmented<MemberProxyDto['provider']>
          label="Proxy"
          size={size}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'none', label: 'None' },
            { value: 'dataimpulse', label: 'DataImpulse' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
      </SettingRow>
      {kind === 'custom' && (
        <SettingRow label="Address" help="http://user@host:port. Only an HTTP proxy works for WebFetch and WebSearch." top>
          <Input mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://user@proxy.example.com:8080" aria-label="Proxy address" className="w-[240px]!" size="sm" spellCheck={false} />
        </SettingRow>
      )}
      {kind === 'dataimpulse' && (
        <>
          <SettingRow label="Login" help={p.loginSet ? 'Saved. Type a new one to replace it.' : 'Not saved.'} top>
            <Input mono type="password" autoComplete="off" value={login} onChange={(e) => setLogin(e.target.value)} aria-label="DataImpulse login" className="w-[200px]!" size="sm" />
          </SettingRow>
          <SettingRow label="Country" help="Two letters, such as US. Empty: DataImpulse picks." top>
            <Input mono value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Proxy country" className="w-[96px]!" size="sm" />
          </SettingRow>
        </>
      )}
      {kind !== 'none' && (
        <SettingRow label="Password" help={p.passwordSet ? 'Saved. Type a new one to replace it.' : 'Not saved.'} top>
          <Input mono type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Proxy password" className="w-[200px]!" size="sm" />
        </SettingRow>
      )}
      <SettingRow label="Save">
        <Button variant="solid" size={size} busy={busy ? 'Saving' : false} onClick={() => void save()}>
          {kind === 'none' ? 'Remove proxy' : 'Save proxy'}
        </Button>
      </SettingRow>
    </Group>
  );
}
