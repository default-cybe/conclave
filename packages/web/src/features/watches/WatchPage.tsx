/**
 * A watch's page (the Items tab of /routines/:id for a watch): one line on
 * how many are listed and what the last run changed, filter links (All,
 * New, Price changes, Still there, Gone), then the items: a photo, the
 * price (the old one struck when it moved), the item's state word, title,
 * place and fields, when it was first and last seen, its history and a link
 * to the listing. Desktops get a grid, phones a list with the photo on the
 * left. Edit filters opens the filters dialog.
 */
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Routine } from '@conclave/core/types';
import type { BrowserProfileDto, WatchDetailDto, WatchFilters, WatchItem, WatchSpec } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { dayStart } from '@/lib/schedule';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Overlay';
import { Field, Input, Segmented, Select } from '@/components/ui/Field';
import { FilterLinks } from '@/components/ui/Tags';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { StateWord, STATE_TEXT } from '@/components/ui/List';
import { useWatch } from './data';
import { Photo } from './Photo';
import { MARK_TONE, chipWords, countWords, dayWords, factsWords, filterItems, historyWords, priceWords, seenWords, specWords, wasPrice, type ItemFilter } from './words';

export function WatchItemsTab({ routine, onEdit }: { routine: Routine; onEdit: () => void }) {
  const { data, error } = useWatch(routine.id);
  const [filter, setFilter] = useState<ItemFilter>('all');
  if (error && !data) return <p className="py-4 text-[13px] text-fault">Could not load the items. {error}</p>;
  if (!data) return <LoadingRows loading rows={4} />;
  const counts: Record<ItemFilter, number> = {
    all: data.items.length,
    new: filterItems(data.items, 'new').length,
    price: filterItems(data.items, 'price').length,
    still: filterItems(data.items, 'still').length,
    gone: filterItems(data.items, 'gone').length,
  };
  const shown = filterItems(data.items, filter);
  return (
    <section aria-labelledby="items-h">
      <h2 id="items-h" className="sr-only">
        Items
      </h2>
      <Summary data={data} onEdit={onEdit} />
      {data.items.length === 0 ? (
        <EmptyState wave={false}>Nothing yet. The first run keeps what it finds, and the runs after it say what changed.</EmptyState>
      ) : (
        <>
          <FilterLinks<ItemFilter>
            label="Show"
            className="mt-5 mb-4"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: counts.all },
              { value: 'new', label: 'New', count: counts.new },
              { value: 'price', label: 'Price changes', count: counts.price },
              { value: 'still', label: 'Still there', count: counts.still },
              { value: 'gone', label: 'Gone', count: counts.gone },
            ]}
          />
          {shown.length ? <Items items={shown} routineId={routine.id} spec={data.spec} /> : <p className="py-3 text-[13px] text-fg-3 phone:text-[14px]">None right now.</p>}
        </>
      )}
    </section>
  );
}

/** "14 listed. Last run today 09:00: 3 new, 1 gone, 1 price drop." and the filters in words. */
function Summary({ data, onEdit }: { data: WatchDetailDto; onEdit: () => void }) {
  const last = data.last;
  const filters = specWords(data.spec);
  const when = last ? (last.at >= dayStart(Date.now()) ? `today ${hhmm(last.at)}` : `${dayWords(last.at)} ${hhmm(last.at)}`) : undefined;
  return (
    <div className="space-y-1">
      <p className="text-[14px] leading-[1.5] text-fg phone:text-[15px]">
        <span className="num">{data.count}</span> listed.{' '}
        {last ? (
          <>
            Last run {when}: <span className={cn(countWords(last.counts) === 'No change' ? 'text-fg-2' : 'text-fg')}>{countWords(last.counts)}</span>.
          </>
        ) : (
          <span className="text-fg-2">No run yet.</span>
        )}
      </p>
      <p className="text-[12.5px] leading-[1.45] text-fg-3 phone:text-[13.5px]">
        {filters ? `Filters: ${filters}. ` : 'No filters. '}
        {data.spec.notify === 'daily' ? 'A summary after every run.' : 'A message only when something changes.'}{' '}
        <button type="button" onClick={onEdit} className="link text-fg-2 hover:text-fg">
          Edit filters
        </button>
      </p>
    </div>
  );
}

function Items({ items, routineId, spec }: { items: WatchItem[]; routineId: string; spec: WatchSpec }) {
  const phone = useIsMobile();
  if (phone)
    return (
      <ul className="m-0 list-none divide-y divide-rule border-y border-rule p-0" aria-label="Items">
        {items.map((i) => (
          <li key={i.id} className="py-3">
            <ItemRow item={i} routineId={routineId} spec={spec} />
          </li>
        ))}
      </ul>
    );
  return (
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-x-5 gap-y-7 p-0" aria-label="Items">
      {items.map((i) => (
        <li key={i.id} className="min-w-0">
          <ItemTile item={i} routineId={routineId} spec={spec} />
        </li>
      ))}
    </ul>
  );
}

function PriceLine({ item, spec }: { item: WatchItem; spec: WatchSpec }) {
  const was = wasPrice(item);
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className={cn('t-row font-[540]', item.present ? 'text-fg' : 'text-fg-3')}>{priceWords(item.price, item.priceText, spec.currency)}</span>
      {was !== undefined && <s className="num text-[12px] text-fg-3 phone:text-[13px]">{priceWords(was, undefined, spec.currency)}</s>}
      <StateWord tone={MARK_TONE[item.mark]} className="ml-auto text-[12px] phone:text-[13px]">
        {chipWords(item)}
      </StateWord>
    </span>
  );
}

function ItemTile({ item, routineId, spec }: { item: WatchItem; routineId: string; spec: WatchSpec }) {
  const facts = factsWords(item, spec.fields);
  return (
    <article className="min-w-0" aria-label={item.title} data-watch-item={item.id}>
      <Photo source={item.image ? { routineId, itemId: item.id } : undefined} alt={item.title} className="rounded-[var(--r-2)]" dim={!item.present} />
      <div className="mt-2">
        <PriceLine item={item} spec={spec} />
        <p className={cn('mt-0.5 line-clamp-2 text-[13px] leading-[1.4]', item.present ? 'text-fg-2' : 'text-fg-3')}>{item.title}</p>
        {facts && <p className="mt-0.5 truncate text-[12px] text-fg-3">{facts}</p>}
        <p className="mt-0.5 text-[12px] text-fg-3">{seenWords(item)}</p>
        <Actions item={item} spec={spec} />
      </div>
    </article>
  );
}

function ItemRow({ item, routineId, spec }: { item: WatchItem; routineId: string; spec: WatchSpec }) {
  const facts = factsWords(item, spec.fields);
  return (
    <article className="grid grid-cols-[104px_minmax(0,1fr)] gap-3" aria-label={item.title} data-watch-item={item.id}>
      <Photo source={item.image ? { routineId, itemId: item.id } : undefined} alt={item.title} className="rounded-[var(--r-1)]" dim={!item.present} />
      <div className="min-w-0">
        <PriceLine item={item} spec={spec} />
        <p className={cn('mt-0.5 line-clamp-2 text-[14px] leading-[1.4]', item.present ? 'text-fg-2' : 'text-fg-3')}>{item.title}</p>
        {facts && <p className="mt-0.5 truncate text-[13px] text-fg-3">{facts}</p>}
        <p className="mt-0.5 text-[13px] text-fg-3">{seenWords(item)}</p>
        <Actions item={item} spec={spec} />
      </div>
    </article>
  );
}

function Actions({ item, spec }: { item: WatchItem; spec: WatchSpec }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="mt-1.5 flex items-center gap-4 text-[12px] phone:text-[13px]">
        {item.url && (
          <a href={item.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-fg-2 hover:text-fg phone:min-h-8">
            Open <ExternalLink className="size-3" strokeWidth={1.75} />
          </a>
        )}
        {item.history.length > 0 && (
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="text-fg-3 hover:text-fg phone:min-h-8">
            {open ? 'Hide history' : 'History'}
          </button>
        )}
      </div>
      {open && (
        <ol className="mt-1.5 list-none space-y-0.5 border-l border-rule-2 p-0 pl-2.5" aria-label={`History of ${item.title}`}>
          {[...item.history].reverse().map((h, n) => (
            <li key={n} className="text-[12px] leading-[1.45] text-fg-2 phone:text-[13px]">
              <span className="num text-fg-3">{dayWords(h.at)}</span> {historyWords(h, spec.currency)}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Edit filters
// ---------------------------------------------------------------------------

const list = (s: string): string[] | undefined => {
  const out = s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
};
const num = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s.replace(/[^\d.]/g, '')));

/** The filters dialog: what a run reads and what the hub keeps out, and when you hear from it. */
export function FiltersDialog({ routine, open, onClose }: { routine: Routine; open: boolean; onClose: () => void }) {
  const spec = routine.watch!;
  const f = spec.filters ?? {};
  const phone = useIsMobile();
  const [url, setUrl] = useState(spec.url);
  const [profile, setProfile] = useState(spec.profile ?? 'default');
  const [minPrice, setMin] = useState(f.minPrice?.toString() ?? '');
  const [maxPrice, setMax] = useState(f.maxPrice?.toString() ?? '');
  const [maxDistance, setDist] = useState(f.maxDistance?.toString() ?? '');
  const [unit, setUnit] = useState<'km' | 'mi'>(f.unit ?? 'km');
  const [near, setNear] = useState(f.near ?? '');
  const [keywords, setKeywords] = useState((f.keywords ?? []).join(', '));
  const [exclude, setExclude] = useState((f.exclude ?? []).join(', '));
  const [fields, setFields] = useState((spec.fields ?? []).join(', '));
  const [notify, setNotify] = useState<'change' | 'daily'>(spec.notify ?? 'change');
  const [profiles, setProfiles] = useState<BrowserProfileDto[]>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (!open) return;
    api()
      .browserStatus()
      .then((s) => setProfiles(s.profiles))
      .catch(() => setProfiles([]));
  }, [open]);

  const names = useMemo(() => [...new Set([...(profiles ?? []).map((p) => p.name), spec.profile ?? 'default'])], [profiles, spec.profile]);
  const sitesOf = (name: string) => profiles?.find((p) => p.name === name)?.sites.map((s) => s.host) ?? [];

  const save = async () => {
    const filters: WatchFilters = {
      minPrice: num(minPrice),
      maxPrice: num(maxPrice),
      maxDistance: num(maxDistance),
      ...(num(maxDistance) !== undefined || near.trim() ? { unit } : {}),
      near: near.trim() || undefined,
      keywords: list(keywords),
      exclude: list(exclude),
    };
    const next: WatchSpec = { ...spec, url: url.trim(), profile, filters, fields: list(fields), notify };
    setBusy(true);
    setProblem(undefined);
    try {
      await api().updateRoutine(routine.id, { watch: next });
      toast({ title: 'Filters saved. The next run uses them.' });
      onClose();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit filters"
      description="What each run looks for and keeps out. New items outside the filters are left out; items already kept stay."
      width={560}
      footer={
        <>
          <Button variant="quiet" size={phone ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={phone ? 'touch' : 'md'} busy={busy ? 'Saving' : false} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 max-sm:grid-cols-1">
        <Field label="Search address" help="The page each run starts at." className="col-span-2 max-sm:col-span-1">
          <Input mono value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Lowest price" optional>
          <Input inputMode="decimal" value={minPrice} onChange={(e) => setMin(e.target.value)} suffix={spec.currency} />
        </Field>
        <Field label="Highest price" optional>
          <Input inputMode="decimal" value={maxPrice} onChange={(e) => setMax(e.target.value)} suffix={spec.currency} />
        </Field>
        <Field label="Distance" optional>
          <div className="flex items-center gap-2">
            <Input inputMode="decimal" value={maxDistance} onChange={(e) => setDist(e.target.value)} aria-label="Most distance" />
            <Segmented<'km' | 'mi'>
              label="Unit"
              size={phone ? 'touch' : 'md'}
              value={unit}
              onChange={setUnit}
              options={[
                { value: 'km', label: 'km' },
                { value: 'mi', label: 'mi' },
              ]}
            />
          </div>
        </Field>
        <Field label="From" optional>
          <Input value={near} onChange={(e) => setNear(e.target.value)} placeholder="Oakland, CA" />
        </Field>
        <Field label="Looking for" help="Words to search for, separated by commas." optional>
          <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="civic, corolla" />
        </Field>
        <Field label="Leave out" help="Items whose title has one of these." optional>
          <Input value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="salvage, parts" />
        </Field>
        <Field label="Also read" help="Facts to read for each item." optional>
          <Input value={fields} onChange={(e) => setFields(e.target.value)} placeholder="year, mileage" />
        </Field>
        <Field label="Browser profile" help={sitesOf(profile).length ? `Signed in to ${sitesOf(profile).join(', ')}.` : 'Sign in to a site in Settings, Browser.'}>
          <Select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tell me" className="col-span-2 max-sm:col-span-1">
          <Segmented<'change' | 'daily'>
            label="Tell me"
            size={phone ? 'touch' : 'md'}
            value={notify}
            onChange={setNotify}
            full={phone}
            options={[
              { value: 'change', label: 'When something changes' },
              { value: 'daily', label: 'After every run' },
            ]}
          />
        </Field>
      </div>
      {problem && <p className={cn('mt-4 text-[13px]', STATE_TEXT.fault)}>Could not save. {problem}</p>}
    </Dialog>
  );
}
