import { afterEach, describe, expect, test } from 'bun:test';
import { LocalMachine, isHubSecretEnv } from '../../src/machine/local';

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('hub secrets stay out of tool shells', () => {
  test('names', () => {
    expect(isHubSecretEnv('CONCLAVE_TOKEN')).toBe(true);
    expect(isHubSecretEnv('ANTHROPIC_API_KEY')).toBe(true);
    expect(isHubSecretEnv('CONCLAVE_GITHUB_TOKEN')).toBe(true);
    expect(isHubSecretEnv('CONCLAVE_HOME')).toBe(false);
    expect(isHubSecretEnv('PATH')).toBe(false);
    expect(isHubSecretEnv('GITHUB_TOKEN')).toBe(false);
  });

  test('a shell cannot read the hub token or a provider key', async () => {
    process.env.CONCLAVE_TOKEN = 'hub-secret-token';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    process.env.SOME_OTHER = 'visible';
    const m = new LocalMachine();
    const r = await m.exec('echo "[$CONCLAVE_TOKEN][$ANTHROPIC_API_KEY][$SOME_OTHER]"', { cwd: '/tmp' });
    expect(r.stdout.trim()).toBe('[][][visible]');
  });

  test('a value passed on purpose still reaches the process', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
    const m = new LocalMachine();
    const r = await m.exec('echo "[$ANTHROPIC_API_KEY]"', { cwd: '/tmp', env: { ANTHROPIC_API_KEY: 'given' } });
    expect(r.stdout.trim()).toBe('[given]');
  });

  test('CONCLAVE_PASS_ENV lets a named variable through', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.CONCLAVE_PASS_ENV = 'OPENAI_API_KEY';
    const m = new LocalMachine();
    const r = await m.exec('echo "[$OPENAI_API_KEY]"', { cwd: '/tmp' });
    expect(r.stdout.trim()).toBe('[sk-openai]');
  });
});
