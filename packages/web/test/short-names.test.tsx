/**
 * A plan's short name in Settings > Models > Accounts
 * (features/settings/shortname.tsx, lib/accounts.ts): the line that asks for
 * names when two or more plans of a vendor have none, the suggested names,
 * the field on each plan row, and Save, which checks the name and sends it
 * to the hub (PUT /api/accounts/:id/prefix).
 *
 *   cd packages/web && bun test test/short-names.test.tsx
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountDto, AccountsStatus } from '@conclave/core/client';
import { api, connectClient } from '../src/lib/api';
import { shortNameSuggestions, starterLine, takenPrefixes, unnamedLine, unnamedPlans } from '../src/lib/accounts';
import { saveShortName, ShortNameRow, UnnamedPlans } from '../src/features/settings/shortname';

const plan = (id: string, extra: Partial<AccountDto> = {}): AccountDto => ({ id, label: id, vendor: 'anthropic', vendorName: 'Claude', kind: 'subscription', credential: `${id}.json`, enabled: true, state: 'ready', windows: [], models: [], saved: true, ...extra });
const personal = plan('claude-kai@kaivalya.dev', { label: 'kai@kaivalya.dev', email: 'kai@kaivalya.dev' });
const neu = plan('claude-kai@neu.edu', { label: 'kai@neu.edu', email: 'kai@neu.edu' });
const key = plan('api-anthropic', { label: 'Claude API key', kind: 'api', credential: undefined });
const codex = plan('codex-kai@kaivalya.dev', { label: 'kai@kaivalya.dev', email: 'kai@kaivalya.dev', vendor: 'openai', vendorName: 'ChatGPT', prefix: 'chat' });
const status = (accounts: AccountDto[], management = true): AccountsStatus => ({ accounts, routes: [], now: [], management });

describe('the line at the top', () => {
  test('two Claude plans without a short name ask for them, with a field for each', () => {
    const all = [personal, neu, key, codex];
    expect(unnamedPlans(all)).toEqual([{ vendor: 'anthropic', vendorName: 'Claude', count: 2, plans: [personal, neu] }]);
    expect(unnamedLine(unnamedPlans(all)[0])).toBe('You have 2 Claude plans. Give each a short name so Conclave can pick one (Refusal fallback, Window starter).');
    const html = renderToStaticMarkup(<UnnamedPlans status={status(all)} suggestions={shortNameSuggestions(all)} onSaved={() => {}} />);
    expect(html).toContain('You have 2 Claude plans. Give each a short name so Conclave can pick one (Refusal fallback, Window starter).');
    // the same email name on both: each gets its domain
    expect(html).toMatch(/aria-label="Short name for kai@kaivalya.dev"[^>]* value="kaivalya"/);
    expect(html).toMatch(/aria-label="Short name for kai@neu.edu"[^>]* value="neu"/);
    expect(html.match(/>Save</g)?.length).toBe(2);
    expect(html).not.toContain('—');
  });

  test('none once a vendor has at most one plan without a name, or without the management key', () => {
    const named = { ...neu, prefix: 'neu' };
    expect(unnamedPlans([personal, named, key])).toEqual([]);
    expect(renderToStaticMarkup(<UnnamedPlans status={status([personal, named])} suggestions={new Map()} onSaved={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<UnnamedPlans status={status([personal, neu], false)} suggestions={new Map()} onSaved={() => {}} />)).toBe('');
    // three plans, two unnamed: it counts the plans and asks for the two
    const third = plan('claude-x@example.com', { label: 'x@example.com', email: 'x@example.com' });
    expect(unnamedPlans([personal, named, third])).toEqual([{ vendor: 'anthropic', vendorName: 'Claude', count: 3, plans: [personal, third] }]);
  });

  test('suggestions skip the names other plans have', () => {
    const s = shortNameSuggestions([plan('a', { label: 'chat@example.com', email: 'chat@example.com' }), codex]);
    expect(s.get('a')).toBe('example');
    expect(s.has(codex.id)).toBe(false);
    expect(takenPrefixes([codex, neu], neu.id)).toEqual(['chat']);
  });
});

describe('the field on a plan row', () => {
  test('a named plan shows its name and how to remove it', () => {
    const html = renderToStaticMarkup(<ShortNameRow a={{ ...neu, prefix: 'neu' }} all={[neu]} onSaved={() => {}} />);
    expect(html).toContain('Short name');
    expect(html).toContain('Ids also as neu/, so Conclave can pick this plan. Empty removes it.');
    expect(html).toContain('value="neu"');
  });

  test('a plan without one starts from the suggestion', () => {
    const html = renderToStaticMarkup(<ShortNameRow a={personal} all={[personal]} suggestion="kai" onSaved={() => {}} />);
    expect(html).toContain('Lets Conclave pick this plan (Refusal fallback, Window starter).');
    expect(html).toContain('value="kai"');
  });

  test('the starter and refusal hints point here', () => {
    expect(starterLine({ enabled: true, start: '07:00', end: '22:30', zone: 'UTC', state: 'setup', reason: 'Cannot pin a request to it' }).text).toBe('Cannot reach this account alone. Give it a short name in Settings > Models > Accounts.');
  });
});

describe('Save', () => {
  const sent: Array<[string, string]> = [];
  beforeAll(async () => {
    await connectClient({ baseUrl: 'http://hub.test', token: 't' });
    Object.assign(api(), {
      setAccountPrefix: async (id: string, prefix: string) => {
        sent.push([id, prefix]);
        return status([{ ...neu, ...(prefix ? { prefix } : {}) }]);
      },
    });
  });

  test('sends the name, trimmed and in lowercase, and gives back the new list', async () => {
    const after = await saveShortName(neu, ' Neu ', [personal, neu]);
    expect(sent).toEqual([[neu.id, 'neu']]);
    expect(after.accounts[0].prefix).toBe('neu');
  });

  test('empty removes it', async () => {
    await saveShortName({ ...neu, prefix: 'neu' }, '', [neu]);
    expect(sent.at(-1)).toEqual([neu.id, '']);
  });

  test("a name that does not fit, or another plan's, is refused here and never sent", async () => {
    const before = sent.length;
    await expect(saveShortName(neu, 'neu/work', [neu])).rejects.toThrow('Use 1 to 24 lowercase letters, digits and dashes.');
    await expect(saveShortName(neu, 'chat', [neu, codex])).rejects.toThrow('Another plan already has the short name chat.');
    // its own name is not another plan's
    await saveShortName({ ...neu, prefix: 'neu' }, 'neu', [{ ...neu, prefix: 'neu' }]);
    expect(sent.length).toBe(before + 1);
  });
});
