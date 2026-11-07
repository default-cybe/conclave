/**
 * Seeded leak check: a hub that holds someone's name (a restored backup, or
 * another person's hub) and has not finished setup. The Hub step's name
 * field must start empty, and a member sees no name field at all.
 *
 *   cd packages/web && bun test test/onboarding-name-leak.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { useHub } from '../src/store/store';

// HubStep reads the hub's address from location when there is no saved connection
(globalThis as Record<string, unknown>).location ??= new URL('https://hub.example.com/setup/hub');
const { HubStep } = await import('../src/features/onboarding/steps/HubStep');
const { FlowCtx } = await import('../src/features/onboarding/StepLayout');
const noop = async () => undefined;
const flow = { step: 'hub' as const, go: () => undefined, next: noop, skip: noop, back: () => undefined, leave: noop, register: () => undefined, runContinue: () => undefined };
const NAME = 'Kaivalya Ahir';

function seed(role: 'owner' | 'member', onboarded: boolean) {
  // a server render reads the store's initial state (zustand getServerSnapshot), so seed that
  Object.assign(useHub.getInitialState(), {
    hub: { name: 'arch', version: '0.0.0' },
    conn: 'open',
    me: { id: role === 'owner' ? 'owner' : 'acc_dee', name: role === 'owner' ? 'owner' : 'dee', displayName: NAME, role },
    config: { ui: { name: NAME, onboarded } },
  });
  return renderToStaticMarkup(
    <FlowCtx.Provider value={flow}>
      <HubStep />
    </FlowCtx.Provider>,
  );
}

describe('the Hub step on a hub that already holds a name', () => {
  test('first setup: the name field starts empty', () => {
    const out = seed('owner', false);
    expect(out).toContain('autoComplete="name"');
    expect(out).not.toContain(NAME);
  });

  test('a member gets no name field and sees no name', () => {
    const out = seed('member', false);
    expect(out).not.toContain('autoComplete="name"');
    expect(out).not.toContain(NAME);
  });

  test('setup run again on a set up hub shows the owner their own name', () => {
    expect(seed('owner', true)).toContain(`value="${NAME}"`);
  });
});
