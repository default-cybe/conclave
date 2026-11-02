/*
 * The "Say this" card (docs/design/MEETING-MODE.md 1.3, 3.5): the bullets to
 * read aloud, large, then the rest of the answer (details, code, tables,
 * charts) smaller, then the source. Earlier answers show in the same card.
 *
 * The "n of m" stepper is ported from cheating-daddy, github.com/sohzm/cheating-daddy
 * @3cccc36f5ed63d7116e4bf93566899871e0199dc:src/components/views/AssistantView.js
 * 387-410 and 675-681 (previous and next response, disabled at the ends, the
 * counter between them). Copyright (C) 2025 sohzm. Licensed GPL-3.0-or-later;
 * combined into Conclave (AGPL-3.0-only) under GPLv3 section 13.
 */
import { memo, useEffect, useState } from 'react';
import { splitAnswer } from './model';
import { StreamText } from './StreamText';
import type { AnswerPaintInput, MeetingAnswer } from './wire';

/**
 * Reports each answer's first paint once: a frame after its first words
 * commit, POST .../paint with the desktop clock, fire and forget (a hub
 * without the route answers 404, and that is fine).
 */
export function paintReporter(post: (answerId: string, body: AnswerPaintInput) => Promise<unknown>, raf: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb)) {
  const sent = new Set<string>();
  return (answerId: string) => {
    if (sent.has(answerId)) return;
    sent.add(answerId);
    raf(() => {
      const paintedAt = Date.now();
      void post(answerId, { paintedAt, sentAt: Date.now() }).catch(() => undefined);
    });
  };
}

const STATE: Record<MeetingAnswer['state'], string> = { streaming: 'Writing', done: '', cancelled: 'Stopped', failed: 'No answer' };

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ov-copy"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        )
      }
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export interface Nav {
  index: number;
  count: number;
  step: (dir: -1 | 1) => void;
}

export const AnswerCard = memo(function AnswerCard({ answer, text, nav, onStop, onRetry, onPaint }: { answer: MeetingAnswer; text: string; nav?: Nav; onStop?: () => void; onRetry?: () => void; onPaint?: (answerId: string) => void }) {
  const done = answer.state !== 'streaming';
  const a = splitAnswer(text, done);
  // the first words on screen: a held back "Say this:" alone is not visible yet
  const visible = !!(a.say || a.rest.trim());
  const report = visible && !done && answer.paintedAt === undefined;
  useEffect(() => void (report && onPaint?.(answer.id)), [report, onPaint, answer.id]);
  return (
    <section className="ov-card" aria-label="Say this">
      <header className="ov-card-head">
        <span className="ov-label">Say this</span>
        {STATE[answer.state] && <span className={answer.state === 'failed' ? 'ov-fault' : 'ov-state'}>{STATE[answer.state]}</span>}
        <span className="ov-grow" />
        {nav && nav.count > 1 && (
          <span className="ov-nav" aria-label="Answers">
            <button type="button" className="ov-step" aria-label="Previous answer" disabled={nav.index <= 0} onClick={() => nav.step(-1)}>
              <svg viewBox="0 0 20 20" aria-hidden>
                <path d="M12 5l-5 5 5 5" />
              </svg>
            </button>
            <span className="ov-num">
              {nav.index + 1} of {nav.count}
            </span>
            <button type="button" className="ov-step" aria-label="Next answer" disabled={nav.index >= nav.count - 1} onClick={() => nav.step(1)}>
              <svg viewBox="0 0 20 20" aria-hidden>
                <path d="M8 5l5 5-5 5" />
              </svg>
            </button>
          </span>
        )}
        {done && text && <Copy text={answer.question ? `Question: ${answer.question}\n\n${text}` : text} />}
        {!done && onStop && (
          <button type="button" className="ov-link" onClick={onStop}>
            Stop
          </button>
        )}
      </header>
      {answer.question && <p className="ov-question">{answer.question}</p>}
      {answer.state === 'failed' ? (
        <div className="ov-row">
          <p className="ov-fault">No answer: {answer.error ?? 'the model did not answer'}</p>
          {onRetry && (
            <button type="button" className="ov-btn" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      ) : (
        <div aria-live="polite">
          {/* keyed by answer: one parser per answer and part (StreamText) */}
          {a.say && <StreamText key={`${answer.id}:say`} className="ov-md ov-say" text={a.say} done={done} />}
          {a.rest.trim() && <StreamText key={`${answer.id}:rest`} className="ov-md ov-rest" text={a.rest} done={done} />}
          {!a.say && !a.rest.trim() && !done && <p className="ov-muted">Thinking of an answer</p>}
          {a.source !== undefined && <p className="ov-source">Source: {a.source}</p>}
        </div>
      )}
    </section>
  );
});
