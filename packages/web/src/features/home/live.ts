/**
 * Live output rate, measured from the text that streams into the store.
 *
 * The hub sends message.delta events for every running turn. We watch the
 * streaming messages grow and turn characters into tokens (about 4 per token),
 * so Home can show "38 t/s" per running session without waiting for usage
 * records, which only land when a turn ends.
 */
import { useSyncExternalStore } from 'react';
import type { Message } from '@conclave/core/types';
import { useHub } from '@/store/store';

const CHARS_PER_TOKEN = 4;
/** Rate window. Long enough to smooth bursty deltas, short enough to fall to 0 soon after a turn. */
const WINDOW_MS = 5000;

export interface LiveRates {
  /** Tokens per second per session id, only sessions with recent output. */
  bySession: Record<string, number>;
  /** Sum over sessions. */
  total: number;
  /** Tokens counted per minute (minute start epoch ms), for the scope. */
  minutes: Record<number, number>;
}

const EMPTY: LiveRates = { bySession: {}, total: 0, minutes: {} };

const lengths = new Map<string, number>();
let samples: Array<{ t: number; sid: string; tokens: number }> = [];
const minutes: Record<number, number> = {};
const ema: Record<string, number> = {};
let snapshot: LiveRates = EMPTY;
const subs = new Set<() => void>();
let unsubStore: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function textLength(m: Message): number {
  let n = 0;
  for (const b of m.content) {
    if (b.type === 'text') n += b.text.length;
    else if (b.type === 'thinking') n += b.thinking.length;
  }
  return n;
}

function observe() {
  unsubStore = useHub.subscribe((s, prev) => {
    if (s.messages === prev.messages) return;
    const now = Date.now();
    for (const sid of Object.keys(s.messages)) {
      const list = s.messages[sid];
      if (list === prev.messages[sid] || !list?.length) continue;
      // only the tail of a transcript streams
      for (let i = Math.max(0, list.length - 2); i < list.length; i++) {
        const m = list[i];
        if (!s.streaming[m.id]) continue;
        const len = textLength(m);
        const before = lengths.get(m.id) ?? 0;
        lengths.set(m.id, len);
        const grew = len - before;
        if (grew <= 0) continue;
        const tokens = grew / CHARS_PER_TOKEN;
        samples.push({ t: now, sid, tokens });
        const minute = Math.floor(now / 60_000) * 60_000;
        minutes[minute] = (minutes[minute] ?? 0) + tokens;
      }
    }
  });
}

function tick() {
  const now = Date.now();
  samples = samples.filter((x) => now - x.t <= WINDOW_MS);
  const raw: Record<string, number> = {};
  for (const x of samples) raw[x.sid] = (raw[x.sid] ?? 0) + x.tokens / (WINDOW_MS / 1000);
  const bySession: Record<string, number> = {};
  let total = 0;
  for (const sid of new Set([...Object.keys(raw), ...Object.keys(ema)])) {
    const next = (ema[sid] ?? raw[sid] ?? 0) * 0.5 + (raw[sid] ?? 0) * 0.5;
    if (next < 0.5 && !raw[sid]) {
      delete ema[sid];
      continue;
    }
    ema[sid] = next;
    bySession[sid] = next;
    total += next;
  }
  // forget minutes older than an hour and lengths of finished messages
  for (const k of Object.keys(minutes)) if (now - Number(k) > 61 * 60_000) delete minutes[Number(k)];
  if (lengths.size > 400) lengths.clear();
  const changed = total !== snapshot.total || Object.keys(bySession).length !== Object.keys(snapshot.bySession).length;
  if (changed || samples.length) {
    snapshot = { bySession, total, minutes: { ...minutes } };
    for (const f of subs) f();
  }
}

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!unsubStore) observe();
  if (!timer) timer = setInterval(tick, 1000);
  return () => {
    subs.delete(cb);
    if (!subs.size) {
      clearInterval(timer);
      timer = undefined;
      unsubStore?.();
      unsubStore = null;
    }
  };
}

/** Live output rates. Starts watching the store on first use. */
export function useLiveRates(): LiveRates {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}
