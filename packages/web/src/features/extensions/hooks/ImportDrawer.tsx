/**
 * Import hooks from Gemini CLI or Codex settings: a preview with renamed
 * events, converted timeouts, skipped events and behaviour notes, then save
 * to user or project scope (appended after the hooks already there).
 */
import { useEffect, useState } from 'react';
import type { HookImportResult } from '@conclave/core/client';
import type { HookEvent, HookMatcher } from '@conclave/core/config/schema';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { plural } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { HarnessMark } from '@/components/logo';
import { Drawer } from './Drawer';
import { EVENT_ORDER, anyWords, countHandlers, type Scope } from './model';

export type From = 'gemini' | 'codex';

const FILES: Record<From, string> = {
  gemini: '~/.gemini/settings.json and .gemini/settings.json in the project',
  codex: '~/.codex/hooks.json, ~/.codex/config.toml and the same files in the project',
};

export function ImportDrawer({ open, initialFrom, onClose, cwd, onSave }: { open: boolean; initialFrom: From; onClose: () => void; cwd?: string; onSave: (scope: Scope, r: HookImportResult) => Promise<string | undefined> }) {
  const mobile = useIsMobile();
  const [from, setFrom] = useState<From>('codex');
  const [scope, setScope] = useState<Scope>('user');
  const [preview, setPreview] = useState<HookImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const read = async (f: From) => {
    setLoading(true);
    setError(undefined);
    setPreview(null);
    try {
      setPreview(await api().importHooks(f, cwd));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setScope('user');
    setFrom(initialFrom);
    void read(initialFrom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const n = preview ? countHandlers(preview.hooks) : 0;
  const events = preview ? EVENT_ORDER.filter((e) => preview.hooks[e]?.length) : [];
  const name = from === 'gemini' ? 'Gemini CLI' : 'Codex';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Import hooks"
      sub="Nothing is saved until you add them."
      footer={
        <>
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="solid"
            size={mobile ? 'touch' : 'md'}
            disabled={!n || (scope === 'project' && !cwd)}
            busy={saving ? 'Adding' : false}
            onClick={async () => {
              if (!preview) return;
              setSaving(true);
              const err = await onSave(scope, preview);
              setSaving(false);
              if (err) setError(err);
              else onClose();
            }}
          >
            {n ? `Add ${plural(n, 'handler')}` : 'Add'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">From</span>
        <Segmented
          className="self-start"
          label="Import from"
          value={from}
          size={mobile ? 'touch' : 'md'}
          onChange={(f) => {
            setFrom(f);
            void read(f);
          }}
          options={[
            {
              value: 'codex',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <HarnessMark harness="codex" size={14} /> Codex
                </span>
              ),
            },
            {
              value: 'gemini',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <HarnessMark harness="gemini-cli" size={14} /> Gemini CLI
                </span>
              ),
            },
          ]}
        />
        <p className="m-0 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">Reads {FILES[from]} on the hub.</p>
      </div>

      <section aria-label="Preview" aria-busy={loading} className="mt-6">
        <div className="flex items-baseline gap-2 border-b border-rule-2 pb-[9px]">
          <h3 className="t-section text-fg">Preview</h3>
          {preview && <span className="num text-[13px] text-fg-3">{n}</span>}
        </div>
        {loading && <p className="mt-3 text-[13px] text-fg-3">Reading {name} settings.</p>}
        {error && (
          <p className="mt-3 text-[14px] leading-[1.45] text-fg-2">
            <span className="text-fault">Failed.</span> {error}
          </p>
        )}
        {preview && n === 0 && (
          <p className="mt-3 text-[14px] leading-[1.45] text-fg-2">
            No {name} hooks found in {FILES[from]}. Nothing to import.
          </p>
        )}
        {preview && n > 0 && (
          <div className="rows">
            {events.map((ev) =>
              (preview.hooks[ev as HookEvent] as HookMatcher[]).map((g, gi) =>
                g.hooks.map((h, hi) => (
                  <div key={`${ev}:${gi}:${hi}`} className="py-2.5">
                    <div className="flex items-baseline gap-3 text-[12.5px]">
                      <span className="font-mono text-fg">{ev}</span>
                      <span className="min-w-0 truncate text-[12px] text-fg-3">{g.matcher ? <span className="mono">{g.matcher}</span> : anyWords(ev as HookEvent)}</span>
                      <span className="ml-auto shrink-0 text-[12px] text-fg-3">{h.timeout ? `timeout ${h.timeout}s` : 'default timeout'}</span>
                    </div>
                    <div className="mt-0.5 font-mono text-[12.5px] [overflow-wrap:anywhere] text-fg-2">{h.command ?? h.prompt}</div>
                  </div>
                )),
              ),
            )}
          </div>
        )}
        {preview && preview.skipped.length > 0 && (
          <p className="mt-3 mb-0 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">
            Skipped: {preview.skipped.map((s, i) => (
              <span key={s}>
                <span className="mono">{s}</span>
                {i < preview.skipped.length - 1 ? ', ' : ''}
              </span>
            ))}
            . Conclave has no matching event, so they are left out.
          </p>
        )}
        {preview && preview.notes.length > 0 && (
          <div className="mt-4">
            <div className="text-[12px] font-medium text-fg-3">Behaviour differences</div>
            <ul className="m-0 mt-1 list-disc pl-5 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">
              {preview.notes.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {preview && n > 0 && (
        <div className="mt-6 flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Save to</span>
          <Segmented
            className="self-start"
            label="Scope"
            value={scope}
            onChange={setScope}
            size={mobile ? 'touch' : 'md'}
            options={[
              { value: 'user', label: 'User' },
              { value: 'project', label: 'This project', disabled: !cwd },
            ]}
          />
          <p className="m-0 text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
            {scope === 'user' ? (
              <>
                Added after your hooks in <span className="mono">~/.conclave/config.json</span>.
              </>
            ) : (
              <>
                Added after the hooks in <span className="mono">.conclave/settings.json</span> of this project.
              </>
            )}
          </p>
        </div>
      )}
    </Drawer>
  );
}
