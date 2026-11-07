/**
 * The design mock's ranking (src/components/dev/PickerComposerDesign.tsx):
 * pickable first, then tier, context window and output price.
 *
 *   bun test packages/web/test/picker-design-rank.test.tsx
 */
import { expect, test } from 'bun:test';
import type { Row } from '../src/components/pickers/ModelPicker';
import { capabilityRank } from '../src/components/dev/PickerComposerDesign';

const row = (ref: string, m: { tier?: 'deep' | 'smart' | 'fast'; ctx?: number; out?: number }, disabled = false): Row =>
  ({ ref, group: 'x', groupKey: 'x', disabled, model: { tier: m.tier, contextWindow: m.ctx ?? 0, outputPrice: m.out ?? 0 } }) as unknown as Row;

test('most capable first, unpickable last', () => {
  const rows = [row('a/fast', { tier: 'fast', ctx: 1e6 }), row('a/none', {}), row('a/deep-off', { tier: 'deep' }, true), row('a/smart', { tier: 'smart' }), row('a/deep-small', { tier: 'deep', ctx: 2e5 }), row('a/deep-big', { tier: 'deep', ctx: 1e6, out: 20 })];
  expect(rows.sort(capabilityRank).map((r) => r.ref)).toEqual(['a/deep-big', 'a/deep-small', 'a/smart', 'a/fast', 'a/none', 'a/deep-off']);
});
