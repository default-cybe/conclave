/** Basic Memory connected under Memory, Connections counts as installed in Discover. */
import { afterEach, describe, expect, test } from 'bun:test';
import { CatalogInstaller } from '../../src/catalog/install';
import { CatalogStore } from '../../src/catalog/store';
import { CatalogHttp } from '../../src/catalog/http';
import { GithubClient } from '../../src/catalog/github';
import { McpRegistry } from '../../src/catalog/registry';
import { gitRunner } from '../../src/catalog/git';
import { RECOMMENDED } from '../../src/catalog/recommended';
import { cleanupAll, fakeHost, fixtureFetch, tempHome } from './helpers';

afterEach(cleanupAll);

function installer(connections: Array<{ id: string; type: string; enabled?: boolean; options?: Record<string, unknown> }>) {
  const home = tempHome();
  const store = new CatalogStore(home.db);
  const f = fixtureFetch([]);
  const http = new CatalogHttp(store, { fetch: f });
  const host = { ...fakeHost(home), memoryConnections: () => connections };
  return new CatalogInstaller({ paths: home.paths, store, http, git: gitRunner(), github: new GithubClient({ http, fetch: f }), registry: new McpRegistry(http), host, checkBin: async () => true } as never);
}

const basicMemory = RECOMMENDED.find((i) => i.id === 'mcp:basic-memory')!;

describe('Basic Memory in Discover', () => {
  test('a basic-memory connection marks it installed, pointing at Memory, Connections', () => {
    expect(installer([{ id: 'notes', type: 'basic-memory' }]).matchByName(basicMemory)).toMatchObject({ ref: 'notes', href: '/memory/connections' });
  });
  test('an mcp connection to the basic-memory server counts too', () => {
    expect(installer([{ id: 'external', type: 'mcp', options: { server: 'basic-memory' } }]).matchByName(basicMemory)).toMatchObject({ ref: 'external' });
  });
  test('a turned-off connection, or none, does not', () => {
    expect(installer([{ id: 'notes', type: 'basic-memory', enabled: false }]).matchByName(basicMemory)).toBeUndefined();
    expect(installer([]).matchByName(basicMemory)).toBeUndefined();
  });
});
