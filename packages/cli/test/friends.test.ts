import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FriendDto } from '@conclave/core/client/index.ts';
import { OWNER } from '../../server/test/helpers';
import { makePeerHub, waitFor, type PeerHub } from '../../server/test/peer-helpers';
import { findFriend } from '../src/commands/friends';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
let a: PeerHub;
let b: PeerHub;
let home: string;

beforeAll(() => {
  a = makePeerHub('Alice');
  b = makePeerHub('Bob');
  home = mkdtempSync(join(tmpdir(), 'conclave-friends-cli-'));
});
afterAll(async () => {
  await a.close();
  await b.close();
  rmSync(home, { recursive: true, force: true });
});

async function cli(hub: PeerHub, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { CONCLAVE_HUB: _hub, CONCLAVE_TOKEN: _token, ...env } = process.env;
  const proc = Bun.spawn([process.execPath, ENTRY, ...args, '--hub', hub.url, '--token', OWNER], { env: { ...env, CONCLAVE_HOME: home, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe('conclave friends', () => {
  test('invite, accept, ls, verify, send-note, inbox and rm between two hubs', async () => {
    const invite = await cli(a, ['friends', 'invite', '--json']);
    expect(invite.stderr).toBe('');
    const link = JSON.parse(invite.stdout).link as string;
    expect(link).toStartWith('conclave://friend?fp=');

    const accepted = await cli(b, ['friends', 'accept', link, '--name', 'Bob']);
    expect(accepted.stderr).toBe('');
    expect(accepted.stdout).toContain("Request sent. Their hub's key checked out");

    const listA = await cli(a, ['friends']);
    expect(listA.stdout).toContain('Bob');
    expect(listA.stdout).toContain('asks to be friends');
    expect(listA.stdout).toContain('conclave friends accept "Bob"');

    const yes = await cli(a, ['friends', 'accept', 'Bob']);
    expect(yes.stdout).toContain('You and Bob are friends. Safety code');
    const code = /Safety code (\d{5} \d{5} \d{5} \d{5})/.exec(yes.stdout)![1];

    await waitFor('Bob to see the accept', async () => ((await b.api('/api/friends')).body as FriendDto[]).some((f) => f.status === 'active'));
    const listB = await cli(b, ['friends']);
    expect(listB.stdout).toContain('test hub');
    expect(listB.stdout).toContain(code);

    // Alice's hub sent its default name (the fake hub is "test hub"); Bob's side picks it by name or key
    const fpA = a.running!.conclave.ctx.identity.fingerprint;
    const verified = await cli(b, ['friends', 'verify', fpA.slice(0, 8)]);
    expect(verified.stdout).toContain('is verified');

    const sent = await cli(a, ['friends', 'send-note', 'Bob', 'hello', 'from', 'the', 'CLI']);
    expect(sent.stdout).toContain('Delivered to Bob.');
    const inbox = await cli(b, ['friends', 'inbox']);
    expect(inbox.stdout).toContain('hello from the CLI');

    const removed = await cli(b, ['friends', 'rm', 'test hub']);
    expect(removed.stdout).toContain('Removed test hub.');
    await waitFor('Alice to hear', async () => ((await a.api('/api/friends')).body as FriendDto[]).length === 0);
    expect((await cli(a, ['friends'])).stdout).toContain('No friends yet');

    const unknown = await cli(a, ['friends', 'send-note', 'Nobody', 'hi']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No friend called "Nobody"');
  }, 60_000);

  test('findFriend takes an id, a key, its start, or a name', () => {
    const f = (id: string, name: string, fingerprint: string) => ({ id, name, fingerprint }) as FriendDto;
    const list = [f('frd_1', 'Alice', 'aaaa1111'.repeat(4)), f('frd_2', 'Alina', 'bbbb2222'.repeat(4))];
    expect(findFriend(list, 'frd_2').name).toBe('Alina');
    expect(findFriend(list, 'alice').id).toBe('frd_1');
    expect(findFriend(list, 'bbbb 2222').id).toBe('frd_2');
    expect(() => findFriend(list, 'Al')).toThrow('More than one friend matches');
    expect(() => findFriend(list, 'Carol')).toThrow('No friend called');
  });
});
