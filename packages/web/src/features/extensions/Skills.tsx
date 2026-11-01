/**
 * Extensions: Skills (docs/extensions/IA.md). Every skill found, as typed
 * (superpowers:brainstorming), with its source and path. Shadowed copies sit
 * under the copy in use. The detail sheet renders SKILL.md and says which
 * agents preload it and which other CLIs can see it. Skills agents wrote
 * carry the word Learned and their session (skills/Learned.tsx).
 */
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import type { InventoryItemDto, LearnedSkillDto } from '@conclave/core/client';
import type { SkillDef } from '@conclave/core/extensions/types';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { HarnessName } from '@/components/logo';
import { ButtonLink } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { InlineCode } from '@/components/ui/Code';
import { FilterLinks } from '@/components/ui/Tags';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { TextAction } from '@/components/ui/Section';
import { Markdown } from '@/features/chat/Markdown';
import { useExtCwd } from './project';
import { WhereFrom, scopeWord } from './shared/SourceBadge';
import { shortPath } from './shared/ProjectPicker';
import { Block, DetailSheet, LoadFailed, RefreshFailed, TOUCH, sentence, splitFrontmatter } from './shared/parts';
import { LearnSetting, LearnedBlocks, LearnedLine, withLearned } from './skills/Learned';

type Filter = 'all' | 'plugin' | 'yours' | 'learned' | 'clis';
const OTHER = ['claude', 'codex', 'opencode', 'gemini', 'agents'];

export interface Grouped {
  item: InventoryItemDto;
  shadowed: InventoryItemDto[];
}

/** The copy in use with its shadowed copies under it, sorted by name. */
export function groupByName(items: InventoryItemDto[]): Grouped[] {
  const map = new Map<string, Grouped>();
  for (const it of items.filter((i) => i.active)) map.set(it.name, { item: it, shadowed: [] });
  for (const it of items.filter((i) => !i.active)) {
    const g = map.get(it.name);
    if (g) g.shadowed.push(it);
    else map.set(it.name, { item: it, shadowed: [] });
  }
  return [...map.values()].sort((a, b) => a.item.name.localeCompare(b.item.name));
}

function matchesFilter(i: InventoryItemDto, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'plugin') return i.source === 'plugin';
  if (f === 'learned') return !!i.learned;
  if (f === 'yours') return (i.source === 'user' || i.source === 'project') && !i.learned;
  return OTHER.includes(i.source);
}

/** One line under a winner: where the shadowed copy lives. */
export function ShadowLine({ s }: { s: InventoryItemDto }) {
  return (
    <span className="mt-1 block truncate text-[12px] leading-[1.4] text-fg-3 phone:whitespace-normal phone:text-[13px]">
      Also in {scopeWord(s.scope)}
      {s.path && (
        <>
          , <span className="mono">{shortPath(s.path)}</span>
        </>
      )}
      , shadowed by {s.shadowedBy ? scopeWord(s.shadowedBy) : 'a later copy'}
    </span>
  );
}

export function SkillsTab() {
  const cwd = useExtCwd();
  const search = useSearch();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const inv = useLoad(() => api().extensionsInventory({ cwd, kind: 'skill' }), [cwd]);
  const defs = useLoad(() => api().skills(), []);
  const learned = useLoad(() => api().learnedSkills(), []);
  const open = new URLSearchParams(search).get('skill') ?? undefined;
  const setOpen = (name: string | undefined) => navigate(name ? `/extensions/skills?skill=${encodeURIComponent(name)}` : '/extensions/skills', { replace: !!open && !!name });

  const groups = useMemo(() => withLearned(groupByName(inv.data ?? []), learned.data ?? [], (item) => ({ item, shadowed: [] })), [inv.data, learned.data]);
  const learnedOf = (g: Grouped): LearnedSkillDto | undefined => (g.item.learned ? learned.data?.find((l) => l.path === g.item.path || l.name === g.item.name) : undefined);
  const reloadAll = () => (inv.reload(), learned.reload());
  const needle = q.trim().toLowerCase();
  const shown = groups.filter((g) => matchesFilter(g.item, filter) && (!needle || g.item.name.toLowerCase().includes(needle) || (g.item.description ?? '').toLowerCase().includes(needle)));
  const count = (f: Filter) => groups.filter((g) => matchesFilter(g.item, f)).length;
  const current = groups.find((g) => g.item.name === open);

  if (inv.error && !inv.data) return <LoadFailed what="skills" error={inv.error} retry={inv.reload} />;
  if (!inv.data) return <LoadingRows loading={inv.loading} rows={6} />;
  if (!groups.length)
    return (
      <EmptyState action={<ButtonLink href="/extensions/plugins?view=marketplace" className={TOUCH}>Install a plugin</ButtonLink>}>
        No skills yet. Add a folder with a <span className="mono">SKILL.md</span> to <span className="mono">~/.conclave/skills</span>, or install a plugin that brings some.
      </EmptyState>
    );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pb-4">
        <div className="w-[260px] phone:w-full">
          <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or description" aria-label="Filter skills" />
        </div>
        <FilterLinks<Filter>
          label="Source"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: count('all') },
            { value: 'plugin', label: 'Plugins', count: count('plugin') },
            { value: 'yours', label: 'Yours', count: count('yours') },
            { value: 'learned', label: 'Learned', count: count('learned') },
            { value: 'clis', label: 'Other CLIs', count: count('clis') },
          ]}
        />
      </div>
      <RefreshFailed error={inv.error} retry={inv.reload} className="mb-3" />
      {filter === 'learned' && <LearnSetting />}
      <div className="rows border-t border-rule-2">
        {shown.map((g) => {
          const l = learnedOf(g);
          return (
            <button key={g.item.name} type="button" onClick={() => setOpen(g.item.name)} className="flex w-full items-start gap-4 py-[var(--row-py)] text-left transition-colors duration-[var(--dur-1)] hover:bg-hover phone:gap-3">
              <span className="min-w-0 flex-1">
                <span className={cn('mono block truncate text-[13px] phone:whitespace-normal phone:break-all', l && !l.enabled ? 'text-fg-3' : 'text-fg')}>{g.item.name}</span>
                {g.item.description && <span className="mt-0.5 line-clamp-2 block text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">{g.item.description}</span>}
                {l ? <LearnedLine l={l} /> : g.item.path && <span className="mono mt-0.5 block truncate text-[11.5px] text-fg-3 phone:text-[12px]">{shortPath(g.item.path)}</span>}
                {g.shadowed.map((s, i) => (
                  <ShadowLine key={i} s={s} />
                ))}
              </span>
              <span className="shrink-0 text-[12px] phone:text-[13px]">{l ? <span className="text-fg-2">Learned</span> : <WhereFrom item={g.item} />}</span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="py-4 text-[13px] text-fg-2 phone:text-[14px]">
            {needle ? `No skill matches "${q.trim()}".` : filter === 'learned' ? 'No learned skills yet. Agents write one after a long task or a tricky fix.' : 'No skills from this source.'}
          </p>
        )}
      </div>
      <SkillSheet
        g={current}
        all={inv.data}
        def={defs.data?.find((d) => d.name === current?.item.name && (!current?.item.path || d.path === current.item.path))}
        learned={current ? learnedOf(current) : undefined}
        onLearnedChanged={reloadAll}
        onClose={() => setOpen(undefined)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

interface Sight {
  harness: string;
  yes: boolean;
  why: string;
}

/** Which other CLIs read this skill (IA.md: Claude reads ~/.claude/skills; Codex, OpenCode and Gemini read ~/.agents/skills). */
function whoSees(item: InventoryItemDto, all: InventoryItemDto[]): Sight[] {
  const copies = all.filter((i) => i.kind === 'skill' && i.name === item.name);
  const at = (src: string) => copies.find((c) => c.source === src);
  const claude = at('claude');
  const shared = at('agents');
  const own = (src: string) => item.source === src;
  const sync = 'Sync to other CLIs copies it there.';
  const plugin = item.source === 'plugin';
  const viaShared = (name: string, src: string): Sight => {
    const harness = src === 'gemini' ? 'gemini-cli' : src;
    if (own(src)) return { harness, yes: true, why: `It is ${name}'s own file.` };
    if (shared) return { harness, yes: true, why: `From the shared copy in ${shared.path ? shortPath(shared.path.replace(/\/SKILL\.md$/, '')) : '~/.agents/skills'}.` };
    if (plugin) return { harness, yes: false, why: src === 'codex' ? 'Codex reads Claude Code plugins only when the plugin is installed in Codex.' : `${name} does not read Conclave plugins.` };
    return { harness, yes: false, why: `${name} reads ~/.agents/skills. ${sync}` };
  };
  return [
    own('claude')
      ? { harness: 'claude-code', yes: true, why: 'It is a Claude Code file.' }
      : claude
        ? { harness: 'claude-code', yes: true, why: `From the copy in ${claude.path ? shortPath(claude.path.replace(/\/SKILL\.md$/, '')) : '~/.claude/skills'}.` }
        : plugin
          ? { harness: 'claude-code', yes: false, why: 'Only when the plugin is installed in Claude Code too.' }
          : { harness: 'claude-code', yes: false, why: `Claude Code reads ~/.claude/skills. ${sync}` },
    viaShared('Codex', 'codex'),
    viaShared('OpenCode', 'opencode'),
    viaShared('Gemini CLI', 'gemini'),
  ];
}

function SkillSheet({ g, all, def, learned, onLearnedChanged, onClose }: { g: Grouped | undefined; all: InventoryItemDto[]; def: SkillDef | undefined; learned?: LearnedSkillDto; onLearnedChanged: () => void; onClose: () => void }) {
  const agents = useHub((s) => s.agents);
  const item = g?.item;
  const path = item?.path ?? def?.path;
  const dir = def?.dir || path?.replace(/\/SKILL\.md$/, '');
  // a learned skill is read through its own route, with its text; others from the hub's disk
  const learnedName = learned?.name;
  const detail = useLoad(async () => (learnedName ? await api().learnedSkill(learnedName) : undefined), [learnedName, learned?.updated, learned?.enabled]);
  // keyed by path, so a slow read never shows the skill opened before this one
  const file = useLoad(async () => (path && !learnedName ? { path, text: (await api().readDeviceFile('local', path)).content } : undefined), [path, learnedName]);
  const files = useLoad(async () => (dir && !learnedName ? { dir, list: await api().browse('local', dir) } : undefined), [dir, learnedName]);
  if (!g || !item) return <DetailSheet open={false} onClose={onClose} title="" label="Skill">{null}</DetailSheet>;
  const parsed = file.data && file.data.path === path ? splitFrontmatter(file.data.text) : undefined;
  const folder = files.data && files.data.dir === dir ? files.data.list : [];
  const allowed = def?.allowedTools ?? parsed?.fields.find(([k]) => k === 'allowed-tools')?.[1]?.split(/,\s*/).filter(Boolean);
  const preload = agents.filter((a) => a.skills?.includes(item.name));
  return (
    <DetailSheet
      open
      onClose={onClose}
      label={`Skill ${item.name}`}
      title={<span className="mono text-[16px]">{item.name}</span>}
      meta={
        <>
          {learned ? 'Learned' : <WhereFrom item={item} />}
          {path && (
            <>
              <br />
              <span className="mono break-all">{shortPath(path)}</span>
            </>
          )}
        </>
      }
    >
      {item.description && <p className="text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">{learned?.description ?? item.description}</p>}

      {learned && detail.data?.name === learned.name && (
        <LearnedBlocks
          key={`${learned.name}:${detail.data.updated}:${detail.data.enabled}`}
          l={detail.data}
          onChanged={() => (detail.reload(), onLearnedChanged())}
          onDeleted={() => (onLearnedChanged(), onClose())}
        />
      )}
      {learned && !detail.data && <LoadingRows loading={detail.loading} rows={3} />}

      <Block title="Use it" className="mt-5">
        <p className="text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
          {learned && !learned.enabled ? (
            'Turn it on to use it. While it is off, agents do not see it and /name does not find it.'
          ) : (
            <>
              Type <InlineCode>/{item.name}</InlineCode> in a session to load it now. Agents also load it on their own when a task matches the description.
            </>
          )}
        </p>
      </Block>

      <Block title="Allowed tools">
        {learned ? (
          <p className="text-[13px] text-fg-2 phone:text-[14px]">None. A learned skill is Markdown only and never widens what the agent may do.</p>
        ) : allowed?.length ? (
          <p className="text-[13px] leading-[1.6] text-fg-2">
            {allowed.map((t, i) => (
              <span key={t}>
                {i > 0 && ', '}
                <span className="mono text-fg">{t}</span>
              </span>
            ))}
          </p>
        ) : (
          <p className="text-[13px] text-fg-2 phone:text-[14px]">Not limited. While it runs, the skill can use any tool the agent has.</p>
        )}
      </Block>

      <Block title="Preloaded by">
        {preload.length ? (
          <p className="text-[13px] text-fg-2 phone:text-[14px]">
            {preload.map((a, i) => (
              <span key={a.name}>
                {i > 0 && ', '}
                <Link href={`/agents/${encodeURIComponent(a.name)}`} className="link tap">
                  {a.name}
                </Link>
              </span>
            ))}
            . These agents get its full text at the start of every session.
          </p>
        ) : (
          <p className="text-[13px] text-fg-2 phone:text-[14px]">No agent preloads it. Agents see the name and description and load the rest when needed.</p>
        )}
      </Block>

      {!learned && <Block title="Other CLIs on this hub" right={item.source === 'user' ? <TextAction label="Sync to other CLIs" href="/extensions/sources#sync" /> : undefined}>
        <ul className="rows">
          {whoSees(item, all).map((s) => (
            <li key={s.harness} className="flex items-baseline gap-3 py-2">
              <HarnessName harness={s.harness} size={13} className="w-[118px] shrink-0 text-[13px] text-fg phone:text-[14px]" />
              <span className={cn('w-7 shrink-0 text-[13px]', s.yes ? 'text-fg' : 'text-fg-3')}>{s.yes ? 'yes' : 'no'}</span>
              <span className="min-w-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{s.why}</span>
            </li>
          ))}
        </ul>
      </Block>}

      {g.shadowed.length > 0 && (
        <Block title="Shadowed copies">
          <p className="text-[12px] text-fg-3 phone:text-[13px]">These have the same name and lose to the copy above.</p>
          <ul className="mt-1">
            {g.shadowed.map((s, i) => (
              <li key={i} className="py-1 text-[13px] text-fg-2">
                {scopeWord(s.scope)}
                {s.path && (
                  <>
                    , <span className="mono break-all text-[12px]">{shortPath(s.path)}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <TextAction label="See all conflicts" href="/extensions/sources#conflicts" className="mt-1 inline-block" />
        </Block>
      )}

      {folder.length > 0 && (
        <Block title="Files in the folder">
          {dir && <p className="mono mb-1 text-[12px] break-all text-fg-3">{shortPath(dir)}/</p>}
          <p className="text-[13px] leading-[1.6] text-fg-2">
            {folder.map((f, i) => (
              <span key={f.path}>
                {i > 0 && ', '}
                <span className="mono">{f.type === 'dir' ? `${f.name}/` : f.name}</span>
              </span>
            ))}
          </p>
        </Block>
      )}

      {!learned && <Block title="SKILL.md">
        {file.error ? (
          <p className="text-[13px] text-fault phone:text-[14px]">Could not read SKILL.md. {sentence(file.error)} The file may have moved. Reload the page to see the current list.</p>
        ) : !parsed ? (
          <LoadingRows loading={file.loading} rows={3} />
        ) : (
          <Markdown text={parsed.body} className="text-[14px]" />
        )}
      </Block>}
    </DetailSheet>
  );
}
