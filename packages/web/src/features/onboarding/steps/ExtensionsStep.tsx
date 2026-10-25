/**
 * Step 4, Make Conclave better: install recommended extensions in one go.
 * Packs as checkable cards (Starter on), then one form for every value the
 * chosen entries need (one field per input name), then the install, one entry
 * at a time through the Discover routes. Installed entries are skipped, so the
 * step is safe to run again.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { CatalogItemDto } from '@conclave/core/client';
import { EXTENSION_PACKS, KEY_HELP, type ExtensionPack } from '@conclave/core/catalog/packs';
import { api } from '@/lib/api';
import { cn } from '@/lib/text';
import { reloadConfig, useHub } from '@/store/store';
import { Checkbox, Field, Input } from '@/components/ui/Field';
import { SectionHeading } from '@/components/ui/Section';
import { StateWord, type StateTone } from '@/components/ui/List';
import { StepFrame } from '../StepLayout';
import { errText, LINK } from '../parts';
import { installAll, keyFields, packIds, type Row } from '../packs';

type Phase = 'pick' | 'keys' | 'install' | 'finished';

/** Every pack entry as the hub describes it, with installed and ready. */
async function loadEntries(ids: string[]): Promise<Record<string, CatalogItemDto>> {
  const out: Record<string, CatalogItemDto> = {};
  let cursor: string | undefined;
  do {
    const page = await api().catalog({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const it of page.items) if (ids.includes(it.id)) out[it.id] = it;
    cursor = page.next;
  } while (cursor && Object.keys(out).length < ids.length);
  return out;
}

const ALL_IDS = packIds(EXTENSION_PACKS.map((p) => p.id));

function PackCard({ pack, on, onChange, entries }: { pack: ExtensionPack; on: boolean; onChange: (v: boolean) => void; entries: Record<string, CatalogItemDto> | null }) {
  const [open, setOpen] = useState(false);
  const installed = pack.items.filter((id) => entries?.[id]?.installed).length;
  return (
    <div className={cn('rounded-[var(--r-2)] border px-4 py-3', on ? 'border-edge bg-raise' : 'border-rule')}>
      <Checkbox
        checked={on}
        onChange={onChange}
        label={<span className="text-[14px] font-[560] phone:text-[15px]">{pack.name}</span>}
        description={<span className="text-[13px] text-fg-2 phone:text-[14px]">{pack.line}</span>}
      />
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cn('mt-1 ml-6 text-[12px] text-fg-3 hover:text-fg phone:text-[13px]', LINK)}>
        {open ? 'Hide' : 'Show'} what it installs ({pack.items.length}
        {installed ? `, ${installed} already installed` : ''})
      </button>
      {open && (
        <ul className="m-0 mt-2 ml-6 list-none space-y-1 p-0">
          {pack.items.map((id) => {
            const it = entries?.[id];
            return (
              <li key={id} className="text-[13px] leading-[1.45] phone:text-[14px]">
                <span className="text-fg">{it?.name ?? id.split(':')[1]}</span>
                <span className="text-fg-3"> {id.split(':')[0]}</span>
                {it?.installed && <span className="text-ok"> installed</span>}
                {it?.description && <span className="line-clamp-1 text-[12px] text-fg-3 phone:text-[13px]">{it.description}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const TONE: Record<Row['state'], StateTone> = { waiting: 'dim', installing: 'signal', done: 'ok', skipped: 'dim', failed: 'fault' };
const WORD: Record<Row['state'], string> = { waiting: 'Waiting', installing: 'Installing', done: 'Done', skipped: 'Skipped', failed: 'Failed' };

export function ExtensionsStep() {
  const saved = useHub((s) => s.secrets?.values) ?? [];
  const [chosen, setChosen] = useState<string[]>(EXTENSION_PACKS.filter((p) => p.defaultOn).map((p) => p.id));
  const [entries, setEntries] = useState<Record<string, CatalogItemDto> | null>(null);
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<Phase>('pick');
  const [values, setValues] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<string, Row>>({});

  useEffect(() => {
    loadEntries(ALL_IDS)
      .then(setEntries)
      .catch((e) => setError(errText(e)));
  }, []);

  // each phase starts at its top, like a new step (StepShell scrolls #main on a step change)
  useEffect(() => {
    if (phase !== 'finished') document.getElementById('main')?.scrollTo({ top: 0 });
  }, [phase]);

  const items = useMemo(() => packIds(chosen).flatMap((id) => (entries?.[id] ? [entries[id]] : [])), [chosen, entries]);
  const fields = useMemo(() => keyFields(items, saved), [items, saved]);
  const todo = items.filter((i) => !i.installed);

  const run = async () => {
    setPhase('install');
    setRows(Object.fromEntries(items.map((i) => [i.id, { state: 'waiting' } as Row])));
    await installAll(items, values, saved, { preview: (r) => api().catalogPreview(r), install: (r) => api().catalogInstall(r) }, (id, row) => setRows((rs) => ({ ...rs, [id]: row })));
    void reloadConfig().catch(() => undefined);
    setPhase('finished');
  };

  const onContinue = async (): Promise<boolean> => {
    if (phase === 'finished') return true;
    if (phase === 'install' || !entries) return false;
    if (phase === 'pick') {
      if (!todo.length) return true;
      // fill each field's default once, so a default value is visible and editable
      setValues((v) => ({ ...Object.fromEntries(fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default!])), ...v }));
      if (fields.some((f) => !f.saved)) {
        setPhase('keys');
        return false;
      }
    }
    await run();
    return false;
  };

  const counts = Object.values(rows).reduce<Record<string, number>>((c, r) => ({ ...c, [r.state]: (c[r.state] ?? 0) + 1 }), {});
  const summary =
    phase === 'pick'
      ? entries
        ? `${todo.length} to install${items.length > todo.length ? `, ${items.length - todo.length} already installed` : ''}.`
        : undefined
      : phase === 'keys'
        ? `${fields.length} ${fields.length === 1 ? 'value' : 'values'} for ${todo.length} extensions.`
        : `${counts.done ?? 0} installed, ${counts.skipped ?? 0} skipped, ${counts.failed ?? 0} failed.`;

  return (
    <StepFrame
      summary={summary}
      onContinue={onContinue}
      continueLabel={phase === 'pick' ? (todo.length || !entries ? 'Install selected' : 'Continue') : phase === 'keys' ? 'Install' : 'Continue'}
      continueBusy={phase === 'install' ? 'Installing' : 'Checking'}
    >
      {error && <p className="m-0 mb-6 text-[13px] text-fault">Could not load the catalog. {error}</p>}

      {phase === 'pick' && (
        <div className="space-y-3">
          {EXTENSION_PACKS.map((p) => (
            <PackCard key={p.id} pack={p} entries={entries} on={chosen.includes(p.id)} onChange={(v) => setChosen((c) => (v ? [...c, p.id] : c.filter((x) => x !== p.id)))} />
          ))}
        </div>
      )}

      {phase === 'keys' && (
        <section>
          <SectionHeading count={fields.length}>Keys and values</SectionHeading>
          <p className="m-0 mt-3 max-w-[64ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
            Secrets go to the hub&apos;s secrets store. Leave a required one empty and that extension is skipped. Model provider keys are on the{' '}
            <Link href="/setup/providers" className={LINK}>
              Providers
            </Link>{' '}
            step.
          </p>
          <div className="mt-5 space-y-5">
            {fields.map((f) => {
              const help = KEY_HELP[f.name];
              return (
                <Field
                  key={f.name}
                  label={f.label}
                  optional={!f.required || f.saved}
                  help={
                    <>
                      {f.saved ? 'Saved on the hub. Leave empty to keep it. ' : ''}
                      {help?.how ?? f.description}{' '}
                      {help?.url && (
                        <a href={help.url} target="_blank" rel="noreferrer" className={LINK}>
                          Get it
                        </a>
                      )}
                      <span className="block">For {f.for.join(', ')}</span>
                    </>
                  }
                >
                  <Input
                    mono
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    value={values[f.name] ?? ''}
                    placeholder={f.example}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  />
                </Field>
              );
            })}
          </div>
          <button type="button" onClick={() => setPhase('pick')} className={cn('mt-6 text-[13px] text-fg-3 hover:text-fg phone:text-[14px]', LINK)}>
            Change packs
          </button>
        </section>
      )}

      {(phase === 'install' || phase === 'finished') && (
        <section aria-live="polite">
          <SectionHeading count={items.length}>{phase === 'finished' ? 'Results' : 'Installing'}</SectionHeading>
          <div className="rows">
            {items.map((it) => {
              const r = rows[it.id] ?? { state: 'waiting' };
              const why = r.state === 'skipped' || r.state === 'failed' ? r.why : r.state === 'done' ? r.note : undefined;
              return (
                <div key={it.id} className="flex items-baseline gap-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-[14px] text-fg phone:text-[15px]">{it.name}</p>
                    {why && <p className={cn('m-0 mt-0.5 text-[12px] leading-[1.45] phone:text-[13px]', r.state === 'failed' ? 'text-fault' : 'text-fg-3')}>{why}</p>}
                  </div>
                  <StateWord tone={TONE[r.state]} live={r.state === 'installing'} className="shrink-0">
                    {WORD[r.state]}
                  </StateWord>
                </div>
              );
            })}
          </div>
          {phase === 'finished' && (
            <p className="m-0 mt-6 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Skipped and failed ones can be added later in Extensions, Discover.</p>
          )}
        </section>
      )}
    </StepFrame>
  );
}
