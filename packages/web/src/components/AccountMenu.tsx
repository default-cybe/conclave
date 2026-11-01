/**
 * The account row at the foot of the sidebar and the phone's drawer, like
 * the Claude app's (docs/design/SPEC.md 5.3): an initial in a circle, the
 * person's name, their role and hub, and the hub's state as a dot (ok,
 * fault, or the knot while it reconnects; the knot plays success when the
 * hub is back, docs/design/KNOT-MOTION.md). A dot by the name says a newer
 * release waits (the owner's, when the popup at start is off or was put
 * away).
 *
 * The row opens the account menu: the email (or the hub's address) at the
 * top, Settings, Usage, Devices, Keyboard shortcuts, Get help and What's
 * new, the other accounts on this browser to switch to and Add account,
 * then Log out (docs/design/ACCOUNTS.md 10).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { openShortcuts } from '@/store/ui';
import { loadConnection, MOCK } from '@/lib/api';
import { accountLabel, addAccount, isCurrent, personName, savedAccounts, signOut, switchAccount, useIsOwner, useMe } from '@/lib/people';
import { hostOf } from '@/lib/remote';
import { useReach } from '@/lib/reach';
import { durationShort } from '@/lib/format';
import { useMedia, useNow } from '@/lib/hooks';
import { KnotRope } from './motion/KnotRope';
import { MenuList, Popover, type MenuItem } from './ui/Overlay';
import { MOD } from './ui/Kbd';
import { useHubUpdate, useUpdateDot } from './UpdateBanners';

/** The docs, and the release notes. */
export const HELP_URL = 'https://conclave.dymnitguys.com/details.html';
export const RELEASES_URL = 'https://github.com/default-cybe/conclave/releases';

function open(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Who is signed in, for the row: a name, a line under it, an initial, an email or address. */
export function useAccount(): { name: string; sub: string; initial: string; email?: string; address?: string } {
  const me = useMe();
  const hub = useHub((s) => s.hub?.name);
  const uiName = useHub((s) => (s.config?.ui as { name?: unknown } | undefined)?.name);
  const offline = useReach((s) => s.offline?.label);
  const conn = loadConnection();
  const hubName = hub || offline || conn?.hubName || hostOf(conn?.baseUrl) || 'Hub';
  const own = personName(me) ?? (me?.role !== 'member' && typeof uiName === 'string' && uiName.trim() ? uiName.trim() : undefined);
  const role = me?.role === 'member' ? 'Member' : 'Owner';
  const name = own ?? role;
  const address = conn?.baseUrl ?? (MOCK ? location.origin : undefined);
  return { name, sub: own ? `${role}, ${hubName}` : hubName, initial: (name.trim()[0] ?? 'C').toUpperCase(), email: me?.email, address: address ? address.replace(/^https?:\/\//, '') : undefined };
}

/** The hub's state: words for the tooltip and screen readers, and its mark. */
export function useHubState(): { words: string; mark: ReactNode; name: string } {
  const conn = useHub((s) => s.conn);
  const name = useHub((s) => s.hub?.name) ?? 'hub';
  const [since, setSince] = useState(Date.now());
  const [back, setBack] = useState(false);
  const wasOffline = useRef(false);
  const now = useNow(conn === 'connecting' ? 1000 : 60_000);
  useEffect(() => {
    setSince(Date.now());
    if (conn === 'closed') wasOffline.current = true;
    if (conn !== 'open') setBack(false);
    else if (wasOffline.current) {
      wasOffline.current = false;
      setBack(true);
    }
  }, [conn]);
  const state = conn === 'open' ? 'online' : conn === 'closed' ? 'offline' : 'reconnecting';
  const words = `Hub ${name} ${state}${conn === 'connecting' && now - since > 3000 ? ` ${durationShort(now - since)}` : ''}`;
  const mark =
    conn === 'connecting' ? (
      <KnotRope moment="run" size={12} />
    ) : back ? (
      <KnotRope moment="success" size={12} onDone={() => setBack(false)} />
    ) : (
      <span aria-hidden className={cn('size-[7px] rounded-full', conn === 'open' ? 'bg-ok' : 'bg-fault')} />
    );
  return { words, mark, name };
}

/** The account menu's rows. */
export function useAccountMenu(): MenuItem[] {
  const [, navigate] = useLocation();
  const me = useMe();
  const account = useAccount();
  const owner = useIsOwner();
  const waiting = useUpdateDot();
  const latest = useHubUpdate((s) => (s.status?.available ? s.status.latest?.version : undefined));
  const saved = savedAccounts();
  const others = saved.filter((c) => !isCurrent(c));
  const several = !!me?.people || saved.length > 1;
  // a phone has no keys to show
  const keyboard = useMedia('(pointer: fine)');
  return [
    { group: true, label: account.email ?? account.address ?? account.name },
    { label: 'Settings', hint: keyboard ? `${MOD} ,` : undefined, onSelect: () => navigate('/settings') },
    { label: 'Usage', onSelect: () => navigate('/usage') },
    { label: 'Devices', onSelect: () => navigate('/devices') },
    ...(owner && waiting && latest ? [{ label: `Update to ${latest}`, hint: <span aria-hidden className="inline-block size-[7px] rounded-full bg-signal" />, onSelect: () => navigate('/settings/about') }] : []),
    ...(keyboard ? [{ label: 'Keyboard shortcuts', hint: '?', onSelect: openShortcuts }] : []),
    { separator: true, label: '' },
    { label: 'Get help', detail: 'How Conclave works', onSelect: () => open(HELP_URL) },
    { label: "What's new", onSelect: () => open(RELEASES_URL) },
    ...(several || others.length
      ? [
          { separator: true, label: '' },
          ...others.map((c) => ({ label: `Switch to ${accountLabel(c)}`, detail: c.hubName && c.account ? c.hubName : undefined, onSelect: () => switchAccount(c) })),
          { label: 'Add account', onSelect: addAccount },
        ]
      : []),
    { separator: true, label: '' },
    { label: 'Log out', onSelect: () => void signOut() },
  ];
}

/** The initial in a circle. */
export function Avatar({ initial, size = 28, className }: { initial: string; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cn('grid shrink-0 place-items-center rounded-full bg-surface-2 font-semibold text-fg-2 shadow-[inset_0_0_0_1px_var(--rule)]', className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}>
      {initial}
    </span>
  );
}

/**
 * The row that opens the account menu. `compact`: the avatar alone (the
 * folded sidebar). `phone`: 52px tall, larger words, the menu as a sheet.
 */
export function AccountRow({ compact, phone, className }: { compact?: boolean; phone?: boolean; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const account = useAccount();
  const hub = useHubState();
  const dot = useUpdateDot();
  const items = useAccountMenu();
  const label = `${account.name}, ${hub.words}${dot ? ', a new version is ready' : ''}`;
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label={`Account: ${label}`}
        title={compact ? label : undefined}
        onClick={() => setMenu((m) => !m)}
        className={cn(
          'group/acct relative flex w-full min-w-0 items-center text-left transition-colors duration-[var(--dur-1)]',
          compact ? 'size-9 justify-center rounded-full' : phone ? 'min-h-[52px] gap-3 rounded-[12px] px-2.5' : 'h-12 gap-2.5 rounded-[10px] px-2',
          menu ? 'bg-side-active' : 'hov:bg-side-hover active:bg-side-hover',
          className,
        )}
      >
        <span className="relative">
          <Avatar initial={account.initial} size={phone ? 34 : compact ? 28 : 30} />
          {dot && <span aria-hidden className="absolute -top-px -right-px size-[9px] rounded-full border-2 border-side bg-signal" />}
        </span>
        {!compact && (
          <>
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate font-medium text-fg', phone ? 'text-[15.5px]' : 'text-[13.5px]')}>{account.name}</span>
              <span className={cn('block truncate text-fg-3', phone ? 'text-[13px]' : 'text-[12px]')}>{account.sub}</span>
            </span>
            <span role="status" className="grid size-5 shrink-0 place-items-center" title={hub.words}>
              {hub.mark}
              <span className="sr-only">{hub.words}</span>
            </span>
          </>
        )}
      </button>
      <Popover anchor={ref} open={menu} onClose={() => setMenu(false)} placement={compact ? 'right-start' : 'top-start'} width={compact ? 260 : Math.max(244, ref.current?.offsetWidth ?? 244)} maxHeight={560} label="Account" sheetTitle={account.name}>
        <MenuList items={items} onDone={() => setMenu(false)} label="Account" />
      </Popover>
    </>
  );
}
