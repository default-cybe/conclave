/**
 * Settings > Web search (core tools/search-settings.ts): the engines
 * WebSearch can use with their free allowance, which one is in use, and
 * for the one picked here its sign-up steps, its key (stored on the hub,
 * never shown again) with Paste, Save, Test and Remove, or the SearXNG
 * address. The owner's only.
 */
import { useEffect, useState } from 'react';
import type { SearchProviderId, WebSearchSettingsDto, WebSearchTestResult } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
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
  if (s.chosen !== 'auto') return `${name}, chosen here.`;
  return s.active === 'duckduckgo' ? `${name}, because no engine has a key or address yet.` : `${name}, the first engine with a key or address.`;
}

export function WebSearchBody({ s, onChange, initial }: { s: WebSearchSettingsDto; onChange: (s: WebSearchSettingsDto) => void; initial?: SearchProviderId }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [open, setOpen] = useState<SearchProviderId>(initial ?? s.active);
  const [key, setKey] = useState('');
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
    setTest(undefined);
  };
  const paste = async () => {
    try {
      setKey((await navigator.clipboard.readText()).trim());
    } catch {
      toast({ title: 'The browser did not allow reading the clipboard. Paste into the field instead.', level: 'error' });
    }
  };
  const runTest = async () => {
    setBusy('test');
    setTest(undefined);
    try {
      setTest(await api().testWebSearch(p.id));
    } catch (e) {
      toast({ title: `The test did not run. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };

  return (
    <div className="space-y-9">
      <Group title="Engine" help="WebSearch in chats and sessions uses one engine for everyone on this hub. Each one below has a free allowance for personal use. Pick one to see how to get its key.">
        <SettingRow label="In use" help={inUseWords(s)}>
          {s.chosen !== 'auto' && (
            <Button size={size} busy={busy === 'auto' ? 'Saving' : false} onClick={() => void call('auto', () => api().setWebSearchSettings({ provider: 'auto' }))}>
              Choose automatically
            </Button>
          )}
        </SettingRow>
        <ul className="m-0 list-none space-y-1 p-0 py-3" aria-label="Search engines">
          {s.providers.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                aria-pressed={x.id === p.id}
                onClick={() => pick(x.id)}
                className={cn('w-full rounded-md px-3 py-2.5 text-left hover:bg-hover', x.id === p.id && 'bg-hover')}
              >
                <span className="text-[13.5px] font-medium text-fg phone:text-[15px]">{x.name}</span>
                {x.id === s.active && <span className="ml-2 text-[12px] text-ok">In use</span>}
                {x.keySet && <span className="ml-2 text-[12px] text-fg-3">Key saved</span>}
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
          <SettingRow
            label="Key"
            help={p.keySet ? (p.keyFrom === 'env' ? `Set in the hub environment (${p.env?.join(' or ')}).` : p.keyFrom === 'config' ? 'Set in config.json (search.apiKey).' : 'Set, stored on the hub.') : `Not set.${p.keyHint ? ` ${p.keyHint}.` : ''}`}
            top
          >
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              <Input mono type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.keySet ? 'Paste a new key' : 'API key'} aria-label={`${p.name} API key`} className="w-[200px]!" size="sm" />
              <Button size={size} onClick={() => void paste()}>
                Paste
              </Button>
              <Button
                variant="solid"
                size={size}
                disabled={!key.trim()}
                busy={busy === 'key' ? 'Saving' : false}
                onClick={async () => {
                  if (await call('key', () => api().setWebSearchKey(p.id, key.trim()))) setKey('');
                }}
              >
                Save
              </Button>
              {p.keySet && p.keyFrom === 'hub' && (
                <Button variant="danger" size={size} busy={busy === 'rmkey' ? 'Removing' : false} onClick={() => void call('rmkey', () => api().setWebSearchKey(p.id, null))}>
                  Remove
                </Button>
              )}
            </div>
          </SettingRow>
        )}
        {p.needs === 'url' && (
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
        <SettingRow label="Use it" help={s.chosen === p.id ? 'WebSearch uses this engine.' : 'Make WebSearch always use this engine.'}>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Button size={size} busy={busy === 'test' ? 'Testing' : false} onClick={() => void runTest()}>
              Test
            </Button>
            {s.chosen !== p.id && (
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
    </div>
  );
}
