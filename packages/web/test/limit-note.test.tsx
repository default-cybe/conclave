/**
 * A plan whose vendor reports no usage (Antigravity) shows its note on the
 * Usage page, and says Blocked when the hub saw it refuse.
 *
 *   bun test packages/web/test/limit-note.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LimitState } from '@conclave/core/types';
import { LimitGroup } from '../src/components/ui/Meter';

const plan: LimitState = { provider: 'cliproxy', account: 'antigravity-g', label: 'Gemini plan · g@example.test', windows: [], updatedAt: 1, source: 'headers', note: 'Usage not reported by Google' };

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
