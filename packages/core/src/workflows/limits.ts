/**
 * Caps on calls in flight (docs/WORKFLOWS.md, "Budgets and concurrency"):
 * per run (workflows.concurrency, default 8, at most 16), per provider
 * (default 6) and across the hub (default 16). Live worktrees are capped per
 * device (8). Every cap that makes a call wait is logged once by the caller.
 */

export class Semaphore {
  private active = 0;
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(private limit: number) {}

  setLimit(n: number): void {
    this.limit = Math.max(1, n);
    this.drain();
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** True when acquire() would wait. */
  get full(): boolean {
    return this.active >= this.limit;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const w = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.releaser());
        },
        reject,
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(w);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length) {
      this.active++;
      this.waiters.shift()!.resolve();
    }
  }
}

/** Named semaphores made on first use (per provider, per device). */
export class SemaphoreMap {
  private map = new Map<string, Semaphore>();
  constructor(private limit: () => number) {}

  get(key: string): Semaphore {
    let s = this.map.get(key);
    if (!s) {
      s = new Semaphore(this.limit());
      this.map.set(key, s);
    } else s.setLimit(this.limit());
    return s;
  }
}

export const DEFAULTS = {
  concurrency: 8,
  maxConcurrency: 16,
  perProvider: 6,
  hubMax: 16,
  autoApproveTokens: 2_000_000,
  maxAgents: 1000,
  worktreesPerDevice: 8,
  sleepMaxMs: 5 * 60_000,
  logLines: 2000,
  resultChars: 12_000,
  /**
   * Host calls other than agent() (timers, lib calls) per run. Waiting on the
   * host costs no CPU, so without this cap a loop like
   * `for (;;) await lib.dropDismissed([])` would run for hours.
   */
  hostCalls: 10_000,
  /** lib.exec and lib.runCheck calls per run: each starts a process and is journaled. */
  checks: 1000,
  /** Findings recorded per run. */
  findings: 1000,
  /** Phases per run: meta.phases plus titles phase() adds. */
  phases: 64,
};

/** Per-run caps a test may lower (WorkflowService.caps). */
export type RunCaps = Partial<Pick<typeof DEFAULTS, 'hostCalls' | 'checks' | 'findings' | 'phases'>>;

/** Parse a "+500k" or "+2m" budget word from the owner's message. */
export function budgetWord(text: string): number | undefined {
  const m = /(?:^|\s)\+(\d+(?:\.\d+)?)\s*([km])\b/i.exec(text);
  if (!m) return undefined;
  const n = parseFloat(m[1]) * (m[2].toLowerCase() === 'm' ? 1_000_000 : 1000);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** "1 agent", "3 agents": a count with its noun. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
