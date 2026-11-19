/**
 * The folder menu (features/home/FolderPicker.tsx) on the folder chip: a
 * typed path is asked of the device before Use (features/chat/folderCheck.tsx),
 * a recent folder that is gone is marked "missing", an offline device waits
 * for "Use anyway"; Recent is deduped, newest first, name over muted path;
 * search filters by name and path; arrow keys, Enter and Esc work; and the
 * folder browser lists folders only, with breadcrumbs, Up and Select.
 * Mounted on linkedom.
 *
 *   cd packages/web && bun test test/folder-check.test.tsx
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ProjectDto } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { api, connectClient } from '../src/lib/api';
import { useHub } from '../src/store/store';
import { crumbs, filterFolders, folderNameOk, looksLikePath, parentPath, recentFolders, useOpenFolder } from '../src/features/home/FolderPicker';
import { setDesktop } from '../src/overlay/desktop';

const saved: Record<string, unknown> = {};
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'matchMedia', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver'];
class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const there = new Set(['/home/kai/code/conclave', '/home/kai/code', '/home/kai']);
const made: string[] = [];
const tree: Record<string, Array<{ name: string; type: 'dir' | 'file' }>> = {
  '/home/kai': [
    { name: 'code', type: 'dir' },
    { name: '.config', type: 'dir' },
    { name: 'notes.md', type: 'file' },
  ],
  '/home/kai/code': [
    { name: 'conclave', type: 'dir' },
    { name: 'site', type: 'dir' },
  ],
  '/home/kai/code/conclave': [],
};

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
  g.Event = win.Event;
  g.KeyboardEvent = win.KeyboardEvent ?? win.Event;
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
    folderCheck: async (_d: string, path: string) => ({ path, exists: there.has(path) || path.startsWith('~') }),
    makeFolder: async (_d: string, path: string) => (made.push(path), there.add(path), (tree[path] = []), { path, exists: true }),
    browse: async (_d: string, path: string) => (tree[path] ?? []).map((e) => ({ ...e, path: `${path}/${e.name}` })),
  });
  useHub.setState({
    devices: {
      local: { id: 'local', name: 'madx', online: true, info: { home: '/home/kai' } },
      arch: { id: 'arch', name: 'arch-desktop', online: false, info: { platform: 'linux' } },
    },
    sessions: {
      s1: { id: 's1', kind: 'agent', device: 'local', cwd: '/home/kai/code/conclave', updatedAt: 2 },
      s2: { id: 's2', kind: 'agent', device: 'local', cwd: '/home/kai/code/old-tool', updatedAt: 1 },
    },
    projects: {},
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

async function chip(device: string, cwd?: string) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { FolderChip } = await import('../src/features/home/Where');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const picked: string[] = [];
  let closed = 0;
  await act(async () => root.render(<FolderChip device={device} cwd={cwd} onCwd={(c) => picked.push(c)} onDevice={() => {}} open onOpenChange={(v) => !v && closed++} />));
  await act(async () => Bun.sleep(320));
  const search = () => document.querySelector<HTMLInputElement>('input[aria-label="Search folders"]')!;
  const type = async (v: string) => {
    const el = search();
    // linkedom's input events do not reach React's onChange: call it as React would
    const props = (el as unknown as Record<string, { onChange: (e: unknown) => void }>)[Object.keys(el).find((k) => k.startsWith('__reactProps$'))!];
    await act(async () => props.onChange({ target: { value: v }, currentTarget: { value: v } }));
    await act(async () => Bun.sleep(320));
  };
  const key = async (k: string) => act(async () => void search().dispatchEvent(Object.assign(new Event('keydown', { bubbles: true }), { key: k })));
  const options = () => [...document.querySelectorAll<HTMLButtonElement>('[data-folder-menu] [role=option]')];
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
  const note = () => document.querySelector('[data-folder-check]');
  return { act, picked, closed: () => closed, type, key, options, button, note, unmount: async () => (await act(async () => root.unmount()), host.remove()) };
}

describe('Recent, search and paths (pure)', () => {
  const s = (id: string, cwd: string, at: number, extra: Partial<Session> = {}) => ({ id, kind: 'agent', device: 'mac', cwd, updatedAt: at, ...extra }) as Session;
  const prj = (id: string, name: string, path: string) => ({ id, name, locations: [{ device: 'mac', path }] }) as unknown as ProjectDto;

  test('deduped, newest first, at most 8, home and chats left out; project names; path only when it adds something', () => {
    const sessions = [
      s('a', '/Users/kai/Project-1_Part2', 5),
      s('b', '~/site', 4),
      s('c', '/Users/kai/Project-1_Part2/', 3),
      s('d', '~', 9),
      s('e', '/Users/kai/chats', 10, { kind: 'chat' } as never),
      s('f', '/Users/kai/work/site', 2),
      s('g', '/srv/x', 1, { device: 'pc' }),
    ];
    const rows = recentFolders(sessions, [prj('p1', 'CSE546-SPRING-2026', '/Users/kai/Project-1_Part2')], 'mac', '/Users/kai');
    expect(rows.map((r) => r.name)).toEqual(['CSE546-SPRING-2026', 'site', 'site']);
    expect(rows[0]).toMatchObject({ path: '/Users/kai/Project-1_Part2', detail: '~/Project-1_Part2', projectId: 'p1' });
    // two "site" folders: both show their path
    expect(rows[1].detail).toBe('~/site');
    expect(rows[2].detail).toBe('~/work/site');
    const many = Array.from({ length: 12 }, (_, i) => s(`m${i}`, `~/p${i}`, 100 - i));
    const top = recentFolders(many, [], 'mac', '/Users/kai');
    expect(top.length).toBe(8);
    expect(top[0]).toEqual({ path: '~/p0', name: 'p0' });
  });

  test('search matches every word in the name or path', () => {
    const rows = [
      { name: 'conclave', path: '~/code/conclave' },
      { name: 'CSE546', path: '~/uni/Project-1' },
    ];
    expect(filterFolders(rows, 'UNI proj').map((r) => r.name)).toEqual(['CSE546']);
    expect(filterFolders(rows, 'clave').map((r) => r.name)).toEqual(['conclave']);
    expect(filterFolders(rows, '').length).toBe(2);
    expect(looksLikePath('~/co')).toBe(true);
    expect(looksLikePath('C:\\Users')).toBe(true);
    expect(looksLikePath('conclave')).toBe(false);
  });

  test('breadcrumbs, Up and New folder names', () => {
    expect(crumbs('/home/kai/code').map((c) => [c.name, c.path])).toEqual([
      ['/', '/'],
      ['home', '/home'],
      ['kai', '/home/kai'],
      ['code', '/home/kai/code'],
    ]);
    expect(crumbs('C:/Users/kai').map((c) => c.path)).toEqual(['C:/', 'C:/Users', 'C:/Users/kai']);
    expect(parentPath('/home/kai')).toBe('/home');
    expect(parentPath('/')).toBeUndefined();
    expect(['site', 'a/b', '..', ' ', 'x\\y'].map(folderNameOk)).toEqual([true, false, false, false, false]);
  });
});

describe('the folder menu', () => {
  test('No folder, Recent with name over path, Open folder…; a gone folder is missing', async () => {
    const v = await chip('local');
    const rows = v.options();
    expect(rows[0].textContent).toContain('No folder');
    expect(rows[0].querySelector('[aria-label=selected]')).not.toBeNull();
    const old = rows.find((r) => r.textContent?.includes('old-tool'))!;
    const good = rows.find((r) => r.textContent?.startsWith('conclave'))!;
    expect(good.textContent).toBe('conclave~/code/conclave');
    expect(old.textContent).toContain('missing');
    await v.act(async () => old.click());
    expect(v.picked).toEqual([]);
    await v.act(async () => good.click());
    expect(v.picked).toEqual(['/home/kai/code/conclave']);
    expect(rows.at(-1)?.textContent).not.toContain('Open folder');
    expect(v.button('Open folder…')).toBeDefined();
    await v.unmount();
  });

  test('arrow keys move, Enter picks, Esc closes', async () => {
    const v = await chip('local');
    await v.key('ArrowDown');
    expect(v.options().findIndex((o) => o.getAttribute('aria-selected') === 'true')).toBe(1);
    await v.key('ArrowUp');
    await v.key('ArrowUp');
    expect(v.options().at(-1)?.getAttribute('aria-selected')).toBe('true');
    await v.key('ArrowDown');
    await v.key('Enter');
    expect(v.picked).toEqual(['~']);
    await v.key('Escape');
    expect(v.closed()).toBeGreaterThan(0);
    await v.unmount();
  });

  test('a typed path not on the device: the error, Use off, Create folder makes it', async () => {
    const v = await chip('local');
    await v.type('/home/kai/does-not-exist');
    expect(v.note()?.textContent).toContain('No folder at /home/kai/does-not-exist on madx');
    await v.key('Enter');
    expect(v.picked).toEqual([]);
    await v.act(async () => v.button('Create folder')!.click());
    await v.act(async () => Bun.sleep(320));
    expect(made).toEqual(['/home/kai/does-not-exist']);
    await v.key('Enter');
    expect(v.picked).toEqual(['/home/kai/does-not-exist']);
    await v.unmount();
  });

  test('"On <device>" lists the places, offline greyed; a member is never offered the hub', async () => {
    const v = await chip('arch');
    await v.act(async () => v.options().find((o) => o.textContent?.startsWith('On '))!.click());
    expect(v.options().map((o) => o.textContent)).toEqual(expect.arrayContaining(['madx (hub)', 'arch-desktopoffline']));
    await v.unmount();
    useHub.setState({ me: { role: 'member' } } as never);
    const m = await chip('arch');
    // only one place left for a member here: no device row at all
    expect(m.options().some((o) => o.textContent?.startsWith('On '))).toBe(false);
    expect(m.options().some((o) => o.textContent?.includes('madx'))).toBe(false);
    await m.unmount();
    useHub.setState({ me: undefined } as never);
  });

  test('a typed path lists the folders it starts on the device', async () => {
    const v = await chip('local');
    await v.type('/home/kai/code/s');
    expect(v.options().map((o) => o.textContent)).toContain('/home/kai/code/site');
    await v.unmount();
  });

  test('an offline device cannot be checked: Use waits for Use anyway', async () => {
    const v = await chip('arch');
    await v.type('~/code/anything');
    expect(v.note()?.textContent).toContain("arch-desktop is offline, the folder can't be checked");
    await v.key('Enter');
    expect(v.picked).toEqual([]);
    await v.act(async () => v.button('Use anyway')!.click());
    await v.key('Enter');
    expect(v.picked).toEqual(['~/code/anything']);
    await v.unmount();
  });
});

describe('native folder routing', () => {
  afterEach(() => {
    setDesktop(undefined);
    useHub.setState({ me: undefined, projects: {} } as never);
  });

  function native(result: string | null | Error, here: string | null = 'pc') {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    setDesktop({
      listen: async () => () => {},
      invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push([cmd, args]);
        if (cmd === 'native_folder_device') return here as T;
        if (result instanceof Error) throw result;
        return result as T;
      },
    });
    useHub.setState((s) => ({ devices: { ...s.devices, pc: { id: 'pc', name: 'arch-desktop', online: true, info: { home: '/home/kai' } } } }) as never);
    return calls;
  }

  test('same device: native success keeps server validation and Add as project before selection', async () => {
    const calls = native('/home/kai/code/conclave');
    const v = await chip('pc', '~/code');
    await v.act(async () => v.button('Open folder…')!.click());
    await v.act(async () => Bun.sleep(320));
    expect(calls).toEqual([
      ['native_folder_device', undefined],
      ['pick_folder', { device: 'pc', start: '/home/kai/code' }],
    ]);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')?.value).toBe('~/code/conclave');
    expect(v.picked).toEqual([]);
    const added: unknown[] = [];
    const old = api().addProject;
    api().addProject = async (...args) => {
      added.push(args);
      return { id: 'native-project', name: 'conclave', locations: [{ device: 'pc', path: '/home/kai/code/conclave' }] } as ProjectDto;
    };
    try {
      await v.act(async () => v.button('Add as project')!.click());
      await v.act(async () => v.button('Add and select')!.click());
      expect(added).toEqual([['pc', '/home/kai/code/conclave', 'conclave']]);
      expect(v.picked).toEqual(['~/code/conclave']);
    } finally {
      api().addProject = old;
      await v.unmount();
    }
  });

  test('cancel preserves selection and opens neither fallback nor error', async () => {
    const calls = native(null);
    const v = await chip('pc', '~/code');
    await v.act(async () => v.button('Open folder…')!.click());
    expect(calls.map(([c]) => c)).toEqual(['native_folder_device', 'pick_folder']);
    expect(v.picked).toEqual([]);
    expect(document.querySelector('input[aria-label="Folder path"]')).toBeNull();
    expect(document.querySelector('[role=alert]')).toBeNull();
    await v.unmount();
  });

  test('native failure explains fallback, using the unchanged current folder', async () => {
    native(new Error('dialog unavailable'));
    const v = await chip('pc', '~/code');
    await v.act(async () => v.button('Open folder…')!.click());
    await v.act(async () => Bun.sleep(320));
    expect(document.querySelector('[role=alert]')?.textContent).toContain('native folder picker could not open');
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')?.value).toBe('~/code');
    expect(v.picked).toEqual([]);
    await v.act(async () => v.button('Select this folder')!.click());
    expect(v.picked).toEqual(['~/code']);
    await v.unmount();
  });

  test('remote device with identical name and unproven device keep the browser', async () => {
    for (const here of ['different-id', null]) {
      const calls = native('/wrong/folder', here);
      const v = await chip('pc', '~/code');
      await v.act(async () => v.button('Open folder…')!.click());
      expect(calls.map(([c]) => c)).toEqual(['native_folder_device']);
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')?.value).toBe('~/code');
      expect(document.querySelector('[role=alert]')).toBeNull();
      await v.unmount();
    }
  });

  test('hub local is never this desktop, even for a member or a misleading native ID', async () => {
    const calls = native('/wrong/folder', 'local');
    useHub.setState({ me: { role: 'member' } } as never);
    const v = await chip('local', '~/code');
    await v.act(async () => v.button('Open folder…')!.click());
    expect(calls).toEqual([]);
    expect(document.querySelector('input[aria-label="Folder path"]')).not.toBeNull();
    expect(v.picked).toEqual([]);
    await v.unmount();
  });

  test('member paired device uses native ID, not the hub alias', async () => {
    const calls = native('/home/kai/code');
    useHub.setState({ me: { role: 'member' } } as never);
    const v = await chip('pc');
    await v.act(async () => v.button('Open folder…')!.click());
    await v.act(async () => Bun.sleep(320));
    expect(calls[1]).toEqual(['pick_folder', { device: 'pc', start: null }]);
    await v.act(async () => v.button('Select this folder')!.click());
    expect(v.picked).toEqual(['~/code']);
    await v.unmount();
  });

  test('browser and phone without desktop IPC keep the existing folder browser', async () => {
    const v = await chip('local', '~/code');
    await v.act(async () => v.button('Open folder…')!.click());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')?.value).toBe('~/code');
    expect(v.picked).toEqual([]);
    await v.unmount();
  });

  test('native result missing on server cannot be selected', async () => {
    native('/home/kai/missing-native');
    const v = await chip('pc');
    await v.act(async () => v.button('Open folder…')!.click());
    await v.act(async () => Bun.sleep(320));
    expect(v.note()?.textContent).toContain('No folder at /home/kai/missing-native');
    expect(v.button('Select this folder')?.getAttribute('aria-disabled')).toBe('true');
    await v.act(async () => v.button('Select this folder')!.click());
    expect(v.picked).toEqual([]);
    await v.unmount();
  });

  test('device changes while native selection waits discard the old device path', async () => {
    let finish!: (path: string | null) => void;
    setDesktop({ listen: async () => () => {}, invoke: async <T,>(cmd: string) => (cmd === 'native_folder_device' ? 'pc' : await new Promise<string | null>((resolve) => { finish = resolve; })) as T });
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const picked: string[] = [];
    function Fixture({ device }: { device: string }) {
      const browse = useOpenFolder(device, '~/code', (p) => picked.push(p));
      return <><button onClick={browse.open}>Open</button>{browse.browser}</>;
    }
    await act(async () => root.render(<Fixture device="pc" />));
    await act(async () => host.querySelector('button')!.click());
    await act(async () => root.render(<Fixture device="local" />));
    await act(async () => finish('/old-device/path'));
    expect(document.querySelector('input[aria-label="Folder path"]')).toBeNull();
    expect(picked).toEqual([]);
    await act(async () => root.unmount());
    host.remove();
  });
});

describe('the folder browser', () => {
  test('folders only, Show hidden, into a folder, breadcrumbs, Up, Select', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { FolderBrowser } = await import('../src/features/home/FolderPicker');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const picked: string[] = [];
    await act(async () => root.render(<FolderBrowser open device="local" start="~" onSelect={(p) => picked.push(p)} onClose={() => {}} />));
    await act(async () => Bun.sleep(320));
    const names = () => [...document.querySelectorAll('[aria-label^="Open folder"] [role=listbox] [role=option]')].map((b) => b.textContent);
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[aria-label^="Open folder"] button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
    expect(names()).toEqual(['code']);
    // Show hidden: linkedom's click does not reach React's onChange, so call it
    const box = document.querySelector<HTMLInputElement>('[aria-label^="Open folder"] input[type=checkbox]')! as unknown as Record<string, { onChange: (e: unknown) => void }>;
    await act(async () => box[Object.keys(box).find((k) => k.startsWith('__reactProps$'))!].onChange({ target: { checked: true } }));
    expect(names()).toEqual(['.config', 'code']);
    await act(async () => button('code')!.click());
    await act(async () => Bun.sleep(320));
    expect(names()).toEqual(['conclave', 'site']);
    expect([...document.querySelectorAll('nav[aria-label=Path] button')].map((b) => b.textContent)).toEqual(['/', 'home', 'kai', 'code']);
    await act(async () => button('kai')!.click());
    await act(async () => Bun.sleep(320));
    expect(names()).toEqual(['.config', 'code']);
    await act(async () => button('code')!.click());
    await act(async () => Bun.sleep(320));
    await act(async () => button('Up one folder')!.click());
    await act(async () => Bun.sleep(320));
    expect(names()).toEqual(['.config', 'code']);
    await act(async () => button('Select this folder')!.click());
    expect(picked).toEqual(['~']);
    await act(async () => root.unmount());
    host.remove();
  });
});
