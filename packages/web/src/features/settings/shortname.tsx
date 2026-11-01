/**
 * A plan's short name in Settings > Models > Accounts: its CLIProxyAPI
 * prefix, so its models also read neu/claude-opus-5-5 and Conclave can keep
 * a request on that plan (Refusal fallback, Window starter). Each plan row
 * has the field; when two or more plans of one vendor have none, one quiet
 * line at the top asks for them, with a field for each. The hub writes the
 * name to CLIProxyAPI (PUT /api/accounts/:id/prefix) and reads the models
 * again.
 */
import { useState } from 'react';
import type { AccountDto, AccountsStatus } from '@conclave/core/client';
import { prefixProblem } from '@conclave/core/accounts/prefix';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { takenPrefixes, unnamedLine, unnamedPlans } from '@/lib/accounts';
import { toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { errText } from './parts';

/** Check the name, then save it on the hub. Empty removes it. Throws with the words to show. */
export async function saveShortName(a: AccountDto, value: string, all: AccountDto[]): Promise<AccountsStatus> {
  const name = value.trim().toLowerCase();
  const problem = prefixProblem(name, takenPrefixes(all, a.id));
  if (problem) throw new Error(problem.message);
  return api().setAccountPrefix(a.id, name);
}

/** The field and Save. Starts with the saved name, else the suggestion. */
export function ShortNameField({ a, all, suggestion, onSaved, className }: { a: AccountDto; all: AccountDto[]; suggestion?: string; onSaved: (s: AccountsStatus) => void; className?: string }) {
  const mobile = useIsMobile();
  const saved = a.prefix ?? '';
  const [value, setValue] = useState(saved || suggestion || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const name = value.trim().toLowerCase();
      onSaved(await saveShortName(a, value, all));
      toast({ title: name ? `${a.label} has the short name ${name}.` : `${a.label} has no short name now.` });
    } catch (e) {
      setError(errText(e));
    }
    setBusy(false);
  };
  return (
    <form
      className={cn('min-w-0', className)}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <span className="flex items-center gap-2">
        <Input
          aria-label={`Short name for ${a.label}`}
          mono
          size={mobile ? 'md' : 'sm'}
          value={value}
          onChange={(e) => setValue(e.target.value.toLowerCase())}
          placeholder={suggestion ?? 'neu'}
          maxLength={24}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          invalid={!!error}
          className="w-[150px] phone:w-auto phone:min-w-0 phone:flex-1"
        />
        <Button type="submit" variant="outline" size={mobile ? 'md' : 'sm'} busy={busy ? 'Saving' : false} disabled={value.trim().toLowerCase() === saved}>
          Save
        </Button>
      </span>
      {error && <span className="mt-1 block text-[12px] leading-[1.45] text-fault phone:text-[13px]">{error}</span>}
    </form>
  );
}

/** On a plan's row: what the short name does, and the field. */
export function ShortNameRow({ a, all, suggestion, onSaved }: { a: AccountDto; all: AccountDto[]; suggestion?: string; onSaved: (s: AccountsStatus) => void }) {
  const help = a.prefix ? `Ids also as ${a.prefix}/, so Conclave can pick this plan. Empty removes it.` : 'Lets Conclave pick this plan (Refusal fallback, Window starter).';
  return (
    <div className="mt-3 max-w-[560px] border-t border-rule pt-3">
      <div className="flex items-start gap-3 phone:flex-col phone:items-stretch phone:gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-fg phone:text-[15px]">Short name</span>
          <span className="block text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{help}</span>
        </span>
        {/* a new saved name starts the field again from it */}
        <ShortNameField key={a.prefix ?? ''} a={a} all={all} suggestion={suggestion} onSaved={onSaved} />
      </div>
    </div>
  );
}

/** The quiet line at the top: two or more plans of a vendor without a short name, with a field for each. */
export function UnnamedPlans({ status, suggestions, onSaved }: { status: AccountsStatus; suggestions: Map<string, string>; onSaved: (s: AccountsStatus) => void }) {
  if (!status.management) return null;
  const groups = unnamedPlans(status.accounts);
  if (!groups.length) return null;
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.vendor} className="max-w-[640px]">
          <p className="m-0 text-[13px] leading-[1.45] text-fg-3 phone:text-[14px]">{unnamedLine(g)}</p>
          <div className="mt-2 space-y-2">
            {g.plans.map((a) => (
              <div key={a.id} className="flex items-center gap-3 phone:flex-col phone:items-stretch phone:gap-1">
                <span className="w-[200px] truncate text-[12.5px] text-fg-2 phone:w-auto phone:text-[13.5px]">{a.label}</span>
                <ShortNameField a={a} all={status.accounts} suggestion={suggestions.get(a.id)} onSaved={onSaved} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
