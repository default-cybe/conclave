import type { EngineEvent } from '@conclave/core/types.ts';

/** The session an event belongs to, if any. */
export function eventSessionId(ev: EngineEvent): string | undefined {
  switch (ev.type) {
    case 'session.created':
    case 'session.updated':
      return ev.session.id;
    case 'session.deleted':
      return ev.sessionId;
    case 'message.created':
    case 'message.updated':
      return ev.message.sessionId;
    case 'message.delta':
    case 'tool.started':
    case 'tool.progress':
    case 'tool.completed':
    case 'approval.resolved':
    case 'question.answered':
    case 'todo.updated':
    case 'checkpoint.created':
    case 'regression.checked':
      return ev.sessionId;
    case 'approval.requested':
      return ev.approval.sessionId;
    case 'question.asked':
      return ev.question.sessionId;
    case 'notice':
      return ev.notice.sessionId;
    case 'usage.recorded':
      return ev.record.sessionId;
    default:
      return undefined;
  }
}

/** Statuses where a turn is in progress. */
export function isActiveStatus(s: string | undefined): boolean {
  return s === 'running' || s === 'waiting_approval' || s === 'waiting_input';
}

/** Drops repeats of the same error reported by several events (notice, session error, message). */
export class DedupeNotes {
  private recent: Array<{ key: string; at: number }> = [];

  constructor(private windowMs = 15_000) {}

  static key(text: string): string {
    let t = text.trim().toLowerCase();
    for (let i = 0; i < 4; i++) t = t.replace(/^(error|session error|conclave|warning|notice)\s*:\s*/, '');
    return t;
  }

  /** True when this text is new and should be shown. */
  fresh(text: string, now = Date.now()): boolean {
    const key = DedupeNotes.key(text);
    if (!key) return false;
    this.recent = this.recent.filter((r) => now - r.at < this.windowMs);
    if (this.recent.some((r) => r.key.includes(key) || key.includes(r.key))) return false;
    this.recent.push({ key, at: now });
    return true;
  }
}
