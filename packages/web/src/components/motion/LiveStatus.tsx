import type { ReactNode } from 'react';
import { cn } from '@/lib/text';
import { useNow } from '@/lib/hooks';
import { durationShort, hhmm } from '@/lib/format';
import { Knot, type MarkState } from './Knot';
import { Roll } from './Roll';
import { Shimmer } from './Shimmer';

/** Every live state a reply or a session can be in (docs/design/CHAT-AND-MOTION.md 1.3). */
export type LiveState = 'thinking' | 'tool' | 'writing' | 'waiting' | 'resuming' | 'done' | 'failed' | 'stopped';

const MARK: Record<LiveState, MarkState> = {
  thinking: 'thinking',
  tool: 'tool',
  writing: 'tool',
  waiting: 'waiting',
  resuming: 'paused',
  done: 'done',
  failed: 'failed',
  stopped: 'done',
};

const WORD: Record<LiveState, string> = {
  thinking: 'Thinking',
  tool: 'Working',
  writing: 'Writing',
  waiting: 'Waiting on you',
  resuming: 'Resumes {t}',
  done: 'Done in {t}',
  failed: 'Failed',
  stopped: 'Stopped',
};

const TONE: Record<LiveState, string> = {
  thinking: 'text-signal',
  tool: 'text-signal',
  writing: 'text-signal',
  waiting: 'text-warn',
  resuming: 'text-fg-3',
  done: 'text-fg-3',
  failed: 'text-fault',
  stopped: 'text-fg-3',
};

/** "4:59", "1:02:03": a countdown that reads at a glance and rolls its digits. */
export function clockLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface LiveStatusProps {
  state: LiveState;
  /**
   * The words, sentence case. "{t}" is replaced by the time: elapsed while
   * live, the duration when done, the clock time when resuming (or the
   * countdown with `countdown`). Without "{t}" a known time follows the
   * words. Defaults: Thinking, Working, Writing, Waiting on you, Resumes {t},
   * Done in {t}, Failed, Stopped. Pass the tool's verb for state "tool".
   */
  label?: string;
  /** Quiet detail after the words, in fg-3: a search query, a host, a reason. */
  detail?: ReactNode;
  /** One action after the detail, such as Retry under a failure. */
  action?: ReactNode;
  /** When the work started: live states count up from it. */
  startedAt?: number;
  /** When it ended: "Done in 12s", "Thought for 12s". */
  endedAt?: number;
  /** For state "resuming": when the limit resets. */
  resumeAt?: number;
  /** For state "resuming": count down to resumeAt ("Resumes in 4:59") instead of naming the clock time. */
  countdown?: boolean;
  /** Mark size in px. Default 14 (meta lines); 16 next to body text. */
  size?: number;
  /** Hide the mark (when one already shows nearby). */
  mark?: boolean;
  /** The mark holds its still pose: in rows of a list, where a Knot never animates (spec 1.9). */
  still?: boolean;
  className?: string;
}

/**
 * The one line that says what the model is doing: the Knot, the state
 * words and the time. Live words shimmer; waiting is amber and still;
 * finished words settle to fg-3. Every number rolls (Roll). Only the words
 * are announced, never the counter.
 */
export function LiveStatus({ state, label, detail, action, startedAt, endedAt, resumeAt, countdown, size = 14, mark = true, still, className }: LiveStatusProps) {
  const live = state === 'thinking' || state === 'tool' || state === 'writing';
  const now = useNow(1000);
  let t = '';
  // a live counter starts at 1s, never "0s" (chat replies and session turns read the same)
  if (live && startedAt) t = now - startedAt >= 1000 ? durationShort(now - startedAt) : '';
  else if ((state === 'done' || state === 'stopped' || state === 'failed') && startedAt && endedAt) t = durationShort(endedAt - startedAt);
  else if (state === 'resuming' && resumeAt) t = countdown ? clockLeft(resumeAt - now) : hhmm(resumeAt);

  const words = label ?? (state === 'resuming' && countdown ? 'Resumes in {t}' : WORD[state]);
  const at = words.indexOf('{t}');
  const hasSlot = at >= 0;
  const roll = (v: string) => <Roll value={v} direction={state === 'resuming' ? 'down' : 'up'} duration={state === 'resuming' && countdown ? 380 : 240} />;
  let head: ReactNode;
  if (hasSlot) {
    if (t) {
      const before = words.slice(0, at);
      const after = words.slice(at + 3);
      head = (
        <>
          {before}
          {roll(t)}
          {after}
        </>
      );
    } else head = words.replace(/\s*(in|for|at)?\s*\{t\}/, '').trim();
  } else head = state === 'thinking' || state === 'tool' ? <Shimmer>{words}</Shimmer> : words;
  // what a screen reader hears: the words, never a ticking number
  const spoken = !hasSlot ? words : state === 'resuming' && countdown && resumeAt ? `Resumes at ${hhmm(resumeAt)}` : t ? words.replace('{t}', t) : words.replace(/\s*(in|for|at)?\s*\{t\}/, '').trim();

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2 text-[12.5px] leading-[1.4] phone:text-[13.5px]', className)}>
      {mark && <Knot state={MARK[state]} size={size} still={still} />}
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
      <span aria-hidden className={cn('state-word shrink-0 font-medium', TONE[state])}>
        {head}
      </span>
      {!hasSlot && t && <span className={cn('shrink-0', live ? 'text-signal' : 'text-fg-3')}>{roll(t)}</span>}
      {detail && <span className="min-w-0 truncate text-fg-3">{detail}</span>}
      {action && <span className="shrink-0">{action}</span>}
    </span>
  );
}
