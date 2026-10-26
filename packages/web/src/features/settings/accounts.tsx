/**
 * Settings > Models > Accounts: every signed in plan and API key the hub may
 * use, in the owner's order per vendor. A line says which account takes the
 * next call and why the ones before it were passed over. Each row has its
 * plan, state, small meters (5 hours, week, week Opus, budget) with reset
 * times, the models it reaches, and Move up, Move down, Pause, Try now and
 * Budget. The hub writes the order to CLIProxyAPI as priorities, so Account
 * 1 serves until it is blocked, then Account 2, then the API key. A plan's
 * row also has its short name (./shortname.tsx) and its window starter
 * (./starter.tsx). Every plan and key has "Use when a model refuses": a
 * refused reply goes to it first, same model, before the Refusal fallback
 * list (a plan without a short name gets the suggested one from the hub).
 * A plan's row has Refresh and, when it stopped working, Sign in again (the
 * Subscriptions sign-in); a saved plan whose sign-in is gone has Remove.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, MoreHorizontal } from 'lucide-react';
import type { AccountBudget, AccountDto, AccountRouteDto, AccountsStatus, SubscriptionsStatus } from '@conclave/core/client';
import type { LimitWindow } from '@conclave/core/types';
import { api } from '@/lib/api';
import { useIsMobile, useNow } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { MANAGEMENT_NOTE, REFUSAL_HINT, REFUSAL_SWITCH, STATE_WORD, VENDOR_LOGO, balanceWords, budgetWords, nowLine, planActions, resetWords, rowWindows, sharedModels, shortNameSuggestions, useAccounts, usedOf, windowName } from '@/lib/accounts';
import { TONE_CLASS, useSubscriptions } from '@/lib/subscriptions';
import { ProviderLine, ensureBuiltinOn } from '@/components/subscriptions/Subscriptions';
import { memberNow, toast, useHub } from '@/store/store';
import { Logo, ModelMark } from '@/components/logo';
import { LiveStatus } from '@/components/motion';
import { Button, ButtonLink, IconButton } from '@/components/ui/Button';
import { Checkbox, Field, Input, OnOff, Segmented, Select } from '@/components/ui/Field';
import { LimitGauge } from '@/components/ui/Meter';
import { ConfirmDialog, Dialog, Menu } from '@/components/ui/Overlay';
import { TextAction } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { agoWords, errText, Group } from './parts';
import { ShortNameRow, UnnamedPlans } from './shortname';
import { StarterRow } from './starter';

type Busy = { id: string; what: 'up' | 'down' | 'pause' | 'try' | 'refresh' } | null;

export function AccountsSection() {
  const { status, set, error } = useAccounts(true);
  const subs = useSubscriptions().status;
  const [removeFor, setRemoveFor] = useState<AccountDto | null>(null);
  const now = useNow(30_000);
  const [busy, setBusy] = useState<Busy>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [budgetFor, setBudgetFor] = useState<AccountDto | null>(null);
  const [renameFor, setRenameFor] = useState<AccountDto | null>(null);

  const vendors = useMemo(() => (status ? status.routes.filter((r) => !r.match) : []), [status]);
  const perModel = useMemo(() => (status ? status.routes.filter((r) => r.match) : []), [status]);
  const [adding, setAdding] = useState(false);
  if (!status) return error ? <p className="m-0 text-[14px] text-fault">{error}</p> : <LoadingRows loading rows={6} />;

  const run = async (b: NonNullable<Busy>, call: () => Promise<AccountsStatus>, done?: string) => {
    setBusy(b);
    try {
      set(await call());
      if (done) toast({ title: done });
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
    }
    setBusy(null);
  };
  const move = (r: AccountRouteDto, id: string, by: -1 | 1) => {
    const order = [...r.order];
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    void run({ id, what: by < 0 ? 'up' : 'down' }, () => api().setAccountOrder({ vendor: r.vendor, ...(r.match ? { match: r.match } : {}), order }));
  };
  // an empty vendor lets the hub file the order under the model's maker; an empty order starts from the default
  const addModel = async (model: string) => {
    setAdding(true);
    try {
      set(await api().setAccountOrder({ vendor: '', match: model, order: [] }));
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
    }
    setAdding(false);
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      set(await api().refreshAccounts());
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
    }
    setRefreshing(false);
  };

  if (!status.accounts.length)
    return (
      <div className="space-y-4">
        <p className="m-0 max-w-[60ch] text-[14px] leading-[1.5] text-fg-2">
          {memberNow() ? 'No plans of yours yet. Sign in to one in Settings > Subscriptions, and it shows up here.' : 'No accounts yet. Sign in to a plan you pay for, or add an API key, and each one shows up here in the order the hub uses them.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/settings/subscriptions" variant="outline">
            {memberNow() ? 'Open Subscriptions' : 'Sign in to a plan'}
          </ButtonLink>
          {/* a member's Accounts lists only their own plans: an API key of theirs never shows here */}
          {!memberNow() && (
            <ButtonLink href="/settings/providers" variant="quiet">
              Add an API key
            </ButtonLink>
          )}
        </div>
      </div>
    );

  const byId = new Map(status.accounts.map((a) => [a.id, a]));
  const suggestions = shortNameSuggestions(status.accounts);
  const shared = sharedModels(status);
  const rowsOf = (r: AccountRouteDto) => {
    const list = r.order.map((id) => byId.get(id)).filter((a): a is AccountDto => !!a);
    return list.map((a, i) => (
      <AccountRow
        key={a.id}
        a={a}
        rank={i + 1}
        first={i === 0}
        last={i === list.length - 1}
        now={now}
        busy={busy?.id === a.id ? busy.what : null}
        management={status.management}
        onMove={(by) => move(r, a.id, by)}
        onPause={() => void run({ id: a.id, what: 'pause' }, () => api().updateAccount(a.id, { enabled: !a.enabled }), a.enabled ? `${a.label} is paused.` : `${a.label} is back in the order.`)}
        onTry={() => void run({ id: a.id, what: 'try' }, () => api().tryAccountNow(a.id), `${a.label}: the next call tries it.`)}
        subs={subs}
        onRefresh={(name) =>
          void run(
            { id: a.id, what: 'refresh' },
            async () => {
              useHub.setState({ subscriptions: { ...(await api().refreshSubscriptionAccount(name)), local: subs?.local } });
              return api().accounts();
            },
            `${a.label}: refreshed.`,
          )
        }
        onRemove={() => setRemoveFor(a)}
        onBudget={() => setBudgetFor(a)}
        onRename={() => setRenameFor(a)}
        noted={!!status.starterNoted}
        all={status.accounts}
        suggestion={suggestions.get(a.id)}
        onSaved={set}
      />
    ));
  };
  return (
    <div className="space-y-9">
      <UnnamedPlans status={status} suggestions={suggestions} onSaved={set} />
      <NowLines status={status} now={now} />

      {vendors.map((r, vi) => {
        return (
          <Group
            key={r.vendor}
            title={r.vendorName}
            count={r.order.filter((id) => byId.has(id)).length}
            right={
              vi > 0 ? undefined : refreshing ? (
                <LiveStatus state="tool" label="Reading" />
              ) : (
                <span className="flex items-center gap-3 text-[12px] text-fg-3">
                  {status.refreshedAt && <span>Read {agoWords(status.refreshedAt, now)}</span>}
                  <TextAction label="Refresh" onClick={() => void refresh()} />
                </span>
              )
            }
            help={vi === 0 ? 'First in the list takes the call. The next one takes over when it is at a limit, resting or paused. Signed in plans go before API keys unless you move them.' : undefined}
          >
            {rowsOf(r)}
          </Group>
        );
      })}

      {(perModel.length > 0 || shared.length > 0) && (
        <div className="space-y-5">
          <h3 className="m-0 text-[15px] font-medium text-fg">Per model</h3>
          <p className="m-0 max-w-[64ch] text-[13px] leading-[1.45] text-fg-3">An order for one model. It can hold any plan that offers the model, from any vendor (Opus on Antigravity). Calls for that model use it instead of the vendor&apos;s order.</p>
          {perModel.map((r) => (
            <Group key={`${r.vendor}:${r.match}`} title={r.match} count={r.order.filter((id) => byId.has(id)).length}>
              {rowsOf(r)}
            </Group>
          ))}
          {shared.length > 0 && (
            <Select aria-label="Add an order for a model" className="max-w-[320px]" value="" disabled={adding} onChange={(e) => e.target.value && void addModel(e.target.value)}>
              <option value="">Add an order for a model…</option>
              {shared.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}

      {!status.management && <p className="m-0 max-w-[64ch] text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Pause, Try now, short names, {REFUSAL_SWITCH} and the order for signed in plans need CLIProxyAPI&apos;s management key. Add it in Subscriptions.</p>}

      {budgetFor && <BudgetDialog a={budgetFor} onClose={() => setBudgetFor(null)} onSaved={set} />}
      {renameFor && <RenameDialog a={renameFor} onClose={() => setRenameFor(null)} onSaved={set} />}
      <ConfirmDialog
        open={!!removeFor}
        onClose={() => setRemoveFor(null)}
        onConfirm={async () => {
          try {
            if (removeFor) set(await api().removeAccount(removeFor.id));
            setRemoveFor(null);
          } catch (e) {
            toast({ title: `Failed. ${errText(e)}`, level: 'error' });
          }
        }}
        busy="Removing"
        title={`Remove ${removeFor?.label ?? 'this plan'}?`}
        body="CLIProxyAPI no longer has its sign-in. It leaves every order here, and refusal fallback entries for it go too. Signing in to it again brings it back."
        confirm="Remove"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Now using
// ---------------------------------------------------------------------------

function NowLines({ status, now }: { status: AccountsStatus; now: number }) {
  return (
    <div className="space-y-3">
      {status.now.map((n) => {
        const line = nowLine(n, status.accounts, now);
        return (
          <div key={n.vendor}>
            <p className="m-0 text-[17px] leading-[1.45] text-fg phone:text-[16px]">
              <span className={cn('font-medium', TONE_CLASS[line.tone === 'ok' ? 'ok' : line.tone])}>{n.vendorName}.</span> {line.lead}
            </p>
            {line.why.length > 0 && <p className="m-0 mt-0.5 text-[13px] leading-[1.45] text-fg-3 phone:text-[14px]">{line.why.join(' ')}</p>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------

export function Meter({ w, now }: { w: LimitWindow; now: number }) {
  const used = usedOf(w);
  const name = windowName(w);
  const money = budgetWords(w);
  const until = w.resetsAt && w.resetsAt > now ? `resets ${resetWords(w.resetsAt, now)}` : undefined;
  const note = [money, until].filter(Boolean).join(', ');
  // one line on desktop: name, gauge, percent, then the reset; phones put the reset under the gauge
  return (
    <div className="grid grid-cols-[72px_minmax(0,180px)_40px_minmax(0,1fr)] items-center gap-x-3 py-[3px] phone:grid-cols-[80px_minmax(0,1fr)_44px] phone:gap-y-0.5">
      <span className="text-[12px] text-fg-3 phone:text-[13px]">{name}</span>
      {used === undefined ? <span className="text-[12px] text-fg-3">{balanceWords(w) ?? 'not read yet'}</span> : <LimitGauge value={used} label={name} segments={20} />}
      <span className={cn('num text-right text-[12.5px] font-[560]', used === undefined ? 'text-fg-4' : used >= 90 ? 'text-fault' : used >= 70 ? 'text-warn' : 'text-fg')}>{used === undefined ? '' : `${used}%`}</span>
      <span className="truncate text-[12px] text-fg-3 phone:col-span-2 phone:col-start-2 phone:text-[12.5px]">{note}</span>
    </div>
  );
}

function AccountRow({
  a,
  rank,
  first,
  last,
  now,
  busy,
  management,
  onMove,
  onPause,
  onTry,
  subs,
  onRefresh,
  onRemove,
  onBudget,
  onRename,
  noted,
  all,
  suggestion,
  onSaved,
}: {
  a: AccountDto;
  rank: number;
  first: boolean;
  last: boolean;
  now: number;
  busy: NonNullable<Busy>['what'] | null;
  management: boolean;
  onMove: (by: -1 | 1) => void;
  onPause: () => void;
  onTry: () => void;
  subs?: SubscriptionsStatus;
  onRefresh: (credential: string) => void;
  onRemove: () => void;
  onBudget: () => void;
  onRename: () => void;
  /** The window starter's note was shown once already. */
  noted: boolean;
  all: AccountDto[];
  /** A short name to offer a plan that has none. */
  suggestion?: string;
  onSaved: (s: AccountsStatus) => void;
}) {
  const mobile = useIsMobile();
  const [models, setModels] = useState(false);
  const word = a.state === 'unknown' ? { word: 'Ready', tone: 'ok' as const } : STATE_WORD[a.state];
  const windows = rowWindows(a);
  const sub = a.kind === 'subscription';
  const canPause = !sub || (management && !!a.credential);
  const canTry = sub && management && (a.state === 'cooldown' || a.state === 'limited');
  const acts = planActions(a, subs);
  const detail = sub
    ? [a.plan && `${a.vendorName} ${a.plan}`, a.email && a.email !== a.label && a.email, a.prefix && `ids also as ${a.prefix}/`].filter(Boolean).join(' · ')
    : [a.subscription ? `${a.plan} · API key` : `${a.vendorName} API key`, a.budget ? `Budget $${a.budget.usd} a ${a.budget.period ?? 'month'}` : 'No budget'].filter((x, i) => i > 0 || x !== a.label).join(' · ');
  const why = a.state === 'paused' ? undefined : a.state !== 'ready' && a.state !== 'unknown' ? `${a.detail ?? word.word}${a.until && a.until > now ? `, until ${resetWords(a.until, now)}` : ''}.` : a.state === 'unknown' ? 'No usage read yet.' : undefined;
  const menu = [
    ...(!first ? [{ label: 'Move up', onSelect: () => onMove(-1) }] : []),
    ...(!last ? [{ label: 'Move down', onSelect: () => onMove(1) }] : []),
    ...(canTry ? [{ label: 'Try now', onSelect: onTry }] : []),
    ...(acts.refresh ? [{ label: 'Refresh', onSelect: () => onRefresh(acts.refresh!) }] : []),
    ...(canPause ? [{ label: a.enabled ? 'Pause' : 'Resume', onSelect: onPause }] : []),
    ...(!sub && !a.subscription ? [{ label: a.budget ? 'Change budget' : 'Set a budget', onSelect: onBudget }] : []),
    { label: 'Rename', onSelect: onRename },
    ...(acts.remove ? [{ label: 'Remove', danger: true, onSelect: onRemove }] : []),
  ];
  return (
    <div className={cn('py-3', !a.enabled && 'opacity-70')}>
      <div className="flex items-start gap-3">
        <span className="num mt-[1px] w-4 shrink-0 text-right text-[12.5px] text-fg-3" aria-label={`Number ${rank} in the order`}>
          {rank}
        </span>
        <Logo id={VENDOR_LOGO[a.vendor]} tone="brand" size={18} fallbackName={a.vendorName} label={a.vendorName} className="mt-[1px]" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{a.label}</span>
            <span className={cn('state-word shrink-0 text-[12.5px] phone:text-[13.5px]', TONE_CLASS[word.tone])}>{word.word}</span>
          </span>
          {detail && <span className="block truncate text-[12px] text-fg-3 phone:text-[13px]">{detail}</span>}
          {why && <span className={cn('block text-[12px] phone:text-[13px]', a.state === 'unknown' ? 'text-fg-3' : TONE_CLASS[word.tone])}>{why}</span>}
        </span>
        {mobile ? (
          <Menu
            label={`${a.label} actions`}
            items={menu}
            trigger={({ ref, props }) => (
              <IconButton ref={ref} label="Account actions" size="touch" className="-mr-3 -mt-2" {...props}>
                <MoreHorizontal />
              </IconButton>
            )}
          />
        ) : (
          <span className="flex shrink-0 items-center gap-1">
            {canTry && (
              <Button variant="outline" size="sm" busy={busy === 'try' ? 'Trying' : false} onClick={onTry}>
                Try now
              </Button>
            )}
            {acts.refresh && (
              <Button variant="quiet" size="sm" busy={busy === 'refresh' ? 'Refreshing' : false} onClick={() => onRefresh(acts.refresh!)}>
                Refresh
              </Button>
            )}
            {acts.remove && (
              <Button variant="danger" size="sm" onClick={onRemove}>
                Remove
              </Button>
            )}
            {canPause && (
              <Button variant="quiet" size="sm" busy={busy === 'pause' ? (a.enabled ? 'Pausing' : 'Resuming') : false} onClick={onPause}>
                {a.enabled ? 'Pause' : 'Resume'}
              </Button>
            )}
            {!sub && !a.subscription && (
              <Button variant="quiet" size="sm" onClick={onBudget}>
                {a.budget ? 'Budget' : 'Set budget'}
              </Button>
            )}
            <IconButton label={`Move ${a.label} up`} size="sm" disabled={first || !!busy} onClick={() => onMove(-1)}>
              <ChevronUp />
            </IconButton>
            <IconButton label={`Move ${a.label} down`} size="sm" disabled={last || !!busy} onClick={() => onMove(1)}>
              <ChevronDown />
            </IconButton>
            <Menu
              label={`${a.label} actions`}
              items={[{ label: 'Rename', onSelect: onRename }]}
              trigger={({ ref, props }) => (
                <IconButton ref={ref} label="More" size="sm" {...props}>
                  <MoreHorizontal />
                </IconButton>
              )}
            />
          </span>
        )}
      </div>
      <div className="mt-2 pl-[52px] phone:pl-[46px]">
        {subs && acts.signIn.length > 0 && (
          <div className="max-w-[560px]">
            {acts.signIn.map((p) => (
              <ProviderLine key={p.id} p={p} status={subs} ensureOn={() => ensureBuiltinOn(subs)} action="Sign in again" />
            ))}
          </div>
        )}
        {windows.length > 0 && (
          <div className="max-w-[560px]">
            {windows.map((w) => (
              <Meter key={w.name} w={w} now={now} />
            ))}
          </div>
        )}
        {a.models.length > 0 && (
          <div className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">
            <button type="button" className="underline decoration-rule-2 underline-offset-[3px] hov:text-fg" onClick={() => setModels((m) => !m)} aria-expanded={models}>
              {a.models.length === 1 ? '1 model' : `${a.models.length} models`}
            </button>
            {models && (
              <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                {a.models.map((m) => (
                  <span key={m.id} className="inline-flex items-center gap-1.5 text-fg-2">
                    <ModelMark model={m.id} tone="brand" size={13} />
                    {m.name}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
        {sub && management && a.credential && <ShortNameRow a={a} all={all} suggestion={suggestion} onSaved={onSaved} />}
        {!memberNow() && <RefusalRow a={a} management={management} onSaved={onSaved} />}
        {(sub || a.subscription) && !memberNow() && <StarterRow a={a} now={now} noted={noted} onSaved={onSaved} />}
      </div>
    </div>
  );
}

/**
 * "Use when a model refuses" (core session/refusal-fallback.ts): a refused
 * reply is tried again on this plan or key first, same model. A plan needs a
 * short name to be reached alone; the hub gives it the suggested one when it
 * has none, so without CLIProxyAPI's management key a plan's switch is off.
 */
export function RefusalRow({ a, management, onSaved }: { a: AccountDto; management: boolean; onSaved: (s: AccountsStatus) => void }) {
  const mobile = useIsMobile();
  const sub = a.kind === 'subscription';
  const off = sub && (!management || !a.credential);
  const [busy, setBusy] = useState(false);
  const set = async (on: boolean) => {
    setBusy(true);
    try {
      const st = await api().updateAccount(a.id, { refusal: on });
      onSaved(st);
      const after = st.accounts.find((x) => x.id === a.id);
      // the hub named the plan so a refusal can reach it alone
      if (on && sub && !a.prefix && after?.prefix) toast({ title: `${after.label} has the short name ${after.prefix}, so Conclave can reach it alone.` });
    } catch (e) {
      toast({ title: `Failed. ${errText(e)}`, level: 'error' });
    }
    setBusy(false);
  };
  return (
    <div className="mt-3 max-w-[560px] border-t border-rule pt-3">
      <div className="flex items-start gap-3 phone:flex-col phone:items-stretch phone:gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-fg phone:text-[15px]">{REFUSAL_SWITCH}</span>
          <span className="block text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{off ? MANAGEMENT_NOTE : REFUSAL_HINT}</span>
        </span>
        <OnOff checked={!!a.refusal} onChange={(v) => void set(v)} label={`${REFUSAL_SWITCH}: ${a.label}`} disabled={off || busy} size={mobile ? 'md' : 'sm'} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget and name
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function BudgetDialog({ a, onClose, onSaved }: { a: AccountDto; onClose: () => void; onSaved: (s: AccountsStatus) => void }) {
  const b = a.budget;
  // this device's zone, as an example; the hub may be in another one
  const hereZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [usd, setUsd] = useState(b ? String(b.usd) : '');
  const [period, setPeriod] = useState<NonNullable<AccountBudget['period']>>(b?.period ?? 'month');
  const [day, setDay] = useState(String(b?.resetDay ?? (b?.period === 'week' ? 1 : 1)));
  const [hour, setHour] = useState(String(b?.resetHour ?? 0));
  const [tz, setTz] = useState(b?.tz ?? '');
  const [warn, setWarn] = useState(String(b?.warnAt ?? 80));
  const [stop, setStop] = useState(b?.hardStop !== false);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string>();
  const save = async (remove = false) => {
    setBusy(remove ? 'remove' : 'save');
    setError(undefined);
    try {
      const budget: AccountBudget | null = remove ? null : { usd: Number(usd), period, ...(period !== 'day' ? { resetDay: Number(day) } : {}), resetHour: Number(hour), ...(tz.trim() ? { tz: tz.trim() } : {}), warnAt: Number(warn), hardStop: stop };
      onSaved(await api().updateAccount(a.id, { budget }));
      onClose();
    } catch (e) {
      setError(errText(e));
    }
    setBusy(null);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Budget for ${a.label}`}
      description="Spend comes from Conclave's own cost records for this key. You hear once at the warning, and once when it is spent."
      footer={
        <>
          {b && (
            <Button variant="danger" busy={busy === 'remove' ? 'Removing' : false} onClick={() => void save(true)} className="mr-auto">
              Remove budget
            </Button>
          )}
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" busy={busy === 'save' ? 'Saving' : false} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Amount in US dollars" error={error}>
          <Input mono inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} placeholder="100" autoFocus />
        </Field>
        <Field label="Resets every">
          <div>
            <Segmented
            label="Period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'month', label: 'Month' },
              { value: 'week', label: 'Week' },
              { value: 'day', label: 'Day' },
            ]}
            />
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          {period === 'month' && (
            <Field label="On day" help="Past a short month's end it resets on its last day.">
              <Select value={day} onChange={(e) => setDay(e.target.value)}>
                {Array.from({ length: 31 }, (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>
                    {i + 1}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {period === 'week' && (
            <Field label="On">
              <Select value={day} onChange={(e) => setDay(e.target.value)}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={String(i)}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="At">
            <Select value={hour} onChange={(e) => setHour(e.target.value)}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={String(h)}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Time zone" help={`A name like ${hereZone}. Empty uses the hub's time zone.`} optional>
          <Input mono value={tz} onChange={(e) => setTz(e.target.value)} placeholder={hereZone} spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="Tell me at" help="Percent of the budget.">
          <Input mono inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value)} className="max-w-[96px]" />
        </Field>
        <Checkbox checked={stop} onChange={setStop} label="Stop calls on this key when it is spent" description="Off: you are told, and calls go on." />
      </form>
    </Dialog>
  );
}

function RenameDialog({ a, onClose, onSaved }: { a: AccountDto; onClose: () => void; onSaved: (s: AccountsStatus) => void }) {
  const [label, setLabel] = useState(a.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api().updateAccount(a.id, { label }));
      onClose();
    } catch (e) {
      setError(errText(e));
    }
    setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename"
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" busy={busy ? 'Saving' : false} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" help="Empty goes back to the email or the provider's name." error={error}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} autoFocus />
        </Field>
      </form>
    </Dialog>
  );
}
