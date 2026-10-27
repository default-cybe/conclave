/**
 * Memory > Map: Conclave memories and Basic Memory notes in one graph
 * (GET /api/memory/graph). Filled marks are Conclave memories, rings are
 * Basic Memory notes, a filled mark in a ring is a memory mirrored as a
 * note; small squares are the tags and sessions memories share. Edges are
 * only real links, drawn faint until a node is picked; then its links and
 * neighbors stand out and the rest steps back. Labels never overlap (see
 * graph-model.ts placeLabels); more show as the owner zooms in. Drag to pan,
 * wheel or + and - to zoom, arrows pan, Tab walks the nodes, Enter opens
 * one. The map is still: nothing animates.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { Link } from 'wouter';
import { X } from 'lucide-react';
import type { MemoryGraph, MemoryGraphNode } from '@conclave/core/client';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { Input } from '@/components/ui/Field';
import { IconButton } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Overlay';
import { FilterLinks } from '@/components/ui/Tags';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { FIRST_LIMIT, labelBudget, layoutGraph, linksOf, markRadius, nextLimit, nodeLabel, nodeWords, placeLabels, statusLine, visibleIds, type KindFilter, type SourceFilter } from './graph-model';

export function MemoryMapTab() {
  const mobile = useIsMobile();
  const [g, setG] = useState<MemoryGraph | null>(null);
  const [limit, setLimit] = useState(FIRST_LIMIT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [source, setSource] = useState<SourceFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string>();
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api()
      .memoryGraph(limit)
      .then((r) => alive && (setG(r), setSel(undefined)))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [limit]);

  const pos = useMemo(() => (g ? layoutGraph(g) : new Map()), [g]);
  const byId = useMemo(() => new Map((g?.nodes ?? []).map((n) => [n.id, n])), [g]);
  const shown = useMemo(() => (g ? visibleIds(g, { source, kind, q }) : new Set<string>()), [g, source, kind, q]);
  const near = useMemo(() => new Set(g && sel ? linksOf(g, sel).map((l) => l.id) : []), [g, sel]);
  const labelled = useMemo(() => {
    const byDegree = (ids: Iterable<string>) => [...ids].map((id) => byId.get(id)).filter((n): n is MemoryGraphNode => !!n && shown.has(n.id) && n.kind !== 'session').sort((a, b) => b.degree - a.degree);
    // a picked node labels itself and its neighbors only, so its star reads alone
    const order = sel ? [byId.get(sel)!, ...byDegree(near)] : byDegree(shown);
    return placeLabels(order.map((n) => ({ id: n.id, text: nodeLabel(n) })), pos, view.k, sel ? 80 : q.trim() ? 60 : labelBudget(view.k), size.w ? { x: view.x, y: view.y, ...size } : undefined);
  }, [shown, byId, sel, near, q, pos, view, size]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [g]);

  // fit the drawing to the box once a graph is laid out
  useEffect(() => {
    const el = box.current;
    if (!el || !pos.size) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; // prettier-ignore
    for (const p of pos.values()) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
    const { width, height } = el.getBoundingClientRect();
    const k = Math.min(2, Math.max(0.15, Math.min(width / (x1 - x0 + 160), height / (y1 - y0 + 60))));
    setView({ k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k });
  }, [pos]);

  // a picked node moves to the middle of what the drawer leaves free (at once: the map never animates)
  useEffect(() => {
    const p = sel ? pos.get(sel) : undefined;
    const el = box.current;
    if (!p || !el) return;
    // on a phone the sheet covers the bottom: bring the map to the top so its star shows above it
    if (mobile) el.scrollIntoView({ block: 'start', behavior: 'instant' });
    const { width, height } = el.getBoundingClientRect();
    const free = mobile ? width : width - 340;
    setView((v) => ({ ...v, x: free / 2 - p.x * v.k, y: (mobile ? height * 0.27 : height / 2) - p.y * v.k }));
  }, [sel, pos, mobile]);

  const zoom = (f: number, cx?: number, cy?: number) =>
    setView((v) => {
      const r = box.current?.getBoundingClientRect();
      const px = cx ?? (r?.width ?? 0) / 2;
      const py = cy ?? (r?.height ?? 0) / 2;
      const k = Math.min(4, Math.max(0.1, v.k * f));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });

  const onWheel = (e: WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  const onDown = (e: PointerEvent) => {
    if ((e.target as Element).closest('[data-node]')) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [mx, my] = [e.clientX - d.x, e.clientY - d.y];
    if (Math.abs(mx) + Math.abs(my) > 2) d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setView((v) => ({ ...v, x: v.x + mx, y: v.y + my }));
  };
  const onUp = () => {
    if (drag.current && !drag.current.moved) setSel(undefined);
    drag.current = null;
  };
  const onKey = (e: KeyboardEvent) => {
    const step = 60;
    const keys: Record<string, () => void> = {
      '+': () => zoom(1.25),
      '=': () => zoom(1.25),
      '-': () => zoom(0.8),
      ArrowLeft: () => setView((v) => ({ ...v, x: v.x + step })),
      ArrowRight: () => setView((v) => ({ ...v, x: v.x - step })),
      ArrowUp: () => setView((v) => ({ ...v, y: v.y + step })),
      ArrowDown: () => setView((v) => ({ ...v, y: v.y - step })),
      Escape: () => setSel(undefined),
    };
    if (!keys[e.key] || (e.target as Element).closest('input')) return;
    e.preventDefault();
    keys[e.key]();
  };

  if (error) return <EmptyState>The memory map did not load: {error}</EmptyState>;
  if (!g) return <LoadingRows loading rows={4} />;
  if (!g.nodes.length) return <EmptyState>Nothing to map yet. Notes show here once sessions save memories.</EmptyState>;

  const selected = sel ? byId.get(sel) : undefined;
  const more = nextLimit(g.limit, g.total);
  const edges = g.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
  const hot = sel ? edges.filter((e) => e.from === sel || e.to === sel) : [];
  const line = (e: MemoryGraph['edges'][number], i: number, on: boolean) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const dashed = e.kind === 'tag' || e.kind === 'session';
    return (
      <line
        key={i}
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke={on ? 'var(--fg-2)' : 'var(--rule-2)'}
        strokeOpacity={on ? 1 : sel ? 0.18 : 0.55}
        strokeWidth={(on ? 1.3 : 0.6) / view.k}
        strokeDasharray={dashed ? `${3 / view.k} ${3 / view.k}` : undefined}
      />
    );
  };
  const detail = selected && <Detail g={g} n={selected} byId={byId} onSelect={setSel} onClose={() => setSel(undefined)} sheet={mobile} />;

  return (
    <div className="space-y-4" onKeyDown={onKey}>
      <div className="space-y-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the map" aria-label="Search the map" enterKeyHint="search" className="text-[14px]" />
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <FilterLinks
            label="Source"
            value={source}
            onChange={setSource}
            options={[
              { value: 'all', label: 'Both' },
              { value: 'conclave', label: 'Conclave' },
              { value: 'basic-memory', label: 'Basic Memory' },
            ]}
          />
          <span aria-hidden className="hidden h-3.5 w-px self-center bg-rule-2 sm:block" />
          <FilterLinks
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: 'All' },
              { value: 'fact', label: 'Facts' },
              { value: 'procedure', label: 'Procedures' },
              { value: 'profile', label: 'Profile' },
              { value: 'episode', label: 'Episodes' },
              { value: 'note', label: 'Notes' },
            ]}
          />
        </div>
        <p className={cn('m-0 text-[12px] phone:text-[13px]', g.basicMemory.state === 'offline' ? 'text-warn' : 'text-fg-3')} role="status">
          {statusLine(g, [...shown].filter((id) => !id.startsWith('tag:') && !id.startsWith('ses:')).length)}
          {more && (
            <>
              {' '}
              <button type="button" className="link" disabled={loading} onClick={() => setLimit(more)}>
                {loading ? 'Loading' : `Show up to ${more.toLocaleString('en-US')}`}
              </button>
            </>
          )}
        </p>
      </div>
      <div className="relative">
        <div
          ref={box}
          className="relative h-[min(68vh,720px)] min-h-[360px] touch-none overflow-hidden border-y border-rule bg-bg-sunk outline-none focus-visible:ring-2 focus-visible:ring-signal phone:-mx-4"
          tabIndex={0}
          aria-label="Memory map. Drag or use the arrow keys to move, plus and minus to zoom, Tab to walk the items."
          onWheel={onWheel}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        >
          <svg className="absolute inset-0 h-full w-full select-none" role="group" aria-label={`${shown.size} items`}>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {edges.map((e, i) => (sel && (e.from === sel || e.to === sel) ? null : line(e, i, false)))}
              {hot.map((e, i) => line(e, -1 - i, true))}
              {g.nodes.map((n) =>
                shown.has(n.id) ? <Mark key={n.id} n={n} p={pos.get(n.id)!} k={view.k} selected={n.id === sel} dim={!!sel && n.id !== sel && !near.has(n.id)} onSelect={() => setSel(n.id === sel ? undefined : n.id)} /> : null,
              )}
              {/* labels on top of every mark, so no mark covers one */}
              <g aria-hidden className="pointer-events-none">
                {[...labelled].map((id) => {
                  const n = byId.get(id)!;
                  const p = pos.get(id)!;
                  return (
                    <text key={id} x={p.x + markRadius(p.r, view.k) / view.k + 4 / view.k} y={p.y} dominantBaseline="central" fontSize={12 / view.k} fill={id === sel ? 'var(--fg)' : 'var(--fg-2)'} stroke="var(--bg-sunk)" strokeWidth={4 / view.k} paintOrder="stroke" style={{ fontWeight: id === sel ? 560 : 450 }}>
                      {nodeLabel(n)}
                    </text>
                  );
                })}
              </g>
            </g>
          </svg>
          <div className="absolute right-2 bottom-2 flex gap-1">
            <IconButton label="Zoom in" size="sm" onClick={() => zoom(1.25)}>
              <span aria-hidden className="text-[15px] leading-none">+</span>
            </IconButton>
            <IconButton label="Zoom out" size="sm" onClick={() => zoom(0.8)}>
              <span aria-hidden className="text-[15px] leading-none">−</span>
            </IconButton>
          </div>
          <p className="pointer-events-none absolute bottom-2 left-3 m-0 text-[11px] text-fg-3 phone:text-[12px]">Filled: Conclave. Ring: Basic Memory. Both: mirrored.</p>
        </div>
        {!mobile && detail}
      </div>
      {mobile && (
        <Sheet open={!!selected} onClose={() => setSel(undefined)} label="Selected item">
          {detail}
        </Sheet>
      )}
    </div>
  );
}

function Mark({ n, p, k, selected, dim, onSelect }: { n: MemoryGraphNode; p: { x: number; y: number; r: number }; k: number; selected: boolean; dim: boolean; onSelect: () => void }) {
  const hub = n.kind === 'tag' || n.kind === 'session';
  // world units; on screen it is markRadius(p.r, k)
  const r = markRadius(p.r, k) / k;
  const text = nodeLabel(n);
  return (
    <g
      data-node
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${text}. ${nodeWords(n)}. ${n.degree} links.`}
      className="cursor-pointer outline-none [&:focus-visible>.ring]:stroke-signal"
      opacity={dim ? 0.18 : 1}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), onSelect());
      }}
    >
      <title>{n.title}</title>
      {hub ? (
        <rect x={p.x - r * 0.8} y={p.y - r * 0.8} width={r * 1.6} height={r * 1.6} fill="var(--fg-4)" />
      ) : (
        <>
          {n.source !== 'conclave' && <circle cx={p.x} cy={p.y} r={r} fill="var(--bg-sunk)" stroke="var(--fg-3)" strokeWidth={1.2 / k} />}
          {n.source !== 'basic-memory' && <circle cx={p.x} cy={p.y} r={n.source === 'both' ? r * 0.55 : r} fill="var(--fg)" />}
        </>
      )}
      <circle className="ring" cx={p.x} cy={p.y} r={r + 4 / k} fill="transparent" stroke={selected ? 'var(--signal)' : 'transparent'} strokeWidth={2 / k} />
    </g>
  );
}

function Detail({ g, n, byId, onSelect, onClose, sheet }: { g: MemoryGraph; n: MemoryGraphNode; byId: Map<string, MemoryGraphNode>; onSelect: (id: string) => void; onClose: () => void; sheet: boolean }) {
  const links = linksOf(g, n.id);
  return (
    <aside aria-label="Selected item" className={cn('overflow-y-auto', sheet ? 'max-h-[42dvh] px-5 pb-4' : 'absolute top-0 right-0 h-full w-[340px] border-l border-rule bg-bg px-5 py-4')}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">{nodeWords(n)}</p>
          <p className="t-prose m-0 mt-1 break-words text-fg">{n.kind === 'tag' ? `#${n.title}` : n.title}</p>
        </div>
        <IconButton label="Close" size={sheet ? 'touch' : 'sm'} onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 text-[13px]">
        {n.memoryId && (
          <Link href={`/memory?focus=${n.memoryId}`} className="link">
            Open in Notes
          </Link>
        )}
        {n.sessionId && (
          <Link href={`/s/${n.sessionId}`} className="link">
            Open the session
          </Link>
        )}
      </div>
      <h3 className="mt-5 mb-1 text-[13px] font-[560] text-fg">
        Links <span className="num font-normal text-fg-3">{links.length}</span>
      </h3>
      {links.length === 0 && <p className="m-0 text-[13px] text-fg-2">No links in either store.</p>}
      <ul className="m-0 list-none p-0">
        {links.slice(0, 60).map((l, i) => {
          const o = byId.get(l.id);
          return o ? (
            <li key={i} className="border-b border-rule py-1.5 text-[13px] phone:py-2.5 phone:text-[14px]">
              <span className="text-fg-3">{l.label} </span>
              <button type="button" className="link text-left" onClick={() => onSelect(l.id)}>
                {nodeLabel(o)}
              </button>
            </li>
          ) : null;
        })}
      </ul>
      {links.length > 60 && <p className="m-0 mt-1 text-[12px] text-fg-3">And {links.length - 60} more.</p>}
    </aside>
  );
}
