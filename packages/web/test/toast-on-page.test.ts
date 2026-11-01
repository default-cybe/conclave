/**
 * A toast about an approval, a question or an alert (src/store/store.ts)
 * is not shown while the open page shows that item's row or card: the stuck
 * alert's toast showed over its own card.
 *
 *   bun test packages/web/test/toast-on-page.test.ts
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { Notice } from '@conclave/core/types';
import { applyEvent, showOnPage, stopLive, useHub } from '../src/store/store';

let seq = 0;
const notice = (n: Partial<Notice> & { id: string }) =>
  applyEvent({ type: 'notice', notice: { title: 'Fix login', body: 'No progress for 6 min', level: 'warning', createdAt: 1, ...n }, seq: ++seq, ts: 1000 + seq } as Parameters<typeof applyEvent>[0]);
const shown = () => useHub.getState().toasts.map((t) => t.id);

beforeEach(() => stopLive());

describe('a toast about what the page shows', () => {
  test('a row that comes on screen takes its toast away', () => {
    notice({ id: 'n1', alertId: 'alrt_1', sessionId: 's1' });
    notice({ id: 'n2', title: 'Saved.' });
    expect(shown()).toEqual(['n1', 'n2']);
    const gone = showOnPage('alrt_1');
    expect(shown()).toEqual(['n2']);
    gone();
  });

  test('a toast about a row on screen is not drawn, and is again once the row goes', () => {
    const gone = showOnPage('appr_1');
    notice({ id: 'n3', approvalId: 'appr_1', title: 'Approval needed' });
    notice({ id: 'n4', questionId: 'q_1', title: 'Question' });
    expect(shown()).toEqual(['n4']);
    gone();
    notice({ id: 'n5', approvalId: 'appr_1', title: 'Approval needed' });
    expect(shown()).toEqual(['n4', 'n5']);
  });

  test('two rows of one item: its toast stays away until both go', () => {
    const a = showOnPage('q_2');
    const b = showOnPage('q_2');
    a();
    notice({ id: 'n6', questionId: 'q_2', title: 'Question' });
    expect(shown()).toEqual([]);
    b();
    notice({ id: 'n7', questionId: 'q_2', title: 'Question' });
    expect(shown()).toEqual(['n7']);
  });
});
