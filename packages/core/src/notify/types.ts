import type { Notice } from '../types';

export interface NotifyChannel {
  readonly id: string;
  enabled(): boolean;
  /** `only` limits the send to one push endpoint (a test from one browser). */
  send(notice: Notice, opts: { publicUrl?: string; only?: string; accountId?: string }): Promise<void>;
}

/** A browser or installed web app that gets Web Push from the hub. */
export interface NotifyDevice {
  /** Short stable id: a hash of the push endpoint. */
  id: string;
  /** The name the browser sent when it subscribed ("Chrome on macOS"). */
  name?: string;
  kind: 'webpush';
  createdAt?: number;
}

export interface Notifier {
  /**
   * Emit a notice to open apps and send it to devices. The notice on the bus
   * has `alert: true` when devices should show it (see Notice.alert).
   */
  send(notice: Omit<Notice, 'id' | 'createdAt' | 'alert'>, opts?: { force?: boolean }): Promise<Notice>;
  /** Mark a client as in use (holds notifications while you are looking at the app). The hold is per account: one person at the desk never holds another's. */
  touch(clientId: string, accountId?: string): void;
  /** The client is no longer in use (its app went to the background or closed): stop holding for it now. */
  release(clientId: string): void;
  channels(): Array<{ id: string; enabled: boolean }>;
  /** Send a test notification to an account's browsers. With `endpoint`, only that browser gets it. Throws a message that says what to do. */
  test(channel: string, opts?: { endpoint?: string; accountId?: string }): Promise<void>;
  /** Web Push subscription management, per account (docs/design/ACCOUNTS.md). */
  addPushSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, device?: string, accountId?: string): void;
  removePushSubscription(endpoint: string, accountId?: string): void;
  /** Browsers of an account that get Web Push. */
  devices(accountId?: string): NotifyDevice[];
  /** Stop notifying a browser of an account. False when the id is unknown. */
  removeDevice(id: string, accountId?: string): boolean;
  vapidPublicKey(): string | undefined;
}
