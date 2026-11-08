/**
 * The folder field asks the device before Use (features/chat/folderCheck.tsx):
 * a path that is not there shows "No folder at <path> on <device>", keeps
 * Use off and offers Create folder; a recent folder that is gone is marked
 * "missing"; an offline device says it cannot be checked and waits for
 * "Use anyway". Mounted on linkedom with the folder chip.
 *
 *   cd packages/web && bun test test/folder-check.test.tsx
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { api, connectClient } from '../src/lib/api';
import { useHub } from '../src/store/store';

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

const there = new Set(['/home/kai/code/conclave']);
const made: string[] = [];

beforeAll(async () => {
  const req = createRequire(join(import.meta.dir, '../../core/package.json'));
  const { parseHTML } = req('linkedom');
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  const win = dom.window;
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
  Object.assign(api(), {
    folderCheck: async (_d: string, path: string) => ({ path, exists: there.has(path) }),
    makeFolder: async (_d: string, path: string) => (made.push(path), there.add(path), { path, exists: true }),
  });
  useHub.setState({
    devices: {
      local: { id: 'local', name: 'madx', online: true },
      arch: { id: 'arch', name: 'arch-desktop', online: false, info: { platform: 'linux' } },
    },
    sessions: {
      s1: { id: 's1', kind: 'agent', device: 'local', cwd: '/home/kai/code/conclave', updatedAt: 2 },
      s2: { id: 's2', kind: 'agent', device: 'local', cwd: '/home/kai/code/old-tool', updatedAt: 1 },
    },
    config: {},
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

/** The chip opened on a path (it fills the field from cwd, as a typed path would). */
async function chip(device: string, cwd?: string) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { FolderChip } = await import('../src/features/home/Where');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const picked: string[] = [];
  await act(async () => root.render(<FolderChip device={device} cwd={cwd} onCwd={(c) => picked.push(c)} open onOpenChange={() => {}} />));
  await act(async () => Bun.sleep(320));
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
  const note = () => document.querySelector('[data-folder-check]');
  return { act, picked, button, note, unmount: async () => (await act(async () => root.unmount()), host.remove()) };
}

describe('the folder field', () => {
  test('a path not on the device: the error under the field, Use off, Create folder makes it', async () => {
    const v = await chip('local', '/home/kai/does-not-exist');
    expect(v.note()?.textContent).toContain('No folder at /home/kai/does-not-exist on madx');
    expect(v.button('Use')?.getAttribute('aria-disabled')).toBe('true');
    await v.act(async () => v.button('Use')!.click());
    expect(v.picked).toEqual([]);
    await v.act(async () => v.button('Create folder')!.click());
    expect(made).toEqual(['/home/kai/does-not-exist']);
    expect(v.note()).toBeNull();
    expect(v.button('Use')?.getAttribute('aria-disabled')).toBeNull();
    await v.unmount();
  });

  test('a recent folder that is gone is marked missing and cannot be picked', async () => {
    const v = await chip('local');
    await v.act(async () => Bun.sleep(20));
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Recent folders"] [role=option]')];
    const old = rows.find((r) => r.textContent?.includes('old-tool'))!;
    const good = rows.find((r) => r.textContent?.includes('conclave'))!;
    expect(old.textContent).toContain('missing');
    expect(old.getAttribute('aria-disabled')).toBe('true');
    expect(good.textContent).not.toContain('missing');
    await v.act(async () => old.click());
    expect(v.picked).toEqual([]);
    await v.act(async () => good.click());
    expect(v.picked).toEqual(['/home/kai/code/conclave']);
    await v.unmount();
  });

  test('an offline device cannot be checked: Use waits for Use anyway', async () => {
    const v = await chip('arch', '~/code/anything');
    expect(v.note()?.textContent).toContain("arch-desktop is offline, the folder can't be checked");
    expect(v.button('Use')?.getAttribute('aria-disabled')).toBe('true');
    await v.act(async () => v.button('Use anyway')!.click());
    expect(v.button('Use')?.getAttribute('aria-disabled')).toBeNull();
    await v.unmount();
  });
});
