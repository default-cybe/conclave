/**
 * The workflow sandbox: QuickJS compiled to WASM, inside the hub process.
 * The model writes workflow scripts, so this interpreter is the security
 * boundary (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.3):
 *
 * - no filesystem, network, process or Bun API: the context only has the
 *   standard built-ins and the host functions below;
 * - 64 MB of memory, a 512 KB stack, 60 s of CPU counted only while the
 *   interpreter runs (evalCode and executePendingJobs), so a run may wait
 *   hours on agents without being killed;
 * - host functions take and return JSON text, so no host object ever enters
 *   the sandbox.
 *
 * Async host calls return QuickJS promises; when the host side settles, the
 * deferred promise is resolved and the pending jobs run.
 */
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import releaseSync from '@jitl/quickjs-wasmfile-release-sync';
// embedded by `bun build --compile` as a file asset, so the binary needs no node_modules
import wasmPath from '@jitl/quickjs-wasmfile-release-sync/wasm' with { type: 'file' };

export const SANDBOX_LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  cpuMs: 60_000,
  resultBytes: 4 * 1024 * 1024,
};

let modulePromise: Promise<QuickJSWASMModule> | undefined;

/** The QuickJS module, loaded once per process. */
export function quickjs(): Promise<QuickJSWASMModule> {
  modulePromise ??= (async () => {
    let variant = releaseSync;
    try {
      const file = Bun.file(wasmPath);
      if (await file.exists()) {
        const bytes = await file.arrayBuffer();
        variant = newVariant(releaseSync, { wasmBinary: bytes });
      }
    } catch {
      // the package's own loader finds the wasm next to its module
    }
    return newQuickJSWASMModuleFromVariant(variant);
  })();
  return modulePromise;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly kind: 'cpu' | 'memory' | 'script' | 'result' | 'stalled' | 'aborted' = 'script',
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** A host function the script can call. Async ones return a promise in the sandbox. */
export type HostFn = (payload: unknown) => unknown | Promise<unknown>;

export interface SandboxOptions {
  /** Synchronous host calls (log, phase, budget). */
  sync: Record<string, HostFn>;
  /** Async host calls (agent, sleep, workflow, lib calls). */
  async: Record<string, HostFn>;
  limits?: Partial<typeof SANDBOX_LIMITS>;
  signal?: AbortSignal;
}

/**
 * One script evaluation. Create, run once, and it disposes itself.
 */
export class Sandbox {
  private rt!: QuickJSRuntime;
  private ctx!: QuickJSContext;
  private cpuMs = 0;
  private enteredAt = 0;
  private inside = false;
  private disposed = false;
  private pending = new Set<Promise<void>>();
  private readonly limits: typeof SANDBOX_LIMITS;
  private cpuExceeded = false;
  private wake?: () => void;
  /** Host promises the script still waits on; disposed with the context. */
  private deferreds = new Set<{ dispose(): void; alive: boolean }>();

  private constructor(private opts: SandboxOptions) {
    this.limits = { ...SANDBOX_LIMITS, ...(opts.limits ?? {}) };
  }

  static async create(opts: SandboxOptions): Promise<Sandbox> {
    const sb = new Sandbox(opts);
    const mod = await quickjs();
    sb.rt = mod.newRuntime();
    sb.rt.setMemoryLimit(sb.limits.memoryBytes);
    sb.rt.setMaxStackSize(sb.limits.stackBytes);
    sb.rt.setInterruptHandler(() => {
      if (sb.opts.signal?.aborted) return true;
      if (sb.inside && sb.cpuMs + (performance.now() - sb.enteredAt) > sb.limits.cpuMs) {
        sb.cpuExceeded = true;
        return true;
      }
      return false;
    });
    sb.ctx = sb.rt.newContext();
    sb.install();
    return sb;
  }

  /** CPU time the script has used, in ms. */
  get cpuUsedMs(): number {
    return Math.round(this.cpuMs);
  }

  private enter<T>(fn: () => T): T {
    if (this.inside) return fn();
    this.inside = true;
    this.enteredAt = performance.now();
    try {
      return fn();
    } finally {
      this.cpuMs += performance.now() - this.enteredAt;
      this.inside = false;
    }
  }

  private pump(): void {
    if (this.disposed) return;
    this.enter(() => {
      const r = this.rt.executePendingJobs();
      if (r.error) r.error.dispose();
    });
    this.wake?.();
  }

  private install(): void {
    const ctx = this.ctx;
    const sync = ctx.newFunction('__hostSync', (nameH, argH) => {
      const name = ctx.getString(nameH);
      const fn = this.opts.sync[name];
      if (!fn) return ctx.newError(`unknown host call ${name}`);
      let payload: unknown;
      try {
        payload = JSON.parse(ctx.getString(argH));
      } catch {
        payload = undefined;
      }
      try {
        const out = fn(payload);
        return ctx.newString(JSON.stringify({ ok: out === undefined ? null : out }));
      } catch (err) {
        return ctx.newString(JSON.stringify({ error: (err as Error)?.message ?? String(err) }));
      }
    });
    ctx.setProp(ctx.global, '__hostSync', sync);
    sync.dispose();

    const asyncFn = ctx.newFunction('__host', (nameH, argH) => {
      const name = ctx.getString(nameH);
      const fn = this.opts.async[name];
      const deferred = ctx.newPromise();
      this.deferreds.add(deferred);
      let payload: unknown;
      try {
        payload = JSON.parse(ctx.getString(argH));
      } catch {
        payload = undefined;
      }
      const settle = (ok: boolean, value: unknown) => {
        if (this.disposed) return;
        this.deferreds.delete(deferred);
        if (ok) {
          const h = ctx.newString(JSON.stringify(value === undefined ? null : value));
          deferred.resolve(h);
          h.dispose();
        } else {
          const h = ctx.newError((value as Error)?.message ?? String(value));
          deferred.reject(h);
          h.dispose();
        }
        deferred.dispose();
      };
      const p = (async () => (fn ? fn(payload) : Promise.reject(new Error(`unknown host call ${name}`))))().then(
        (v) => settle(true, v),
        (e) => settle(false, e),
      );
      const tracked: Promise<void> = p.finally(() => {
        this.pending.delete(tracked);
        this.pump();
      });
      this.pending.add(tracked);
      return deferred.handle;
    });
    ctx.setProp(ctx.global, '__host', asyncFn);
    asyncFn.dispose();
  }

  /** Evaluate code in the global scope (the prelude). Throws SandboxError on an exception. */
  evalGlobal(code: string, filename: string): void {
    const res = this.enter(() => this.ctx.evalCode(code, filename));
    if (res.error) {
      const err = this.toError(res.error);
      res.error.dispose();
      throw err;
    }
    res.value.dispose();
  }

  /**
   * Evaluate a pure literal (the meta block) and return it after a JSON round
   * trip. Run in a fresh sandbox with no host functions.
   */
  evalLiteral(source: string): unknown {
    const res = this.enter(() => this.ctx.evalCode(`JSON.stringify((${source}))`, 'meta.js'));
    if (res.error) {
      const err = this.toError(res.error);
      res.error.dispose();
      throw err;
    }
    const text = this.ctx.typeof(res.value) === 'string' ? this.ctx.getString(res.value) : undefined;
    res.value.dispose();
    if (text === undefined) throw new SandboxError('meta does not serialize to JSON');
    return JSON.parse(text);
  }

  /**
   * Run an expression that evaluates to a promise (the wrapped script body)
   * and wait for it. The result goes through JSON inside the sandbox; a
   * result over the size cap is refused.
   */
  async runAsync(code: string, filename: string): Promise<unknown> {
    const wrapped = `(${code}).then((v) => (typeof __wfResultJson === 'function' ? __wfResultJson(v) : JSON.stringify(v === undefined ? null : v) ?? 'null'))`;
    const res = this.enter(() => this.ctx.evalCode(wrapped, filename));
    if (res.error) {
      const err = this.toError(res.error);
      res.error.dispose();
      throw err;
    }
    let settled = false;
    let outcome: { ok: true; value: string } | { ok: false; error: Error } | undefined;
    const native = this.ctx.resolvePromise(res.value);
    res.value.dispose();
    void native.then((r) => {
      settled = true;
      if (r.error) {
        outcome = { ok: false, error: this.toError(r.error) };
        r.error.dispose();
      } else {
        const s = this.ctx.typeof(r.value) === 'string' ? this.ctx.getString(r.value) : 'null';
        r.value.dispose();
        outcome = { ok: true, value: s };
      }
      this.wake?.();
    });
    const onAbort = () => this.wake?.();
    this.opts.signal?.addEventListener('abort', onAbort, { once: true });
    this.pump();
    for (;;) {
      if (settled && outcome) break;
      if (this.opts.signal?.aborted) throw new SandboxError('the run was stopped', 'aborted');
      if (this.cpuExceeded) throw new SandboxError(`the script used more than ${this.limits.cpuMs / 1000} s of CPU time`, 'cpu');
      if (!this.pending.size) {
        // one more turn of the job queue, then the script is waiting on nothing
        this.pump();
        await Promise.resolve();
        if (settled && outcome) break;
        if (!this.pending.size) throw new SandboxError('the script is waiting on a promise that never settles', 'stalled');
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
    this.opts.signal?.removeEventListener('abort', onAbort);
    const done = outcome!;
    if (!done.ok) throw done.error;
    if (done.value.length > this.limits.resultBytes) throw new SandboxError(`the result is larger than ${Math.round(this.limits.resultBytes / 1024 / 1024)} MB`, 'result');
    return JSON.parse(done.value);
  }

  private toError(h: QuickJSHandle): Error {
    let dumped: unknown;
    try {
      dumped = this.ctx.dump(h);
    } catch {
      dumped = undefined;
    }
    const d = dumped as { name?: string; message?: string; stack?: string } | string | undefined;
    const message = typeof d === 'string' ? d : (d?.message ?? 'unknown error');
    const name = typeof d === 'object' ? d?.name : undefined;
    if (this.cpuExceeded || (name === 'InternalError' && message === 'interrupted' && !this.opts.signal?.aborted)) {
      return new SandboxError(`the script used more than ${this.limits.cpuMs / 1000} s of CPU time`, 'cpu');
    }
    if (name === 'InternalError' && message === 'interrupted') return new SandboxError('the run was stopped', 'aborted');
    if (/out of memory/i.test(message)) return new SandboxError(`the script used more than ${this.limits.memoryBytes / 1024 / 1024} MB of memory`, 'memory');
    if (/stack overflow/i.test(message)) return new SandboxError('the script overflowed its stack', 'memory');
    const where = typeof d === 'object' && d?.stack ? `\n${String(d.stack).split('\n').slice(0, 3).join('\n')}` : '';
    return new SandboxError(`${name && name !== 'Error' ? `${name}: ` : ''}${message}${where}`, 'script');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.deferreds) {
      try {
        if (d.alive) d.dispose();
      } catch {
        // already gone
      }
    }
    this.deferreds.clear();
    try {
      this.ctx.dispose();
    } catch {
      // handles still alive after an abort: the runtime is dropped anyway
    }
    try {
      this.rt.dispose();
    } catch {
      // see above
    }
  }
}

/** Evaluate a meta literal in an empty sandbox and require a JSON round trip. */
export async function evalMeta(source: string): Promise<unknown> {
  const sb = await Sandbox.create({ sync: {}, async: {}, limits: { cpuMs: 1000, memoryBytes: 8 * 1024 * 1024 } });
  try {
    return sb.evalLiteral(source);
  } finally {
    sb.dispose();
  }
}
