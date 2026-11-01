import { describe, expect, test } from 'bun:test';
import { ROUTINE_SUGGESTIONS, SUGGESTED_AGENTS } from '../../src/scheduler/suggestions';
import { ROUTINE_TEMPLATES } from '../../src/scheduler/templates';
import { parseSchedule, previewRuns } from '../../src/scheduler/schedule';
import { CLOSED_GAPS, RoutineSuggestions, SuggestionError, expandHome, offeredDevices, roleDevice, type SuggestionHost } from '../../src/scheduler/suggest';
import { BUILTIN_AGENTS, parseAgentMarkdown } from '../../src/extensions/builtin-agents';
import type { Device, Routine } from '../../src/types';
import type { RoutineInput } from '../../src/scheduler/types';

describe('suggestion data (ECOSYSTEM.md 6)', () => {
  test('every schedule parses, previews and sits off the hour', () => {
    for (const s of ROUTINE_SUGGESTIONS) {
      expect(() => parseSchedule(s.schedule)).not.toThrow();
      // alert-triage runs from its webhook only: a far @once until the hub has @never
      if (s.schedule.startsWith('@once')) continue;
      expect(previewRuns(s.schedule, 'Europe/Berlin', 3, Date.parse('2026-10-17T10:00:00Z')).length).toBe(3);
      expect(s.schedule.split(' ')[0]).not.toBe('0');
    }
  });

  test('ids are unique and never clash with a template', () => {
    const ids = ROUTINE_SUGGESTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of ROUTINE_TEMPLATES) expect(ids).not.toContain(t.id);
  });

  test('every agent is built in or ships in SUGGESTED_AGENTS', () => {
    const builtin = new Set(BUILTIN_AGENTS.map((a) => a.name));
    for (const s of ROUTINE_SUGGESTIONS) expect(builtin.has(s.agent!) || !!SUGGESTED_AGENTS[s.agent!]).toBe(true);
  });

  test('a Bash allow rule always waits for bash-allow-safe', () => {
    for (const s of ROUTINE_SUGGESTIONS) {
      if (s.allow.some((r) => r.startsWith('Bash('))) expect(s.blockedBy).toContain('bash-allow-safe');
      // no whole-tool Bash rule, and no wildcard in the middle of a command
      for (const r of s.allow) {
        expect(r).not.toBe('Bash');
        const m = r.match(/^Bash\((.*)\)$/);
        if (m) expect(m[1].replace(/:\*$/, '')).not.toContain('*');
      }
    }
  });

  test('every prompt asks for a STATUS line', () => {
    // a routine the hub runs in code (the daily digest) writes its STATUS line itself
    for (const s of ROUTINE_SUGGESTIONS) if (!s.builtin) expect(s.prompt).toMatch(/"STATUS: ok"/);
  });

  test('suggested agents parse and leave tools unset', () => {
    for (const [name, md] of Object.entries(SUGGESTED_AGENTS)) {
      const a = parseAgentMarkdown(name, md);
      expect(a.name).toBe(name);
      expect(a.tools).toBeUndefined();
      expect(a.disallowedTools).toContain('Write');
      expect(a.prompt.length).toBeGreaterThan(200);
    }
  });

  test('the librarian deep pass writes memory only', () => {
    const s = ROUTINE_SUGGESTIONS.find((x) => x.id === 'librarian-deep-pass')!;
    expect(s.agent).toBe('librarian');
    expect(s.allow.every((r) => /^(Memory(Save|Forget)|mcp__basic-memory__(write|edit|move)_note)$/.test(r))).toBe(true);
    expect(s.prompt).toContain('Never call delete_note');
    expect(s.prompt).toContain('Never change files inside the repos');
  });

  test('the librarian deep pass runs on each computer with code, with its caps per run', () => {
    // found in a real setup: the owner has code on several computers, and the deep pass made one routine on one of them
    const s = ROUTINE_SUGGESTIONS.find((x) => x.id === 'librarian-deep-pass')!;
    expect(s.deviceRole).toBe('each');
    expect(s.eachOf).toEqual(['workstation', 'laptop']);
    expect(s.hubNeedsRepos).toBe(true);
    expect(s.prompt).toContain('Budget for this run: at most 6 repos, 60 note edits and 25 changes to Conclave memory.');
    // each computer keeps its own lines in the shared state note
    expect(s.prompt).toContain("this machine's hostname");
  });
});

const dev = (id: string, name: string, extra: Partial<Device> = {}): Device => ({ id, name, online: true, roots: [], createdAt: 1, ...extra });
const DEVICES: Device[] = [
  dev('local', 'madx', { info: { hostname: 'madx', platform: 'linux', arch: 'x64', home: '/root', shell: '/bin/bash', clis: {}, capabilities: [] } }),
  dev('d_arch', 'arch-desktop', { info: { hostname: 'archbox', platform: 'linux', arch: 'x64', home: '/home/kai', shell: '/usr/bin/zsh', clis: {}, capabilities: [] } }),
  dev('d_pve', 'pve', { info: { hostname: 'pve', platform: 'linux', arch: 'x64', home: '/root', shell: '/bin/bash', clis: { pvesh: '9.0.6' }, capabilities: [] } }),
  dev('d_mac', 'macbook', { online: false, info: { hostname: 'mbp', platform: 'darwin', arch: 'arm64', home: '/Users/kai', shell: '/bin/zsh', clis: {}, capabilities: [] } }),
];

function host(over: Partial<SuggestionHost> = {}) {
  const routines: Routine[] = [];
  const agents = new Set(BUILTIN_AGENTS.map((a) => a.name));
  const created: Array<{ name: string; markdown: string }> = [];
  let n = 0;
  const h: SuggestionHost = {
    routines: () => routines,
    createRoutine: (input: RoutineInput) => {
      if (input.name.includes('boom')) throw new Error('boom');
      const r = { ...input, id: `rt_${++n}`, agent: input.agent!, mode: input.mode ?? 'agent', enabled: input.enabled ?? true, sessionPolicy: input.sessionPolicy ?? 'new', notify: input.notify ?? 'always', createdAt: 1, updatedAt: 1 } as Routine;
      routines.push(r);
      return r;
    },
    removeRoutine: (id) => {
      const i = routines.findIndex((r) => r.id === id);
      if (i >= 0) routines.splice(i, 1);
    },
    agentExists: (name) => agents.has(name),
    createAgent: async (name, markdown) => {
      created.push({ name, markdown });
      agents.add(name);
    },
    mcpServers: () => ['github'],
    secrets: () => [],
    devices: () => DEVICES,
    ...over,
  };
  return { h, routines, created, agents };
}

describe('roleDevice and expandHome', () => {
  test('roles map to the owner machines by name and what they report', () => {
    expect(roleDevice('hub', DEVICES)?.id).toBe('local');
    expect(roleDevice('proxmox', DEVICES)?.id).toBe('d_pve');
    expect(roleDevice('workstation', DEVICES)?.id).toBe('d_arch');
    expect(roleDevice('laptop', DEVICES)?.id).toBe('d_mac');
    expect(roleDevice('each', DEVICES)).toBeUndefined();
    // no Proxmox host or laptop: no stand-in, the owner picks
    expect(roleDevice('proxmox', [DEVICES[0], DEVICES[1]])).toBeUndefined();
    expect(roleDevice('laptop', [DEVICES[0]])).toBeUndefined();
    // a workstation falls back to another online machine, then the hub
    const other = dev('d_x', 'kali-vm');
    expect(roleDevice('workstation', [DEVICES[0], other])?.id).toBe('d_x');
    expect(roleDevice('workstation', [DEVICES[0]])?.id).toBe('local');
  });

  test('~ expands with the device home', () => {
    expect(expandHome('~/code', '/home/kai')).toBe('/home/kai/code');
    expect(expandHome('~', '/root/')).toBe('/root');
    expect(expandHome('~/x', '/')).toBe('/x');
    expect(expandHome('/srv', '/root')).toBe('/srv');
    expect(expandHome('~/code', undefined)).toBe('~/code');
    expect(expandHome('  ', '/root')).toBeUndefined();
  });
});

describe('RoutineSuggestions', () => {
  test('list reports added, missing and waiting gaps', async () => {
    const { h } = host();
    const svc = new RoutineSuggestions(h);
    const dto = svc.list();
    expect(dto.suggestions.length).toBe(ROUTINE_SUGGESTIONS.length);
    expect(dto.closed).toEqual(CLOSED_GAPS);
    expect(dto.agents).toEqual({ 'ops-watch': { exists: false }, steward: { exists: false } });
    const deep = dto.suggestions.find((s) => s.id === 'librarian-deep-pass')!;
    expect(deep.waitingOn).toEqual([]);
    expect(deep.missing.map((m) => m.id)).toEqual(['basic-memory']);
    // agents Add creates are never "missing"
    const backup = dto.suggestions.find((s) => s.id === 'backup-check')!;
    expect(backup.missing.find((m) => m.kind === 'agent')).toBeUndefined();
    // gaps the hub has not closed yet
    expect(dto.suggestions.find((s) => s.id === 'uni-calendar-sync')!.waitingOn).toEqual(['routine-env']);
    expect(dto.suggestions.find((s) => s.id === 'routine-doctor')!.waitingOn).toEqual(['routine-runs-tool']);
    expect(dto.suggestions.find((s) => s.id === 'uni-calendar-sync')!.missing.map((m) => m.id)).toContain('uni-ical-url');

    await svc.add('librarian-deep-pass', {});
    expect(svc.list().suggestions.find((s) => s.id === 'librarian-deep-pass')!.added).toEqual(['rt_1', 'rt_2']);
  });

  test('add uses the role devices, expands ~ and seeds the rules', async () => {
    const { h, created } = host();
    const svc = new RoutineSuggestions(h);
    const res = await svc.add('librarian-deep-pass', { enabled: true });
    expect(res.agentCreated).toBeUndefined();
    expect(created).toEqual([]);
    // one routine per computer with code, named after it, each ~ with its own home
    expect(res.routines.map((r) => [r.name, r.device, r.cwd])).toEqual([
      ['Librarian: deep pass (arch-desktop)', 'd_arch', '/home/kai/code'],
      ['Librarian: deep pass (macbook)', 'd_mac', '/Users/kai/code'],
    ]);
    for (const r of res.routines) {
      expect(r.agent).toBe('librarian');
      expect(r.enabled).toBe(true);
      expect(r.suggestion).toBe('librarian-deep-pass');
      expect(r.allow).toContain('mcp__basic-memory__edit_note');
      expect(r.precheck).toContain('git');
      expect(r.schedule).toBe('10 4 * * 0');
    }
  });

  test('the hub is offered for the deep pass only when it holds code', async () => {
    const deep = ROUTINE_SUGGESTIONS.find((x) => x.id === 'librarian-deep-pass')!;
    expect(offeredDevices(deep, DEVICES, false).map((d) => d.id)).toEqual(['d_arch', 'd_pve', 'd_mac']);
    expect(offeredDevices(deep, DEVICES, true).map((d) => d.id)).toEqual(['local', 'd_arch', 'd_pve', 'd_mac']);
    // other "each" suggestions keep the hub
    expect(offeredDevices(ROUTINE_SUGGESTIONS.find((x) => x.id === 'update-scout')!, DEVICES, false)).toHaveLength(4);

    // a hub alone, in Docker: nothing to read, so nothing is made there
    const bare = new RoutineSuggestions(host({ devices: () => [DEVICES[0]] }).h);
    expect(bare.list().hubRepos).toBe(false);
    await expect(bare.add('librarian-deep-pass', {})).rejects.toThrow('Pick at least one device.');
    await expect(bare.add('librarian-deep-pass', { devices: ['local'] })).rejects.toThrow('the hub has none there');
    // the hub with repos in ~/code gets its own copy
    const coding = new RoutineSuggestions(host({ devices: () => [DEVICES[0]], hubHasRepos: () => true }).h);
    expect(coding.list().hubRepos).toBe(true);
    expect((await coding.add('librarian-deep-pass', {})).routines.map((r) => [r.name, r.device, r.cwd])).toEqual([['Librarian: deep pass (madx)', 'local', '/root/code']]);
  });

  test('add creates a missing suggested agent once, then the routine', async () => {
    const { h, created } = host();
    const svc = new RoutineSuggestions(h);
    const res = await svc.add('backup-check', {});
    expect(res.agentCreated).toBe('ops-watch');
    expect(created.map((c) => c.name)).toEqual(['ops-watch']);
    expect(res.routines[0].device).toBe('d_pve');
    expect(res.routines[0].enabled).toBe(true);
    const again = await svc.add('disk-health', {});
    expect(again.agentCreated).toBeUndefined();
    expect(created.length).toBe(1);
  });

  test('"each" makes one routine per device, named after it', async () => {
    const { h } = host();
    const res = await new RoutineSuggestions(h).add('update-scout', { devices: ['d_pve', 'd_arch'], enabled: false });
    expect(res.routines.map((r) => r.name)).toEqual(['Update scout (pve)', 'Update scout (arch-desktop)']);
    expect(res.routines.every((r) => r.enabled === false)).toBe(true);
  });

  test('add refuses what it cannot do safely', async () => {
    const { h, routines } = host();
    const svc = new RoutineSuggestions(h);
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return 0;
      } catch (e) {
        expect(e).toBeInstanceOf(SuggestionError);
        return (e as SuggestionError).status;
      }
    };
    expect(await code(svc.add('nope', {}))).toBe(404);
    expect(await code(svc.add('uni-calendar-sync', {}))).toBe(409);
    expect(await code(svc.add('docs-drift', {}))).toBe(400); // asks for a folder
    expect(await code(svc.add('backup-check', { devices: ['d_arch', 'd_pve'] }))).toBe(400);
    expect(await code(svc.add('librarian-deep-pass', { devices: ['ghost'] }))).toBe(400);
    // no Proxmox host on this hub: the owner has to pick a device
    const bare = new RoutineSuggestions(host({ devices: () => [DEVICES[0], DEVICES[1]] }).h);
    expect(await code(bare.add('backup-check', {}))).toBe(400);
    expect((await bare.add('backup-check', { devices: ['d_arch'] })).routines[0].device).toBe('d_arch');
    // the sheet may drop allow rules, never add them
    expect(await code(svc.add('librarian-deep-pass', { overrides: { allow: ['Bash'] } }))).toBe(400);
    expect(routines.length).toBe(0);

    const ok = await svc.add('docs-drift', { cwd: '~/code/conclave', overrides: { allow: [], notify: 'on_attention', schedule: '25 9 * * 6' } });
    expect(ok.routines[0].cwd).toBe('/home/kai/code/conclave');
    expect(ok.routines[0].allow).toEqual([]);
    expect(ok.routines[0].notify).toBe('on_attention');
    expect(ok.routines[0].schedule).toBe('25 9 * * 6');
  });

  test('a failure half way removes the routines it made', async () => {
    const { h, routines } = host();
    const svc = new RoutineSuggestions(h);
    await expect(svc.add('update-scout', { devices: ['d_pve', 'd_arch'], overrides: { name: 'boom' } })).rejects.toThrow('boom');
    expect(routines.length).toBe(0);
    let made = 0;
    const flaky = host({
      createRoutine: (input) => {
        if (++made === 2) throw new Error('disk full');
        return { ...input, id: `rt_${made}` } as Routine;
      },
    });
    const removed: string[] = [];
    flaky.h.removeRoutine = (id) => void removed.push(id);
    await expect(new RoutineSuggestions(flaky.h).add('update-scout', { devices: ['d_pve', 'd_arch'] })).rejects.toThrow('disk full');
    expect(removed).toEqual(['rt_1']);
  });
});
