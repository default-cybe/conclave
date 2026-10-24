/**
 * A plan paid with an API key (the Z.ai Coding Plan): an account named by
 * its plan, with the 5 hour and weekly windows its usage reader stored, and
 * the same route for its models as before.
 *
 *   bun test packages/core/test/accounts/keyplan.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { openDb } from '../../src/storage/db';
import { Repos } from '../../src/storage/repos';
import { EventBus } from '../../src/util/bus';
import { AccountsService } from '../../src/accounts/service';

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const H = 3_600_000;

function setup(now: number) {
  const home = mkdtempSync(join(tmpdir(), 'conclave-keyplan-'));
  homes.push(home);
  const config = new ConfigStore(home);
  config.setSecret('providers', 'zai', 'test-key-not-real');
  const repos = new Repos(openDb(':memory:'));
  const bus = new EventBus();
  const svc = new AccountsService({ config, repos, bus, now: () => now });
  // as usage/readers/zai.ts stores it: for the provider, no account
  repos.usage.setLimit({
    provider: 'zai',
    label: 'Z.ai Coding Plan',
    windows: [
      { name: '5h', usedPercent: 25, resetsAt: now + 2 * H },
      { name: '7d', usedPercent: 10, resetsAt: now + 50 * H },
      { name: 'MCP monthly', usedPercent: 100, limit: 1000, remaining: 0 },
    ],
    updatedAt: now,
    source: 'api',
  });
  return { svc, repos };
}

describe('the Z.ai Coding Plan', () => {
  test('is an account with its plan name and the windows the usage reader stored', () => {
    const now = Date.parse('2026-10-23T09:00:00Z');
    const { svc, repos } = setup(now);

    const a = svc.status().accounts.find((x) => x.provider === 'zai');
    expect(a).toMatchObject({ id: 'api-zai', vendor: 'zai', kind: 'api', plan: 'Z.ai Coding Plan', subscription: 'zai-coding' });
    expect(a!.windows.map((w) => [w.name, w.kind, w.resetsAt])).toEqual([
      ['5h', 'session', now + 2 * H],
      ['7d', 'weekly', now + 50 * H],
      ['MCP monthly', 'extra', undefined],
    ]);
    // the MCP tool quota does not stop coding calls
    expect(a!.state).toBe('ready');

    // GLM keeps its route: no plan order applies, calls on zai are this account's
    expect(svc.providersFor('glm-5.3')).toBeUndefined();
    expect(svc.accountFor('zai', 'glm-5.3')).toBe('api-zai');

    // publish keeps the reader's state and adds no second one
    svc.publish();
    expect(repos.usage.limits().map((l) => `${l.provider}:${l.account ?? ''}`)).toEqual(['zai:']);

    // the window starter is for signed in plans
    expect(() => svc.patch('api-zai', { starter: { enabled: true } })).toThrow('window starter');
  });

  test('a 429 marks the reader state blocked with its reset, so the Usage page shows it', () => {
    const now = Date.parse('2026-10-23T09:00:00Z');
    const { svc, repos } = setup(now);
    // as session/stream.ts does on a 429 with nowhere to go
    svc.noteLimit('zai', 'glm-5.3', { resetAt: now + H });
    svc.observeHeaders('zai', [{ name: 'limit', usedPercent: 100, resetsAt: now + H }]);
    svc.publish();
    const l = repos.usage.limits();
    expect(l.map((x) => `${x.provider}:${x.account ?? ''}`)).toEqual(['zai:']);
    expect(l[0].blocked).toBe(true);
    expect(l[0].windows.find((w) => w.name === 'limit')?.resetsAt).toBe(now + H);
    expect(l[0].windows.map((w) => w.name)).toContain('5h');
  });
});
