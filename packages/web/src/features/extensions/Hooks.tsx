/**
 * Extensions > Hooks (docs/extensions/IA.md, docs/design/ECOSYSTEM.md 4).
 * Three views:
 *   Events (default): all 12 events in lifecycle order with their handler
 *     groups, where each comes from, whether it is on, its last runs, lint
 *     problems with a fix, and "from recipe" on handlers a recipe added.
 *   Recipes (?view=recipes): tested hooks to add in one step, by goal.
 *   Built in (?view=builtin): memory recall, extraction, compaction, file recall.
 * Add or edit handlers at user or project scope, test them against the real
 * hub, import from Gemini CLI or Codex. ?event=PreToolUse scrolls to that
 * event and marks it; ?recipe=<id> opens that recipe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import type { BuiltinHookDto, HookGroupDto, HookHandlerDto, HookImportResult, HookLintIssue, HooksOverview } from '@conclave/core/client';
import type { HookEvent, HooksConfig } from '@conclave/core/config/schema';
import { api } from '@/lib/api';
import { toast, useHub } from '@/store/store';
import { useIsMobile, useLoad } from '@/lib/hooks';
import { plural } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Menu } from '@/components/ui/Overlay';
import { FilterLinks, Tabs } from '@/components/ui/Tags';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Section';
import { useExtCwd } from './project';
import { TrustBanner } from './shared/TrustBanner';
import { EventSection, type HandlerActions } from './hooks/EventSection';
import { HandlerForm, type HandlerDraft } from './hooks/HandlerForm';
import { ImportDrawer } from './hooks/ImportDrawer';
import { RunsDrawer } from './hooks/RunsDrawer';
import { TestRunner, type TestStart } from './hooks/TestRunner';
import { RecipesView } from './hooks/Recipes';
import { RecipeSheet } from './hooks/RecipeSheet';
import { BuiltInView } from './hooks/BuiltIn';
import { handlerText, inScope, mergeHooks, placeHandler, pluginRoots, removeHandler, runsFor, scrollBehavior, scopeConfig, scopeIndex, type HandlerRef, type Scope } from './hooks/model';
import { errText } from '@/features/settings/parts';

const NEW_HANDLER: HandlerDraft = { scope: 'user', event: 'PreToolUse', matcher: '', handler: { type: 'command', command: '' } };

export function HooksTab() {
  const mobile = useIsMobile();
  const cwd = useExtCwd();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const focus = params.get('event') as HookEvent | null;
  const openRecipe = params.get('recipe');
  const view = params.get('view') === 'recipes' ? 'recipes' : params.get('view') === 'builtin' ? 'builtin' : 'events';
  const ov = useLoad(() => api().hooks(cwd), [cwd]);
  const recipes = useLoad(() => api().hookRecipes(cwd), [cwd]);
  const [builtins, setBuiltins] = useState<BuiltinHookDto[]>();
  const [builtinState, setBuiltinState] = useState<{ loading: boolean; error?: string }>({ loading: false });
  const hubName = useHub((s) => s.devices.local?.name ?? 'the hub');
  const titles = useMemo(() => Object.fromEntries((recipes.data ?? []).map((r) => [r.id, r.title])), [recipes.data]);

  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      const p = new URLSearchParams(search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) p.delete(k);
        else p.set(k, v);
      }
      const qs = p.toString();
      navigate(`/extensions/hooks${qs ? `?${qs}` : ''}`, { replace: true });
    },
    [search, navigate],
  );

  const loadBuiltins = useCallback(() => {
    setBuiltinState({ loading: true });
    api()
      .builtinHooks()
      .then((b) => {
        setBuiltins(b);
        setBuiltinState({ loading: false });
      })
      .catch((e) => setBuiltinState({ loading: false, error: errText(e) }));
  }, []);
  useEffect(() => {
    if (view === 'builtin') loadBuiltins();
  }, [view, loadBuiltins]);
  const [filter, setFilter] = useState<'all' | 'used'>('all');
  const [form, setForm] = useState<{ draft: HandlerDraft; from?: HandlerRef } | null>(null);
  const [test, setTest] = useState<TestStart | null>(null);
  const [runs, setRuns] = useState<{ event: HookEvent; handler?: HookHandlerDto } | null>(null);
  const [removing, setRemoving] = useState<{ ref: HandlerRef; text: string } | null>(null);
  const [importing, setImporting] = useState<'codex' | 'gemini' | null>(null);

  // ?event=X scrolls to that event once it renders; reloads after a test or a save do not scroll again
  const scrolled = useRef<string | null>(null);
  const loaded = !!ov.data;
  useEffect(() => {
    if (!focus) scrolled.current = null;
    if (!focus || !loaded || scrolled.current === focus) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`hook-${focus}`);
      if (!el) return;
      scrolled.current = focus;
      el.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    }, 80);
    return () => clearTimeout(t);
  }, [focus, loaded, filter]);

  const data = ov.data;
  const roots = useMemo(() => pluginRoots(data), [data]);
  const glosses = useMemo(() => Object.fromEntries((data?.events ?? []).map((e) => [e.event, e.gloss])) as Partial<Record<HookEvent, string>>, [data]);
  const total = data?.events.reduce((n, e) => n + e.groups.reduce((m, g) => m + g.hooks.length, 0), 0) ?? 0;
  const used = data?.events.filter((e) => e.groups.length).length ?? 0;
  const off = data?.events.reduce((n, e) => n + e.groups.filter((g) => !g.active).reduce((m, g) => m + g.hooks.length, 0), 0) ?? 0;
  const shown = (data?.events ?? []).filter((e) => filter === 'all' || e.groups.length || e.event === focus);

  /** Save one scope's full list. Returns an error sentence on failure. */
  const saveScope = async (scope: Scope, hooks: HooksConfig): Promise<string | undefined> => {
    try {
      await api().saveHooks({ scope, ...(scope === 'project' ? { cwd } : {}), hooks });
      return undefined;
    } catch (e) {
      return errText(e);
    }
  };

  const refOf = (current: HooksOverview, g: HookGroupDto, handler: number): HandlerRef | undefined => {
    const ev = current.events.find((e) => e.groups.includes(g));
    if (!ev) return undefined;
    const scope: Scope = inScope(g, 'user') ? 'user' : 'project';
    return { scope, event: ev.event, group: scopeIndex(ev, g, scope), handler };
  };

  const actions: HandlerActions = {
    onTest: (g) => {
      const ev = data?.events.find((e) => e.groups.includes(g));
      if (ev) setTest({ event: ev.event, group: g });
    },
    onEdit: (g, handler) => {
      if (!data) return;
      const ref = refOf(data, g, handler);
      if (!ref) return;
      setForm({ draft: { scope: ref.scope, event: ref.event, matcher: g.matcher ?? '', handler: g.hooks[handler] }, from: ref });
    },
    onRemove: (g, handler) => {
      if (!data) return;
      const ref = refOf(data, g, handler);
      if (ref) setRemoving({ ref, text: handlerText(g.hooks[handler]) });
    },
    onRuns: (event, handler) => setRuns({ event, handler }),
    onAdd: (event) => setForm({ draft: { ...NEW_HANDLER, event, scope: 'user' } }),
    onRecipe: (id) => setParam({ recipe: id }),
    onRemoveRecipe: (g, id) => setRemovingRecipe({ id, scope: inScope(g, 'user') ? 'user' : 'project' }),
    onFix: (issue) => void fix(issue),
  };

  const [removingRecipe, setRemovingRecipe] = useState<{ id: string; scope: Scope } | null>(null);

  /** Save a lint fix to the file it is for: config.json (user) or the project's .conclave/settings.json. */
  const fix = async (issue: HookLintIssue) => {
    if (!issue.fix || !issue.path) return;
    const scope: Scope = /\/\.conclave\/settings\.json$/.test(issue.path) ? 'project' : 'user';
    const err = await saveScope(scope, issue.fix);
    if (err) toast({ title: `Could not save the fix. ${err}`, level: 'error' });
    else {
      ov.reload();
      toast({ title: `Fixed. Saved to ${scope === 'user' ? 'config.json' : '.conclave/settings.json'}.` });
    }
  };

  const reloadAll = () => {
    ov.reload();
    recipes.reload();
  };

  const lintFor = (event: HookEvent) => (data?.lint ?? []).filter((i) => i.event === event);

  const runsList = runs && data ? (() => {
    const ev = data.events.find((e) => e.event === runs.event);
    if (!ev) return [];
    return runs.handler ? runsFor(ev.last, runs.handler) : ev.last;
  })() : [];

  const recipeRow = recipes.data?.find((r) => r.id === openRecipe);
  const recipeCount = recipes.data?.reduce((n, r) => n + (r.installed.length ? 1 : 0), 0);

  return (
    <div className="space-y-7 phone:space-y-8">
      <TrustBanner cwd={cwd} trust={data?.trust} onChange={() => ov.reload()} />

      <Tabs
        label="Hooks view"
        value={view}
        onChange={(v) => setParam({ view: v === 'events' ? null : v, event: null })}
        options={[
          { value: 'events', label: 'Events' },
          { value: 'recipes', label: 'Recipes', count: recipes.data ? recipes.data.length : undefined },
          { value: 'builtin', label: 'Built in' },
        ]}
      />

      {view === 'recipes' && (
        <RecipesView
          list={recipes.data}
          loading={recipes.loading}
          error={recipes.error}
          onReload={reloadAll}
          onOpen={(id) => setParam({ recipe: id })}
          hubName={hubName}
        />
      )}

      {view === 'builtin' && (
        <BuiltInView list={builtins} loading={builtinState.loading} error={builtinState.error} onReload={loadBuiltins} onChanged={(b) => setBuiltins((l) => l?.map((x) => (x.id === b.id ? b : x)))} />
      )}

      {view === 'events' && (
      <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <p className="m-0 min-w-0 flex-1 text-[14px] leading-[1.45] text-fg-2 phone:basis-full phone:text-[15px]">
          {data
            ? total
              ? `${plural(total, 'handler')} in ${plural(used, 'event')}.${off ? ` ${off} ${off === 1 ? 'is' : 'are'} off until you trust this folder.` : ''}`
              : 'No hooks yet. Add a recipe, add a handler, or import the ones you use in Codex or Gemini CLI.'
            : ' '}
          {data && recipeCount !== undefined && (
            <>
              {' '}
              <button type="button" onClick={() => setParam({ view: 'recipes' })} className="tap whitespace-nowrap text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
                {recipeCount ? `${plural(recipeCount, 'recipe')} added` : 'Browse recipes'}
              </button>
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Menu
            label="Import hooks"
            width={220}
            items={[
              { label: 'Import from Codex', onSelect: () => setImporting('codex') },
              { label: 'Import from Gemini CLI', onSelect: () => setImporting('gemini') },
            ]}
            trigger={({ ref, props }) => (
              <Button ref={ref} variant="quiet" size={mobile ? 'touch' : 'md'} {...props}>
                Import
              </Button>
            )}
          />
          <Button variant="outline" size={mobile ? 'touch' : 'md'} onClick={() => setTest({ event: focus ?? 'PreToolUse' })} disabled={!data}>
            Test a hook
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} onClick={() => setForm({ draft: { ...NEW_HANDLER, event: focus ?? 'PreToolUse' } })} disabled={!data}>
            Add a handler
          </Button>
        </div>
      </div>

      {ov.error && !data && (
        <div className="border-y border-rule-2 py-2">
          <Notice tone="fault" action={{ label: 'Retry', onClick: ov.reload }}>
            {`Failed. Could not load hooks: ${errText(ov.error)} Check that the hub is running, then retry.`}
          </Notice>
        </div>
      )}
      <LoadingRows loading={ov.loading && !data} rows={5} />

      {data && (
        <>
          <FilterLinks
            label="Events"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All events', count: data.events.length },
              { value: 'used', label: 'With handlers', count: used },
            ]}
          />
          {(data.lint ?? []).length > 0 && filter === 'all' && (
            <p className="-mt-3 text-[13px] leading-[1.45] text-warn phone:text-[14px]">
              {`${plural(data.lint!.length, 'problem')} in the hooks that load. Each one is listed under its event${data.lint!.some((i) => i.fix) ? ', with a fix where one is known' : ''}.`}
            </p>
          )}
          {shown.map((info) => (
            <EventSection key={info.event} info={info} highlight={focus === info.event} actions={actions} lint={lintFor(info.event)} titles={titles} />
          ))}
          {filter === 'used' && shown.length === 0 && <p className="text-[14px] text-fg-2">No event has a handler yet.</p>}
          <p className="text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
            Command hooks get the event as JSON on stdin and run on the hub. Exit 0 lets the action go on, exit 2 blocks it and stderr becomes the reason. Hooks from <span className="mono">~/.claude/settings.json</span> load while Claude Code compatibility is on.
          </p>
        </>
      )}
      </>
      )}

      <RecipeSheet
        id={openRecipe}
        open={!!openRecipe}
        onClose={() => setParam({ recipe: null })}
        row={recipeRow}
        cwd={cwd}
        hubName={hubName}
        onChanged={reloadAll}
        onTry={(t) => {
          setParam({ recipe: null });
          setTest({ event: t.event, input: t.input, matcherValue: t.matcherValue });
        }}
      />

      {data && (
        <HandlerForm
          open={!!form}
          onClose={() => setForm(null)}
          initial={form?.draft ?? NEW_HANDLER}
          editing={!!form?.from}
          cwd={cwd}
          events={data.events}
          onSave={async (d) => {
            const current = data;
            const from = form?.from;
            if (from && from.scope !== d.scope) {
              // moving between scopes: add to the new one, then take it out of the old one
              const err = await saveScope(d.scope, placeHandler(scopeConfig(current, d.scope), d.event, d.matcher, d.handler));
              if (err) return err;
              const err2 = await saveScope(from.scope, removeHandler(scopeConfig(current, from.scope), from));
              if (err2) return err2;
            } else {
              const err = await saveScope(d.scope, placeHandler(scopeConfig(current, d.scope), d.event, d.matcher, d.handler, from));
              if (err) return err;
            }
            ov.reload();
            toast({ title: d.scope === 'user' ? 'Saved to config.json.' : 'Saved to .conclave/settings.json.' });
            if (focus !== d.event) navigate(`/extensions/hooks?event=${d.event}`, { replace: true });
            return undefined;
          }}
        />
      )}

      <TestRunner open={!!test} onClose={() => setTest(null)} start={test} cwd={cwd} glosses={glosses} roots={roots} onRan={() => ov.reload()} />

      <RunsDrawer open={!!runs} onClose={() => setRuns(null)} event={runs?.event} handler={runs?.handler} runs={runsList} roots={roots} />

      <ImportDrawer
        open={!!importing}
        initialFrom={importing ?? 'codex'}
        onClose={() => setImporting(null)}
        cwd={cwd}
        onSave={async (scope: Scope, r: HookImportResult) => {
          if (!data) return 'Hooks are not loaded yet.';
          const err = await saveScope(scope, mergeHooks(scopeConfig(data, scope), r.hooks));
          if (err) return err;
          ov.reload();
          toast({ title: `Imported. Saved to ${scope === 'user' ? 'config.json' : '.conclave/settings.json'}.` });
          return undefined;
        }}
      />

      <ConfirmDialog
        open={!!removingRecipe}
        onClose={() => setRemovingRecipe(null)}
        title={`Remove the recipe ${removingRecipe ? (titles[removingRecipe.id] ?? removingRecipe.id) : ''}?`}
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          if (!removingRecipe) return;
          try {
            const res = await api().removeHookRecipe(removingRecipe.id, { scope: removingRecipe.scope, ...(removingRecipe.scope === 'project' ? { cwd } : {}) });
            toast({ title: `Removed. ${plural(res.removed ?? 0, 'handler')} taken out.` });
            reloadAll();
          } catch (e) {
            toast({ title: `Could not remove it. ${errText(e)}`, level: 'error' });
          }
        }}
      >
        <p className="m-0">
          Every handler it added to {removingRecipe?.scope === 'project' ? <span className="mono">.conclave/settings.json</span> : <span className="mono">config.json</span>} stops running. The script is deleted when nothing else uses it.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this handler?"
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          if (!removing || !data) return;
          const err = await saveScope(removing.ref.scope, removeHandler(scopeConfig(data, removing.ref.scope), removing.ref));
          if (err) toast({ title: `Could not remove it. ${err}`, level: 'error' });
          else ov.reload();
        }}
      >
        {removing && (
          <>
            <p className="m-0 [overflow-wrap:anywhere] font-mono text-[12.5px] text-fg">{removing.text}</p>
            <p className="mt-2 mb-0">
              It stops running at <span className="mono">{removing.ref.event}</span>. The script file stays where it is.
            </p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

