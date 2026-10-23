/**
 * Settings > Models > Refusal fallback (the owner's "safety priority", core
 * session/refusal-fallback.ts). An ordered list of models, each with an
 * optional account from Accounts. When a model refuses and its provider says
 * so, the hub runs the same turn on the next one, with the same messages. On
 * its own when the switch is on; the "Try the next model" button under a
 * refused reply works whenever the list has a model. Off and empty unless set.
 *
 * Rows: number, drag handle, model, account, up, down, remove. Every change
 * saves at once (models.refusalFallback).
 *
 * A line at the top names the plans and keys marked "Use when a model
 * refuses" in Accounts, which a refused reply goes to first, same model,
 * before this list; with none marked it says how to mark one.
 */
import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, X } from 'lucide-react';
import { Link } from 'wouter';
import type { AccountDto } from '@conclave/core/client';
import type { RefusalFallbackConfig, RefusalFallbackEntry } from '@conclave/core/config/schema';
import { SHORT_NAME_WHERE, refusalMarkedLine, useAccounts } from '@/lib/accounts';
import { cn } from '@/lib/text';
import { useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { makerOf, ModelList, ModelPicker } from '@/components/pickers/ModelPicker';
import { Button, IconButton } from '@/components/ui/Button';
import { OnOff } from '@/components/ui/Field';
import { Popover } from '@/components/ui/Overlay';
import { SelectMenu, type SelectOption } from '@/components/ui/Select';
import { Group, save, SettingRow } from './parts';

/** The vendor an account serves (core accounts/vendors.ts) for a model ref. */
export function vendorOfRef(ref: string): string | undefined {
  const maker = makerOf(ref.slice(ref.indexOf('/') + 1));
  return maker === 'google' ? 'gemini' : maker;
}

/** A plan with no short name (prefix) next to other plans of its vendor: CLIProxyAPI picks which one answers. */
export function looseAccount(a: AccountDto | undefined, all: AccountDto[]): boolean {
  return !!a && a.kind === 'subscription' && !a.prefix && all.some((x) => x.id !== a.id && x.vendor === a.vendor && x.kind === 'subscription');
}

const ANY = '__order';

export function RefusalSection() {
  const config = useHub((s) => s.config);
  const own = ((config?.models as { refusalFallback?: RefusalFallbackConfig } | undefined)?.refusalFallback ?? {}) as RefusalFallbackConfig;
  const entries = own.entries ?? [];
  const { status } = useAccounts();
  const accounts = status?.accounts ?? [];
  const addRef = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const write = (next: Partial<RefusalFallbackConfig>) => void save({ models: { refusalFallback: { ...own, ...next } } });
  const setEntries = (list: RefusalFallbackEntry[]) => write({ entries: list });
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= entries.length) return;
    const list = [...entries];
    const [e] = list.splice(from, 1);
    list.splice(to, 0, e);
    setEntries(list);
  };

  const marked = refusalMarkedLine(status);
  return (
    <div className="space-y-9">
      <p className="m-0 max-w-[64ch] text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">
        {marked.text}{' '}
        <Link href="/settings/accounts" className="underline decoration-rule-2 underline-offset-[3px] hover:text-fg">
          {marked.marked ? 'Change in Accounts' : 'Open Accounts'}
        </Link>
      </p>

      <Group title="When a model refuses">
        <SettingRow label="Try the next model on its own" help="Off: a refused reply shows Try the next model instead.">
          <OnOff checked={own.enabled === true} onChange={(v) => write({ enabled: v })} label="Try the next model on its own" />
        </SettingRow>
        <SettingRow label="Stay on the model that answered" help="Off: the next message goes to the chat's own model again.">
          <OnOff checked={own.stay === true} onChange={(v) => write({ stay: v })} label="Stay on the model that answered" />
        </SettingRow>
      </Group>

      <Group
        title="Order"
        count={entries.length || undefined}
        right={
          <Button ref={addRef} variant="outline" size="sm" aria-expanded={adding} onClick={() => setAdding(true)}>
            Add a model
          </Button>
        }
        help="First tried first, after the marked plans and keys. Drag a row or use the arrows. Pick an account to keep a step on that plan or key."
      >
        {entries.length === 0 ? (
          <p className="m-0 py-3.5 text-[13px] text-fg-3 phone:text-[14px]">No models yet. Add the ones to try when a model refuses, in order.</p>
        ) : (
          entries.map((e, i) => (
            <EntryRow
              key={`${e.model}@${e.account ?? ''}#${i}`}
              entry={e}
              rank={i + 1}
              first={i === 0}
              last={i === entries.length - 1}
              accounts={accounts}
              dragging={dragging === i}
              over={over === i && dragging !== null && dragging !== i}
              onDragStart={() => setDragging(i)}
              onDragOver={() => setOver(i)}
              onDrop={() => {
                if (dragging !== null) move(dragging, i);
                setDragging(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onChange={(next) => setEntries(entries.map((x, j) => (j === i ? next : x)))}
              onMove={(by) => move(i, i + by)}
              onRemove={() => setEntries(entries.filter((_, j) => j !== i))}
            />
          ))
        )}
      </Group>

      <Popover anchor={addRef} open={adding} onClose={() => setAdding(false)} width={380} maxHeight={480} label="Add a model" sheetTitle="Add a model">
        <ModelList
          harnesses={false}
          onChange={(ref) => {
            setEntries([...entries, { model: ref }]);
          }}
          onDone={() => setAdding(false)}
        />
      </Popover>
    </div>
  );
}

function EntryRow({
  entry,
  rank,
  first,
  last,
  accounts,
  dragging,
  over,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onChange,
  onMove,
  onRemove,
}: {
  entry: RefusalFallbackEntry;
  rank: number;
  first: boolean;
  last: boolean;
  accounts: AccountDto[];
  dragging: boolean;
  over: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onChange: (e: RefusalFallbackEntry) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const mobile = useIsMobile();
  const vendor = vendorOfRef(entry.model);
  const mine = accounts.filter((a) => a.vendor === vendor);
  const chosen = entry.account ? accounts.find((a) => a.id === entry.account) : undefined;
  const options: SelectOption[] = [
    { value: ANY, label: 'Your order', text: 'Your order', detail: 'The first account in Accounts that has it' },
    ...mine.map((a) => ({ value: a.id, label: a.label, text: a.label, detail: [a.kind === 'api' ? 'API key' : a.plan ? `${a.vendorName} ${a.plan}` : 'Plan', a.prefix && `ids as ${a.prefix}/`].filter(Boolean).join(' · ') })),
    // an account that is gone keeps its place, so the list says what it names
    ...(entry.account && !chosen ? [{ value: entry.account, label: `${entry.account} (not found)`, text: entry.account }] : []),
  ];
  return (
    <div
      className={cn('py-3', dragging && 'opacity-50', over && 'shadow-[inset_0_2px_0_var(--signal)]')}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <div className="flex items-center gap-3 phone:items-start">
        <span className="num w-4 shrink-0 text-right text-[12.5px] text-fg-3 phone:mt-3" aria-label={`Step ${rank}`}>
          {rank}
        </span>
        {!mobile && (
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            className="-ml-1 cursor-grab text-fg-4 hover:text-fg-2"
            aria-hidden
          >
            <GripVertical className="size-4" strokeWidth={1.75} />
          </span>
        )}
        {/* a phone stacks the model, the account and the arrows; a computer keeps them on one line */}
        <div className="flex min-w-0 flex-1 items-center gap-3 phone:flex-col phone:items-stretch phone:gap-2">
          <ModelPicker look="field" label={`Step ${rank} model`} value={entry.model} harnesses={false} onChange={(ref) => onChange({ model: ref, ...(entry.account && vendorOfRef(ref) === vendor ? { account: entry.account } : {}) })} className="min-w-0 flex-1 md:max-w-[260px]" />
          <SelectMenu look="field" label={`Step ${rank} account`} value={entry.account ?? ANY} options={options} onChange={(v) => onChange({ model: entry.model, ...(v === ANY ? {} : { account: v }) })} width={260} className="min-w-0 flex-1 md:max-w-[200px]" />
          <span className="ml-auto flex shrink-0 items-center gap-0.5 phone:-mr-2">
            <IconButton label="Move up" size={mobile ? 'touch' : 'sm'} disabled={first} onClick={() => onMove(-1)}>
              <ChevronUp />
            </IconButton>
            <IconButton label="Move down" size={mobile ? 'touch' : 'sm'} disabled={last} onClick={() => onMove(1)}>
              <ChevronDown />
            </IconButton>
            <IconButton label="Remove" size={mobile ? 'touch' : 'sm'} onClick={onRemove}>
              <X />
            </IconButton>
          </span>
        </div>
      </div>
      {looseAccount(chosen, accounts) && <p className="m-0 mt-1.5 pl-7 text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">CLIProxyAPI picks which {chosen!.vendorName} plan answers. To keep the step on this plan, give it a short name in {SHORT_NAME_WHERE}.</p>}
    </div>
  );
}
