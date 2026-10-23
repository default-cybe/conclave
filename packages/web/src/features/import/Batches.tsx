/**
 * Recent imports (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.10): one row
 * per batch with its state word, counts and cost; the live one shows its
 * progress, with Pause, Resume and Cancel; finished ones offer Undo for 30
 * days. Above them, "Learn from N imported chats not learned yet".
 */
import { useEffect, useRef, useState } from 'react';
import type { ImportBatch, ImportBatchItem } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { relTime } from '@/lib/format';
import { cn } from '@/lib/text';
import { toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { StateWord } from '@/components/ui/List';
import { KnotRope, LiveStatus, Roll } from '@/components/motion';
import { isLive, loadBatches, upsertBatch, useImport } from './store';
import { batchCounts, batchProgress, batchState, batchTitle, droppedWords } from './words';
import { useDeviceNames } from './PastChats';
import { errText } from '@/features/settings/parts';

export function NotLearnedLine({ className }: { className?: string }) {
  const notLearned = useImport((s) => s.notLearned);
  const live = useImport((s) => s.batches.some((b) => isLive(b) && b.mode === 'learn'));
  const mobile = useIsMobile();
  const [busy, setBusy] = useState(false);
  if (!notLearned || live) return null;
  const learn = async () => {
    setBusy(true);
    try {
      const b = await api().startImport({ device: 'local', notLearned: true, mode: 'learn' });
      upsertBatch(b);
      toast({ title: `Learning from ${b.total} imported chats.`, body: 'It keeps going when you leave this page.', level: 'success' });
      void loadBatches(true);
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn('flex gap-x-4 gap-y-2', mobile ? 'flex-col items-stretch' : 'items-center', className)}>
      <p className="m-0 min-w-0 flex-1 text-[13px] text-fg-2 phone:text-[14px]">
        <span className="num">{notLearned}</span> imported {notLearned === 1 ? 'chat is' : 'chats are'} not learned from yet.
      </p>
      <Button variant="outline" size={mobile ? 'touch' : 'sm'} onClick={() => void learn()} busy={busy ? 'Starting' : false} full={mobile}>
        Learn from {notLearned} {notLearned === 1 ? 'chat' : 'chats'}
      </Button>
    </div>
  );
}

export function Batches({ limit = 6, title = 'Recent imports' }: { limit?: number; title?: string }) {
  const batches = useImport((s) => s.batches);
  const loaded = useImport((s) => s.loaded);
  const [all, setAll] = useState(false);

  useEffect(() => {
    void loadBatches();
  }, []);

  if (!loaded || !batches.length) return null;
  const shown = all ? batches : batches.slice(0, limit);
  return (
    <section aria-label={title}>
      <SectionHeading count={batches.length} right={batches.length > limit ? <TextAction label={all ? 'Fewer' : 'All'} onClick={() => setAll(!all)} /> : undefined}>
        {title}
      </SectionHeading>
      <div className="rows">
        {shown.map((b) => (
          <BatchRow key={b.id} batch={b} />
        ))}
      </div>
    </section>
  );
}

/** Why chats failed: each one's title and the hub's reason, read from the batch on demand. */
function FailedWhy({ batchId, count }: { batchId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ImportBatchItem[]>();
  const show = async () => {
    setOpen(!open);
    if (items || open) return;
    try {
      const out: ImportBatchItem[] = [];
      let cursor: string | undefined;
      // a few pages at most: the reasons are what the owner wants, not every row
      for (let page = 0; page < 5; page++) {
        const d = await api().importBatch(batchId, cursor);
        out.push(...d.items.filter((i) => i.state === 'failed' || i.reason?.startsWith('not learned')));
        if (!d.next) break;
        cursor = d.next;
      }
      setItems(out);
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
      setOpen(false);
    }
  };
  return (
    <div className="mt-1">
      <TextAction label={open ? 'Hide why' : `Why ${count === 1 ? 'it' : `${count}`} failed`} onClick={() => void show()} />
      {open && items && (
        <ul className="mt-1.5 space-y-1 text-[12px] leading-[1.5] phone:text-[13px]">
          {items.length === 0 && <li className="text-fg-3">The hub kept no reason for these.</li>}
          {items.map((i) => (
            <li key={i.key} className="min-w-0">
              <span className="text-fg-2">{i.title || i.key}</span>
              <span className="text-fault">: {i.reason ?? 'no reason given'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BatchRow({ batch: b }: { batch: ImportBatch }) {
  const names = useDeviceNames();
  const mobile = useIsMobile();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string>();
  const st = batchState(b);
  const live = isLive(b) && b.status !== 'waiting_reset';
  const p = batchProgress(b);
  const counts = batchCounts(b);
  const dropped = droppedWords(b.dropped);
  const canUndo = b.status !== 'undone' && !live && (b.undoUntil ?? 0) > Date.now() && (b.imported + b.forked + b.updated + b.memoriesAdded + b.memoriesReview + b.memoriesMerged > 0 || b.status === 'failed' || b.status === 'cancelled');
  // an import that finishes while you watch: the knot plays success where it ran
  const [finished, setFinished] = useState(false);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live && b.status === 'done') setFinished(true);
    wasLive.current = live;
  }, [live, b.status]);

  const act = async (verb: string, run: () => Promise<ImportBatch | unknown>, done?: string) => {
    setBusy(verb);
    try {
      const r = await run();
      if (r && typeof r === 'object' && 'status' in (r as ImportBatch)) upsertBatch(r as ImportBatch);
      else void loadBatches(true);
      if (done) toast({ title: done, level: 'success' });
    } catch (e) {
      toast({ title: errText(e), level: 'error' });
    } finally {
      setBusy(undefined);
    }
  };

  const undo = () =>
    act('Undoing', async () => {
      const r = await api().undoImport(b.id);
      setConfirm(false);
      await loadBatches(true);
      const keptSessions = r.keptSessions?.length ? ` ${r.keptSessions.length === 1 ? '1 session you kept going in was' : `${r.keptSessions.length} sessions you kept going in were`} kept.` : '';
      const kept = `${r.kept.length ? ` ${r.kept.length} memories you edited since were kept.` : ''}${keptSessions}`;
      toast({ title: `Undid the import: ${r.sessionsRemoved} sessions, ${r.messagesRemoved} messages and ${r.memoriesRemoved} memories removed.${kept}`, level: 'success' });
      return r;
    });

  return (
    <div className="py-3">
      <div className={cn('grid gap-x-4', mobile ? 'grid-cols-[minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)_auto]')}>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-fg phone:text-[15px]">{batchTitle(b, names)}</div>
          <div className="text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">
            {counts.length ? counts.join(', ') : 'Nothing done yet'}
            {mobile && (
              <>
                , <StateWord tone={st.tone}>{st.word}</StateWord>
              </>
            )}
          </div>
          {dropped && b.mode !== 'chats' && <div className="text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Left out: {dropped}.</div>}
          {b.error && <div className="text-[12px] leading-[1.5] text-fault phone:text-[13px]">{b.error}</div>}
          {b.failed > 0 && !live && <FailedWhy batchId={b.id} count={b.failed} />}
        </div>
        {!mobile && (
          <div className="text-right">
            <div className="num text-[12px] text-fg-3">{relTime(b.updatedAt)}</div>
            <StateWord tone={st.tone} className="text-[12px]">
              {st.word}
            </StateWord>
          </div>
        )}
      </div>
      {finished && (
        <div className="mt-2 flex items-center gap-2 text-[12.5px] font-medium text-ok phone:text-[13.5px]">
          <KnotRope moment="success" size={16} onDone={() => setTimeout(() => setFinished(false), 1200)} />
          Finished
        </div>
      )}
      {(live || b.status === 'waiting_reset' || b.status === 'paused' || canUndo || b.status === 'failed') && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          {live && <LiveStatus state="tool" label={p.verb} detail={<Roll value={`${p.done} of ${p.total}`} />} startedAt={b.createdAt} />}
          {b.status === 'waiting_reset' && b.resumeAt && <LiveStatus state="resuming" resumeAt={b.resumeAt} detail="the model's limit" />}
          {live && <TextAction label={busy === 'Pausing' ? 'Pausing' : 'Pause'} onClick={() => void act('Pausing', () => api().pauseImport(b.id))} />}
          {(b.status === 'paused' || b.status === 'failed' || b.status === 'waiting_reset') && <TextAction label={busy === 'Resuming' ? 'Resuming' : 'Resume'} onClick={() => void act('Resuming', () => api().resumeImport(b.id))} />}
          {(live || b.status === 'paused' || b.status === 'waiting_reset') && <TextAction label={busy === 'Cancelling' ? 'Cancelling' : 'Cancel'} onClick={() => void act('Cancelling', () => api().cancelImport(b.id), 'Cancelled. What was done is kept.')} />}
          {canUndo && <TextAction label="Undo this import" onClick={() => setConfirm(true)} />}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void undo()}
        title="Undo this import?"
        body={`It deletes the ${b.imported + b.forked} sessions it made, the messages it added and the ${b.memoriesAdded + b.memoriesReview} memories it learned. Memories you edited since are kept.`}
        confirm="Undo"
        busy={busy === 'Undoing' ? 'Undoing' : undefined}
        tone="danger"
      />
    </div>
  );
}
