/**
 * Map (docs/DESIGN.md 29): a live view of everything the hub is doing. The
 * hub's knot in the middle, devices and projects branching off it, every
 * chat, session, subagent and workflow agent a node, and streams of light
 * along the links while they work. Click a node for its details; scrub back
 * through the last 24 hours. A phone opens on the hub and its busiest
 * project, where labels read; Fit shows the whole map.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { MapSnapshot } from '@conclave/core/client';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { useReducedMotion } from '@/components/motion';
import { useBreakpoint, useNow } from '@/lib/hooks';
import { compact, countWord, usd } from '@/lib/format';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { MapCanvas } from './MapCanvas';
import { NodeDrawer } from './Drawer';
import { Scrubber } from './Scrubber';
import { focusBox, layoutMap, type Measure } from './layout';
import { clockWords, counts, groupLine, groupStats } from './model';
import { useMapData, useStreamMode } from './useMap';
import type { StreamMode } from './streams';
import { READ_K, type Insets } from './view';
import './map.css';

const MODES: Array<{ value: StreamMode; label: string; title: string }> = [
  { value: 'full', label: 'Full', title: 'Streams follow every token' },
  { value: 'quiet', label: 'Quiet', title: 'A third of the streams' },
  { value: 'lines', label: 'Lines', title: 'Links only, nothing moves' },
];

/** Text widths from the real fonts, once they are loaded. */
function useMeasure(): Measure | undefined {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let on = true;
    void document.fonts?.ready.then(() => on && setReady(true));
    return () => {
      on = false;
    };
  }, []);
  return useMemo(() => {
    if (!ready) return undefined;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return undefined;
    const family = getComputedStyle(document.documentElement).getPropertyValue('--sans').trim() || 'sans-serif';
    const cache = new Map<string, number>();
    return (text, font) => {
      const key = font + '\u0000' + text;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      ctx.font = font === 'name' ? `600 14px ${family}` : font === 'title' ? `500 13px ${family}` : `400 12px ${family}`;
      // the name is set 4% wider (font-stretch), and padding rounds up
      const w = Math.ceil(ctx.measureText(text).width * (font === 'name' ? 1.06 : 1.04)) + 12;
      cache.set(key, w);
      return w;
    };
  }, [ready]);
}

/** The map area's width over its height, in steps, less the room the overlays take. */
function useAspect(ref: React.RefObject<HTMLElement | null>, insets: Insets): number | undefined {
  const [aspect, setAspect] = useState<number>();
  const { top, right, bottom, left } = insets;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = r.width - left - right;
      const h = r.height - top - bottom;
      if (w > 0 && h > 0) setAspect(Math.round((w / h) * 10) / 10);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, top, right, bottom, left]);
  return aspect;
}

/** What changes where things sit: ids, parents, groups, titles, devices. States do not move the map. */
function structureKey(s: MapSnapshot, now: number): string {
  return JSON.stringify([
    s.hub.name,
    s.devices.map((d) => [d.id, d.name, d.online]),
    s.groups.map((g) => [g.id, g.name, g.device, groupLine(groupStats(g.id, s.nodes), g.kind === 'chats')]),
    s.nodes.map((n) => [n.id, n.parentId, n.group, n.kind, n.title, n.stuckSince ? Math.round((now - n.stuckSince) / 600_000) : 0]),
  ]);
}

export default function MapPage() {
  const bp = useBreakpoint();
  const phone = bp === 'phone';
  const reduced = useReducedMotion();
  const data = useMapData();
  const [mode, setMode] = useStreamMode();
  const [selected, setSelected] = useState<string>();
  const [fit, setFit] = useState(0);
  const [zoom, setZoom] = useState({ n: 0, factor: 1 });
  const conn = useHub((s) => s.conn);
  const online = conn !== 'closed';
  const measure = useMeasure();
  const now = useNow(30_000);
  const snap = data.snap;
  const replay = data.replay !== undefined;

  // a node that left the map closes its details
  const node = selected ? snap?.nodes.find((n) => n.id === selected) : undefined;
  useEffect(() => {
    if (selected && snap && !node) setSelected(undefined);
  }, [selected, snap, node]);

  const drawer = !!node && !phone;
  // Esc closes the details on desktop, unless a dialog above them takes it
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[role=dialog][aria-modal=true]')) return;
      setSelected(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);
  // the phone's sheet covers about the lower half: a node picked there moves up into sight
  const insets: Insets = phone ? { top: 84, right: 12, bottom: node ? Math.round(window.innerHeight * 0.7) : 120, left: 12 } : { top: 92, right: drawer ? 384 : 32, bottom: 76, left: 32 };
  const root = useRef<HTMLDivElement>(null);
  // the drawer does not reshape the map: it is measured without it
  const aspect = useAspect(root, phone ? { ...insets, bottom: 120 } : { ...insets, right: 32 });

  const key = snap ? structureKey(snap, now) : '';
  const layout = useMemo(
    () => (snap && aspect ? layoutMap(snap, { measure, now, aspect, ...(phone ? { sides: 'right' as const, compact: true } : {}) }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, measure, phone, aspect],
  );
  // a phone opens on the hub and its busiest project where the labels read; Fit shows it all.
  // Taken when the layout changes, so a state that changes never moves the map
  const start = useMemo(
    () => (phone && layout && snap ? { focus: focusBox(layout, snap.nodes), k: READ_K } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, phone],
  );
  const effective: StreamMode = reduced ? 'lines' : mode;

  const streams = (
    <div className="flex items-center gap-2">
      {!phone && <span className="text-[12.5px] text-fg-3">Streams</span>}
      <Segmented
        label="Streams"
        value={effective}
        onChange={setMode}
        size="sm"
        options={MODES.map((m) => ({ ...m, disabled: reduced && m.value !== 'lines', title: reduced && m.value !== 'lines' ? 'Reduce motion is on' : m.title }))}
      />
    </div>
  );

  return (
    <div ref={root} className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
      {snap && layout ? (
        <MapCanvas
          snap={snap}
          layout={layout}
          mode={effective}
          selected={selected}
          onSelect={setSelected}
          insets={insets}
          online={online}
          replay={replay}
          fit={fit}
          zoom={zoom}
          now={replay ? snap.at : now}
          refit={!phone}
          start={start}
          className={cn('absolute inset-0', phone && 'map-phone')}
        />
      ) : (
        <div className="grid flex-1 place-items-center px-6 text-center text-[14px] text-fg-3" role="status">
          {data.error ? (
            <div>
              <p className="m-0 text-fg-2">The map did not load: {data.error}</p>
              <Button className="mt-3" onClick={data.reload}>
                Try again
              </Button>
            </div>
          ) : data.loading ? (
            'Loading the map'
          ) : null}
        </div>
      )}

      {/* the header line */}
      {/* phones: a band like the top bar, so the map passes under the sentence instead of through it */}
      <div className={cn('map-overlay absolute top-0 left-0', phone ? 'right-0 bg-bg px-5 pt-1 pb-2' : 'right-[440px] px-8 pt-5')}>
        <div>
          {!phone && <h1 className="t-page m-0 text-fg">Map</h1>}
          {snap && <Sentence snap={snap} replay={data.replay} online={online} phone={phone} />}
        </div>
      </div>

      {/* streams, zoom and fit */}
      {!phone && snap && (
        <div className="map-overlay absolute top-5 flex items-center gap-4 transition-[right] duration-[var(--dur-3)]" style={{ right: drawer ? 392 : 32 }}>
          {streams}
          <div className="flex items-center">
            <ZoomButton label="Zoom out" onClick={() => setZoom((z) => ({ n: z.n + 1, factor: 0.8 }))}>
              <Minus className="size-4" strokeWidth={1.75} aria-hidden />
            </ZoomButton>
            <ZoomButton label="Zoom in" onClick={() => setZoom((z) => ({ n: z.n + 1, factor: 1.25 }))}>
              <Plus className="size-4" strokeWidth={1.75} aria-hidden />
            </ZoomButton>
            <Button variant="quiet" size="sm" onClick={() => setFit((f) => f + 1)}>
              Fit
            </Button>
          </div>
        </div>
      )}

      {/* replay */}
      {snap && (
        <div className={cn('map-overlay absolute bottom-0 left-0', phone ? 'right-0 px-5 pb-[calc(var(--safe-b)+8px)]' : 'px-8 pb-3')} style={phone ? undefined : { right: drawer ? 360 : 0 }}>
          {phone && (
            <div className="mb-1 flex items-center justify-end gap-2">
              {streams}
              <Button variant="outline" size="sm" onClick={() => setFit((f) => f + 1)}>
                Fit
              </Button>
            </div>
          )}
          <div>
            <Scrubber from={snap.from} now={Date.now()} at={data.replay} onChange={data.setReplay} phone={phone} />
          </div>
        </div>
      )}

      {snap && <NodeDrawer node={node} snap={snap} phone={phone} replay={replay} onSelect={setSelected} onClose={() => setSelected(undefined)} />}
    </div>
  );
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-[26px] place-items-center rounded-[var(--r-1)] text-fg-3 transition-colors duration-[var(--dur-1)] hov:bg-hover hov:text-fg">
      {children}
    </button>
  );
}

/** "Six running, one waiting on you. 3.4M tokens and $8.12 today." */
function Sentence({ snap, replay, online, phone }: { snap: MapSnapshot; replay?: number; online: boolean; phone: boolean }) {
  const { running, waiting } = counts(snap.nodes);
  const t = snap.totals.today;
  const nothing = !running && !waiting;
  return (
    <p className={cn('m-0 text-fg-2', phone ? 'text-[14px] leading-[1.4]' : 'mt-1 text-[14px]')} aria-live="polite">
      {replay !== undefined && <span className="text-fg">Replay of {clockWords(replay)}. </span>}
      {!online && replay === undefined && <span className="text-fg">{snap.hub.name} is offline. </span>}
      {nothing && 'Nothing running'}
      {running > 0 && <span className="text-signal">{countWord(running, true)} running</span>}
      {running > 0 && waiting > 0 && ', '}
      {waiting > 0 && <span className="text-warn">{countWord(waiting, !running)} waiting on you</span>}
      {'. '}
      <span className="num">{compact(t.tokens)}</span> tokens and <span className="num">{usd(t.costUsd)}</span> {replay !== undefined ? 'by then' : 'today'}.
    </p>
  );
}
