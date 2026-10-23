/**
 * "Use when a model refuses" in the web app: the switch on each plan and key
 * in Settings > Models > Accounts (features/settings/accounts.tsx
 * RefusalRow), off without CLIProxyAPI's management key for a plan, the
 * line at the top of Refusal fallback (lib/accounts.ts refusalMarkedLine),
 * and the mock hub, which names a plan as the hub does.
 *
 *   cd packages/web && bun test test/refusal-mark.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountDto, AccountsStatus } from '@conclave/core/client';
import { MANAGEMENT_NOTE, REFUSAL_HINT, refusalMarkedLine } from '../src/lib/accounts';
import { RefusalRow } from '../src/features/settings/accounts';
import { registerAccounts } from '../src/mock/accounts';

const acct = (id: string, extra: Partial<AccountDto> = {}): AccountDto => ({ id, label: id, vendor: 'anthropic', vendorName: 'Claude', kind: 'subscription', credential: `${id}.json`, enabled: true, state: 'ready', windows: [], models: [], saved: true, ...extra });

describe('the switch on a row', () => {
  test('a plan: on and off with the hint; without the management key it is off with the short name note', () => {
    const plan = acct('claude-kai@kaivalya.dev', { label: 'kai@kaivalya.dev' });
    const html = renderToStaticMarkup(<RefusalRow a={plan} management onSaved={() => {}} />);
    expect(html).toContain('Use when a model refuses');
    expect(html).toContain(REFUSAL_HINT);
    expect(html).toBe(html.replace(/disabled=""/g, ''));
    expect(html).toMatch(/aria-checked="true"[^>]*>Off</);
    const on = renderToStaticMarkup(<RefusalRow a={{ ...plan, refusal: true, prefix: 'kai' }} management onSaved={() => {}} />);
    expect(on).toMatch(/aria-checked="true"[^>]*>On</);
    const off = renderToStaticMarkup(<RefusalRow a={plan} management={false} onSaved={() => {}} />);
    expect(off).toContain(MANAGEMENT_NOTE.replace("'", '&#x27;'));
    expect(off).not.toContain(REFUSAL_HINT);
    expect(off.match(/disabled=""/g)?.length).toBe(2);
    expect(off).not.toContain('—');
  });

  test('an API key needs no management key', () => {
    const key = acct('api-anthropic', { kind: 'api', label: 'Claude API key', credential: undefined, provider: 'anthropic' });
    const html = renderToStaticMarkup(<RefusalRow a={key} management={false} onSaved={() => {}} />);
    expect(html).toContain(REFUSAL_HINT);
    expect(html).not.toContain('disabled=""');
  });
});

describe('the line at the top of Refusal fallback', () => {
  test('none marked: how to mark one', () => {
    const line = refusalMarkedLine({ accounts: [acct('a')], routes: [] });
    expect(line.marked).toBe(false);
    expect(line.text).toBe('No plan or key is marked yet. Turn on Use when a model refuses on one in Accounts, and a refused reply is tried there first, same model, before this list.');
  });

  test('the marked ones in Accounts order per vendor: a plan by its short name, a key by its name', () => {
    const status: Pick<AccountsStatus, 'accounts' | 'routes'> = {
      accounts: [
        acct('claude-kai@neu.edu', { prefix: 'neu' }),
        acct('claude-kai@kaivalya.dev', { prefix: 'personal-claude', refusal: true }),
        acct('api-anthropic', { kind: 'api', label: 'Claude API key', refusal: true }),
        acct('codex-kai@kaivalya.dev', { vendor: 'openai', vendorName: 'ChatGPT', prefix: 'chat', refusal: true }),
      ],
      routes: [
        { vendor: 'anthropic', vendorName: 'Claude', order: ['claude-kai@neu.edu', 'api-anthropic', 'claude-kai@kaivalya.dev'] },
        { vendor: 'openai', vendorName: 'ChatGPT', order: ['codex-kai@kaivalya.dev'] },
      ],
    };
    expect(refusalMarkedLine(status)).toEqual({ marked: true, text: 'Tried first: Claude API key and personal-claude on Claude; chat on ChatGPT.' });
    expect(refusalMarkedLine({ accounts: [status.accounts[1]], routes: [] }).text).toBe('Tried first: personal-claude on Claude.');
  });
});

describe('the mock hub', () => {
  type Handler = (p: { params: string[]; body: unknown }) => unknown;
  function hub() {
    const routes: Array<[string, RegExp, Handler]> = [];
    const ctx = {
      on: (m: string, path: string, h: Handler) => routes.push([m, new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h]),
      emit: () => undefined,
      sleep: async () => undefined,
      fail: (status: number, msg: string): never => {
        throw Object.assign(new Error(msg), { status });
      },
      FRESH: false,
      db: { limits: new Map() },
    };
    registerAccounts(ctx as never);
    return async (method: string, path: string, body?: unknown) => {
      for (const [m, re, h] of routes) {
        const match = m === method ? re.exec(path) : null;
        if (match) return (await h({ params: match.slice(1), body })) as AccountsStatus;
      }
      throw new Error(`no route ${method} ${path}`);
    };
  }

  test('turning it on for a plan without a short name names it, as the hub does; off keeps the name', async () => {
    const call = hub();
    const id = 'claude-kai@kaivalya.dev';
    const before = (await call('GET', '/api/accounts')).accounts.find((a) => a.id === id)!;
    expect(before.prefix).toBeUndefined();
    const on = (await call('PATCH', `/api/accounts/${encodeURIComponent(id)}`, { refusal: true })).accounts.find((a) => a.id === id)!;
    expect(on).toMatchObject({ refusal: true, prefix: 'personal' });
    const off = (await call('PATCH', `/api/accounts/${encodeURIComponent(id)}`, { refusal: false })).accounts.find((a) => a.id === id)!;
    expect(off.refusal).toBeUndefined();
    expect(off.prefix).toBe('personal');
  });
});
