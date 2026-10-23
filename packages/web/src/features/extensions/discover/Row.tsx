/**
 * One Discover row (ECOSYSTEM.md 3.3):
 *   line 1  name, stars at the right, the action at the far right
 *   line 2  owner/repo, kind, category, updated, not verified, archived, your pick
 *   line 3  description, two lines at most
 *   line 4  "Can touch: ..." and missing needs in amber, only when they apply
 *   line 5  "Install on the hub" when the hub can install what is missing, else
 *           why not and the command to copy (hub-setup.ts)
 * A click outside the action opens the detail. Once added, the title links to
 * the item in its tab and the action becomes the word "added".
 */
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Link } from 'wouter';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import type { CatalogItemDto } from '@conclave/core/client';
import { KIND_WORD, addLabel, categoryWord, isStale, missingWords, starsWords, touchWords, updatedWords } from './words';
import { cardFix } from './hub-setup';
import { HubFixLine } from './HubSetup';

export function DiscoverRow({
  item,
  onOpen,
  onAdd,
  onUpdate,
  onReady,
  recommendedMark,
  hubName,
}: {
  item: CatalogItemDto;
  /** Row click: the detail sheet. */
  onOpen: (item: CatalogItemDto) => void;
  /** The Add button: the preview sheet, or the Routines Add sheet for routines. */
  onAdd: (item: CatalogItemDto) => void;
  onUpdate?: (item: CatalogItemDto) => void;
  /** After "Install on the hub" ran, with the readiness the hub checked again. */
  onReady?: (id: string, ready: CatalogItemDto['ready']) => void;
  /** Mark curated matches in search results with "recommended". */
  recommendedMark?: boolean;
  hubName?: string;
}) {
  const mobile = useIsMobile();
  const storeHub = useHub((s) => s.hub?.name);
  const added = !!item.installed;
  const unverified = item.source === 'mcp-registry' && !item.verified;
  // an added item already runs (Basic Memory as a Memory connection): what a fresh install would need does not apply
  const missing = item.installed ? '' : missingWords(item.ready?.missing ?? [], hubName ? hubName : 'the hub');
  const fix = missing ? cardFix(item) : null;
  const touches = touchWords(item.touches);
  const parts: ReactNode[] = [
    item.repo ?? item.url?.replace(/^https?:\/\//, ''),
    KIND_WORD[item.kind],
    categoryWord(item.category),
    updatedWords(item.updatedAt),
    isStale(item.updatedAt) && !item.archived ? 'no commits in 6 months' : null,
    unverified ? 'not verified' : null,
    item.archived ? <span className="text-fault">archived</span> : null,
    item.must ? 'your pick' : recommendedMark && item.recommended ? 'recommended' : null,
  ];
  const meta = parts.filter((p) => !!p);

  const open = () => onOpen(item);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };
  const stop = (e: MouseEvent) => e.stopPropagation();

  const title = added && item.installed?.href ? (
    <Link href={item.installed.href} onClick={stop} className="t-row min-w-0 truncate text-fg underline-offset-[3px] hover:underline">
      {item.name}
    </Link>
  ) : (
    <button type="button" onClick={(e) => (stop(e), open())} className="t-row min-w-0 truncate text-left text-fg underline-offset-[3px] hover:underline">
      {item.name}
    </button>
  );

  const action = added ? (
    item.updateAvailable && onUpdate ? (
      <button type="button" onClick={(e) => (stop(e), onUpdate(item))} className="tap text-[13px] font-medium text-fg-2 hover:text-fg phone:text-[14px]">
        Update
      </button>
    ) : (
      <span className="text-[13px] text-fg-3 phone:text-[14px]">added</span>
    )
  ) : (
    <Button
      variant="outline"
      size="sm"
      className={cn(mobile && 'h-8 px-3.5 text-[14px]')}
      onClick={(e) => {
        stop(e);
        onAdd(item);
      }}
      aria-label={`${addLabel(item)} ${item.name}`}
    >
      {addLabel(item)}
    </Button>
  );

  return (
    // the list's hairline sits on this box; the row inside reaches 12px past it for the hover fill
    <div>
    <div
      role="group"
      aria-label={item.name}
      tabIndex={-1}
      onClick={open}
      onKeyDown={onKey}
      className="group/row -mx-3 flex cursor-pointer gap-4 px-3 py-3 transition-colors duration-[var(--dur-1)] hover:bg-hover phone:-mx-2 phone:gap-3 phone:px-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-3">
          {title}
          {item.stars !== undefined && (
            <span className="num ml-auto shrink-0 text-[12.5px] text-fg-3 phone:text-[13px]" title={item.starsAt ? `Read on ${item.starsAt}` : undefined}>
              {starsWords(item.stars)}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
          {meta.map((p, i) => (
            <span key={i}>
              {p}
              {i < meta.length - 1 ? ', ' : ''}
            </span>
          ))}
        </div>
        <p className="m-0 mt-1 line-clamp-2 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">{item.description}</p>
        {(missing || (touches && !mobile)) && (
          <p className="m-0 mt-1 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
            {touches && !mobile && <>Can touch: {touches}.</>}
            {missing && (
              <>
                {touches && !mobile ? ' ' : ''}
                <span className="text-warn">{missing}</span>
              </>
            )}
          </p>
        )}
        {fix && <HubFixLine fix={fix} itemId={item.id} itemName={item.name} hubName={hubName || storeHub || 'the hub'} onReady={(ready) => onReady?.(item.id, ready)} className="mt-1.5" compact={mobile} />}
      </div>
      <div className="flex min-w-[64px] shrink-0 justify-end pt-[1px] phone:min-w-0 phone:pt-0">{action}</div>
    </div>
    </div>
  );
}
