/**
 * Maps cards in the chat: places (name, rating, open now, address, Open in
 * Google Maps and Directions), a route (time, distance, mode, leave-by) and
 * a map image the hub serves from /api/maps/image/:id, so the key never
 * reaches the browser. On a phone the turn's tool calls fold into one line
 * and these cards sit under it (docs/design/MOBILE-V2.md 5).
 */
import { useEffect, useState } from 'react';
import type { MapsCardData, MapImageCard, PlaceCard, RouteCard } from '@conclave/core/client';
import type { ToolResultBlock, ToolUseBlock } from '@conclave/core/types';
import { distanceWords } from '@conclave/core/maps/words';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { ButtonLink } from '@/components/ui/Button';
import { useIsMobile } from '@/lib/hooks';
import { mapsCardOf, mapsLineWords, openWords, placeFacts, routeExtra, routeHeadline, routeTimes, routeWhere } from './words';

const BOX = 'rounded-[var(--r-2)] border border-rule-2 bg-raise';

export function MapsCard({ card, className }: { card: MapsCardData; className?: string }) {
  if (card.kind === 'places') return <Places card={card} className={className} />;
  if (card.kind === 'route') return <Route card={card} className={className} />;
  return <MapPicture card={card} className={className} />;
}

/** The cards of a turn's maps calls, in order: what sits under a phone's folded tool line. */
export function MapsCards({ results, className }: { results: Array<ToolResultBlock | undefined>; className?: string }) {
  const cards = results.map((r) => mapsCardOf(r)).filter((c): c is MapsCardData => !!c);
  if (!cards.length) return null;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {cards.map((c, i) => (
        <MapsCard key={i} card={c} />
      ))}
    </div>
  );
}

/** A maps call on the Chat page: one quiet line, and its card unless a phone shows the cards under the fold. */
export function MapsLine({ tool, result, card = true }: { tool: ToolUseBlock; result?: ToolResultBlock; card?: boolean }) {
  const mobile = useIsMobile();
  const c = mapsCardOf(result);
  if (result?.isError)
    return (
      <div className="py-0.5">
        <div className="flex min-h-[25px] items-center text-[12.5px] text-fault phone:text-[13.5px]">{tool.name === 'MapImage' ? 'Map failed' : tool.name === 'Directions' ? 'Directions failed' : 'Place search failed'}</div>
        <p className="mb-1 max-w-[72ch] text-[13px] leading-[1.5] text-fg-2">{typeof result.content === 'string' ? result.content : ''}</p>
      </div>
    );
  return (
    <div className="py-0.5">
      <div className="flex min-h-[25px] items-center text-[12.5px] text-fg-3 phone:text-[13.5px]">{mapsLineWords(tool.name, tool.input, c)}</div>
      {card && !mobile && c && <MapsCard card={c} className="mt-1 mb-1.5" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// places
// ---------------------------------------------------------------------------

function Places({ card, className }: { card: Extract<MapsCardData, { kind: 'places' }>; className?: string }) {
  return (
    <div className={cn(BOX, 'max-w-[560px] divide-y divide-rule', className)} data-maps-card="places">
      {card.places.map((p) => (
        <Place key={p.id} p={p} open={openWords(card)} />
      ))}
      {card.attribution && <Attribution text={card.attribution} />}
    </div>
  );
}

function Place({ p, open }: { p: PlaceCard; open: string }) {
  const facts = placeFacts(p);
  return (
    <div className="px-3.5 py-3 phone:px-4">
      <div className="flex items-baseline gap-3">
        <span className="t-row min-w-0 flex-1 truncate text-fg">{p.name}</span>
        {p.distanceMeters !== undefined && <span className="num shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{distanceWords(p.distanceMeters)}</span>}
      </div>
      {facts.length > 0 && (
        <div className="mt-0.5 text-[12.5px] leading-[1.45] text-fg-2 phone:text-[14px]">
          {facts.map((f, i) => (
            <span key={f.text}>
              {i > 0 && ', '}
              <span className={cn(f.tone === 'ok' && 'text-ok', f.tone === 'dim' && 'text-fg-3')}>{i > 0 ? f.text.charAt(0).toLowerCase() + f.text.slice(1) : f.text}</span>
            </span>
          ))}
        </div>
      )}
      {p.address && <div className="mt-0.5 text-[12.5px] leading-[1.45] text-fg-3 phone:text-[14px]">{p.address}</div>}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <ButtonLink href={p.mapsUrl} external size="sm" variant="outline">
          {open}
        </ButtonLink>
        <ButtonLink href={p.directionsUrl} external size="sm" variant="quiet">
          Directions
        </ButtonLink>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// a route
// ---------------------------------------------------------------------------

function Route({ card, className }: { card: Extract<MapsCardData, { kind: 'route' }>; className?: string }) {
  const r: RouteCard = card.route;
  const extra = routeExtra(r);
  return (
    <div className={cn(BOX, 'max-w-[560px] px-3.5 py-3 phone:px-4', className)} data-maps-card="route">
      <div className="flex items-baseline gap-3">
        <span className="t-stat min-w-0 flex-1 truncate text-fg">{routeHeadline(r)}</span>
      </div>
      <div className={cn('mt-1 text-[13px] leading-[1.45] phone:text-[14.5px]', r.leaveByText ? 'font-medium text-fg' : 'text-fg-2')}>{routeTimes(r)}</div>
      <div className="mt-0.5 text-[12.5px] leading-[1.45] text-fg-3 phone:text-[14px]">{routeWhere(r)}</div>
      {extra && <div className="mt-0.5 text-[12.5px] leading-[1.45] text-fg-3 phone:text-[14px]">{extra}</div>}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <ButtonLink href={r.directionsUrl} external size="sm" variant="outline">
          {openWords(card)}
        </ButtonLink>
      </div>
      {card.attribution && <Attribution text={card.attribution} inline />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// a map image, fetched from the hub with the token like any call
// ---------------------------------------------------------------------------

const urls = new Map<string, string>();

function useMapImage(id: string): { src?: string; error?: string } {
  const [state, setState] = useState<{ src?: string; error?: string }>(() => (urls.has(id) ? { src: urls.get(id) } : {}));
  useEffect(() => {
    if (urls.has(id)) return setState({ src: urls.get(id) });
    let alive = true;
    api()
      .mapImage(id)
      .then((blob) => {
        // one object URL per map for the page's life, so scrolling back does not ask the hub again
        const src = URL.createObjectURL(blob);
        urls.set(id, src);
        if (alive) setState({ src });
      })
      .catch((e: unknown) => alive && setState({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [id]);
  return state;
}

function MapPicture({ card, className }: { card: Extract<MapsCardData, { kind: 'map' }>; className?: string }) {
  const img: MapImageCard = card.image;
  const { src, error } = useMapImage(img.id);
  return (
    <figure className={cn('m-0 max-w-[560px]', className)} data-maps-card="map">
      <div className={cn(BOX, 'relative overflow-hidden bg-sunk')} style={{ aspectRatio: `${img.width} / ${img.height}` }}>
        {src && <img src={src} alt={img.alt} className="block size-full object-cover anim-fade" draggable={false} />}
        {error && <p className="absolute inset-0 grid place-items-center px-4 text-center text-[13px] text-fg-3">Could not load the map. {error}</p>}
      </div>
      {/* the picture carries its own attribution (Google's mark, or the OpenStreetMap line the hub draws) */}
      <figcaption className="mt-1 truncate text-[12px] text-fg-3 phone:text-[13px]">{img.alt}</figcaption>
    </figure>
  );
}

function Attribution({ text, inline }: { text: string; inline?: boolean }) {
  return (
    <div className={cn('text-[11.5px] text-fg-3 phone:text-[12.5px]', inline ? 'mt-2' : 'px-3.5 py-1.5 phone:px-4')}>
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener" className="hov:text-fg">
        {text}
      </a>
    </div>
  );
}
