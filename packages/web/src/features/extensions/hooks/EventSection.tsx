/**
 * One hook event as a section: the event name in mono, when it fires, what a
 * hook there can do (stdin, exit codes, stdout fields, from core's
 * hook-events.ts), its problems, then its handler groups with matcher,
 * source, state and the last run of each handler. An event with no handlers
 * and no problems is one row that opens to its description and Add.
 */
import { useState } from 'react';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { Link } from 'wouter';
import type { HookEventInfo, HookGroupDto, HookHandlerDto, HookLintIssue, HookRunDto } from '@conclave/core/client';
import type { HookEvent } from '@conclave/core/config/schema';
import { HOOK_EVENT_DOCS, HOOK_OTHER_EXIT, HOOK_STDIN_COMMON } from '@conclave/core/extensions/hook-events';
import { useIsMobile, useNow } from '@/lib/hooks';
import { duration, plural, relTime } from '@/lib/format';
import { cn } from '@/lib/text';
import { IconButton } from '@/components/ui/Button';
import { Menu, type MenuItem } from '@/components/ui/Overlay';
import { SelectedMark, StateWord } from '@/components/ui/List';
import { TextAction } from '@/components/ui/Section';
import { Tooltip } from '@/components/ui/Tooltip';
import { SourceBadge } from '../shared/SourceBadge';
import { anyWords, canEdit, defaultTimeoutWords, groupFile, handlerText, matcherWords, networkWithoutTimeout, recipeOf, resultTone, resultWord, runsFor, tokenWords, withPluginRoot, type Tone } from './model';

const TONE: Record<Tone, string> = { ok: 'text-ok', fault: 'text-fault', warn: 'text-warn', dim: 'text-fg-3', neutral: 'text-fg-2' };

export interface HandlerActions {
  onTest: (g: HookGroupDto) => void;
  onEdit: (g: HookGroupDto, handler: number) => void;
  onRemove: (g: HookGroupDto, handler: number) => void;
  onRuns: (event: HookEvent, h?: HookHandlerDto) => void;
  onAdd: (event: HookEvent) => void;
  /** Open a recipe's sheet. */
  onRecipe?: (id: string) => void;
  /** Remove every handler of a recipe from the group's scope. */
  onRemoveRecipe?: (g: HookGroupDto, id: string) => void;
  /** Save a lint fix. */
  onFix?: (issue: HookLintIssue) => void;
}

/** The recipe titles by id, so rows can say "from recipe Git work saver". */
export type RecipeTitles = Record<string, string>;

export function EventSection({ info, highlight, actions, lint = [], titles = {} }: { info: HookEventInfo; highlight?: boolean; actions: HandlerActions; lint?: HookLintIssue[]; titles?: RecipeTitles }) {
  const handlers = info.groups.reduce((n, g) => n + g.hooks.length, 0);
  const off = info.groups.filter((g) => !g.active).reduce((n, g) => n + g.hooks.length, 0);
  const [open, setOpen] = useState(false);
  const doc = HOOK_EVENT_DOCS[info.event];
  if (!info.groups.length && !lint.length && !highlight)
    return (
      <section id={`hook-${info.event}`} aria-labelledby={`hook-${info.event}-h`} className="scroll-mt-6 border-t border-rule-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="tap flex w-full min-w-0 items-baseline gap-2 py-2.5 text-left hover:text-fg"
        >
          <ChevronRight aria-hidden className={cn('size-3.5 shrink-0 self-center text-fg-3 transition-transform duration-[var(--dur-1)]', open && 'rotate-90')} />
          <h3 id={`hook-${info.event}-h`} className="shrink-0 font-mono text-[13px] font-medium text-fg phone:text-[14px]">
            {info.event}
          </h3>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3 phone:text-[13.5px]">{doc?.when ?? info.gloss}</span>
          {!info.fires && <span className="shrink-0 text-[12px] text-warn phone:text-[13px]">Not fired yet</span>}
        </button>
        {open && (
          <div className="pb-3 pl-[22px] phone:pl-0">
            <EventContract event={info.event} />
            <div className="mt-2 flex items-baseline gap-3 text-[13px] text-fg-3 phone:text-[14px]">
              <span>No handlers.</span>
              <TextAction label="Add a handler" onClick={() => actions.onAdd(info.event)} className="text-fg-2 underline decoration-rule-2 underline-offset-[3px]" />
            </div>
          </div>
        )}
      </section>
    );
  return (
    <section
      id={`hook-${info.event}`}
      aria-labelledby={`hook-${info.event}-h`}
      aria-current={highlight ? 'true' : undefined}
      className={cn('scroll-mt-6 border-t border-rule-2 pt-3 pb-4', highlight && 'relative -mx-3 bg-raise px-3 pb-1 phone:-mx-2 phone:px-2')}
    >
      {highlight && <SelectedMark />}
      <div className={cn('flex items-baseline gap-2', highlight && 'pt-2')}>
        <h3 id={`hook-${info.event}-h`} className="font-mono text-[13.5px] font-medium text-fg phone:text-[14.5px]">
          {info.event}
        </h3>
        {handlers > 0 && <span className="num text-[13px] text-fg-3">{handlers}</span>}
        {off > 0 && <span className="text-[12px] text-warn phone:text-[13px]">{off} off</span>}
        <span className="ml-auto flex items-baseline gap-4">
          {!info.fires && (
            <StateWord tone="warn" className="text-[12px] phone:text-[13px]">
              Not fired yet
            </StateWord>
          )}
          <TextAction label="Add" onClick={() => actions.onAdd(info.event)} />
        </span>
      </div>
      {lint.length > 0 && (
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0" aria-label={`Problems in ${info.event}`}>
          {lint.map((i, n) => (
            <li key={n} className={cn('text-[12.5px] leading-[1.45] [overflow-wrap:anywhere] phone:text-[13.5px]', i.level === 'error' ? 'text-fault' : 'text-warn')}>
              {i.text}
              {i.path && (
                <span className="text-fg-3">
                  {' In '}
                  <span className="mono" title={i.path}>
                    {fileWords(i.path)}
                  </span>
                  .
                </span>
              )}
              {i.plugins?.map((p) => (
                <span key={p}>
                  {' '}
                  <Link href={`/extensions/plugins?plugin=${encodeURIComponent(p)}`} className="tap text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
                    {`Plugin ${p}`}
                  </Link>
                </span>
              ))}
              {i.fix && i.path && actions.onFix && (
                <>
                  {' '}
                  <TextAction label={/\.claude\//.test(i.path) ? 'Fix it in this file' : 'Fix it'} onClick={() => actions.onFix!(i)} />
                </>
              )}
              {i.path && (
                <>
                  {' '}
                  <Link href={openFileHref(i.path)} className="tap whitespace-nowrap text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
                    Open file
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 mb-0 max-w-[80ch] text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
        {doc?.when ?? `${info.gloss}.`} {matcherWords(info)}
        {info.last.length > 0 && (
          <>
            {' '}
            <TextAction label={`${plural(info.last.length, 'recent run')}`} onClick={() => actions.onRuns(info.event)} className="whitespace-nowrap underline decoration-rule-2 underline-offset-[3px]" />
          </>
        )}
      </p>
      <div className="pb-[9px]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="tap mt-1 inline-flex items-baseline gap-1 text-[12px] text-fg-3 hover:text-fg phone:text-[13px]"
        >
          <ChevronRight aria-hidden className={cn('size-3 self-center transition-transform duration-[var(--dur-1)]', open && 'rotate-90')} />
          What a hook can do here
        </button>
        {open && (
          <div className="mt-1.5">
            <EventContract event={info.event} />
          </div>
        )}
      </div>
      <div className={cn('rows border-t border-rule-2', highlight && 'pb-1')}>
        {info.groups.map((g) => (
          <GroupBlock key={`${g.source}:${g.plugin ?? ''}:${g.path ?? ''}:${g.index}`} info={info} g={g} actions={actions} titles={titles} />
        ))}
        {info.groups.length === 0 && (
          <div className="flex items-baseline gap-3 py-2.5 text-[13px] text-fg-3 phone:text-[14px]">
            <span>No handlers.</span>
            <TextAction label="Add one" onClick={() => actions.onAdd(info.event)} />
          </div>
        )}
      </div>
    </section>
  );
}

/** What a hook at this event gets on stdin, what its exit codes do, and the stdout fields Conclave acts on. */
export function EventContract({ event }: { event: HookEvent }) {
  const doc = HOOK_EVENT_DOCS[event];
  if (!doc) return null;
  const row = 'grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 phone:grid-cols-1';
  const key = 'text-fg-3';
  return (
    <div className="max-w-[90ch] space-y-1 text-[12.5px] leading-[1.5] text-fg-2 phone:text-[13.5px]">
      <div className={row}>
        <span className={key}>stdin JSON</span>
        <span className="[overflow-wrap:anywhere]">
          <span className="font-mono text-[12px] text-fg">{doc.stdin.join(', ')}</span>
          <span className="text-fg-3">
            {', plus '}
            <span className="font-mono text-[12px]">{HOOK_STDIN_COMMON.join(', ')}</span>
          </span>
        </span>
      </div>
      <div className={row}>
        <span className={key}>exit 0</span>
        <span>{doc.stdout.length || doc.plainStdout ? 'Goes on. Conclave reads stdout as below.' : 'Goes on. Output is not read.'}</span>
      </div>
      <div className={row}>
        <span className={key}>exit 2</span>
        <span>{doc.exit2}</span>
      </div>
      <div className={row}>
        <span className={key}>other exit</span>
        <span>{HOOK_OTHER_EXIT}</span>
      </div>
      {doc.plainStdout && (
        <div className={row}>
          <span className={key}>plain stdout</span>
          <span>{doc.plainStdout}</span>
        </div>
      )}
      {doc.stdout.length > 0 && (
        <div className={row}>
          <span className={key}>stdout JSON</span>
          <ul className="m-0 list-none space-y-0.5 p-0">
            {doc.stdout.map((f) => (
              <li key={f.field} className="[overflow-wrap:anywhere]">
                <span className="font-mono text-[12px] text-fg">{f.field}</span> {f.does}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "config.json", "~/.claude/settings.json", ".conclave/settings.json". */
export function fileWords(path: string): string {
  if (/\/config\.json$/.test(path)) return 'config.json';
  const m = /(\.(?:claude|conclave)\/settings(?:\.local)?\.json)$/.exec(path);
  if (!m) return path;
  // the user file sits right under the home folder; a project file under the project
  return /^\/(?:home|Users)\/[^/]+\/\.claude\/settings\.json$|^\/root\/\.claude\/settings\.json$/.test(path) ? `~/${m[1]}` : m[1];
}

/** The hub's file viewer at that file. */
export function openFileHref(path: string): string {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  return `/devices/local/files?path=${encodeURIComponent(dir)}&file=${encodeURIComponent(path)}`;
}

function GroupBlock({ info, g, actions, titles }: { info: HookEventInfo; g: HookGroupDto; actions: HandlerActions; titles: RecipeTitles }) {
  const ignored = !info.matcherValue && !!g.matcher;
  const file = groupFile(g);
  return (
    <div className={cn('py-3', !g.active && 'text-fg-3')}>
      <div className="flex min-w-0 items-baseline gap-3 phone:flex-col phone:items-start phone:gap-0.5">
        <span className="min-w-0 max-w-[62%] shrink-0 truncate text-[13px] phone:max-w-full phone:text-[14px]">
          {g.matcher && !ignored ? (
            <span className={cn('font-mono text-[12.5px]', g.active ? 'text-fg' : 'text-fg-3')} title="Matcher">
              {g.matcher}
            </span>
          ) : (
            <span className="text-fg-3">{anyWords(info.event, info.matcherValue)}</span>
          )}
          {ignored && (
            <span className="text-fg-3">
              , matcher <span className="mono">{g.matcher}</span> is ignored
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 justify-end text-[12px] whitespace-nowrap text-fg-3 phone:justify-start phone:text-[13px] phone:whitespace-normal" title={g.path}>
          <span className="min-w-0 truncate phone:overflow-visible phone:whitespace-normal">
            {g.source === 'plugin' && g.plugin ? (
              <Link href={`/extensions/plugins?plugin=${encodeURIComponent(g.plugin)}`} className="tap hover:text-fg">
                <SourceBadge source="plugin" plugin={g.plugin} className="text-inherit" />
              </Link>
            ) : (
              <SourceBadge source={g.source} label={GROUP_SOURCE[g.source]} />
            )}
            {file && <span className="mono"> {file}</span>}
          </span>
          <span className={cn('shrink-0', g.active ? 'text-fg-3' : 'text-warn')}>{g.active ? ', on' : ', off'}</span>
        </span>
      </div>
      {!g.active && <p className="mt-1 mb-0 text-[12px] text-warn phone:text-[13px]">Off until you trust this folder.</p>}
      {!canEdit(g) && <ForeignSource g={g} />}
      {g.hooks.map((h, i) => (
        <HandlerLine key={i} info={info} g={g} h={h} index={i} actions={actions} titles={titles} />
      ))}
    </div>
  );
}

/** Source words on the Hooks page, where "user" alone does not say which file. */
const GROUP_SOURCE: Record<string, string> = { config: 'Conclave config', 'claude-user': 'Claude Code ~/.claude', 'claude-project': 'Claude Code project', project: 'project' };

/** A group Conclave does not write: where to edit it, or how to turn its source off. */
function ForeignSource({ g }: { g: HookGroupDto }) {
  const link = 'tap whitespace-nowrap text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg';
  if (g.source === 'plugin')
    return (
      <p className="mt-1 mb-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
        {`From plugin ${g.plugin ?? ''}, read only here. `}
        <Link href={`/extensions/plugins?plugin=${encodeURIComponent(g.plugin ?? '')}`} className={link}>
          Turn off this source
        </Link>
      </p>
    );
  const file = g.path ? fileWords(g.path) : undefined;
  return (
    <p className="mt-1 mb-0 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
      From <span className="mono">{file ?? 'its file'}</span>, edit there.{' '}
      {g.path && (
        <Link href={openFileHref(g.path)} className={link}>
          Open file
        </Link>
      )}
      {g.source === 'claude-user' && (
        <>
          {' '}
          <Link href="/extensions/sources" className={link}>
            Turn off this source
          </Link>
        </>
      )}
    </p>
  );
}

/** The command on one line, cut with an ellipsis; a tap shows all of it (hover shows it too). */
function CommandLine({ h }: { h: HookHandlerDto }) {
  const [full, setFull] = useState(false);
  const text = handlerText(h);
  if (full || h.type !== 'command') return <CommandText h={h} />;
  return (
    <button type="button" onClick={() => setFull(true)} title={text} aria-label={`Command: ${text}. Show all of it`} className="tap block w-full min-w-0 truncate text-left font-mono text-[12.5px] leading-[1.5]">
      {withPluginRoot(text, h.pluginRoot)}
    </button>
  );
}

function CommandText({ h }: { h: HookHandlerDto }) {
  const text = handlerText(h);
  if (h.type === 'mcp_tool')
    return (
      <span className="text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
        <span className="text-fg-3">MCP tool: </span>
        <span className="font-mono text-[12.5px] text-fg">
          {h.server} {h.tool}
        </span>
        {h.input && Object.keys(h.input).length > 0 && <span className="font-mono text-[12px] text-fg-3"> {JSON.stringify(h.input)}</span>}
      </span>
    );
  if (h.type === 'prompt')
    return (
      <span className="text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
        <span className="text-fg-3">Prompt: </span>
        {text}
      </span>
    );
  const root = h.pluginRoot;
  if (!root || !text.includes(root)) return <span className="font-mono text-[12.5px] leading-[1.5] [overflow-wrap:anywhere]">{text}</span>;
  const parts = text.split(root);
  return (
    <span className="font-mono text-[12.5px] leading-[1.5] [overflow-wrap:anywhere]">
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && (
            <Tooltip content={<span className="font-mono text-[11.5px]">{root}</span>}>
              <span tabIndex={0} className="cursor-help rounded-[2px] text-fg-2 underline decoration-rule-2 decoration-dotted underline-offset-[3px] outline-none focus-visible:outline-2 focus-visible:outline-signal">
                {'${CLAUDE_PLUGIN_ROOT}'}
              </span>
            </Tooltip>
          )}
        </span>
      ))}
    </span>
  );
}

function LastRun({ run }: { run: HookRunDto }) {
  useNow(30_000);
  const tone = resultTone(run.result);
  return (
    <span className="text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
      <span className={TONE[tone]}>{resultWord(run.result)}</span>
      {run.exitCode !== undefined && run.exitCode !== null && <>, exit {run.exitCode}</>}
      {run.result !== 'async' && run.result !== 'skipped' && <>, {duration(run.durationMs)}</>}, {relTime(run.at) === 'now' ? 'just now' : `${relTime(run.at)} ago`}
    </span>
  );
}

function HandlerLine({ info, g, h, index, actions, titles }: { info: HookEventInfo; g: HookGroupDto; h: HookHandlerDto; index: number; actions: HandlerActions; titles: RecipeTitles }) {
  const mobile = useIsMobile();
  const runs = runsFor(info.last, h);
  const last = runs[runs.length - 1];
  const recipe = recipeOf(h);
  const meta = [
    h.type === 'prompt' ? 'prompt' : h.type === 'mcp_tool' ? (h.allowWrite ? 'may write' : 'read only') : 'command',
    h.timeout ? `timeout ${h.timeout}s` : defaultTimeoutWords(info.event),
    h.async ? 'async, runs in the background' : '',
    h.model ? `model ${h.model}` : '',
    h.onFailure === 'block' ? 'blocks if it fails' : '',
    h.once ? 'once per session' : '',
    tokenWords(h.tokensPerSession) ?? '',
  ].filter(Boolean);
  const editable = canEdit(g);
  const items: MenuItem[] = [
    { label: 'Test this group', disabled: !g.active, detail: g.active ? undefined : 'Trust the folder first', onSelect: () => actions.onTest(g) },
    { label: runs.length ? `Last runs (${runs.length})` : 'No runs yet', disabled: !runs.length, onSelect: () => actions.onRuns(info.event, h) },
  ];
  if (recipe && actions.onRecipe) items.push({ separator: true, label: '' }, { label: `Recipe ${titles[recipe] ?? recipe}`, detail: 'What it does, its tests, tunables', onSelect: () => actions.onRecipe!(recipe) });
  if (editable && recipe && actions.onRemoveRecipe) items.push({ label: 'Remove the recipe', detail: 'Every handler it added here', danger: true, onSelect: () => actions.onRemoveRecipe!(g, recipe) });
  if (editable)
    items.push({ separator: true, label: '' }, { label: 'Edit', onSelect: () => actions.onEdit(g, index) }, { label: recipe ? 'Delete this handler' : 'Delete', danger: true, onSelect: () => actions.onRemove(g, index) });
  else
    items.push(
      { separator: true, label: '' },
      g.source === 'plugin'
        ? { label: `From plugin ${g.plugin ?? ''}, read only`, detail: 'Turn the plugin off to stop it', disabled: true }
        : { label: 'Read only here', detail: `Edit ${groupFile(g) ?? g.path ?? 'the file'} by hand`, disabled: true },
    );
  return (
    <div className={cn('mt-2 grid items-start gap-x-4 gap-y-1', mobile ? 'grid-cols-[minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto_auto]')}>
      <div className="min-w-0">
        <div className={cn(g.active ? 'text-fg' : 'text-fg-3')}>
          <CommandLine h={h} />
        </div>
        <div className="mt-0.5 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
          {meta.join(', ')}
          {h.if && (
            <>
              ,{' '}
              <span className="mono text-fg-2" title="if: the handler runs only for calls that match this permission rule">
                if {h.if}
              </span>
            </>
          )}
          {recipe && (
            <>
              , from recipe{' '}
              {actions.onRecipe ? (
                <button type="button" onClick={() => actions.onRecipe!(recipe)} className="tap text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
                  {titles[recipe] ?? recipe}
                </button>
              ) : (
                <span className="text-fg-2">{titles[recipe] ?? recipe}</span>
              )}
            </>
          )}
        </div>
        {networkWithoutTimeout(h) && (
          <p className="mt-1 mb-0 text-[12px] leading-[1.4] text-warn phone:text-[13px]">
            No timeout, and it calls the network. A slow server can hold the session for up to 10 minutes. {editable ? 'Set a timeout with Edit.' : 'Add a timeout in its file.'}
          </p>
        )}
        {mobile && (
          <div className="mt-0.5">
            {last ? <LastRun run={last} /> : <span className="text-[13px] text-fg-3">No runs yet</span>}
          </div>
        )}
        {editable && (
          <div className="mt-0.5 flex gap-4">
            <TextAction label="Edit" onClick={() => actions.onEdit(g, index)} />
            <TextAction label="Delete" onClick={() => actions.onRemove(g, index)} />
          </div>
        )}
      </div>
      {!mobile && (
        <div className="pt-px text-right">
          {last ? (
            <button type="button" onClick={() => actions.onRuns(info.event, h)} className="tap rounded-[var(--r-1)] text-right hover:text-fg" title={`${plural(runs.length, 'run')}. Open the output.`}>
              <LastRun run={last} />
            </button>
          ) : (
            <span className="text-[12px] text-fg-3">No runs yet</span>
          )}
        </div>
      )}
      <Menu
        label={`Handler actions`}
        width={240}
        items={items}
        trigger={({ ref, props }) => (
          <IconButton ref={ref} label="Handler actions" size={mobile ? 'touch' : 'sm'} className={cn(mobile ? '-mt-2 -mr-2' : '-mt-1')} {...props}>
            <MoreHorizontal />
          </IconButton>
        )}
      />
    </div>
  );
}
