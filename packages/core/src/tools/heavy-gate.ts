/**
 * A FIFO gate for whole test suites and builds on the hub's own machine
 * (tools/bash.ts). Two agents running `bun run test` at once on a 2-core hub
 * starve each other and the hub's event loop; one at a time finishes both
 * sooner. Paired devices are never gated. Background shells take a slot
 * while they run but never wait for one.
 */

/** Default slots: server.heavyCommands in the config. 0 turns the gate off. */
export const HEAVY_COMMANDS_DEFAULT = 1;

export const HEAVY_WAIT_NOTE = 'Waiting for another test run or build on the hub to finish.';

// split a command line into simple commands; quotes are not parsed, which only errs toward gating less
const SEGMENT_SPLIT = /&&|\|\||[;|\n&]/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/** Arguments that name what to run (paths, filters), as opposed to flags and plain numbers such as a timeout or a 1/4 shard. */
function namesTargets(args: string[]): boolean {
  return args.some((a) => !a.startsWith('-') && !/^\d+(\/\d+)?$/.test(a));
}

function heavySegment(seg: string): boolean {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  while (words.length && (ENV_ASSIGN.test(words[0]) || words[0] === 'time' || words[0] === 'exec')) words.shift();
  const [cmd, a1, ...rest] = words;
  if (cmd === 'bun' && a1 === 'test') return !namesTargets(rest);
  if (cmd === 'bun' && a1 === 'run' && rest[0] === 'test') return !namesTargets(rest.slice(1));
  if (cmd === 'cargo') return a1 === 'build' || a1 === 'test';
  return cmd === './gradlew' || cmd === 'gradlew' || cmd === 'gradle';
}

/** A whole test suite or a build: `bun test` or `bun run test` with no paths, `cargo build`, `cargo test`, `./gradlew`. */
export function isHeavyCommand(command: unknown): boolean {
  return typeof command === 'string' && command.split(SEGMENT_SPLIT).some(heavySegment);
}

export class HeavyGate {
  private active = 0;
  private limit = HEAVY_COMMANDS_DEFAULT;
  private waiters: Array<() => void> = [];

  get waiting(): number {
    return this.waiters.length;
  }

  /** Take a slot at once, even past the limit: a background shell is counted while it runs, never made to wait. */
  hold(): () => void {
    this.active++;
    return this.releaser();
  }

  /**
   * Wait for a slot (FIFO) and return its release; call it in a finally.
   * onWait runs once when the call has to wait. An abort while waiting leaves
   * the queue and rejects; it never holds a slot.
   */
  async acquire(limit: number, signal?: AbortSignal, onWait?: () => void): Promise<() => void> {
    if (limit <= 0) return () => undefined;
    if (signal?.aborted) throw new Error('aborted');
    this.limit = limit;
    if (this.active < limit && !this.waiters.length) {
      this.active++;
      return this.releaser();
    }
    onWait?.();
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i === -1) return; // already granted: the caller holds the slot and releases it
        this.waiters.splice(i, 1);
        reject(new Error('aborted'));
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      while (this.waiters.length && this.active < this.limit) this.waiters.shift()!();
    };
  }
}

/** The hub process's one gate. */
export const heavyGate = new HeavyGate();
