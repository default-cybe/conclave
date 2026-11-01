/**
 * Suggested routines (docs/design/ECOSYSTEM.md 5.2): ready-made routines for
 * the owner's machines, grouped by what they look after. Each row says what
 * it does, when, as which agent, on which device and what it leaves behind,
 * with Add (which opens the Add sheet) or "added".
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { Device } from '@conclave/core/types';
import { roleDevice } from '@conclave/core/scheduler/suggest';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { CATEGORY_WORD, addedRoutines, discoverHref, grouped, loadSuggestions, missingWords, useSuggestStore, whatWords, whenWords, whereWords, type Suggestion } from './suggest';

/** Good first routines, in order, for the empty state and onboarding. */
const STARTERS = ['librarian-deep-pass', 'backup-check', 'github-inbox', 'unpushed-work', 'disk-health', 'token-cost-review', 'cve-watch'];

/**
 * Up to n starters this hub can add now and whose machine it has (a Proxmox
 * routine needs a Proxmox host). Added ones stay, so a row does not jump
 * after Add.
 */
function starterPicks(list: Suggestion[] | undefined, n: number, devices: Device[] = []): Suggestion[] {
  if (!list) return [];
  const fits = (s: Suggestion) => (s.deviceRole !== 'proxmox' && s.deviceRole !== 'laptop') || !!roleDevice(s.deviceRole, devices);
  const ready = (s: Suggestion) => !s.waitingOn.length && fits(s);
  const byId = new Map(list.map((s) => [s.id, s]));
  const first = STARTERS.map((id) => byId.get(id)).filter((s): s is Suggestion => !!s && ready(s));
  const rest = list.filter((s) => s.recommended && ready(s) && !STARTERS.includes(s.id));
  return [...first, ...rest].slice(0, n);
}

export function SuggestedSection({ onAdd, limit, className, heading = 'Suggested' }: { onAdd: (id: string) => void; limit?: number; className?: string; heading?: string }) {
  const data = useSuggestStore((s) => s.data);
  const error = useSuggestStore((s) => s.error);
  const loading = useSuggestStore((s) => s.loading);
  const [more, setMore] = useState(false);
  const [all, setAll] = useState(false);
  const deviceMap = useHub((st) => st.devices);

  useEffect(() => {
    void loadSuggestions();
  }, []);

  const list = data?.suggestions;
  const recommended = useMemo(() => list?.filter((s) => s.recommended) ?? [], [list]);
  const others = useMemo(() => list?.filter((s) => !s.recommended) ?? [], [list]);

  if (error && !list)
    return (
      <section className={className} aria-labelledby="sug-h">
        <SectionHeading id="sug-h">{heading}</SectionHeading>
        <p className="pt-3 text-[13px] text-fg-2 phone:text-[14px]">
          Could not load the suggestions. {error}{' '}
          <TextAction label="Try again" onClick={() => void loadSuggestions(true)} className="link" />
        </p>
      </section>
    );

  if (!list)
    return (
      <section className={className} aria-labelledby="sug-h">
        <SectionHeading id="sug-h">{heading}</SectionHeading>
        <LoadingRows loading={loading} rows={3} />
      </section>
    );

  // the empty state shows a few starters first, then the whole list on request
  if (limit && !all) {
    const picks = starterPicks(list, limit, Object.values(deviceMap));
    return (
      <section className={className} aria-labelledby="sug-h">
        <SectionHeading id="sug-h" right={<TextAction label={`All ${list.length} suggestions`} onClick={() => setAll(true)} />}>
          {heading}
        </SectionHeading>
        <div className="rows">
          {picks.map((s) => (
            <SuggestionRow key={s.id} s={s} onAdd={onAdd} />
          ))}
        </div>
      </section>
    );
  }

  const shown = more ? list : recommended;
  return (
    <section className={className} aria-labelledby="sug-h">
      <SectionHeading id="sug-h" count={shown.length}>
        {heading}
      </SectionHeading>
      <p className="pt-2.5 text-[12.5px] leading-[1.5] text-fg-3 phone:text-[13.5px]">Ready-made routines for your machines. Add shows what each one may run before anything is saved.</p>
      {grouped(shown).map((g) => (
        <div key={g.category}>
          <h3 className="pt-5 pb-1 text-[12px] font-semibold text-fg-3 phone:text-[13px]">{CATEGORY_WORD[g.category]}</h3>
          <div className="rows">
            {g.items.map((s) => (
              <SuggestionRow key={s.id} s={s} onAdd={onAdd} />
            ))}
          </div>
        </div>
      ))}
      {!more && others.length > 0 && (
        <div className="border-t border-rule pt-3">
          <TextAction className="link" label={`Show ${others.length} more`} onClick={() => setMore(true)} />
        </div>
      )}
    </section>
  );
}

function SuggestionRow({ s, onAdd }: { s: Suggestion; onAdd: (id: string) => void }) {
  const devices = useHub((st) => st.devices);
  const routines = useHub((st) => st.routines);
  const replacement = useSuggestStore((st) => (s.replacedBy ? st.data?.suggestions.find((x) => x.id === s.replacedBy)?.name : undefined));
  const hubRepos = useSuggestStore((st) => st.data?.hubRepos);
  const phone = useIsMobile();
  const list = useMemo(() => Object.values(devices), [devices]);
  const missing = missingWords(s);
  const waiting = s.waitingOn.length > 0;
  // from the live routine list, so a routine deleted elsewhere frees the row at once
  const added = addedRoutines(s, routines)[0]?.id;
  const meta = [whenWords(s.schedule), s.agent ?? 'assistant', whereWords(s, list, hubRepos)].join(', ');

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 py-3.5 phone:gap-x-3 phone:py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-[13.5px] font-medium text-fg phone:text-[15px]">{s.name}</span>
          <span className="text-[12px] text-fg-3 phone:text-[13px]">{meta}</span>
        </div>
        <p className="mt-0.5 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">{whatWords(s.description)}</p>
        <p className={cn('mt-1 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]', phone ? 'line-clamp-2' : 'truncate')} title={s.outputs}>
          Leaves: {s.outputs}
        </p>
        {missing.length > 0 && (
          <p className="mt-1 text-[12.5px] leading-[1.45] text-warn phone:text-[13.5px]">
            Needs {missing.map((m) => m.label).join(' and ')}.
            {missing.find((m) => m.catalog) && (
              <>
                {' '}
                <Link href={discoverHref(missing.find((m) => m.catalog)!.catalog!)} className="link text-warn">
                  Add it
                </Link>
              </>
            )}
          </p>
        )}
      </div>
      <div className="flex min-w-[64px] flex-col items-end pt-0.5">
        {added ? (
          <Link href={`/routines/${added}`} className="tap text-[13px] text-fg-3 hover:text-fg phone:text-[14px]">
            added
          </Link>
        ) : (
          <Button variant="outline" size={phone ? 'md' : 'sm'} disabled={waiting} onClick={() => onAdd(s.id)} aria-label={`Add ${s.name}`}>
            Add
          </Button>
        )}
        {waiting && !added && <span className="mt-1 text-right text-[11.5px] leading-tight text-fg-3 phone:text-[12.5px]">Needs a hub update</span>}
        {replacement && <span className="mt-1 text-right text-[11.5px] leading-tight text-fg-3 phone:text-[12.5px]">Replaced by {replacement}</span>}
      </div>
    </div>
  );
}
