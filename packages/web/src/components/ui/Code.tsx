/**
 * Code, commands and diffs (spec 10.18, 10.19). The only boxes besides
 * inputs, the approval card and floating layers: bg-sunk, a rule border,
 * r-2, mono 12.5/1.6. Inside the approval card pass `bare` (fill, no border).
 */
import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn, diffSpan, parseDiff, type DiffFile, type DiffLine } from '@/lib/text';
import { useCopy, useIsMobile } from '@/lib/hooks';
import { highlight, langFromPath } from '@/lib/highlight';
import { Swap } from '../motion/Swap';
import { Button } from './Button';
import { Textarea } from './Field';
import { useEscape } from './Overlay';

const BOX = 'rounded-[var(--r-2)] bg-sunk t-code text-fg';

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      aria-label={copied ? 'Copied' : 'Copy'}
      className={cn('grid size-6 shrink-0 place-items-center rounded-[var(--r-1)] text-fg-3 transition-colors hover:bg-hover hover:text-fg coarse:size-11', className)}
    >
      {/* Copy gives way to Check for 1.5s; no toast */}
      <Swap on={copied} off={<Copy className="size-3.5" strokeWidth={1.75} />}>
        <Check className="size-3.5 text-ok" strokeWidth={1.75} />
      </Swap>
    </button>
  );
}

/**
 * A code block. With `lang` or `copy` it gets a header line inside the box:
 * the language word in meta fg-3 and a Copy button (on hover and focus on
 * desktop, always on phones). `shell` prefixes lines with a $ in fg-4 that
 * is not copied.
 */
export function CodeBlock({
  code,
  lang,
  copy = true,
  closed = true,
  shell,
  bare,
  maxLines,
  wrap,
  className,
  title,
}: {
  code: string;
  lang?: string;
  copy?: boolean;
  /** Open markdown fences stay plain until their closing fence arrives. */
  closed?: boolean;
  shell?: boolean;
  bare?: boolean;
  /** Collapse to this many lines with "Show all N lines". */
  maxLines?: number;
  /** Wrap long lines instead of scrolling. */
  wrap?: boolean;
  className?: string;
  /** Replaces the language word in the header. */
  title?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const lines = code.replace(/\n$/, '').split('\n');
  const long = !!maxLines && lines.length > maxLines && !all;
  const shown = long ? lines.slice(0, maxLines).join('\n') : lines.join('\n');
  const html = useMemo(() => (shell || !closed ? null : highlight(shown, lang)), [shown, lang, shell, closed]);
  const mobile = useIsMobile();
  // phones always get the header line, so the 44px Copy button never sits on top of the first line
  const header = !!(lang || title) || (copy && mobile);
  return (
    <div data-hover="code" className={cn('relative', BOX, !bare && 'border border-rule', className)}>
      {header && (
        <div className="flex h-8 items-center justify-between pr-1.5 pl-3 coarse:h-11 coarse:pr-0">
          <span className="font-sans text-[12px] font-normal tracking-normal text-fg-3">{title ?? lang ?? ''}</span>
          {copy && <CopyButton text={code} className="reveal-code opacity-0 focus-visible:opacity-100 coarse:opacity-100" />}
        </div>
      )}
      <pre className={cn('m-0 overflow-x-auto px-3 pb-2.5', !header && 'pt-2.5', wrap && 'break-words whitespace-pre-wrap')}>
        {shell ? (
          shown.split('\n').map((l, i) => (
            <div key={i}>
              <span className="text-fg-4 select-none">$ </span>
              {l}
            </div>
          ))
        ) : html ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{shown}</code>
        )}
      </pre>
      {long && (
        <button type="button" onClick={() => setAll(true)} className="mb-2 ml-3 font-sans text-[12px] tracking-normal text-fg-3 hover:text-fg">
          Show all {lines.length} lines
        </button>
      )}
      {!header && copy && <CopyButton text={code} className="absolute top-1.5 right-1.5 bg-sunk reveal-code opacity-0 focus-visible:opacity-100 coarse:opacity-100" />}
    </div>
  );
}

/**
 * A shell command. Wraps between tokens only (each token nowrap), so flags
 * never split. The $ prompt is fg-4 and not selectable.
 */
export function Command({ command, bare, copy = false, className }: { command: string; bare?: boolean; copy?: boolean; className?: string }) {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+|\s+/g) ?? [command];
  return (
    <div data-hover="code" className={cn('relative px-3 py-2.5', BOX, !bare && 'border border-rule', copy && 'pr-9 coarse:pr-12', className)}>
      <span className="text-fg-4 select-none">$ </span>
      {tokens.map((t, i) => (/^\s+$/.test(t) ? ' ' : <span key={i} className="whitespace-nowrap">{t}</span>))}
      {copy && <CopyButton text={command} className="absolute top-1.5 right-1.5 reveal-code opacity-0 focus-visible:opacity-100 coarse:top-0 coarse:right-0 coarse:opacity-100" />}
    </div>
  );
}

/** Inline code: mono 0.93em, bg-sunk, a rule border, radius 3px, 0 4px padding. */
export function InlineCode({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('rounded-[3px] border border-rule bg-sunk px-1 text-[0.93em] text-fg', className)}>{children}</code>;
}

/**
 * A diff: a header row above the box (verb, mono path, +n −n), then the
 * lines with numbers (fg-3), a sign gutter and syntax colors. Collapses to
 * `maxLines` with "Show all N lines". With `onComment` each line number is
 * a button: it opens a comment box under the line, and Shift with it picks
 * the range from the line already picked. On a phone, with the box still
 * empty, a tap on another number picks the range (touch has no Shift).
 */
export function Diff({
  diff,
  file,
  verb = 'Edit',
  maxLines = 20,
  bare,
  header = true,
  action,
  onComment,
  className,
}: {
  /** A unified diff (first file is shown) */
  diff?: string;
  file?: DiffFile;
  verb?: ReactNode;
  maxLines?: number;
  bare?: boolean;
  header?: boolean;
  /** A quiet action at the right of the header ("View file"). */
  action?: ReactNode;
  /** The owner commented on these lines (hunk rows left out). */
  onComment?: (path: string, lines: DiffLine[], text: string) => void;
  className?: string;
}) {
  const f = useMemo(() => file ?? (diff ? parseDiff(diff)[0] : undefined), [file, diff]);
  const [all, setAll] = useState(false);
  // the picked lines, as indexes into what is shown; the box opens under the last
  const [pick, setPick] = useState<{ from: number; to: number } | null>(null);
  const [note, setNote] = useState('');
  const table = useRef<HTMLTableElement>(null);
  const mobile = useIsMobile();
  const close = (back: number) => {
    setPick(null);
    setNote('');
    table.current?.querySelector<HTMLButtonElement>(`[data-line="${back}"]`)?.focus();
  };
  // the box is the top layer: Esc closes it, not the dialog or sheet the diff sits in
  useEscape(!!pick, () => pick && close(Math.max(pick.from, pick.to)));
  if (!f) return null;
  const lang = langFromPath(f.path);
  const lines = f.lines.filter((l) => l.type !== 'meta');
  const long = lines.length > maxLines && !all;
  const shown = long ? lines.slice(0, maxLines) : lines;
  const lo = pick ? Math.min(pick.from, pick.to) : -1;
  const hi = pick ? Math.max(pick.from, pick.to) : -1;
  const choose = (i: number, range: boolean) => {
    if (pick && pick.from === i && pick.to === i) {
      setPick(null);
      setNote('');
    } else setPick(range && pick ? { from: pick.from, to: i } : { from: i, to: i });
  };
  const add = () => {
    if (!note.trim() || !onComment) return;
    onComment(f.path, shown.slice(lo, hi + 1), note);
    close(hi);
  };
  const boxKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      add();
    }
  };
  const at = pick ? diffSpan(shown.slice(lo, hi + 1)) : {};
  const span = at.line === undefined ? 'these lines' : `${at.endLine === undefined ? `line ${at.line}` : `lines ${at.line}-${at.endLine}`}${at.removed ? ' (removed)' : ''}`;
  return (
    <div className={className}>
      {header && (
        <div className="mb-1.5 flex items-baseline gap-2 text-[13px]">
          <span className="font-medium text-fg-2">{verb}</span>
          <span className="mono min-w-0 truncate text-fg">{f.path}</span>
          <span className="num ml-auto shrink-0 text-[12px]">
            <span className="text-ok">+{f.added}</span> <span className="text-fault">−{f.removed}</span>
          </span>
          {action}
        </div>
      )}
      <div className={cn(BOX, !bare && 'border border-rule', 'overflow-hidden')}>
        <div className="overflow-x-auto py-1.5">
          <table ref={table} className="w-full border-collapse">
            <tbody>
              {shown.map((l, i) => {
                if (l.type === 'hunk')
                  return (
                    <tr key={i}>
                      <td colSpan={3} className="px-3 py-0.5 text-fg-3">
                        {l.text}
                      </td>
                    </tr>
                  );
                const html = highlight(l.text, lang);
                const picked = i >= lo && i <= hi;
                return (
                  <Fragment key={i}>
                  <tr style={{ background: l.type === 'add' ? 'var(--add-bg)' : l.type === 'del' ? 'var(--del-bg)' : undefined }} className={cn(picked && 'shadow-[inset_2px_0_0_var(--signal)]')}>
                    <td className="w-9 min-w-9 pr-1 text-right align-top text-fg-3 select-none">
                      {onComment ? (
                        <button
                          type="button"
                          data-line={i}
                          aria-label={`Comment on line ${lineNo(l)}`}
                          aria-pressed={picked}
                          title="Comment on this line. Shift picks a range."
                          onClick={(e) => choose(i, e.shiftKey || (mobile && !note.trim()))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && e.shiftKey) {
                              e.preventDefault();
                              choose(i, true);
                            }
                          }}
                          className={cn('-my-px w-full rounded-[3px] pr-0.5 text-right font-mono phone:min-h-6 transition-colors duration-[var(--dur-1)] hov:bg-hover hov:text-fg', picked && 'text-fg')}
                        >
                          {lineNo(l) ?? ''}
                        </button>
                      ) : (
                        lineNo(l) ?? ''
                      )}
                    </td>
                    <td className={cn('w-3.5 min-w-3.5 text-center align-top select-none', l.type === 'add' ? 'text-ok' : l.type === 'del' ? 'text-fault' : 'text-fg-4')}>
                      {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ''}
                    </td>
                    {/* phones wrap long lines: a line cut at the screen's edge reads as cut off, and nothing says the box scrolls */}
                    <td className="pr-3 whitespace-pre phone:whitespace-pre-wrap phone:[overflow-wrap:anywhere]">{html ? <span className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : l.text || ' '}</td>
                  </tr>
                  {onComment && i === hi && (
                    <tr>
                      <td colSpan={3} className="px-3 py-2 font-sans tracking-normal">
                        <Textarea autoFocus minRows={2} maxRows={8} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={boxKey} aria-label={`Comment on ${span}`} placeholder={mobile && lo === hi ? `Comment on ${span}. Tap another number for a range.` : `Comment on ${span}`} className="w-full max-w-[640px]" />
                        <div className="mt-1.5 flex items-center gap-1">
                          <Button variant="solid" size="sm" aria-disabled={!note.trim() || undefined} onClick={add}>
                            Add comment
                          </Button>
                          <Button variant="quiet" size="sm" onClick={() => close(hi)}>
                            Cancel
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {long && (
          <button type="button" onClick={() => setAll(true)} className="mb-2 ml-3 font-sans text-[12px] tracking-normal text-fg-3 hover:text-fg">
            Show all {lines.length} lines
          </button>
        )}
      </div>
    </div>
  );
}

/** The number a diff line shows: the old file's for a removed line, else the new file's. */
function lineNo(l: DiffLine | undefined): number | undefined {
  return l?.type === 'del' ? l.oldNo : l?.newNo;
}
