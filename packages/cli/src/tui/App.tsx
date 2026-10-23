/** The chat screen: committed transcript in <Static>, live items, input and status. */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Static, Text, useAnimation, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { join } from 'node:path';
import type { FileEntryDto } from '@conclave/core/client/index.ts';
import { tui as p, truncate } from '../ansi';
import { isActiveStatus } from '../events';
import { formatDuration } from '../render/format';
import { renderTodos } from '../render/tools';
import { matchCommands, matchFiles, slashToken, atToken, splitPathQuery, type Suggestion, type CommandInfo } from './complete';
import type { ChatController } from './controller';
import * as ed from './editor';
import type { History } from './history';
import { Picker } from './Picker';
import { ApprovalBox, QuestionBox } from './Prompts';
import { itemGap, renderItem, SPINNER } from './render-item';
import { BUILTINS, runSlash, type PickerSpec, type SlashHost } from './slash';
import { footerLine, headerLine } from './statusline';
import type { Item } from './transcript';

const MAX_INPUT_ROWS = 8;
const PLACEHOLDER = 'Ask anything · / for commands · @ to mention files';

function itemSig(item: Item, frame: number, now: number): string {
  switch (item.kind) {
    case 'text':
      return `${item.final}|${item.first}|${item.text.length}`;
    case 'thinking':
      return `${item.final}|${item.text.length}`;
    case 'tool':
      return `${item.status}|${item.result ? 1 : 0}|${item.progress?.length ?? 0}|${item.status === 'running' ? `${frame}|${Math.floor(now / 1000)}` : ''}`;
    default:
      return '';
  }
}

const StaticItem = React.memo(function StaticItem(props: { item: Item; prev?: Item; width: number; showThinking: boolean; cwd: string }) {
  const text = renderItem(props.item, { width: props.width - 1, painter: p, showThinking: props.showThinking, cwd: props.cwd });
  return (
    <Box marginTop={itemGap(props.item, props.prev) ? 1 : 0}>
      <Text>{text}</Text>
    </Box>
  );
});

/** Live items as one string, clamped to the rows we have so Ink never scrolls a frame. */
function useLiveText(items: Item[], prevCommitted: Item | undefined, width: number, showThinking: boolean, cwd: string, frame: number, budget: number): string {
  const cache = useRef(new Map<string, { sig: string; text: string }>());
  const now = Date.now();
  const lines: string[] = [];
  const seen = new Set<string>();
  items.forEach((item, i) => {
    seen.add(item.id);
    const sig = `${itemSig(item, frame, now)}|${width}|${showThinking}`;
    let c = cache.current.get(item.id);
    if (!c || c.sig !== sig) {
      c = { sig, text: renderItem(item, { width: width - 1, painter: p, showThinking, cwd, frame, now }) };
      cache.current.set(item.id, c);
    }
    if (itemGap(item, i === 0 ? prevCommitted : items[i - 1])) lines.push('');
    lines.push(...c.text.split('\n'));
  });
  for (const k of cache.current.keys()) if (!seen.has(k)) cache.current.delete(k);
  if (lines.length > budget) {
    const hidden = lines.length - budget + 1;
    return [p.dim(`⋮ ${hidden} more lines above, they print in full when finished`), ...lines.slice(hidden)].join('\n');
  }
  return lines.join('\n');
}

function InputView({ edit, width, borderColor, busy }: { edit: ed.Edit; width: number; borderColor: string; busy: boolean }): React.JSX.Element {
  const lines = edit.value.split('\n');
  const { row, col } = ed.position(edit);
  let start = 0;
  if (lines.length > MAX_INPUT_ROWS) start = Math.max(0, Math.min(row - Math.floor(MAX_INPUT_ROWS / 2), lines.length - MAX_INPUT_ROWS));
  const end = Math.min(lines.length, start + MAX_INPUT_ROWS);
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column" width={width}>
      {start > 0 && <Text dimColor>{`  ↑ ${start} more lines`}</Text>}
      {lines.slice(start, end).map((l, k) => {
        const i = start + k;
        const prefix = i === 0 ? <Text color={busy ? 'gray' : 'cyan'}>{'> '}</Text> : <Text>{'  '}</Text>;
        if (i !== row) return <Text key={i}>{prefix}{l}</Text>;
        const ch = [...l.slice(col)][0] ?? ' ';
        return (
          <Text key={i}>
            {prefix}
            {l.slice(0, col)}
            <Text inverse>{ch}</Text>
            {l.slice(col + ch.length)}
            {edit.value === '' ? <Text dimColor>{PLACEHOLDER.slice(0, Math.max(0, width - 8))}</Text> : null}
          </Text>
        );
      })}
      {end < lines.length && <Text dimColor>{`  ↓ ${lines.length - end} more lines`}</Text>}
    </Box>
  );
}

function Suggestions({ items, selected, width }: { items: Suggestion[]; selected: number; width: number }): React.JSX.Element {
  const labelW = Math.min(34, Math.max(...items.map((s) => s.label.length)) + 2);
  return (
    <Box flexDirection="column" paddingX={2}>
      {items.map((s, i) => (
        <Text key={s.value + i} wrap="truncate-end">
          <Text color={i === selected ? 'cyan' : undefined} bold={i === selected}>
            {(s.kind === 'dir' ? '▸ ' : '  ') + truncate(s.label, labelW - 2).padEnd(labelW)}
          </Text>
          {s.hint ? <Text dimColor>{truncate(s.hint, Math.max(10, width - labelW - 8))}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function borderFor(mode: string | undefined): string {
  if (mode === 'bypass') return 'red';
  if (mode === 'plan') return 'cyan';
  if (mode === 'acceptEdits') return 'magenta';
  return 'gray';
}

export function App({ ctl, history }: { ctl: ChatController; history: History }): React.JSX.Element {
  const snap = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(30, columns || 80);
  const [editState, setEditState] = useState<ed.Edit>(ed.empty);
  // Keys can arrive faster than renders; read and write through a ref so none are lost.
  const editRef = useRef(editState);
  const setEdit = (next: ed.Edit) => {
    editRef.current = next;
    setEditState(next);
  };
  const edit = editState;
  const [picker, setPicker] = useState<PickerSpec | null>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [files, setFiles] = useState<Record<string, FileEntryDto[]>>({});
  const lastCtrlC = useRef(0);
  const lastEsc = useRef(0);

  const session = snap.session;
  const active = isActiveStatus(session?.status);
  const approval = snap.approvals.find((a) => !session || a.sessionId === session.id);
  const question = snap.questions.find((q) => !session || q.sessionId === session.id);
  const overlay = approval ? 'approval' : question ? 'question' : picker ? 'picker' : null;
  const cwd = session?.cwd ?? snap.draft.cwd;
  const device = session?.device ?? snap.draft.device;
  const permissionMode = session?.permissionMode ?? snap.draft.permissionMode;

  const { frame } = useAnimation({ interval: 100, isActive: active });
  const waitingReset = session?.status === 'waiting_reset';
  useAnimation({ interval: 1000, isActive: waitingReset });

  // Reflow the transcript after the terminal is resized.
  const firstWidth = useRef(width);
  useEffect(() => {
    if (width === firstWidth.current) return;
    const t = setTimeout(() => {
      firstWidth.current = width;
      ctl.rerender();
    }, 300);
    return () => clearTimeout(t);
  }, [width]);

  const doExit = () => {
    ctl.dispose();
    exit();
  };

  const host: SlashHost = {
    ctl,
    openPicker: (spec) => setPicker(spec),
    exit: doExit,
    width: () => width,
  };

  // ----- suggestions
  const commands: CommandInfo[] = useMemo(
    () => [...BUILTINS.map((b) => ({ name: b.name, description: b.description, args: b.args })), ...ctl.commands.map((c) => ({ name: c.name, description: c.description, args: c.argumentHint, source: c.source }))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctl.commands.length],
  );
  const slash = slashToken(edit);
  const at = slash ? undefined : atToken(edit);
  const atDir = at ? splitPathQuery(at.query).dir : undefined;
  const dirKey = atDir !== undefined ? `${device}:${cwd}:${atDir}` : undefined;
  let suggestions: Suggestion[] = [];
  if (!dismissed && !overlay) {
    if (slash) suggestions = matchCommands(commands, slash.query);
    else if (at && dirKey && files[dirKey]) suggestions = matchFiles(files[dirKey], at.query);
  }
  const selected = Math.min(sel, Math.max(0, suggestions.length - 1));

  useEffect(() => {
    if (dirKey === undefined || atDir === undefined || files[dirKey]) return;
    const t = setTimeout(async () => {
      const abs = atDir.startsWith('/') ? atDir : atDir.startsWith('~') ? atDir : atDir ? join(cwd, atDir) : cwd;
      let entries: FileEntryDto[] = [];
      try {
        entries = await ctl.client.browse(device, abs);
      } catch {
        /* unknown dir: no suggestions */
      }
      setFiles((f) => ({ ...f, [dirKey]: entries }));
    }, 60);
    return () => clearTimeout(t);
  }, [dirKey]);

  const changeEdit = (next: ed.Edit) => {
    setEdit(next);
    setSel(0);
    setDismissed(false);
  };

  const accept = (s: Suggestion, range: { start: number; end: number }): ed.Edit => {
    const after = s.kind === 'dir' ? '' : ' ';
    return ed.replaceRange(editRef.current, range.start, range.end, s.value + after);
  };

  const submit = (raw: string) => {
    const value = raw.replace(/\s+$/, '');
    if (!value.trim()) return;
    history.push(value);
    changeEdit(ed.empty);
    if (value.startsWith('/') && !value.startsWith('//')) {
      void runSlash(host, value);
      return;
    }
    void ctl.send(value.startsWith('//') ? value.slice(1) : value);
  };

  // ----- global keys
  useInput((input, key) => {
    ctl.inUse();
    if (key.ctrl && input === 'c') {
      if (picker) return;
      if (editRef.current.value) {
        changeEdit(ed.empty);
        history.reset();
        return;
      }
      if (Date.now() - lastCtrlC.current < 2000) return doExit();
      lastCtrlC.current = Date.now();
      ctl.flash('Press Ctrl-C again to exit', 2000);
      return;
    }
    if (key.ctrl && input === 't') return ctl.toggleThinking();
    if (key.ctrl && input === 'l') return ctl.rerender();
    if (key.tab && key.shift) return void ctl.cyclePermissionMode();
  });

  usePaste(
    (text) => {
      changeEdit(ed.insert(editRef.current, text.replace(/\r\n?/g, '\n')));
    },
    { isActive: !overlay },
  );

  // ----- input keys
  useInput(
    (input, key) => {
      const edit = editRef.current;
      const slash = slashToken(edit);
      const at = slash ? undefined : atToken(edit);
      if (key.ctrl && (input === 'c' || input === 't' || input === 'l')) return;
      if (key.tab && key.shift) return;
      const range = slash ?? at;
      if (suggestions.length && range) {
        if (key.upArrow) return setSel((selected - 1 + suggestions.length) % suggestions.length);
        if (key.downArrow) return setSel((selected + 1) % suggestions.length);
        if (key.tab) return changeEdit(accept(suggestions[selected], range));
        if (key.escape) return setDismissed(true);
        if (key.return && !key.meta) {
          const s = suggestions[selected];
          const typed = edit.value.slice(range.start, range.end);
          if (s.kind === 'command' && (typed === s.value || s.noArgs)) {
            const line = (s.value + edit.value.slice(range.end)).trim();
            return submit(line);
          }
          if (typed !== s.value) return changeEdit(accept(s, range));
        }
      }
      if (key.return) {
        if (key.meta) return changeEdit(ed.insert(edit, '\n'));
        if (edit.value.endsWith('\\') && edit.cursor === edit.value.length) return changeEdit({ value: edit.value.slice(0, -1) + '\n', cursor: edit.value.length });
        return submit(edit.value);
      }
      if (input === '\n') return changeEdit(ed.insert(edit, '\n'));
      if (key.escape) {
        if (active) {
          void ctl.abort();
          return;
        }
        if (edit.value && Date.now() - lastEsc.current < 800) changeEdit(ed.empty);
        lastEsc.current = Date.now();
        return;
      }
      if (key.upArrow) {
        const up = ed.up(edit);
        if (up) return setEdit(up);
        const prev = history.prev(edit.value);
        if (prev !== undefined) changeEdit(ed.set(prev));
        return;
      }
      if (key.downArrow) {
        const down = ed.down(edit);
        if (down) return setEdit(down);
        const next = history.next();
        if (next !== undefined) changeEdit(ed.set(next));
        return;
      }
      if (key.leftArrow) return setEdit(key.meta || key.ctrl ? ed.wordLeft(edit) : ed.left(edit));
      if (key.rightArrow) return setEdit(key.meta || key.ctrl ? ed.wordRight(edit) : ed.right(edit));
      if (key.home || (key.ctrl && input === 'a')) return setEdit(ed.lineStart(edit));
      if (key.end || (key.ctrl && input === 'e')) return setEdit(ed.lineEnd(edit));
      if (key.backspace) return changeEdit(key.meta || key.ctrl ? ed.deleteWordBack(edit) : ed.backspace(edit));
      if (key.delete) return changeEdit(ed.del(edit));
      if (key.ctrl) {
        if (input === 'u') return changeEdit(ed.killToLineStart(edit));
        if (input === 'k') return changeEdit(ed.killToLineEnd(edit));
        if (input === 'w') return changeEdit(ed.deleteWordBack(edit));
        if (input === 'b') return setEdit(ed.left(edit));
        if (input === 'f') return setEdit(ed.right(edit));
        if (input === 'p') {
          const prev = history.prev(edit.value);
          if (prev !== undefined) changeEdit(ed.set(prev));
          return;
        }
        if (input === 'n') {
          const next = history.next();
          if (next !== undefined) changeEdit(ed.set(next));
          return;
        }
        if (input === 'd' && !edit.value) return doExit();
        return;
      }
      if (key.meta) {
        if (input === 'b') return setEdit(ed.wordLeft(edit));
        if (input === 'f') return setEdit(ed.wordRight(edit));
        return;
      }
      if (key.tab) return;
      if (!input) return;
      // Typed-ahead text and Enter can arrive as one chunk: insert, then send.
      if (/^[^\r\n]+\r$/.test(input)) {
        const next = ed.insert(edit, input.slice(0, -1).replace(/[\x00-\x1f\x7f]/g, ''));
        if (next.value.endsWith('\\')) return changeEdit({ value: next.value.slice(0, -1) + '\n', cursor: next.value.length });
        return submit(next.value);
      }
      const clean = input.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (clean) changeEdit(ed.insert(edit, clean));
    },
    { isActive: !overlay },
  );

  // ----- layout
  const inputRows = Math.min(MAX_INPUT_ROWS, edit.value.split('\n').length) + 2;
  const todosShown = active && snap.todos.length ? Math.min(6, snap.todos.length) : 0;
  // rows used below the live items: gaps, working line, input or overlay, suggestions, two status lines
  const chrome = 1 + (active ? 2 : 0) + todosShown + 1 + (overlay ? 14 : inputRows) + suggestions.length + 2;
  const budget = Math.max(4, (rows || 24) - chrome - 2);
  const prevCommitted = snap.committed[snap.committed.length - 1];
  const liveText = useLiveText(snap.live, prevCommitted, width, snap.showThinking, cwd, frame, budget);

  const now = Date.now();
  let working = '';
  if (active) {
    const el = snap.turnStartedAt ? formatDuration(now - snap.turnStartedAt) : '';
    const label = session?.status === 'waiting_approval' ? 'Waiting for approval' : session?.status === 'waiting_input' ? 'Waiting for your answer' : 'Working…';
    working = `${p.fg('#C792EA')(SPINNER[frame % SPINNER.length])} ${p.fg('#C792EA')(label)} ${p.dim(`(${el ? el + ' · ' : ''}esc to interrupt)`)}`;
  }

  const header = headerLine(
    {
      model: ctl.currentModel(),
      agent: session?.agent ?? snap.draft.agent,
      mode: session?.mode ?? snap.draft.mode,
      permissionMode,
      device,
      cwd,
      hubStatus: snap.hubStatus,
    },
    p,
    width - 2,
  );
  const footer = footerLine(
    { session, model: ctl.currentModel(), lastUsage: snap.lastUsage, contextWindow: snap.contextWindow, limits: snap.limits, subscriptions: snap.subscriptions, now },
    p,
    width - 2,
  );

  return (
    <>
      <Static key={snap.staticKey} items={snap.committed}>
        {(item, i) => <StaticItem key={item.id} item={item} prev={snap.committed[i - 1]} width={width} showThinking={snap.showThinking} cwd={cwd} />}
      </Static>
      <Box flexDirection="column">
        {liveText ? <Text>{liveText}</Text> : null}
        {working ? (
          <Box marginTop={1}>
            <Text>{working}</Text>
          </Box>
        ) : null}
        {todosShown ? (
          <Box marginLeft={2} flexDirection="column">
            <Text>{renderTodos(snap.todos.slice(0, 6), p).join('\n')}</Text>
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          {overlay === 'approval' && approval ? (
            <ApprovalBox
              key={approval.id}
              approval={approval}
              width={width}
              cwd={cwd}
              queued={snap.approvals.length - 1}
              onResolve={(r) => void ctl.resolveApproval(approval, r)}
              onAbort={() => void ctl.abort()}
            />
          ) : overlay === 'question' && question ? (
            <QuestionBox key={question.id} question={question} onAnswer={(a) => void ctl.answerQuestion(question, a)} onAbort={() => void ctl.abort()} />
          ) : overlay === 'picker' && picker ? (
            <Picker spec={picker} width={width} onClose={() => setPicker(null)} />
          ) : (
            <InputView edit={edit} width={width} borderColor={borderFor(permissionMode)} busy={active} />
          )}
          {suggestions.length > 0 && <Suggestions items={suggestions} selected={selected} width={width} />}
        </Box>
        <Box paddingX={1} flexDirection="column">
          <Text wrap="truncate-end">{header}</Text>
          <Text wrap="truncate-end">{snap.flash ? p.yellow(snap.flash) : footer}</Text>
        </Box>
      </Box>
    </>
  );
}
