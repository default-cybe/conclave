/**
 * Watches attached to each engine (engine/create.ts), so routes and tools
 * reach the service without widening the engine's interfaces, and the
 * runner extension that keeps a watch run to the reading browser tools.
 */
import type { RunnerExtension } from '../session/runner-ext';
import type { Tool } from '../tools/types';
import type { Session } from '../types';
import { WATCH_BROWSER_TOOLS, WATCH_NEVER, WATCH_REPORT } from './rules';
import type { WatchService } from './service';

export * from './types';
export * from './spec';
export * from './diff';
export * from './rules';
export { WatchService, WatchError, moneyWords, privateHost, IMAGE_DIR_CAP, type WatchBrowser, type WatchServiceOptions, type WatchCreateInput, type RunHooks, type RunResult } from './service';

const attached = new WeakMap<object, WatchService>();

export function attachWatches(engine: object, service: WatchService): void {
  attached.set(engine, service);
}

/** The watch service of an engine, when the hub has one. */
export function watchesOf(engine: object): WatchService | undefined {
  return attached.get(engine);
}

/** The watch a session runs for, when it is a watch run (WatchService.begin marks it). */
export function watchRunOf(session: Pick<Session, 'meta'>): string | undefined {
  const w = session.meta?.watch;
  return typeof w === 'string' && typeof session.meta?.watchRun === 'string' ? w : undefined;
}

const NEVER = new Set<string>(WATCH_NEVER);

/**
 * A watch run sees the reading browser tools and WatchReport, whatever its
 * agent's list says, and never the ones that type, pick, run page code or
 * switch profile, whatever its allow list says. They still need the
 * routine's allow rules to run (the session is untrusted).
 */
export function watchExtension(optInTools: () => Tool[], builtin: () => Tool[]): RunnerExtension {
  const wanted = new Set<string>([...WATCH_BROWSER_TOOLS, WATCH_REPORT]);
  return {
    name: 'watches',
    tools(session, tools) {
      if (!watchRunOf(session)) return undefined;
      const kept = tools.filter((t) => !NEVER.has(t.name));
      const have = new Set(kept.map((t) => t.name));
      const add = [...optInTools(), ...builtin()].filter((t) => wanted.has(t.name) && !have.has(t.name));
      return add.length || kept.length !== tools.length ? [...kept, ...add] : undefined;
    },
    beforeTool(ctx) {
      if (watchRunOf(ctx.session) && NEVER.has(ctx.tool.name)) return { decision: 'deny', reason: `A watch only reads the web, so ${ctx.tool.name} is not allowed in a watch run.` };
      return undefined;
    },
  };
}
