/**
 * Per-upstream concurrency gate with a FIFO queue and a shared cooldown.
 * After a 429 every queued request waits until the cooldown ends instead of
 * hammering the upstream again.
 */
export class UpstreamLimiter {
  private active = 0;
  private queue: Array<{ resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];
  private cooldownUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(public max = 8) {}

  /** ms left on the cooldown, 0 when none. */
  cooldownLeft(now = Date.now()): number {
    return Math.max(0, this.cooldownUntil - now);
  }

  /** Start (or extend) a cooldown. */
  cooldown(ms: number): void {
    const until = Date.now() + Math.max(0, ms);
    if (until > this.cooldownUntil) this.cooldownUntil = until;
    this.schedule();
  }

  /** Wait for a slot. Resolves to a release function that must be called exactly once. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<() => void>((resolve, reject) => {
      const entry = {
        resolve: () => resolve(this.releaser()),
        reject,
        signal,
        onAbort: undefined as undefined | (() => void),
      };
      if (signal) {
        entry.onAbort = () => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      this.pump();
    };
  }

  private pump(): void {
    if (this.cooldownLeft() > 0) {
      this.schedule();
      return;
    }
    while (this.active < this.max && this.queue.length) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      this.active++;
      next.resolve();
    }
  }

  private schedule(): void {
    if (this.timer || !this.queue.length) return;
    const wait = this.cooldownLeft();
    if (wait <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, wait);
  }
}
