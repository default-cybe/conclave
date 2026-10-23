/**
 * A question from a running session (spec 10.16). Not boxed: a row under the
 * section rule. "GLM-5 asks: Which libc does the remote run?", the options as
 * outline buttons, Reply opens an inline input. Multi-select questions use
 * checkboxes and Send. Several questions in one request step "1 of 2".
 *
 * Phones (docs/design/MOBILE-V2.md 5): the question, the options as full
 * width outlined rows, then an "Other answer" field with Send.
 *
 * A subagent's or a workflow agent's question shows in the chat the owner is
 * in (lib/asks.ts): a quiet line above it says who asks ("Subagent email
 * asks"), in place of "GLM-5 asks:". In the Inbox its title reads "from
 * subagent email in <the chat's title>".
 */
import { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type { QuestionRequest } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, removeKey, useHub, useOnPage } from '@/store/store';
import { cn } from '@/lib/text';
import { relTime } from '@/lib/format';
import { useIsMobile } from '@/lib/hooks';
import { askFromInbox, askFromLine, askHome } from '@/lib/asks';
import { Button } from '../ui/Button';
import { Checkbox, Input } from '../ui/Field';
import { ModelName } from '../logo';

export function QuestionCard({
  question: req,
  inSession,
  here,
  className,
  title,
}: {
  question: QuestionRequest;
  inSession?: boolean;
  /** The conversation it shows in: a subagent's or a workflow agent's question there says who asks, above it. */
  here?: string;
  className?: string;
  /** Overrides the session title line. */
  title?: string;
}) {
  const mobile = useIsMobile();
  const session = useHub((s) => s.sessions[req.sessionId]);
  // a subagent's question is the chat's: the Inbox names that chat
  const homeTitle = useHub((s) => (req.from ? s.sessions[askHome(req)]?.title : undefined));
  const from = here ? askFromLine(req, here) : undefined;
  const heading = title ?? askFromInbox(req, homeTitle) ?? session?.title ?? 'Question';
  useOnPage(req.id);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multi, setMulti] = useState<string[]>([]);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const q = req.questions[step];
  if (!q) return null;
  const total = req.questions.length;

  const commit = async (value: string) => {
    const next = { ...answers, [q.question]: value };
    setAnswers(next);
    setMulti([]);
    setReply(null);
    if (step < total - 1) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    const ok = await attempt(() => api().answerQuestion(req.id, next));
    setBusy(false);
    if (ok) removeKey('questions', req.id);
  };

  if (mobile)
    return (
      <div id={`ask-${req.id}`} className={cn('py-3', className)} data-ask-from={from ? '' : undefined}>
        {!inSession && <p className="m-0 mb-1 truncate text-[14px] text-fg-3">{heading}</p>}
        {from && <p className="m-0 mb-2 truncate text-[14px] leading-[1.4] text-fg-3">{from}</p>}
        <p className="m-0 text-[16px] leading-[1.45] font-semibold text-fg">
          {q.question}
          {total > 1 && (
            <span className="num ml-2 text-[14px] font-normal text-fg-3">
              {step + 1} of {total}
            </span>
          )}
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {q.options.map((o) => {
            const on = multi.includes(o.label);
            return (
              <button
                key={o.label}
                type="button"
                disabled={busy}
                aria-pressed={q.multiSelect ? on : undefined}
                onClick={() => (q.multiSelect ? setMulti((m) => (on ? m.filter((x) => x !== o.label) : [...m, o.label])) : commit(o.label))}
                className={cn('min-h-12 w-full rounded-[12px] border px-4 py-3 text-left transition-colors duration-[var(--dur-1)] active:bg-hover disabled:text-fg-3', on ? 'border-fg' : 'border-rule-2')}
              >
                <span className="block text-[16px] leading-[1.35] font-medium text-fg">{o.label}</span>
                {o.description && <span className="mt-0.5 block text-[14px] leading-[1.4] text-fg-3">{o.description}</span>}
              </button>
            );
          })}
          {q.multiSelect && (
            <Button variant="solid" size="touch" full busy={busy ? 'Sending' : false} disabled={!multi.length} onClick={() => commit(multi.join(', '))} className="h-12! rounded-[12px]! text-[16px]!">
              Send
            </Button>
          )}
        </div>
        <form
          className="mt-2 flex items-center rounded-[12px] bg-surface-2 pl-4 light:border light:border-rule"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply?.trim()) void commit(reply.trim());
          }}
        >
          <input
            value={reply ?? ''}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Other answer"
            aria-label="Other answer"
            enterKeyHint="send"
            className="h-12 min-w-0 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-fg-3"
          />
          <span className="grid size-12 shrink-0 place-items-center">
            <button
              type="submit"
              aria-label="Send the answer"
              aria-disabled={!reply?.trim() || busy || undefined}
              className={cn('relative grid size-9 place-items-center rounded-full border transition-colors duration-[var(--dur-1)] after:absolute after:-inset-[5px]', reply?.trim() ? 'border-signal bg-signal text-bg' : 'border-fg-4 text-fg-4')}
            >
              <ArrowUp className="size-[18px]" strokeWidth={2} aria-hidden />
            </button>
          </span>
        </form>
      </div>
    );

  return (
    <div className={cn('py-3', className)} data-ask-from={from ? '' : undefined}>
      {from && <p className="m-0 mb-1.5 truncate text-[12.5px] leading-[1.4] text-fg-3">{from}</p>}
      {!inSession && (
        <div className="flex items-baseline gap-3">
          <span className="t-row min-w-0 flex-1 truncate text-fg">{heading}</span>
          <span className="num shrink-0 text-[12px] text-fg-3">{relTime(req.createdAt)}</span>
        </div>
      )}
      <p className="mt-1 text-[14px] leading-[1.45] text-fg phone:text-[15px]">
        {/* the line above says who asks */}
        {!from && <span className="text-fg-2">{session?.model ? <ModelName model={session.model} as="model" size={14} className="font-medium" /> : 'The agent'} asks: </span>}
        {q.question}
        {total > 1 && (
          <span className="num ml-2 text-[12px] text-fg-3">
            {step + 1} of {total}
          </span>
        )}
      </p>

      {q.multiSelect ? (
        <div className="mt-2.5">
          {q.options.map((o) => (
            <Checkbox key={o.label} checked={multi.includes(o.label)} onChange={(v) => setMulti((m) => (v ? [...m, o.label] : m.filter((x) => x !== o.label)))} label={o.label} description={o.description} />
          ))}
          <Button className="mt-2" variant="solid" size="sm" busy={busy ? 'Sending' : false} disabled={!multi.length} onClick={() => commit(multi.join(', '))}>
            Send
          </Button>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {q.options.map((o) => (
            <Button key={o.label} variant="outline" size="sm" title={o.description} busy={busy} onClick={() => commit(o.label)}>
              {o.label}
            </Button>
          ))}
          {reply === null && (
            <Button variant="quiet" size="sm" onClick={() => setReply('')}>
              Reply
            </Button>
          )}
        </div>
      )}

      {reply !== null && (
        <form
          className="mt-2.5 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) void commit(reply.trim());
          }}
        >
          <Input autoFocus size="sm" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Your answer" aria-label="Your answer" className="flex-1" />
          <Button type="submit" variant="solid" size="sm" disabled={!reply.trim()} busy={busy ? 'Sending' : false}>
            Send
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setReply(null)}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}
