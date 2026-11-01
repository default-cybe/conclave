/**
 * The Map's data: the snapshot, moved on by map.delta events while it is
 * live, or a replay at an earlier time. Loads again when the connection
 * comes back, since deltas missed while it was down are not replayed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapSnapshot } from '@conclave/core/client';
import { api } from '@/lib/api';
import { onHubEvent, useHub, watchMap } from '@/store/store';
import { applyDelta } from './model';
import type { StreamMode } from './streams';

export interface MapData {
  snap?: MapSnapshot;
  /** The time a replay shows; undefined while live. */
  replay?: number;
  setReplay: (at: number | undefined) => void;
  loading: boolean;
  error?: string;
  reload: () => void;
}

const tz = () => new Date().getTimezoneOffset();

export function useMapData(): MapData {
  const [live, setLive] = useState<MapSnapshot>();
  const [past, setPast] = useState<MapSnapshot>();
  const [replay, setReplayAt] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const conn = useHub((s) => s.conn);
  const replayRef = useRef<number | undefined>(undefined);
  const asked = useRef(0);

  const load = useCallback(async () => {
    const ask = ++asked.current;
    try {
      const snap = await api().map({ tz: tz() });
      if (ask !== asked.current) return;
      setLive(snap);
      setError(undefined);
    } catch (err) {
      if (ask === asked.current) setError((err as Error).message);
    } finally {
      if (ask === asked.current) setLoading(false);
    }
  }, []);

  // live: the snapshot, then deltas while this page is open
  useEffect(() => {
    void load();
    const stop = watchMap();
    const off = onHubEvent((e) => {
      // a stuck turn or a file conflict came or went: the snapshot carries them, deltas do not
      if (e.type === 'alert.raised' || e.type === 'alert.cleared') {
        if (replayRef.current === undefined) void load();
        return;
      }
      if (e.type !== 'map.delta') return;
      setLive((s) => (s ? applyDelta(s, e.delta) : s));
    });
    return () => {
      off();
      stop();
    };
  }, [load]);

  // back online: what moved while the socket was down is not replayed, so load again
  const wasOpen = useRef(conn === 'open');
  useEffect(() => {
    if (conn === 'open' && !wasOpen.current && replayRef.current === undefined) void load();
    wasOpen.current = conn === 'open';
  }, [conn, load]);

  const pastAsk = useRef(0);
  const setReplay = useCallback(
    (at: number | undefined) => {
      replayRef.current = at;
      setReplayAt(at);
      if (at === undefined) {
        setPast(undefined);
        void load();
        return;
      }
      const ask = ++pastAsk.current;
      api()
        .map({ at: Math.round(at), tz: tz() })
        .then((snap) => {
          if (ask === pastAsk.current && replayRef.current !== undefined) setPast(snap);
        })
        .catch((err) => setError((err as Error).message));
    },
    [load],
  );

  return { snap: replay !== undefined ? (past ?? live) : live, replay, setReplay, loading, error, reload: () => void load() };
}

const MODE_KEY = 'conclave.map.streams';

/** The Streams switch, remembered on this device. */
export function useStreamMode(): [StreamMode, (m: StreamMode) => void] {
  const [mode, setMode] = useState<StreamMode>(() => {
    try {
      const v = localStorage.getItem(MODE_KEY);
      return v === 'quiet' || v === 'lines' ? v : 'full';
    } catch {
      return 'full';
    }
  });
  const set = useCallback((m: StreamMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode */
    }
  }, []);
  return [mode, set];
}
