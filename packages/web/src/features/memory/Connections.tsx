/**
 * Memory connections: other memory stores Conclave searches and, by mode,
 * saves to. One row per connection with its state; a row opens in place to
 * show the details and the actions (enable, test, sync, edit, connect to
 * other CLIs, clear imported notes, remove).
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { ChevronRight } from 'lucide-react';
import type { MemoryConnectionInfo, MemoryConnectionTestResult, MemorySyncResult } from '@conclave/core/client';
import { api } from '@/lib/api';
import { toast } from '@/store/store';
import { useIsMobile, useIsWide, useNow } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { OnOff, Radio } from '@/components/ui/Field';
import { Aside, KV, Notice, Section } from '@/components/ui/Section';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { ConnectionForm } from './ConnectionForm';
import { ConnectPanel } from './ConnectPanel';
import { Confirm, errMsg, TestSteps, Working } from './parts';
import { dropConnection, OLD_HUB, reloadConnections, reloadMemories, upsertConnection, useConnections } from './store';
import { agoWords, capabilityWords, hintFor, isMcpBased, MODE, MODES, msWords, placeOf, sentence, stateWords, syncError, syncWords, TYPE_NAME, whereOf } from './words';

export function ConnectionsTab({ adding, setAdding }: { adding: boolean; setAdding: (v: boolean) => void }) {
  const { list, error, loading } = useConnections();
  const wide = useIsWide();
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryConnectionInfo | null>(null);
  const [connecting, setConnecting] = useState<MemoryConnectionInfo | null>(null);

  const body = (
    <div className="min-w-0">
      <p className="mb-6 max-w-[68ch] text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">Connections are other memory stores. Every session searches them along with Conclave's own notes, and new notes go where each mode says.</p>
      {error && !list && (error === OLD_HUB ? <Notice>{OLD_HUB}</Notice> : <Notice tone="fault" action={{ label: 'Try again', onClick: () => void reloadConnections() }}>{`Failed. Could not load connections: ${sentence(error)} Check that the hub is online.`}</Notice>)}
      {!list && !error && <LoadingRows loading={loading || !list} rows={3} />}
      {list && list.length === 0 && (
        <EmptyState action={{ label: 'Add a connection', onClick: () => setAdding(true) }}>
          No connections yet. Notes stay in Conclave's own store. Connect Basic Memory, mem0, Cognee or any MCP memory server to search it too.
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <Section title="Connections" count={list.length}>
          {list.map((c) => (
            <ConnectionRow key={c.id} c={c} open={open === c.id} onToggle={() => setOpen((o) => (o === c.id ? null : c.id))} onEdit={() => setEditing(c)} onConnect={() => setConnecting(c)} />
          ))}
        </Section>
      )}
    </div>
  );

  return (
    <>
      {wide ? (
        <div className="grid grid-cols-[minmax(0,780px)_minmax(0,1fr)]">
          <div className="min-w-0 pr-10">{body}</div>
          <aside className="min-w-0 border-l border-rule pl-10" aria-label="About connections">
            <div className="max-w-[460px] space-y-7">
              <Aside title="Modes">
                {MODES.map((m) => (
                  <KV key={m} k={MODE[m].label} keyWidth={72}>
                    <span className="text-[13px] text-fg-2">{MODE[m].help}</span>
                  </KV>
                ))}
              </Aside>
              <Aside title="Other tools">
                <p className="py-1.5 text-[13px] leading-[1.5] text-fg-2">
                  Claude Code, Codex, OpenCode and Gemini CLI can use Conclave memory too.{' '}
                  <Link href="/memory/share" className="link">
                    Share it with them
                  </Link>
                  , or{' '}
                  <Link href="/memory/import" className="link">
                    import their memory files
                  </Link>
                  .
                </p>
              </Aside>
            </div>
          </aside>
        </div>
      ) : (
        <div className="max-w-[780px]">{body}</div>
      )}
      <ConnectionForm open={adding || !!editing} edit={editing ?? undefined} onClose={() => (setAdding(false), setEditing(null))} onSaved={(c) => setOpen(c.id)} />
      <ConnectPanel conn={connecting} onClose={() => setConnecting(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// A connection
// ---------------------------------------------------------------------------

type Run<T> = { state: 'idle' } | { state: 'running'; since: number } | { state: 'done'; result: T } | { state: 'failed'; error: string };

function ConnectionRow({ c, open, onToggle, onEdit, onConnect }: { c: MemoryConnectionInfo; open: boolean; onToggle: () => void; onEdit: () => void; onConnect: () => void }) {
  const now = useNow(30_000);
  const s = stateWords(c.status, now);
  const where = whereOf(c);
  const place = placeOf(c);
  const sync = c.status.lastSync;
  const panelId = `conn-${c.id}`;
  const second = [MODE[c.mode].words, c.status.imported ? `${c.status.imported} imported` : undefined, sync ? (sync.error ? `sync failed ${agoWords(sync.at, now)}` : `synced ${agoWords(sync.at, now)}`) : undefined].filter(Boolean).join(', ');

  return (
    <article className="anim-fade">
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={onToggle} className="group -mx-3 flex w-[calc(100%+24px)] items-start gap-3 px-3 py-3 text-left transition-colors duration-[var(--dur-1)] hover:bg-hover phone:-mx-0 phone:w-full phone:px-0">
        <span className="min-w-0 flex-1">
          <span className={cn('t-row block truncate', c.enabled ? 'text-fg' : 'text-fg-2')}>{c.name}</span>
          <span className="mt-0.5 block truncate text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">
            {TYPE_NAME[c.type]}
            {where && (
              <>
                , <span className="mono">{where}</span>
              </>
            )}
            {place ? `, ${place}` : ''}
          </span>
          <span className="mt-0.5 block truncate text-[12px] leading-[1.4] text-fg-3 phone:text-[13px]">{second}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-[12px] leading-[1.4] phone:text-[13px]">
          <span className="num text-fg-3">{c.enabled && c.status.latencyMs !== undefined && c.status.state === 'ok' ? msWords(c.status.latencyMs) : ' '}</span>
          <span className={cn('state-word', s.tone === 'ok' ? 'text-ok' : s.tone === 'fault' ? 'text-fault' : s.tone === 'warn' ? 'text-warn' : 'text-fg-3')}>{s.word}</span>
        </span>
        <ChevronRight aria-hidden strokeWidth={1.75} className={cn('mt-0.5 size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--dur-1)]', open && 'rotate-90')} />
      </button>
      {s.detail && c.enabled && <p className="-mt-1.5 mb-3 max-w-[68ch] pr-8 text-[12px] leading-[1.45] text-fg-2 phone:text-[13px]">{s.detail}</p>}
      {open && <ConnectionDetail id={panelId} c={c} onEdit={onEdit} onConnect={onConnect} />}
    </article>
  );
}

function ConnectionDetail({ id, c, onEdit, onConnect }: { id: string; c: MemoryConnectionInfo; onEdit: () => void; onConnect: () => void }) {
  const mobile = useIsMobile();
  const now = useNow(30_000);
  const size = mobile ? 'touch' : 'sm';
  const [test, setTest] = useState<Run<MemoryConnectionTestResult>>({ state: 'idle' });
  const [sync, setSync] = useState<Run<MemorySyncResult>>({ state: 'idle' });
  const [toggling, setToggling] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [keep, setKeep] = useState(false);
  const last = c.status.lastSync;
  const slow = (c.type === 'basic-memory' || c.type === 'mcp') && !c.options.url && !c.options.server;

  const runTest = async () => {
    setTest({ state: 'running', since: Date.now() });
    try {
      setTest({ state: 'done', result: await api().testMemoryConnection(c.id) });
    } catch (e) {
      setTest({ state: 'failed', error: errMsg(e) });
    }
    void reloadConnections();
  };

  const runSync = async () => {
    setSync({ state: 'running', since: Date.now() });
    try {
      const r = await api().syncMemoryConnection(c.id);
      setSync({ state: 'done', result: r });
      // the hub sends a note event for small syncs only; fetch the list after a big one
      if (r.added + r.updated > 40) void reloadMemories();
    } catch (e) {
      setSync({ state: 'failed', error: errMsg(e) });
    }
    void reloadConnections();
  };

  const setEnabled = async (enabled: boolean) => {
    setToggling(true);
    try {
      upsertConnection(await api().updateMemoryConnection(c.id, { enabled }));
    } catch (e) {
      toast({ title: `Could not turn ${c.name} ${enabled ? 'on' : 'off'}. ${errMsg(e)}`, level: 'error' });
    }
    setToggling(false);
  };

  // the quieter actions: a row of text buttons on desktop, a list of 44px rows on phones
  const more: Array<{ label: string; onClick: () => void; danger?: boolean }> = [
    { label: 'Edit', onClick: onEdit },
    ...(isMcpBased(c) ? [{ label: 'Connect to my CLIs', onClick: onConnect }] : []),
    ...(c.status.imported > 0 ? [{ label: 'Clear imported notes', onClick: () => setClearing(true) }] : []),
    { label: 'Remove', onClick: () => (setKeep(false), setRemoving(true)), danger: true },
  ];

  return (
    <div id={id} className="pb-5 anim-fade">
      <dl className="max-w-[640px]">
        <KV k="Type" keyWidth={104}>
          {TYPE_NAME[c.type]}
          {c.type === 'mcp' && <span className="text-fg-3">{c.options.preset === 'custom' ? ', custom tools' : ', knowledge graph'}</span>}
        </KV>
        <KV k="Where" keyWidth={104}>
          <span className="mono break-all">{whereOf(c) || 'not set'}</span>
          {placeOf(c) && <span className="text-fg-3">, {placeOf(c)}</span>}
        </KV>
        <KV k="Mode" keyWidth={104}>
          {MODE[c.mode].words}
          <span className="text-fg-3"> ({c.mode})</span>
        </KV>
        <KV k="Live search" keyWidth={104}>
          {c.search ? `On every recall, waits up to ${msWords(c.timeoutMs)}` : 'Off. Sessions use the imported notes.'}
        </KV>
        <KV k="Can" keyWidth={104}>
          {capabilityWords(c.capabilities)}
        </KV>
        <KV k="Last sync" keyWidth={104}>
          {last ? (
            last.error ? (
              <span>
                <span className="text-fault">Failed</span> {agoWords(last.at, now)}. <span className="text-fg-2">{syncError(last.error)}</span> {hintFor(last.error) ?? ''}
              </span>
            ) : (
              <span>
                {agoWords(last.at, now)}: {syncWords(last)}
              </span>
            )
          ) : c.capabilities.pull ? (
            'Never'
          ) : (
            <span className="text-fg-2">This store cannot list its notes, so there is nothing to import. Live search still works.</span>
          )}
        </KV>
        <KV k="Imported" keyWidth={104}>
          {c.status.imported ? `${c.status.imported} ${c.status.imported === 1 ? 'note' : 'notes'}, refreshed by each sync` : 'None'}
        </KV>
        {c.status.failures > 0 && (
          <KV k="Failures" keyWidth={104}>
            {c.status.failures} in a row{c.status.lastErrorAt ? `, last ${agoWords(c.status.lastErrorAt, now)}` : ''}
            {c.status.lastOkAt ? `. Last worked ${agoWords(c.status.lastOkAt, now)}.` : '.'}
          </KV>
        )}
        {c.legacy && (
          <KV k="Note" keyWidth={104}>
            <span className="text-fg-2">From the old memory.external setting. Editing it moves it to the connections list.</span>
          </KV>
        )}
      </dl>

      <div className="mt-3 flex items-center justify-between gap-4 border-t border-rule pt-3">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-fg phone:text-[15px]">Use this connection</p>
          <p className="mt-0.5 text-[12px] text-fg-3 phone:text-[13px]">{c.enabled ? 'Searched and written to by mode.' : 'Off. Nothing is searched or written. Imported notes stay.'}</p>
        </div>
        <OnOff label={`Use ${c.name}`} size={mobile ? 'touch' : 'sm'} checked={c.enabled} disabled={toggling} onChange={(v) => void setEnabled(v)} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        <Button variant="outline" size={size} busy={test.state === 'running' ? 'Testing' : false} onClick={() => void runTest()}>
          Test
        </Button>
        {c.capabilities.pull && (
          <Button variant="outline" size={size} busy={sync.state === 'running' ? 'Syncing' : false} disabled={!c.enabled} title={c.enabled ? undefined : 'Turn the connection on to sync.'} onClick={() => void runSync()}>
            Sync now
          </Button>
        )}
        {!mobile &&
          more.map((a, i) => (
            <span key={a.label} className="contents">
              {i === more.length - (c.status.imported > 0 ? 2 : 1) && <span className="flex-1" />}
              <Button variant={a.danger ? 'danger' : 'quiet'} size={size} onClick={a.onClick}>
                {a.label}
              </Button>
            </span>
          ))}
      </div>
      {!c.enabled && c.capabilities.pull && <p className="mt-2 text-[12px] text-fg-3 phone:text-[13px]">Turn the connection on to sync.</p>}

      {test.state === 'running' && <Working className="mt-3" word="Testing" since={test.since} detail={slow ? 'The first start downloads the server. It can take a minute.' : whereOf(c)} />}
      {test.state === 'done' && <TestSteps className="mt-3" result={test.result} />}
      {test.state === 'failed' && (
        <p className="mt-3 text-[13px] text-fg-2 phone:text-[14px]">
          <span className="text-fault">Failed.</span> {test.error}
        </p>
      )}

      {sync.state === 'running' && <Working className="mt-3" word="Syncing" since={sync.since} detail={`Reading every note in ${c.name}`} />}
      {sync.state === 'done' && (
        <p className="mt-3 text-[13px] text-fg-2 phone:text-[14px]">
          <span className="text-ok">Synced.</span> {syncWords(sync.result)}, {sync.result.total} in {c.name}.
        </p>
      )}
      {sync.state === 'failed' && (
        <p className="mt-3 max-w-[68ch] text-[13px] text-fg-2 phone:text-[14px]">
          <span className="text-fault">Sync failed.</span> {syncError(sync.error)} {hintFor(sync.error) ?? ''}
        </p>
      )}

      {mobile && (
        <div className="mt-4 border-t border-rule">
          {more.map((a) => (
            <button key={a.label} type="button" onClick={a.onClick} className={cn('flex min-h-11 w-full items-center border-b border-rule text-left text-[15px]', a.danger ? 'text-fault' : 'text-fg')}>
              {a.label}
            </button>
          ))}
        </div>
      )}

      <Confirm
        open={clearing}
        onClose={() => setClearing(false)}
        title={`Clear the ${c.status.imported} notes imported from ${c.name}?`}
        body="The connection stays. Sessions stop seeing these notes until the next sync brings them back."
        confirm="Clear notes"
        busy="Clearing"
        onConfirm={async () => {
          try {
            const r = await api().clearImportedMemory(c.id);
            toast({ title: `Cleared ${r.removed} ${r.removed === 1 ? 'note' : 'notes'} from ${c.name}.` });
            setSync({ state: 'idle' });
          } catch (e) {
            toast({ title: `Could not clear the notes. ${errMsg(e)}`, level: 'error' });
          }
          void reloadConnections();
        }}
      />

      <Confirm
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Remove ${c.name}?`}
        confirm="Remove"
        busy="Removing"
        onConfirm={async () => {
          try {
            await api().removeMemoryConnection(c.id, keep);
            dropConnection(c.id);
            toast({ title: keep && c.status.imported ? `Removed ${c.name}. Its notes stay in Conclave.` : `Removed ${c.name}.` });
          } catch (e) {
            toast({ title: `Could not remove ${c.name}. ${errMsg(e)}`, level: 'error' });
          }
          void reloadConnections();
        }}
      >
        <p>Conclave stops searching it and stops saving to it. Nothing in the store itself is deleted.</p>
        {c.status.imported > 0 && (
          <div className="mt-4">
            <Radio name={`rm-${c.id}`} checked={!keep} onChange={() => setKeep(false)} label={`Remove its ${c.status.imported} imported notes too`} description="They came from this store and stay there." className="phone:py-2" />
            <Radio name={`rm-${c.id}`} checked={keep} onChange={() => setKeep(true)} label="Keep the imported notes in Conclave" description="They stay in Conclave as they are. No sync updates them again." className="mt-1 phone:py-2" />
          </div>
        )}
      </Confirm>
    </div>
  );
}
