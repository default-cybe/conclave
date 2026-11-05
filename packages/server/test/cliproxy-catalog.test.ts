import { describe, expect, test } from 'bun:test';
import { CLAUDE_SECTION, claudeExtras, withExtras, type Catalog } from '../src/cliproxy/catalog';

// CLIProxyAPI 8.0.57's claude section (internal/registry/models/models.json), the ids only
const CPA_CLAUDE = [
  'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5',
  'claude-fable-5', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-5-20251101', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514',
  'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022',
];

describe('claude section extras from Conclave catalog', () => {
  test("against CLIProxyAPI's real list only Mythos 5.1 is missing; a dated id counts as the model", () => {
    const extras = claudeExtras(new Set(CPA_CLAUDE));
    expect(extras.map((e) => e.id)).toEqual(['claude-mythos-5-1']);
    expect(extras[0]).toEqual({ section: CLAUDE_SECTION, id: 'claude-mythos-5-1', name: 'Claude Mythos 5.1', like: 'claude-fable-5', fields: { context_length: 1_000_000, max_completion_tokens: 128_000 } });
  });

  test('the writer copies the like model, keeps the official entries and leaves other sections alone', () => {
    const base: Catalog = {
      claude: [
        { id: 'claude-opus-5-5', type: 'claude', owned_by: 'anthropic', thinking: { levels: ['low'] } },
        { id: 'claude-fable-5', type: 'claude', owned_by: 'anthropic', context_length: 200_000, thinking: { levels: ['low', 'max'] } },
      ],
      'codex-plus': [{ id: 'gpt-6-astra' }],
    };
    const { catalog, added } = withExtras(base, claudeExtras(new Set(CPA_CLAUDE)));
    expect(added.map((e) => e.id)).toEqual(['claude-mythos-5-1']);
    expect(catalog.claude.slice(0, 2)).toEqual(base.claude);
    expect(catalog.claude[2]).toEqual({
      id: 'claude-mythos-5-1',
      type: 'claude',
      owned_by: 'anthropic',
      context_length: 1_000_000,
      max_completion_tokens: 128_000,
      thinking: { levels: ['low', 'max'] },
      display_name: 'Claude Mythos 5.1',
      description: "Claude Mythos 5.1, from Conclave's catalog.",
    });
    expect(catalog['codex-plus']).toEqual(base['codex-plus']);
    // nothing to add once CLIProxyAPI has it
    expect(withExtras(catalog, claudeExtras(new Set([...CPA_CLAUDE, 'claude-mythos-5-1']))).added).toEqual([]);
  });
});
