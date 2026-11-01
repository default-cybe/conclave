import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';

const homes: string[] = [];

/** A ConfigStore over a temp home whose config.json holds `user`. */
function store(user: unknown): { config: ConfigStore; file: () => any; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'conclave-zai-'));
  homes.push(home);
  const path = join(home, 'config.json');
  if (user !== undefined) writeFileSync(path, JSON.stringify(user));
  const config = new ConfigStore(home);
  return { config, file: () => JSON.parse(readFileSync(path, 'utf8')), home };
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('providers.zai moves to Chat Completions at /api/coding/paas/v4', () => {
  test('the old Anthropic shim default loads as the new default, and the file loses both keys', () => {
    const { config, file } = store({ providers: { zai: { type: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'k' } } });
    expect(config.get().providers.zai).toMatchObject({ type: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'k', subscription: 'zai-coding' });
    expect(file().providers.zai).toEqual({ apiKey: 'k', migrated: 'paas-v4' });
  });

  test('a type "anthropic" with no URL meant the old default too', () => {
    const { config } = store({ providers: { zai: { type: 'anthropic' } } });
    expect(config.get().providers.zai).toMatchObject({ type: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4' });
  });

  test('another /anthropic URL without a type gets type "anthropic" pinned', () => {
    const { config, file } = store({ providers: { zai: { baseUrl: 'https://open.bigmodel.cn/api/anthropic' } } });
    expect(config.get().providers.zai).toMatchObject({ type: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic' });
    expect(file().providers.zai).toEqual({ type: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', migrated: 'paas-v4' });
  });

  test('an OpenAI-wire entry stays as it is', () => {
    const zai = { type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4' };
    const { config, file } = store({ providers: { zai } });
    expect(config.get().providers.zai).toMatchObject(zai);
    expect(file().providers.zai).toEqual(zai);
  });

  test('an empty file loads the new default', () => {
    const { config } = store(undefined);
    expect(config.get().providers.zai).toMatchObject({ type: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKeyEnv: 'ZAI_API_KEY' });
    expect(config.get().providers.zai.models?.[0]).toBe('glm-5.3');
  });

  test('the move runs on load only: a later update or replace back to the shim stays', () => {
    const { config, file } = store({});
    const shim = { type: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' };
    config.update({ providers: { zai: shim } } as any);
    expect(config.get().providers.zai).toMatchObject(shim);
    expect(file().providers.zai).toEqual({ ...shim, migrated: 'paas-v4' });
    config.replace({ providers: { zai: { type: 'anthropic' } } } as any);
    expect(config.get().providers.zai.type).toBe('anthropic');
    expect(file().providers.zai).toEqual({ type: 'anthropic', migrated: 'paas-v4' });
  });

  test('a switch back to the shim after the move survives a restart', () => {
    const { config, file, home } = store({ providers: { zai: { type: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'k' } } });
    expect(config.get().providers.zai.type).toBe('openai');
    const shim = { type: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' };
    config.update({ providers: { zai: shim } } as any);
    // the next load sees the mark and leaves the entry alone
    const again = new ConfigStore(home);
    expect(again.get().providers.zai).toMatchObject(shim);
    expect(file().providers.zai).toEqual({ ...shim, apiKey: 'k', migrated: 'paas-v4' });
  });

  test('an edit that leaves zai alone does not mark it', () => {
    const zai = { type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4' };
    const { config, file } = store({ providers: { zai } });
    config.update({ defaultModel: 'zai/glm-5.3' } as any);
    expect(file().providers.zai).toEqual(zai);
  });

  test('a placeholder URL is left as it is', () => {
    const zai = { type: 'anthropic', baseUrl: '${env:ZAI_BASE}' };
    const { file } = store({ providers: { zai } });
    expect(file().providers.zai).toEqual(zai);
    const bare = { baseUrl: '${secret:zai.url}/anthropic' };
    expect(store({ providers: { zai: bare } }).file().providers.zai).toEqual(bare);
  });
});
