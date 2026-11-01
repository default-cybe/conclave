/**
 * An alert in the Inbox (docs/DESIGN.md 28): two live chats editing one
 * file, or a turn that stopped making progress. Filled like the approval
 * card; the amber is in the state word. A file conflict links to both chats
 * and has Dismiss; a stuck turn has Stop and Keep waiting. The hub removes
 * the alert once it is answered, or when it clears itself.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import type { AlertAction, AlertItem } from '@conclave/core/client';
import { api } from '@/lib/api';
import { attempt, removeKey, useHub, useOnPage } from '@/store/store';
import { cn } from '@/lib/text';
import { hhmm } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { hrefOf } from '@/lib/recents';
import { Button } from '../ui/Button';
import { CodeBlock } from '../ui/Code';
import { alertActions, alertText, alertWord, waitHint } from './alertWords';

/** Answer an alert: the hub hears it, and the row leaves at once. */
export function useAlertAction(a: AlertItem) {
  // its answers are on the page: no toast about this alert
  useOnPage(a.id);
  const [busy, setBusy] = useState<AlertAction | null>(null);
  const act = async (action: AlertAction) => {
    if (busy) return;
    setBusy(action);
    const ok = await attempt(() => api().alertAction(a.id, action));
    setBusy(null);
    if (ok) removeKey('alerts', a.id);
  };
  return { busy, act };
}

const BUSY: Record<AlertAction, string> = { stop: 'Stopping', wait: 'Waiting', dismiss: 'Dismissing' };

export function AlertCard({ alert: a, inSession, className }: { alert: AlertItem; inSession?: boolean; className?: string }) {
  const now = useNow(15_000);
  const sessions = useHub((s) => s.sessions);
  const deviceName = useHub((s) => (a.device && a.device !== 'local' ? (s.devices[a.device]?.name ?? a.device) : undefined));
  const { busy, act } = useAlertAction(a);
  const text = alertText(a, now);
  const hint = waitHint(a);
  const linkClass = 'rounded-[var(--r-1)] px-2 py-1 text-[13px] text-fg-2 underline decoration-rule-2 underline-offset-[3px] hover:text-fg';
  const links =
    a.kind === 'fileConflict'
      ? (a.sessions ?? []).map((r) => ({ id: r.id, label: `Open '${sessions[r.id]?.title ?? r.title}'` }))
      : inSession
        ? []
        : [{ id: a.sessionId, label: 'Open session' }];

  return (
    <div aria-label={`Alert: ${text}`} className={cn('relative rounded-[var(--r-2)] border border-rule-2 bg-raise px-4 pt-3.5 pb-4 anim-rise', className)}>
      <div className="flex items-baseline gap-3">
        <h3 className="min-w-0 flex-1 text-[14px] leading-[1.4] font-semibold text-pretty text-fg phone:text-[15px]">{text}</h3>
        <span className="shrink-0 text-[12px] text-warn phone:text-[13px]">{alertWord(a)}</span>
      </div>

      {a.kind === 'fileConflict' && a.path && (
        <p className="mt-2 text-[12px] text-fg-3 phone:text-[13px]">
          <span className="mono text-fg-2 [overflow-wrap:anywhere]">{a.path}</span>
          {deviceName && <> on {deviceName}</>}
        </p>
      )}
      {a.kind === 'stuck' && a.reason === 'loop' && a.error && <CodeBlock code={a.error} bare copy={false} wrap className="mt-3" />}
      {a.kind === 'stuck' && a.reason !== 'loop' && a.since && <p className="mt-1 text-[12px] text-fg-3 phone:text-[13px]">Last progress at {hhmm(a.since)}.</p>}
      {hint && <p className="mt-2 text-[13px] leading-[1.45] text-fg-2">{hint}</p>}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {alertActions(a).map((x) => (
          <Button key={x.action} variant={x.action === 'dismiss' ? 'quiet' : 'outline'} disabled={!!busy && busy !== x.action} busy={busy === x.action ? BUSY[x.action] : false} onClick={() => void act(x.action)}>
            {x.label}
          </Button>
        ))}
        {links.length > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-1">
            {links.map((l) => (
              <Link key={l.id} href={hrefOf(sessions[l.id] ?? { id: l.id })} className={linkClass}>
                {l.label}
              </Link>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
