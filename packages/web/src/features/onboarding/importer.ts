/**
 * The onboarding view of a chat import. The batch runs on the hub as a job
 * (import.run), so it keeps going when the owner moves on and the steps show
 * its progress again when they come back. This reads the shared import store
 * (features/import/store.ts), fed by import.batch events.
 */
import { useEffect } from 'react';
import { isLive, loadBatches, useImport } from '@/features/import/store';
import { batchProgress } from '@/features/import/words';

export interface ImportJob {
  total: number;
  done: number;
  failed: number;
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

/** The newest import batch as a job line: running, done of total, failed. */
export function useImportJob(): ImportJob {
  const batch = useImport((s) => s.batches.find(isLive) ?? s.batches[0]);
  useEffect(() => {
    void loadBatches();
  }, []);
  if (!batch) return { total: 0, done: 0, failed: 0, running: false };
  const p = batchProgress(batch);
  const running = isLive(batch);
  return {
    total: p.total,
    done: running ? p.done : batch.imported + batch.updated + batch.forked + (batch.mode === 'learn' ? batch.learnedSessions : 0),
    failed: batch.failed,
    running,
    startedAt: batch.createdAt,
    ...(batch.finishedAt ? { finishedAt: batch.finishedAt } : {}),
    ...(batch.error ? { error: batch.error } : {}),
  };
}
