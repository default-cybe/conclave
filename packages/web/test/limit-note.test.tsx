/**
 * A plan whose vendor reports no usage (Antigravity) shows its note on the
 * Usage page, and says Blocked when the hub saw it refuse.
 *
 *   bun test packages/web/test/limit-note.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LimitState } from '@conclave/core/types';
import { LimitGroup, LimitRow } from '../src/components/ui/Meter';
import { Meter as AccountMeter } from '../src/features/settings/accounts';
import { rowWindows } from '../src/lib/accounts';
import { mapAntigravityUsage } from '../../core/src/usage/readers/antigravity';

const plan: LimitState = { provider: 'cliproxy', account: 'antigravity-g', label: 'Gemini plan · g@example.test', windows: [], updatedAt: 1, source: 'headers', note: 'Usage not reported by Google' };

describe('informational balances', () => {
  test('Accounts and Usage show exact credits, without a percentage or meter', () => {
    for (const creditAmount of ['96.512345', '1.234567', '0']) {
      const mapped = mapAntigravityUsage({ paidTier: { availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount, minimumCreditAmountForUsage: 5 }] } });
      const windows = rowWindows(mapped);
      expect(windows).toHaveLength(1);
      for (const html of [
        renderToStaticMarkup(<AccountMeter w={windows[0]} now={1000} />),
        renderToStaticMarkup(<LimitGroup limit={{ ...plan, windows: mapped.windows }} />),
      ]) {
        expect(html).toContain('Credits');
        expect(html).toContain(`${creditAmount} balance`);
        expect(html.replace(/<[^>]*>/g, '')).not.toContain('%');
        expect(html).not.toContain('role="meter"');
        expect(html).not.toContain('not read yet');
        expect(html).not.toContain('Blocked');
      }
    }
  });

  test('the reset line names the clock time, then the countdown', () => {
    const resetsAt = Date.now() + 83 * 60_000;
    const html = renderToStaticMarkup(<LimitRow window={{ name: '5h', usedPercent: 22, resetsAt }} plan="Plan" />);
    expect(html).toMatch(/resets \d{2}:\d{2} \(in /);
  });

  test('unknown percentages stay unknown, including a limit without remaining', () => {
    for (const window of [{ name: '5h' }, { name: '5h', limit: 100 }]) {
      const html = renderToStaticMarkup(<LimitRow window={window} plan="Plan" />);
      expect(html).toContain('not read yet');
      expect(html).not.toContain('%');
      expect(html).not.toContain('role="meter"');
    }
    const known = renderToStaticMarkup(<LimitRow window={{ name: '5h', usedPercent: 0 }} plan="Plan" />);
    expect(known).toContain('role="meter"');
    expect(known).toContain('0%');
  });
});

describe('a plan with no windows', () => {
  test('shows its note', () => {
    const html = renderToStaticMarkup(<LimitGroup limit={plan} />);
    expect(html).toContain('Usage not reported by Google');
    expect(html).not.toContain('Blocked');
  });

  test('says Blocked when the plan is blocked', () => {
    const html = renderToStaticMarkup(<LimitGroup limit={{ ...plan, blocked: true }} />);
    expect(html).toContain('Blocked. ');
    expect(html).toContain('Usage not reported by Google');
  });
});
