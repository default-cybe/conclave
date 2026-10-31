/** The "Say this" card (docs/design/MEETING-MODE.md 1.3, 3.5). */
import { memo, useState } from 'react';
import { parseAnswer } from './model';
import type { MeetingAnswer } from './wire';

const STATE: Record<MeetingAnswer['state'], string> = { streaming: 'Writing', done: '', cancelled: 'Stopped', failed: 'No answer' };

export const AnswerCard = memo(function AnswerCard({ answer, text, onStop, onRetry }: { answer: MeetingAnswer; text: string; onStop?: () => void; onRetry?: () => void }) {
  const a = parseAnswer(text);
  return (
    <section className="ov-card" aria-label="Say this" aria-live="polite">
      <header className="ov-card-head">
        <span className="ov-label">Say this</span>
        {STATE[answer.state] && <span className={answer.state === 'failed' ? 'ov-fault' : 'ov-state'}>{STATE[answer.state]}</span>}
        {answer.state === 'streaming' && onStop && (
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
        <>
          {a.bullets.length > 0 && (
            <ul className="ov-say">
              {a.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
          {a.rest && <p className="ov-say-rest">{a.rest}</p>}
          {!a.bullets.length && !a.rest && answer.state === 'streaming' && <p className="ov-muted">Thinking of an answer</p>}
          {a.source !== undefined && <p className="ov-source">Source: {a.source}</p>}
        </>
      )}
    </section>
  );
});

/** An earlier answer, one line until opened. */
export function PreviousAnswer({ answer, text }: { answer: MeetingAnswer; text: string }) {
  const [open, setOpen] = useState(false);
  const a = parseAnswer(text);
  return (
    <li className="ov-prev">
      <button type="button" className="ov-prev-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {answer.question || a.bullets[0] || 'Answer'}
      </button>
      {open && (
        <ul className="ov-say ov-say-small">
          {a.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
