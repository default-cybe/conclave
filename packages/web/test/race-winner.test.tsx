/**
 * A race run's Winner section (features/workflows/Race.tsx): the winner with
 * its reasons and Keep winner while its branch is kept, the other racers
 * with their check, a plain note when nobody passed, and only a state word
 * once the winner is applied.
 *
 *   bun test packages/web/test/race-winner.test.tsx
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkflowCall, WorkflowRunDetail } from '@conclave/core/client';
import { Race, raceOf } from '../src/features/workflows/Race';

function call(seq: number, state: 'kept' | 'merged' | 'discarded'): WorkflowCall {
  return { seq, label: `racer ${seq}`, phase: 'Run', state: 'done', worktree: { branch: `conclave/wf/wfr_r/${seq}`, commit: 'abc1234', state, files: 2 } } as unknown as WorkflowCall;
}

function detail(winner: number | null, states: Array<'kept' | 'merged' | 'discarded'>): WorkflowRunDetail {
  return {
    run: { id: 'wfr_r', name: 'race', status: 'done', cwd: '~/code/app', phases: [] },
    calls: states.map((s, i) => call(i + 1, s)),
    logs: [],
    findings: [],
    result: {
      race: {
        winner,
        reasons: ['Smallest change that does the task.'],
        arms: [
          { arm: 'racer 1', ran: true, seq: 1, passed: true, score: 8.5 },
          { arm: 'racer 2', ran: true, seq: 2, passed: false },
        ],
      },
    },
  } as unknown as WorkflowRunDetail;
}

test('the winner shows its reasons and Keep winner while its branch is kept', () => {
  const html = renderToStaticMarkup(<Race detail={detail(1, ['kept', 'kept'])} onKept={() => {}} />);
  expect(html).toContain('Winner');
  expect(html).toContain('Smallest change that does the task.');
  expect(html).toContain('Keep winner');
  expect(html).toContain('check failed');
});

test('once applied there is no Keep winner, and no winner says so plainly', () => {
  expect(renderToStaticMarkup(<Race detail={detail(1, ['merged', 'discarded'])} onKept={() => {}} />)).not.toContain('Keep winner');
  const none = renderToStaticMarkup(<Race detail={detail(null, ['kept', 'kept'])} onKept={() => {}} />);
  expect(none).toContain('No racer passed the check');
  expect(none).not.toContain('Keep winner');
});

test('a run without a race block shows nothing', () => {
  expect(raceOf({ report: 'x' })).toBeUndefined();
  expect(renderToStaticMarkup(<Race detail={{ ...detail(1, []), result: 'done' }} onKept={() => {}} />)).toBe('');
});
