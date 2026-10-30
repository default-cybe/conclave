/**
 * Settings (spec 11.10, docs/design/SPEC.md 5.3). On a computer it opens over
 * the app, like the Claude app's: a large panel with its own index at the
 * left (a search box, then the sections under quiet group names: Settings,
 * Models, Customize, Platform) and the section at the right with a close x.
 * The address stays /settings/<section>, so deep links and the back button
 * work, and the page under it stays as it was (lib/settingsRoute.ts). The
 * index changes the section in place of the address, so Back or Esc closes
 * Settings at once.
 *
 * Phones (docs/design/MOBILE-V2.md 7) get the index as its own page, a
 * grouped list in the way of the iPhone's settings: a group label, then
 * rows with a chevron. Each section opens full screen under the bar's back
 * arrow. A More group at the end holds every page the drawer does not list
 * (the Inbox, All conversations, Workflows, Routines, Memory and the rest).
 *
 * One section has pages of its own: /settings/friends/:id is a friend, in
 * the Friends section on a computer and full screen with its own bar on a
 * phone.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, Route, Switch, useLocation, useParams } from 'wouter';
import { navigate as browserNavigate } from 'wouter/use-browser-location';
import { ChevronRight, Search, X } from 'lucide-react';
import { cn } from '@/lib/text';
import { useIsMobile, useMedia } from '@/lib/hooks';
import { openShortcuts } from '@/store/ui';
import { Page, usePageHeader } from '@/components/ui/Page';
import { IconButton } from '@/components/ui/Button';
import { useFocusTrap } from '@/components/ui/Overlay';
import { closeSettings } from '@/lib/settingsRoute';
import { OWNER_PAGES, PHONE_PAGES, useInboxCount } from '@/components/nav';
import { groupSections, searchSections, settingsRedirect } from './nav';
import { ProvidersSection } from './providers';
import { DefaultsSection } from './defaults';
import { MemberPermissionsSection, PermissionsSection } from './permissions';
import { NotificationsSection } from './notifications';
import { AssistantSection } from './assistant';
import { ReflectSection } from './reflect';
import { MapsSection } from './maps';
import { WebSearchSection } from './websearch';
import { CalMailSection } from './calmail';
import { BrowserSection } from './browser';
import { GatewaySection } from './gateway';
import { AppsSection } from './apps';
import { GithubSection } from './github';
import { AboutSection, AppearanceSection, AuditSection } from './app';
import { RemoteSection } from './remote';
import { ComputerSection, showComputerSection } from './computer';
import { SubscriptionsSection } from './subscriptions';
import { MemberSubscriptionsSection } from './member-plans';
import { AccountsSection } from './accounts';
import { RefusalSection } from './refusal';
import { UsageFallbackSection } from './usage-fallback';
import { MemberProvidersSection, PeopleSection, YourAccountSection } from './people';
import { useIsOwner } from '@/lib/people';
import { LogsSection } from './logs';
import { FriendsSection } from '@/features/friends/FriendsSection';
import { FriendPage } from '@/features/friends/FriendPage';

interface SectionDef {
  id: string;
  label: string;
  /** One line under the title, fg-2. */
  desc: string;
  C: ComponentType;
  /** Column width when 720 is too narrow for its rows. */
  width?: number;
  /** Shown only where this returns true (the desktop app). */
  when?: () => boolean;
  /** The hub's owner only (docs/design/ACCOUNTS.md): a member never sees it. */
  owner?: boolean;
  /** What a member sees in its place. */
  member?: { C: ComponentType; desc: string };
}

const ALL_SECTIONS: SectionDef[] = [
  {
    id: 'account',
    label: 'Your account',
    desc: 'Your name, password and defaults, the apps you are signed in with, and the accounts on this browser.',
    C: YourAccountSection,
  },
  {
    id: 'people',
    label: 'People',
    desc: 'Who else uses this hub, how they sign in, and which of your keys they may use.',
    C: PeopleSection,
    width: 900,
    owner: true,
  },
  {
    id: 'providers',
    label: 'Providers',
    desc: 'Keys and plans the hub signs in with. Keys stay on the hub.',
    C: ProvidersSection,
    width: 900,
    member: { C: MemberProvidersSection, desc: "Which key your calls use: your own, or the hub's where the owner allows it." },
  },
  {
    id: 'subscriptions',
    label: 'Subscriptions',
    desc: 'Sign in to Claude, ChatGPT, Google and other plans you pay for. Every model from those accounts shows up here.',
    C: SubscriptionsSection,
    width: 900,
    member: { C: MemberSubscriptionsSection, desc: 'Sign in to Claude, ChatGPT and other plans you pay for. Only your chats use them.' },
  },
  {
    id: 'accounts',
    label: 'Accounts',
    desc: 'Which plan or key takes each call, in your order, with each one\'s limits, reset times and budget.',
    C: AccountsSection,
    width: 900,
    // a member's own plans, their order and limits: the same page
    member: { C: AccountsSection, desc: 'Which of your plans takes each call, in your order, with their limits and reset times.' },
  },
  {
    id: 'refusal',
    label: 'Refusal fallback',
    desc: 'When a model refuses, the same messages go to the next model on your list. Your words are never changed.',
    C: RefusalSection,
    width: 900,
    // a member's own list, on the same page (saveFallback writes it to their account)
    member: { C: RefusalSection, desc: 'When a model refuses, the same messages go to the next model on your own list. Only models you can use.' },
  },
  {
    id: 'usage',
    label: 'Usage fallback',
    desc: 'When a model is at its limit on every account, the next model here takes over, on its own account order.',
    C: UsageFallbackSection,
    width: 900,
    member: { C: UsageFallbackSection, desc: 'When a model is at its limit on your plans, the next model on your own list takes over. Only models you can use.' },
  },
  {
    id: 'defaults',
    label: 'Defaults',
    desc: 'What a new session uses when you do not choose, and how memory works.',
    C: DefaultsSection,
    owner: true,
  },
  {
    id: 'permissions',
    label: 'Permissions',
    desc: 'What sessions may do without asking you first.',
    C: PermissionsSection,
    // a member's own always-allow rules; the hub's mode and deny rules stay the owner's
    member: { C: MemberPermissionsSection, desc: 'What your sessions may do without asking you first.' },
  },
  {
    id: 'notifications',
    label: 'Notifications',
    desc: 'How Conclave reaches you while you are away from it.',
    C: NotificationsSection,
  },
  {
    id: 'assistant',
    label: 'Assistant',
    desc: 'What the assistant brings up on its own, when, and the heartbeat and nightly reflection.',
    C: AssistantSection,
  },
  {
    id: 'reflect',
    label: 'Reflect',
    desc: 'What the assistant learns each night about how you like to work: the notes it keeps, when it runs, and Reflect now.',
    C: ReflectSection,
  },
  {
    id: 'maps',
    label: 'Maps',
    desc: 'Places, directions and maps for the assistant, from Google Maps or OpenStreetMap. The key stays on the hub.',
    C: MapsSection,
    // a member's own key, home and cap, on the same page (the routes run as the caller)
    member: { C: MapsSection, desc: 'Places, directions and maps for your assistant, from Google Maps on your own key. Your key and home stay in your account.' },
  },
  {
    id: 'websearch',
    label: 'Web search',
    desc: 'The search engine WebSearch uses, how to get a free key for it, and the key. Keys stay on the hub.',
    C: WebSearchSection,
    // a member's own keys and proxy, on the same page; the hub's search only if the owner allows it
    member: { C: WebSearchSection, desc: 'Your own search engine keys and proxy. Your keys stay in your account.' },
  },
  {
    id: 'calmail',
    label: 'Calendar and mail',
    desc: 'Calendars and mail the assistant may read, and where it may propose events. Every change waits for your approval.',
    C: CalMailSection,
  },
  {
    id: 'browser',
    label: 'Browser',
    desc: 'The browser the assistant and watches use: its engines, the profiles and the sites you signed in to, and a proxy for when you ask for one.',
    C: BrowserSection,
    member: { C: BrowserSection, desc: 'Your own browser on the hub: the sites you signed in to and your saved logins. Nobody else browses with them.' },
    // a member sees their own browser only: its sites, saved logins and Sign in (routes-browser.ts memberStatus);
    // engines, the install and the proxy come only in the owner's answer, so the section hides them
  },
  {
    id: 'gateway',
    label: 'Gateway keys',
    desc: 'Point Claude Code, Codex or OpenCode at the hub so their usage is tracked and routed.',
    C: GatewaySection,
    owner: true,
  },
  {
    id: 'apps',
    label: 'Connected apps',
    desc: 'Chatbots such as claude.ai and ChatGPT that use your memory through /mcp, and what each may do.',
    C: AppsSection,
    width: 900,
  },
  {
    id: 'github',
    label: 'GitHub',
    desc: 'The token repo sessions use to clone, push and open pull requests. Only the hub uses it; sessions never see it.',
    C: GithubSection,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    desc: 'How Conclave looks on this device, and the name it greets you by.',
    C: AppearanceSection,
  },
  {
    id: 'audit',
    label: 'Audit log',
    desc: 'What sessions and people did on the hub, newest first.',
    C: AuditSection,
    width: 1040,
  },
  {
    id: 'remote',
    label: 'Remote access',
    desc: 'How your phone and other computers reach this hub, at home and away.',
    C: RemoteSection,
    owner: true,
  },
  {
    id: 'friends',
    label: 'Friends',
    desc: "Other people's Conclave hubs that trade notes, chats and sessions with yours, hub to hub. Nothing goes through a service in the middle.",
    C: FriendsSection,
    owner: true,
  },
  {
    id: 'computer',
    label: 'This computer',
    desc: 'Whether the hub may use the files, shells and coding tools of the computer this app runs on.',
    C: ComputerSection,
    when: showComputerSection,
    owner: true,
  },
  {
    id: 'about',
    label: 'About',
    desc: 'This hub, this client and the connection between them.',
    C: AboutSection,
  },
  {
    id: 'logs',
    label: 'Logs',
    desc: "What the hub and your apps did, kept for a few weeks. Download them for a developer to see what went wrong.",
    C: LogsSection,
    // the hub's logs: the owner reads them
    owner: true,
  },
];

export const SECTIONS: SectionDef[] = ALL_SECTIONS.filter((s) => !s.when || s.when());

/** The sections this person sees: a member gets their own variant of some, and none of the owner's. */
function useSections(): SectionDef[] {
  const owner = useIsOwner();
  if (owner) return SECTIONS;
  return SECTIONS.filter((s) => !s.owner).map((s) => (s.member ? { ...s, C: s.member.C, desc: s.member.desc, width: undefined } : s));
}

/** Sections with pages under them (/settings/<section>/<item>). */
const ITEM_PAGES: Record<string, ComponentType<{ id: string }>> = {
  friends: FriendPage,
};

/** /settings/defaults#memory scrolls to that group once it renders. Only the section's own box scrolls. */
function useHashScroll(section: string | undefined) {
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id) return;
    const t = setTimeout(() => {
      const el = document.getElementById(id);
      const box = el?.closest<HTMLElement>('.overflow-y-auto');
      if (!el || !box) return;
      const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      box.scrollTo({ top: box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - margin });
    }, 120);
    return () => clearTimeout(t);
  }, [section]);
}

/** The route on a phone: the index, a section, or a page under one. A computer opens SettingsOverlay instead. */
export default function SettingsPage() {
  const { section, item } = useParams<{ section?: string; item?: string }>();
  const mobile = useIsMobile();
  const [, navigate] = useLocation();
  const sections = useSections();
  const current = sections.find((s) => s.id === section);
  const Item = section && item ? ITEM_PAGES[section] : undefined;

  useEffect(() => {
    if (!mobile) return;
    // a phone's /settings/more lists the pages the drawer leaves out
    const to = settingsRedirect(section, item, [...sections.map((s) => s.id), 'more'], true, location.search);
    if (to) navigate(to, { replace: true });
  }, [section, item, mobile, navigate, sections]);
  useHashScroll(section);

  if (!mobile) return null;
  if (section === 'more') return <PhoneMore />;
  if (!current) return <PhoneIndex sections={sections} />;
  // a friend's page draws its own bar
  if (Item && item) return <Item key={item} id={item} />;
  return <PhoneSection s={current} />;
}

// ---------------------------------------------------------------------------
// A computer: Settings over the app
// ---------------------------------------------------------------------------

/** Settings over the app, at /settings/... on a computer (App.tsx renders it beside the routes). */
export function SettingsOverlay() {
  return (
    <Switch>
      <Route path="/settings/:section/:item">{(p) => <SettingsModal section={p.section} item={p.item} />}</Route>
      <Route path="/settings/:section?">{(p) => <SettingsModal section={p.section} />}</Route>
    </Switch>
  );
}

function SettingsModal({ section, item }: { section?: string; item?: string }) {
  const sections = useSections();
  const current = sections.find((s) => s.id === section);
  const Item = section && item ? ITEM_PAGES[section] : undefined;
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const found = useMemo(() => searchSections(sections, q), [sections, q]);
  const groups = useMemo(() => groupSections(found), [found]);
  useFocusTrap(ref, true, { initial: search });
  useHashScroll(section);

  useEffect(() => {
    const to = settingsRedirect(section, item, sections.map((s) => s.id), false, location.search);
    if (to) browserNavigate(to, { replace: true });
  }, [section, item, sections]);

  // the window's title while it is open; the page under it sets its own again after
  useEffect(() => {
    const before = document.title;
    document.title = `${current?.label ?? 'Settings'}, Conclave`;
    return () => void (document.title = before);
  }, [current?.label]);

  // a new section starts at its top
  useEffect(() => {
    if (!location.hash) body.current?.scrollTo({ top: 0 });
  }, [section, item]);

  // Esc closes, unless a dialog, menu or sheet over it takes it first (they stop the key)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (e.target === search.current && q) return;
      e.preventDefault();
      closeSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [q]);

  const go = (id: string) => browserNavigate(`/settings/${id}`, { replace: true });

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 lg:p-10">
      <div aria-hidden className="absolute inset-0 anim-fade" style={{ background: 'var(--scrim)' }} onClick={closeSettings} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="relative flex h-[min(860px,100%)] w-[min(1180px,100%)] overflow-hidden rounded-[16px] border border-rule-2 bg-bg outline-none anim-rise"
        style={{ boxShadow: 'var(--shadow-pop)' }}
      >
        <nav aria-label="Settings sections" className="flex w-[248px] shrink-0 flex-col bg-side">
          <div className="shrink-0 px-3 pt-4 pb-2">
            <label className="flex h-8 items-center gap-2 rounded-[8px] bg-bg px-2.5 shadow-[inset_0_0_0_1px_var(--rule)] focus-within:shadow-[inset_0_0_0_1px_var(--edge)]">
              <Search className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.75} aria-hidden />
              <input
                ref={search}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && found[0]) {
                    e.preventDefault();
                    go(found[0].id);
                  } else if (e.key === 'Escape' && q) {
                    e.preventDefault();
                    setQ('');
                  }
                }}
                placeholder="Search settings"
                aria-label="Search settings"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3"
              />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {groups.length === 0 && <p className="m-0 px-2.5 py-2 text-[12.5px] text-fg-3">No setting matches "{q}".</p>}
            {groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label} className="mt-3 first:mt-1">
                <div className="flex h-7 items-center px-2.5 text-[12px] font-medium text-fg-3">{g.label}</div>
                {g.items.map((x) => {
                  const on = x.id === current?.id;
                  return (
                    <a
                      key={x.id}
                      href={`/settings/${x.id}`}
                      aria-current={on ? 'page' : undefined}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                        e.preventDefault();
                        go(x.id);
                      }}
                      className={cn('flex h-8 items-center rounded-[8px] px-2.5 text-[13.5px] transition-colors duration-[var(--dur-1)]', on ? 'bg-side-active font-medium text-fg' : 'text-fg-2 hov:bg-side-hover hov:text-fg')}
                    >
                      <span className="truncate">{x.label}</span>
                    </a>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="absolute top-3 right-3 z-10">
            <IconButton label="Close settings" onClick={closeSettings} tooltip={false}>
              <X />
            </IconButton>
          </div>
          <div ref={body} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {current && (
              <div className="mx-auto w-full px-10 pt-9 pb-14" style={{ maxWidth: (Item ? 1000 : (current.width ?? 760)) + 80 }}>
                {Item && item ? (
                  <Item key={item} id={item} />
                ) : (
                  <>
                    <header className="pr-8 pb-7">
                      <h1 className="t-page m-0 text-fg">{current.label}</h1>
                      <p className="m-0 mt-1.5 max-w-[64ch] text-[14px] leading-[1.45] text-fg-2">{current.desc}</p>
                    </header>
                    <current.C key={current.id} />
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// A phone: Settings as pages
// ---------------------------------------------------------------------------

interface PhoneRow {
  label: string;
  to?: string;
  run?: () => void;
  /** At the right, before the chevron: the Inbox's count. */
  value?: ReactNode;
}

/** A phone's More page: every page the drawer does not list, and the keys on a phone with a keyboard. */
export function phoneMoreRows(owner: boolean, keyboard: boolean): PhoneRow[] {
  return [...PHONE_PAGES.filter((p) => p.to !== '/approvals' && (owner || !OWNER_PAGES.has(p.to))).map((p) => ({ label: p.label, to: p.to })), ...(keyboard ? [{ label: 'Keyboard shortcuts', run: openShortcuts }] : [])];
}

function PhoneGroups({ groups }: { groups: Array<{ label: string; rows: PhoneRow[] }> }) {
  return (
    <div className="flex flex-col gap-6 px-5 pt-2 pb-10">
      {groups.map((g, i) => (
        <section key={g.label || i} aria-label={g.label || undefined}>
          {g.label && <h2 className="m-0 px-4 pb-1.5 text-[13px] font-medium text-fg-3">{g.label}</h2>}
          <ul className="m-0 list-none overflow-hidden rounded-[14px] bg-raise p-0 light:border light:border-rule">
            {g.rows.map((r) => (
              <li key={r.label}>
                <PhoneRowLink row={r} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The index: the Inbox and More (the pages) first, then the sections in their groups. */
function PhoneIndex({ sections }: { sections: SectionDef[] }) {
  const inbox = useInboxCount();
  const groups: Array<{ label: string; rows: PhoneRow[] }> = [
    {
      label: '',
      rows: [
        { label: 'Inbox', to: '/approvals', value: inbox ? <span className="num font-medium text-warn">{inbox}</span> : undefined },
        { label: 'More', to: '/settings/more', value: <span className="text-fg-3">Workflows, Memory, Usage</span> },
      ],
    },
    ...groupSections(sections).map((g) => ({ label: g.label, rows: g.items.map((x) => ({ label: x.label, to: `/settings/${x.id}` })) })),
  ];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <h1 className="sr-only">Settings</h1>
      <PhoneGroups groups={groups} />
    </div>
  );
}

/** /settings/more on a phone. */
function PhoneMore() {
  const keyboard = useMedia('(pointer: fine)');
  const owner = useIsOwner();
  usePageHeader('More', '/settings');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <h1 className="sr-only">More</h1>
      <PhoneGroups groups={[{ label: '', rows: phoneMoreRows(owner, keyboard) }]} />
    </div>
  );
}

const PHONE_ROW = 'flex min-h-12 w-full items-center gap-3 px-4 text-left text-[16px] text-fg transition-colors duration-[var(--dur-1)] active:bg-hover';

function PhoneRowLink({ row }: { row: PhoneRow }) {
  const inner = (
    <>
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {row.value && <span className="min-w-0 shrink truncate text-[15px]">{row.value}</span>}
      <ChevronRight className="size-4 shrink-0 text-fg-4" strokeWidth={2} aria-hidden />
    </>
  );
  if (row.to)
    return (
      <Link href={row.to} className={PHONE_ROW}>
        {inner}
      </Link>
    );
  return (
    <button type="button" onClick={row.run} className={PHONE_ROW}>
      {inner}
    </button>
  );
}

function PhoneSection({ s }: { s: SectionDef }) {
  usePageHeader(s.label, '/settings');
  const C = s.C;
  return (
    <Page width="wide">
      {/* the bar shows the section's name with its back arrow */}
      <header className="pt-5 pb-6">
        <h1 className="sr-only">{s.label}</h1>
        <p className="m-0 max-w-[64ch] text-[15px] leading-[1.45] text-fg-2">{s.desc}</p>
      </header>
      <C key={s.id} />
    </Page>
  );
}
