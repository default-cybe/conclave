/**
 * Extensions > Discover (docs/design/ECOSYSTEM.md section 3). Tools, skills,
 * plugins, subagents, commands, MCP servers, hook recipes and routines from
 * GitHub, with name, owner, stars, description and an Add button.
 *
 * With no search text: Recommended (the owner's picks first, then by rank),
 * then More by stars. Both come from the hub's local data, so they show with
 * no network. With search text: live GitHub and MCP registry results through
 * the hub, curated matches first, with "Load more" at the end.
 *
 * URL: /extensions/discover?kind=&q=&category=&item=<id>
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useHub, toast } from '@/store/store';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { hhmm, plural, shortDate } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Dialog, Sheet } from '@/components/ui/Overlay';
import { Notice, SectionHeading, TextAction } from '@/components/ui/Section';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { DiscoverRow } from './discover/Row';
import { PreviewSheet, type SheetTarget } from './discover/Preview';
import { errText } from '@/features/settings/parts';
import type { CatalogCategory, CatalogItemDto, CatalogKind, CatalogPage, CatalogSearchResult, CatalogStatus, InstalledRef, RecipeTestResult } from '@conclave/core/client';
import { KIND_ORDER, KIND_PLURAL, KIND_PLURAL_LOWER, KIND_WORD, categoryWord, dayWords, localMatches } from './discover/words';
import { STARTER } from './hooks/recipe-words';

const PER_KIND = 4;
const MORE_SHOWN = 8;
/** The hub sends at most 200 items a page; shipped items come first, so one page holds every recommended item. */
const PAGE = 200;

const isKind = (k: string | null): k is CatalogKind => !!k && (KIND_ORDER as string[]).includes(k);

function sortCurated(a: CatalogItemDto, b: CatalogItemDto) {
  if (!!a.must !== !!b.must) return a.must ? -1 : 1;
  if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
  if (a.recommended && b.recommended) return (a.rank ?? 999) - (b.rank ?? 999) || (b.stars ?? 0) - (a.stars ?? 0);
  return (b.stars ?? 0) - (a.stars ?? 0);
}

export function DiscoverTab() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const mobile = useIsMobile();
  const params = new URLSearchParams(search);
  const kindParam = params.get('kind');
  const kind: CatalogKind | undefined = isKind(kindParam) ? kindParam : undefined;
  const category = (params.get('category') || undefined) as CatalogCategory | undefined;
  const urlQ = params.get('q') ?? '';
  const itemParam = params.get('item');

  const [q, setQ] = useState(urlQ);
  const [page, setPage] = useState<CatalogPage>();
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [found, setFound] = useState<CatalogSearchResult>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [status, setStatus] = useState<CatalogStatus>();
  const [target, setTarget] = useState<SheetTarget | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tokenOpen, setTokenOpen] = useState(false);
  const [catSheet, setCatSheet] = useState(false);
  const [starter, setStarter] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const searchSeq = useRef(0);

  const setParam = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const p = new URLSearchParams(search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') p.delete(k);
        else p.set(k, v);
      }
      const s = p.toString();
      navigate(`/extensions/discover${s ? `?${s}` : ''}`, { replace: true });
    },
    [search, navigate],
  );

  // the list: local data only (shipped, marketplaces, cache), so it shows offline
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api()
      .catalog({ ...(kind ? { kind } : {}), limit: PAGE })
      .then((r) => {
        if (!alive) return;
        setPage(r);
        setStatus(r.status);
        setLoadError(undefined);
      })
      .catch((e) => alive && setLoadError(errText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [kind, tick]);

  // live search, debounced; the hub caches each query for an hour
  const term = q.trim();
  useEffect(() => {
    if (term === urlQ) return;
    const t = setTimeout(() => setParam({ q: term || null }), 450);
    return () => clearTimeout(t);
  }, [term, urlQ, setParam]);
  useEffect(() => setQ((cur) => (cur.trim() === urlQ ? cur : urlQ)), [urlQ]);

  const runSearch = useCallback(
    async (pageNo: number) => {
      if (!urlQ) return;
      const seq = ++searchSeq.current;
      setSearching(true);
      try {
        const r = await api().catalogSearch({ q: urlQ, ...(kind ? { kind } : {}), page: pageNo });
        if (seq !== searchSeq.current) return;
        setFound((prev) => (pageNo > 1 && prev ? { ...r, items: [...prev.items, ...r.items.filter((x) => !prev.items.some((y) => y.id === x.id))] } : r));
        setSearchError(undefined);
      } catch (e) {
        if (seq === searchSeq.current) setSearchError(errText(e));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
      api().catalogStatus().then(setStatus).catch(() => undefined);
    },
    [urlQ, kind],
  );
  useEffect(() => {
    setFound(undefined);
    setSearchError(undefined);
    if (urlQ) void runSearch(1);
  }, [urlQ, kind, tick, runSearch]);

  // ?item=<id> opens that item (links from Routines and the palette)
  useEffect(() => {
    if (!itemParam) return;
    const seed = page?.items.find((x) => x.id === itemParam);
    setTarget((t) => (t?.id === itemParam ? t : { id: itemParam, mode: params.get('mode') === 'add' ? 'add' : 'detail', seed }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemParam, page]);

  // one row per id: a curated entry wins over a derived one with the same id (spec 1.3)
  const items = useMemo(() => {
    const seen = new Map<string, CatalogItemDto>();
    for (const x of page?.items ?? []) if (!seen.has(x.id) || (x.source === 'recommended' && seen.get(x.id)!.source !== 'recommended')) seen.set(x.id, x);
    return [...seen.values()].sort(sortCurated);
  }, [page]);
  const categories = useMemo(() => {
    if (!kind) return [];
    const seen = new Map<string, number>();
    for (const x of items) seen.set(x.category, (seen.get(x.category) ?? 0) + 1);
    return [...seen].sort((a, b) => b[1] - a[1]).map(([c]) => c as CatalogCategory);
  }, [items, kind]);
  const shown = category ? items.filter((x) => x.category === category) : items;
  const recommended = shown.filter((x) => x.recommended);
  const musts = recommended.filter((x) => x.must);
  const more = shown.filter((x) => !x.recommended);
  const starsAt = items.find((x) => x.starsAt)?.starsAt;
  // when live search fails, the saved list still answers (spec 3.6: never an empty page)
  const saved = useMemo(() => (urlQ ? localMatches(items, urlQ, kind).sort(sortCurated) : []), [items, urlQ, kind]);

  // the next page of saved results (marketplaces, the star index, earlier searches), by stars
  const loadMore = async () => {
    if (!page?.next || loadingMore) return;
    setLoadingMore(true);
    try {
      const from = page;
      const r = await api().catalog({ ...(kind ? { kind } : {}), limit: PAGE, cursor: page.next });
      // another kind or a reload replaced the list meanwhile: this page belongs to the old one
      setPage((p) => (p === from ? { ...r, items: [...p.items, ...r.items.filter((x) => !p.items.some((y) => y.id === x.id))] } : p));
    } catch (e) {
      toast({ title: `Could not load more: ${errText(e)}`, level: 'error' });
    } finally {
      setLoadingMore(false);
    }
  };

  const open = (item: CatalogItemDto, mode: SheetTarget['mode']) => {
    if (mode === 'add' && (item.kind === 'routine' || item.install.type === 'routine')) {
      const sid = item.install.type === 'routine' ? item.install.suggestion : item.id.replace(/^routine:/, '');
      navigate(`/routines?suggest=${encodeURIComponent(sid)}`);
      return;
    }
    setTarget({ id: item.id, mode, seed: item });
  };
  const close = () => {
    setTarget(null);
    if (itemParam) setParam({ item: null, mode: null });
  };
  const changed = (id: string, installed: InstalledRef | null) => {
    const patch = (x: CatalogItemDto) => (x.id === id ? { ...x, installed: installed ?? undefined, updateAvailable: false } : x);
    setPage((p) => (p ? { ...p, items: p.items.map(patch) } : p));
    setFound((f) => (f ? { ...f, items: f.items.map(patch) } : f));
  };

  // after "Install on the hub": this card at once, then every card, since one install (uv) can fix several
  const readyChanged = (id: string, ready: CatalogItemDto['ready']) => {
    const patch = (x: CatalogItemDto) => (x.id === id ? { ...x, ready } : x);
    setPage((p) => (p ? { ...p, items: p.items.map(patch) } : p));
    setFound((f) => (f ? { ...f, items: f.items.map(patch) } : f));
    api()
      .catalog({ ...(kind ? { kind } : {}), limit: Math.min(200, Math.max(PAGE, page?.items.length ?? 0)) })
      .then((r) => {
        const by = new Map(r.items.map((x) => [x.id, x.ready]));
        const again = (x: CatalogItemDto) => (x.id !== id && by.has(x.id) ? { ...x, ready: by.get(x.id)! } : x);
        setPage((p) => (p ? { ...p, items: p.items.map(again) } : p));
        setFound((f) => (f ? { ...f, items: f.items.map(again) } : f));
      })
      .catch(() => undefined);
  };

  const row = (x: CatalogItemDto, mark?: boolean) => (
    <DiscoverRow key={x.id} item={x} recommendedMark={mark} onOpen={(i) => open(i, 'detail')} onAdd={(i) => open(i, 'add')} onUpdate={(i) => open(i, 'update')} onReady={readyChanged} />
  );

  const kindLinks = (
    <KindLinks
      value={kind}
      onChange={(k) => {
        setExpanded({});
        setParam({ kind: k ?? null, category: null });
      }}
      phone={mobile}
    />
  );

  return (
    <div className="space-y-7 phone:space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="min-w-[240px] flex-1 phone:basis-full">
          <Input
            type="search"
            size="lg"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setParam({ q: q.trim() || null });
              if (e.key === 'Escape' && q) {
                e.preventDefault();
                setQ('');
                setParam({ q: null });
              }
            }}
            placeholder={`Search GitHub for ${kind ? KIND_PLURAL_LOWER[kind] : 'MCP servers, skills, plugins'}…`}
            aria-label="Search GitHub"
          />
          </div>
          {!mobile && <StatusLine status={status} onOpen={() => setTokenOpen(true)} />}
        </div>
        <div className="mt-3">{kindLinks}</div>
        {kind && categories.length > 1 && !urlQ && (
          <div className="mt-2">
            {mobile ? (
              <button type="button" onClick={() => setCatSheet(true)} className="tap text-[14px] font-medium text-fg-3 hover:text-fg">
                Category: <span className="text-fg">{category ? categoryWord(category) : 'All'}</span>
              </button>
            ) : (
              <div role="group" aria-label="Category" className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                {[undefined, ...categories].map((c) => {
                  const on = c === category;
                  return (
                    <button key={c ?? 'all'} type="button" aria-pressed={on} onClick={() => setParam({ category: c ?? null })} className={cn('whitespace-nowrap text-[12.5px] transition-colors duration-[var(--dur-1)]', on ? 'text-fg' : 'text-fg-3 hover:text-fg')}>
                      <span className={on ? 'underline decoration-1 underline-offset-[3px]' : undefined}>{c ? categoryWord(c) : 'All'}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {mobile && <StatusLine status={status} onOpen={() => setTokenOpen(true)} className="mt-2.5" />}
      </div>

      {loadError && (
        <Notice tone="fault" action={{ label: 'Retry', onClick: () => setTick((t) => t + 1) }}>
          {`Failed. Could not load the catalog: ${loadError}`}
        </Notice>
      )}

      {urlQ ? (
        <SearchResults
          q={urlQ}
          kind={kind}
          found={found}
          saved={saved}
          searching={searching}
          error={searchError}
          onRetry={() => setTick((t) => t + 1)}
          onAllKinds={() => setParam({ kind: null })}
          onMore={() => void runSearch((found?.page ?? 1) + 1)}
          row={row}
        />
      ) : (
        <>
          <LoadingRows loading={loading && !page} rows={6} />
          {page && (
            <section aria-labelledby="disc-rec-h">
              <SectionHeading
                id="disc-rec-h"
                count={recommended.length}
                right={kind === 'hook' ? <TextAction label="Add the starter set" onClick={() => setStarter(true)} /> : undefined}
              >
                Recommended
              </SectionHeading>
              <p className="m-0 border-b border-rule py-2.5 text-[12.5px] leading-[1.45] text-fg-3 phone:text-[13px]">
                Picked for your setup.{starsAt ? ` Stars as of ${dayWords(starsAt)}.` : ''}
              </p>
              {recommended.length === 0 ? (
                <p className="m-0 py-3 text-[14px] text-fg-2">
                  Nothing recommended here{category ? ` in ${categoryWord(category)}` : ''}.{' '}
                  {category && (
                    <button type="button" className="link" onClick={() => setParam({ category: null })}>
                      Show all categories
                    </button>
                  )}
                </p>
              ) : kind ? (
                <div className="rows">{recommended.map((x) => row(x))}</div>
              ) : (
                <>
                  <div className="rows">{musts.map((x) => row(x))}</div>
                  {KIND_ORDER.map((k) => {
                    const list = recommended.filter((x) => x.kind === k && !x.must);
                    if (!list.length) return null;
                    return (
                      <div key={k} className="mt-5">
                        <h3 className="flex items-baseline gap-2 border-b border-rule pb-2 text-[12.5px] font-medium text-fg-2 phone:text-[13.5px]">
                          {KIND_PLURAL[k]}
                          <span className="num font-[450] text-fg-3">{list.length}</span>
                        </h3>
                        <div className="rows">{list.slice(0, PER_KIND).map((x) => row(x))}</div>
                        {list.length > PER_KIND && (
                          <TextAction className="mt-1.5 inline-block" label={`Show all ${list.length}`} onClick={() => setParam({ kind: k })} />
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </section>
          )}
          {page && more.length > 0 && (
            <section aria-labelledby="disc-more-h">
              <SectionHeading id="disc-more-h" count={`${more.length}${page.next ? '+' : ''}`}>
                More
              </SectionHeading>
              <div className="rows">{(expanded.more ? more : more.slice(0, MORE_SHOWN)).map((x) => row(x))}</div>
              {more.length > MORE_SHOWN && !expanded.more && (
                <TextAction className="mt-1.5 inline-block" label={page.next ? `Show ${more.length} more` : `Show all ${more.length}`} onClick={() => setExpanded((e) => ({ ...e, more: true }))} />
              )}
              {(expanded.more || more.length <= MORE_SHOWN) && page.next && (
                <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className="tap mt-3 text-[13px] font-medium text-fg-2 hover:text-fg disabled:text-fg-3 phone:text-[14px]">
                  {loadingMore ? 'Loading' : 'Load more'}
                </button>
              )}
            </section>
          )}
          {page && (
            <p className="m-0 text-[12.5px] leading-[1.5] text-fg-3 phone:text-[13px]">
              Not here? Search GitHub above, or add a{' '}
              <button type="button" className="link" onClick={() => navigate('/extensions/plugins?view=marketplace')}>
                plugin marketplace
              </button>{' '}
              or an{' '}
              <button type="button" className="link" onClick={() => navigate('/extensions/mcp?add=1')}>
                MCP server by hand
              </button>
              .
            </p>
          )}
        </>
      )}

      <PreviewSheet target={target} onClose={close} onChanged={changed} onReady={readyChanged} />
      <TokenDialog open={tokenOpen} onClose={() => setTokenOpen(false)} onSaved={(s) => setStatus(s)} status={status} />
      <CategorySheet
        open={catSheet}
        onClose={() => setCatSheet(false)}
        value={category}
        options={categories}
        onPick={(c) => {
          setCatSheet(false);
          setParam({ category: c ?? null });
        }}
      />
      <StarterDialog open={starter} onClose={() => setStarter(false)} items={items} onDone={() => setTick((t) => t + 1)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kind links: text links, the current one fg with the 1px underline. Phones
// scroll them sideways instead of wrapping.
// ---------------------------------------------------------------------------

function KindLinks({ value, onChange, phone }: { value?: CatalogKind; onChange: (k?: CatalogKind) => void; phone: boolean }) {
  const opts: Array<{ v?: CatalogKind; label: string }> = [{ label: 'All' }, ...KIND_ORDER.map((k) => ({ v: k, label: KIND_PLURAL[k] }))];
  const row = useRef<HTMLDivElement>(null);
  // phones: keep the picked kind in view in the sideways row
  useEffect(() => {
    const el = row.current;
    const on = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!phone || !el || !on) return;
    const left = on.offsetLeft - el.offsetLeft;
    if (left < el.scrollLeft || left + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, left - 16);
  }, [value, phone]);
  return (
    <div ref={row} role="group" aria-label="Kind" className={cn('flex items-baseline gap-x-4', phone ? 'no-scrollbar -mx-4 overflow-x-auto px-4 whitespace-nowrap' : 'flex-wrap gap-y-1')}>
      {opts.map((o) => {
        const on = o.v === value;
        return (
          <button
            key={o.label}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.v)}
            className={cn('shrink-0 whitespace-nowrap text-[13px] font-medium transition-colors duration-[var(--dur-1)] phone:py-2.5 phone:text-[14px]', on ? 'text-fg' : 'text-fg-3 hover:text-fg')}
          >
            <span className={on ? 'underline decoration-1 underline-offset-[3px]' : undefined}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

function SearchResults({
  q,
  kind,
  found,
  saved,
  searching,
  error,
  onRetry,
  onAllKinds,
  onMore,
  row,
}: {
  q: string;
  kind?: CatalogKind;
  found?: CatalogSearchResult;
  /** Matches from the list Discover already has, for when live search fails. */
  saved: CatalogItemDto[];
  searching: boolean;
  error?: string;
  onRetry: () => void;
  onAllKinds: () => void;
  onMore: () => void;
  row: (x: CatalogItemDto, mark?: boolean) => ReactNode;
}) {
  const items = (found?.items ?? []).filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
  const curated = items.filter((x) => x.source === 'recommended' || x.source === 'recipe' || x.source === 'suggestion');
  const live = items.filter((x) => !curated.includes(x));
  const from = (found?.from ?? []).filter((f) => f !== 'cache');
  return (
    <section aria-labelledby="disc-res-h" aria-busy={searching}>
      <SectionHeading id="disc-res-h" count={found ? items.length + (found.more ? '+' : '') : undefined} right={searching ? <span className="text-signal">Searching</span> : undefined}>
        Results for "{q}"
      </SectionHeading>
      {found?.note && <p className="m-0 border-b border-rule py-2.5 text-[12.5px] leading-[1.45] text-fg-3 phone:text-[13px]">{found.note}</p>}
      {!found?.note && found && from.length > 0 && (
        <p className="m-0 border-b border-rule py-2.5 text-[12.5px] leading-[1.45] text-fg-3 phone:text-[13px]">
          From {from.map((f) => (f === 'github' ? 'GitHub' : f === 'mcp-registry' ? 'the MCP registry' : 'your marketplaces')).join(', ').replace(/, ([^,]*)$/, ' and $1')}.
          {curated.length > 0 ? ' Recommended matches first.' : ''}
        </p>
      )}
      {error && (
        <Notice tone="fault" className="mt-3" action={{ label: 'Retry', onClick: onRetry }}>
          {`${/reach|network|fetch|offline|ENOTFOUND|ECONN|timed out/i.test(error) ? "Failed. Can't reach GitHub from the hub." : `Failed. ${error}`}${
            found ? '' : saved.length ? ` Showing ${saved.length === 1 ? 'the one match' : `${saved.length} matches`} from the saved list.` : ' Nothing in the saved list matches either.'
          }`}
        </Notice>
      )}
      {error && !found && saved.length > 0 && <div className="rows">{saved.map((x) => row(x, true))}</div>}
      <LoadingRows loading={searching && !found} rows={5} />
      {found && items.length === 0 && (
        <EmptyState wave={false}>
          Nothing on GitHub matches "{q}"{kind ? ` as ${kind === 'mcp' ? 'an' : 'a'} ${KIND_WORD[kind]}` : ''}.{' '}
          {kind ? (
            <button type="button" className="link" onClick={onAllKinds}>
              Try all kinds.
            </button>
          ) : (
            'Try fewer words, or the name of the repo.'
          )}
        </EmptyState>
      )}
      <div className="rows">
        {curated.map((x) => row(x, true))}
        {live.map((x) => row(x))}
      </div>
      {found?.more && (
        <button type="button" disabled={searching} onClick={onMore} className="tap mt-3 text-[13px] font-medium text-fg-2 hover:text-fg disabled:text-fg-3 phone:text-[14px]">
          {searching ? 'Loading' : 'Load more'}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Status line and the token dialog
// ---------------------------------------------------------------------------

function statusWords(s: CatalogStatus | undefined): { text: string; tone?: 'warn' } | null {
  if (!s) return null;
  const gh = s.sources.find((x) => x.id === 'github');
  if (s.offline || (gh?.lastError && /reach|network|fetch|offline|ENOTFOUND|ECONN|timed out/i.test(gh.lastError))) {
    return { text: `Offline: saved results${s.lastRefresh ? ` from ${shortDate(s.lastRefresh)}` : ''}` };
  }
  const g = s.github;
  const until = g.blockedUntil && g.blockedUntil > Date.now() ? g.blockedUntil : g.remaining <= 0 && g.resetAt ? g.resetAt : 0;
  if (until) return { text: `GitHub: limit reached until ${hhmm(until)}`, tone: 'warn' };
  if (g.authenticated) return { text: `GitHub: signed in, ${g.remaining.toLocaleString('en')} left` };
  return { text: `GitHub: ${g.remaining} of ${g.limit} calls left this hour`, tone: g.remaining < 10 ? 'warn' : undefined };
}

function StatusLine({ status, onOpen, className }: { status?: CatalogStatus; onOpen: () => void; className?: string }) {
  const w = statusWords(status);
  if (!w) return null;
  return (
    <button type="button" onClick={onOpen} className={cn('tap shrink-0 text-left text-[12.5px] transition-colors duration-[var(--dur-1)] hover:text-fg phone:text-[13px]', w.tone === 'warn' ? 'text-warn' : 'text-fg-3', className)}>
      {w.text}
    </button>
  );
}

const TOKEN_KEY = 'catalog.github-token';
/** One empty list, so the store selector returns the same value while secrets are not loaded. */
const NO_SECRETS: string[] = [];

function TokenDialog({ open, onClose, onSaved, status }: { open: boolean; onClose: () => void; onSaved: (s: CatalogStatus) => void; status?: CatalogStatus }) {
  const mobile = useIsMobile();
  const saved = useHub((s) => s.secrets?.values ?? NO_SECRETS);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'saving' | 'removing' | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setValue('');
      setError(undefined);
    }
  }, [open]);
  const own = saved.includes(TOKEN_KEY);
  const shared = !own && saved.includes('github-pat');
  const g = status?.github;
  const sources = (status?.sources ?? []).filter((s) => s.id !== 'github');

  const save = async (v: string | null) => {
    setBusy(v ? 'saving' : 'removing');
    setError(undefined);
    try {
      await api().setSecret('values', TOKEN_KEY, v);
      useHub.setState((s) => ({ secrets: s.secrets ? { ...s.secrets, values: v ? [...new Set([...s.secrets.values, TOKEN_KEY])] : s.secrets.values.filter((k) => k !== TOKEN_KEY) } : s.secrets }));
      const st = await api().catalogRefresh('github').catch(() => api().catalogStatus());
      onSaved(st);
      toast({ title: v ? 'GitHub token saved. Discover uses it from now on.' : 'GitHub token removed.', level: 'success' });
      onClose();
    } catch (e) {
      setError(`${errText(e)} Check the token, then try again.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="GitHub limit"
      width={520}
      footer={
        <>
          {own && (
            <Button variant="danger" size={mobile ? 'touch' : 'md'} busy={busy === 'removing' ? 'Removing' : false} onClick={() => void save(null)}>
              Remove token
            </Button>
          )}
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!value.trim()} busy={busy === 'saving' ? 'Saving' : false} onClick={() => void save(value.trim())}>
            Save
          </Button>
        </>
      }
    >
      <p className="m-0 leading-[1.5]">
        {g
          ? g.authenticated
            ? `Discover is signed in to GitHub: ${g.remaining.toLocaleString('en')} of ${g.limit.toLocaleString('en')} calls left this hour${g.resetAt ? `, resets at ${hhmm(g.resetAt)}` : ''}.`
            : `Without a token GitHub allows ${g.limit} calls an hour. ${g.remaining} are left${g.resetAt ? `, and the count resets at ${hhmm(g.resetAt)}` : ''}.`
          : 'GitHub allows 60 calls an hour without a token.'}{' '}
        Add a GitHub token to raise the limit to 5,000 an hour. A fine-grained token with no extra scopes is enough for public repos.
      </p>
      {shared && (
        <p className="m-0 mt-2 leading-[1.5] text-fg-3">
          Discover already uses <span className="mono">github-pat</span>, the GitHub MCP server's token. Save one here to use a separate token.
        </p>
      )}
      <Field label="GitHub token" className="mt-4" error={error} help={<>Saved in the hub's secrets store as <span className="mono">{TOKEN_KEY}</span>. It is never shown again or logged.</>}>
        <Input type="password" mono autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={own ? 'Saved. Paste a new one to replace it' : 'github_pat_…'} />
      </Field>
      {sources.length > 0 && (
        <div className="mt-5">
          <div className="border-b border-rule-2 pb-2 text-[13px] font-semibold text-fg">Sources</div>
          {sources.map((s) => (
            <div key={s.id} className="flex items-baseline gap-3 border-b border-rule py-2 text-[13px] last:border-b-0 phone:text-[14px]">
              <span className="min-w-0 flex-1 text-fg">{s.label}</span>
              <span className={cn('shrink-0', s.lastError ? 'text-fault' : 'text-fg-3')}>{s.lastError ? 'failed' : !s.on ? 'off' : `${s.items.toLocaleString('en')} ${s.items === 1 ? 'item' : 'items'}${s.lastFetch ? `, ${shortDate(s.lastFetch)}` : ''}`}</span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Phone category sheet
// ---------------------------------------------------------------------------

function CategorySheet({ open, onClose, value, options, onPick }: { open: boolean; onClose: () => void; value?: CatalogCategory; options: CatalogCategory[]; onPick: (c?: CatalogCategory) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Category">
      <div className="pb-2">
        {[undefined, ...options].map((c) => {
          const on = c === value;
          return (
            <button key={c ?? 'all'} type="button" onClick={() => onPick(c)} className={cn('flex h-11 w-full items-center px-4 text-left text-[15px] hover:bg-hover', on ? 'font-medium text-fg' : 'text-fg-2')} aria-pressed={on}>
              <span className={on ? 'underline decoration-1 underline-offset-[3px]' : undefined}>{c ? categoryWord(c) : 'All'}</span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Hook starter set: eight recipes that need only bash and jq
// ---------------------------------------------------------------------------

function StarterDialog({ open, onClose, items, onDone }: { open: boolean; onClose: () => void; items: CatalogItemDto[]; onDone: () => void }) {
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const [results, setResults] = useState<Array<{ id: string; name: string; ok: boolean; tests?: RecipeTestResult[]; error?: string }>>();
  const list = STARTER.map((rid) => items.find((x) => x.install.type === 'hook' && x.install.recipe === rid) ?? items.find((x) => x.id === `hook:${rid}`)).filter((x): x is CatalogItemDto => !!x);
  const todo = list.filter((x) => !x.installed);
  useEffect(() => {
    if (open) {
      setResults(undefined);
      setAt(0);
    }
  }, [open]);

  const run = async () => {
    setBusy(true);
    const out: NonNullable<typeof results> = [];
    for (let i = 0; i < todo.length; i++) {
      const x = todo[i];
      setAt(i);
      const rid = x.install.type === 'hook' ? x.install.recipe : x.id.replace(/^hook:/, '');
      try {
        const r = await api().installHookRecipe(rid, { scope: 'user' });
        out.push({ id: x.id, name: x.name, ok: r.tests.every((t) => t.ok), tests: r.tests });
      } catch (e) {
        out.push({ id: x.id, name: x.name, ok: false, error: errText(e) });
      }
      setResults([...out]);
    }
    setBusy(false);
    onDone();
  };

  const tests = results?.flatMap((r) => r.tests ?? []) ?? [];
  const passed = tests.filter((t) => t.ok).length;
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Add the starter set"
      width={560}
      footer={
        results && !busy ? (
          <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="solid" size={mobile ? 'touch' : 'md'} busy={busy ? 'Adding' : false} disabled={!todo.length} onClick={() => void run()}>
              {todo.length ? `Add ${plural(todo.length, 'recipe')}` : 'All added'}
            </Button>
          </>
        )
      }
    >
      <p className="m-0 leading-[1.5]">Eight hook recipes that guard git work, secrets, Proxmox and MCP writes, and trim test output. Each needs only bash and jq, runs on this hub for every session, and runs its own tests once it is added.</p>
      <div className="mt-3">
        {list.map((x) => {
          const r = results?.find((y) => y.id === x.id);
          const word = x.installed && !r ? 'added' : r ? (r.ok ? (r.tests?.length ? `${r.tests.filter((t) => t.ok).length} of ${r.tests.length} passed` : 'added') : 'failed') : busy && todo[at]?.id === x.id ? 'adding' : '';
          return (
            <div key={x.id} className="flex items-baseline gap-3 border-b border-rule py-2 last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{x.name}</span>
                {r?.error && <span className="block text-[12px] text-fault phone:text-[13px]">{r.error}</span>}
                {!r && (x.ready?.missing.length ?? 0) > 0 && <span className="block text-[12px] text-warn phone:text-[13px]">Needs {x.ready.missing.map((n) => n.bin).join(' and ')} on the hub.</span>}
              </span>
              <span className={cn('shrink-0 text-[12.5px] phone:text-[13px]', word === 'failed' ? 'text-fault' : word === 'adding' ? 'text-signal' : 'text-fg-3')}>{word}</span>
            </div>
          );
        })}
      </div>
      {results && !busy && tests.length > 0 && (
        <p className={cn('m-0 mt-3', passed === tests.length ? 'text-ok' : 'text-fault')}>{`${passed} of ${tests.length} tests passed.`}</p>
      )}
    </Dialog>
  );
}
