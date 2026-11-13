/**
 * The composer's chips (design PR #292): agent, style (the session mode, with
 * Jury, Debate, Loop and Ultra under "More styles", design review #4) and memory
 * sit under the box next to the model, "+" keeps files and add-ons only, and
 * there is no status line under the box. The chips set the same session
 * fields the "+" rows set before, and every row the old "+" had is still
 * reachable. Mounted on linkedom: the chat composer, the session composer
 * and the Code start.
 *
 *   cd packages/web && bun test test/composer-chips.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import type { Session } from '@conclave/core/types';
import { api, connectClient } from '../src/lib/api';
import { useHub } from '../src/store/store';
import { memoryModeOf, memoryPatch } from '../src/features/conversation/ComposerParts';
import { DEFAULT_JURY, modePatch } from '../src/features/chat/pickers';

const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver'];
class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let win: any;

beforeAll(async () => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  win = dom.window;
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  const store = new Map<string, string>();
  win.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  win.location = { pathname: '/', search: '', hash: '' };
  g.window = win;
  g.document = dom.document;
  g.navigator = win.navigator;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.matchMedia = win.matchMedia;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  g.getComputedStyle = () => ({ getPropertyValue: () => '', lineHeight: '20px', paddingTop: '0', paddingBottom: '0' });
  g.MutationObserver = Quiet;
  g.ResizeObserver = Quiet;
  g.IntersectionObserver = Quiet;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  await connectClient({ baseUrl: 'http://hub.test', token: 't' });
  useHub.setState({
    agents: [
      { name: 'coder', description: 'Default coding agent', source: 'builtin' },
      { name: 'reviewer', description: 'Reviews diffs', source: 'user' },
    ],
    devices: {
      local: { id: 'local', name: 'madx', online: true },
      mac: { id: 'mac', name: 'MacBook', online: true, info: { platform: 'darwin' } },
    },
    hub: { defaultModel: 'anthropic/claude-sonnet-5-5' },
    config: {},
    sessions: {},
    messages: {},
  } as never);
});

afterAll(async () => {
  await Bun.sleep(300);
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

/** Every PATCH /api/sessions/:id the composer sends. */
function patches() {
  const sent: Array<Record<string, unknown>> = [];
  Object.assign(api(), {
    updateSession: async (id: string, p: Record<string, unknown>) => (sent.push(p), { ...base(), id, ...p }),
    folderGit: async () => ({ git: false }),
    browse: async () => [],
    sessionLocation: async () => ({}),
    getSession: async () => undefined,
  });
  return sent;
}

function base(over: Partial<Session> = {}): Session {
  return {
    id: 'ses_1',
    kind: 'agent',
    agent: 'coder',
    model: 'anthropic/claude-sonnet-5-5',
    device: 'local',
    cwd: '~/code/conclave',
    mode: 'agent',
    permissionMode: 'acceptEdits',
    status: 'idle',
    title: 'A session',
    createdAt: 1,
    updatedAt: 1,
    stats: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 },
    meta: { mode: 'code' },
    ...over,
  } as unknown as Session;
}

async function mount(node: ReactNode) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Router } = await import('wouter');
  const { memoryLocation } = await import('wouter/memory-location');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Router hook={memoryLocation({ path: '/' }).hook}>{node}</Router>));
  const chip = (name: string) => host.querySelector<HTMLButtonElement>(`[data-chip="${name}"]`);
  /** Open a chip or "+" (its menu is named by the button's label word) and its rows. */
  const open = async (button: HTMLElement | null) => {
    expect(button).not.toBeNull();
    if (button!.getAttribute('aria-expanded') !== 'true') await act(async () => button!.click());
    const name = button!.getAttribute('aria-label')!.split(',')[0];
    const menus = [...document.querySelectorAll(`[role=menu][aria-label="${name}"]`)];
    return [...(menus.at(-1)?.querySelectorAll('[role=menuitem],[role=menuitemcheckbox]') ?? [])];
  };
  const rowLabels = (rows: Element[]) => rows.map((r) => (r.querySelector('span.block')?.textContent ?? r.textContent ?? '').trim());
  const pick = async (rows: Element[], label: string) => {
    const row = rows.find((r) => (r.textContent ?? '').trim().startsWith(label));
    expect(row).toBeDefined();
    await act(async () => (row as HTMLElement).click());
  };
  const close = async (button: HTMLElement | null) => {
    if (button?.getAttribute('aria-expanded') === 'true') await act(async () => button.click());
  };
  const plus = () => host.querySelector<HTMLButtonElement>('button[aria-label="Add files and more"]');
  return { act, host, chip, open, rowLabels, pick, close, plus, unmount: async () => (await act(async () => root.unmount()), host.remove()) };
}

describe('memory chip words and patches', () => {
  test('Use and save, Use only, Off read from the chat switches and go back as the hub takes them', () => {
    expect(memoryModeOf(undefined)).toBe('save');
    expect(memoryModeOf({ memory: true, memorySave: false })).toBe('use');
    expect(memoryModeOf({ memory: false })).toBe('off');
    expect(memoryPatch('save')).toEqual({ memory: true, memorySave: true });
    expect(memoryPatch('use')).toEqual({ memory: true, memorySave: false });
    expect(memoryPatch('off')).toEqual({ memory: false, memorySave: true });
  });

  test('a mode picked fills that mode defaults, as "+" did', () => {
    expect(modePatch('jury')).toEqual({ mode: 'jury', modeConfig: { jury: DEFAULT_JURY } });
    expect(modePatch('plan', { loop: { untilCommand: 'x', maxIterations: 1 } })).toEqual({ mode: 'plan', modeConfig: { loop: { untilCommand: 'x', maxIterations: 1 } } });
  });
});

describe('the session composer', () => {
  test('a session in an expert style names it, and its menu opens on More styles', async () => {
    patches();
    const { Composer } = await import('../src/features/chat/Composer');
    const v = await mount(<Composer session={base({ mode: 'debate' })} />);
    expect(v.chip('style')?.textContent).toBe('Debate style');
    const rows = await v.open(v.chip('style'));
    expect(v.rowLabels(rows)).toEqual(['Agent', 'Chat', 'Plan', 'More styles', 'Jury', 'Debate', 'Loop', 'Ultra']);
    expect(rows.find((r) => r.textContent?.startsWith('Debate'))?.getAttribute('aria-checked')).toBe('true');
    // the fold still closes by hand
    await v.pick(rows, 'More styles');
    expect(v.rowLabels(await v.open(v.chip('style')))).toEqual(['Agent', 'Chat', 'Plan', 'More styles']);
    await v.close(v.chip('style'));
    await v.unmount();
  });

  test('agent, style, Ultra and memory chips set the fields the "+" rows set; "+" is the files only; no status line', async () => {
    const sent = patches();
    const { Composer } = await import('../src/features/chat/Composer');
    const v = await mount(<Composer session={base()} />);
    expect(v.host.querySelector('[data-status-line]')).toBeNull();
    expect(v.chip('model')).not.toBeNull();
    expect(v.chip('mode')).toBeNull();
    expect(v.chip('style')?.textContent).toContain('Agent style');
    expect(v.chip('memory')?.textContent).toContain('Memory');

    // "+": files only (agent, devices, modes and Ultra left it)
    expect(v.rowLabels(await v.open(v.plus()))).toEqual(['Attach files and images']);
    await v.close(v.plus());

    // agent: the default and the custom ones, as "+" listed them
    const agents = await v.open(v.chip('agent'));
    expect(v.rowLabels(agents)).toEqual(['coder', 'reviewer']);
    await v.pick(agents, 'reviewer');
    expect(sent.at(-1)).toEqual({ agent: 'reviewer' });

    // style: Agent, Chat, Plan; Jury, Debate, Loop and Ultra in the "More styles" fold
    const styles = await v.open(v.chip('style'));
    expect(document.querySelector('[role=menu][aria-label="Style"]')?.textContent).toContain('Working style');
    expect(v.rowLabels(styles)).toEqual(['Agent', 'Chat', 'Plan', 'More styles']);
    await v.pick(styles, 'More styles');
    const folded = await v.open(v.chip('style'));
    expect(v.rowLabels(folded)).toEqual(['Agent', 'Chat', 'Plan', 'More styles', 'Jury', 'Debate', 'Loop', 'Ultra']);
    await v.pick(folded, 'Jury');
    expect(sent.at(-1)).toEqual({ mode: 'jury', modeConfig: { jury: DEFAULT_JURY } });
    // a fold opened by hand shuts again with the menu
    const again = await v.open(v.chip('style'));
    expect(v.rowLabels(again)).toEqual(['Agent', 'Chat', 'Plan', 'More styles']);
    expect(again.find((r) => r.textContent === 'More styles')?.getAttribute('aria-expanded')).toBe('false');
    await v.pick(again, 'More styles');
    await v.pick(await v.open(v.chip('style')), 'Ultra');
    expect(sent.at(-1)).toEqual({ ultra: true });
    await v.close(v.chip('style'));

    // memory
    const mem = await v.open(v.chip('memory'));
    expect(v.rowLabels(mem)).toEqual(['Use and save', 'Use only', 'Off']);
    await v.pick(mem, 'Use only');
    expect(sent.at(-1)).toEqual({ chat: { memory: true, memorySave: false } });
    await v.close(v.chip('memory'));

    // devices: the chip at the left, also for the device this is (it left "+")
    expect(v.host.querySelector('[data-picker="device"]')).not.toBeNull();
    await v.unmount();
  });
});

describe('the chat composer', () => {
  test('memory is a chip, web search stays in "+", no status line', async () => {
    const sent = patches();
    const { ChatComposer } = await import('../src/features/conversation/ChatComposer');
    const chat = base({ id: 'ses_chat', kind: 'chat', mode: 'chat', meta: {}, chat: { webSearch: true, memory: true } } as Partial<Session>);
    useHub.setState({ sessions: { [chat.id]: chat } } as never);
    const v = await mount(<ChatComposer session={chat} chatId={chat.id} />);
    expect(v.host.querySelector('[data-status-line]')).toBeNull();
    expect(v.chip('agent')).toBeNull();
    expect(v.chip('style')).toBeNull();
    expect(v.rowLabels(await v.open(v.plus()))).toEqual(['Attach files and images', 'Search the web']);
    await v.close(v.plus());
    const mem = await v.open(v.chip('memory'));
    await v.pick(mem, 'Off');
    expect(sent.at(-1)).toEqual({ chat: { memory: false, memorySave: true } });
    await v.unmount();
  });
});

describe('the model chip', () => {
  test('Effort sits on top of the picker, above the search and the list, as before #298', async () => {
    const { claudeEffort } = await import('@conclave/core/providers/effort');
    const { ModelEffort } = await import('../src/features/conversation/ComposerParts');
    const before = useHub.getState().models;
    const opus = { id: 'claude-opus-5-5', ref: 'anthropic/claude-opus-5-5', provider: 'anthropic', name: 'Claude Opus 5.5', effort: claudeEffort('claude-opus-5-5') };
    useHub.setState({ models: [{ provider: 'anthropic', name: 'Anthropic', type: 'anthropic', configured: true, enabled: true, models: [opus] }] } as never);
    const v = await mount(<ModelEffort model={opus.ref} value={undefined} onModel={() => {}} onEffort={() => {}} />);
    try {
      await v.act(async () => v.chip('model')!.click());
      // document order: Effort, then the search, then the list
      const parts = [...document.querySelectorAll('[data-part="effort"], input[aria-label="Search models"], [role="listbox"][aria-label="Models"]')];
      expect(parts.map((el) => (el.getAttribute('data-part') ? 'effort' : el.tagName === 'INPUT' ? 'search' : 'list'))).toEqual(['effort', 'search', 'list']);
    } finally {
      await v.unmount();
      useHub.setState({ models: before } as never);
    }
  });

  test('Same model and Security sit behind one Settings row at the foot, which names what is on', async () => {
    const { ModelEffort } = await import('../src/features/conversation/ComposerParts');
    const before = useHub.getState().models;
    const opus = { id: 'claude-opus-5-5', ref: 'anthropic/claude-opus-5-5', provider: 'anthropic', name: 'Claude Opus 5.5' };
    useHub.setState({ models: [{ provider: 'anthropic', name: 'Anthropic', type: 'anthropic', configured: true, enabled: true, models: [opus] }] } as never);
    const v = await mount(<ModelEffort model={opus.ref} value={undefined} onModel={() => {}} onEffort={() => {}} sameModel onSameModel={() => {}} security={false} onSecurity={() => {}} />);
    try {
      await v.act(async () => v.chip('model')!.click());
      const foot = document.querySelector('[data-part="picker-settings"]')!;
      const row = foot.querySelector('button[aria-expanded]') as HTMLButtonElement;
      expect(row.getAttribute('aria-expanded')).toBe('false');
      expect(row.textContent).toBe('Settings: Same model');
      // shut: no switch takes room under the list
      expect(document.body.textContent).not.toContain('Delegate, Task and workflow agents');
      expect(document.body.textContent).not.toContain('Loads the security agent');
      await v.act(async () => row.click());
      expect(document.body.textContent).toContain('Same model for all work');
      expect(document.body.textContent).toContain('Loads the security agent');
    } finally {
      await v.unmount();
      useHub.setState({ models: before } as never);
    }
  });
});

describe('the Code start', () => {
  test('chips for agent, style with Ultra and memory; "+" keeps Work in, worktree and design direction', async () => {
    patches();
    const { ChatComposer } = await import('../src/features/conversation/ChatComposer');
    const { useSessionTarget } = await import('../src/features/home/SessionStart');
    function Start() {
      return <ChatComposer chatId="start" target={useSessionTarget('code')} />;
    }
    const v = await mount(<Start />);
    expect(v.chip('agent')?.textContent).toContain('coder');
    expect(v.chip('style')?.textContent).toContain('Agent style');
    expect(v.chip('memory')).not.toBeNull();
    const plus = v.rowLabels(await v.open(v.plus()));
    expect(plus[0]).toBe('Attach files and images');
    expect(plus).toContain('A folder');
    expect(plus).toContain('A GitHub repository');
    expect(plus).toContain('Minimal');
    for (const gone of ['coder, the default', 'Ultra', 'Use and save', 'madx (hub)', 'MacBook']) expect(plus).not.toContain(gone);
    await v.close(v.plus());
    // Ultra is in the fold, and the fold starts open while Ultra is on
    expect(v.rowLabels(await v.open(v.chip('style')))).not.toContain('Ultra');
    await v.pick(await v.open(v.chip('style')), 'More styles');
    await v.pick(await v.open(v.chip('style')), 'Ultra');
    expect(v.chip('style')?.textContent).toContain('Agent style, Ultra');
    // Ultra off keeps the fold open under it
    await v.pick(await v.open(v.chip('style')), 'Ultra');
    expect(v.chip('style')?.textContent).toBe('Agent style');
    expect(v.rowLabels(await v.open(v.chip('style')))).toContain('Ultra');
    await v.close(v.chip('style'));
    expect(v.host.querySelector('[data-picker="device"]')).not.toBeNull();
    await v.unmount();
  });
});
