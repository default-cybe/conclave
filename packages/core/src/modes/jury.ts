import type { Session, JuryConfig } from '../types';
import type { Engine } from '../engine/engine';
import type { SessionRunner } from '../session/runner';
import { lastQuestion, renderTranscript } from '../session/transcript';
import { streamCompletion } from '../session/stream';
import { newId } from '../util/ids';
import { logger } from '../util/log';

const log = logger('jury');

/**
 * Jury mode: several models answer the same question in parallel, then a judge
 * reads every answer and produces one result. Jurors can be hidden from the
 * judge so it does not favor a brand. Each juror answer is shown in the chat as
 * an aside grouped under one run; the verdict is a normal assistant message.
 */
export async function runJury(engine: Engine, runner: SessionRunner, session: Session, signal: AbortSignal): Promise<void> {
  const cfg: JuryConfig = { ...engine.config.get().modes.jury, ...session.modeConfig?.jury };
  const msgs = engine.repos.messages.list(session.id);
  const question = lastQuestion(msgs);
  const context = renderTranscript(msgs.slice(0, -1), { maxChars: 30_000, includeThinking: false });
  const group = newId('jury');

  const jurors = cfg.jurors.filter((j) => engine.isUsableRef(j));
  if (jurors.length < 2) {
    engine.notice(session.id, 'Jury mode needs at least two usable models. Falling back to a single answer.', 'warning');
    await runner.agentLoop(session.model, 'chat', signal);
    return;
  }

  engine.notice(session.id, `Asking ${jurors.length} models in parallel.`, 'info');

  const answers = await Promise.all(
    jurors.map(async (ref, i) => {
      const label = `Juror ${i + 1}`;
      try {
        const text = await askOne(engine, ref, question, context, cfg, session, signal);
        engine.addMessage(session.id, {
          role: 'assistant',
          kind: 'aside',
          content: [{ type: 'text', text }],
          model: engine.displayModel(ref),
          author: label,
          group,
        });
        return { ref, label, text, ok: true };
      } catch (err) {
        log.warn(`juror ${ref} failed`, err);
        engine.addMessage(session.id, {
          role: 'assistant',
          kind: 'aside',
          content: [{ type: 'text', text: `(failed: ${(err as Error)?.message ?? 'error'})` }],
          model: engine.displayModel(ref),
          author: label,
          group,
        });
        return { ref, label, text: '', ok: false };
      }
    }),
  );

  const good = answers.filter((a) => a.ok && a.text.trim());
  if (!good.length) {
    engine.notice(session.id, 'All jurors failed.', 'error');
    return;
  }

  const judgeRef = cfg.judge && engine.isUsableRef(cfg.judge) ? cfg.judge : session.model;
  const verdict = await judge(engine, judgeRef, question, good, cfg, session, signal);
  engine.addMessage(session.id, {
    role: 'assistant',
    kind: 'normal',
    content: [{ type: 'text', text: verdict }],
    model: engine.displayModel(judgeRef),
    author: 'Verdict',
    group,
  });
}

async function askOne(engine: Engine, ref: string, question: string, context: string, cfg: JuryConfig, session: Session, signal: AbortSignal): Promise<string> {
  const system = `You are one of several independent experts answering the same question. Give your best, complete answer. Be specific and honest about uncertainty. Do not mention that other experts exist.`;
  const prompt = context ? `Conversation so far:\n\n${context}\n\n---\n\nQuestion:\n${question}` : question;
  const res = await streamCompletion(
    engine,
    ref,
    { system: [{ text: system }], messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 4000, signal },
    { sessionId: session.id, purpose: 'jury' },
  );
  return res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
}

async function judge(engine: Engine, ref: string, question: string, answers: Array<{ ref: string; label: string; text: string }>, cfg: JuryConfig, session: Session, signal: AbortSignal): Promise<string> {
  const panel = answers
    .map((a, i) => `## Answer ${String.fromCharCode(65 + i)}${cfg.anonymize ? '' : ` (${engine.displayModel(a.ref)})`}\n${a.text}`)
    .join('\n\n');
  const task =
    cfg.strategy === 'vote'
      ? 'Pick the single best answer. Say which one (by its letter) and why in two or three sentences, then give that answer, improved where you can.'
      : cfg.strategy === 'rank'
        ? 'Rank the answers from best to worst with a one-line reason each, then write the best combined answer.'
        : 'Synthesize one strong answer that takes the best parts of each and drops the mistakes. Note briefly where the answers disagreed and which you trust.';
  const system = `You are the judge of a panel. ${answers.length} experts answered the same question. ${task} Write for the user as the final answer; do not expose your scoring as a wall of text.`;
  const prompt = `Question:\n${question}\n\n${panel}`;
  const res = await streamCompletion(
    engine,
    ref,
    { system: [{ text: system }], messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 4000, signal },
    { sessionId: session.id, purpose: 'jury-judge' },
  );
  return res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
}
