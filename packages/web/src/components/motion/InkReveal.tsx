import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/text';
import { onFrame } from './frame';
import { STREAM } from './tokens';
import { useReducedMotion } from './useReducedMotion';

/**
 * Ink: streamed text is revealed by a soft front along each line, newest
 * letters violet, cooling to ink about 0.3s behind the front. Nothing moves
 * or reflows: letters that have arrived but are not yet released are
 * painted transparent in place.
 *
 * Pace: words are released 40ms apart and never more than 320ms behind the
 * stream; a big chunk is spread evenly over what is left of the 320ms.
 *
 * It watches the rendered DOM, not the markdown source, so markdown renders
 * as usual (lists, code, tables), React keeps owning the nodes, and text
 * already on screen never animates again. Built on the CSS Custom Highlight
 * API: only the new letters repaint. Without the API, and under reduced
 * motion, text lands as it arrives.
 */
export function InkReveal({ active, children, className }: { active: boolean; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useInkReveal(ref, active);
  return (
    <div ref={ref} className={cn('cv-ink', className)} data-ink-live={(active && !reduced) || undefined}>
      {children}
    </div>
  );
}

/** Ages (ms since a letter's release) where each tier ends. Tier 0 is "not yet released". */
export const INK_TIERS = [0, 40, 90, 170, 250, 330] as const;
const DONE_AFTER = INK_TIERS[INK_TIERS.length - 1];
/** Text already on screen when streaming starts animates only if it is this short (a first chunk). */
const FIRST_CHUNK = 200;
/**
 * Boxes drawn around text (a code block, an inline code chip, a table, a
 * quote): each stays hidden until the front reaches its first letter, so an
 * empty box never shows ahead of its words.
 */
const BOXES = '.cv-code, [class~="group/code"], :not(pre) > code, table, blockquote';

interface InkBox {
  el: HTMLElement;
  /** char offset of its first letter */
  at: number;
  wait: boolean;
}

let tiers: Highlight[] | null | undefined;
function registry(): Highlight[] | null {
  if (tiers !== undefined) return tiers;
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return (tiers = null);
  tiers = INK_TIERS.map((_, i) => {
    const h = new Highlight();
    CSS.highlights.set(`cv-ink-${i}`, h);
    return h;
  });
  return tiers;
}

export interface InkRun {
  /** char offsets [start, end) of one word */
  start: number;
  end: number;
  /** its front crosses the word from t0 to t1 */
  t0: number;
  t1: number;
}

/**
 * Release times for `words` (char lengths) that arrive at `now`, after a
 * queue that last released a word at `queueEnd`. Pure, for tests.
 */
export function inkSchedule(lengths: number[], now: number, queueEnd: number, word: number = STREAM.word, lag: number = STREAM.lag): number[] {
  const n = lengths.length;
  if (!n) return [];
  const limit = now + lag;
  const s0 = Math.min(limit, Math.max(now, queueEnd + word));
  const gap = n > 1 ? Math.min(word, Math.max(0, (limit - s0) / (n - 1))) : word;
  return lengths.map((_, i) => s0 + i * gap);
}

/** The first char whose release time is after T (runs are in text order and in time order). */
export function inkBoundary(runs: readonly InkRun[], T: number, end: number): number {
  for (const r of runs) {
    if (T < r.t0) return r.start;
    if (T >= r.t1) continue;
    const k = (T - r.t0) / (r.t1 - r.t0);
    return Math.min(r.end, r.start + Math.floor(k * (r.end - r.start)) + 1);
  }
  return end;
}

interface Spot {
  node: Text;
  start: number;
}

function textMap(root: Node): { spots: Spot[]; total: number } {
  const spots: Spot[] = [];
  let total = 0;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    spots.push({ node: n, start: total });
    total += n.data.length;
  }
  return { spots, total };
}

function textOf(spots: Spot[], from: number): string {
  let out = '';
  for (const s of spots) {
    const end = s.start + s.node.data.length;
    if (end <= from) continue;
    out += s.node.data.slice(Math.max(0, from - s.start));
  }
  return out;
}

function rangeOf(spots: Spot[], a: number, b: number): StaticRange | null {
  if (b <= a || !spots.length) return null;
  const at = (off: number, isEnd: boolean): { node: Text; offset: number } | null => {
    let lo = 0;
    let hi = spots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (spots[mid].start < off || (!isEnd && spots[mid].start === off)) lo = mid;
      else hi = mid - 1;
    }
    const s = spots[lo];
    const o = Math.min(s.node.data.length, Math.max(0, off - s.start));
    return { node: s.node, offset: o };
  };
  const s = at(a, false);
  const e = at(b, true);
  if (!s || !e) return null;
  return new StaticRange({ startContainer: s.node, startOffset: s.offset, endContainer: e.node, endOffset: e.offset });
}

/** The hook behind InkReveal, for a container you already render. */
export function useInkReveal(ref: RefObject<HTMLElement | null>, active: boolean) {
  const reduced = useReducedMotion();
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const el = ref.current;
    const hl = registry();
    if (!el || reduced || !hl) return;
    let map = textMap(el);
    // what is on screen now is old text, unless this is the first chunk of a reply that mounted streaming
    let seen = activeRef.current && map.total <= FIRST_CHUNK ? 0 : map.total;
    let runs: InkRun[] = [];
    let queueEnd = -Infinity;
    let mine: StaticRange[][] = INK_TIERS.map(() => []);
    let stop: (() => void) | null = null;
    let boxes: InkBox[] = [];

    const clear = () => {
      mine.forEach((list, i) => list.forEach((r) => hl[i].delete(r)));
      mine = INK_TIERS.map(() => []);
    };
    const hold = (box: InkBox, wait: boolean) => {
      if (box.wait === wait) return;
      box.wait = wait;
      if (wait) box.el.setAttribute('data-ink-wait', '');
      else box.el.removeAttribute('data-ink-wait');
    };
    const release = () => {
      for (const box of boxes) hold(box, false);
    };
    const findBoxes = () => {
      const starts = new Map<Node, number>();
      for (const sp of map.spots) starts.set(sp.node, sp.start);
      const next: InkBox[] = [];
      for (const b of el.querySelectorAll<HTMLElement>(BOXES)) {
        const first = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
        const at = first ? starts.get(first) : undefined;
        if (at !== undefined) next.push({ el: b, at, wait: b.hasAttribute('data-ink-wait') });
      }
      boxes = next;
    };

    const paint = (now: number) => {
      clear();
      if (!runs.length) return false;
      const end = map.total;
      // boundaries, newest first: b[0] is the first letter not yet released
      const b = INK_TIERS.map((age) => inkBoundary(runs, now - age, end));
      for (const box of boxes) hold(box, box.at >= b[0]);
      for (let i = 0; i < INK_TIERS.length; i++) {
        const hi = i === 0 ? end : b[i - 1];
        const r = rangeOf(map.spots, b[i], hi);
        if (r) {
          hl[i].add(r);
          mine[i].push(r);
        }
      }
      const last = runs[runs.length - 1];
      if (now - last.t1 > DONE_AFTER) {
        runs = [];
        clear();
        release();
        return false;
      }
      // forget words that have fully cooled
      while (runs.length && now - runs[0].t1 > DONE_AFTER) runs.shift();
      return true;
    };

    const run = () => {
      if (stop) return;
      stop = onFrame((now) => {
        if (!paint(now)) {
          stop?.();
          stop = null;
        }
      });
    };

    const schedule = (from: number, now: number) => {
      const text = textOf(map.spots, from);
      const words = text.match(/\s*\S+\s*|\s+/g) ?? [];
      const lens = words.map((w) => w.length);
      const times = inkSchedule(lens, now, queueEnd);
      let off = from;
      words.forEach((w, i) => {
        const t0 = times[i];
        const next = i + 1 < times.length ? times[i + 1] : t0 + STREAM.word;
        runs.push({ start: off, end: off + w.length, t0, t1: Math.max(t0 + 16, Math.min(next, t0 + STREAM.word)) });
        off += w.length;
      });
      if (times.length) queueEnd = times[times.length - 1];
    };

    const update = () => {
      map = textMap(el);
      findBoxes();
      const total = map.total;
      if (total < seen) {
        // markdown re-rendered shorter (a ** pair closed): keep what is known, drop runs past the end
        seen = total;
        runs = runs.filter((r) => r.start < total).map((r) => (r.end > total ? { ...r, end: total } : r));
      }
      if (total > seen) {
        if (activeRef.current) schedule(seen, performance.now());
        seen = total;
      }
      // mark the new text in the same task React commits it, before the browser paints:
      // a highlight set one frame later would show the chunk at full color for a frame first
      if (runs.length && paint(performance.now())) run();
    };

    if (seen < map.total) update();
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      stop?.();
      clear();
      release();
    };
  }, [ref, reduced]);
}
