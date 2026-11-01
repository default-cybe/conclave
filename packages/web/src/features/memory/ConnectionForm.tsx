/**
 * Add or edit a memory connection (UI-HANDOFF.md, Memory connections): pick
 * a preset, fill its fields (a trailing ? in the preset marks the optional
 * ones), test the unsaved form, choose a mode, save. Saved credentials show
 * as ******** and go back as they are, so the hub keeps them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryConnectionConfigDto, MemoryConnectionInfo, MemoryConnectionInputDto, MemoryConnectionMode, MemoryConnectionPreset, MemoryConnectionTestResult } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast, useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Field, Input, OnOff, Radio, Textarea } from '@/components/ui/Field';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { errMsg, Panel, TestSteps, Working } from './parts';
import { reloadConnections, upsertConnection } from './store';
import { CREDENTIAL, FIELD, fieldInfo, isHidden, MODE, MODES, parseField, recordToText, textToRecord, TYPE_NAME, type FieldKind } from './words';

type Opts = Record<string, unknown>;
type Test = { state: 'idle' } | { state: 'running'; since: number } | { state: 'done'; result: MemoryConnectionTestResult } | { state: 'failed'; error: string };

/** Example URLs per store type, for an empty URL field. */
const URL_HINT: Record<string, string> = {
  'basic-memory': 'http://notes-box:8000/mcp',
  mcp: 'http://memory.lan:8000/mcp',
  mem0: 'http://mem0:8888',
  cognee: 'http://cognee:8000',
  http: 'http://notes.lan:8080',
};

/** Options the form never shows as fields: they come with the preset. */
const FIXED = new Set(['preset', 'variant', 'transport', 'fields', 'listArgs']);
// a member's config has no mcpServers; a fresh {} per read made the store selector loop (React #185)
const NO_SERVERS: Record<string, unknown> = {};

/** The preset an existing connection most likely started from. */
function presetFor(c: MemoryConnectionInfo, presets: MemoryConnectionPreset[]): MemoryConnectionPreset | undefined {
  const same = presets.filter((p) => p.type === c.type);
  const has = (k: string) => c.options[k] !== undefined && c.options[k] !== '';
  if (c.type === 'basic-memory') return same.find((p) => p.key === (has('server') ? 'basic-memory-server' : has('url') ? 'basic-memory-http' : 'basic-memory-local')) ?? same[0];
  if (c.type === 'mcp') return same.find((p) => p.key === (c.options.preset === 'custom' || has('searchTool') ? 'mcp-custom' : 'mcp-knowledge-graph')) ?? same[0];
  if (c.type === 'mem0') return same.find((p) => p.key === (c.options.variant === 'self-hosted' || (has('url') && !/mem0\.ai/.test(String(c.options.url))) ? 'mem0-self-hosted' : 'mem0-platform')) ?? same[0];
  return same[0];
}

/** Known option keys have a fixed kind; any other object or list value is edited as JSON. */
function kindFor(key: string, v: unknown): FieldKind {
  if (FIELD[key]) return FIELD[key].kind;
  return v && typeof v === 'object' ? 'json' : fieldInfo(key).kind;
}

function toText(key: string, v: unknown): string {
  const kind = kindFor(key, v);
  if (kind === 'headers' || kind === 'env') return recordToText(v, kind);
  if (kind === 'json') return v === undefined ? '' : JSON.stringify(v, null, 2);
  if (kind === 'secret') return isHidden(v) ? CREDENTIAL : String(v ?? '');
  return v === undefined || v === null ? '' : String(v);
}

export function ConnectionForm({ open, edit, onClose, onSaved }: { open: boolean; edit?: MemoryConnectionInfo; onClose: () => void; onSaved?: (c: MemoryConnectionInfo) => void }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'md';
  const mcpServers = useHub((s) => (s.config?.mcpServers ?? NO_SERVERS) as Record<string, unknown>);
  const [presets, setPresets] = useState<MemoryConnectionPreset[]>();
  const [loadError, setLoadError] = useState<string>();
  const [presetKey, setPresetKey] = useState<string>();
  const [picking, setPicking] = useState(true);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<MemoryConnectionMode>('mirror');
  const [search, setSearch] = useState(true);
  const [timeout, setTimeoutMs] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const [test, setTest] = useState<Test>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  // load presets and reset the form each time it opens
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadError(undefined);
    setTest({ state: 'idle' });
    setTried(false);
    setSaveError(undefined);
    setSaving(false);
    api()
      .memoryConnectionPresets()
      .then((p) => {
        if (!alive) return;
        setPresets(p);
        if (edit) {
          const pre = presetFor(edit, p);
          setPresetKey(pre?.key);
          setPicking(false);
          setName(edit.name);
          setMode(edit.mode);
          setSearch(edit.search);
          setTimeoutMs(String(edit.timeoutMs));
          const keys = fieldsOf(pre, edit.options).map((f) => f.key);
          setValues(Object.fromEntries(keys.map((k) => [k, toText(k, edit.options[k])])));
        } else {
          setPresetKey(undefined);
          setPicking(true);
          setValues({});
        }
        // the panel opened before the store types arrived, so focus sat on Cancel: move it to the first field
        requestAnimationFrame(() => {
          if (!alive) return;
          const first = document.querySelector<HTMLElement>(edit ? '[data-conn-first]' : 'input[name=conn-preset]');
          first?.focus({ preventScroll: true });
        });
      })
      .catch((e) => alive && setLoadError(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [open, edit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const preset = presets?.find((p) => p.key === presetKey);
  const fields = useMemo(() => fieldsOf(preset, edit?.options), [preset, edit?.options]);
  const type = edit?.type ?? preset?.type;

  const choose = (p: MemoryConnectionPreset) => {
    setPresetKey(p.key);
    setPicking(false);
    setName(p.template.name ?? TYPE_NAME[p.type]);
    setMode(p.template.mode ?? 'mirror');
    setSearch(p.template.search !== false);
    setTimeoutMs(String(p.template.timeoutMs ?? 2500));
    const opts = (p.template.options ?? {}) as Opts;
    setValues(Object.fromEntries(p.fields.map((f) => parseField(f).key).map((k) => [k, toText(k, opts[k])])));
    setTest({ state: 'idle' });
    setTried(false);
    setSaveError(undefined);
  };

  // ----- build the connection from the form ---------------------------------

  const built = useMemo(() => {
    const errors: Record<string, string> = {};
    const options: Opts = { ...((edit?.options ?? preset?.template.options ?? {}) as Opts) };
    for (const f of fields) {
      const info = fieldInfo(f.key);
      const kind = kindFor(f.key, options[f.key]);
      const raw = values[f.key] ?? '';
      const text = raw.trim();
      if (kind === 'headers' || kind === 'env') {
        const r = textToRecord(raw, kind);
        if (r.error) errors[f.key] = r.error;
        const rec = r.value ? Object.fromEntries(Object.entries(r.value).filter(([, v]) => v !== '')) : undefined;
        if (rec && Object.keys(rec).length) options[f.key] = rec;
        else delete options[f.key];
      } else if (kind === 'json') {
        if (!text) delete options[f.key];
        else
          try {
            options[f.key] = JSON.parse(text);
          } catch {
            errors[f.key] = 'This is not valid JSON. Check the quotes and commas.';
          }
      } else if (!text) {
        if (f.optional) delete options[f.key];
        else {
          options[f.key] = '';
          errors[f.key] = `Fill in the ${/^[A-Z]{2,}\b/.test(info.label) ? info.label : info.label.toLowerCase()}.`;
        }
      } else options[f.key] = text;
    }
    const ms = Number(timeout);
    if (timeout.trim() && (!Number.isFinite(ms) || ms < 200 || ms > 60_000)) errors.timeoutMs = 'Use a number of milliseconds between 200 and 60000.';
    const input: MemoryConnectionInputDto = {
      ...(edit ? { id: edit.id } : {}),
      type: (type ?? 'basic-memory') as MemoryConnectionConfigDto['type'],
      name: name.trim() || undefined,
      mode,
      search,
      ...(timeout.trim() && !errors.timeoutMs ? { timeoutMs: ms } : {}),
      options,
    };
    return { input, errors };
  }, [fields, values, name, mode, search, timeout, type, edit, preset]);

  // a test result belongs to the form it ran on: any change makes it stale
  const sig = JSON.stringify(built.input);
  const sigNow = useRef(sig);
  sigNow.current = sig;
  useEffect(() => {
    setTest((t) => (t.state === 'done' || t.state === 'failed' ? { state: 'idle' } : t));
  }, [sig]);

  const errorCount = Object.keys(built.errors).length;
  const readOnlyStore = type === 'mcp' && built.input.options?.preset === 'custom' && !String(built.input.options?.writeTool ?? '').trim();

  const runTest = async () => {
    setTried(true);
    if (errorCount) return;
    setTest({ state: 'running', since: Date.now() });
    const ran = sig;
    let next: Test;
    try {
      next = { state: 'done', result: await api().testMemoryConnectionConfig(built.input) };
    } catch (e) {
      next = { state: 'failed', error: errMsg(e) };
    }
    // the form changed while the test ran: its answer is for settings no longer on screen
    setTest(sigNow.current === ran ? next : { state: 'idle' });
  };

  const save = async () => {
    setTried(true);
    setSaveError(undefined);
    if (errorCount) return setSaveError(`Fix ${errorCount === 1 ? 'the field' : `the ${errorCount} fields`} marked in red.`);
    setSaving(true);
    try {
      const { id: _id, type: _t, ...patch } = built.input;
      const c = edit ? await api().updateMemoryConnection(edit.id, patch) : await api().addMemoryConnection(built.input);
      upsertConnection(c);
      const failing = c.status.state === 'error' || c.status.state === 'backoff';
      toast({ title: edit ? `Saved ${c.name}.${failing ? ' Test it to clear the last error.' : ''}` : `Added ${c.name}. ${test.state === 'done' && test.result.ok ? '' : 'Test it to check it works.'}`.trim() });
      onSaved?.(c);
      onClose();
      void reloadConnections();
    } catch (e) {
      setSaveError(errMsg(e));
    }
    setSaving(false);
  };

  const testWords =
    test.state === 'done' ? (
      test.result.ok ? (
        <span className="text-ok">Works</span>
      ) : (
        <span className="text-fault">Test failed</span>
      )
    ) : test.state === 'failed' ? (
      <span className="text-fault">Test failed</span>
    ) : test.state === 'running' ? (
      <span className="text-signal">Testing</span>
    ) : (
      'Not tested yet'
    );

  const slow = (type === 'basic-memory' || type === 'mcp') && !built.input.options?.url && !built.input.options?.server && !built.input.options?.command;
  const servers = Object.keys(mcpServers);

  return (
    <Panel
      open={open}
      onClose={onClose}
      title={edit ? `Edit ${edit.name}` : 'Add a connection'}
      sub={edit ? <span className="mono">{edit.id}</span> : 'Search another memory store from every session.'}
      width={600}
      footer={
        <>
          <p className={cn('mr-auto min-w-0 text-[12px] leading-[1.4] phone:w-full phone:text-[13px]', saveError ? 'text-fault' : 'text-fg-3')}>{saveError ?? (preset || edit ? testWords : '')}</p>
          <Button variant="quiet" size={size} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" size={size} busy={saving ? 'Saving' : false} disabled={!type} onClick={() => void save()}>
            {edit ? 'Save' : 'Add connection'}
          </Button>
        </>
      }
    >
      {loadError && (
        <p className="text-[14px] text-fg-2">
          <span className="text-fault">Failed.</span> Could not load the store types: {loadError} Close this and try again.
        </p>
      )}
      {!presets && !loadError && <LoadingRows loading rows={4} />}

      {presets && !edit && (
        <section>
          <SectionHeading right={!picking && <TextAction label="Change" onClick={() => setPicking(true)} />}>Store</SectionHeading>
          {picking ? (
            <div className="pt-2" role="radiogroup" aria-label="Store">
              {presets.map((p) => (
                <Radio key={p.key} name="conn-preset" checked={p.key === presetKey} onChange={() => choose(p)} label={p.label} description={p.description} className="py-1.5 phone:py-2.5" />
              ))}
            </div>
          ) : (
            preset && (
              <p className="pt-3 text-[14px] text-fg phone:text-[15px]">
                {preset.label}
                <span className="block text-[12px] text-fg-3 phone:text-[13px]">{preset.description}</span>
              </p>
            )
          )}
        </section>
      )}

      {presets && type && !picking && (
        <>
          <section className={cn(!edit && 'mt-8')}>
            <SectionHeading>Settings</SectionHeading>
            <div className="flex flex-col gap-4 pt-4">
              <Field label="Name" help="Shown in lists and in notes it imports.">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={TYPE_NAME[type]} data-conn-first />
              </Field>
              {fields.map((f) => {
                const info = fieldInfo(f.key);
                const kind = kindFor(f.key, (edit?.options ?? preset?.template.options ?? {})[f.key]);
                const v = values[f.key] ?? '';
                const set = (x: string) => setValues((s) => ({ ...s, [f.key]: x }));
                const err = tried ? built.errors[f.key] : undefined;
                const hiddenSecret = kind === 'secret' && v === CREDENTIAL;
                return (
                  <Field key={f.key} label={info.label} optional={f.optional} error={err} help={hiddenSecret ? 'Saved. Leave it to keep the saved key, or paste a new one.' : f.key === 'server' && servers.length ? `${info.help} You have ${servers.join(', ')}.` : info.help}>
                    {kind === 'headers' || kind === 'env' || kind === 'json' ? (
                      <Textarea mono minRows={kind === 'json' ? 3 : 2} maxRows={8} value={v} onChange={(e) => set(e.target.value)} placeholder={info.placeholder} spellCheck={false} autoCapitalize="off" />
                    ) : (
                      <Input
                        mono={info.mono}
                        type={kind === 'secret' ? 'password' : 'text'}
                        value={v}
                        onChange={(e) => set(e.target.value)}
                        onFocus={(e) => hiddenSecret && e.target.select()}
                        placeholder={f.key === 'url' ? (URL_HINT[type] ?? info.placeholder) : info.placeholder}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoComplete={kind === 'secret' ? 'new-password' : 'off'}
                        list={f.key === 'server' && servers.length ? 'conn-servers' : undefined}
                      />
                    )}
                  </Field>
                );
              })}
              {servers.length > 0 && (
                <datalist id="conn-servers">
                  {servers.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              )}
            </div>
          </section>

          <section className="mt-8">
            <SectionHeading>Mode</SectionHeading>
            <div className="pt-2" role="radiogroup" aria-label="Mode">
              {MODES.map((m) => (
                <Radio key={m} name="conn-mode" checked={mode === m} onChange={() => setMode(m)} disabled={readOnlyStore && m !== 'read'} label={MODE[m].words} description={MODE[m].help} className="py-1.5 phone:py-2.5" />
              ))}
            </div>
            {readOnlyStore && mode !== 'read' && <p className="mt-1 text-[12px] text-fault phone:text-[13px]">Without a write tool this store can only be read. Pick Search and import only, or name a write tool.</p>}
          </section>

          <section className="mt-8">
            <SectionHeading>Search</SectionHeading>
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-fg phone:text-[15px]">Search it on every recall</p>
                <p className="mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">{search ? 'A slow or broken store is skipped without delaying the answer.' : 'Sessions use the notes a sync imported instead.'}</p>
              </div>
              <OnOff label="Search it on every recall" size={mobile ? 'touch' : 'sm'} checked={search} onChange={setSearch} />
            </div>
            {search && (
              <Field label="Wait at most" help="Per search, in milliseconds. Cognee and remote stores need more than the default 2500." error={tried ? built.errors.timeoutMs : undefined}>
                <Input value={timeout} inputMode="numeric" onChange={(e) => setTimeoutMs(e.target.value.replace(/[^\d]/g, ''))} suffix="ms" boxClassName="max-w-[200px] phone:max-w-none" placeholder="2500" />
              </Field>
            )}
          </section>

          <section className="mt-8">
            <SectionHeading>Test</SectionHeading>
            <p className="pt-3 text-[13px] text-fg-2 phone:text-[14px]">Connects, lists the tools and runs a harmless search. Nothing is saved.</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="outline" size={size} busy={test.state === 'running' ? 'Testing' : false} onClick={() => void runTest()}>
                Test
              </Button>
              {tried && errorCount > 0 && test.state === 'idle' && <span className="text-[12px] text-fault phone:text-[13px]">Fix the fields marked in red first.</span>}
            </div>
            {test.state === 'running' && <Working className="mt-3" word="Testing" since={test.since} detail={slow ? 'The first start downloads the server. It can take a minute.' : undefined} />}
            {test.state === 'done' && <TestSteps className="mt-3" result={test.result} />}
            {test.state === 'failed' && (
              <p className="mt-3 text-[13px] text-fg-2 phone:text-[14px]">
                <span className="text-fault">Failed.</span> {test.error}
              </p>
            )}
          </section>
        </>
      )}
    </Panel>
  );
}

/** The preset's fields, plus any other option an existing connection has, so nothing is lost on edit. */
function fieldsOf(preset: MemoryConnectionPreset | undefined, options: Opts | undefined): Array<{ key: string; optional: boolean }> {
  const out = (preset?.fields ?? []).map(parseField);
  for (const k of Object.keys(options ?? {})) if (!FIXED.has(k) && !out.some((f) => f.key === k)) out.push({ key: k, optional: true });
  return out;
}
