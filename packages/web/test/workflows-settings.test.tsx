/**
 * Settings > Advanced > Workflows and subagents (features/settings/workflows.tsx):
 * the four caps with their defaults, Reset only on a saved value, the range
 * check that keeps Save off, and a save that sends the hub's config PATCH.
 *
 *   cd packages/web && bun test test/workflows-settings.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { api, connectClient } from '../src/lib/api';
import { useHub } from '../src/store/store';
import { limitValue, saveLimit, WorkflowsBody } from '../src/features/settings/workflows';

describe('Settings > Workflows and subagents', () => {
  test('four caps with their defaults and ranges, the queue note, and Reset only on a saved one', () => {
    const html = renderToStaticMarkup(<WorkflowsBody values={{ hubMax: 24 }} />);
    for (const l of ['At once in one run', 'At once per provider, all runs', 'At once on this hub', 'Most agents one run can start']) expect(html).toContain(l);
    for (const d of ['Default 8', 'Default 6', 'Default 16', 'Default 1,000']) expect(html).toContain(d);
    for (const r of ['1 to 16.', '1 to 32.', '1 to 64.', '1 to 10,000.']) expect(html).toContain(r);
    expect(html).toContain('wait in a queue and still finish');
    expect(html).toContain('Task subagent started from a chat is not held');
    expect(html).toContain('value="24"');
    expect(html.match(/>Reset</g)).toHaveLength(1);
  });

  test('only a whole number from 1 to the cap passes', () => {
    expect(limitValue('concurrency', '16')).toBe(16);
    expect(limitValue('concurrency', '17')).toBeUndefined();
    expect(limitValue('hubMax', ' 64 ')).toBe(64);
    for (const bad of ['0', '-1', '2.5', '', 'abc', '1e3']) expect(limitValue('perProvider', bad)).toBeUndefined();
    expect(limitValue('maxAgents', '10000')).toBe(10_000);
    expect(limitValue('maxAgents', '10001')).toBeUndefined();
  });

  test('saving sends workflows.<key> through PATCH /api/config and updates the store; Reset sends null', async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    const sent: unknown[] = [];
    Object.assign(api(), { updateConfig: async (p: unknown) => void sent.push(p) });
    expect(await saveLimit('perProvider', 10)).toBe(true);
    expect(sent).toEqual([{ workflows: { perProvider: 10 } }]);
    expect((useHub.getState().config?.workflows as { perProvider?: number }).perProvider).toBe(10);
    expect(await saveLimit('perProvider', null)).toBe(true);
    expect(sent[1]).toEqual({ workflows: { perProvider: null } });
  });
});
