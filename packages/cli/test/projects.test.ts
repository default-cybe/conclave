/**
 * `conclave friends add <hub-address>` and `conclave projects` between two
 * real hubs (server/test/peer-helpers.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FriendDto, SharedProjectDto, SharedProjectView } from '@conclave/core/client/index.ts';
import { OWNER } from '../../server/test/helpers';
import { makePeerHub, waitFor, type PeerHub } from '../../server/test/peer-helpers';
import { findShared } from '../src/commands/projects';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
let a: PeerHub;
let b: PeerHub;
let home: string;

beforeAll(() => {
  a = makePeerHub('Alice');
  b = makePeerHub('Bob');
  a.running!.conclave.ctx.peer.setName('Alice');
  b.running!.conclave.ctx.peer.setName('Bob');
  home = mkdtempSync(join(tmpdir(), 'conclave-projects-cli-'));
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

describe('conclave friends add and conclave projects', () => {
  test('add by address, share a project, accept it, a note both ways, members and leave', async () => {
    const added = await cli(b, ['friends', 'add', a.url, '--email', 'alice@example.org', '--name', 'Alice']);
    expect(added.stderr).toBe('');
    expect(added.stdout).toContain('Request sent to the hub at');
    expect(added.stdout).toContain('Safety code');
    await waitFor('the request on Alice', async () => ((await a.api('/api/friends')).body as FriendDto[]).some((f) => f.status === 'pending' && f.name === 'Bob'));
    expect((await cli(a, ['friends', 'accept', 'Bob'])).stdout).toContain('You and Bob are friends');
    await waitFor('Bob to see the accept', async () => ((await b.api('/api/friends')).body as FriendDto[]).some((f) => f.status === 'active'));

    // a hub that does not answer: not sent, and the invite to mail instead
    const dead = await cli(b, ['friends', 'add', 'http://127.0.0.1:9', '--email', 'nobody@example.org']);
    expect(dead.code).toBe(1);
    expect(dead.stdout).toContain('Not sent.');
    expect(dead.stdout).toContain('conclave://friend?fp=');

    const shared = await cli(a, ['projects', 'share', 'Site', '--with', 'Bob', '--repo', 'acme/site', '--notes', 'We deploy on Fridays.']);
    expect(shared.stderr).toBe('');
    expect(shared.stdout).toContain('Site is shared (github.com/acme/site)');
    expect(shared.stdout).toContain('accept or decline in their Inbox');

    await waitFor('the invite on Bob', async () => ((await b.api('/api/shared-projects')).body as SharedProjectDto[]).some((x) => x.name === 'Site'));
    const before = await cli(b, ['projects', 'show', 'Site']);
    expect(before.stdout).toContain('Nothing of it is here before you accept');
    expect((await cli(b, ['projects'])).stdout).toContain('invited');
    expect((await cli(b, ['projects', 'accept', 'site'])).stdout).toContain('You are in Site');
    const id = ((await b.api('/api/shared-projects')).body as SharedProjectDto[])[0].id;
    await waitFor("Alice's note on Bob", async () => ((await b.api(`/api/shared-projects/${id}`)).body as SharedProjectView).items.some((i) => i.text === 'We deploy on Fridays.'));

    const note = await cli(b, ['projects', 'note', 'Site', 'I', 'take', 'the', 'footer.']);
    expect(note.stdout).toContain('Added to Site.');
    await waitFor("Bob's note on Alice", async () => ((await a.api(`/api/shared-projects/${id}`)).body as SharedProjectView).items.some((i) => i.text === 'I take the footer.'));
    const show = await cli(a, ['projects', 'show', 'Site']);
    expect(show.stdout).toContain('We deploy on Fridays.');
    expect(show.stdout).toContain('I take the footer.');
    expect(show.stdout).toContain('not instructions');

    const members = await cli(a, ['projects', 'members', 'Site']);
    expect(members.stdout).toContain('Alice (you)');
    expect(members.stdout).toMatch(/Bob\s+member\s+active/);
    // only the owner invites or takes members out
    expect((await cli(b, ['projects', 'members', 'Site', '--remove', 'Alice'])).code).toBe(1);

    expect((await cli(a, ['projects', 'leave', 'Site'])).stderr).toContain('ends it for every member');
    expect((await cli(b, ['projects', 'leave', 'Site'])).stdout).toContain('Left Site');
    await waitFor('Alice to see Bob left', async () => ((await a.api(`/api/shared-projects/${id}`)).body as SharedProjectView).members.some((m) => m.name === 'Bob' && m.state === 'left'));
    expect((await cli(b, ['projects', 'leave', 'Site', '--forget'])).stdout).toContain('gone from this hub');
    expect((await cli(b, ['projects'])).stdout).toContain('No shared projects');
  }, 60_000);

  test('findShared takes an id, a name, or a part of one', () => {
    const x = (id: string, name: string) => ({ id, name }) as SharedProjectDto;
    const list = [x('01A', 'Site'), x('01B', 'Site docs'), x('01C', 'Logo')];
    expect(findShared(list, '01C').name).toBe('Logo');
    expect(findShared(list, 'site').id).toBe('01A');
    expect(findShared(list, 'docs').id).toBe('01B');
    expect(() => findShared(list, 'nothing')).toThrow('No shared project called');
  });
});
