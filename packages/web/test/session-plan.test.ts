/**
 * The plan under the context ring (lib/accounts.ts sessionPlan): which plan
 * or key a session's model runs on, why, and the others that serve it, as
 * core AccountsService.accountFor picks it.
 */
import { describe, expect, test } from 'bun:test';
import type { AccountDto, AccountsStatus } from '@conclave/core/client';
import { sessionPlan } from '../src/lib/accounts';

const OPUS = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', vendor: 'anthropic' };
const acct = (a: Partial<AccountDto> & Pick<AccountDto, 'id'>): AccountDto => ({ label: a.id, vendor: 'anthropic', vendorName: 'Claude', kind: 'subscription', enabled: true, state: 'ready', windows: [], models: [OPUS], saved: true, ...a });

const personal = acct({ id: 'personal', prefix: 'personal-claude', plan: 'Max 20x' });
const neu = acct({ id: 'neu', prefix: 'neu-claude', plan: 'Pro' });
const gemini = acct({ id: 'backup', vendor: 'gemini', vendorName: 'Gemini', prefix: 'backup-gemini', models: [{ id: 'backup-gemini/claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', vendor: 'anthropic' }] });
const key = acct({ id: 'api-anthropic', kind: 'api', provider: 'anthropic', label: 'Anthropic key', models: [] });
const zai = acct({ id: 'api-zai', kind: 'api', provider: 'zai', vendor: 'zai', vendorName: 'GLM', label: 'Z.ai Coding Plan', subscription: 'zai-coding', models: [{ id: 'glm-5.3', name: 'GLM-5.3', vendor: 'zai' }] });

const status = (routes: AccountsStatus['routes'] = [{ vendor: 'anthropic', vendorName: 'Claude', order: ['personal', 'neu', 'api-anthropic'] }]): Pick<AccountsStatus, 'accounts' | 'routes'> => ({ accounts: [personal, neu, gemini, key, zai], routes });
const ids = (as: AccountDto[]) => as.map((a) => a.id);

describe('which plan a session runs on', () => {
  test('an id without a prefix: the first ready plan in the order, the rest that serve it after', () => {
    const p = sessionPlan('cliproxy/claude-opus-5-5', undefined, 'cliproxy/claude-opus-5-5', status())!;
    expect(p.current?.id).toBe('personal');
    expect(p.pinned).toBe(false);
    expect(p.reason).toEqual({ kind: 'default' });
    // another vendor's plan that lists a variant (Antigravity) serves it too; the key comes last
    expect(ids(p.others)).toEqual(['neu', 'backup', 'api-anthropic']);
  });

  test('a plan at its limit is passed over for the next ready one', () => {
    const s = status();
    s.accounts = s.accounts.map((a) => (a.id === 'personal' ? { ...a, state: 'limited' as const } : a));
    expect(sessionPlan('cliproxy/claude-opus-5-5', undefined, undefined, s)!.current?.id).toBe('neu');
  });

  test('a per model order wins over the vendor order', () => {
    const p = sessionPlan('cliproxy/claude-opus-5-5', undefined, undefined, status([{ vendor: 'anthropic', vendorName: 'Claude', order: ['personal', 'neu'] }, { vendor: 'anthropic', vendorName: 'Claude', match: 'claude-opus-*', order: ['neu', 'personal'] }]))!;
    expect(p.current?.id).toBe('neu');
  });

  test('a prefix pins the plan, whatever the order', () => {
    const p = sessionPlan('cliproxy/backup-gemini/claude-opus-5-5-high', undefined, 'cliproxy/claude-opus-5-5', status())!;
    expect(p.current?.id).toBe('backup');
    expect(p.pinned).toBe(true);
    expect(p.reason).toEqual({ kind: 'picked' });
    expect(ids(p.others)).toEqual(['personal', 'neu', 'api-anthropic']);
  });

  test('a key on its own provider (the Z.ai Coding Plan)', () => {
    const p = sessionPlan('zai/glm-5.3', undefined, undefined, status())!;
    expect(p.current?.id).toBe('api-zai');
    expect(p.pinned).toBe(true);
    expect(p.others).toEqual([]);
  });

  test('why: a sticky usage fallback, then an account failover, each only for the model it moved to', () => {
    const fb = { limitFallback: { from: 'cliproxy/claude-opus-5-5', to: 'zai/glm-5.3', at: 1 } };
    expect(sessionPlan('zai/glm-5.3', fb, 'cliproxy/claude-opus-5-5', status())!.reason).toEqual({ kind: 'fallback', from: 'cliproxy/claude-opus-5-5' });
    const sw = { limitSwitch: { from: 'cliproxy/personal-claude/claude-opus-5-5', to: 'cliproxy/neu-claude/claude-opus-5-5', at: 1 } };
    const r = sessionPlan('cliproxy/neu-claude/claude-opus-5-5', sw, undefined, status())!.reason;
    expect(r.kind === 'switched' && [r.from, r.was?.id]).toEqual(['cliproxy/personal-claude/claude-opus-5-5', 'personal']);
    // the owner picked another model since: the old record no longer explains it
    expect(sessionPlan('cliproxy/claude-opus-5-5', fb, 'cliproxy/claude-opus-5-5', status())!.reason).toEqual({ kind: 'default' });
  });

  test('a full window for this model only (7d opus) passes the plan over, though its state says ready', () => {
    const s = status();
    const now = Date.UTC(2026, 9, 26);
    s.accounts = s.accounts.map((a) => (a.id === 'personal' ? { ...a, windows: [{ name: '7d opus', kind: 'weekly' as const, usedPercent: 100, resetsAt: now + 3_600_000 }] } : a));
    expect(sessionPlan('cliproxy/claude-opus-5-5', undefined, undefined, s, now)!.current?.id).toBe('neu');
    // a Sonnet call is not limited by it
    const sonnet = { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'anthropic' };
    s.accounts = s.accounts.map((a) => (a.vendor === 'anthropic' ? { ...a, models: [...a.models, sonnet] } : a));
    expect(sessionPlan('cliproxy/claude-sonnet-5', undefined, undefined, s, now)!.current?.id).toBe('personal');
    // nor once it resets, nor by a cooldown on another model; a cooldown on this one does
    expect(sessionPlan('cliproxy/claude-opus-5-5', undefined, undefined, s, now + 7_200_000)!.current?.id).toBe('personal');
    s.accounts = s.accounts.map((a) => (a.id === 'personal' ? { ...a, windows: [], cooldowns: [{ model: 'claude-sonnet-5', reason: 'quota', until: now + 60_000 }] } : a));
    expect(sessionPlan('cliproxy/claude-opus-5-5', undefined, undefined, s, now)!.current?.id).toBe('personal');
    s.accounts = s.accounts.map((a) => (a.id === 'personal' ? { ...a, cooldowns: [{ model: 'claude-opus-5-5', reason: 'quota', until: now + 60_000 }] } : a));
    expect(sessionPlan('cliproxy/claude-opus-5-5', undefined, undefined, s, now)!.current?.id).toBe('neu');
  });

  test('moved off a bare ref: the plan that hit its limit, not the one it runs on now', () => {
    const s = status();
    s.accounts = s.accounts.map((a) => (a.id === 'personal' ? { ...a, state: 'limited' as const } : a));
    const sw = { limitSwitch: { from: 'cliproxy/claude-opus-5-5', to: 'cliproxy/neu-claude/claude-opus-5-5', at: 1 } };
    // the bare ref's first ready plan is neu, the one it moved to: it left personal, the plan not ready for it
    const r = sessionPlan('cliproxy/neu-claude/claude-opus-5-5', sw, undefined, s)!.reason;
    expect(r.kind === 'switched' && r.was?.id).toBe('personal');
    // every plan ready again: the first in the order
    const back = sessionPlan('cliproxy/neu-claude/claude-opus-5-5', sw, undefined, status())!.reason;
    expect(back.kind === 'switched' && back.was?.id).toBe('personal');
  });

  test('a provider other than the gateway runs on its own key or on nothing: no plan, no prefix', () => {
    expect(sessionPlan('vertex/claude-opus-5-5', undefined, undefined, status())).toBeUndefined();
    expect(sessionPlan('openrouter/anthropic/claude-opus-5', undefined, undefined, status())).toBeUndefined();
    const s = status();
    s.accounts = [...s.accounts, acct({ id: 'api-or', kind: 'api', provider: 'openrouter', label: 'OpenRouter key', models: [] })];
    const p = sessionPlan('openrouter/anthropic/claude-opus-5-5', undefined, undefined, s)!;
    expect(p.current?.id).toBe('api-or');
    expect(p.pinned).toBe(true);
  });

  test('a signed in plan whose model list is not read yet serves its vendor', () => {
    const s = status();
    s.accounts = s.accounts.map((a) => (a.id === 'personal' ? { ...a, models: [] } : a));
    const p = sessionPlan('cliproxy/claude-opus-5-5', undefined, undefined, s)!;
    expect(p.current?.id).toBe('personal');
    // another vendor's plan with no list does not
    s.accounts = s.accounts.map((a) => (a.id === 'backup' ? { ...a, models: [] } : a));
    expect(ids(sessionPlan('cliproxy/claude-opus-5-5', undefined, undefined, s)!.others)).toEqual(['neu', 'api-anthropic']);
  });

  test('nothing for a harness, a model no plan or key serves, or before the accounts load', () => {
    expect(sessionPlan('claude-code', undefined, undefined, status())).toBeUndefined();
    expect(sessionPlan('ollama/llama-5', undefined, undefined, status())).toBeUndefined();
    expect(sessionPlan('cliproxy/claude-opus-5-5', undefined, undefined, undefined)).toBeUndefined();
  });
});
