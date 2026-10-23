/**
 * Quiet hours for routine notices (docs/design/ROUND-LIFE-ASSISTANT.md 5).
 * Wraps the notifier: a notice from a routine session that is not an
 * approval, a question or a failure, sent outside the owner's message hours,
 * becomes a durable job at the end of quiet hours instead of a toast and a
 * push now. Everything else passes through untouched, and the hold while
 * the owner is using Conclave still applies when the notice goes out.
 */
import type { Notice } from '../types';
import type { Notifier } from '../notify/types';
import type { Scheduler } from '../scheduler/types';
import { newId } from '../util/ids';
import { logger } from '../util/log';

const log = logger('quiet-hours');

export const QUIET_JOB = 'assistant.notice';
/** The body of the engine's "a session finished its turn" notice. */
const TURN_DONE = 'Session finished a turn';

export interface QuietHoursOptions {
  /** True for a session a routine runs in (or a subagent of one). */
  routineSession(sessionId: string): boolean;
  /** Quiet hours at a time for an account (each person keeps their own message hours), and when they end. */
  quiet(ts: number, accountId?: string): { now: boolean; until?: number };
  scheduler: Pick<Scheduler, 'enqueue' | 'handle' | 'poke' | 'cancel'>;
  /** Pending held notices, for Settings. */
  waiting(): number;
  /** The held notices (job payloads), to fold a session's "finished a turn" into its real notice. */
  pending?(): Array<{ payload: Record<string, unknown>; dedupeKey?: string }>;
  now?: () => number;
}

type SendInput = Omit<Notice, 'id' | 'createdAt' | 'alert'>;

export class QuietHoursNotifier implements Notifier {
  private now: () => number;

  constructor(
    private inner: Notifier,
    private opts: QuietHoursOptions,
  ) {
    this.now = opts.now ?? Date.now;
    opts.scheduler.handle(QUIET_JOB, async (payload) => {
      const notice = payload.notice as SendInput | undefined;
      if (!notice || typeof notice.title !== 'string') return;
      // the hours may have moved while it waited
      const q = this.opts.quiet(this.now(), notice.accountId);
      if (q.now && q.until) {
        this.opts.scheduler.enqueue(QUIET_JOB, q.until, { notice });
        return;
      }
      await this.inner.send(notice);
    });
  }

  /** Whether a notice waits for the end of quiet hours. */
  holds(notice: SendInput, opts: { force?: boolean } = {}): number | undefined {
    if (opts.force || notice.level === 'error' || notice.approvalId) return undefined;
    if (!notice.sessionId || !this.opts.routineSession(notice.sessionId)) return undefined;
    const q = this.opts.quiet(this.now(), notice.accountId);
    return q.now ? q.until : undefined;
  }

  async send(input: SendInput, opts: { force?: boolean } = {}): Promise<Notice> {
    const until = this.holds(input, opts);
    if (until === undefined) return this.inner.send(input, opts);
    const { alert: _a, ...notice } = input as Notice;
    // a routine's "finished a turn" says nothing its own notice does not: hold at most one, and only when nothing else waits
    const sid = notice.sessionId!;
    const doneKey = `quiet:${sid}:done`;
    if (notice.body === TURN_DONE) {
      const other = this.opts.pending?.().some((j) => (j.payload.notice as SendInput | undefined)?.sessionId === sid && j.dedupeKey !== doneKey);
      if (!other) this.opts.scheduler.enqueue(QUIET_JOB, until, { notice }, doneKey);
    } else {
      this.opts.scheduler.cancel(doneKey);
      this.opts.scheduler.enqueue(QUIET_JOB, until, { notice });
    }
    log.debug(`notice "${notice.title}" waits for ${new Date(until).toISOString()}: quiet hours`);
    return { ...notice, id: newId('ntc'), createdAt: this.now() };
  }

  waiting(): number {
    return this.opts.waiting();
  }

  touch(clientId: string, accountId?: string): void {
    this.inner.touch(clientId, accountId);
  }
  release(clientId: string): void {
    this.inner.release(clientId);
  }
  channels() {
    return this.inner.channels();
  }
  test(channel: string, opts?: { endpoint?: string; accountId?: string }) {
    return this.inner.test(channel, opts);
  }
  addPushSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device?: string, accountId?: string) {
    this.inner.addPushSubscription(sub, device, accountId);
  }
  removePushSubscription(endpoint: string, accountId?: string) {
    this.inner.removePushSubscription(endpoint, accountId);
  }
  devices(accountId?: string) {
    return this.inner.devices(accountId);
  }
  removeDevice(id: string, accountId?: string) {
    return this.inner.removeDevice(id, accountId);
  }
  vapidPublicKey() {
    return this.inner.vapidPublicKey();
  }
}
