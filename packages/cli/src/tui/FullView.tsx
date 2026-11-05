/**
 * ctrl+o: the whole transcript on its own screen (the terminal's alternate
 * screen, see main.tsx), every tool output and thought in full. Only the rows
 * in view are drawn, so a tool output of any length scrolls at the same cost.
 */
import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { tui as p, truncate } from '../ansi';
import { itemGap, renderItem } from './render-item';
import type { Item } from './transcript';

/** Every item as display lines, at full detail. */
export function transcriptLines(items: Item[], width: number, cwd: string, prev?: Item): string[] {
  const out: string[] = [];
  items.forEach((item, i) => {
    if (out.length && itemGap(item, i ? items[i - 1] : prev)) out.push('');
    out.push(...renderItem(item, { width: width - 1, painter: p, showThinking: true, expand: true, cwd }).split('\n'));
  });
  return out;
}

export function FullView({ committed, live, width, rows, cwd, onClose }: { committed: Item[]; live: Item[]; width: number; rows: number; cwd: string; onClose: () => void }): React.JSX.Element {
  // the finished part renders once per change; the live part is small and changes while it streams
  const done = useMemo(() => transcriptLines(committed, width, cwd), [committed, width, cwd]);
  const lines = useMemo(() => {
    const more = transcriptLines(live, width, cwd, committed.at(-1));
    return more.length ? [...done, ...(done.length ? [''] : []), ...more] : done;
  }, [done, live, width, cwd, committed]);
  // one row for the footer and one left free below it, so the frame never fills the screen and scrolls
  const view = Math.max(3, rows - 2);
  const maxTop = Math.max(0, lines.length - view);
  // undefined: follow the end as new lines arrive
  const [top, setTop] = useState<number | undefined>(undefined);
  const topRef = useRef(top);
  const cur = Math.min(topRef.current ?? maxTop, maxTop);
  const go = (t: number) => {
    const next = Math.max(0, Math.min(maxTop, t));
    topRef.current = next >= maxTop ? undefined : next;
    setTop(topRef.current);
  };

  useInput((input, key) => {
    // keys can come faster than renders: start from the ref
    const cur = Math.min(topRef.current ?? maxTop, maxTop);
    if (key.escape || input === 'q' || (key.ctrl && (input === 'o' || input === 'c'))) return onClose();
    if (key.upArrow || input === 'k') return go(cur - 1);
    if (key.downArrow || input === 'j' || key.return) return go(cur + 1);
    if (key.pageUp || (key.ctrl && input === 'b') || input === 'b') return go(cur - (view - 1));
    if (key.pageDown || (key.ctrl && input === 'f') || input === ' ') return go(cur + (view - 1));
    if (key.home || input === 'g') return go(0);
    if (key.end || input === 'G') return go(maxTop);
  });

  const shown = lines.slice(cur, cur + view).map((l) => truncate(l, width - 1));
  while (shown.length < view) shown.push('');
  const end = Math.min(lines.length, cur + view);
  const where = lines.length <= view ? 'all' : cur === 0 ? 'top' : end >= lines.length ? 'end' : `${Math.round((end / lines.length) * 100)}%`;
  const footer = `Transcript · ${lines.length} lines · ${where} · ↑↓ scroll · PgUp PgDn page · g G top end · q esc ctrl+o close`;
  return (
    <Box flexDirection="column">
      <Text>{shown.join('\n')}</Text>
      <Text wrap="truncate-end" dimColor>
        {footer}
      </Text>
    </Box>
  );
}
