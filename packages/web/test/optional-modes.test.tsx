/**
 * Security and Canvas can be hidden per account (features/home/modes.tsx):
 * the switch's list (sidebar icons, the phone's picker and the palette's
 * mode actions all read shownModes), the line on a page of a mode that is
 * off, and Home's one-time note for an account from before the setting.
 *
 *   bun test packages/web/test/optional-modes.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { MeDto } from '@conclave/core/client';
import { modeOn, NEW_ACCOUNT_MODES } from '@conclave/core/client';
import { listedMode, shownModes } from '../src/features/home/modes';

const values = (p: Parameters<typeof shownModes>[0]) => shownModes(p).map((m) => m.value);

describe('which modes show', () => {
  test('an account from before the setting (nothing saved) sees all five', () => {
    expect(values(undefined)).toEqual(['chat', 'assistant', 'code', 'security', 'canvas']);
    expect(values({})).toEqual(['chat', 'assistant', 'code', 'security', 'canvas']);
  });
  test('a new account sees Chat, Assistant and Code', () => {
    expect(values({ modes: NEW_ACCOUNT_MODES })).toEqual(['chat', 'assistant', 'code']);
    expect(modeOn({ modes: NEW_ACCOUNT_MODES }, 'security')).toBe(false);
  });
  test('each one on its own', () => {
    expect(values({ modes: { security: true, canvas: false } })).toEqual(['chat', 'assistant', 'code', 'security']);
    expect(values({ modes: { security: false, canvas: true } })).toEqual(['chat', 'assistant', 'code', 'canvas']);
  });
  test('a hunt or Canvas opened by a link while off: the sidebar lists and starts Chat, not New hunt', () => {
    const off = { modes: NEW_ACCOUNT_MODES };
    expect(listedMode('security', off)).toBe('chat');
    expect(listedMode('canvas', off)).toBe('chat');
    expect(listedMode('code', off)).toBe('code');
    expect(listedMode('security', undefined)).toBe('security');
  });
});

test('setup has a Modes step, and the Welcome strip a column for every step (13 wrapped Done onto a row of its own)', async () => {
  const { STEPS } = await import('../src/features/onboarding/steps');
  expect(STEPS.map((s) => s.id)).toContain('modes');
  const src = readFileSync(join(import.meta.dir, '../src/features/onboarding/Welcome.tsx'), 'utf8');
  expect(src).toContain(` grid-cols-${Math.ceil(STEPS.length / 2)} `);
  expect(src).toContain(`xl:grid-cols-${STEPS.length}"`);
});

const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'];
const saved: Record<string, unknown> = {};
beforeAll(() => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  g.window = dom.window;
  g.document = dom.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  g.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

const me = (modes?: MeDto['preferences']['modes']) => ({ id: 'owner', name: 'owner', role: 'owner', people: false, hubMachine: true, passwordSet: true, providers: [], preferences: modes ? { modes } : {} }) as unknown as MeDto;

async function render(el: () => Promise<React.ReactElement>, modes?: MeDto['preferences']['modes'], path = '/') {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const { useHub } = await import('../src/store/store');
  useHub.setState({ me: me(modes) });
  const mem = memoryLocation({ path });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const node = await el();
  await act(async () => root.render(<Router hook={mem.hook}>{node}</Router>));
  const out = { text: host.textContent ?? '', labels: [...host.querySelectorAll('[role="radio"]')].map((b) => b.getAttribute('aria-label')) };
  await act(async () => root.unmount());
  host.remove();
  return out;
}

describe('the sidebar switch', () => {
  const sw = async () => {
    const { ModeSwitch } = await import('../src/features/home/ModeSwitch');
    return <ModeSwitch compact />;
  };
  test('both off: three icons', async () => {
    expect((await render(sw, { security: false, canvas: false })).labels).toEqual(['Chat', 'Assistant', 'Code']);
  });
  test('nothing saved: all five', async () => {
    expect((await render(sw)).labels).toEqual(['Chat', 'Assistant', 'Code', 'Security', 'Canvas']);
  });
});

describe('a page of a mode that is off', () => {
  const note = async () => {
    const { ModeOffNote } = await import('../src/features/home/modes');
    return <ModeOffNote mode="canvas" />;
  };
  test('a link to Canvas while it is off says so, with a way to turn it on', async () => {
    expect((await render(note, { security: true, canvas: false }, '/canvas')).text).toBe('Canvas is off in Settings.Turn it on');
  });
  test('nothing when it is on', async () => {
    expect((await render(note, { security: false, canvas: true }, '/canvas')).text).toBe('');
  });
});

describe("Home's note", () => {
  const note = async () => {
    const { ModesNote } = await import('../src/features/home/modes');
    return <ModesNote />;
  };
  test('an account from before the setting sees it once', async () => {
    expect((await render(note)).text).toContain('Security and Canvas can now be turned off in Settings, Appearance');
  });
  test('a new account, or one that saved its choice, does not', async () => {
    expect((await render(note, { security: false, canvas: false })).text).toBe('');
    expect((await render(note, { security: true, canvas: true })).text).toBe('');
  });
});
