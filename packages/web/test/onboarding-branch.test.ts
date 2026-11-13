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
import { laterLeft } from '../src/features/onboarding/progress';

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
    const none = { defaultModel: undefined, imported: 0, devices: [], channels: [], routines: 0, logins: [] };
    expect(laterLeft(none, []).map((s) => s.id)).toEqual(LATER.map((s) => s.id));
    const some = { ...none, defaultModel: 'a/b', routines: 2, channels: ['Phone'] };
    expect(laterLeft(some, ['extensions']).map((s) => s.id)).toEqual(['agents', 'import', 'devices']);
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
