/**
 * Hooks > Recipes (ECOSYSTEM.md 4.2): tested hooks to add in one step,
 * grouped by goal. A row shows what the recipe watches, its goal and where it
 * is added; Add opens the sheet with the exact config, the scope and its
 * tests. The starter set adds eight bash and jq recipes at once.
 */
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { HookRecipeDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { plural } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { FilterLinks } from '@/components/ui/Tags';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Section';
import { CATEGORY_WORD, GOALS, STARTER, eventsWords, inGoal, installWords, type Goal } from './recipe-words';

export function RecipesView({
  list,
  loading,
  error,
  onReload,
  onOpen,
  hubName,
}: {
  list?: HookRecipeDto[];
  loading: boolean;
  error?: string;
  onReload: () => void;
  onOpen: (id: string) => void;
  hubName: string;
}) {
  const mobile = useIsMobile();
  const [goal, setGoal] = useState<Goal>('all');
  const [adding, setAdding] = useState<string | null>(null);

  const counts = useMemo(() => Object.fromEntries(GOALS.map((g) => [g.value, (list ?? []).filter((r) => inGoal(r, g.value)).length])) as Record<Goal, number>, [list]);
  const shown = useMemo(
    () => (list ?? []).filter((r) => inGoal(r, goal)).sort((a, b) => Number(b.recommended) - Number(a.recommended) || GOALS.findIndex((g) => g.cats?.includes(a.category)) - GOALS.findIndex((g) => g.cats?.includes(b.category))),
    [list, goal],
  );
  const starter = (list ?? []).filter((r) => STARTER.includes(r.id));
  const notAdded = starter.filter((r) => !r.installed.some((i) => i.scope === 'user'));
  const todo = notAdded.filter((r) => r.ready.ok);
  // programs the hub lacks for the starter recipes not added yet (jq on an older image)
  const lacking = [...new Set(notAdded.flatMap((r) => (r.ready.ok ? [] : r.ready.missing)))];

  const addStarter = async () => {
    let ok = 0;
    let failed = 0;
    const notes: string[] = [];
    for (const r of todo) {
      setAdding(`Adding ${r.title}`);
      try {
        const res = await api().installHookRecipe(r.id, { scope: 'user' });
        const bad = res.tests.filter((t) => !t.ok);
        if (bad.length) notes.push(`${r.title}: ${bad.length} of ${res.tests.length} tests failed`);
        ok++;
      } catch (e) {
        failed++;
        notes.push(`${r.title}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setAdding(null);
    onReload();
    toast({ title: failed || notes.length ? `Added ${ok} of ${todo.length}. ${notes.join('. ')}.` : `Added ${plural(ok, 'recipe')}. Every test passed.`, level: failed ? 'error' : undefined });
  };

  return (
    <div className="space-y-6 phone:space-y-7">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-rule-2 pb-4">
        <div className="min-w-0 flex-1 basis-[420px]">
          <h2 className="t-section text-fg">Starter set</h2>
          <p className="mt-1 mb-0 max-w-[70ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
            Eight recipes that guard git work, secrets, Proxmox and MCP writes, catch injected instructions, trim test output, question new dependencies and check work before the agent stops. Each needs only bash and jq on {hubName}, and goes into <span className="mono">config.json</span> for every session on this hub.
          </p>
          {list && lacking.length > 0 && (
            <p className="mt-1 mb-0 text-[12px] text-warn phone:text-[13px]">
              {`${plural(notAdded.length - todo.length, 'recipe')} of the set ${notAdded.length - todo.length === 1 ? 'needs' : 'need'} ${lacking.join(' and ')}, which ${lacking.length === 1 ? 'is' : 'are'} not on ${hubName}. Install ${lacking.length === 1 ? 'it' : 'them'} there, or open each one and pick Add it anyway.`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 pt-0.5">
          {adding && <span className="text-[12px] text-fg-3 phone:text-[13px]">{adding}</span>}
          <Button variant="outline" size={mobile ? 'touch' : 'md'} disabled={!list || !todo.length} busy={adding ? 'Adding' : false} onClick={() => void addStarter()}>
            {!list ? 'Add 8 recipes' : todo.length ? `Add ${plural(todo.length, 'recipe')}` : notAdded.length ? 'Nothing to add yet' : 'All added'}
          </Button>
        </div>
      </div>

      {error && !list && (
        <div className="border-y border-rule-2 py-2">
          <Notice tone="fault" action={{ label: 'Retry', onClick: onReload }}>
            {`Failed. Could not load the recipes: ${error} Check that the hub is running, then retry.`}
          </Notice>
        </div>
      )}
      <LoadingRows loading={loading && !list} rows={6} />

      {list && (
        <>
          <div>
            <FilterLinks label="Goal" value={goal} onChange={setGoal} options={GOALS.map((g) => ({ value: g.value, label: g.label, count: counts[g.value] }))} />
            {goal !== 'all' && <p className="mt-2 mb-0 text-[13px] text-fg-3 phone:text-[14px]">{GOALS.find((g) => g.value === goal)?.gloss}</p>}
          </div>
          <div className="rows border-t border-rule-2">
            {shown.map((r) => (
              <div key={r.id}>
                <RecipeRow r={r} onOpen={() => onOpen(r.id)} hubName={hubName} />
              </div>
            ))}
          </div>
          <p className="text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
            Every recipe reads Claude Code&apos;s hook JSON and prints Claude Code&apos;s answers, so the same script also works in <span className="mono">~/.claude/settings.json</span> and Codex. Its tests run through the hub&apos;s own hook runner when you add it.
          </p>
        </>
      )}
    </div>
  );
}

function RecipeRow({ r, onOpen, hubName }: { r: HookRecipeDto; onOpen: () => void; hubName: string }) {
  const mobile = useIsMobile();
  const added = r.installed.length > 0;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  const meta = [eventsWords(r.handlers), CATEGORY_WORD[r.category], r.recommended ? 'recommended' : null, plural(r.testCount, 'test'), added ? `added to ${r.installed.map((i) => installWords(i)).join(' and ')}` : null].filter(Boolean);
  return (
    <div
      role="group"
      aria-label={r.title}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onKey}
      className="-mx-3 flex cursor-pointer gap-4 px-3 py-3 outline-none transition-colors duration-[var(--dur-1)] hover:bg-hover focus-visible:bg-hover phone:-mx-2 phone:gap-3 phone:px-2"
    >
      <div className="min-w-0 flex-1">
        <div className="t-row truncate text-fg">{r.title}</div>
        <div className="mt-0.5 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
          {meta.map((p, i) => (
            <span key={i}>
              <span className={cn(i === 0 && 'font-mono text-[11.5px] phone:text-[12.5px]')}>{p}</span>
              {i < meta.length - 1 ? ', ' : ''}
            </span>
          ))}
        </div>
        <p className="mt-1 mb-0 line-clamp-2 max-w-[80ch] text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">{r.summary}</p>
        {!r.ready.ok && <p className="mt-1 mb-0 text-[12px] text-warn phone:text-[13px]">Needs {r.ready.missing.join(' and ')} on {hubName}.</p>}
      </div>
      <div className="shrink-0 pt-px">
        {added ? (
          <span className="text-[13px] text-fg-3 phone:text-[14px]">added</span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className={cn(mobile && 'h-8 px-3.5 text-[14px]')}
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            aria-label={`Add ${r.title}`}
          >
            Add
          </Button>
        )}
      </div>
    </div>
  );
}
