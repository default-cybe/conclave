/**
 * Setup's first choice (features/onboarding/branch.ts): a hub or a client,
 * and the name the Hub step starts with.
 *
 *   bun test packages/web/test/onboarding-branch.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchChoices, branchTarget, hubIsHere, startingName } from '../src/features/onboarding/branch';
import { LATER, STEPS, pageFor, stepHref } from '../src/features/onboarding/steps';
import { finishedOldSetup, laterLeft } from '../src/features/onboarding/progress';
import { keyDefaults, modelUsable, providerReady } from '../src/lib/providers';
import type { ModelGroup } from '@conclave/core/client';
import type { HubConfig } from '../src/store/store';

// what GET /api/config returns on a new hub: the schema's defaults, whatever is connected
const SCHEMA = { defaultModel: 'anthropic/claude-sonnet-5-5', smallModel: 'anthropic/claude-haiku-5-5' };
const model = (provider: string, id: string, tier?: 'fast' | 'smart' | 'deep', unavailable?: string) => ({ id, ref: `${provider}/${id}`, provider, name: id, tier, unavailable });
const group = (provider: string, configured: boolean, models: ReturnType<typeof model>[], error?: string) => ({ provider, name: provider, type: provider, configured, enabled: true, models, error });
// only an OpenAI key, tested OK; Anthropic is listed from the catalog without a key
const KEY_ONLY = [
  group('anthropic', false, [model('anthropic', 'claude-sonnet-5-5', 'smart'), model('anthropic', 'claude-haiku-5-5', 'fast')]),
  group('openai', true, [model('openai', 'gpt-5.6', 'deep'), model('openai', 'gpt-5.6-terra', 'smart'), model('openai', 'gpt-5.6-luna', 'fast')]),
] as unknown as ModelGroup[];
const factsFor = (config: Record<string, unknown>, groups: ModelGroup[]) => ({ defaultUsable: modelUsable(config.defaultModel, providerReady(groups)), imported: 0, devices: [], channels: [], routines: 0, logins: [] });

describe('four steps', () => {
  test('Welcome, Hub, Connect a model, Make it yours', () => {
    expect(STEPS.map((s) => s.name)).toEqual(['Welcome', 'Hub', 'Connect a model', 'Make it yours']);
    expect(stepHref('welcome')).toBe('/welcome');
    expect(stepHref('model')).toBe('/setup/model');
  });

  test('every old step URL still opens a page', () => {
    for (const old of ['hub', 'subscriptions', 'providers', 'extensions', 'agents', 'defaults', 'modes', 'memory', 'import', 'devices', 'notifications', 'routines', 'done']) expect(pageFor(old)).toBeDefined();
    expect(pageFor('subscriptions')).toBe('model');
    expect(pageFor('providers')).toBe('model');
    expect(pageFor('memory')).toBe('yours');
    expect(pageFor('done')).toBe('yours');
    expect(pageFor('routines')).toBe('routines');
    expect(pageFor('nope')).toBeUndefined();
  });

  test('Set up later lists what is not done yet', () => {
    const none = factsFor(SCHEMA, KEY_ONLY);
    expect(laterLeft(none, []).map((s) => s.id)).toEqual(LATER.map((s) => s.id));
    const some = { ...factsFor({ defaultModel: 'openai/gpt-5.6-terra' }, KEY_ONLY), routines: 2, channels: ['Phone'] };
    expect(laterLeft(some, ['extensions']).map((s) => s.id)).toEqual(['agents', 'import', 'devices']);
  });

  test('a default model that cannot run shows the Defaults card; one that can hides it', () => {
    expect(laterLeft(factsFor(SCHEMA, KEY_ONLY), []).map((s) => s.id)).toContain('defaults');
    expect(laterLeft(factsFor({ defaultModel: 'openai/gpt-5.6-terra' }, KEY_ONLY), []).map((s) => s.id)).not.toContain('defaults');
    // a key the provider rejected does not count
    const rejected = [group('openai', true, [], 'HTTP 401')] as unknown as ModelGroup[];
    expect(laterLeft(factsFor({ defaultModel: 'openai/gpt-5.6-terra' }, rejected), []).map((s) => s.id)).toContain('defaults');
    // finishing the Defaults page counts too
    expect(laterLeft(factsFor(SCHEMA, KEY_ONLY), ['defaults']).map((s) => s.id)).not.toContain('defaults');
  });

  test('with only an API key, Continue sets defaults that can run', () => {
    const ready = providerReady(KEY_ONLY);
    const next = keyDefaults(KEY_ONLY, SCHEMA, ready);
    expect(next).toEqual({ defaultModel: 'openai/gpt-5.6-terra', smallModel: 'openai/gpt-5.6-luna' });
    expect(modelUsable(next?.defaultModel, ready)).toBe(true);
    expect(laterLeft(factsFor({ ...SCHEMA, ...next }, KEY_ONLY), []).map((s) => s.id)).not.toContain('defaults');
    // defaults that already run stay; no working provider changes nothing
    expect(keyDefaults(KEY_ONLY, { defaultModel: 'openai/gpt-5.6', smallModel: 'openai/gpt-5.6-luna' }, ready)).toBeUndefined();
    expect(keyDefaults([KEY_ONLY[0]], SCHEMA, providerReady([KEY_ONLY[0]]))).toBeUndefined();
    // a default the owner's plan runs (merged entry, sameAs) stays, and counts as usable
    const plan = [
      group('anthropic', false, [{ ...model('anthropic', 'claude-sonnet-5-5', 'smart'), sameAs: 'cliproxy/claude-sonnet-5-5' }, { ...model('anthropic', 'claude-haiku-5-5', 'fast'), sameAs: 'cliproxy/claude-haiku-5-5' }]),
      group('cliproxy', true, [model('cliproxy', 'claude-sonnet-5-5', 'smart'), model('cliproxy', 'claude-haiku-5-5', 'fast')]),
      group('ollama', true, [model('ollama', 'llama-4')]),
    ] as unknown as ModelGroup[];
    expect(keyDefaults(plan, SCHEMA, providerReady(plan))).toBeUndefined();
    expect(modelUsable(SCHEMA.defaultModel, providerReady(plan), plan)).toBe(true);
    // a key whose listing failed for a moment keeps the owner's choice
    const flaky = [group('anthropic', true, [], 'timeout'), ...KEY_ONLY.slice(1)] as unknown as ModelGroup[];
    expect(keyDefaults(flaky, SCHEMA, providerReady(flaky))).toBeUndefined();
    // a model the plan refused is never picked
    const refused = [group('openai', true, [model('openai', 'gpt-5.6-terra', 'smart', 'HTTP 404'), model('openai', 'gpt-5.4', 'smart'), model('openai', 'gpt-5.4-mini', 'fast')])] as unknown as ModelGroup[];
    expect(keyDefaults(refused, SCHEMA, providerReady(refused))?.defaultModel).toBe('openai/gpt-5.4');
  });

  test('a hub that finished the thirteen step setup hides the list', () => {
    const old = { ui: { onboarded: true, onboardingSteps: ['hub', 'subscriptions', 'providers', 'defaults', 'memory', 'done'] }, setup: { completedAt: 1 } } as HubConfig;
    expect(finishedOldSetup(old)).toBe(true);
    // the four step setup writes only new ids
    expect(finishedOldSetup({ ui: { onboardingSteps: ['hub', 'model', 'yours'] }, setup: { completedAt: 1 } } as HubConfig)).toBe(false);
    // an old setup left halfway is not finished
    expect(finishedOldSetup({ ui: { onboardingSteps: ['hub', 'subscriptions'] } } as HubConfig)).toBe(false);
  });
});

describe('hub or client', () => {
  test('a hub on this computer is the hub branch only', () => {
    for (const a of ['http://127.0.0.1:7717', 'http://localhost:7717/', 'http://[::1]:7717']) {
      expect(hubIsHere(a)).toBe(true);
      expect(branchChoices(a)).toEqual(['hub']);
    }
  });

  test('a hub elsewhere offers both, the hub first', () => {
    for (const a of ['https://quiet-river-lamp.trycloudflare.com', 'http://192.168.0.20:7717', 'https://hub.example.com', undefined, 'not a url']) {
      expect(hubIsHere(a)).toBe(false);
      expect(branchChoices(a)).toEqual(['hub', 'client']);
    }
  });

  test('the hub branch runs setup; the client branch is the Connect screen', () => {
    expect(branchTarget('hub')).toBe('/setup/hub');
    expect(branchTarget('client')).toBe('/connect');
  });

  test('the Hub step offers no way to connect to another hub', () => {
    const src = readFileSync(join(import.meta.dir, '../src/features/onboarding/steps/HubStep.tsx'), 'utf8');
    expect(src).not.toContain('ConnectForm');
    expect(src).not.toContain('Connect to another hub');
    expect(src).not.toContain('A different hub');
  });
});

describe('the name field', () => {
  const owner = (name: string, displayName?: string) => ({ name, ...(displayName ? { displayName } : {}), role: 'owner' as const });

  test('a new hub starts empty, whatever name the hub already holds', () => {
    expect(startingName(owner('owner'), false)).toBe('');
    // a restored backup or another person's hub: their name is not this person's
    expect(startingName(owner('owner', 'Kaivalya Ahir'), false)).toBe('');
    expect(startingName(owner('kai'), false)).toBe('');
    expect(startingName(undefined, false)).toBe('');
  });

  test('setup run again shows the owner their own name', () => {
    expect(startingName(owner('owner', 'Dee Okafor'), true)).toBe('Dee Okafor');
    expect(startingName(owner('owner'), true)).toBe('');
  });

  test('a member is never shown a name here', () => {
    expect(startingName({ name: 'dee', displayName: 'Dee Okafor', role: 'member' }, true)).toBe('');
  });

  test('the field has no person as its placeholder', () => {
    const src = readFileSync(join(import.meta.dir, '../src/features/onboarding/steps/HubStep.tsx'), 'utf8');
    expect(src).not.toMatch(/placeholder="[A-Z][a-z]+ [A-Z][a-z]+"/);
  });
});
