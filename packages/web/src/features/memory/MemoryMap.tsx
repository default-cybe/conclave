/**
 * Memory > Map: the owner's whole memory as a mind map (GET /api/memory/graph,
 * every item once). The brain sits in the middle, the areas of his life and
 * work around it (People, Homelab, Courses, ...), and an open area shows its
 * best linked items with a plain "k more" row. Any item can become the
 * center (double click, Enter, Center here): its links stand around it in
 * groups by relation, the view glides there in 450 ms, the trail leads back
 * to the brain, and Escape steps back. Rings past the first fold into
 * counts until they fit or the owner zooms in. Search counts its hits
 * ("2 of 18"); Enter and Shift+Enter step through them and pull each one
 * into the tree along its path from what is on the map. The scrubber steps
 * back what changed after a day. Text only: there are no marks
 * (graph-model.ts, MemoryCanvas.tsx).
 *
 * Expand all (E) opens every area with every item at once, read by
 * semantic zoom; Collapse all goes back to the brain and its areas. The
 * Brain view (Tree / Brain) shows how memories connect across areas: two
 * hemispheres of lobes with every real link bundled through the middle
 * (brain-model.ts, BrainCanvas.tsx). Filters, search, the scrubber and
 * the drawer work in both.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { Minus, Plus, X } from 'lucide-react';
import type { MemoryGraph, MemoryGraphNode } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useBreakpoint } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Input, Segmented } from '@/components/ui/Field';
import { FilterLinks } from '@/components/ui/Tags';
import { Sheet } from '@/components/ui/Overlay';
import type { Measure } from '@/features/map/layout';
import type { Insets } from '@/features/map/view';
import { BRAIN, MORE_STEP, ROW, ROW_PHONE, areaId, buildTree, chainTo, indexGraph, layoutAll, layoutTree, nodeLabel, nodeWords, pathInto, searchItems, type Indexed, type PNode } from './graph-model';
import { edgeOn, layoutBrain, RECORDS, type BrainLayout } from './brain-model';
import { BrainCanvas } from './BrainCanvas';
import { MemoryCanvas, READ_K } from './MemoryCanvas';
import { TimeScrubber } from './TimeScrubber';
import '@/features/map/map.css';
import './memory-map.css';

type Source = 'all' | 'conclave' | 'basic-memory';
type Pair = readonly [string, string];
type Mode = 'tree' | 'brain';

const add = <T,>(s: ReadonlySet<T>, v: T) => new Set([...s, v]);
const del = <T,>(s: ReadonlySet<T>, v: T) => new Set([...s].filter((x) => x !== v));
const num = (n: number) => n.toLocaleString('en-US');
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Text widths from the real fonts, as the Map measures them (MapPage useMeasure). */
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
      const w = Math.ceil(ctx.measureText(text).width * (font === 'name' ? 1.06 : 1.04)) + 12;
      cache.set(key, w);
      return w;
    };
  }, [ready]);
}

export function MemoryMapTab() {
  const [g, setG] = useState<MemoryGraph>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    api()
      .memoryGraph()
      .then((x) => alive && setG(x))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);
  const ix = useMemo(() => (g ? indexGraph(g) : undefined), [g]);
  if (error) return <Centered>The memory map did not load: {error}</Centered>;
  if (!g || !ix) return <Centered>Loading memory</Centered>;
  if (!g.nodes.length) return <Centered>No memory yet. Notes you add, and a linked Basic Memory, show here.</Centered>;
  return <MemoryMindMap g={g} ix={ix} />;
}

function MemoryMindMap({ g, ix }: { g: MemoryGraph; ix: Indexed }) {
  const phone = useBreakpoint() === 'phone';
  const measure = useMeasure();
  const [trail, setTrail] = useState<string[]>([BRAIN]);
  const [depth, setDepth] = useState(1);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set(['mentions']));
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [more, setMore] = useState<ReadonlyMap<string, number>>(new Map());
  const [pulled, setPulled] = useState<Pair[]>([]);
  // the path search drew: replaced at every step, not piled up
  const [found, setFound] = useState<{ pairs: Pair[]; target: string }>();
  const [area, setArea] = useState<string>();
  const [sel, setSel] = useState<string>();
  const [hover, setHover] = useState<string>();
  const [q, setQ] = useState('');
  const [hit, setHit] = useState(-1);
  const [at, setAt] = useState<number>();
  const [source, setSource] = useState<Source>('all');
  const [unfold, setUnfold] = useState(false);
  const [fit, setFit] = useState(0);
  const [zoom, setZoom] = useState({ n: 0, factor: 1 });
  const [reveal, setReveal] = useState<{ ids: string[]; n: number; center?: boolean; all?: boolean }>();
  const [note, setNote] = useState<string>();
  const [filters, setFilters] = useState(false);
  const [mode, setMode] = useState<Mode>('tree');
  const [all, setAll] = useState(false);
  const [crossOnly, setCrossOnly] = useState(false);
  // brain view: the item or area under the pointer, and an area tapped or clicked to keep it lit
  const [bHover, setBHover] = useState<string>();
  const [bArea, setBArea] = useState<string>();
  const boxRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const boxH = useHeight(boxRef, 600);
  const headH = useHeight(headRef, 120);
  const footH = useHeight(footRef, 70);
  const show = (ids: string[], center?: boolean) => setReveal((r) => ({ ids, n: (r?.n ?? 0) + 1, center }));
  const center = trail.at(-1)!;
  const atBrain = center === BRAIN;

  // rows ring 1 may use so a hub opens on one screen at the zoom where labels read
  const roomRows = Math.max(12, Math.floor((boxH - headH - footH - 24) / ((phone ? ROW_PHONE : ROW) * READ_K)));
  const budget = phone ? roomRows : roomRows * 2;
  const extra = useMemo(() => [...pulled, ...(found?.pairs ?? [])], [pulled, found]);
  const expanded = all && atBrain;
  const tree = useMemo(() => buildTree(ix, { center, depth, hidden, dismissed, open, more, extra, unfold, budget, all: expanded }), [ix, center, depth, hidden, dismissed, open, more, extra, unfold, budget, expanded]);
  const layout = useMemo(() => (expanded ? layoutAll(tree.root, ix, { measure, phone }) : layoutTree(tree.root, ix, { measure, sides: phone ? 'right' : 'both', phone })), [tree, ix, measure, phone, expanded]);
  // the brain view's layout and bundles: once, the first time it is shown
  const brainRef = useRef<{ g: MemoryGraph; l: BrainLayout }>(undefined);
  if (mode === 'brain' && brainRef.current?.g !== g) {
    const t0 = performance.now();
    brainRef.current = { g, l: layoutBrain(g, ix) };
    performance.clearMeasures('memory-brain:layout');
    performance.measure('memory-brain:layout', { start: t0, end: performance.now() });
  }
  const brain = mode === 'brain' ? brainRef.current?.l : undefined;
  const path = useMemo(() => (found && layout.byId.has(found.target) ? chainTo(layout, found.target) : undefined), [found, layout]);
  const hits = useMemo(() => searchItems(ix, q, tree.items), [ix, q, tree.items]);
  const hitSet = useMemo(() => new Set(hits.map((h) => h.id)), [hits]);

  const labelOf = (id: string) => (id === BRAIN ? 'Brain' : nodeLabel(ix.byId.get(id)!));
  const centerNode = atBrain ? undefined : ix.byId.get(center);

  // ----- what the owner does ----------------------------------------------------------
  const reset = () => {
    setMore(new Map());
    setPulled([]);
    setFound(undefined);
    setHover(undefined);
    setNote(undefined);
  };
  const recenter = (id: string) => {
    if (id === center) return;
    if (atBrain) setArea(ix.byId.get(id)?.area);
    setTrail((t) => [...t.filter((x) => x !== id), id]);
    setOpen(new Set());
    reset();
    setSel(id);
    show([id], true);
  };
  const back = (i: number) => {
    const id = trail[i];
    setTrail((t) => t.slice(0, i + 1));
    // back at the brain the area the owner came from is open again
    setOpen(id === BRAIN && area ? new Set([areaId(area)]) : new Set());
    reset();
    setSel(id === BRAIN ? undefined : id);
    show(id === BRAIN && area ? [areaId(area)] : [id], id !== BRAIN || !area);
  };
  const toArea = (name: string) => {
    setArea(name);
    setTrail([BRAIN]);
    setOpen(new Set([areaId(name)]));
    reset();
    setSel(undefined);
    show([areaId(name)]);
  };
  const pick = (p: PNode) => {
    setNote(undefined);
    const k = p.t.kind;
    if (k === 'more') {
      setMore((m) => new Map(m).set(p.t.key!, (m.get(p.t.key!) ?? 0) + MORE_STEP));
      return show([p.parent!]);
    }
    if (k === 'brain') return setFit((f) => f + 1);
    if (k === 'area' || k === 'group') {
      // a group around an item is open while it shows items
      const on = k === 'group' ? !p.t.children.some((c) => c.kind === 'node') : !open.has(p.id);
      setOpen((o) => (on ? add(o, p.id) : del(o, p.id)));
      if (on && k === 'area') setArea(p.t.via);
      return show([p.id]);
    }
    setSel(p.id);
    if (k === 'node' && !open.has(p.id)) setOpen((o) => add(o, p.id));
    show([p.id]);
  };
  const pull = (from: string, to: string) => {
    setSel(to);
    if (!tree.items.has(to)) setPulled((e) => [...e, [from, to] as const]);
    show([to]);
  };
  /** Pull `id` into the tree along its shortest path from what is on the map, and draw that path. */
  const pathTo = (id: string) => {
    const pairs = pathInto(ix, center, tree.items, id);
    if (!pairs) return setNote(`Nothing links ${labelOf(center)} to ${labelOf(id)}.`);
    setFound({ pairs, target: id });
    setSel(id);
    if (atBrain) setArea(ix.byId.get(id)?.area);
    setNote(undefined);
    // the whole path, from the center out, comes into view
    show(pairs.length ? [center, ...new Set(pairs.flat())] : [id]);
  };
  const step = (dir: 1 | -1) => {
    if (!hits.length) return;
    const i = (hit + dir + hits.length) % hits.length;
    setHit(i);
    // the brain view lights the hit and its links where they are; the tree pulls it in
    if (mode === 'brain') setBArea(undefined);
    else pathTo(hits[i].id);
  };
  const dismiss = (id: string) => {
    setDismissed((d) => add(d, id));
    if (sel === id) setSel(undefined);
  };
  const dismissOthers = (id: string) => {
    const keep = new Set([...chainTo(layout, id), ...layout.nodes.filter((p) => p.parent === id).map((p) => p.id)]);
    setDismissed((d) => new Set([...d, ...[...tree.items].filter((x) => !keep.has(x))]));
  };
  const toggleRelation = (label: string) => setHidden((h) => (h.has(label) ? del(h, label) : add(h, label)));
  // a new depth grows rings that can land under the drawer: bring what grew from the picked item (or the center) into the room
  const setDepthTo = (d: number) => {
    const next = Math.max(1, Math.min(3, d));
    if (next === depth) return;
    setDepth(next);
    if (!atBrain) show([sel && sel !== BRAIN ? sel : center]);
  };
  const toggleAll = () => {
    const on = !expanded;
    setAll(on);
    if (on && !atBrain) setTrail([BRAIN]);
    if (!on) setOpen(new Set());
    reset();
    setReveal((r) => ({ ids: [], n: (r?.n ?? 0) + 1, all: true }));
  };
  const zoomBy = (factor: number) => setZoom((z) => ({ n: z.n + 1, factor }));

  const onKey = (e: React.KeyboardEvent): boolean => {
    if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      toggleAll();
      return true;
    }
    if (e.key === '[' || e.key === ']') {
      setDepthTo(depth + (e.key === ']' ? 1 : -1));
      return true;
    }
    if (e.key === 'Escape') {
      if (sel) setSel(undefined);
      else if (trail.length > 1) back(trail.length - 2);
      else if (expanded) toggleAll();
      else if (open.size) setOpen(new Set());
      return true;
    }
    if (e.key === 'Enter' && sel && sel !== center && ix.byId.has(sel) && !(e.target as HTMLElement).closest('button')) {
      recenter(sel);
      return true;
    }
    return false;
  };

  // ----- what shows ------------------------------------------------------------------
  const selected = sel ? ix.byId.get(sel) : undefined;
  const drawer = !!selected && !phone;
  const insets: Insets = phone ? { top: headH + 8, right: 12, bottom: selected ? Math.round(boxH * 0.5) : footH + 8, left: 12 } : { top: headH + 16, right: drawer ? 384 : 32, bottom: footH + 12, left: 32 };
  const span = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of g.nodes) if (n.at) (lo = Math.min(lo, n.at)), (hi = Math.max(hi, n.at)); // prettier-ignore
    return { lo, hi };
  }, [g]);
  const faded = (p: PNode) => {
    const n = p.item;
    if (!n) return false;
    if (at !== undefined && n.at && n.at > at) return true;
    return source !== 'all' && n.source !== source && n.source !== 'both';
  };
  const existed = at === undefined ? g.nodes.length : g.nodes.filter((n) => !n.at || n.at <= at).length;
  // brain view: the same filters, by node index
  const gone = useMemo(() => (i: number) => {
    const n = g.nodes[i];
    return (at !== undefined && !!n.at && n.at > at) || (source !== 'all' && n.source !== source && n.source !== 'both');
  }, [g, at, source]); // prettier-ignore
  const brainFilter = useMemo(() => ({ hidden, crossOnly }), [hidden, crossOnly]);
  const brainOn = useMemo(() => brain?.edges.filter((e) => edgeOn(brain, e, { ...brainFilter, gone })), [brain, brainFilter, gone]);
  const bFocus = bHover ?? bArea;
  const relations = ix.labels.slice(0, phone ? 14 : 9);
  const offline = g.basicMemory.state === 'offline';

  const crumbs: Array<{ label: string; go?: () => void }> = [{ label: 'Brain', go: trail.length > 1 || open.size ? () => (trail.length > 1 ? back(0) : (setOpen(new Set()), setSel(undefined), setFit((f) => f + 1))) : undefined }];
  const crumbArea = trail.length > 1 ? ix.byId.get(trail[1])?.area : area && open.has(areaId(area)) ? area : undefined;
  if (crumbArea) crumbs.push({ label: crumbArea, go: trail.length > 1 ? () => toArea(crumbArea) : undefined });
  trail.slice(1).forEach((id, i) => crumbs.push({ label: labelOf(id), go: i + 2 < trail.length ? () => back(i + 1) : undefined }));
  const trailNav = (
    <nav aria-label="Where you are" className="flex min-w-0 items-baseline gap-1.5 overflow-hidden text-[13px] whitespace-nowrap phone:text-[14px]">
      {crumbs.slice(-4).map((c, i, all) => {
        const last = i === all.length - 1;
        return (
          <span key={`${c.label}-${i}`} className={cn('flex min-w-0 items-baseline gap-1.5', last ? 'shrink-0' : 'shrink')}>
            {i > 0 && <span className="text-fg-4">/</span>}
            {c.go ? (
              <button type="button" className="tap truncate text-fg-3 hov:text-fg" onClick={c.go}>
                {c.label}
              </button>
            ) : (
              <span className="truncate font-medium text-fg" aria-current="location">
                {c.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );

  const folded = !atBrain && layout.nodes.some((p) => p.t.kind === 'node' && p.count && p.t.depth >= 1 && depth > p.t.depth);
  // a search path in words: every step of it, each one goes there (a phone shows the end of a long one)
  const chain = found?.pairs.length && !note && mode === 'tree' ? [found.pairs[0][0], ...found.pairs.map((p) => p[1])] : undefined;
  const pathNav = chain && (
    <nav aria-label="Path" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px] phone:text-[14px]">
      <span className="text-fg-3">Path</span>
      {chain.map((id, i) => (
        <span key={id} className="flex items-baseline gap-x-1.5">
          {i > 0 && <span className="text-fg-4">›</span>}
          <button type="button" className={cn('tap hov:text-fg', i === chain.length - 1 ? 'font-medium text-fg' : 'text-fg-2')} onClick={() => show([id])}>
            {id.startsWith('area:') ? id.slice(5) : labelOf(id)}
          </button>
        </span>
      ))}
    </nav>
  );
  const sentence = (
    <p className={cn('m-0 text-[13px] phone:text-[14px]', offline ? 'text-warn' : 'text-fg-2')} aria-live="polite">
      {note ??
        (brain && brainOn ? (
          <BrainWords l={brain} on={brainOn} focus={bFocus} ix={ix} />
        ) : expanded ? (
          <>
            All <span className="num">{num(g.nodes.length)}</span> items in <span className="num">{ix.areas.length}</span> areas. The most linked read first; zoom in for the rest.
          </>
        ) : atBrain ? (
          <>
            <span className="num">{num(g.nodes.length)}</span> items in <span className="num">{ix.areas.length}</span> areas
            {offline ? '. Basic Memory is offline, so only Conclave memory is shown' : open.size ? '' : '. Open an area to see what is in it'}.
          </>
        ) : (
          <>
            <span className="num">{tree.items.size - 1}</span> items around {labelOf(center)}, which has <span className="num">{centerNode?.degree ?? 0}</span> links
            {hidden.size ? `. ${[...hidden].map(cap).join(', ')} hidden` : ''}
            {folded ? '. Deeper links fold into counts until you zoom in' : ''}.
          </>
        ))}
    </p>
  );

  const searchBox = (
    <Input
      value={q}
      onChange={(e) => (setQ(e.target.value), setHit(-1))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          setQ('');
          setFound(undefined);
          setNote(undefined);
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder="Search memory"
      aria-label="Search memory. Enter goes to the next match, Shift+Enter to the one before."
      enterKeyHint="search"
      suffix={q.trim().length >= 2 ? <span className="num text-[12px] whitespace-nowrap text-fg-3" aria-live="polite">{hits.length ? `${hit >= 0 ? `${hit + 1} of ` : ''}${num(hits.length)}` : 'none'}</span> : undefined}
      className={phone ? 'text-[15px]' : undefined}
    />
  );

  const depthControl = <Segmented label="Depth" size="sm" value={String(depth)} onChange={(v) => setDepthTo(Number(v))} options={[1, 2, 3].map((d) => ({ value: String(d), label: String(d), title: `${d} ${d === 1 ? 'link' : 'links'} out` }))} />;
  const zoomButtons = (
    <div className="flex items-center">
      <ZoomButton label="Zoom out" onClick={() => zoomBy(0.8)} phone={phone}>
        <Minus className="size-4" strokeWidth={1.75} aria-hidden />
      </ZoomButton>
      <ZoomButton label="Zoom in" onClick={() => zoomBy(1.25)} phone={phone}>
        <Plus className="size-4" strokeWidth={1.75} aria-hidden />
      </ZoomButton>
    </div>
  );
  const relationFilter = (
    <div role="group" aria-label="Relations" className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
      {!phone && <span className="text-[12.5px] text-fg-3">Relations</span>}
      {relations.map(({ label, count }) => {
        const on = !hidden.has(label);
        return (
          <button key={label} type="button" aria-pressed={on} onClick={() => toggleRelation(label)} className={cn('tap text-[13px] font-medium whitespace-nowrap transition-colors duration-[var(--dur-1)] phone:text-[14px]', on ? 'text-fg' : 'text-fg-4 hov:text-fg-2')}>
            <span className={on ? 'underline decoration-1 underline-offset-[3px]' : 'line-through decoration-1'}>{label}</span>
            <span className="num ml-1 font-[450] text-fg-3">{num(count)}</span>
          </button>
        );
      })}
    </div>
  );
  const sourceFilter = (
    <FilterLinks
      label="Source"
      value={source}
      onChange={setSource}
      options={[
        { value: 'all', label: 'Both stores' },
        { value: 'conclave', label: 'Conclave' },
        { value: 'basic-memory', label: 'Basic Memory' },
      ]}
    />
  );
  const crossFilter = brain && (
    <button type="button" aria-pressed={crossOnly} onClick={() => setCrossOnly((c) => !c)} className={cn('tap text-[13px] font-medium whitespace-nowrap phone:text-[14px]', crossOnly ? 'text-fg' : 'text-fg-3 hov:text-fg')}>
      <span className={crossOnly ? 'underline decoration-1 underline-offset-[3px]' : undefined}>Across areas only</span>
    </button>
  );
  const legend =
    mode === 'brain'
      ? 'Each tick on the outline is an item, longer the more it links; each curve is a real link, bundled through its areas, crossing the middle between the halves.'
      : 'A tick under a title: Conclave memory. Dashed: also in Basic Memory. None: a Basic Memory note.';
  const switchMode = (m: Mode) => {
    setMode(m);
    setBHover(undefined);
    setBArea(undefined);
    setHover(undefined);
  };
  const modeToggle = (
    <div role="group" aria-label="View" className="flex shrink-0 items-baseline gap-1.5 text-[13px] phone:text-[14px]">
      {(['tree', 'brain'] as const).map((m, i) => (
        <span key={m} className="flex items-baseline gap-1.5">
          {i > 0 && <span className="text-fg-4">/</span>}
          <button type="button" aria-pressed={mode === m} onClick={() => switchMode(m)} className={cn('tap', mode === m ? 'font-medium text-fg' : 'text-fg-3 hov:text-fg')}>
            {cap(m)}
          </button>
        </span>
      ))}
    </div>
  );
  const expandButton = (
    <Button variant="quiet" size="sm" onClick={toggleAll} title={expanded ? 'Collapse all (E)' : 'Expand all (E)'}>
      {expanded ? 'Collapse all' : 'Expand all'}
    </Button>
  );

  const detail = selected && (
    <Detail
      n={selected}
      ix={ix}
      center={center}
      onMap={tree.items}
      hidden={hidden}
      open={open.has(selected.id)}
      phone={phone}
      brain={!!brain}
      onClose={() => setSel(undefined)}
      onCenter={() => (switchMode('tree'), recenter(selected.id))}
      onToggle={() => setOpen((o) => (o.has(selected.id) ? del(o, selected.id) : add(o, selected.id)))}
      onDismiss={() => dismiss(selected.id)}
      onDismissOthers={() => dismissOthers(selected.id)}
      onPath={() => pathTo(selected.id)}
      onPull={(id) => (brain ? setSel(id) : pull(selected.id, id))}
    />
  );

  return (
    <div ref={boxRef} className="relative -mx-[var(--gutter)] min-h-[420px] flex-1 overflow-hidden border-t border-rule bg-bg">
      {brain ? (
        <BrainCanvas
          ix={ix}
          layout={brain}
          filter={brainFilter}
          gone={gone}
          hits={hitSet}
          hit={hit >= 0 ? hits[hit]?.id : undefined}
          selected={sel}
          hover={bFocus}
          onHover={setBHover}
          onPick={(id) => (setSel(id), setBArea(undefined))}
          onArea={(name) => setBArea((a) => (a === areaId(name) ? undefined : areaId(name)))}
          onBlank={() => (setSel(undefined), setBArea(undefined))}
          insets={insets}
          fit={fit}
          zoom={zoom}
          phone={phone}
          measure={measure}
          className="absolute inset-0"
        />
      ) : (
        <MemoryCanvas
          layout={layout}
          ix={ix}
          items={tree.items}
          selected={sel}
          hover={hover}
          onHover={setHover}
          onPick={pick}
          onCenter={recenter}
          onBlank={() => (setSel(undefined), setNote(undefined))}
          path={path}
          hits={hitSet}
          faded={faded}
          insets={insets}
          fit={fit}
          zoom={zoom}
          reveal={reveal}
          onUnfold={setUnfold}
          onKey={onKey}
          measure={measure}
          className="absolute inset-0"
        />
      )}

      {/* solid bands above and below, so a tall tree passes under them, not through the words */}
      <div ref={headRef} className={cn('absolute top-0 left-0 z-[5] border-b border-rule bg-bg', phone ? 'right-0 space-y-2 px-4 pt-2 pb-2' : 'space-y-2 px-8 pt-3 pb-3')} style={phone ? undefined : { right: drawer ? 360 : 0 }}>
        {phone ? (
          <>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">{searchBox}</div>
              {modeToggle}
            </div>
            {!brain && crumbs.length > 1 && trailNav}
            {pathNav}
            {(note || (brain && bFocus)) && sentence}
          </>
        ) : (
          <>
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">{brain ? <span className="text-[13px] font-medium text-fg">How memories connect across areas</span> : trailNav}</div>
              <div className="flex shrink-0 items-center gap-3">
                {!brain && !atBrain && (
                  <>
                    <span className="text-[12.5px] text-fg-3">Depth</span>
                    {depthControl}
                  </>
                )}
                {!brain && expandButton}
                {zoomButtons}
                <Button variant="quiet" size="sm" onClick={() => setFit((f) => f + 1)} title="Fit (0)">
                  Fit
                </Button>
                <span className="h-4 w-px bg-rule-2" aria-hidden />
                {modeToggle}
              </div>
            </div>
            {pathNav ?? sentence}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="w-[280px] shrink-0">{searchBox}</div>
              {relationFilter}
              {crossFilter}
              {sourceFilter}
            </div>
          </>
        )}
      </div>

      <div ref={footRef} className={cn('absolute bottom-0 left-0 z-[5] border-t border-rule bg-bg', phone ? 'right-0 px-4 pb-[calc(var(--safe-b)+6px)]' : 'px-8 pt-2 pb-2')} style={phone ? undefined : { right: drawer ? 360 : 0 }}>
        {phone ? (
          <div className="flex items-center justify-between gap-2 pt-2">
            {brain ? <span className="min-w-0 truncate text-[13px] text-fg-3">{num(g.nodes.length)} items</span> : atBrain ? expandButton : depthControl}
            <div className="flex items-center gap-1.5">
              {zoomButtons}
              <Button variant="outline" size="sm" onClick={() => setFilters(true)}>
                Filters{hidden.size || source !== 'all' ? ` (${hidden.size + (source !== 'all' ? 1 : 0)})` : ''}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setFit((f) => f + 1)}>
                Fit
              </Button>
            </div>
          </div>
        ) : (
          <p className={cn('m-0 text-[12px] text-fg-3 transition-opacity duration-[var(--dur-2)]', at !== undefined && 'opacity-0')}>{legend} {brain ? 'Hover lights an item or area, click opens.' : 'Click opens, double click centers, E expands all, Esc steps back.'}</p>
        )}
        {span.hi > span.lo && <TimeScrubber from={span.lo} to={span.hi} at={at} onChange={setAt} phone={phone} shown={`${num(existed)} existed`} />}
      </div>

      {drawer && (
        <aside aria-label={`${nodeLabel(selected)}, details`} className="anim-right absolute inset-y-0 right-0 z-10 flex w-[360px] max-w-full flex-col border-l border-rule bg-bg">
          {detail}
        </aside>
      )}
      {/* phones: a half-height panel, not a modal sheet, so the map above it still pans and takes taps */}
      {phone && selected && (
        <aside aria-label={`${nodeLabel(selected)}, details`} className="anim-sheet absolute inset-x-0 bottom-0 z-10 flex h-[50%] flex-col rounded-t-[var(--r-3)] border-t border-rule-2 bg-raise pb-safe">
          <button type="button" aria-label="Close" onClick={() => setSel(undefined)} className="absolute top-1 right-2 grid size-11 place-items-center rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg">
            <X className="size-5" strokeWidth={1.75} aria-hidden />
          </button>
          <div className="flex min-h-0 flex-1 flex-col pt-4">{detail}</div>
        </aside>
      )}
      {phone && (
        <Sheet open={filters} onClose={() => setFilters(false)} title="Filters">
          <div className="space-y-4 px-4 pb-4">
            {sentence}
            <div>
              <h3 className="m-0 mb-1.5 text-[13px] font-medium text-fg-3">Relations</h3>
              {relationFilter}
              {crossFilter && <div className="mt-2">{crossFilter}</div>}
            </div>
            <div>
              <h3 className="m-0 mb-1.5 text-[13px] font-medium text-fg-3">Source</h3>
              {sourceFilter}
            </div>
            <p className="m-0 text-[13px] text-fg-3">{legend}</p>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** An element's height, kept up to date. */
function useHeight(ref: React.RefObject<HTMLElement | null>, guess: number): number {
  const [h, setH] = useState(guess);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

/** The brain view's sentence: what is drawn, or what the lit area or item links to. */
function BrainWords({ l, on, focus, ix }: { l: BrainLayout; on: BrainLayout['edges']; focus?: string; ix: Indexed }) {
  const cross = on.filter((e) => e.cross).length;
  const area = focus?.startsWith('area:') ? l.areas.findIndex((a) => areaId(a.name) === focus) : -1;
  const item = focus && area < 0 ? l.byId.get(focus) : undefined;
  if (area >= 0 || item !== undefined) {
    const mine = (i: number) => (area >= 0 ? l.items[i].area === area : i === item);
    const to = new Map<number, number>();
    let n = 0;
    for (const e of on)
      for (const [a, b] of [[e.a, e.b], [e.b, e.a]] as const)
        if (mine(a)) {
          n++;
          const other = l.items[b].area;
          if (other !== (area >= 0 ? area : l.items[a].area)) to.set(other, (to.get(other) ?? 0) + 1);
        }
    const top = [...to].sort((x, y) => y[1] - x[1]).slice(0, 3);
    const name = area >= 0 ? l.areas[area].name : nodeLabel(ix.byId.get(focus!)!);
    const size = area >= 0 ? `${num(l.areas[area].to - l.areas[area].from)} items, ` : `${l.areas[l.items[item!].area].name}, `;
    return (
      <>
        {name}: {size}
        <span className="num">{num(n)}</span> {n === 1 ? 'link' : 'links'} shown
        {top.length ? `, most to ${top.map(([a, c]) => `${l.areas[a].name} ${num(c)}`).join(', ')}` : ''}.
      </>
    );
  }
  const left = l.hemi[-1].names.filter((x) => RECORDS.includes(x));
  return (
    <>
      <span className="num">{num(l.items.length)}</span> items, <span className="num">{num(on.length)}</span> links shown, <span className="num">{num(cross)}</span> across areas.
      {left.length ? ` Left: what was said (${left.join(', ')}). Right: what it is about.` : ''}
    </>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-[320px] flex-1 place-items-center px-6 text-center text-[14px] text-fg-3" role="status">
      {children}
    </div>
  );
}

function ZoomButton({ label, onClick, children, phone }: { label: string; onClick: () => void; children: ReactNode; phone: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cn('grid place-items-center rounded-[var(--r-1)] text-fg-3 transition-colors duration-[var(--dur-1)] hov:bg-hover hov:text-fg', phone ? 'size-9' : 'size-[26px]')}>
      {children}
    </button>
  );
}

const when = (t?: number) => (t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : undefined);

function Detail(props: {
  n: MemoryGraphNode;
  ix: Indexed;
  center: string;
  onMap: Set<string>;
  hidden: ReadonlySet<string>;
  open: boolean;
  phone: boolean;
  /** Opened from the brain view: no tree to open links in or dismiss from; Center here goes to the tree. */
  brain?: boolean;
  onClose: () => void;
  onCenter: () => void;
  onToggle: () => void;
  onDismiss: () => void;
  onDismissOthers: () => void;
  onPath: () => void;
  onPull: (id: string) => void;
}) {
  const { n, ix, hidden, open, phone } = props;
  const center = props.brain ? '' : props.center;
  // the brain view draws every item: all of them are on it
  const onMap = props.brain ? new Set<string>() : props.onMap;
  const [all, setAll] = useState<ReadonlySet<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => scroller.current?.scrollTo({ top: 0 }), [n.id]);
  const groups = new Map<string, string[]>();
  for (const l of ix.nbrs.get(n.id) ?? []) groups.set(l.label, [...(groups.get(l.label) ?? []), l.id]);
  const order = [...groups].sort((a, b) => Number(hidden.has(a[0])) - Number(hidden.has(b[0])) || b[1].length - a[1].length);
  const isCenter = n.id === center;
  const size = phone ? 'touch' : 'sm';
  return (
    <>
      <div className={cn('flex shrink-0 items-start gap-2', phone ? 'pr-14 pb-1 pl-4' : 'px-5 pt-4 pb-1')}>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-fg-3 phone:text-[13px]">
            {nodeWords(n)}
            {n.area ? `, ${n.area}` : ''}
            {isCenter ? ', the center' : onMap.has(n.id) || props.brain ? '' : ', not on the map'}
          </div>
          <h2 className="t-title m-0 mt-0.5 line-clamp-4 break-words text-fg">{n.title}</h2>
          <div className="mt-1 text-[13px] text-fg-3 phone:text-[14px]">
            <span className="num">{n.degree}</span> links{when(n.at) && `, changed ${when(n.at)}`}
          </div>
        </div>
        {!phone && (
          <button type="button" aria-label="Close" onClick={props.onClose} className="-mr-2 grid size-8 shrink-0 place-items-center rounded-[var(--r-1)] text-fg-3 hov:bg-hover hov:text-fg">
            <X className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
      <div className={cn('flex shrink-0 flex-wrap items-center gap-2', phone ? 'px-4 pt-2' : 'px-5 pt-2')}>
        {!isCenter && (
          <Button variant="solid" size={size} onClick={props.onCenter}>
            Center here
          </Button>
        )}
        {!isCenter && onMap.has(n.id) && (
          <Button variant="outline" size={size} onClick={props.onToggle}>
            {open ? 'Show fewer' : 'Open links'}
          </Button>
        )}
        {!isCenter && !onMap.has(n.id) && !props.brain && (
          <Button variant="outline" size={size} onClick={props.onPath}>
            Show the path
          </Button>
        )}
      </div>
      <div className={cn('flex shrink-0 flex-wrap gap-x-4 gap-y-1 text-[13px] phone:text-[14px]', phone ? 'px-4 pt-2' : 'px-5 pt-2.5')}>
        {!isCenter && onMap.has(n.id) && (
          <button type="button" className="link" onClick={props.onDismiss}>
            Dismiss
          </button>
        )}
        {onMap.has(n.id) && (
          <button type="button" className="link" onClick={props.onDismissOthers}>
            Dismiss the rest
          </button>
        )}
        {n.memoryId && (
          <Link href={`/memory?focus=${n.memoryId}`} className="link">
            Open in Notes
          </Link>
        )}
      </div>
      <div ref={scroller} className={cn('min-h-0 flex-1 overflow-y-auto', phone ? 'px-4 pb-3' : 'px-5 pb-4')}>
        {order.map(([label, ids]) => {
          const cut = all.has(label) ? ids : ids.slice(0, 6);
          return (
            <section key={label} className="mt-4 border-t border-rule pt-3">
              <h3 className="m-0 mb-1 text-[12px] font-medium text-fg-3 phone:text-[13px]">
                {label} <span className="num font-normal">{ids.length}</span>
                {hidden.has(label) && <span className="font-normal">, hidden on the map</span>}
              </h3>
              <ul className="m-0 list-none p-0">
                {cut.map((id) => (
                  <li key={id}>
                    <button type="button" onClick={() => props.onPull(id)} className="-mx-2 flex w-[calc(100%+16px)] items-baseline gap-3 rounded-[var(--r-1)] px-2 py-1 text-left hov:bg-hover phone:py-2">
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg phone:text-[15px]">{nodeLabel(ix.byId.get(id)!)}</span>
                      <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">{props.brain ? ix.byId.get(id)?.area : id === center ? 'center' : onMap.has(id) ? 'on the map' : 'add'}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {ids.length > cut.length && (
                <button type="button" className="mt-0.5 text-[12.5px] text-fg-3 underline decoration-rule-2 underline-offset-2 hov:text-fg phone:text-[14px]" onClick={() => setAll((a) => add(a, label))}>
                  {ids.length - cut.length} more
                </button>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
