/**
 * Marketplace: search every added marketplace, filter by category,
 * marketplace and installed, install with a preview and a warning, and add
 * a marketplace from owner/repo, a git URL or a path on the hub.
 */
import { useEffect, useMemo, useState } from 'react';
import type { MarketplaceSearchItem, MarketplaceSearchResult } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast } from '@/store/store';
import { useDelayed, useIsMobile } from '@/lib/hooks';
import { plural } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { Dialog } from '@/components/ui/Overlay';
import { KV, Notice, SectionHeading } from '@/components/ui/Section';
import { FilterLinks } from '@/components/ui/Tags';
import { LoadingRows } from '@/components/ui/EmptyState';
import { StateWord } from '@/components/ui/List';
import { kindWords, marketplaceErrorHint, marketplaceSourceError } from './parts';
import { errText } from '@/features/settings/parts';

type Have = 'all' | 'installed' | 'available';

export function Marketplace({ onInstalled, onOpen, version }: { onInstalled: (name: string) => void; onOpen: (name: string) => void; version: number }) {
  const mobile = useIsMobile();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  const [market, setMarket] = useState('');
  const [have, setHave] = useState<Have>('all');
  const [data, setData] = useState<MarketplaceSearchResult>();
  const [facets, setFacets] = useState<{ categories: string[]; total: number }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const [installing, setInstalling] = useState<MarketplaceSearchItem | null>(null);
  const slow = useDelayed(loading && !data, 1500);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);

  // categories come from the unfiltered list
  useEffect(() => {
    let alive = true;
    api()
      .searchMarketplace({})
      .then((r) => {
        if (!alive) return;
        const cats = [...new Set(r.results.map((x) => x.category).filter((c): c is string => !!c))].sort();
        setFacets({ categories: cats, total: r.results.length });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tick, version]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api()
      .searchMarketplace({ ...(debounced ? { q: debounced } : {}), ...(category ? { category } : {}), ...(market ? { marketplace: market } : {}) })
      .then((r) => {
        if (!alive) return;
        setData(r);
        setError(undefined);
      })
      .catch((e) => alive && setError(errText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [debounced, category, market, tick, version]);

  const results = useMemo(() => (data?.results ?? []).filter((r) => (have === 'all' ? true : have === 'installed' ? r.installed : !r.installed)), [data, have]);
  const installedCount = (data?.results ?? []).filter((r) => r.installed).length;
  const filtered = !!(debounced || category || market || have !== 'all');

  return (
    <div className="space-y-7 phone:space-y-8">
      <section aria-labelledby="mkt-h">
        <SectionHeading id="mkt-h" count={data ? (filtered ? `${results.length} of ${facets?.total ?? data.results.length}` : data.results.length) : undefined}>
          Plugins in your marketplaces
        </SectionHeading>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search names, descriptions and categories"
            aria-label="Search plugins"
            boxClassName="min-w-[220px] flex-1 phone:basis-full"
          />
          <SelectMenu
            look="text"
            prefix="Category"
            label="Category"
            value={category}
            onChange={setCategory}
            width={220}
            options={[{ value: '', label: 'All', text: 'All' }, ...(facets?.categories ?? []).map((c) => ({ value: c, label: c, text: c }))]}
            className="phone:h-11"
          />
          <SelectMenu
            look="text"
            prefix="Marketplace"
            label="Marketplace"
            value={market}
            onChange={setMarket}
            width={280}
            options={[{ value: '', label: 'All', text: 'All' }, ...(data?.marketplaces ?? []).map((m) => ({ value: m.name, label: m.name, text: m.name, hint: <span className="num">{m.plugins}</span> }))]}
            className="phone:h-11"
          />
        </div>
        <FilterLinks
          className="mt-3"
          label="Installed"
          value={have}
          onChange={setHave}
          options={[
            { value: 'all', label: 'All' },
            { value: 'installed', label: 'Installed', count: installedCount },
            { value: 'available', label: 'Not installed' },
          ]}
        />

        {error && (
          <Notice tone="fault" className="mt-3" action={{ label: 'Retry', onClick: () => setTick((t) => t + 1) }}>
            {`Failed. Could not search the marketplaces: ${error} Check the hub's network, then retry.`}
          </Notice>
        )}
        <LoadingRows loading={loading && !data} rows={5} className="mt-2" />
        {slow && <p className="mt-2 text-[13px] text-fg-3">Fetching the marketplace list. The first search on a new hub clones it, which can take a minute.</p>}

        {data && results.length === 0 && (
          <p className="mt-4 text-[14px] leading-[1.45] text-fg-2">
            {filtered ? 'No plugins match. Clear the search or pick another category or marketplace.' : 'No plugins in your marketplaces yet. Add a marketplace below.'}
          </p>
        )}
        <div className={cn('rows mt-2', loading && data && 'opacity-100')} aria-busy={loading}>
          {results.map((r) => (
            <div key={`${r.marketplace}:${r.name}`} className="flex items-start gap-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="t-row truncate text-fg">{r.name}</span>
                  {r.version && <span className="shrink-0 font-mono text-[11.5px] text-fg-3">{r.version}</span>}
                </div>
                {r.description && <p className="m-0 mt-0.5 line-clamp-2 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">{r.description}</p>}
                <div className="mt-1 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">{[r.category, r.marketplace, kindWords(r.sourceKind)].filter(Boolean).join(', ')}</div>
              </div>
              <div className="shrink-0 pt-0.5 text-right">
                {r.installed ? (
                  <button type="button" onClick={() => onOpen(r.name)} className="tap text-[13px] hover:text-fg phone:text-[14px]">
                    <StateWord tone="dim">{r.enabled ? 'installed' : 'installed, off'}</StateWord>
                  </button>
                ) : (
                  <Button variant="outline" size={mobile ? 'touch' : 'sm'} onClick={() => setInstalling(r)}>
                    Install
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <AddMarketplace marketplaces={data?.marketplaces ?? []} onAdded={() => setTick((t) => t + 1)} />

      <InstallDialog
        item={installing}
        onClose={() => setInstalling(null)}
        onDone={(name) => {
          setTick((t) => t + 1);
          onInstalled(name);
        }}
      />
    </div>
  );
}

function InstallDialog({ item, onClose, onDone }: { item: MarketplaceSearchItem | null; onClose: () => void; onDone: (name: string) => void }) {
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setError(undefined);
    setBusy(false);
  }, [item]);
  const install = async () => {
    if (!item) return;
    setBusy(true);
    setError(undefined);
    try {
      const p = await api().installPlugin(item.install);
      toast({ title: `${p.name} installed.`, level: 'success' });
      onClose();
      onDone(p.name);
    } catch (e) {
      setError(`${errText(e)} Check that the hub can reach the marketplace, then try again.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      title={item ? `Install ${item.name}?` : ''}
      width={560}
      footer={
        <>
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} busy={busy ? 'Installing' : false} onClick={() => void install()}>
            Install
          </Button>
        </>
      }
    >
      {item && (
        <>
          {item.description && <p className="m-0 text-[14px] leading-[1.5] text-fg-2">{item.description}</p>}
          <dl className="m-0 mt-3">
            <KV k="Marketplace">{item.marketplace}</KV>
            {item.category && <KV k="Category">{item.category}</KV>}
            {item.version && <KV k="Version">{item.version}</KV>}
            <KV k="Comes from">{kindWords(item.sourceKind)}</KV>
            <KV k="Installs" mono>
              {item.install}
            </KV>
          </dl>
          <p className="mt-4 mb-0 border-t border-rule pt-3 text-[13px] leading-[1.5] text-warn phone:text-[14px]">
            A plugin can add hooks and MCP servers. Hooks run commands on the hub at session events, and MCP servers start programs on the hub. Install only plugins you trust.
          </p>
          <p className="mt-2 mb-0 text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">After the install you see exactly what it added, and you can turn it off there.</p>
          {error && (
            <p className="mt-3 mb-0 text-[13px] leading-[1.5] text-fg-2">
              <span className="text-fault">Failed.</span> {error}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}

function AddMarketplace({ marketplaces, onAdded }: { marketplaces: Array<{ name: string; plugins: number }>; onAdded: () => void }) {
  const mobile = useIsMobile();
  const [src, setSrc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const local = marketplaceSourceError(src);
  return (
    <section aria-labelledby="addmkt-h">
      <SectionHeading id="addmkt-h">Add a marketplace</SectionHeading>
      <p className="mt-2.5 mb-0 max-w-[64ch] text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
        A repo or folder with <span className="mono">.claude-plugin/marketplace.json</span>, the format Claude Code and Codex use.
        {marketplaces.length > 0 && (
          <>
            {' '}
            Added: {marketplaces.map((m, i) => (
              <span key={m.name}>
                {m.name} ({plural(m.plugins, 'plugin')}){i < marketplaces.length - 1 ? ', ' : '.'}
              </span>
            ))}
          </>
        )}
      </p>
      <form
        className="mt-3 flex flex-wrap items-start gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const s = src.trim();
          if (!s || local) return;
          setBusy(true);
          setError(undefined);
          try {
            await api().addMarketplace(s);
            setSrc('');
            toast({ title: 'Marketplace added. Its plugins are in the list now.', level: 'success' });
            onAdded();
          } catch (err) {
            const m = errText(err).replace(/\s+/g, ' ');
            setError(`${m} ${marketplaceErrorHint(m)}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Source" className="min-w-[240px] flex-1" error={local ?? error} help="owner/repo, a git URL, or a path on the hub.">
          <Input mono value={src} onChange={(e) => setSrc(e.target.value)} placeholder="anthropics/skills" />
        </Field>
        <Button type="submit" variant="outline" size={mobile ? 'touch' : 'md'} className="mt-[22px] h-[34px] phone:mt-[25px] phone:h-11" disabled={!src.trim() || !!local} busy={busy ? 'Adding' : false}>
          Add
        </Button>
      </form>
    </section>
  );
}
