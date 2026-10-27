/**
 * Command palette (spec 11.13): ⌘K / Ctrl K and Search in the sidebar. A 640px
 * dialog 15vh from the top; a 48px input with only a rule under it; results
 * in groups (Actions, Chats, Sessions, Pages, Agents, Models, Memory). Typing
 * ">" limits to actions, "@" to chats and sessions, "#" to memory. On phones a full height
 * sheet opened from Search in the drawer. Words match in any order, and the
 * commands used lately come first (lib/palette.ts).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'wouter';
import { ChevronLeft } from 'lucide-react';
import type { SessionMode } from '@conclave/core/types';
import type { WorkflowSummary } from '@conclave/core/client';
import { cn } from '@/lib/text';
import { loadRecent, rankItems, rememberCommand } from '@/lib/palette';
import { useHub, attempt, upsertSession } from '@/store/store';
import { closePalette, openNewChat, openShortcuts, resolvedTheme, toggleContext, toggleTheme, useUi } from '@/store/ui';
import { api } from '@/lib/api';
import { relTime } from '@/lib/format';
import { contextLabel, isHarness, modelName } from '@/lib/models';
import { useFocusTrap } from './ui/Overlay';
import { useIsMobile } from '@/lib/hooks';
import { NAV, OWNER_PAGES, SETTINGS_NAV } from './Shell';
import { useIsOwner } from '@/lib/people';
import { Kbd, MOD } from './ui/Kbd';
import { ModelMark, ModelName } from './logo';
import { MODES } from '@/features/chat/modes';
import { chooseChatModel } from '@/features/conversation/actions';
import { useStartMode } from '@/features/home/start';
import { RUN_SETUP_AGAIN } from '@/lib/onboarding';
import { isDelegated } from '@conclave/core/session/delegated';
import { delegateWho } from '@/lib/sidebar';

type Group = 'Recent' | 'Actions' | 'Chats' | 'Sessions' | 'Pages' | 'Agents' | 'Models' | 'Memory' | 'Messages' | 'Mode' | 'Run routine' | 'Run workflow';

interface Item {
  id: string;
  group: Group;
  label: ReactNode;
  /** text for filtering */
  text: string;
  lead?: ReactNode;
  detail?: ReactNode;
  hint?: ReactNode;
  run: () => void;
  /** keep the palette open (sub menus) */
  keep?: boolean;
  /** shown with an empty query */
  top?: boolean;
  /** Under Recent: the group it came from, so using it again is remembered as the same command. */
  from?: Group;
}

/** Extensions tabs as pages: [route, label, extra words to match]. */
const EXTENSION_TABS: Array<[string, string, string]> = [
  ['overview', 'Extensions overview', 'problems loaded other clis compat'],
  ['discover', 'Discover', 'github search recommended add install mcp skills plugins hook recipes'],
  ['tools', 'Tools', 'permissions allow ask deny rules'],
  ['skills', 'Skills', 'SKILL.md'],
  ['commands', 'Commands', 'slash prompts arguments'],
  ['hooks', 'Hooks', 'PreToolUse events scripts'],
  ['plugins', 'Plugins', 'marketplace install'],
  ['mcp', 'MCP servers', 'mcp tools servers'],
  ['sources', 'Sources', 'conflicts shadowed sync load order'],
];

/** Settings sections as pages, with the words people search for. */
const SETTINGS_SECTIONS: Array<[string, string, string]> = [
  ['account', 'Your account', 'name password sign out switch account email'],
  ['people', 'People', 'people members friend family invite add person budget access'],
  ['providers', 'Providers', 'keys api plans logins'],
  ['defaults', 'Defaults', 'default model agent device memory'],
  ['permissions', 'Permissions', 'rules allow ask deny mode'],
  ['notifications', 'Notifications', 'notify push alerts phone browser hold'],
  ['assistant', 'Assistant', 'proactive preferences tell me never quiet hours message hours timezone heartbeat checklist nightly reflection'],
  ['gateway', 'Gateway keys', 'gateway keys claude code codex usage'],
  ['appearance', 'Appearance', 'theme dark light density motion name text size font'],
  ['audit', 'Audit log', 'history actions blocked pairings'],
  ['remote', 'Remote access', 'phone away from home anywhere tunnel cloudflare tailscale address url network wifi'],
  ['friends', 'Friends', 'friend invite link qr code safety code verify notes other hubs people share'],
  ['about', 'About', 'version hub client connection'],
];

/** The settings a member has (docs/design/ACCOUNTS.md 10); the rest are the hub owner's. */
const MEMBER_SETTINGS = new Set(['account', 'providers', 'notifications', 'assistant', 'appearance', 'audit', 'about']);

const ORDER: Group[] = ['Recent', 'Actions', 'Chats', 'Sessions', 'Pages', 'Agents', 'Models', 'Memory', 'Messages', 'Mode', 'Run routine', 'Run workflow'];

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const mode = useUi((s) => s.paletteMode);
  const initial = useUi((s) => s.paletteQuery);
  const set = useUi((s) => s.set);
  const [q, setQ] = useState(initial ?? '');
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState<Array<{ sessionId: string; messageId: string; snippet: string; title: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [loc, navigate] = useLocation();
  const mobile = useIsMobile();
  const sessionId = loc.startsWith('/s/') ? loc.slice(3).split('/')[0] : undefined;
  const sessions = useHub((s) => s.sessions);
  const agents = useHub((s) => s.agents);
  const models = useHub((s) => s.models);
  const routines = useHub((s) => s.routines);
  const memories = useHub((s) => s.memories);
  // setup and extensions are the hub owner's (docs/design/ACCOUNTS.md 10): a member's palette leaves them out
  const owner = useIsOwner();
  const current = sessionId ? sessions[sessionId] : undefined;
  // on the Chat page a model goes to the open chat (or the next new chat), never to a new session;
  // so it does on Home while its box starts a chat
  const chatId = loc.startsWith('/chat/') ? loc.slice(6).split('/')[0] : undefined;
  const startMode = useStartMode((s) => s.mode);
  const onChat = loc === '/chat' || !!chatId || (loc === '/' && startMode === 'chat');
  useFocusTrap(boxRef, true, { initial: inputRef });

  const close = closePalette;
  // read once per open: what was used lately on this device
  const [recent] = useState(loadRecent);
  // the workflow library, fetched only when its list is open
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  useEffect(() => {
    if (mode !== 'workflow') return;
    let live = true;
    api()
      .workflows()
      .then((w) => live && setWorkflows(w.filter((x) => x.runnable)))
      .catch(() => live && setWorkflows([]));
    return () => {
      live = false;
    };
  }, [mode]);
  const keyOf = (i: Item) => `${i.from ?? i.group}:${i.id}`;

  useEffect(() => {
    setQ(useUi.getState().paletteQuery ?? '');
    setSel(0);
  }, [mode]);

  const prefix = mode === 'root' ? (q.startsWith('>') ? '>' : q.startsWith('@') ? '@' : q.startsWith('#') ? '#' : '') : '';
  const query = (prefix ? q.slice(1) : q).trim();

  // full text search over messages
  useEffect(() => {
    if (mode !== 'root' || prefix || query.length < 3) {
      setHits([]);
      return;
    }
    // an answer for a query you have typed past never replaces the newer one
    let live = true;
    const t = setTimeout(() => {
      api()
        .search(query)
        .then((h) => live && setHits(h))
        .catch(() => live && setHits([]));
    }, 220);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, mode, prefix]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => navigate(to);
    const sub = (m: 'model' | 'agent' | 'mode' | 'routine' | 'workflow') => () => set({ paletteMode: m, paletteQuery: undefined });

    if (mode === 'model') {
      const list: Item[] = [];
      for (const g of models) {
        if (!g.enabled) continue;
        for (const m of g.models) {
          // a chat runs on the hub: coding agents (Claude Code, Codex) are for sessions, as in the composer's picker
          if (onChat && isHarness(m.ref)) continue;
          list.push({
            id: m.ref,
            group: 'Models',
            text: `${modelName(m.ref)} ${m.name} ${m.ref} ${g.name}`,
            lead: <ModelMark model={m.ref} size={16} tone="brand" />,
            label: modelName(m.ref),
            detail: g.name,
            hint: <span className="num text-[12px] text-fg-3">{contextLabel(m.contextWindow)}</span>,
            run: () => {
              if (onChat) return chooseChatModel(chatId, m.ref);
              if (!current) return openNewChat({ model: m.ref });
              const hasHistory = (useHub.getState().messages[current.id]?.length ?? 0) > 0;
              void attempt(() => (hasHistory ? api().handoff(current.id, m.ref) : api().updateSession(current.id, { model: m.ref }))).then((s) => s && upsertSession(s));
            },
          });
        }
      }
      return list;
    }
    if (mode === 'agent') {
      return agents
        .filter((a) => a.primary !== false)
        .map((a) => ({
          id: a.name,
          group: 'Agents' as const,
          text: `${a.name} ${a.description}`,
          label: a.name,
          detail: a.description,
          run: () => {
            if (current) void attempt(() => api().updateSession(current.id, { agent: a.name })).then((s) => s && upsertSession(s));
            else openNewChat({ agent: a.name });
          },
        }));
    }
    if (mode === 'mode') {
      return MODES.map((m) => ({
        id: m.value,
        group: 'Mode' as const,
        text: `${m.label} ${m.description}`,
        label: m.label,
        detail: m.description,
        run: () => {
          if (current) void attempt(() => api().updateSession(current.id, { mode: m.value as SessionMode })).then((s) => s && upsertSession(s));
          else openNewChat();
        },
      }));
    }
    if (mode === 'routine') {
      return Object.values(routines).map((r) => ({
        id: r.id,
        group: 'Run routine' as const,
        text: r.name,
        label: r.name,
        detail: r.agent,
        run: () => void attempt(() => api().runRoutine(r.id), `Started ${r.name}.`),
      }));
    }
    if (mode === 'workflow') {
      // the library's run sheet opens on it, for its arguments (features/workflows/WorkflowsPage.tsx)
      return workflows.map((w) => ({ id: w.name, group: 'Run workflow' as const, text: `${w.name} ${w.description}`, label: w.name, detail: w.description, run: go(`/workflows?run=${encodeURIComponent(w.name)}`) }));
    }

    const list: Item[] = [];
    // actions
    const action = (id: string, label: string, run: () => void, hint?: ReactNode, top = false, keep = false) => list.push({ id, group: 'Actions', label, text: label, run, hint, top, keep });
    action('chat:new', 'New chat', go('/chat'), <Kbd>{MOD === '⌘' ? '⇧⌘O' : 'Ctrl ⇧ O'}</Kbd>, true);
    action('new', 'New session', () => openNewChat(), <Kbd>{MOD === '⌘' ? '⌘N' : 'Ctrl N'}</Kbd>, true);
    action('routine:new', 'New routine', go('/routines/new'), undefined, true);
    action('goal:new', 'New goal', go('/goals?new=1'));
    action('theme', resolvedTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', toggleTheme, <Kbd>{MOD === '⌘' ? '⌘.' : 'Ctrl .'}</Kbd>, true);
    action('pair', 'Pair a device', go('/devices?pair=1'), undefined, true);
    if (owner) action('setup', 'Run setup again', go(RUN_SETUP_AGAIN), undefined, true);
    action('inbox', 'Open inbox', go('/approvals'), <Kbd>G I</Kbd>, true);
    action('import', 'Import past chats', go('/sessions?import=1'));
    // a new session that starts in a mode (the New session dialog opens on it)
    for (const m of MODES.filter((x) => x.value !== 'agent' && x.value !== 'chat')) list.push({ id: `new:${m.value}`, group: 'Actions', label: `New ${m.label.toLowerCase()} session`, text: `New ${m.label} session mode ${m.description}`, run: () => openNewChat({ mode: m.value }) });
    action('split', 'Sessions side by side', go('/sessions/split'));
    action('shortcuts', 'Keyboard shortcuts', () => openShortcuts(), <Kbd>?</Kbd>);
    // extensions
    if (owner) {
      action('ext:discover', 'Find extensions on GitHub', go('/extensions/discover'));
      action('ext:plugin', 'Install a plugin', go('/extensions/plugins?view=marketplace'));
      action('ext:mcp', 'Add an MCP server', go('/extensions/mcp?add=1'));
      action('ext:test', 'Test a tool call against the permission rules', go('/extensions/tools#test'));
      action('ext:sync', 'Sync skills and agents to other CLIs', go('/extensions/sources#sync'));
    }
    action('run', 'Run a routine now', sub('routine'), undefined, false, true);
    action('workflow', 'Run a workflow', sub('workflow'), undefined, false, true);
    if (chatId) action('model', 'Switch model for this chat', sub('model'), <Kbd>{MOD === '⌘' ? '⇧⌘M' : 'Ctrl ⇧ M'}</Kbd>, true, true);
    else if (onChat) action('model', 'Switch model for the next chat', sub('model'), <Kbd>{MOD === '⌘' ? '⇧⌘M' : 'Ctrl ⇧ M'}</Kbd>, true, true);
    if (current) {
      action('model', 'Switch model for this session', sub('model'), <Kbd>{MOD === '⌘' ? '⇧⌘M' : 'Ctrl ⇧ M'}</Kbd>, true, true);
      action('agent', 'Switch agent for this session', sub('agent'), undefined, false, true);
      action('mode', 'Switch mode for this session', sub('mode'), undefined, false, true);
      action('panel', 'Toggle the context panel', toggleContext, <Kbd>{MOD === '⌘' ? '⌘\\' : 'Ctrl \\'}</Kbd>);
    }

    // chats (the Chat page) in their own group, then sessions
    const recent = Object.values(sessions)
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const [i, s] of recent.filter((x) => x.kind === 'chat').entries()) {
      list.push({
        id: `c:${s.id}`,
        group: 'Chats',
        text: `${s.title} chat ${modelName(s.model)}`,
        label: s.title,
        detail: <ModelName model={s.model} size={13} />,
        hint: <span className="num text-[12px] text-fg-3">{relTime(s.updatedAt)}</span>,
        run: go(`/chat/${s.id}`),
        top: i < 3,
      });
    }
    for (const [i, s] of recent.filter((x) => x.kind !== 'chat').entries()) {
      // delegated work is found too, by its words and by who did it and where ("Code on MadX Arch")
      const handed = isDelegated(s) ? delegateWho(s, { devices: useHub.getState().devices }) : undefined;
      list.push({
        id: `s:${s.id}`,
        group: 'Sessions',
        text: `${s.title} ${s.agent} ${modelName(s.model)}${handed ? ` delegated work ${handed}` : ''}`,
        label: s.title,
        detail: handed ? (
          `Delegated work, ${handed}`
        ) : (
          <span className="inline-flex items-center">
            {s.agent},&nbsp;
            <ModelName model={s.model} size={13} />
          </span>
        ),
        hint: <span className="num text-[12px] text-fg-3">{relTime(s.updatedAt)}</span>,
        run: go(`/s/${s.id}`),
        top: i < 6,
      });
    }

    // pages
    for (const n of [...NAV.filter((x) => owner || !OWNER_PAGES.has(x.to)), SETTINGS_NAV]) list.push({ id: `go:${n.to}`, group: 'Pages', text: `${n.label} page go to`, label: n.label, hint: <Kbd>G {n.key.toUpperCase()}</Kbd>, run: go(n.to) });
    if (owner) for (const [tab, label, words] of EXTENSION_TABS) list.push({ id: `go:/extensions/${tab}`, group: 'Pages', text: `${label} extensions ${words}`, label, detail: 'Extensions', run: go(`/extensions/${tab}`) });
    for (const [id, label, words] of SETTINGS_SECTIONS.filter(([x]) => owner || MEMBER_SETTINGS.has(x))) list.push({ id: `go:/settings/${id}`, group: 'Pages', text: `${label} settings ${words}`, label, detail: 'Settings', run: go(`/settings/${id}`) });

    // agents
    for (const a of agents.filter((x) => x.primary !== false)) {
      list.push({ id: `agent:${a.name}`, group: 'Agents', text: `${a.name} ${a.description}`, label: a.name, detail: a.description, run: () => openNewChat({ agent: a.name }) });
    }

    // models
    for (const g of models) {
      if (!g.enabled) continue;
      for (const m of g.models) {
        // a chat runs on the hub: coding agents (Claude Code, Codex) are for sessions, as in the composer's picker
        if (onChat && isHarness(m.ref)) continue;
        list.push({
          id: `model:${m.ref}`,
          group: 'Models',
          text: `${modelName(m.ref)} ${m.name} ${m.ref} ${g.name}`,
          lead: <ModelMark model={m.ref} size={16} tone="brand" />,
          label: modelName(m.ref),
          detail: chatId ? 'Use for this chat' : onChat ? 'Use for the next chat' : current ? 'Use for this session' : g.name,
          run: () => {
            if (onChat) return chooseChatModel(chatId, m.ref);
            if (!current) return openNewChat({ model: m.ref });
            const hasHistory = (useHub.getState().messages[current.id]?.length ?? 0) > 0;
            void attempt(() => (hasHistory ? api().handoff(current.id, m.ref) : api().updateSession(current.id, { model: m.ref }))).then((s) => s && upsertSession(s));
          },
        });
      }
    }

    // memory
    for (const m of Object.values(memories)) {
      list.push({ id: `mem:${m.id}`, group: 'Memory', text: m.content, label: m.content, detail: m.kind, run: go(`/memory?focus=${m.id}`) });
    }
    return list;
  }, [mode, models, agents, routines, workflows, sessions, memories, current, chatId, onChat, navigate, set, owner]);

  const filtered = useMemo(() => {
    if (mode !== 'root') {
      return rankItems(items, query, (i) => i.text, keyOf, recent).slice(0, 80);
    }
    let pool = items;
    if (prefix === '>') pool = items.filter((i) => i.group === 'Actions');
    else if (prefix === '@') pool = items.filter((i) => i.group === 'Sessions' || i.group === 'Chats');
    else if (prefix === '#') pool = items.filter((i) => i.group === 'Memory');
    let out: Item[];
    if (!query) {
      if (prefix) out = pool.slice(0, 40);
      else {
        // commands used lately first, then the newest conversations, then the usual actions
        const used = recent.flatMap((k) => pool.filter((i) => keyOf(i) === k && i.group !== 'Chats' && i.group !== 'Sessions')).slice(0, 5);
        const shown = new Set(used.map((i) => i.id));
        out = [
          ...used.map((i) => ({ ...i, group: 'Recent' as const, from: i.group })),
          ...pool.filter((i) => (i.group === 'Chats' || i.group === 'Sessions') && i.top).map((i) => ({ ...i, group: 'Recent' as const, from: i.group })),
          ...pool.filter((i) => i.group === 'Actions' && i.top && !shown.has(i.id)).slice(0, 6),
        ];
      }
    } else {
      const base = rankItems(prefix ? pool : pool.filter((i) => i.group !== 'Memory' || query.length >= 2), query, (i) => i.text, keyOf, recent);
      const cap: Partial<Record<Group, number>> = { Chats: 6, Sessions: 8, Models: 6, Memory: 5, Agents: 5 };
      const count: Partial<Record<Group, number>> = {};
      out = base.filter((i) => {
        count[i.group] = (count[i.group] ?? 0) + 1;
        return count[i.group]! <= (cap[i.group] ?? 12);
      });
    }
    const msg: Item[] = hits.map((h) => ({
      id: `hit:${h.messageId}`,
      group: 'Messages',
      text: h.snippet,
      label: h.snippet.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim(),
      detail: h.title,
      run: () => navigate(`${sessions[h.sessionId]?.kind === 'chat' ? '/chat/' : '/s/'}${h.sessionId}#${h.messageId}`),
    }));
    const all = [...out, ...msg];
    // with a query, the group holding the best match comes first ("ext" puts Pages above a loose session match)
    const order = query ? [...new Set([...out.map((i) => i.group), ...ORDER])] : ORDER;
    return order.flatMap((g) => all.filter((i) => i.group === g));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query, prefix, hits, navigate, mode, sessions, recent]);

  useEffect(() => setSel(0), [q, mode]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (i: Item | undefined) => {
    if (!i) return;
    // conversations and message hits are recent by their own time; commands, pages, agents and models are remembered
    if (!['Chats', 'Sessions', 'Messages', 'Memory'].includes(i.from ?? i.group)) rememberCommand(keyOf(i));
    i.run();
    if (!i.keep) close();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      setSel((s) => Math.min(filtered.length - 1, s + 1));
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(filtered[sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (mode !== 'root') set({ paletteMode: 'root' });
      else close();
    } else if (e.key === 'Backspace' && !q && mode !== 'root') {
      set({ paletteMode: 'root' });
    }
  };

  const placeholder = { root: 'Search or run a command', model: 'Pick a model', agent: 'Pick an agent', mode: 'Pick a mode', search: 'Search messages', routine: 'Run a routine', workflow: 'Run a workflow' }[mode];
  let last: Group | '' = '';
  const listId = 'palette-list';

  return createPortal(
    <div className={cn('fixed inset-0 z-[75] flex justify-center', mobile ? 'items-stretch' : 'items-start px-4 pt-[15vh]')} onKeyDown={onKey}>
      <div className="absolute inset-0 anim-fade" style={{ background: 'var(--scrim)' }} onClick={close} aria-hidden />
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn(
          'relative flex w-full flex-col overflow-hidden border-rule-2 bg-raise',
          mobile ? 'h-full pt-safe pb-safe' : 'max-h-[min(560px,72vh)] max-w-[640px] rounded-[var(--r-2)] border anim-rise',
        )}
        style={{ boxShadow: mobile ? undefined : 'var(--shadow-pop)' }}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-4 phone:h-14">
          {mode !== 'root' && (
            <button type="button" onClick={() => set({ paletteMode: 'root' })} className="-ml-1.5 grid size-7 place-items-center rounded-[var(--r-1)] text-fg-3 hover:bg-hover hover:text-fg" aria-label="Back to all commands">
              <ChevronLeft className="size-4" strokeWidth={1.75} />
            </button>
          )}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={filtered[sel] ? `pal-${sel}` : undefined}
            aria-autocomplete="list"
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3 phone:text-[16px]"
          />
          {mobile ? (
            <button type="button" onClick={close} className="text-[15px] text-fg-2">
              Cancel
            </button>
          ) : (
            current && mode === 'root' && <span className="max-w-[200px] truncate text-[12px] text-fg-3">{current.title}</span>
          )}
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-[13px] text-fg-3">
              {query.length >= 3 ? `Nothing matches "${query}".` : prefix === '#' ? 'Type to search memory.' : 'No matches.'}
            </p>
          )}
          {filtered.map((it, idx) => {
            const head = it.group !== last ? it.group : null;
            last = it.group;
            const on = idx === sel;
            return (
              <div key={`${it.group}:${it.id}`}>
                {head && <div className="px-2 pt-3 pb-1 text-[12px] font-semibold text-fg-3 first:pt-1.5">{head}</div>}
                <div
                  id={`pal-${idx}`}
                  role="option"
                  aria-selected={on}
                  data-idx={idx}
                  onMouseMove={() => !on && setSel(idx)}
                  onClick={() => choose(it)}
                  className={cn('flex min-h-[34px] items-center gap-2 rounded-[var(--r-1)] px-2 py-1 text-[13px] phone:min-h-11 phone:text-[15px]', on ? 'bg-hover text-fg' : 'text-fg')}
                >
                  {it.lead && <span className="flex shrink-0 items-center">{it.lead}</span>}
                  <span className="min-w-0 flex-1 truncate">
                    {it.label}
                    {it.detail && <span className="ml-2 text-[12px] text-fg-3 phone:text-[13px]">{it.detail}</span>}
                  </span>
                  {it.hint && <span className="shrink-0">{it.hint}</span>}
                  {on && !mobile && <Kbd>↵</Kbd>}
                </div>
              </div>
            );
          })}
        </div>
        {!mobile && (
          <div className="flex h-8 shrink-0 items-center gap-4 border-t border-rule px-3 text-[12px] text-fg-3">
            <span>
              <Kbd>&gt;</Kbd> actions
            </span>
            <span>
              <Kbd>@</Kbd> sessions
            </span>
            <span>
              <Kbd>#</Kbd> memory
            </span>
            <span className="ml-auto">
              <Kbd>esc</Kbd> close
            </span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
