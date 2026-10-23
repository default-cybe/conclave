import { useRef, type CSSProperties } from 'react';
import { cn } from '@/lib/text';

export interface RollProps {
  /** A number (formatted with `format`) or text with digits: "4:59", "$0.031". */
  value: number | string;
  /** How a number reads. Default: en-US grouping ("1,962"). */
  format?: (n: number) => string;
  /** Which way the digits roll. auto: up when the value rises, down when it falls. */
  direction?: 'auto' | 'up' | 'down';
  /** Roll time per digit in ms. 240 for counts, 380 for a clock. */
  duration?: number;
  className?: string;
}

interface Cell {
  cur: string;
  prev?: string;
  /** order among changed cells from the right: lower digits move first */
  rank: number;
  /** The old and new values do not line up digit for digit: the old one rolls out whole and the new one rolls in. */
  whole?: boolean;
}

const digits = (s: string) => Number(s.replace(/[^\d.-]/g, '')) || 0;

/** Compare right-aligned: which cells changed, and in what order they roll. */
export function rollCells(prev: string, next: string): Cell[] {
  // Shorter ("$147.86" to "$35.67"): a leading character would vanish while the rest wait their turn.
  // Longer behind a sign ("$8.58" to "$147.86"): the "$" would land mid-number and roll out there.
  // Both roll as one value. A plain count that grows ("999" to "1,000", "9s" to "10s") rolls its digits.
  if (prev.length > next.length || (prev.length < next.length && /^\D/.test(prev))) return [{ cur: next, prev, rank: 0, whole: true }];
  const n = next.length;
  const off = prev.length - n;
  const cells: Cell[] = [];
  let rank = 0;
  const ranks: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = prev[i + off];
    ranks[i] = p !== next[i] ? rank++ : -1;
  }
  for (let i = 0; i < n; i++) {
    const p = prev[i + off];
    cells.push(p !== next[i] ? { cur: next[i], prev: p ?? '', rank: ranks[i] } : { cur: next[i], rank: -1 });
  }
  return cells;
}

/**
 * One number component for tokens, cost, countdowns and counts (type.html
 * Roll). Only the characters that change roll, each in its own clipped
 * cell: lower digits first, each higher one 28ms later, up when the value
 * rises and down when it falls. Tabular figures, so nothing shifts.
 * Screen readers get the plain value. Reduced motion: the value changes in place.
 */
export function Roll({ value, format, direction = 'auto', duration = 240, className }: RollProps) {
  const text = typeof value === 'number' ? (format ?? ((n: number) => n.toLocaleString('en-US')))(value) : value;
  const last = useRef<{ text: string; v: number; cells: Cell[]; dir: number }>({ text, v: 0, cells: rollCells(text, text), dir: 1 });
  if (last.current.text !== text) {
    const prevText = last.current.text;
    const up = direction === 'up' ? true : direction === 'down' ? false : (typeof value === 'number' ? value : digits(text)) >= digits(prevText);
    last.current = { text, v: last.current.v + 1, cells: rollCells(prevText, text), dir: up ? 1 : -1 };
  }
  const { cells, v, dir } = last.current;
  return (
    <span className={cn('cv-roll num', className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="cv-roll-cells" style={{ '--dir': dir, '--roll': `${duration}ms` } as CSSProperties}>
        {cells.map((c, i) =>
          c.prev === undefined ? (
            <span key={`${cells.length - i}`} className="cv-roll-cell">
              {c.cur}
            </span>
          ) : (
            <span key={`${cells.length - i}:${v}`} className="cv-roll-cell" data-rolling data-whole={c.whole || undefined} style={{ '--lag': `${c.rank * 28}ms` } as CSSProperties}>
              {c.prev !== '' && <span className="cv-roll-old">{c.prev}</span>}
              <span className="cv-roll-new">{c.cur}</span>
            </span>
          ),
        )}
      </span>
    </span>
  );
}
