/**
 * Alerts the hub raises about work in progress (docs/DESIGN.md 28): two
 * live chats editing the same file, and a turn that stopped making progress.
 * They wait in the Inbox next to approvals and questions, and they live in
 * the hub's memory: a restart drops them.
 * Only type declarations live here (see client/index.ts).
 */

export type AlertKind = 'fileConflict' | 'stuck';

/** What the owner can do with an alert. stop and wait answer a stuck turn; dismiss closes a file conflict. */
export type AlertAction = 'stop' | 'wait' | 'dismiss';

export interface AlertSessionRef {
  id: string;
  title: string;
}

export interface AlertItem {
  id: string;
  kind: AlertKind;
  /** The session it is about: the one that wrote second, or the stuck one. */
  sessionId: string;
  /** The sentence for the Inbox, as of when it was raised ("No progress in 'Fix login' for 5 min"). */
  text: string;
  createdAt: number;
  /** When it last held again (another conflicting write). */
  updatedAt: number;
  /** A conflict's two sessions, the one that wrote first first; a stuck turn's one session. */
  sessions?: AlertSessionRef[];

  // ----- fileConflict -----
  /** The device and the absolute path. */
  device?: string;
  path?: string;
  /** The path as the Inbox shows it: relative to a session's folder when it is inside one. */
  file?: string;

  // ----- stuck -----
  /** idle: no progress for the threshold. loop: one tool failed the same way several times in a row. */
  reason?: 'idle' | 'loop';
  /** idle: when the last progress came. loop: when the first of the failures came. */
  since?: number;
  /** idle: the threshold in force; each Keep waiting doubles it for the turn. */
  thresholdMs?: number;
  /** loop: the tool, how many failures in a row, and the error (cut). */
  tool?: string;
  count?: number;
  error?: string;
}

/**
 * The live state behind the alerts, for views that draw sessions (the Map):
 * cheap to read and independent of what the owner dismissed in the Inbox.
 */
export interface LiveAlerts {
  /** Sessions flagged stuck now: since when (the last progress, or the first failure of a loop). */
  stuck: Record<string, { stuckSince: number; reason: 'idle' | 'loop' }>;
  /** Pairs of live sessions that wrote the same file in the last 10 minutes; since: the first conflicting write. */
  conflicts: Array<{ file: string; device: string; sessions: [string, string]; since: number }>;
}
