/**
 * The photos of what a watch's run changed, under its notice in the toast:
 * up to four, each with its price and what happened ("New", "Price down"),
 * each opening the listing. The notice's Open goes to the watch page.
 */
import type { WatchNotice } from '@conclave/core/client';
import { Photo } from './Photo';
import { MARK_WORD, priceWords } from './words';

export function WatchStrip({ notice }: { notice: WatchNotice }) {
  const items = notice.items.slice(0, 4);
  if (!items.length) return null;
  return (
    <ul className="m-0 grid list-none grid-cols-4 gap-2 p-0 pr-1" aria-label="What changed">
      {items.map((i) => (
        <li key={i.id} className="min-w-0">
          <a href={i.url} target="_blank" rel="noreferrer noopener" className="block" title={i.title}>
            <Photo source={i.image ? { routineId: notice.routineId, itemId: i.id } : undefined} alt={i.title} className="rounded-[var(--r-1)]" dim={i.mark === 'gone'} />
            <span className="mt-1 block truncate text-[11.5px] leading-[1.3] text-fg phone:text-[12.5px]">{priceWords(i.price, i.priceText, notice.currency)}</span>
            <span className="block truncate text-[11px] leading-[1.3] text-fg-3 phone:text-[12px]">{MARK_WORD[i.mark]}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
