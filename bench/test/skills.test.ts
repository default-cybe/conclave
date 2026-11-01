import { describe, expect, test } from 'bun:test';
import { armArgv, DEFAULT_SKILLS, isHubArm, parseArm } from '../lib/arms';
import { installCatalogItems } from '../lib/hub';

/** The A+skills arm: arm A with catalog items installed into its hub through the hub's catalog API. */
describe('A+skills arm', () => {
  test('arm names parse in any case; A+skills runs in a hub with the same command as A', () => {
    expect(parseArm('a+skills')).toBe('A+skills');
    expect(parseArm(' A ')).toBe('A');
    expect(parseArm('b')).toBe('B');
    expect(() => parseArm('A+tricks')).toThrow('unknown arm');
    expect(isHubArm('A+skills')).toBe(true);
    expect(isHubArm('B')).toBe(false);
    const ctx = { model: 'claude-sonnet-5-5', prompt: 'p', copy: '/w/repo', limitS: 600, conclaveSrc: '/src', hub: { url: 'http://127.0.0.1:7799', token: 't' }, claudeFlags: null, matchEffort: null };
    expect(armArgv({ ...ctx, arm: 'A+skills' })).toEqual(armArgv({ ...ctx, arm: 'A' }));
    expect(DEFAULT_SKILLS).toEqual(['plugin:ponytail', 'plugin:caveman']);
  });

  test('items are previewed then installed one at a time; a failure is reported per item', async () => {
    const calls: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body: any = await req.json();
        calls.push(`${path} ${JSON.stringify(body)} ${req.headers.get('authorization')}`);
        if (path === '/api/catalog/preview') {
          if (body.id === 'plugin:broken') return Response.json({ error: 'repo not reachable' }, { status: 502 });
          return Response.json({ planId: `plan-${body.id}`, warnings: ['needs node'] });
        }
        return Response.json({ ok: true, installed: { id: 'x', sha: 'abc123' }, warnings: [] });
      },
    });
    try {
      const out = await installCatalogItems(`http://127.0.0.1:${server.port}`, 'tok', ['plugin:ponytail', 'plugin:broken']);
      expect(out).toEqual([
        { id: 'plugin:ponytail', ok: true, sha: 'abc123', warnings: ['needs node'], error: null },
        { id: 'plugin:broken', ok: false, sha: null, warnings: [], error: '502 repo not reachable' },
      ]);
      expect(calls).toEqual([
        '/api/catalog/preview {"id":"plugin:ponytail"} Bearer tok',
        '/api/catalog/install {"planId":"plan-plugin:ponytail","enable":true} Bearer tok',
        '/api/catalog/preview {"id":"plugin:broken"} Bearer tok',
      ]);
    } finally {
      server.stop(true);
    }
  });
});
