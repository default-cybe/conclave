/**
 * What a new conversation starts (features/home/start.ts): Chat, Assistant
 * or Code, Code's picks and their defaults, the last session for Resume,
 * slash commands, the remembered switch, and the model and effort chip.
 *
 *   bun test packages/web/test/home-start.test.ts
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Session } from '@conclave/core/types';
import { claudeEffort } from '@conclave/core/providers/effort';
import { commandOf, customAgent, lastOwnSession, modeOf, needsOwnDevice, placeName, readMode, readPicks, saveMode, savePicks, sessionSetup, startCommands, startDevice, type SetupInput } from '../src/features/home/start';
import { computerList } from '../src/features/home/Where';
import { effortShown, modelEffortWords } from '../src/features/conversation/ComposerParts';

function session(id: string, p: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    agent: 'coder',
    model: 'anthropic/claude-sonnet-5-5',
    device: 'arch',
    cwd: '~/code/app',
    mode: 'agent',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    stats: { messages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ...p,
  } as Session;
}

const devices = {
  local: { id: 'local', online: true },
  arch: { id: 'arch', online: true },
  mac: { id: 'mac', online: false },
};

const agents = [
  { name: 'assistant', model: 'openai/gpt-5.5' },
  { name: 'coder', model: 'anthropic/claude-sonnet-5-5', device: 'arch' },
  { name: 'helper', primary: false },
];

function input(p: Partial<SetupInput> = {}): SetupInput {
  return { picks: {}, agents, devices, defaultModel: 'anthropic/claude-opus-5', ...p };
}

describe('sessionSetup, Code', () => {
  test('with nothing picked and no history, the default coding agent with its model and device', () => {
    expect(sessionSetup(input())).toEqual({ agent: 'coder', model: 'anthropic/claude-sonnet-5-5', device: 'arch', cwd: undefined });
  });

  test("the hub's default agent is the assistant's own switch: Code still starts the coding agent", () => {
    expect(sessionSetup(input({ defaultAgent: 'assistant', defaultDevice: 'local' })).agent).toBe('coder');
    // a remembered pick of the assistant (from the old quick start) does not turn Code into it
    expect(sessionSetup(input({ picks: { agent: 'assistant' } })).agent).toBe('coder');
  });

  test('the last Code session sets model, device and folder', () => {
    const last = { agent: 'coder', model: 'zai/glm-5', device: 'arch', cwd: '~/notes' };
    expect(sessionSetup(input({ last }))).toEqual({ agent: 'coder', model: 'zai/glm-5', device: 'arch', cwd: '~/notes' });
  });

  test('a custom agent picked under + starts with its own model; on a phone on the last computer used, in a browser on the hub', () => {
    const last = { agent: 'coder', model: 'zai/glm-5', device: 'arch', cwd: '~/notes' };
    expect(sessionSetup(input({ surface: 'phone', last, picks: { agent: 'helper' } }))).toEqual({ agent: 'helper', model: 'anthropic/claude-opus-5', device: 'arch', cwd: '~/notes' });
    expect(sessionSetup(input({ surface: 'browser', last, picks: { agent: 'helper' } }))).toEqual({ agent: 'helper', model: 'anthropic/claude-opus-5', device: 'local', cwd: undefined });
  });

  test("the desktop app's own computer goes before the last one; a device picked by hand goes before both", () => {
    const last = { agent: 'coder', model: 'm', device: 'local', cwd: '~/code/app' };
    expect(sessionSetup(input({ surface: 'desktop', last, here: 'arch' })).device).toBe('arch');
    // the last folder belongs to the hub: not carried to this computer
    expect(sessionSetup(input({ surface: 'desktop', last, here: 'arch' })).cwd).toBeUndefined();
    expect(sessionSetup(input({ surface: 'desktop', last, here: 'arch', picks: { device: 'local' } })).device).toBe('local');
  });

  test('an offline device falls back to the first online one, and its folder is dropped', () => {
    const r = sessionSetup(input({ picks: { agent: 'coder', device: 'mac', cwd: '~/src' } }));
    expect(r.device).toBe('local');
    expect(r.cwd).toBeUndefined();
  });

  test('a picked folder stays with its device', () => {
    expect(sessionSetup(input({ picks: { agent: 'coder', device: 'arch', cwd: '~/src/site' } })).cwd).toBe('~/src/site');
  });

  test('the last folder does not follow you to another device', () => {
    const last = { agent: 'coder', model: 'm', device: 'arch', cwd: '~/code/app' };
    expect(sessionSetup(input({ last, picks: { device: 'local' } })).cwd).toBeUndefined();
  });

  test('the home folder reads as no folder (the hub default)', () => {
    expect(sessionSetup(input({ picks: { agent: 'coder', device: 'arch', cwd: '~' } })).cwd).toBeUndefined();
  });

  test('a saved pick of an agent that was removed gives way to the coding agent and the last session', () => {
    const last = { agent: 'coder', model: 'zai/glm-5', device: 'arch', cwd: '~/code/app' };
    expect(sessionSetup(input({ last, picks: { agent: 'gone' } }))).toEqual({ agent: 'coder', model: 'zai/glm-5', device: 'arch', cwd: '~/code/app' });
  });

  test('a last session whose agent was removed: the coding agent with its own model, on the last computer (a phone)', () => {
    const last = { agent: 'gone', model: 'zai/glm-5', device: 'local', cwd: '~/notes' };
    expect(sessionSetup(input({ surface: 'phone', last }))).toEqual({ agent: 'coder', model: 'anthropic/claude-sonnet-5-5', device: 'local', cwd: '~/notes' });
  });

  test('while the agent list is still loading, a saved pick is kept', () => {
    expect(sessionSetup(input({ agents: [], picks: { agent: 'helper' } })).agent).toBe('helper');
    expect(sessionSetup(input({ agents: [] })).agent).toBe('coder');
  });

  test('a last model whose provider is off (an imported Claude Code chat, the harness off) gives way to the default', () => {
    // found in a real run: Home preselected Claude Code and the session failed with 'Harness "claude-code" is disabled'
    const last = { agent: 'coder', model: 'claude-code/default', device: 'arch', cwd: '~/code/app' };
    const off = new Set(['claude-code']);
    expect(sessionSetup(input({ last, offProviders: off }))).toEqual({ agent: 'coder', model: 'anthropic/claude-sonnet-5-5', device: 'arch', cwd: '~/code/app' });
    expect(sessionSetup(input({ last, offProviders: off, picks: { model: 'claude-code/opus' } })).model).toBe('anthropic/claude-sonnet-5-5');
    // on again: carried over as before
    expect(sessionSetup(input({ last, offProviders: new Set() })).model).toBe('claude-code/default');
  });
});

describe('where Code runs by default', () => {
  // the owner, in a browser on the hub's web page: Code ran on the computer the browser was on, and the hub was not offered
  const plain = [{ name: 'coder', model: 'anthropic/claude-sonnet-5-5' }];
  const last = { agent: 'coder', model: 'm', device: 'arch', cwd: '~/code/app' };

  test('a browser on a computer starts on the hub, not on that computer or the last one used', () => {
    expect(startDevice({ surface: 'browser', here: 'arch', last: 'arch' })).toBe('local');
    expect(startDevice({})).toBe('local');
    expect(sessionSetup(input({ surface: 'browser', agents: plain, last, here: 'arch' }))).toEqual({ agent: 'coder', model: 'm', device: 'local', cwd: undefined });
  });

  test('a device picked in this browser before is kept', () => {
    expect(startDevice({ surface: 'browser', picked: 'arch' })).toBe('arch');
    expect(sessionSetup(input({ surface: 'browser', agents: plain, last, picks: { device: 'arch' } })).device).toBe('arch');
    // its last folder comes with it on that device
    expect(sessionSetup(input({ surface: 'browser', agents: plain, last, picks: { device: 'arch' } })).cwd).toBe('~/code/app');
  });

  test("the desktop app starts on its own computer when the hub may use it, else as a browser does", () => {
    expect(startDevice({ surface: 'desktop', here: 'arch', last: 'pve' })).toBe('arch');
    expect(startDevice({ surface: 'desktop', last: 'pve' })).toBe('local');
    expect(startDevice({ surface: 'desktop', here: 'arch', picked: 'local' })).toBe('local');
  });

  test('a phone starts on the last computer used', () => {
    expect(startDevice({ surface: 'phone', last: 'pve' })).toBe('pve');
    expect(startDevice({ surface: 'phone' })).toBe('local');
  });

  test("the agent's own device and the hub's default device (Settings) go before the hub", () => {
    expect(startDevice({ surface: 'browser', agent: 'pve', hubDefault: 'arch' })).toBe('pve');
    expect(startDevice({ surface: 'browser', hubDefault: 'arch' })).toBe('arch');
    expect(startDevice({ surface: 'phone', last: 'mac', agent: 'pve' })).toBe('mac');
  });

  test('a member never lands on the hub by default, only when they picked it', () => {
    const mine = { local: { id: 'local', online: true }, mine: { id: 'mine', online: true } };
    expect(sessionSetup(input({ surface: 'browser', agents: plain, devices: mine, member: true })).device).toBe('mine');
    expect(sessionSetup(input({ surface: 'browser', agents: plain, devices: mine, member: true, picks: { device: 'local' } })).device).toBe('local');
  });

  test('a folder picked keeps its device, and is not a device pick', () => {
    // the folder was picked on the hub: the session starts there with it
    expect(sessionSetup(input({ surface: 'browser', agents: plain, picks: { cwd: '~/srv', cwdDevice: 'local' } }))).toMatchObject({ device: 'local', cwd: '~/srv' });
    // the desktop app's own computer is the default there: a folder picked on the hub does not follow
    expect(sessionSetup(input({ surface: 'desktop', here: 'arch', agents: plain, picks: { cwd: '~/srv', cwdDevice: 'local' } }))).toMatchObject({ device: 'arch', cwd: undefined });
  });

  test('the hub is always a place to run, first, by its name', () => {
    const list = computerList({
      mac: { id: 'mac', online: false, info: { platform: 'darwin' } },
      arch: { id: 'arch', online: true, info: { platform: 'linux' } },
      // a hub on a phone-like platform is still the hub
      local: { id: 'local', online: true, info: { platform: 'android' } },
      phone: { id: 'phone', online: true, info: { platform: 'ios' } },
    });
    expect(list.map((d) => d.id)).toEqual(['local', 'arch', 'mac']);
    expect(placeName({ id: 'local', name: 'conclave' })).toBe('conclave (hub)');
    expect(placeName({ id: 'arch', name: 'arch-desktop' })).toBe('arch-desktop');
    expect(placeName(undefined, 'local')).toBe('The hub');
  });
});

describe('sessionSetup, Assistant', () => {
  test('the assistant agent on the hub with its own model; no device or folder, whatever Code picked', () => {
    const last = { agent: 'coder', model: 'zai/glm-5', device: 'arch', cwd: '~/notes' };
    expect(sessionSetup(input({ kind: 'assistant', last, here: 'arch', picks: { device: 'arch', cwd: '~/src', model: 'zai/glm-5' } }))).toEqual({ agent: 'assistant', model: 'openai/gpt-5.5', device: 'local' });
  });

  test("the model picked for it wins, unless its provider is off", () => {
    expect(sessionSetup(input({ kind: 'assistant', picks: { assistantModel: 'zai/glm-5' } })).model).toBe('zai/glm-5');
    expect(sessionSetup(input({ kind: 'assistant', picks: { assistantModel: 'claude-code/opus' }, offProviders: new Set(['claude-code']) })).model).toBe('openai/gpt-5.5');
  });
});

describe('modes', () => {
  test('a chat, the assistant and every other agent', () => {
    expect(modeOf({ kind: 'chat', agent: 'chat' })).toBe('chat');
    expect(modeOf({ agent: 'assistant' })).toBe('assistant');
    expect(modeOf({ agent: 'coder' })).toBe('code');
    expect(modeOf({ agent: 'reviewer' })).toBe('code');
  });

  test('Code may start any agent but the chat and the assistant', () => {
    expect(customAgent('reviewer')).toBe(true);
    expect(customAgent('assistant')).toBe(false);
    expect(customAgent('chat')).toBe(false);
    expect(customAgent(undefined)).toBe(false);
  });

  test('the last session of a mode, for its Resume line', () => {
    const all = { a: session('a', { updatedAt: 10, agent: 'assistant' }), c: session('c', { updatedAt: 5, agent: 'coder' }) };
    expect(lastOwnSession(all)?.id).toBe('a');
    expect(lastOwnSession(all, false, 'code')?.id).toBe('c');
    expect(lastOwnSession(all, false, 'assistant')?.id).toBe('a');
  });
});

describe("a member's session (docs/design/ACCOUNTS.md 5)", () => {
  // a member sees the hub by name and their own devices
  const hers = { local: { id: 'local', online: true }, lap: { id: 'lap', online: true }, old: { id: 'old', online: false } };

  test('with no device of their own, Session mode says to pair one instead of starting; the owner always has the hub', () => {
    expect(needsOwnDevice(true, { local: { id: 'local' } })).toBe(true);
    expect(needsOwnDevice(true, {})).toBe(true);
    expect(needsOwnDevice(true, { local: { id: 'local' }, lap: { id: 'lap' } })).toBe(false);
    expect(needsOwnDevice(false, { local: { id: 'local' } })).toBe(false);
  });

  test('the hub never stands in for a device of theirs', () => {
    // the hub's default device is the owner's: not in her list, so her own online one, not the hub
    expect(sessionSetup(input({ devices: hers, member: true, defaultDevice: 'owners-box' })).device).toBe('lap');
    expect(sessionSetup(input({ devices: hers, member: true, picks: { device: 'old' } })).device).toBe('lap');
    // all of hers offline: still hers, never the hub
    expect(sessionSetup(input({ devices: { ...hers, lap: { id: 'lap', online: false } }, member: true })).device).toBe('lap');
    // the hub picked by hand stays (the assistant runs there)
    expect(sessionSetup(input({ devices: hers, member: true, picks: { device: 'local' } })).device).toBe('local');
    // the owner as before: the hub stands in
    expect(sessionSetup(input({ devices: hers, defaultDevice: 'owners-box' })).device).toBe('local');
  });
});

describe('lastOwnSession', () => {
  test('skips chats, routine runs, subagents, juries, debates and archived sessions', () => {
    const all = {
      a: session('a', { updatedAt: 10 }),
      chat: session('chat', { updatedAt: 99, kind: 'chat' }),
      run: session('run', { updatedAt: 98, routineId: 'r1' }),
      sub: session('sub', { updatedAt: 97, parentId: 'a' }),
      jury: session('jury', { updatedAt: 96, mode: 'jury' }),
      debate: session('debate', { updatedAt: 95, mode: 'debate' }),
      old: session('old', { updatedAt: 94, archived: true }),
    };
    expect(lastOwnSession(all)?.id).toBe('a');
  });

  test('settled skips what is still running or waiting (Resume points at finished work)', () => {
    const all = { live: session('live', { updatedAt: 20, status: 'running' }), wait: session('wait', { updatedAt: 15, status: 'waiting_approval' }), done: session('done', { updatedAt: 10, status: 'error' }) };
    expect(lastOwnSession(all)?.id).toBe('live');
    expect(lastOwnSession(all, true)?.id).toBe('done');
  });
});

describe('commandOf', () => {
  const commands = [{ name: 'compact' }, { name: 'hookify:list' }];
  test('a known command with or without arguments', () => {
    expect(commandOf('/compact', commands)).toBe('compact');
    expect(commandOf('  /compact keep the plan', commands)).toBe('compact');
    expect(commandOf('/hookify:list', commands)).toBe('hookify:list');
  });
  test('anything else is a message', () => {
    expect(commandOf('/unknown thing', commands)).toBeUndefined();
    expect(commandOf('fix /compact later', commands)).toBeUndefined();
    expect(commandOf('/', commands)).toBeUndefined();
  });
});

// "Type / for commands" on Home listed nothing on a hub with skills but no commands of its own
describe('startCommands', () => {
  test('the hub commands, then the skills; a command wins over a skill of its name', () => {
    const list = startCommands([{ name: 'deploy', description: 'Ship it', argumentHint: '[env]' }], [{ name: 'release-notes', description: 'Notes since a tag' }, { name: 'deploy', description: 'The skill' }]);
    expect(list).toEqual([
      { name: 'deploy', description: 'Ship it', argumentHint: '[env]' },
      { name: 'release-notes', description: 'Notes since a tag' },
    ]);
    expect(startCommands([], [{ name: 'review-pr' }]).map((c) => c.name)).toEqual(['review-pr']);
    // a skill typed with arguments runs as that command once the session starts
    expect(commandOf('/review-pr 12', startCommands([], [{ name: 'review-pr' }]))).toBe('review-pr');
  });
});

describe('remembered switch and picks', () => {
  const g = globalThis as { localStorage?: unknown };
  const had = 'localStorage' in g;
  const before = g.localStorage;
  afterEach(() => {
    if (had) g.localStorage = before;
    else delete g.localStorage;
  });

  function fakeStorage() {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    return m;
  }

  test('Chat is the default, Assistant and Code are remembered', () => {
    fakeStorage();
    expect(readMode()).toBe('chat');
    saveMode('code');
    expect(readMode()).toBe('code');
    saveMode('assistant');
    expect(readMode()).toBe('assistant');
    saveMode('chat');
    expect(readMode()).toBe('chat');
  });

  test("the old remembered Session switch is not read: a plain question never starts a session by surprise", () => {
    // found in a real run: Home kept "Session" from long ago, and what looked like a chat moved to a Mac folder
    const m = fakeStorage();
    m.set('conclave.home.start', 'session');
    expect(readMode()).toBe('chat');
  });

  test('no storage (private mode) reads as Chat and empty picks, and saving does not throw', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readMode()).toBe('chat');
    expect(readPicks()).toEqual({});
    expect(() => saveMode('code')).not.toThrow();
    expect(() => savePicks({ agent: 'coder' })).not.toThrow();
  });

  test('picks round trip, and junk in storage is ignored', () => {
    const m = fakeStorage();
    savePicks({ agent: 'coder', device: 'arch', cwd: '~/src' });
    expect(readPicks()).toEqual({ agent: 'coder', model: undefined, device: 'arch', cwd: '~/src' });
    m.set('conclave.quickstart', JSON.stringify({ agent: 4, model: '', device: null }));
    expect(readPicks()).toEqual({ agent: undefined, model: undefined, device: undefined, cwd: undefined });
    m.set('conclave.quickstart', '{not json');
    expect(readPicks()).toEqual({});
  });

  test('a folder keeps its device apart from a device picked by hand, and is remembered per browser', () => {
    const m = fakeStorage();
    savePicks({ device: 'arch', cwd: '~/src', cwdDevice: 'local' });
    expect(readPicks()).toMatchObject({ device: 'arch', cwd: '~/src', cwdDevice: 'local' });
    // saved before: a folder pick saved its device as if picked by hand; that device is the folder's now, not a pick
    m.set('conclave.quickstart', JSON.stringify({ device: 'arch', cwd: '~/src' }));
    expect(readPicks()).toMatchObject({ device: undefined, cwd: '~/src', cwdDevice: 'arch' });
    // a device picked by hand (no folder with it) stays a pick
    m.set('conclave.quickstart', JSON.stringify({ device: 'arch' }));
    expect(readPicks().device).toBe('arch');
  });
});

describe('the model and effort picker (conversation/ComposerParts.tsx)', () => {
  const opus55 = claudeEffort('claude-opus-5-5')!;
  const opus46 = claudeEffort('claude-opus-4-6')!;
  const coder = { label: 'the coder agent', level: 'medium' as const };

  test("unset runs at the agent's level, else the model's default; a pick the model lacks shows as the nearest", () => {
    expect(effortShown(undefined, opus46, coder)).toBe('medium');
    expect(effortShown(undefined, opus46)).toBe('high');
    expect(effortShown('xhigh', opus46, coder)).toBe('high');
    expect(effortShown('off', opus55)).toBe('low');
    // a model without Effort has none
    expect(effortShown('high', undefined, coder)).toBeUndefined();
  });

  test('one chip: the model and the level it runs at, the name alone for Off or no levels', () => {
    expect(modelEffortWords('anthropic/claude-opus-5-5', 'medium', opus55)).toBe('Opus 5.5 Medium');
    expect(modelEffortWords('anthropic/claude-opus-4-6', 'xhigh', opus46)).toBe('Opus 4.6 Extra high');
    expect(modelEffortWords('anthropic/claude-opus-4-6', 'off', opus46)).toBe('Opus 4.6');
    expect(modelEffortWords('openai/gpt-4.1', undefined, undefined)).toBe('GPT-4.1');
    expect(modelEffortWords(undefined, undefined, undefined)).toBe('Choose a model');
  });
});
