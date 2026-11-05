/**
 * Canvas mode, PR 1 (docs/design/CANVAS-MODE.md, features/canvas/model.ts):
 * the addresses, the last file open, the folders programs are read from,
 * the sidebar's groups, and where the canvas opens on a phone.
 *
 *   bun test packages/web/test/canvas-mode.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { WorkflowRun, WorkflowSummary } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { canvasHome, deskViewport, libraryOpen, READ_ZOOM, saveLibraryOpen, fileGroups, fileHref, focusNode, focusViewport, folderSessions, isRunId, programHref, rememberFile, sessionFor, workflowFiles, workflowHref } from '../src/features/canvas/model';
import { readMode } from '../src/features/home/start';
import { phonePlace } from '../src/components/PhoneFrame';
import { NEW_WORDS, sideListWord } from '../src/lib/sidebar';

function session(id: string, p: Partial<Session> = {}): Session {
  return { id, title: id, agent: 'coder', model: 'm', device: 'arch', cwd: '~/code/app', mode: 'agent', status: 'idle', createdAt: 1, updatedAt: 1, tags: [], stats: { messages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, ...p } as Session;
}

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
afterEach(() => store.clear());

describe('addresses', () => {
  test('a program carries its folder; a workflow or a run is one segment', () => {
    expect(programHref('daily report', 'arch', '~/code/app')).toBe('/canvas/program/daily%20report?device=arch&cwd=%7E%2Fcode%2Fapp');
    expect(workflowHref('review')).toBe('/canvas/workflow/review');
    expect(isRunId('wfr_abc')).toBe(true);
    expect(isRunId('review')).toBe(false);
    expect(fileHref({ kind: 'workflow', id: 'review', name: 'review', group: 'runs', runId: 'wfr_1' })).toBe('/canvas/workflow/wfr_1');
  });
  test('Canvas pages draw their own phone bar', () => {
    expect(phonePlace('/canvas')).toBe('conversation');
    expect(phonePlace('/canvas/workflow/wfr_1')).toBe('conversation');
  });
  test('the sidebar words', () => {
    expect(sideListWord('canvas')).toBe('Programs and workflows');
    expect(NEW_WORDS.canvas).toBe('All of Canvas');
  });
});

describe('the last file open', () => {
  test('Canvas opens on it, else the start page', () => {
    expect(canvasHome()).toBe('/canvas');
    rememberFile('/canvas/workflow/review');
    expect(canvasHome()).toBe('/canvas/workflow/review');
  });
  test('only Canvas addresses are kept', () => {
    rememberFile('/s/s_1');
    expect(canvasHome()).toBe('/canvas');
    store.set('conclave.canvas.last:none', 'https://evil.example');
    expect(canvasHome()).toBe('/canvas');
  });
  test('per account: a member signing in after the owner on this browser does not see the owner file', () => {
    const signIn = (c: object) => store.set('conclave.connection', JSON.stringify({ baseUrl: 'https://hub', ...c }));
    signIn({ token: 'owner-token' });
    rememberFile('/canvas/workflow/payroll');
    expect(canvasHome()).toBe('/canvas/workflow/payroll');
    signIn({ token: 'member-token', account: { id: 'acc_m', name: 'm', role: 'member' } });
    expect(canvasHome()).toBe('/canvas');
    rememberFile('/canvas/workflow/notes');
    signIn({ token: 'owner-token' });
    expect(canvasHome()).toBe('/canvas/workflow/payroll');
    // the old key, one per browser, is ignored
    store.set('conclave.canvas.last', '/canvas/workflow/leak');
    signIn({ token: 'another' });
    expect(canvasHome()).toBe('/canvas');
  });
  test('the node library: folded on a run until opened, kept per account', () => {
    expect(libraryOpen(true)).toBe(false);
    expect(libraryOpen(false)).toBe(true);
    saveLibraryOpen(true);
    expect(libraryOpen(true)).toBe(true);
    store.set('conclave.connection', JSON.stringify({ baseUrl: 'https://hub', token: 't', account: { id: 'acc_x', name: 'x', role: 'member' } }));
    expect(libraryOpen(true)).toBe(false);
  });
  test('the switch remembers Canvas', () => {
    store.set('conclave.mode', 'canvas');
    expect(readMode()).toBe('canvas');
  });
});

describe('programs', () => {
  const list = [
    session('a', { updatedAt: 3 }),
    session('b', { updatedAt: 5 }),
    session('c', { cwd: '~/other', updatedAt: 4 }),
    session('chat', { kind: 'chat', updatedAt: 9 } as Partial<Session>),
    session('asst', { agent: 'assistant', updatedAt: 9 }),
    session('old', { cwd: '~/gone', archived: true, updatedAt: 9 }),
  ];
  test('one session per folder, the newest, newest folder first; no chats, assistant or archived', () => {
    expect(folderSessions(list).map((s) => s.id)).toEqual(['b', 'c']);
  });
  test('a folder is read through its newest Code session on that device', () => {
    expect(sessionFor(list, 'arch', '~/code/app')?.id).toBe('b');
    expect(sessionFor(list, 'other', '~/code/app')).toBeUndefined();
  });
});

describe('workflows', () => {
  const lib = [
    { id: 'review', name: 'review', source: 'builtin' },
    { id: 'mine', name: 'mine', source: 'user' },
  ] as WorkflowSummary[];
  const runs = [
    { id: 'wfr_1', name: 'review', status: 'failed', createdAt: 1 },
    { id: 'wfr_2', name: 'mine', status: 'running', createdAt: 2 },
  ] as WorkflowRun[];
  test('yours, then the library, then runs newest first, live and failed marked', () => {
    const f = workflowFiles(lib, runs);
    expect(f.map((x) => (x.kind === 'workflow' ? `${x.group}:${x.runId ?? x.id}` : ''))).toEqual(['yours:mine', 'library:review', 'runs:wfr_2', 'runs:wfr_1']);
    expect(f[2]).toMatchObject({ live: true, failed: false });
    expect(f[3]).toMatchObject({ live: false, failed: true });
  });
  test('groups keep order', () => {
    const g = fileGroups([{ kind: 'program', name: 'p', device: 'arch', cwd: '~/a', sessionId: 's' }, ...workflowFiles(lib, runs)], (f) => f.cwd);
    expect(g.map((x) => x.label)).toEqual(['~/a', 'Your workflows', 'Library workflows', 'Recent runs']);
  });
});

describe('where the canvas opens', () => {
  test('running, then waiting, then failed', () => {
    expect(focusNode([{ id: 'a', state: 'failed' }, { id: 'b', state: 'running' }])).toBe('b');
    expect(focusNode([{ id: 'a', state: 'done' }, { id: 'b', state: 'failed' }])).toBe('b');
    expect(focusNode([{ id: 'a', state: 'done' }])).toBeUndefined();
  });
  const canvas = { w: 390, h: 600 };
  const node = (y: number) => ({ x: 0, y, w: 300, h: 80 });
  test('a short graph starts at the top: no empty half', () => {
    const v = focusViewport(node(100), { x: 0, y: 0, w: 300, h: 300 }, canvas);
    expect(v.y).toBe(12);
    expect(v.x).toBe((390 - 300) / 2);
  });
  test('a tall graph centres the node low, but never shows past its ends', () => {
    const graph = { x: 0, y: 0, w: 300, h: 2000 };
    const mid = focusViewport(node(1000), graph, canvas);
    expect(mid.y).toBeCloseTo(600 * 0.6 - 1040);
    // the node is on screen
    expect(1000 + mid.y).toBeGreaterThan(0);
    expect(1080 + mid.y).toBeLessThan(600);
    // near the top it does not pull the graph down off the top edge
    expect(focusViewport(node(0), graph, canvas).y).toBe(12);
    // near the bottom the graph's end sits on the screen's bottom
    expect(focusViewport(node(1920), graph, canvas).y).toBe(600 - 12 - 2000);
  });
});

describe('a computer opens readable (owner on #250)', () => {
  const pane = { w: 848, h: 644 };
  const box = (x: number) => ({ x, y: 40, w: 248, h: 92 });
  // screen x of a flow x at a viewport
  const at = (v: { x: number; zoom: number }, x: number) => v.x + x * v.zoom;
  test('a graph that fits is centred whole', () => {
    const v = deskViewport({ x: 0, y: 0, w: 600, h: 200 }, undefined, pane);
    expect(v.zoom).toBe(1);
    expect(at(v, 0)).toBe((pane.w - 600) / 2);
  });
  test('a short wide graph uses the pane height: above the width fit, its start at the left', () => {
    const v = deskViewport({ x: 0, y: 0, w: 1000, h: 200 }, undefined, pane);
    expect(v.zoom).toBe(1);
    expect(v.zoom).toBeGreaterThan((pane.w - 48) / 1000);
    expect(at(v, 0)).toBe(24);
  });
  test('a tall graph fits its height down to the readable zoom, never below', () => {
    expect(deskViewport({ x: 0, y: 0, w: 400, h: 1000 }, undefined, pane).zoom).toBeCloseTo((644 - 48) / 1000);
    expect(deskViewport({ x: 0, y: 0, w: 400, h: 3000 }, undefined, pane).zoom).toBe(READ_ZOOM);
  });
  test('a far failed node never pulls the first blocks off the left or the zoom down', () => {
    const wide = { x: -40, y: 0, w: 3250, h: 200 };
    const v = deskViewport(wide, box(2800), pane);
    expect(v.zoom).toBe(1);
    expect(at(v, -40)).toBe(24);
  });
  test('a graph taller than the pane: the failed node in the middle', () => {
    const v = deskViewport({ x: 0, y: 0, w: 400, h: 3000 }, { x: 0, y: 2000, w: 248, h: 92 }, pane);
    expect(v.y + 2046 * v.zoom).toBeCloseTo(pane.h / 2);
  });
});
