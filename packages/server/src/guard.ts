/**
 * Failed attempts per client address, with a block that doubles each time it
 * is hit again (60s, 2 min, 4 min, up to an hour). Used for wrong tokens and
 * wrong pairing codes, which matter once the hub has a public address.
 *
 * Only guesses count. A failure carries a mark (a hash of the token or the
 * code it tried): the same wrong token sent again, as an app with an old
 * token does on every reconnect, counts once per window, so it cannot lock
 * out the rest of a home that shares one public address. Someone guessing
 * has to try a new value each time, and each one counts.
 */
export interface GuardOptions {
  /** The failure inside the window that starts a block (20: the 20th wrong token). */
  limit: number;
  windowMs: number;
  /** First block. Each new block doubles it. */
  blockMs: number;
  maxBlockMs: number;
}

interface Entry {
  /** Time of each counted failure, by mark. */
  failures: Map<string, number>;
  blockedUntil: number;
  strikes: number;
  lastBlockAt: number;
}

export class FailureGuard {
  private entries = new Map<string, Entry>();
  private seq = 0;

  constructor(readonly opts: GuardOptions) {}

  /** Seconds until this key may try again, 0 when it is not blocked. */
  blocked(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e || e.blockedUntil <= now) return 0;
    return Math.max(1, Math.ceil((e.blockedUntil - now) / 1000));
  }

  /**
   * Count a failure. `mark` names what was tried; a mark already counted in
   * the window is not counted again. Without a mark every failure counts.
   * Returns the block length in seconds when this failure starts a block, else 0.
   */
  fail(key: string, now = Date.now(), mark?: string): number {
    let e = this.entries.get(key);
    if (!e) {
      e = { failures: new Map(), blockedUntil: 0, strikes: 0, lastBlockAt: 0 };
      this.entries.set(key, e);
      if (this.entries.size > 10_000) this.prune(now);
    }
    // a quiet day forgives earlier blocks
    if (e.strikes && now - e.lastBlockAt > Math.max(this.opts.maxBlockMs * 2, 24 * 3_600_000)) e.strikes = 0;
    this.expire(e, now);
    const id = mark ?? `#${++this.seq}`;
    if (e.failures.has(id)) return 0;
    e.failures.set(id, now);
    if (e.failures.size < this.opts.limit) return 0;
    const ms = Math.min(this.opts.maxBlockMs, this.opts.blockMs * 2 ** e.strikes);
    e.strikes++;
    e.lastBlockAt = now;
    e.blockedUntil = now + ms;
    e.failures.clear();
    return Math.ceil(ms / 1000);
  }

  /** Failures counted in the current window. */
  failures(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    this.expire(e, now);
    return e.failures.size;
  }

  private expire(e: Entry, now: number): void {
    for (const [m, t] of e.failures) if (t <= now - this.opts.windowMs) e.failures.delete(m);
  }

  private prune(now: number): void {
    for (const [k, e] of this.entries) {
      this.expire(e, now);
      if (e.blockedUntil <= now && !e.failures.size) this.entries.delete(k);
    }
  }
}
