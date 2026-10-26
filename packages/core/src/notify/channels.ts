import webpush from 'web-push';
import type { Notice } from '../types';
import type { NotifyChannel } from './types';
import { EngineError } from '../engine/errors';

export type SignAction = (approvalId: string, decision: 'allow' | 'deny') => string;

function baseUrl(u?: string): string | undefined {
  return u ? u.replace(/\/+$/, '') : undefined;
}

/** In-app path for a notice: its link, or its session. */
export function noticePath(notice: Notice): string | undefined {
  return notice.link ?? (notice.sessionId ? `/s/${notice.sessionId}` : undefined);
}

/** Absolute deep link for a notice, when a public URL is configured. */
export function deepLink(notice: Notice, publicUrl?: string): string | undefined {
  const base = baseUrl(publicUrl);
  if (!base) return undefined;
  const path = noticePath(notice);
  if (!path) return base;
  return /^https?:\/\//.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Signed one-tap link that POST /api/approvals/:id/act accepts without the
 * bearer token. Without a public URL it is a path; the service worker sends
 * it to the hub it came from.
 */
export function approvalActionUrl(publicUrl: string | undefined, approvalId: string, decision: 'allow' | 'deny', sign: SignAction): string {
  return `${baseUrl(publicUrl) ?? ''}/api/approvals/${encodeURIComponent(approvalId)}/act?decision=${decision}&sig=${encodeURIComponent(sign(approvalId, decision))}`;
}

// ---------------------------------------------------------------------------
// Web Push (browsers and the installed web app)
// ---------------------------------------------------------------------------

export interface PushSubscriptionRow {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device?: string;
  createdAt?: number;
}

export interface WebPushLib {
  sendNotification(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: Record<string, unknown>): Promise<unknown>;
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
}

export const defaultWebPush: WebPushLib = webpush as unknown as WebPushLib;

/** Signed approve and deny links for push payloads, so a phone can act without the bearer token. */
export function approvalLinks(notice: Notice, publicUrl: string | undefined, sign?: SignAction): { approveUrl?: string; denyUrl?: string } {
  if (!notice.approvalId || !sign) return {};
  return {
    approveUrl: approvalActionUrl(publicUrl, notice.approvalId, 'allow', sign),
    denyUrl: approvalActionUrl(publicUrl, notice.approvalId, 'deny', sign),
  };
}

/** Push services take about 4 KB after encryption; keep the JSON well under it. */
const MAX_PAYLOAD_BYTES = 3000;

/** What the service worker gets (packages/web/build/sw.js reads these fields). */
export function pushPayload(notice: Notice, publicUrl: string | undefined, sign?: SignAction): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: notice.id,
    title: notice.title.slice(0, 200),
    body: notice.body.slice(0, 1000),
    level: notice.level,
    link: noticePath(notice),
    url: deepLink(notice, publicUrl),
    approvalId: notice.approvalId,
    ...approvalLinks(notice, publicUrl, sign),
    sessionId: notice.sessionId,
    tag: notice.approvalId ? `approval-${notice.approvalId}` : notice.thread ? `thread-${notice.thread}` : notice.sessionId ? `session-${notice.sessionId}` : undefined,
  };
  // long bodies in wide scripts are three bytes a character; shorten until it fits
  let raw = payload.body as string;
  while (raw && Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    raw = raw.slice(0, Math.floor(raw.length * 0.75)).trimEnd();
    payload.body = raw ? `${raw}...` : '';
  }
  return payload;
}

/** True for errors from the network (DNS, refused, timeout) rather than from the push service or the keys. */
function networkError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && /^E[A-Z_]+$/.test(code)) return true;
  return /socket|network|timed? ?out|ENOTFOUND|ECONN|EAI_AGAIN/i.test((err as Error)?.message ?? '');
}

export class WebPushChannel implements NotifyChannel {
  readonly id = 'webpush';
  constructor(
    private deps: {
      sign?: SignAction;
      /** One account's browsers (every one when left out). */
      subscriptions: (accountId?: string) => PushSubscriptionRow[];
      remove: (endpoint: string) => void;
      vapid: () => { publicKey: string; privateKey: string; subject: string };
      lib: WebPushLib;
      log: (msg: string) => void;
    },
  ) {}

  enabled(): boolean {
    return this.deps.subscriptions().length > 0;
  }

  async send(notice: Notice, opts: { publicUrl?: string; only?: string; accountId?: string }): Promise<void> {
    // a notice goes to its own account's browsers only (docs/design/ACCOUNTS.md)
    const subs = this.deps.subscriptions(opts.accountId ?? notice.accountId ?? 'owner').filter((s) => !opts.only || s.endpoint === opts.only);
    if (!subs.length) return;
    const v = this.deps.vapid();
    const payload = JSON.stringify(pushPayload(notice, opts.publicUrl, this.deps.sign));
    const urgent = notice.level === 'error' || !!notice.approvalId;
    const errors: Array<{ status?: number; message: string; network: boolean } | 'gone'> = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          await this.deps.lib.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, {
            vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey },
            TTL: urgent ? 3600 : 6 * 3600,
            urgency: urgent ? 'high' : 'normal',
            timeout: 15_000,
          });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.deps.remove(s.endpoint);
            this.deps.log(`dropped expired push subscription ${s.endpoint.slice(0, 60)}`);
            errors.push('gone');
          } else errors.push({ status, message: (err as Error).message, network: !status && networkError(err) });
        }
      }),
    );
    if (errors.length && errors.length === subs.length) {
      const failed = errors.find((e) => e !== 'gone');
      if (!failed) throw new EngineError(410, 'The browser ended this subscription. Turn Notify this device off and on again.');
      throw new EngineError(
        502,
        failed.status
          ? `The push service refused the notification (${failed.status} ${failed.message}). Turn Notify this device off and on again. If it still fails, restart the hub.`
          : failed.network
            ? `The hub could not reach the browser's push service (${failed.message}). Check that the hub can reach the internet, then try again.`
            : `The hub could not send the notification (${failed.message}). Turn Notify this device off and on again.`,
      );
    }
  }
}
