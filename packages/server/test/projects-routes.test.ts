/**
 * Folders across devices routes (routes-projects.ts): input checks, the
 * PATCH device branch and the 501 without a projects service. The service
 * itself is tested in packages/core/test/projects on a real engine; here a
 * stub stands in for it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types.ts';
import type { MoveInput, MoveResult } from '@conclave/core/client/projects.ts';
import { setProjects } from '@conclave/core/projects/attached.ts';
import type { ProjectsService } from '@conclave/core/projects/service.ts';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
const calls: Array<{ method: string; args: unknown[] }> = [];
let nextMove: (id: string, input: MoveInput) => MoveResult;

const now = Date.now();
const base: Session = {
  id: 'ses_move',
  title: 'portfolio',
  agent: 'coder',
  model: 'anthropic/claude-sonnet-5-5',
  mode: 'agent',
  permissionMode: 'default',
  cwd: '/home/kai/code/portfolio',
  device: 'local',
  status: 'idle',
  tags: [],
  pinned: false,
  archived: false,
  createdAt: now,
  updatedAt: now,
  stats: { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
};

beforeAll(() => {
  hub = startHub();
  hub.engine.repos.sessions.insert(base);
  hub.engine.repos.devices.insert({ id: 'mac', name: 'macbook', tokenHash: 'x', roots: [] });
});
afterAll(() => hub.stop());

function stub(): void {
  const svc = {
    move: async (id: string, input: MoveInput) => (calls.push({ method: 'move', args: [id, input] }), nextMove(id, input)),
    location: async (id: string, opts: unknown) => (calls.push({ method: 'location', args: [id, opts] }), { sessionId: id, state: 'ok', history: [] }),
    identify: async (device: string, path: string, opts: unknown) => (calls.push({ method: 'identify', args: [device, path, opts] }), { device, path, level: 'none', line: 'x' }),
    list: () => [],
    get: () => undefined,
    pin: async (id: string, device: string, path: string) => (calls.push({ method: 'pin', args: [id, device, path] }), { id, name: 'portfolio', locations: [] }),
    unpin: (id: string, device: string, path: string) => (calls.push({ method: 'unpin', args: [id, device, path] }), { id, name: 'portfolio', locations: [] }),
    deviceFolders: async (device: string) => ({ device, locations: [] }),
    deletePrefix: (id: string) => id === 'pfx_1',
  };
  setProjects(hub.engine, svc as unknown as ProjectsService);
}

describe('without a projects service', () => {
  test('the routes answer 501 and PATCH still updates the session', async () => {
    expect((await hub.api('/api/projects')).status).toBe(501);
    expect((await hub.api('/api/sessions/ses_move/location')).status).toBe(501);
    const res = await hub.api('/api/sessions/ses_move', { method: 'PATCH', json: { title: 'renamed' } });
    expect(res.status).toBe(200);
  });
});

describe('with the service', () => {
  beforeAll(() => stub());

  test('move checks its input and the device', async () => {
    nextMove = (id) => ({ resolved: true, cwd: '/Users/kai/Developer/portfolio', via: 'syncthing', level: 'exact', session: { ...base, id, device: 'mac' }, line: 'Moved.' });
    expect((await hub.api('/api/sessions/ses_move/move', { method: 'POST', json: {} })).status).toBe(400);
    expect((await hub.api('/api/sessions/ses_move/move', { method: 'POST', json: { device: 'mac', remember: 'yes' } })).status).toBe(400);
    expect((await hub.api('/api/sessions/ses_move/move', { method: 'POST', json: { device: 'mac', clone: 'git@x' } })).status).toBe(400);
    expect((await hub.api('/api/sessions/ses_move/move', { method: 'POST', json: { device: 'nope' } })).status).toBe(404);
    expect((await hub.api('/api/sessions/ses_nope/move', { method: 'POST', json: { device: 'mac' } })).status).toBe(404);
    const ok = await hub.api('/api/sessions/ses_move/move', { method: 'POST', json: { device: 'mac', cwd: '~/Developer/portfolio', remember: true, extra: 1 } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as MoveResult).resolved).toBe(true);
    expect(calls.filter((c) => c.method === 'move').at(-1)?.args).toEqual(['ses_move', { device: 'mac', cwd: '~/Developer/portfolio', remember: true }]);
  });

  test('PATCH with a new device goes through the move and answers 409 when nothing was found', async () => {
    nextMove = () => ({ resolved: false, reason: 'not-found', line: 'No copy of portfolio was found on macbook.', candidates: [{ device: 'mac', path: '/Users/kai/portfolio', level: 'weak', via: 'search', line: 'Same folder name' }] });
    const res = await hub.api('/api/sessions/ses_move', { method: 'PATCH', json: { device: 'mac' } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; reason: string; candidates: unknown[] };
    expect(body).toMatchObject({ error: 'No copy of portfolio was found on macbook.', reason: 'not-found' });
    expect(body.candidates).toHaveLength(1);
    // the same device is a plain patch
    const same = await hub.api('/api/sessions/ses_move', { method: 'PATCH', json: { device: 'local', title: 'again' } });
    expect(same.status).toBe(200);
  });

  test('a path that is huge or has a NUL or line break is refused before it reaches a device', async () => {
    const long = `/${'a'.repeat(5000)}`;
    const n = calls.length;
    for (const path of [long, '/home/kai/code\u0000/x', '/home/kai/code\n/x']) {
      expect((await hub.api('/api/projects/identify', { method: 'POST', json: { device: 'mac', path } })).status).toBe(400);
      expect((await hub.api('/api/projects/prj_1/locations', { method: 'PUT', json: { device: 'mac', path } })).status).toBe(400);
      expect((await hub.api('/api/sessions/ses_move/move', { method: 'POST', json: { device: 'mac', cwd: path } })).status).toBe(400);
      expect((await hub.api('/api/sessions/ses_move/move', { method: 'POST', json: { device: 'mac', clone: { url: 'git@github.com:kai/portfolio.git', into: path } } })).status).toBe(400);
    }
    expect((await hub.api('/api/sessions/ses_move/move', { method: 'POST', json: { device: 'mac', clone: { url: `https://x/${'b'.repeat(5000)}`, into: '~/code/p' } } })).status).toBe(400);
    expect(calls.length).toBe(n);
  });

  test('location, identify, pin, unpin and path pairs pass their input on', async () => {
    expect((await hub.api('/api/sessions/ses_move/location?refresh=1')).status).toBe(200);
    expect(calls.find((c) => c.method === 'location')?.args).toEqual(['ses_move', { refresh: true }]);
    expect((await hub.api('/api/projects/identify', { method: 'POST', json: { device: 'mac' } })).status).toBe(400);
    expect((await hub.api('/api/projects/identify', { method: 'POST', json: { device: 'mac', path: '~/x', sessionId: 'ses_move' } })).status).toBe(200);
    expect(calls.find((c) => c.method === 'identify')?.args).toEqual(['mac', '~/x', { sessionId: 'ses_move', projectId: undefined }]);
    expect((await hub.api('/api/projects/prj_1/locations', { method: 'PUT', json: { device: 'mac', path: '~/x' } })).status).toBe(200);
    expect((await hub.api('/api/projects/prj_1/locations?device=mac', { method: 'DELETE' })).status).toBe(400);
    expect((await hub.api('/api/projects/prj_1/locations?device=mac&path=%2Fx', { method: 'DELETE' })).status).toBe(200);
    expect((await hub.api('/api/path-prefixes/pfx_1', { method: 'DELETE' })).status).toBe(200);
    expect((await hub.api('/api/path-prefixes/pfx_2', { method: 'DELETE' })).status).toBe(404);
    expect((await hub.api('/api/devices/nope/folders')).status).toBe(404);
    expect((await hub.api('/api/devices/mac/folders')).status).toBe(200);
    expect((await hub.api('/api/projects', { token: null })).status).toBe(401);
  });
});
