/**
 * The suggested routines mock (src/mock/routines-suggest.ts) against a stub
 * mock context: it serves the hub's own RoutineSuggestions service, so the
 * Routines tab sees the real list, needs, refusals and agent creation.
 *
 *   bun test packages/web/test/routines-suggest-mock.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { registerRoutinesSuggest } from '../src/mock/routines-suggest';
import { CLOSED_GAPS } from '@conclave/core/scheduler/suggest';
import { addedRoutines, defaultDevices, whatWords, whereWords, shortNeed, whenWords } from '../src/features/routines/suggest';
import { ROUTINE_SUGGESTIONS } from '@conclave/core/scheduler/suggestions';

type Handler = (p: { params: string[]; query: URLSearchParams; body: any }) => unknown;

function world() {
  const routes: Array<[string, RegExp, Handler]> = [];
  const dev = (id: string, name: string, home: string) => ({ id, name, online: true, roots: [], createdAt: 1, info: { hostname: name, platform: 'linux', arch: 'x64', home, shell: 'bash', clis: {}, capabilities: [] } });
  const db = {
    config: { mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } } } as Record<string, any>,
    values: [] as string[],
    agents: [{ name: 'librarian' }, { name: 'assistant' }] as any[],
    routines: new Map<string, any>(),
    devices: new Map<string, any>([
      ['local', dev('local', 'madx', '/root')],
      ['arch-desktop', dev('arch-desktop', 'arch-desktop', '/home/kai')],
      ['pve', dev('pve', 'pve', '/root')],
    ]),
  };
  let n = 0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const ctx = {
    on: (m: string, path: string, h: Handler) => routes.push([m, new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h]),
    db,
    emit: () => undefined,
    uid: (p: string) => `${p}_${++n}`,
    sleep: async () => undefined,
    notFound: () => {
      throw new Error('404');
    },
    fail: (status: number, msg: string): never => {
      throw Object.assign(new Error(msg), { status });
    },
    FRESH: true,
    pass: Symbol('pass'),
    request: async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === '/api/routines' && method === 'POST') {
        const r = { id: `r_${++n}`, ...body };
        db.routines.set(r.id, r);
        return json(r);
      }
      if (path.startsWith('/api/routines/preview')) {
        const schedule = new URL(path, 'http://x').searchParams.get('schedule') ?? '';
        return json(schedule.split(' ').length >= 5 ? { next: [Date.now() + 60_000] } : { next: [], error: 'Cron needs 5 or 6 fields' });
      }
      if (path.startsWith('/api/routines/') && method === 'DELETE') {
        db.routines.delete(path.split('/').pop()!);
        return json({ ok: true });
      }
      return json({ error: `no stub for ${method} ${path}` }, 404);
    },
  };
  registerRoutinesSuggest(ctx as never);
  const call = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const u = new URL(url, 'http://x');
    for (const [m, re, h] of routes) {
      const match = m === method && u.pathname.match(re);
      if (match) return (await h({ params: match.slice(1).map(decodeURIComponent), query: u.searchParams, body })) as T;
    }
    throw new Error(`no route ${method} ${url}`);
  };
  return { call, db };
}

describe('suggested routines mock', () => {
  test('the list carries the real hub gaps and needs', async () => {
    const { call } = world();
    const d = await call<{ suggestions: Array<{ id: string; waitingOn: string[]; missing: Array<{ id: string }> }>; closed: string[] }>('GET', '/api/routines/suggestions');
    expect(d.closed).toEqual(CLOSED_GAPS);
    expect(d.suggestions.find((s) => s.id === 'librarian-deep-pass')!.missing.map((m) => m.id)).toEqual(['basic-memory']);
    expect(d.suggestions.find((s) => s.id === 'uni-calendar-sync')!.waitingOn).toEqual(['routine-env']);
  });

  test('Add makes the agent from its markdown, then the routine on the role device', async () => {
    const { call, db } = world();
    const r = await call<{ routines: Array<Record<string, any>>; agentCreated?: string }>('POST', '/api/routines/suggestions/backup-check/add', { enabled: true });
    expect(r.agentCreated).toBe('ops-watch');
    expect(r.routines[0]).toMatchObject({ device: 'pve', cwd: '/root', agent: 'ops-watch', suggestion: 'backup-check' });
    const agent = db.agents.find((a) => a.name === 'ops-watch');
    expect(agent.disallowedTools).toContain('mcp__basic-memory__delete_note');
    expect(agent.description).toContain('Read-only checker');
    expect(agent.prompt.startsWith('You run scheduled checks')).toBe(true);
    await expect(call('POST', '/api/routines/suggestions/docs-drift/add', {})).rejects.toMatchObject({ status: 400 });
  });

  test('a schedule the hub cannot read stops Add before the agent is made', async () => {
    const { call, db } = world();
    await expect(call('POST', '/api/routines/suggestions/edge-check/add', { overrides: { schedule: 'bogus' } })).rejects.toMatchObject({ status: 400 });
    expect(db.agents.some((a) => a.name === 'ops-watch')).toBe(false);
    expect(db.routines.size).toBe(0);
  });
});

describe('where a suggestion lands', () => {
  const dev = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, online: true, roots: [], createdAt: 1, ...extra }) as any;
  const devices = [dev('local', 'madx'), dev('d_arch', 'arch-desktop'), dev('d_pve', 'pve'), dev('d_kali', 'kali-vm'), dev('d_mac', 'macbook', { online: false })];
  const s = (id: string) => ROUTINE_SUGGESTIONS.find((x) => x.id === id)!;

  test('"each" suggestions name the machines they start on', () => {
    expect(whereWords(s('session-harvester'), devices)).toBe('on arch-desktop and macbook');
    expect(defaultDevices(s('session-harvester'), devices)).toEqual(['d_arch', 'd_mac']);
    expect(whereWords(s('disk-health'), devices)).toBe('on pve and arch-desktop');
    expect(whereWords(s('update-scout'), devices)).toBe('on each machine');
    expect(defaultDevices(s('update-scout'), devices)).toEqual(['local', 'd_arch', 'd_pve', 'd_kali']);
    expect(whereWords(s('backup-check'), devices)).toBe('on pve');
    expect(whereWords(s('backup-check'), [devices[0]])).toBe('on the Proxmox host');
  });

  test('added comes from the live routine list', () => {
    const routines = { r1: { id: 'r1', suggestion: 'backup-check' }, r2: { id: 'r2' } } as any;
    expect(addedRoutines({ id: 'backup-check' }, routines).map((r) => r.id)).toEqual(['r1']);
    expect(addedRoutines({ id: 'backup-check' }, {})).toEqual([]);
  });
});

describe('row words', () => {
  test('the description loses its leading schedule, needs get short names', () => {
    expect(whatWords('Sundays 04:10 on the workstation: reads code repos.')).toBe('Reads code repos.');
    expect(whatWords('1st of each month 11:20: samples sessions.')).toBe('Samples sessions.');
    expect(whatWords('Runs when Proxmox calls its webhook: reads the alert.')).toBe('Runs when Proxmox calls its webhook: reads the alert.');
    expect(shortNeed('Basic Memory MCP server (0.24 or newer)')).toBe('Basic Memory');
    expect(shortNeed('Moodle or Canvas calendar export URL, saved as the secret uni-ical-url')).toBe('Moodle or Canvas calendar export URL');
    expect(whenWords('@once 2099-01-01T00:00')).toBe('When its webhook is called');
    expect(whenWords('10 4 * * 0')).toBe('Sundays at 04:10');
  });
});
