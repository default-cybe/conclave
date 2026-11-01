/**
 * A member's own copies (docs/design/ACCOUNTS.md 5): "always allow" rules
 * land under their account, never in the hub's config, and count only in
 * their sessions; the disk cap refuses writes over the member's limit.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type TestEngine } from '../engine/harness';
import { accountKey } from '../../src/people/store';
import { MEMBER_ALLOW_KEY, memberAllow } from '../../src/engine/permissions-view';
import { forgetDiskUse } from '../../src/people/disk';
import type { Session } from '../../src/types';

let t: TestEngine | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('always allow, per account', () => {
  test("a member's always lands in their own rules; the hub config file is unchanged; others never get it", async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    const alice = engine.people.create({ name: 'alice' });
    const bob = engine.people.create({ name: 'bob' });
    const cfgFile = engine.config.paths.config;
    const before = readFileSync(cfgFile, 'utf8');
    const written: string[] = [];
    const update = engine.config.update.bind(engine.config);
    engine.config.update = (patch) => {
      written.push(...((patch as { permissions?: { allow?: string[] } }).permissions?.allow ?? []));
      return update(patch);
    };

    const ask = (s: Session, rule: string) => engine.requestApproval(s.id, { toolUseId: 'tu', tool: 'WebFetch', input: {}, summary: 'fetch', suggestedRule: rule }, new AbortController().signal);
    const hers = await engine.createSession({ kind: 'chat' }, alice.id);
    const p = ask(hers, 'WebFetch(domain:alice.example)');
    const [req] = engine.pendingApprovals();
    engine.resolveApproval(req.id, { decision: 'allow', scope: 'always' });
    expect((await p).decision).toBe('allow');

    expect(engine.repos.kv.get<string[]>(accountKey(alice.id, MEMBER_ALLOW_KEY), [])).toEqual(['WebFetch(domain:alice.example)']);
    expect(readFileSync(cfgFile, 'utf8')).toBe(before);
    expect(written).toEqual([]);
    expect(engine.permissionRulesFor(engine.requireSession(hers.id)).allow).toContain('WebFetch(domain:alice.example)');

    const bobs = await engine.createSession({ kind: 'chat' }, bob.id);
    expect(engine.permissionRulesFor(bobs).allow).not.toContain('WebFetch(domain:alice.example)');
    const owners = await engine.createSession({ kind: 'chat' });
    expect(engine.permissionRulesFor(owners).allow).not.toContain('WebFetch(domain:alice.example)');
    expect(memberAllow(engine, owners)).toEqual([]);

    // the owner's always still writes the hub config
    const p2 = ask(owners, 'WebFetch(domain:owner.example)');
    const [req2] = engine.pendingApprovals();
    engine.resolveApproval(req2.id, { decision: 'allow', scope: 'always' });
    await p2;
    expect(written).toContain('WebFetch(domain:owner.example)');
    expect(engine.repos.kv.get<string[]>(accountKey(alice.id, MEMBER_ALLOW_KEY), [])).not.toContain('WebFetch(domain:owner.example)');
  });
});

describe('disk cap', () => {
  test("refuses a write past a member's cap, counts their outputs and folder, never the owner", async () => {
    t = await startTestEngine({ script: [[{ text: 'ok' }]] });
    const { engine } = t;
    const alice = engine.people.create({ name: 'alice', settings: { diskLimitGb: 1 } });
    expect(engine.diskRefusal(alice.id, 1024)).toBeUndefined();
    expect(engine.diskRefusal(alice.id, 2 * 1024 ** 3)).toContain('of your 1 GB');
    expect(engine.diskRefusal('owner', 10 * 1024 ** 4)).toBeUndefined();

    const s = await engine.createSession({ kind: 'chat' }, alice.id);
    const out = join(engine.config.paths.home, 'outputs', s.id);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'a.bin'), Buffer.alloc(4096));
    mkdirSync(join(engine.config.paths.home, 'accounts', alice.id), { recursive: true });
    writeFileSync(join(engine.config.paths.home, 'accounts', alice.id, 'b.bin'), Buffer.alloc(4096));
    forgetDiskUse(alice.id);
    expect(engine.diskUse(alice.id).usedBytes).toBeGreaterThanOrEqual(8192);
    expect(engine.diskUse(alice.id).limitBytes).toBe(1024 ** 3);
    expect(engine.diskRefusal(alice.id, 1024 ** 3 - 4096)).toContain('Your files on this hub use');
  });
});
