/** Searchable list: type to filter, arrows to move, enter to pick, esc to cancel. */
import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { inkColor as c, truncate } from '../ansi';
import type { PickerItem, PickerSpec } from './slash';

const VISIBLE = 10;

export function filterItems(items: PickerItem[], query: string): PickerItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const words = q.split(/\s+/);
  return items.filter((it) => {
    const hay = `${it.label} ${it.hint ?? ''} ${it.value}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** State that key handlers read and write immediately; keys can arrive faster than renders. */
export function useRefState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void, React.MutableRefObject<T>] {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef(value);
  const set = (v: T | ((prev: T) => T)) => {
    const next = typeof v === 'function' ? (v as (prev: T) => T)(ref.current) : v;
    ref.current = next;
    setValue(next);
  };
  return [value, set, ref];
}

export function Picker({ spec, width, onClose }: { spec: PickerSpec; width: number; onClose: () => void }): React.JSX.Element {
  const [query, setQuery, queryRef] = useRefState('');
  const [index, setIndex, indexRef] = useRefState(() => Math.max(0, spec.items.findIndex((i) => i.current)));
  const filtered = useMemo(() => filterItems(spec.items, query), [spec.items, query]);
  const sel = Math.min(index, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    const list = filterItems(spec.items, queryRef.current);
    const n = Math.max(1, list.length);
    const cur = Math.min(indexRef.current, list.length - 1);
    if (key.escape || (key.ctrl && input === 'c')) return onClose();
    if (key.upArrow || (key.ctrl && input === 'p')) return setIndex((cur - 1 + n) % n);
    if (key.downArrow || (key.ctrl && input === 'n') || key.tab) return setIndex((cur + 1) % n);
    if (key.pageDown) return setIndex(Math.min(list.length - 1, cur + VISIBLE));
    if (key.pageUp) return setIndex(Math.max(0, cur - VISIBLE));
    if (key.return || (spec.altKey && input === spec.altKey && !queryRef.current)) {
      const it = list[Math.max(0, cur)];
      if (!it) return;
      onClose();
      void spec.onSelect(it, !key.return);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && input >= ' ') {
      setQuery((q) => q + input);
      setIndex(0);
    }
  });

  const start = Math.max(0, Math.min(sel - Math.floor(VISIBLE / 2), filtered.length - VISIBLE));
  const shown = filtered.slice(start, start + VISIBLE);
  const inner = Math.max(20, width - 4);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c('cyan')} paddingX={1} width={Math.min(width, 100)}>
      <Text>
        <Text bold>{spec.title}</Text>
        <Text dimColor> {query ? `· ${query}` : '· type to search'}</Text>
      </Text>
      {shown.length === 0 && <Text dimColor>No matches</Text>}
      {shown.map((it, i) => {
        const active = start + i === sel;
        const hintRoom = Math.max(0, inner - it.label.length - 6);
        return (
          <Text key={it.value + ':' + i} wrap="truncate-end">
            <Text color={c(active ? 'cyan' : undefined)}>{active ? '❯ ' : '  '}</Text>
            {it.color ? <Text color={c(it.color)}>● </Text> : null}
            <Text bold={active} color={c(active ? 'cyan' : undefined)}>
              {it.label}
            </Text>
            {it.current ? <Text color={c('green')}> ✓</Text> : null}
            {it.hint && hintRoom > 8 ? <Text dimColor> {truncate(it.hint, hintRoom)}</Text> : null}
          </Text>
        );
      })}
      {filtered.length > VISIBLE && <Text dimColor>{`${sel + 1}/${filtered.length}`}</Text>}
      <Text dimColor>{spec.hint ?? 'enter select · esc cancel'}</Text>
    </Box>
  );
}
