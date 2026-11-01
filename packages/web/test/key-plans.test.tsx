/**
 * Settings > Subscriptions: a plan paid with an API key (the Z.ai Coding
 * Plan) shows read only, with its 5 hour and weekly windows and their resets.
 *
 *   bun test packages/web/test/key-plans.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountDto } from '@conclave/core/client';
import { KeyPlans } from '../src/features/settings/subscriptions';

const H = 3_600_000;
const now = Date.parse('2026-10-23T09:00:00');

const acct = (p: Partial<AccountDto>): AccountDto => ({ id: 'api-x', label: 'x', vendor: 'zai', vendorName: 'GLM', kind: 'api', enabled: true, state: 'ready', windows: [], models: [], saved: false, ...p });

describe('plans with an API key', () => {
  test('the Z.ai Coding Plan shows its name, that it uses a key, and its windows with resets', () => {
    const html = renderToStaticMarkup(
      <KeyPlans
        now={now}
        accounts={[
          acct({ id: 'api-anthropic', vendor: 'anthropic', plan: 'API key' }),
          acct({ id: 'api-zai', plan: 'Z.ai Coding Plan', subscription: 'zai-coding', windows: [{ name: '5h', kind: 'session', usedPercent: 25, resetsAt: now + 2 * H }, { name: '7d', kind: 'weekly', usedPercent: 10, resetsAt: now + 50 * H }] }),
        ]}
      />,
    );
    expect(html).toContain('Z.ai Coding Plan');
    expect(html).toContain('Uses an API key');
    expect(html).toContain('5 hours');
    expect(html).toContain('Week');
    expect(html).toContain('resets 11:00');
    expect(html).toContain('resets Sun 11:00');
    // a plain API key is not a plan
    expect(html.match(/Uses an API key/g)?.length).toBe(1);
  });

  test('nothing shows without one', () => {
    expect(renderToStaticMarkup(<KeyPlans now={now} accounts={[acct({ plan: 'API key' })]} />)).toBe('');
  });
});
