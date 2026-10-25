/**
 * System events in the transcript (spec 10.20, 11.2.6): one line in meta
 * fg-3 with the time in the gutter. The limit notice is the one with more
 * to say: when the session waits for a reset it explains when it resumes
 * and offers a switch.
 */
import { memo, useRef, useState } from 'react';
import type { Message, Notice, Session } from '@conclave/core/types';
import { api } from '@/lib/api';
import { attempt, upsertSession, useHub } from '@/store/store';
import { hhmm } from '@/lib/format';
import { modelName, providerName } from '@/lib/models';
import { cn } from '@/lib/text';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Overlay';
import { ModelList } from '@/components/pickers/ModelPicker';
import { SwitchModelList } from './SwitchChoice';
import { windowLabel } from '@/components/ui/Meter';
import { LogRow } from './Log';
import { Markdown } from './Markdown';
import { fallbackModel, msgText } from './util';
import { providerFailureNotice, TryNextModel } from './TryNextModel';
import { FanOutNotice } from './FanOutCard';
import { noticeResult } from './agentResult';

interface NoticeMeta {
  type?: string;
  resetsAt?: number;
  provider?: string;
  level?: Notice['level'];
  model?: string;
  summaryTokens?: number;
}

const CONTINUE = 'Continue where you left off.';

/** "Switched to openai/gpt-5.5" -> "Switched to GPT-5.5." and similar clean ups. A hub from before switches said "Handed off". */
function noticeWords(text: string, meta: NoticeMeta): string {
  let t = text.trim();
  if (meta.type === 'handoff' && meta.model) t = `Switched to ${modelName(meta.model)}${meta.summaryTokens ? ` with a ${Math.round(meta.summaryTokens / 1000)}K token summary` : ''}.`;
  else if (/^Handed off (from \S+ )?to /.test(t)) t = t.replace(/^Handed off/, 'Switched');
  t = t.replace(/\b(?:anthropic|openai|google|zai|zhipu|openrouter|ollama|lmstudio|deepseek|moonshot|mistral|groq|xai|claude-code|codex|gemini-cli|opencode)\/[\w.:/-]*[\w]/g, (ref) => modelName(ref));
  if (!/[.!?)]$/.test(t)) t += '.';
  return t;
}

export const NoticeLine = memo(function NoticeLine({ message, session, latest, enter }: { message: Message; session: Session; latest?: boolean; /** It arrived after the transcript loaded: fade in. */ enter?: boolean }) {
  // a background task that reported back: one row that opens to its report (AgentResultRow.tsx)
  // folded into its fan-out card it draws nothing, or a small "updated" line (FanOutCard.tsx)
  if (noticeResult(message))
    return (
      <FanOutNotice
        message={message}
        wrap={(row) => (
          <LogRow time={hhmm(message.createdAt)} id={`msg-${message.id}`} className={cn(enter && 'anim-fade')}>
            {row}
          </LogRow>
        )}
      />
    );
  const text = msgText(message);
  const meta = (message.meta ?? {}) as NoticeMeta;
  const isLimit = meta.type === 'limit' || (latest && session.status === 'waiting_reset' && /limit/i.test(text));
  if (isLimit && latest && session.status === 'waiting_reset') return <LimitNotice message={message} session={session} enter={enter} />;
  const level = meta.level ?? (meta.type === 'error' || /^(error|failed)\b/i.test(text) ? 'error' : 'info');
  let words = noticeWords(isLimit ? limitHeadline(text, meta) : text, meta);
  if (level === 'error' && !/^failed\b/i.test(words)) words = `Failed. ${words.replace(/^error:?\s*/i, '')}`;
  const [first, ...rest] = words.split(' ');
  return (
    <LogRow time={hhmm(message.createdAt)} id={`msg-${message.id}`} className={cn(enter && 'anim-fade')}>
      <p className="py-0.5 text-[12px] leading-[22px] text-fg-3 phone:text-[13px]">
        {level === 'error' ? (
          <>
            <span className="text-fault">{first}</span> {rest.join(' ')}
          </>
        ) : (
          <span className={cn(level === 'warning' && 'text-warn')}>{words}</span>
        )}
      </p>
      {/* a refused reply: the next model of Refusal fallback, on request */}
      <TryNextModel message={message} session={session} className="mt-1.5 mb-1" />
    </LogRow>
  );
});

/** "Claude Max 5 hour limit reached." from the notice text or the limit state. */
function limitHeadline(text: string, meta: NoticeMeta): string {
  const first = /^[^.]*limit[^.]*\./i.exec(text.trim())?.[0];
  if (first) return first;
  return `${providerName(meta.provider) || 'The provider'} limit reached.`;
}

/**
 * The limit notice while the session waits for the reset (spec 11.2.6). Not
 * boxed. The live line under the log says when it resumes and counts down.
 */
function LimitNotice({ message, session, enter }: { message: Message; session: Session; enter?: boolean }) {
  const meta = (message.meta ?? {}) as NoticeMeta;
  const models = useHub((s) => s.models);
  const config = useHub((s) => s.config);
  const limit = useHub((s) => (meta.provider ? s.limits[meta.provider] : undefined));
  const fallback = fallbackModel(session, models, config);
  const pickRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // "Claude Max 5 hour limit reached."
  const plan = limit?.label ?? providerName(meta.provider);
  const win = limit?.windows.find((w) => (w.usedPercent ?? 0) >= 100) ?? limit?.windows[0];
  const winWord = win ? windowLabel(win.name).toLowerCase().replace(/^5 hours$/, '5 hour').replace(/^week$/, 'weekly') : '';
  const headline = plan ? `${plan}${winWord ? ` ${winWord}` : ''} limit reached.` : limitHeadline(msgText(message), meta);

  const handoff = async (model: string, key: string) => {
    setBusy(key);
    const s = await attempt(() => api().handoff(session.id, model));
    if (s) {
      upsertSession(s);
      await attempt(() => api().send(session.id, { text: CONTINUE }));
    }
    setBusy(null);
  };

  return (
    <LogRow time={hhmm(message.createdAt)} id={`msg-${message.id}`} className={cn(enter && 'anim-fade')}>
      <div className="py-1">
        <p className="text-[14px] leading-[22px] font-medium text-warn phone:text-[15px]">{headline}</p>
        <p className="mt-0.5 max-w-[64ch] text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">
          {/* the live line under the log says when, and counts down */}
          This session picks up where it stopped when the limit resets. Switch models to keep going now.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {fallback && (
            <Button variant="outline" busy={busy === 'switch' ? 'Switching' : false} onClick={() => handoff(fallback, 'switch')}>
              Switch to {modelName(fallback)} now
            </Button>
          )}
          <Button ref={pickRef} variant="quiet" aria-expanded={picking} onClick={() => setPicking(true)}>
            Pick another model…
          </Button>
          <Button
            variant="quiet"
            busy={busy === 'resume' ? 'Resuming' : false}
            onClick={async () => {
              setBusy('resume');
              await attempt(() => api().send(session.id, { text: CONTINUE }));
              setBusy(null);
            }}
          >
            Resume now
          </Button>
          <Button
            variant="quiet"
            busy={busy === 'stop' ? 'Stopping' : false}
            onClick={async () => {
              setBusy('stop');
              await attempt(() => api().abort(session.id), 'This session will not resume on its own.');
              setBusy(null);
            }}
          >
            Don't resume
          </Button>
        </div>
      </div>
      <Popover anchor={pickRef} open={picking} onClose={() => setPicking(false)} width={400} label="Switch to" sheetTitle="Switch to">
        {/* a big chat shows the switch's price first (SwitchChoice.tsx); after a switch the session goes on */}
        <SwitchModelList session={session} harnesses onDone={() => setPicking(false)} onSwitched={() => void attempt(() => api().send(session.id, { text: CONTINUE }))} />
      </Popover>
    </LogRow>
  );
}

/**
 * A failed session (status error), next to the live line's Knot, which has
 * stopped and turned the fault color in place: the reason, then Retry and
 * Switch model.
 */
export function ErrorBody({ session, lastPrompt, enter }: { session: Session; lastPrompt?: string; /** It happened while the session was open: fade in. */ enter?: boolean }) {
  const pickRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const providerFailure = useHub((s) => providerFailureNotice(s.messages[session.id] ?? []));
  const reason = (session.error ?? 'The run stopped with an error.').replace(/\.?$/, '.');
  return (
    <div className={cn('min-w-0', enter && 'anim-fade')} role="alert">
      <p className="max-w-[72ch] text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">
        <span className="font-medium text-fault">Failed.</span> {reason}
      </p>
      {providerFailure?.meta?.retryExpired === true && <p>Alternate-model retry expired when the hub restarted. Nothing was rerun.</p>}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {lastPrompt && !providerFailure && (
          <Button
            variant="outline"
            busy={busy === 'retry' ? 'Retrying' : false}
            onClick={async () => {
              setBusy('retry');
              await attempt(() => api().send(session.id, { text: lastPrompt }));
              setBusy(null);
            }}
          >
            Retry
          </Button>
        )}
        <Button ref={pickRef} variant="quiet" aria-expanded={picking} onClick={() => setPicking(true)}>
          Switch model
        </Button>
        {/* the hub names Settings, Providers when a key is missing or refused */}
        {/Settings, Providers/.test(reason) && (
          <ButtonLink href="/settings/providers" variant="quiet">
            Open Providers
          </ButtonLink>
        )}
      </div>
      <Popover anchor={pickRef} open={picking} onClose={() => setPicking(false)} width={380} label="Switch model" sheetTitle="Switch model">
        <ModelList
          value={session.model}
          onChange={async (m) => {
            setBusy('switch');
            const s = await attempt(() => api().handoff(session.id, m));
            if (s) upsertSession(s);
            setBusy(null);
          }}
          onDone={() => setPicking(false)}
        />
      </Popover>
    </div>
  );
}

/** A compaction summary: one notice line, the summary behind "Show summary". A switch's short handover names its model. */
export function SummaryLine({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const text = msgText(message);
  const to = (message.meta?.switch as { to?: string } | undefined)?.to;
  return (
    <LogRow time={hhmm(message.createdAt)} id={`msg-${message.id}`}>
      <p className="py-0.5 text-[12px] leading-[22px] text-fg-3 phone:text-[13px]">
        {to ? `Earlier messages were summarized for the switch to ${modelName(to)}.` : 'Earlier messages were compacted into a summary.'}{' '}
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="link text-[12px] phone:text-[13px]">
          {open ? 'Hide summary' : 'Show summary'}
        </button>
      </p>
      {open && <Markdown text={text} className="mt-1 mb-2 border-l border-rule-2 pl-3 text-[13.5px] text-fg-2 anim-fade" />}
    </LogRow>
  );
}
