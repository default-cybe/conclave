import type { Session, DebateConfig } from '../types';
import type { Engine } from '../engine/engine';
import type { SessionRunner } from '../session/runner';
import { lastQuestion, renderTranscript } from '../session/transcript';
import { streamCompletion } from '../session/stream';
import { newId } from '../util/ids';

/**
 * Debate mode: two models argue a question for a set number of rounds, each
 * seeing the other's last point, then a judge concludes. Each turn is an aside
 * labeled with the model; the conclusion is a normal message.
 */
export async function runDebate(engine: Engine, runner: SessionRunner, session: Session, signal: AbortSignal): Promise<void> {
  const cfg: DebateConfig = { rounds: 2, a: session.model, b: engine.config.get().modes.reviewer, ...session.modeConfig?.debate };
  if (!engine.isUsableRef(cfg.a) || !engine.isUsableRef(cfg.b) || cfg.a === cfg.b) {
    engine.notice(session.id, 'Debate needs two different usable models. Answering normally instead.', 'warning');
    await runner.agentLoop(session.model, 'chat', signal);
    return;
  }
  const msgs = engine.repos.messages.list(session.id);
  const topic = lastQuestion(msgs);
  const context = renderTranscript(msgs.slice(0, -1), { maxChars: 20_000 });
  const group = newId('debate');

  const sides = [
    { ref: cfg.a, label: 'Debater A', stance: cfg.stanceA },
    { ref: cfg.b, label: 'Debater B', stance: cfg.stanceB },
  ];
  const history: Array<{ label: string; text: string }> = [];

  for (let round = 0; round < Math.max(1, Math.min(cfg.rounds, 5)); round++) {
    for (const side of sides) {
      const opponent = history.length ? history[history.length - 1] : undefined;
      const system = [
        `You are ${side.label} in a structured debate.`,
        side.stance ? `Your assigned position: ${side.stance}.` : 'Argue your genuine view, and push hard on weak points in the other side.',
        'Be concise and concrete. One tight argument per turn, around 150 words. Address the opponent\'s last point directly. Do not concede unless the evidence truly forces it.',
      ].join(' ');
      const prompt = [
        context ? `Context:\n${context}\n` : '',
        `Topic: ${topic}`,
        opponent ? `\nThe other side just argued:\n"${opponent.text}"` : '\nOpen the debate.',
        `\nRound ${round + 1}. Your turn, ${side.label}.`,
      ].join('\n');
      const res = await streamCompletion(
        engine,
        side.ref,
        { system: [{ text: system }], messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 1200, signal },
        { sessionId: session.id, purpose: 'debate' },
      );
      const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
      history.push({ label: side.label, text });
      engine.addMessage(session.id, {
        role: 'assistant',
        kind: 'aside',
        content: [{ type: 'text', text }],
        model: engine.displayModel(side.ref),
        author: `${side.label} · round ${round + 1}`,
        group,
      });
      if (signal.aborted) return;
    }
  }

  const judgeRef = cfg.judge && engine.isUsableRef(cfg.judge) ? cfg.judge : session.model;
  const transcript = history.map((h) => `${h.label}: ${h.text}`).join('\n\n');
  const res = await streamCompletion(
    engine,
    judgeRef,
    {
      system: [{ text: 'You judged this debate. Decide which side made the stronger case and why, in a few sentences, then give the user a clear, balanced takeaway with the practical answer.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: `Topic: ${topic}\n\nDebate:\n${transcript}` }] }],
      maxTokens: 2000,
      signal,
    },
    { sessionId: session.id, purpose: 'debate-judge' },
  );
  const verdict = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
  engine.addMessage(session.id, { role: 'assistant', kind: 'normal', content: [{ type: 'text', text: verdict }], model: engine.displayModel(judgeRef), author: 'Conclusion', group });
}
