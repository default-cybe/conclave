/**
 * Extensions: Commands (docs/extensions/IA.md). Saved prompts you run with
 * /name. Each row shows the argument hint, the source and the argument
 * style. The detail sheet shows the template and an argument preview that
 * is computed here and never runs !`cmd` snippets. Plugin names that clash
 * are shown with their prefix and a note.
 */
import { useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import type { InventoryItemDto } from '@conclave/core/client';
import type { CommandArgStyle, CommandDef } from '@conclave/core/extensions/types';
import { api } from '@/lib/api';
import { fileName } from '@/lib/format';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { ButtonLink } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { CodeBlock } from '@/components/ui/Code';
import { FilterLinks } from '@/components/ui/Tags';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { KV, SectionHeading } from '@/components/ui/Section';
import { useExtCwd } from './project';
import { WhereFrom } from './shared/SourceBadge';
import { shortPath } from './shared/ProjectPicker';
import { Block, DetailSheet, LoadFailed, RefreshFailed, TOUCH, sentence, splitFrontmatter } from './shared/parts';
import { STYLE_HELP, STYLE_WORD, placeholders, previewCommand } from './shared/expand';
import { ShadowLine, groupByName, type Grouped } from './Skills';

type Filter = 'all' | 'plugin' | 'yours' | 'clis';
const OTHER = ['claude', 'codex', 'opencode', 'gemini', 'agents'];

function styleOf(item: InventoryItemDto, def?: CommandDef): CommandArgStyle {
  if (def?.argStyle) return def.argStyle;
  if (item.source === 'codex') return 'numbered';
  if (item.source === 'opencode') return 'opencode';
  if (item.source === 'gemini') return 'gemini';
  return 'claude';
}

function matchesFilter(i: InventoryItemDto, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'plugin') return i.source === 'plugin';
  if (f === 'yours') return i.source === 'user' || i.source === 'project';
  return OTHER.includes(i.source);
}

/** Plugin commands whose short name is used by more than one plugin: help -> [hookify:help, ralph-loop:help]. */
function clashes(items: InventoryItemDto[]): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const i of items) {
    // only plugin names: Codex prompts (prompts:deploy) and nested folders (git:commit) are not prefixes
    if (!i.active || i.source !== 'plugin' || !i.name.includes(':')) continue;
    const short = i.name.slice(i.name.indexOf(':') + 1);
    by.set(short, [...(by.get(short) ?? []), i.name]);
  }
  return new Map([...by].filter(([, v]) => v.length > 1));
}

export function CommandsTab() {
  const cwd = useExtCwd();
  const search = useSearch();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const inv = useLoad(() => api().extensionsInventory({ cwd, kind: 'command' }), [cwd]);
  const skills = useLoad(() => api().extensionsInventory({ cwd, kind: 'skill' }), [cwd]);
  const defs = useLoad(() => api().commands(), []);
  const open = new URLSearchParams(search).get('command') ?? undefined;
  const setOpen = (name: string | undefined) => navigate(name ? `/extensions/commands?command=${encodeURIComponent(name)}` : '/extensions/commands', { replace: !!open && !!name });

  const groups = useMemo(() => groupByName(inv.data ?? []), [inv.data]);
  const clash = useMemo(() => clashes(inv.data ?? []), [inv.data]);
  const defFor = (i: InventoryItemDto) => defs.data?.find((d) => d.name === i.name && (!i.path || !d.path || d.path === i.path));
  const needle = q.trim().toLowerCase().replace(/^\//, '');
  const shown = groups.filter((g) => matchesFilter(g.item, filter) && (!needle || g.item.name.toLowerCase().includes(needle) || (g.item.description ?? '').toLowerCase().includes(needle)));
  const count = (f: Filter) => groups.filter((g) => matchesFilter(g.item, f)).length;
  const skillRows = (skills.data ?? []).filter((s) => s.active && (!needle || s.name.toLowerCase().includes(needle))).sort((a, b) => a.name.localeCompare(b.name));
  const current = groups.find((g) => g.item.name === open);

  if (inv.error && !inv.data) return <LoadFailed what="commands" error={inv.error} retry={inv.reload} />;
  if (!inv.data) return <LoadingRows loading={inv.loading} rows={6} />;
  if (!groups.length && !skillRows.length)
    return (
      <EmptyState action={<ButtonLink href="/extensions/plugins?view=marketplace" className={TOUCH}>Install a plugin</ButtonLink>}>
        No commands yet. Save a markdown file to <span className="mono">~/.conclave/commands</span>, for example <span className="mono">commit.md</span>, and run it as <span className="mono">/commit</span>.
      </EmptyState>
    );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pb-4">
        <div className="w-[260px] phone:w-full">
          <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or description" aria-label="Filter commands" />
        </div>
        <FilterLinks<Filter>
          label="Source"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: count('all') },
            { value: 'plugin', label: 'Plugins', count: count('plugin') },
            { value: 'yours', label: 'Yours', count: count('yours') },
            { value: 'clis', label: 'Other CLIs', count: count('clis') },
          ]}
        />
      </div>

      {clash.size > 0 && (
        <div className="mb-4 space-y-1 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
          {[...clash].map(([short, names]) => (
            <p key={short}>
              <span className="mono text-fg-2">{short}</span> comes from {names.length} plugins, so type the full name:{' '}
              {names.map((n, i) => (
                <span key={n}>
                  {i > 0 && (i === names.length - 1 ? ' or ' : ', ')}
                  <span className="mono text-fg-2">/{n}</span>
                </span>
              ))}
              . Plain <span className="mono">/{short}</span> does not pick one.
            </p>
          ))}
        </div>
      )}

      <RefreshFailed error={inv.error} retry={inv.reload} className="mb-3" />
      <div className="rows border-t border-rule-2">
        {shown.map((g) => (
          <CommandRow key={g.item.name} g={g} def={defFor(g.item)} clash={clash} onOpen={() => setOpen(g.item.name)} />
        ))}
        {shown.length === 0 && <p className="py-4 text-[13px] text-fg-2 phone:text-[14px]">{needle ? `No command matches "${q.trim()}".` : 'No commands from this source.'}</p>}
      </div>

      {skillRows.length > 0 && filter === 'all' && (
        <section className="mt-8" aria-labelledby="skill-cmds">
          <SectionHeading id="skill-cmds" count={skillRows.length}>
            Skills you can run as commands
          </SectionHeading>
          <div className="rows">
            {skillRows.map((s) => (
              <button key={s.name} type="button" onClick={() => navigate(`/extensions/skills?skill=${encodeURIComponent(s.name)}`)} className="flex w-full items-baseline gap-4 py-2.5 text-left hover:bg-hover phone:py-3">
                <span className="mono min-w-0 flex-1 truncate text-[13px] text-fg">/{s.name}</span>
                <span className="shrink-0 text-[12px] text-fg-3 phone:text-[13px]">skill</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <CommandSheet g={current} def={current ? defFor(current.item) : undefined} onClose={() => setOpen(undefined)} />
    </div>
  );
}

function CommandRow({ g, def, clash, onOpen }: { g: Grouped; def: CommandDef | undefined; clash: Map<string, string[]>; onOpen: () => void }) {
  const it = g.item;
  const style = styleOf(it, def);
  const short = it.name.includes(':') ? it.name.slice(it.name.indexOf(':') + 1) : undefined;
  const clashing = short && clash.has(short);
  const meta = [def?.argumentHint && <span key="h" className="mono">{def.argumentHint}</span>, STYLE_WORD[style], clashing && 'needs the full name', def?.subtask && 'runs as a subtask'].filter(Boolean);
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-4 py-[var(--row-py)] text-left transition-colors duration-[var(--dur-1)] hover:bg-hover phone:gap-3">
      <span className="min-w-0 flex-1">
        <span className="mono block truncate text-[13px] text-fg phone:whitespace-normal phone:break-all">/{it.name}</span>
        {it.description && <span className="mt-0.5 block truncate text-[13px] text-fg-2 phone:whitespace-normal phone:text-[14px]">{it.description}</span>}
        <span className="mt-0.5 block truncate text-[12px] text-fg-3 phone:text-[13px]">
          {meta.map((m, i) => (
            <span key={i}>
              {i > 0 && ', '}
              {m}
            </span>
          ))}
        </span>
        {g.shadowed.map((s, i) => (
          <ShadowLine key={i} s={s} />
        ))}
      </span>
      <span className="shrink-0 text-[12px] phone:text-[13px]">
        <WhereFrom item={it} />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/** A command read from its file when the hub's list does not carry it (project or shadowed copies). */
function fromFile(text: string, path: string): { body: string; fields: Record<string, string> } {
  if (path.endsWith('.toml')) {
    const m = /prompt\s*=\s*"""([\s\S]*?)"""/.exec(text) ?? /prompt\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    const d = /description\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    return { body: (m?.[1] ?? text).replace(/^\n/, ''), fields: d ? { description: d[1] } : {} };
  }
  const { fields, body } = splitFrontmatter(text);
  return { body, fields: Object.fromEntries(fields) };
}

function CommandSheet({ g, def, onClose }: { g: Grouped | undefined; def: CommandDef | undefined; onClose: () => void }) {
  const mobile = useIsMobile();
  const item = g?.item;
  const path = item?.path ?? def?.path;
  const needFile = !!item && !def?.body && !!path;
  const file = useLoad(async () => (needFile && path ? { path, text: (await api().readDeviceFile('local', path)).content } : undefined), [needFile, path]);
  const [args, setArgs] = useState('');
  const text = file.data && file.data.path === path ? file.data.text : undefined;
  const parsed = text !== undefined && path ? fromFile(text, path) : undefined;
  const body = def?.body || parsed?.body || '';
  const style = item ? styleOf(item, def) : 'claude';
  const hint = def?.argumentHint ?? parsed?.fields['argument-hint'];
  const allowed = def?.allowedTools ?? parsed?.fields['allowed-tools']?.split(/,\s*/).filter(Boolean);
  const preview = useMemo(() => previewCommand(body, args, style, item?.name ?? ''), [body, args, style, item?.name]);
  if (!g || !item) return <DetailSheet open={false} onClose={onClose} title="" label="Command">{null}</DetailSheet>;
  const kw = mobile ? 96 : 120;
  const holes = placeholders(body, style);
  return (
    <DetailSheet
      open
      onClose={() => {
        setArgs('');
        onClose();
      }}
      label={`Command /${item.name}`}
      title={<span className="mono text-[16px]">/{item.name}</span>}
      meta={
        <>
          <WhereFrom item={item} />
          {path && (
            <>
              <br />
              <span className="mono break-all">{shortPath(path)}</span>
            </>
          )}
        </>
      }
    >
      {(item.description || def?.description) && <p className="text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">{item.description || def?.description}</p>}

      <dl className="mt-3">
        <KV k="Arguments" keyWidth={kw}>
          {hint ? <span className="mono text-[13px]">{hint}</span> : <span className="text-fg-2">No hint given</span>}
        </KV>
        <KV k="Style" keyWidth={kw}>
          {STYLE_WORD[style]}
          <span className="mt-0.5 block text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{STYLE_HELP[style]}</span>
        </KV>
        {allowed?.length ? (
          <KV k="Allowed tools" keyWidth={kw}>
            <span className="mono text-[12.5px] break-words">{allowed.join(', ')}</span>
          </KV>
        ) : null}
        {def?.model && (
          <KV k="Model" keyWidth={kw}>
            {def.model}
          </KV>
        )}
        {def?.agent && (
          <KV k="Agent" keyWidth={kw}>
            {def.agent}
          </KV>
        )}
      </dl>

      <Block title="Template" className="mt-6">
        {file.error && !body ? (
          <p className="text-[13px] text-fault phone:text-[14px]">Could not read the file. {sentence(file.error)} It may have moved. Reload the page to see the current list.</p>
        ) : !body ? (
          file.loading ? <LoadingRows loading rows={2} /> : <p className="text-[13px] text-fg-3">The template is empty.</p>
        ) : (
          <CodeBlock code={body} title={path ? fileName(path) : 'template'} wrap />
        )}
      </Block>

      {body && (
        <Block title="Preview with arguments">
          <label htmlFor="cmd-args" className="sr-only">
            Sample arguments
          </label>
          <Input id="cmd-args" mono value={args} onChange={(e) => setArgs(e.target.value)} placeholder={hint ? `Type sample arguments, like ${hint}` : 'Type sample arguments'} autoComplete="off" spellCheck={false} />
          {holes.length > 0 && (
            <p className="mt-2 text-[12px] leading-[1.6] text-fg-3 phone:text-[13px]">
              {holes.map((h, i) => (
                <span key={h} className="break-words">
                  {i > 0 && ', '}
                  <span className="mono">{h}</span> = <span className="mono text-fg-2">{valueOf(h, preview.tokens, preview.raw, style, holes) || 'empty'}</span>
                </span>
              ))}
            </p>
          )}
          {!holes.length && args.trim() && (
            <p className="mt-2 text-[12px] text-fg-3 phone:text-[13px]">
              {style === 'opencode' || style === 'gemini' ? 'The template has no placeholder, so your text is added at the end.' : 'The template has no placeholder, so the arguments are not used.'}
            </p>
          )}
          <pre className="t-code mt-3 overflow-x-auto rounded-[var(--r-2)] border border-rule bg-sunk px-3 py-2.5 break-words whitespace-pre-wrap text-fg">
            {preview.segments.map((s, i) =>
              s.kind ? (
                <span key={i} className="text-fg-3">
                  [{s.kind === 'run' ? 'would run' : 'would read'}: <span className="text-fg-2">{s.text}</span>]
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </pre>
          {(preview.runs.length > 0 || preview.reads.length > 0) && (
            <p className={cn('mt-2 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]')}>
              {preview.runs.length > 0 && <>When you run it, the shell snippets run first on the session device and their output replaces them. </>}
              {preview.reads.length > 0 && <>Files after @ are read into the prompt. </>}
              This preview runs nothing.
            </p>
          )}
        </Block>
      )}
    </DetailSheet>
  );
}

/** What a placeholder becomes for the typed arguments. */
function valueOf(h: string, tokens: string[], raw: string, style: CommandArgStyle, all: string[]): string {
  if (h === '$ARGUMENTS' || h === '{{args}}') return raw;
  const idx = /\[(\d+)\]/.exec(h)?.[1] ?? /\$(\d)/.exec(h)?.[1];
  if (idx === undefined) return '';
  const n = Number(idx);
  if (style === 'claude') return tokens[n] ?? '';
  if (style === 'numbered') return n ? (tokens[n - 1] ?? '') : '';
  // opencode: the highest placeholder takes the rest
  const nums = all.map((x) => Number(/\$(\d)/.exec(x)?.[1] ?? 0)).filter(Boolean);
  if (n === Math.max(...nums)) return tokens.slice(n - 1).join(' ');
  return tokens[n - 1] ?? '';
}
