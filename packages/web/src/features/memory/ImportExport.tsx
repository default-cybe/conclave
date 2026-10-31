/**
 * Import other tools' memory files (Claude Code, Codex, Gemini CLI,
 * OpenCode) from a device: preview first (what would be saved, what would
 * change, how many secret-looking lines were dropped), then import. Export
 * all memory as markdown: one file to download, or files written into a
 * folder on a device.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { ApiError, type MemoryFileImportResult, type MemoryMarkdownExport } from '@conclave/core/client';
import type { Device, MemoryKind } from '@conclave/core/types';
import { api, MOCK } from '@/lib/api';
import { toast, useHub } from '@/store/store';
import { useIsMobile, useIsWide } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Segmented } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { Aside, KV, Quote, Section, SectionHeading, TextAction } from '@/components/ui/Section';
import { CodeBlock } from '@/components/ui/Code';
import { HarnessMark } from '@/components/logo';
import { errMsg, Working } from './parts';
import { sentence } from './words';
import { reloadMemories } from './store';
import { NoteText } from './Notes';
import { PastChats } from '@/features/import/PastChats';
import { Batches, NotLearnedLine } from '@/features/import/Batches';

type FileRow = MemoryFileImportResult['files'][number];
type Run<T> = { state: 'idle' } | { state: 'running'; since: number; dry: boolean } | { state: 'done'; result: T; dry: boolean } | { state: 'failed'; error: string };

const SOURCE: Record<FileRow['source'], { name: string; harness?: string }> = {
  'claude-code': { name: 'Claude Code', harness: 'claude-code' },
  codex: { name: 'Codex', harness: 'codex' },
  gemini: { name: 'Gemini CLI', harness: 'gemini-cli' },
  opencode: { name: 'OpenCode', harness: 'opencode' },
  file: { name: 'File' },
};
const KIND: Record<Exclude<MemoryKind, 'episode'>, string> = { profile: 'Profile', fact: 'Fact', procedure: 'Procedure', inspiration: 'Inspiration' };
const CLIS = ['claude', 'codex', 'gemini', 'opencode'];
const CLI_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode' };

/** ~/x for display: /home/kai/x, /Users/kai/x and /root/x. */
function tilde(p: string, home?: string): string {
  if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  return p.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~').replace(/^\/root(?=\/|$)/, '~');
}

function cliWords(d: Device): string {
  const have = CLIS.filter((c) => d.info?.clis?.[c]).map((c) => CLI_NAME[c]);
  return have.length ? have.join(', ') : 'none of the coding CLIs';
}

export function ImportExportTab() {
  const wide = useIsWide();
  const body = (
    <div className="min-w-0 space-y-10 phone:space-y-12">
      <PastChatsSection />
      <ImportSection />
      <ExportSection />
    </div>
  );
  if (!wide) return <div className="max-w-[780px]">{body}</div>;
  return (
    <div className="grid grid-cols-[minmax(0,780px)_minmax(0,1fr)]">
      <div className="min-w-0 pr-10">{body}</div>
      <aside className="min-w-0 border-l border-rule pl-10" aria-label="Files Conclave reads">
        <div className="max-w-[460px] space-y-7">
          <Aside title="Files it reads">
            <KV k="Claude Code" keyWidth={96} mono>
              ~/.claude/CLAUDE.md
            </KV>
            <KV k="Codex" keyWidth={96} mono>
              ~/.codex/AGENTS.md, ~/.codex/AGENTS.override.md, ~/.codex/memories/MEMORY.md
            </KV>
            <KV k="Gemini CLI" keyWidth={96} mono>
              ~/.gemini/GEMINI.md
            </KV>
            <KV k="OpenCode" keyWidth={96} mono>
              ~/.config/opencode/AGENTS.md
            </KV>
          </Aside>
          <Aside title="With a project folder">
            <p className="py-1.5 text-[13px] leading-[1.5] text-fg-2">
              Also <span className="mono">CLAUDE.md</span>, <span className="mono">.claude/CLAUDE.md</span>, <span className="mono">CLAUDE.local.md</span>, <span className="mono">AGENTS.md</span>, <span className="mono">AGENTS.override.md</span>, <span className="mono">GEMINI.md</span> and Claude Code's auto memory for that folder. Their notes are given to sessions in that project only.
            </p>
          </Aside>
          <Aside title="Past chats">
            <p className="py-1.5 text-[13px] leading-[1.5] text-fg-2">
              Chats are read on the device they live on. A chat imported once is never copied twice, even from a Syncthing copy on another machine; a chat that grew gets its new messages. Learning keeps an item only when its quote is in the chat, and anything said once waits under To review in Notes. A fact your own Basic Memory notes already have is not saved again; the import counts it as already in your notes.
            </p>
          </Aside>
          <Aside title="Safe to run again">
            <p className="py-1.5 text-[13px] leading-[1.5] text-fg-2">Files that did not change since the last import are skipped. Lines that look like keys or tokens are dropped, and instructions written inside the files are ignored.</p>
          </Aside>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Past chats (features/import): the shared scan, mode, cost line and batches
// ---------------------------------------------------------------------------

function PastChatsSection() {
  return (
    <section aria-labelledby="mem-past" className="space-y-6">
      <div>
        <SectionHeading id="mem-past">Past chats</SectionHeading>
        <p className="mt-2.5 max-w-[68ch] text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">Claude Code, Codex and Gemini CLI chats on your machines, and claude.ai or ChatGPT exports. Import them as archived sessions, learn memory from them, or both.</p>
      </div>
      <PastChats />
      <NotLearnedLine />
      <Batches />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function useDeviceOptions() {
  const devices = useHub((s) => s.devices);
  return useMemo(() => {
    const list = Object.values(devices).sort((a, b) => Number(b.online) - Number(a.online) || (a.id === 'local' ? -1 : b.id === 'local' ? 1 : a.name.localeCompare(b.name)));
    const best = list.find((d) => d.online && CLIS.some((c) => d.info?.clis?.[c])) ?? list.find((d) => d.id === 'local') ?? list[0];
    return { list, best, byId: devices };
  }, [devices]);
}

function DevicePick({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { list } = useDeviceOptions();
  return (
    <SelectMenu
      label={label}
      value={value}
      onChange={onChange}
      width={300}
      options={list.map((d) => ({
        value: d.id,
        label: d.name,
        text: d.name,
        detail: d.online ? cliWords(d) : 'offline',
        hint: <span className={d.online ? 'text-ok' : 'text-fg-3'}>{d.online ? 'online' : 'offline'}</span>,
        disabled: !d.online,
      }))}
    />
  );
}

function ImportSection() {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'md';
  const { best, byId } = useDeviceOptions();
  const sessions = useHub((s) => s.sessions);
  const [device, setDevice] = useState<string>();
  const [cwd, setCwd] = useState('');
  const [force, setForce] = useState(false);
  const [run, setRun] = useState<Run<MemoryFileImportResult>>({ state: 'idle' });
  const [showMissing, setShowMissing] = useState(false);
  const dev = byId[device ?? best?.id ?? 'local'];
  const devId = dev?.id ?? 'local';
  const home = dev?.info?.home;

  // folders of recent sessions on that device, as suggestions
  const folders = useMemo(() => [...new Set(Object.values(sessions).filter((s) => (s.device ?? 'local') === devId && s.cwd && s.cwd !== '~' && s.cwd !== '/').map((s) => s.cwd!))].slice(0, 8), [sessions, devId]);

  // a device, folder or force change makes an answer on its way stale: Import must act on what the preview showed
  const runId = useRef(0);
  const go = async (dry: boolean) => {
    const dir = cwd.trim();
    const id = ++runId.current;
    setRun({ state: 'running', since: Date.now(), dry });
    try {
      const result = await api().importMemoryFiles({ device: devId, cwd: dir || undefined, dryRun: dry, force });
      if (id === runId.current) setRun({ state: 'done', result, dry });
      if (!dry) {
        // the hub sends note events for small imports only
        if (result.added.length + result.updated.length > 40) void reloadMemories();
        const n = result.added.length;
        const u = result.updated.length;
        toast({ title: n || u ? `Imported ${n} ${n === 1 ? 'note' : 'notes'}${u ? ` and updated ${u}` : ''} from ${dev?.name ?? devId}.` : `Nothing new on ${dev?.name ?? devId}.` });
      }
    } catch (e) {
      if (id === runId.current) setRun({ state: 'failed', error: e instanceof ApiError && e.status === 404 && !/device/i.test(e.message) ? 'This hub is older and cannot import memory files. Update the hub.' : errMsg(e) });
    }
  };

  const reset = () => {
    runId.current++;
    setRun({ state: 'idle' });
  };
  const result = run.state === 'done' ? run.result : undefined;
  const found = result?.files.filter((f) => f.status !== 'missing') ?? [];
  const missing = result?.files.filter((f) => f.status === 'missing') ?? [];
  const toSave = result ? (run.state === 'done' && run.dry ? result.proposed.length + result.proposedUpdates.length : 0) : 0;

  return (
    <section aria-labelledby="mem-import">
      <SectionHeading id="mem-import">Memory files from other tools</SectionHeading>
      <p className="mt-3 max-w-[68ch] text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">Claude Code, Codex, Gemini CLI and OpenCode each keep what they know about you in markdown files. Conclave reads them on a device and turns them into notes, merged with what is already here.</p>

      <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
        <Field label="Device">
          <DevicePick
            label="Device"
            value={devId}
            onChange={(v) => {
              setDevice(v);
              reset();
            }}
          />
        </Field>
        <Field label="Project folder" optional help="Also read that project's CLAUDE.md, AGENTS.md and GEMINI.md.">
          <Input
            mono
            value={cwd}
            onChange={(e) => {
              setCwd(e.target.value);
              reset();
            }}
            placeholder={folders[0] ?? '~/code/conclave'}
            list="mem-import-folders"
            spellCheck={false}
            autoCapitalize="off"
          />
        </Field>
        {folders.length > 0 && (
          <datalist id="mem-import-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button variant={run.state === 'done' && run.dry && toSave > 0 ? 'outline' : 'solid'} size={size} busy={run.state === 'running' && run.dry ? 'Reading' : false} disabled={run.state === 'running'} onClick={() => void go(true)}>
          Preview
        </Button>
        <Checkbox checked={force} onChange={(v) => (setForce(v), reset())} label="Read files again even if they did not change" className="phone:py-2.5" />
      </div>

      {run.state === 'running' && <Working className="mt-5" word={run.dry ? 'Reading' : 'Importing'} since={run.since} detail={`The small model reads each file on ${dev?.name ?? devId}. This takes a few seconds.`} />}
      {run.state === 'failed' && (
        <p className="mt-5 max-w-[68ch] text-[14px] text-fg-2">
          <span className="text-fault">Failed.</span> {run.error} {/offline/.test(run.error) ? 'Pick a device that is online, or wake this one and try again.' : ''}
        </p>
      )}

      {result && (
        <div className="mt-6 space-y-7">
          <Section title="Files" count={found.length} right={missing.length > 0 ? <TextAction label={showMissing ? 'Hide files not found' : `${missing.length} not found`} onClick={() => setShowMissing((s) => !s)} /> : undefined}>
            {found.length === 0 && !showMissing && <p className="py-3 text-[14px] text-fg-2">None of the memory files exist on {dev?.name ?? devId}. Try another device, or add a project folder.</p>}
            {[...found, ...(showMissing ? missing : [])].map((f) => (
              <FileLine key={f.path} f={f} home={home} dry={run.state === 'done' && run.dry} />
            ))}
          </Section>

          {run.state === 'done' && run.dry && (
            <>
              {result.proposed.length > 0 && (
                <Section title="New notes" count={result.proposed.length}>
                  {result.proposed.map((p, i) => (
                    <div key={i} className="py-3">
                      <p className="t-prose text-fg">
                        <NoteText text={p.content} />
                      </p>
                      <p className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">
                        {KIND[p.kind]}, {p.scope === 'global' ? 'global' : p.scope === 'project' ? 'this project' : p.scope}, from <span className="mono">{tilde(p.file, home)}</span>
                      </p>
                    </div>
                  ))}
                </Section>
              )}
              {result.proposedUpdates.length > 0 && <Updates updates={result.proposedUpdates} home={home} />}
              {(toSave > 0 || found.length > 0 || result.dropped > 0) && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-rule-2 pt-4">
                {toSave > 0 ? (
                  <Button variant="solid" size={size} onClick={() => void go(false)}>
                    Import {result.proposed.length ? `${result.proposed.length} ${result.proposed.length === 1 ? 'note' : 'notes'}` : ''}
                    {result.proposed.length && result.proposedUpdates.length ? ' and ' : ''}
                    {result.proposedUpdates.length ? `${result.proposedUpdates.length} ${result.proposedUpdates.length === 1 ? 'change' : 'changes'}` : ''}
                  </Button>
                ) : (
                  <p className="text-[14px] text-fg-2">Nothing new to import.</p>
                )}
                {result.dropped > 0 && <p className="text-[13px] text-fg-3 phone:text-[14px]">{result.dropped === 1 ? 'Dropped 1 line that looked like a secret.' : `Dropped ${result.dropped} lines that looked like secrets.`}</p>}
              </div>
              )}
            </>
          )}
          {run.state === 'done' && !run.dry && (
            <p className="text-[14px] text-fg-2">
              <span className="text-ok">Imported.</span> {result.added.length} new {result.added.length === 1 ? 'note' : 'notes'}
              {result.updated.length ? `, ${result.updated.length} updated` : ''}.{result.dropped ? ` Dropped ${result.dropped} secret-looking ${result.dropped === 1 ? 'line' : 'lines'}.` : ''}{' '}
              <Link href="/memory" className="link">
                See them in Notes
              </Link>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function FileLine({ f, home, dry }: { f: FileRow; home?: string; dry: boolean }) {
  const src = SOURCE[f.source];
  const words: Record<FileRow['status'], ReactNode> = {
    preview: f.added || f.updated ? [f.added && `${f.added} new`, f.updated && `${f.updated} ${f.updated === 1 ? 'change' : 'changes'}`].filter(Boolean).join(', ') : 'nothing new',
    imported: f.added || f.updated ? [f.added && `${f.added} imported`, f.updated && `${f.updated} updated`].filter(Boolean).join(', ') : 'nothing new',
    unchanged: 'unchanged since the last import',
    missing: 'not found',
    empty: 'empty',
    error: <span className="text-fault">failed</span>,
  };
  return (
    <div className="py-2.5">
      <div className="flex items-baseline gap-3">
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {src.harness ? <HarnessMark harness={src.harness} size={13} className="self-center" /> : <span className="inline-block w-[13px]" aria-hidden />}
          <span className={cn('mono min-w-0 truncate text-[12.5px]', f.status === 'missing' ? 'text-fg-3' : 'text-fg')} title={f.path}>
            {tilde(f.path, home)}
          </span>
        </span>
        <span className={cn('shrink-0 text-right text-[12px] phone:text-[13px]', f.status === 'preview' && (f.added || f.updated) ? 'text-fg-2' : f.status === 'imported' ? 'text-ok' : 'text-fg-3')}>{words[f.status]}</span>
      </div>
      <p className="mt-0.5 pl-[21px] text-[12px] text-fg-3 phone:text-[13px]">
        {src.name}, {f.scope === 'global' ? 'your user file' : 'project file'}
        {dry && f.status === 'unchanged' ? '. Tick "Read files again" to import it anyway.' : ''}
      </p>
      {f.error && (
        <p className="mt-1 pl-[21px] text-[12px] phone:text-[13px]">
          <span className="text-fault">{sentence(f.error)}</span> <span className="text-fg-2">{fileHint(f.error)}</span>
        </p>
      )}
    </div>
  );
}

/** What to do about a file that failed: the small model, the file's permissions, or the device. */
function fileHint(error: string): string {
  if (/\b401\b|\b403\b|authentication|api[ -]?key|x-api-key/i.test(error)) return 'The small model could not run. Check its provider key in Settings, Providers, or pick another small model in Settings, Defaults.';
  if (/EACCES|permission denied/i.test(error)) return 'Conclave cannot read this file on that device. Check its owner and permissions.';
  if (/rate limit|\b429\b/i.test(error)) return 'The small model hit a rate limit. Try again in a minute.';
  if (/timed out|timeout/i.test(error)) return 'The device or the model was too slow. Try again.';
  return 'Try again. If it keeps failing, look at the hub log.';
}

function Updates({ updates, home }: { updates: MemoryFileImportResult['proposedUpdates']; home?: string }) {
  const memories = useHub((s) => s.memories);
  return (
    <Section title="Changes to notes you have" count={updates.length}>
      {updates.map((u) => {
        const old = memories[u.id];
        return (
          <div key={u.id} className="py-3">
            <p className="t-prose text-fg">
              <NoteText text={u.content} />
            </p>
            {old && <Quote className="mt-2 text-[13px]">Now: {old.content}</Quote>}
            <p className="mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">
              From <span className="mono">{tilde(u.file, home)}</span>
            </p>
          </div>
        );
      })}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** GET /api/memory/export?format=md needs the bearer token, so fetch it and save the blob. */
async function downloadMarkdown(includeImported: boolean) {
  const c = api();
  const url = `${c.baseUrl}/api/memory/export?format=md${includeImported ? '&includeImported=1' : ''}`;
  const f = MOCK ? (await import('@/mock')).mockFetch : fetch;
  const res = await f(url, { headers: c.token ? { authorization: `Bearer ${c.token}` } : {} });
  if (!res.ok) {
    let msg = `The hub answered ${res.status}.`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  // the mock router sends the file as a JSON string
  const text = (res.headers.get('content-type') ?? '').includes('json') ? ((await res.json()) as string) : await res.text();
  const href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = 'conclave-memory.md';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

function ExportSection() {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'md';
  const { best, byId } = useDeviceOptions();
  const [layout, setLayout] = useState<'single' | 'folder'>('single');
  const [includeImported, setIncludeImported] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [device, setDevice] = useState<string>();
  const [dir, setDir] = useState('');
  const [dirError, setDirError] = useState<string>();
  const [write, setWrite] = useState<Run<{ dir: string; files: string[]; count: number }>>({ state: 'idle' });
  const [preview, setPreview] = useState<{ data?: MemoryMarkdownExport; error?: string; loading: boolean } | null>(null);
  const dev = byId[device ?? best?.id ?? 'local'];
  const devId = dev?.id ?? 'local';
  // an answer for another layout or device is not shown ("Written ... on" would name the new device)
  const gen = useRef(0);
  useEffect(() => {
    gen.current++;
  }, [layout, includeImported, devId]);

  const download = async () => {
    setDownloading(true);
    try {
      await downloadMarkdown(includeImported);
    } catch (e) {
      toast({ title: `Could not download the export. ${errMsg(e)}`, level: 'error' });
    }
    setDownloading(false);
  };

  const writeFiles = async () => {
    const d = dir.trim();
    if (!d) return setDirError('Type a folder, for example ~/notes/conclave-export.');
    setDirError(undefined);
    setWrite({ state: 'running', since: Date.now(), dry: false });
    const at = gen.current;
    let next: typeof write;
    try {
      next = { state: 'done', result: await api().exportMemoryTo({ dir: d, device: devId, layout, includeImported }), dry: false };
    } catch (e) {
      next = { state: 'failed', error: errMsg(e) };
    }
    if (at === gen.current) setWrite(next);
  };

  const showPreview = async () => {
    if (preview) return setPreview(null);
    setPreview({ loading: true });
    const at = gen.current;
    let next: { data?: MemoryMarkdownExport; error?: string; loading: boolean };
    try {
      next = { loading: false, data: await api().exportMemory({ layout, includeImported }) };
    } catch (e) {
      next = { loading: false, error: errMsg(e) };
    }
    if (at === gen.current) setPreview(next);
  };

  return (
    <section aria-labelledby="mem-export">
      <SectionHeading id="mem-export" right={<TextAction label={preview ? 'Hide the export' : 'Show the export'} onClick={() => void showPreview()} />}>
        Export
      </SectionHeading>
      <p className="mt-3 max-w-[68ch] text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">All memory as markdown, for a backup or a git repo. The order is stable, so a nightly export shows only real changes in a diff.</p>

      <div className="mt-5 space-y-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-fg-2 phone:text-[13px]">Layout</span>
          <Segmented
            className="self-start"
            label="Layout"
            value={layout}
            onChange={(v) => (setLayout(v), setPreview(null), setWrite({ state: 'idle' }))}
            size={mobile ? 'touch' : 'md'}
            full={mobile}
            options={[
              { value: 'single', label: 'One file' },
              { value: 'folder', label: 'Folder of notes' },
            ]}
          />
          <p className="text-[12px] text-fg-3 phone:text-[13px]">
            {layout === 'single' ? (
              <>
                <span className="mono">conclave-memory.md</span>, grouped by profile, facts and sessions.
              </>
            ) : (
              <>
                Basic Memory style notes under <span className="mono">conclave-memory/</span>: a profile, facts per scope and one note per session. Write them to their own folder, not your Basic Memory notes, or every fact shows up twice.
              </>
            )}
          </p>
        </div>
        <Checkbox checked={includeImported} onChange={(v) => (setIncludeImported(v), setPreview(null))} label="Include notes imported from connections" description="They already live in those stores, so they are left out by default." className="phone:py-2" />
      </div>

      {preview && (
        <div className="mt-5">
          {preview.loading && <p className="text-[13px] text-fg-3">Loading the preview.</p>}
          {preview.error && (
            <p className="text-[13px] text-fg-2">
              <span className="text-fault">Failed.</span> {preview.error}
            </p>
          )}
          {preview.data && (
            <div className="space-y-3">
              <p className="text-[12px] text-fg-3 phone:text-[13px]">
                {preview.data.count} {preview.data.count === 1 ? 'memory' : 'memories'} in {preview.data.files.length} {preview.data.files.length === 1 ? 'file' : 'files'}.
              </p>
              {preview.data.files.slice(0, 3).map((f) => (
                <CodeBlock key={f.path} code={f.content} lang="markdown" title={<span className="mono">{f.path}</span>} maxLines={16} />
              ))}
              {preview.data.files.length > 3 && <p className="text-[12px] text-fg-3">And {preview.data.files.length - 3} more files.</p>}
            </div>
          )}
        </div>
      )}

      <div className="mt-6 grid gap-6 border-t border-rule pt-5 md:grid-cols-2 md:gap-10">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-medium text-fg phone:text-[15px]">Download</h3>
          <p className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">{layout === 'single' ? 'One file to this device.' : 'A folder cannot be one download. Pick One file, or write the folder to a device.'}</p>
          <Button className="mt-3" variant="outline" size={size} disabled={layout !== 'single'} busy={downloading ? 'Downloading' : false} onClick={() => void download()}>
            Download conclave-memory.md
          </Button>
        </div>
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-medium text-fg phone:text-[15px]">Write to a device</h3>
          <p className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">Files Conclave wrote there before are replaced.</p>
          <div className="mt-3 flex flex-col gap-2.5">
            <DevicePick label="Device to write to" value={devId} onChange={(v) => (setDevice(v), setWrite({ state: 'idle' }))} />
            <Field label="Folder" error={dirError}>
              <Input mono value={dir} onChange={(e) => (setDir(e.target.value), setDirError(undefined))} placeholder="~/notes/conclave-export" spellCheck={false} autoCapitalize="off" />
            </Field>
            <Button className="self-start" variant="outline" size={size} busy={write.state === 'running' ? 'Writing' : false} onClick={() => void writeFiles()}>
              Write files
            </Button>
          </div>
        </div>
      </div>
      {write.state === 'done' && (
        <div className="mt-4 text-[13px] text-fg-2 phone:text-[14px]">
          <p>
            <span className="text-ok">Written.</span> {write.result.count} {write.result.count === 1 ? 'memory' : 'memories'} in {write.result.files.length} {write.result.files.length === 1 ? 'file' : 'files'} under <span className="mono break-all">{write.result.dir}</span> on {dev?.name ?? devId}.
          </p>
          <ul className="mt-2 list-none space-y-0.5 p-0">
            {write.result.files.slice(0, 6).map((f) => (
              <li key={f} className="mono truncate text-[12px] text-fg-3" title={f}>
                {f.startsWith(write.result.dir) ? f.slice(write.result.dir.length + 1) : f}
              </li>
            ))}
            {write.result.files.length > 6 && <li className="text-[12px] text-fg-3">and {write.result.files.length - 6} more</li>}
          </ul>
        </div>
      )}
      {write.state === 'failed' && (
        <p className="mt-4 max-w-[68ch] text-[13px] text-fg-2 phone:text-[14px]">
          <span className="text-fault">Failed.</span> {write.error} {/offline/.test(write.error) ? 'Pick a device that is online.' : ''}
        </p>
      )}
    </section>
  );
}
