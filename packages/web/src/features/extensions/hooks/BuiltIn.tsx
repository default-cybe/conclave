/**
 * Hooks > Built in (ECOSYSTEM.md 4.3 item 16): memory recall, memory
 * extraction, compaction and file recall. Each row says when it runs, whether
 * it is on and what it costs per session; the detail has the On / Off, the
 * budget and its last run.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { BuiltinHookDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast } from '@/store/store';
import { useIsMobile, useNow } from '@/lib/hooks';
import { duration, relTime } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, Input, OnOff } from '@/components/ui/Field';
import { CodeBlock } from '@/components/ui/Code';
import { StateWord } from '@/components/ui/List';
import { LoadingRows } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Section';
import { Drawer } from './Drawer';
import { resultWord, tokenWords } from './model';

function lastWords(b: BuiltinHookDto): string {
  const r = b.lastRun;
  if (!r) return 'no runs yet';
  const ago = relTime(r.at) === 'now' ? 'just now' : `${relTime(r.at)} ago`;
  return `last run ${ago}: ${resultWord(r.result)}, ${duration(r.durationMs)}`;
}

export function BuiltInView({ list, loading, error, onReload, onChanged }: { list?: BuiltinHookDto[]; loading: boolean; error?: string; onReload: () => void; onChanged: (b: BuiltinHookDto) => void }) {
  useNow(30_000);
  const [open, setOpen] = useState<string | null>(null);
  const current = list?.find((b) => b.id === open);
  return (
    <div className="space-y-6">
      <p className="mt-0 max-w-[80ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
        These run inside the hub at hook points, with no script and no process per call. Each run that adds context is logged with its size, like any hook.
      </p>
      {error && !list && (
        <div className="border-y border-rule-2 py-2">
          <Notice tone="fault" action={{ label: 'Retry', onClick: onReload }}>
            {`Failed. Could not load the built-in hooks: ${error}`}
          </Notice>
        </div>
      )}
      <LoadingRows loading={loading && !list} rows={4} />
      {list && (
        <div className="rows border-t border-rule-2">
          {list.map((b) => (
            <div key={b.id}>
              <Row b={b} onOpen={() => setOpen(b.id)} />
            </div>
          ))}
        </div>
      )}
      <BuiltinSheet b={current} open={!!current} onClose={() => setOpen(null)} onChanged={onChanged} />
    </div>
  );
}

function Row({ b, onOpen }: { b: BuiltinHookDto; onOpen: () => void }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  const meta = [b.event, tokenWords(b.tokensPerSession), lastWords(b)].filter(Boolean);
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={onKey} className="-mx-3 flex cursor-pointer gap-4 px-3 py-3 outline-none transition-colors duration-[var(--dur-1)] hover:bg-hover focus-visible:bg-hover phone:-mx-2 phone:px-2">
      <div className="min-w-0 flex-1">
        <div className="t-row truncate text-fg">{b.label}</div>
        <div className="mt-0.5 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
          <span className="font-mono text-[11.5px] phone:text-[12.5px]">{meta[0]}</span>
          {meta.slice(1).map((m, i) => (
            <span key={i}>, {m}</span>
          ))}
        </div>
        <p className="mt-1 mb-0 line-clamp-2 max-w-[80ch] text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">{b.description}</p>
      </div>
      <StateWord tone={b.enabled ? 'ok' : 'dim'} className="shrink-0 pt-px text-[13px] phone:text-[14px]">
        {b.enabled ? 'on' : 'off'}
      </StateWord>
    </div>
  );
}

function BuiltinSheet({ b, open, onClose, onChanged }: { b?: BuiltinHookDto; open: boolean; onClose: () => void; onChanged: (b: BuiltinHookDto) => void }) {
  const mobile = useIsMobile();
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && b) setBudget(b.budgetChars ? String(b.budgetChars) : '');
  }, [open, b?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = async (p: { enabled?: boolean; budgetChars?: number }) => {
    if (!b) return;
    setBusy(true);
    try {
      const next = await api().setBuiltinHook(b.id, p);
      onChanged(next);
      toast({ title: p.enabled === undefined ? `Saved. ${next.label} adds at most ${next.budgetChars?.toLocaleString('en-US')} chars a run.` : `${next.label} is ${next.enabled ? 'on' : 'off'}.` });
    } catch (e) {
      toast({ title: `Could not save it. ${e instanceof Error ? e.message : String(e)}`, level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const n = Number(budget);
  const badBudget = budget.trim() !== '' && (!Number.isFinite(n) || n < 200 || n > 50_000);
  if (!b) return null;
  return (
    <Drawer open={open} onClose={onClose} title={b.label} sub={<span className="mono">{b.event}</span>} width={520}>
      <div className="flex flex-col gap-5">
        <p className="m-0 text-[14px] leading-[1.5] text-fg phone:text-[15px]">{b.description}</p>
        <div className="flex items-center justify-between gap-4">
          <span className="text-[13px] text-fg-2 phone:text-[14px]">{b.canDisable ? 'Every session on this hub' : 'Always on: long sessions would not fit the model without it'}</span>
          {b.canDisable && <OnOff label={b.label} checked={b.enabled} disabled={busy} onChange={(v) => void patch({ enabled: v })} />}
        </div>
        {b.budgetChars !== undefined && (
          <Field label="Budget" help="Most chars it adds to one message or tool result. More is cut, with a note saying so." error={badBudget ? 'Write a number from 200 to 50000.' : undefined}>
            <div className="flex items-center gap-2">
              <Input value={budget} inputMode="numeric" onChange={(e) => setBudget(e.target.value)} suffix="chars" boxClassName="max-w-[200px]" />
              <Button variant="outline" size={mobile ? 'touch' : 'md'} disabled={badBudget || !budget.trim() || n === b.budgetChars || busy} onClick={() => void patch({ budgetChars: n })}>
                Save
              </Button>
            </div>
          </Field>
        )}
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-fg-3 phone:text-[13px]">Cost</div>
          <p className="m-0 text-[13px] text-fg-2 phone:text-[14px]">{b.tokensPerSession ? `About ${b.tokensPerSession.toLocaleString('en-US')} tokens per session, from recent sessions.` : 'Nothing added in recent sessions.'}</p>
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-fg-3 phone:text-[13px]">Last run</div>
          <p className="m-0 text-[13px] text-fg-2 phone:text-[14px]">{b.lastRun ? `${lastWords(b).replace(/^last run/, 'Ran')}${b.lastRun.contextChars ? `, ${b.lastRun.contextChars.toLocaleString('en-US')} chars` : ''}.` : 'No runs yet.'}</p>
          {b.lastRun?.stdout?.trim() && <CodeBlock className="mt-2" code={b.lastRun.stdout.trim()} wrap maxLines={8} />}
        </div>
        {b.setting && (
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-fg-3 phone:text-[13px]">Equivalent</div>
            <CodeBlock code={`conclave config set ${b.setting} ${b.setting === 'context.compactAt' ? '0.8' : b.enabled}`} shell copy />
          </div>
        )}
      </div>
    </Drawer>
  );
}
