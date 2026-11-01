/**
 * What keeps maps calls cheap and polite: a small cache with expiry, the
 * per-hub daily cap kept in kv, and a gate that spaces calls to a server
 * (Nominatim asks for at most one a second) and limits how many run at once.
 */
import { addDays } from '../assistant/time';
import type { MapsApi } from './types';
import { MapsError } from './types';

/** A map with expiry and a size limit; the oldest entry goes first. */
export class TtlCache<V> {
  private items = new Map<string, { at: number; ttl: number; value: V; size: number }>();
  private bytes = 0;

  constructor(
    private max: number,
    private maxBytes = Infinity,
    private now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > hit.ttl) {
      this.drop(key);
      return undefined;
    }
    // used again: it moves to the young end
    this.items.delete(key);
    this.items.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number, size = 0): void {
    this.drop(key);
    this.items.set(key, { at: this.now(), ttl: ttlMs, value, size });
    this.bytes += size;
    while (this.items.size > this.max || this.bytes > this.maxBytes) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
    this.bytes = 0;
  }

  private drop(key: string): void {
    const hit = this.items.get(key);
    if (!hit) return;
    this.bytes -= hit.size;
    this.items.delete(key);
  }
}

export interface UsageDay {
  date: string;
  calls: number;
  byApi: Partial<Record<MapsApi, number>>;
}

interface KvLike {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(prefix: string): string[];
}

const USAGE_PREFIX = 'maps.usage.';
/** Days of counts kept, today's included. */
const USAGE_DAYS = 7;

/** Calls per local day across the hub. take() throws when the cap is reached; cache hits never call it. */
export class DailyCap {
  constructor(
    private kv: KvLike,
    private cap: () => number,
    private today: () => string,
  ) {}

  usage(): UsageDay {
    const date = this.today();
    return this.kv.get<UsageDay>(USAGE_PREFIX + date, { date, calls: 0, byApi: {} });
  }

  /** Count one call to `api`, or refuse it with plain words when the day's cap is used up. */
  take(api: MapsApi): void {
    const u = this.usage();
    const cap = this.cap();
    if (u.calls >= cap) throw new MapsError('cap', `The daily maps limit of ${cap} calls is used up. It starts again at midnight. Raise it in Settings, Maps.`, 429);
    const first = u.calls === 0;
    u.calls++;
    u.byApi[api] = (u.byApi[api] ?? 0) + 1;
    this.kv.set(USAGE_PREFIX + u.date, u);
    // one key per day: the day's first call drops every one older than a week, not just the one a week back,
    // which a day with calls and none a week later would leave for good
    if (first) {
      const oldest = addDays(u.date, -(USAGE_DAYS - 1));
      for (const key of this.kv.keys(USAGE_PREFIX)) {
        const day = key.slice(USAGE_PREFIX.length);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < oldest) this.kv.delete(key);
      }
    }
  }
}

/**
 * Spaces calls to one server and limits how many run at once. Calls go out
 * in the order they came; each starts at least `spacingMs` after the last
 * one started.
 */
export class Gate {
  private running = 0;
  private queue: Array<() => void> = [];
  private lastStart = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private spacingMs: number,
    private concurrency = 1,
    private now: () => number = Date.now,
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.running++;
        this.lastStart = this.now();
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.pump();
          });
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer || !this.queue.length || this.running >= this.concurrency) return;
    const wait = this.lastStart + this.spacingMs - this.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, wait);
      return;
    }
    this.queue.shift()!();
    this.pump();
  }
}
