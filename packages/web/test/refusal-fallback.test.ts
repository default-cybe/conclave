/**
 * Refusal fallback in the web app (features/settings/refusal.tsx,
 * features/chat/TryNextModel.tsx): where the list lives in Settings, which
 * accounts a step can pick, the notice that offers the next model, and a
 * refused reply leaving the transcript when the hub drops it.
 *
 *   cd packages/web && bun test test/refusal-fallback.test.ts
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { AccountDto } from '@conclave/core/client';
import type { EngineEvent, Message } from '@conclave/core/types';
import { groupSections, searchSections, SETTINGS_GROUPS } from '../src/features/settings/nav';
import { defaultRoute, looseAccount, vendorOfRef } from '../src/features/settings/refusal';
import { offersNextModel } from '../src/features/chat/TryNextModel';
import { applyEvent, stopLive, useHub } from '../src/store/store';

const acct = (id: string, extra: Partial<AccountDto> = {}): AccountDto => ({ id, label: id, vendor: 'anthropic', vendorName: 'Claude', kind: 'subscription', enabled: true, state: 'ready', windows: [], models: [], saved: true, ...extra });
const notice = (meta: Record<string, unknown>): Message => ({ id: 'n1', sessionId: 's1', seq: 3, role: 'assistant', kind: 'notice', content: [{ type: 'text', text: 'The model refused to continue.' }], createdAt: 1, meta });

describe('Refusal fallback in Settings', () => {
  test('it sits under Models, and "safety priority" finds it', () => {
    expect(SETTINGS_GROUPS.find((g) => g.label === 'Models')!.ids).toEqual(['providers', 'subscriptions', 'accounts', 'refusal', 'defaults']);
    const sections = [
      { id: 'accounts', label: 'Accounts', desc: 'Which plan or key takes each call.' },
      { id: 'refusal', label: 'Refusal fallback', desc: 'When a model refuses, the same messages go to the next model on your list. Your words are never changed.' },
    ];
    expect(searchSections(sections, 'safety priority').map((s) => s.id)).toEqual(['refusal']);
    expect(groupSections(sections).find((g) => g.label === 'Models')!.items.map((s) => s.id)).toEqual(['accounts', 'refusal']);
  });

  test('a step picks accounts of the model maker; a plan without a prefix next to another plan is not pinned', () => {
    expect(vendorOfRef('cliproxy/claude-opus-5-5')).toBe('anthropic');
    expect(vendorOfRef('cliproxy/neu/claude-opus-5-5')).toBe('anthropic');
    expect(vendorOfRef('cliproxy/gpt-6-astra')).toBe('openai');
    expect(vendorOfRef('google/gemini-3-pro')).toBe('gemini');
    expect(vendorOfRef('zai/glm-5.3')).toBe('zai');
    const personal = acct('personal');
    const neu = acct('neu', { prefix: 'neu' });
    const key = acct('api-anthropic', { kind: 'api' });
    expect(looseAccount(personal, [personal, neu, key])).toBe(true);
    expect(looseAccount(neu, [personal, neu, key])).toBe(false);
    expect(looseAccount(personal, [personal, key])).toBe(false);
    expect(looseAccount(key, [personal, neu, key])).toBe(false);
  });
});

describe('a step with no account set', () => {
  test('a gateway model follows the account order; an API model names its own key', () => {
    expect(defaultRoute('cliproxy/claude-opus-5-5', []).label).toBe('Your order');
    expect(defaultRoute('zai/glm-5.3', []).label).toBe('Z.ai API key');
    expect(defaultRoute('zai/glm-5.3', []).detail).toContain('own key');
    const key = acct('api-zai', { kind: 'api', provider: 'zai', vendor: 'zai', label: 'Z.ai work key' });
    expect(defaultRoute('zai/glm-5.3', [key]).label).toBe('Z.ai work key');
  });
});

describe('the refused reply', () => {
  beforeEach(() => stopLive());

  test('only a refusal notice the hub marked offers the next model', () => {
    expect(offersNextModel(notice({ type: 'refusal', canTryNext: true }))).toBe(true);
    expect(offersNextModel(notice({ type: 'refusal', canTryNext: false }))).toBe(false);
    expect(offersNextModel(notice({ type: 'refusal', outcome: 'exhausted' }))).toBe(false);
    expect(offersNextModel(notice({ type: 'switch' }))).toBe(false);
    expect(offersNextModel({ ...notice({ type: 'refusal', canTryNext: true }), kind: 'normal' })).toBe(false);
  });

  test('a reply the hub drops (message.deleted) leaves the transcript', () => {
    let seq = 0;
    const send = (e: EngineEvent) => applyEvent({ ...e, seq: ++seq, ts: 1000 + seq } as Parameters<typeof applyEvent>[0]);
    const reply: Message = { id: 'r1', sessionId: 's9', seq: 2, role: 'assistant', kind: 'normal', content: [{ type: 'text', text: 'I can not help with that.' }], createdAt: 2, stopReason: 'refusal' };
    send({ type: 'message.created', message: { id: 'u1', sessionId: 's9', seq: 1, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'hi' }], createdAt: 1 } });
    send({ type: 'message.created', message: reply });
    expect(useHub.getState().messages.s9.map((m) => m.id)).toEqual(['u1', 'r1']);
    send({ type: 'message.deleted', sessionId: 's9', messageId: 'r1' });
    expect(useHub.getState().messages.s9.map((m) => m.id)).toEqual(['u1']);
    // an unknown id changes nothing
    const before = useHub.getState().messages;
    send({ type: 'message.deleted', sessionId: 's9', messageId: 'nope' });
    expect(useHub.getState().messages).toBe(before);
  });
});
