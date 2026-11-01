/**
 * One fan-out as one card (features/chat/fanOut.ts, FanOutCard.tsx): the
 * grouping key, what folds into a card and what stays where it arrived.
 *
 *   bun test packages/web/test/fan-out.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { fanOutFixture } from '../src/mock/fanout';
import { fanOutIndex, fanOutWords, firstLine, lineState, taskToolWords } from '../src/features/chat/fanOut';
import { turnPieces } from '../src/features/chat/Turn';
import { segment } from '../src/features/chat/toolGroups';

const f = fanOutFixture(1_800_000_000_000);

describe('a fan-out folds into one card', () => {
  const idx = fanOutIndex(f.messages);

  test('the four Task calls of one message share its id as the card key', () => {
    const cards = new Set([...idx.byTool.values()].map((n) => n.card));
    expect(cards.size).toBe(1);
    expect(idx.byTool.size).toBe(4);
    const pieces = turnPieces(f.messages.filter((m) => m.role === 'assistant' && m.kind !== 'notice').slice(0, 1), {}, {}, {});
    const work = pieces.find((p) => p.type === 'work');
    const segs = work && work.type === 'work' ? segment(work.entries) : [];
    expect(segs.filter((s) => s.kind === 'fanout').length).toBe(1);
    expect(segs.find((s) => s.kind === 'fanout')).toMatchObject({ items: { length: 4 } });
  });

  test('result notices update their line: done, failed, limited; never a separate row before prose', () => {
    const states = [...idx.byTool.values()].map((n) => lineState('done', n));
    expect(states).toEqual(['done', 'done', 'failed', 'limited']);
    const notices = f.messages.filter((m) => m.kind === 'notice');
    expect(notices.slice(0, 4).map((n) => idx.notices.get(n.id)?.mode)).toEqual(['hide', 'hide', 'hide', 'hide']);
    // round 2's notice arrives after prose: it attaches to the card and leaves a small "updated" line
    expect(idx.notices.get(notices[4].id)).toMatchObject({ mode: 'updated', label: 'Audit server request bodies' });
    expect(idx.byChild.get('ses_0mvServer')).toMatchObject({ round: 2, state: 'completed' });
    expect(idx.byChild.get('ses_0mvServer')?.report).toContain('Patch: cap the body');
    // the hub's no-answer stand-in is not a report: the line says it stopped at a limit
    expect(idx.byChild.get('ses_0mvCli')?.report).toBeUndefined();
  });

  test('TaskWait, TaskContinue and WorkflowStatus about its children fold; their rows vanish', () => {
    expect(idx.folded).toEqual(new Set(['tu_fo_wait', 'tu_fo_cont', 'tu_fo_wfs']));
    const pieces = turnPieces(f.messages, {}, {}, {}, idx.folded);
    const names = pieces.flatMap((p) => (p.type === 'work' ? p.entries.flatMap((e) => (e.type === 'call' ? [e.name] : [])) : []));
    expect(names).toEqual(['Task', 'Task', 'Task', 'Task', 'Workflow']);
  });

  test('a task tool with no card reads as words, never a ses_ id', () => {
    expect(taskToolWords('TaskWait', { ids: ['ses_a', 'ses_b'] }, undefined)).toEqual({ verb: 'Waited', target: 'for 2 subagents' });
    expect(taskToolWords('TaskList', {}, 'ses_a explore running\nses_b x done\nses_c y failed')).toEqual({ verb: 'Checked', target: '3 tasks' });
    expect(JSON.stringify(taskToolWords('TaskResult', { id: 'ses_a' }, 'x'))).not.toContain('ses_');
    const lone = fanOutIndex([{ id: 'a', sessionId: 's', seq: 1, role: 'assistant', kind: 'normal', createdAt: 1, content: [{ type: 'tool_use', id: 'w', name: 'TaskWait', input: { ids: ['ses_x'] } }] }]);
    expect(lone.folded.size).toBe(0);
  });

  test('the header and the closed line words', () => {
    expect(fanOutWords(['running', 'running', 'done', 'limited'])).toBe('4 subagents, 2 running, 1 limited');
    expect(fanOutWords(['done'])).toBe('1 subagent');
    expect(firstLine('\n## **No unsafe** parsing\nmore')).toBe('No unsafe parsing');
  });
});
