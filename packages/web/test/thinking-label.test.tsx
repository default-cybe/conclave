/**
 * A thought's row says its label once (src/features/chat/Turn.tsx Thinking,
 * src/components/motion/Fold.tsx MorphLabel). The label was in the page
 * three times, once for screen readers and twice for its tone, and after
 * "Thought for 12s" (timed here) turned into the hub's "Thought for 15s" the
 * copies were cut where the two differ, so the reply read "Thought for
 * 15sThought for 1Thought for 15s" when copied or searched. Now the label is
 * in pieces only while it turns, and one word before and after.
 *
 *   bun test packages/web/test/thinking-label.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';
import type { Message, Session } from '@conclave/core/types';
import { AssistantTurn, BlockView } from '../src/features/chat/Turn';
import { MorphLabel, morphPlan } from '../src/components/motion/Fold';

/** The text a copy or find in page reads. */
const text = (html: string) => html.replace(/<[^>]+>/g, '');

const thought = (durationMs?: number) => ({ type: 'thinking' as const, thinking: 'Check every import first.', ...(durationMs ? { durationMs } : {}) });

describe('thinking label', () => {
  test('a thought reads "Thought for 15s", once', () => {
    expect(text(renderToStaticMarkup(<BlockView block={thought(15_000)} streaming={false} />))).toBe('Thought for 15s');
  });

  test('without a stored time it is the word count, once', () => {
    expect(text(renderToStaticMarkup(<BlockView block={thought()} streaming={false} />))).toBe('Reasoning, 4 words');
  });

  test('a label that changed is one word again once its last letter lands', () => {
    const p = morphPlan('Thought for 12s', 'Thought for 15s');
    expect(p).toMatchObject({ pre: 'Thought for 1', old: '2s', fresh: '5s' });
    // the last new letter starts at `at` plus 16ms a letter and takes 220ms (motion.css .cv-morph-new)
    expect(p.doneMs).toBeGreaterThanOrEqual(p.at + (p.fresh.length - 1) * 16 + 220);
    expect(p.doneMs).toBeGreaterThanOrEqual(p.leaveMs);
    expect(morphPlan('Thinking', 'Thought for 6s')).toMatchObject({ pre: 'Th', old: 'inking', fresh: 'ought for 6s' });
    expect(text(renderToStaticMarkup(<MorphLabel text="Thought for 15s" />))).toBe('Thought for 15s');
  });

  test('several thoughts in one turn: a label each, each on its own row', () => {
    const session = { id: 's1', agent: 'coder', model: 'claude-code/opus', status: 'idle' } as Session;
    const m: Message = {
      id: 'a1',
      sessionId: 's1',
      seq: 2,
      role: 'assistant',
      kind: 'normal',
      model: 'claude-code/opus',
      content: [thought(15_000), { type: 'text', text: 'Reading the importer.' }, thought(1_000), thought(15_000), { type: 'text', text: 'Done.' }],
      createdAt: 1,
      stopReason: 'end_turn',
    };
    const html = renderToStaticMarkup(
      <Router ssrPath="/s/s1">
        <AssistantTurn messages={[m]} session={session} streaming={{}} tools={{}} results={{}} known={null} />
      </Router>,
    );
    const rows = [...html.matchAll(/<button[^>]*class="cv-fold-row"[^>]*>(.*?)<\/button>/g)].map((r) => text(r[1]));
    // the lone thought keeps its row; the two in a row are one stretch of work (CHAT-AND-MOTION 6.3), its summary closed
    expect(rows).toEqual(['Thought for 15s']);
    expect(html).toContain('>Thought for 16s</span>');
    // each in a log row of its own (LogRow), so they never run together on a line
    const logRows = html.split('<div class="grid grid-cols-[48px_minmax(0,1fr)]').slice(1);
    const labelsIn = (r: string) => r.split('class="cv-fold-row"').length - 1 + (r.includes('data-group-toggle') ? 1 : 0);
    expect(logRows.filter((r) => labelsIn(r) === 1).length).toBe(2);
    for (const r of logRows) expect(labelsIn(r)).toBeLessThanOrEqual(1);
  });

  test('thoughts in a group while the turn runs: one closed summary, as on Android; no label of their own', () => {
    const session = { id: 's1', agent: 'coder', model: 'claude-code/opus', status: 'running' } as Session;
    const m: Message = { id: 'a1', sessionId: 's1', seq: 2, role: 'assistant', kind: 'normal', model: 'claude-code/opus', content: [thought(1_000), thought(15_000)], createdAt: 1 };
    const html = renderToStaticMarkup(
      <Router ssrPath="/s/s1">
        <AssistantTurn messages={[m]} session={session} streaming={{}} tools={{}} results={{}} known={null} live />
      </Router>,
    );
    const rows = [...html.matchAll(/<button[^>]*class="cv-fold-row"[^>]*>(.*?)<\/button>/g)].map((r) => text(r[1]));
    expect(rows).toEqual([]);
    expect(html).toContain('>Thought for 16s</span>');
    expect(html).toContain('data-group-toggle="" aria-expanded="false"');
  });
});
