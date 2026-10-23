/**
 * A background task that reported back, as one compact row in the log
 * (agentResult.ts): "Message from subagent count widgets", its state (done,
 * failed in the fault color, stopped) and a chevron. It opens in place to
 * the report, rendered markdown at a capped height that scrolls, and a link
 * to the subagent's session or the workflow run. It takes the place of the
 * hub's "Background task finished" notice and of the reminder only message
 * that carries the report, so the log shows one row, not a notice and an
 * empty bubble.
 */
import { memo, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ChevronRight } from 'lucide-react';
import type { Message } from '@conclave/core/types';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Markdown } from './Markdown';
import { agentResultHref, agentResultWords, noticeResult, reportFor, type AgentResultRef } from './agentResult';

export function AgentResultRow({ result, report, defaultOpen = false, className }: { result: AgentResultRef; report?: string; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const { title, state } = agentResultWords(result);
  const href = agentResultHref(result);
  const opener = result.type === 'workflow' ? 'Open the run' : 'Open the subagent';
  return (
    <div data-agent-result={result.type} className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[22px] w-full items-center gap-2 py-0.5 text-left text-[12px] leading-[22px] text-fg-3 hov:text-fg-2 phone:min-h-11 phone:text-[13px]"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className={cn('num shrink-0', state === 'failed' && 'text-fault', state === 'stopped' && 'text-warn')}>{state}</span>
        <ChevronRight aria-hidden strokeWidth={2} className={cn('size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--dur-1)]', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-1 mb-2 border-l border-rule-2 pl-3 anim-fade">
          {report ? (
            <div className="max-h-[320px] overflow-y-auto overscroll-contain">
              <Markdown text={report} className="text-[13.5px] text-fg-2" />
            </div>
          ) : (
            <p className="text-[12px] leading-[22px] text-fg-3 phone:text-[13px]">The report is not in this view.</p>
          )}
          {href && (
            <Link href={href} className="link mt-1 inline-block text-[12px] phone:text-[13px]">
              {opener}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** The row for a notice line about a finished task: its report from the session's messages. Null for any other notice. */
export const AgentResultNotice = memo(function AgentResultNotice({ message, className }: { message: Message; className?: string }) {
  const messages = useHub((s) => s.messages[message.sessionId]);
  const { result, report } = useMemo(() => {
    const r = noticeResult(message);
    return { result: r, report: r && messages ? reportFor(messages, r, message.seq) : undefined };
  }, [message, messages]);
  if (!result) return null;
  return <AgentResultRow result={result} report={report} className={className} />;
});
