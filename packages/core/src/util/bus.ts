import type { EngineEvent, EngineEventEnvelope } from '../types';
import { logger } from './log';

const log = logger('bus');

type Listener = (e: EngineEventEnvelope) => void;

/** Whose an event is: an account id, '*' for every account, undefined for the owner only (people/events.ts). */
export type AccountResolver = (e: EngineEvent) => string | undefined;

/**
 * In-process event bus. Every engine event goes through here and the server
 * fans it out over WebSocket. A small ring buffer lets reconnecting clients
 * catch up with `since(seq)` instead of refetching everything.
 */
export class EventBus {
  private listeners = new Set<Listener>();
  private seq = 0;
  private ring: EngineEventEnvelope[] = [];
  private readonly ringSize: number;
  private resolver?: AccountResolver;

  constructor(ringSize = 2000) {
    this.ringSize = ringSize;
  }

  /** Stamp each event with its account (docs/design/ACCOUNTS.md 4), so the server sends it only to that account. */
  setAccountResolver(fn: AccountResolver | undefined): void {
    this.resolver = fn;
  }

  emit(event: EngineEvent): EngineEventEnvelope {
    let account: string | undefined;
    try {
      account = this.resolver?.(event);
    } catch {
      account = undefined;
    }
    const env = { ...event, seq: ++this.seq, ts: Date.now(), ...(account ? { account } : {}) } as EngineEventEnvelope;
    // deltas are high volume and only useful live, keep them out of the replay buffer
    if (event.type !== 'message.delta' && event.type !== 'tool.progress' && event.type !== 'workflow.progress' && event.type !== 'map.delta') {
      this.ring.push(env);
      if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    }
    for (const l of this.listeners) {
      try {
        l(env);
      } catch (err) {
        // with its stack in the log files: a listener that throws is a bug (the Map, alerts, a route's watcher)
        log.error(`listener failed on ${event.type}`, err);
      }
    }
    return env;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Wait for the first event matching a predicate. */
  once<T extends EngineEvent['type']>(
    type: T,
    pred: (e: Extract<EngineEventEnvelope, { type: T }>) => boolean = () => true,
    timeoutMs?: number,
  ): Promise<Extract<EngineEventEnvelope, { type: T }>> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.on((e) => {
        if (e.type === type && pred(e as Extract<EngineEventEnvelope, { type: T }>)) {
          off();
          if (timer) clearTimeout(timer);
          resolve(e as Extract<EngineEventEnvelope, { type: T }>);
        }
      });
      if (timeoutMs) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`timeout waiting for ${type}`));
        }, timeoutMs);
      }
    });
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** Events after `seq`. Returns null when the buffer no longer reaches back that far. */
  since(seq: number): EngineEventEnvelope[] | null {
    if (seq >= this.seq) return [];
    const first = this.ring[0];
    if (!first || first.seq > seq + 1) return null;
    return this.ring.filter((e) => e.seq > seq);
  }
}
