/**
 * Watch data for the Routines page and a watch's page. Fetched from the hub
 * and fetched again when one of its runs ends (routine.run events update
 * the store's runs; a run that ended changes the key below).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Routine, RoutineRun } from '@conclave/core/types';
import type { WatchDetailDto, WatchSummaryDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useHub } from '@/store/store';

export function isWatchRoutine(r: Pick<Routine, 'watch'> | undefined): boolean {
  return !!r?.watch?.url;
}

/** Ids of the runs that ended, so a new end refetches. */
function endedKey(runs: RoutineRun[] | undefined): string {
  return (runs ?? [])
    .filter((r) => r.status !== 'running')
    .map((r) => r.id)
    .sort()
    .join(',');
}

/** Every watch's row data, by routine id. Undefined until the hub answered. */
export function useWatchSummaries(ids: string[]): Record<string, WatchSummaryDto> | undefined {
  const runs = useHub((s) => s.runs);
  const key = useMemo(() => ids.map((id) => `${id}:${endedKey(runs[id])}`).join('|'), [ids, runs]);
  const [data, setData] = useState<Record<string, WatchSummaryDto>>();
  useEffect(() => {
    if (!ids.length) return setData({});
    let live = true;
    api()
      .watches()
      .then((list) => live && setData(Object.fromEntries(list.map((w) => [w.routineId, w]))))
      .catch(() => live && setData((d) => d ?? {}));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return data;
}

/** One watch's page data. */
export function useWatch(id: string): { data?: WatchDetailDto; error?: string; reload: () => void } {
  const runs = useHub((s) => s.runs[id]);
  const routine = useHub((s) => s.routines[id]);
  const [data, setData] = useState<WatchDetailDto>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  const key = `${endedKey(runs)}|${JSON.stringify(routine?.watch ?? null)}|${n}`;
  useEffect(() => {
    let live = true;
    api()
      .watch(id)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(undefined);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key]);
  return { data, error, reload };
}
