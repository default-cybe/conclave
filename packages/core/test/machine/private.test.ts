import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMachine, isHubSecretEnv } from '../../src/machine/local';
import { commandTouchesHubPrivate, isHubPrivatePath } from '../../src/machine/private';

let home = '';
let work = '';
const savedHome = process.env.CONCLAVE_HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'conclave-private-'));
  work = mkdtempSync(join(tmpdir(), 'conclave-private-work-'));
  process.env.CONCLAVE_HOME = home;
  mkdirSync(join(home, 'cliproxy', 'auth'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'cliproxy', 'auth', 'claude-me.json'), '{"refresh_token":"rt-secret"}');
  writeFileSync(join(home, 'cliproxy', 'config.yaml'), 'access:\n  api-keys: ["client-secret"]\n');
  writeFileSync(join(home, 'notes.txt'), 'rt-secret is a word here too');
  symlinkSync(join(home, 'cliproxy'), join(work, 'link'));
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.CONCLAVE_HOME;
  else process.env.CONCLAVE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('the CLIProxyAPI folder is out of reach of tools', () => {
  test('paths inside it, also through a symlink', () => {
    expect(isHubPrivatePath(join(home, 'cliproxy'))).toBe(true);
    expect(isHubPrivatePath(join(home, 'cliproxy', 'auth', 'claude-me.json'))).toBe(true);
    expect(isHubPrivatePath(join(work, 'link', 'auth', 'claude-me.json'))).toBe(true);
    expect(isHubPrivatePath(join(home, 'cliproxy-notes'))).toBe(false);
    expect(isHubPrivatePath(join(home, 'notes.txt'))).toBe(false);
  });

  test('reads, writes, listings and removes are refused', async () => {
    const m = new LocalMachine();
    await expect(m.readText(join(home, 'cliproxy', 'config.yaml'))).rejects.toThrow(/subscription sign-ins/);
    await expect(m.readFile(join(work, 'link', 'auth', 'claude-me.json'))).rejects.toThrow(/Refused/);
    await expect(m.readdir(join(home, 'cliproxy', 'auth'))).rejects.toThrow(/Refused/);
    await expect(m.writeFile(join(home, 'cliproxy', 'auth', 'x.json'), '{}')).rejects.toThrow(/Refused/);
    await expect(m.remove(home, { recursive: true })).rejects.toThrow(/Refused/);
    await expect(m.rename(join(home, 'cliproxy', 'config.yaml'), join(work, 'stolen.yaml'))).rejects.toThrow(/Refused/);
    expect(await m.readText(join(home, 'notes.txt'))).toContain('word');
  });

  test('a search above it never shows what is inside', async () => {
    const m = new LocalMachine();
    const found = await m.grep({ pattern: 'rt-secret', path: home, outputMode: 'content' });
    expect(found.output).toContain('notes.txt');
    expect(found.output).not.toContain('claude-me.json');
    const files = await m.glob('**/*', { cwd: home, dot: true });
    expect(files.some((f) => f.includes('/cliproxy/'))).toBe(false);
    expect(files.some((f) => f.endsWith('notes.txt'))).toBe(true);
    await expect(m.grep({ pattern: 'x', path: join(home, 'cliproxy'), outputMode: 'files' })).rejects.toThrow(/Refused/);
  });

  test('a shell command that names it is refused', async () => {
    expect(commandTouchesHubPrivate(`cat ${home}/cliproxy/auth/claude-me.json`)).toBe(true);
    expect(commandTouchesHubPrivate('cat ~/.conclave/cliproxy/config.yaml')).toBe(true);
    expect(commandTouchesHubPrivate('cat $CONCLAVE_HOME/cliproxy/config.yaml')).toBe(true);
    expect(commandTouchesHubPrivate('ls ~/code/cliproxy-fork')).toBe(false);
    const m = new LocalMachine();
    const r = await m.exec(`cat ${home}/cliproxy/config.yaml`, { cwd: work });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Refused');
    const inside = await m.exec('ls', { cwd: join(home, 'cliproxy') });
    expect(inside.stderr).toContain('Refused');
  });

  test('its management password never reaches a tool shell', () => {
    expect(isHubSecretEnv('MANAGEMENT_PASSWORD')).toBe(true);
    expect(isHubSecretEnv('CLIPROXY_MANAGEMENT_KEY')).toBe(true);
  });
});

describe('the hub secrets file is out of reach of tools', () => {
  test('reads, searches and shell commands that name it are refused, also through the Bash tool and a background shell', async () => {
    const file = join(home, 'secrets.json');
    writeFileSync(file, '{"values":{"github":"tok_never_shown"}}');
    try {
      expect(isHubPrivatePath(file)).toBe(true);
      expect(isHubPrivatePath(join(home, 'secrets.json.txt'))).toBe(false);
      expect(commandTouchesHubPrivate('cat ~/.conclave/secrets.json')).toBe(true);
      expect(commandTouchesHubPrivate(`cat ${file}`)).toBe(true);
      expect(isHubSecretEnv('CONCLAVE_GITHUB_TOKEN')).toBe(true);
      const m = new LocalMachine();
      await expect(m.readText(file)).rejects.toThrow(/keys and tokens/);
      const found = await m.grep({ pattern: 'tok_never_shown|rt-secret', path: home, outputMode: 'content' });
      expect(found.output).not.toContain('tok_never_shown');
      // the Bash tool hands its command over in __CONCLAVE_CMD
      const r = await m.exec('eval "$__CONCLAVE_CMD"', { cwd: work, env: { __CONCLAVE_CMD: `cat ${file}` } });
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('keys and tokens');
      expect(() => m.spawn('bash', ['-c', `cat ${file}`], { cwd: work })).toThrow(/keys and tokens/);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("each member's own CLIProxyAPI and secrets file are out of reach of tools (docs/design/ACCOUNTS.md 12)", () => {
  test('paths, listings, searches and shell commands that name them are refused, for any account id', async () => {
    const acct = join(home, 'accounts', 'acc_alice');
    mkdirSync(join(acct, 'cliproxy', 'auth'), { recursive: true, mode: 0o700 });
    writeFileSync(join(acct, 'cliproxy', 'auth', 'codex-alice.json'), '{"refresh_token":"rt-alice-plan"}');
    writeFileSync(join(acct, 'secrets.json'), '{"hub":{"cliproxy.clientKey":"cpk-alice-never-shown"}}');
    writeFileSync(join(acct, 'notes.txt'), 'hers to read');
    try {
      expect(isHubPrivatePath(join(acct, 'cliproxy'))).toBe(true);
      expect(isHubPrivatePath(join(acct, 'cliproxy', 'auth', 'codex-alice.json'))).toBe(true);
      expect(isHubPrivatePath(join(acct, 'secrets.json'))).toBe(true);
      // also for an account whose folder is not there yet
      expect(isHubPrivatePath(join(home, 'accounts', 'acc_new', 'cliproxy', 'config.yaml'))).toBe(true);
      expect(isHubPrivatePath(join(acct, 'notes.txt'))).toBe(false);
      expect(isHubPrivatePath(join(acct, 'cliproxy-notes'))).toBe(false);
      const m = new LocalMachine();
      await expect(m.readText(join(acct, 'secrets.json'))).rejects.toThrow(/Refused/);
      await expect(m.readdir(join(acct, 'cliproxy', 'auth'))).rejects.toThrow(/Refused/);
      await expect(m.writeFile(join(acct, 'cliproxy', 'auth', 'x.json'), '{}')).rejects.toThrow(/Refused/);
      const found = await m.grep({ pattern: 'rt-alice-plan|cpk-alice-never-shown|hers', path: home, outputMode: 'content' });
      expect(found.output).toContain('notes.txt');
      expect(found.output).not.toContain('rt-alice-plan');
      expect(found.output).not.toContain('cpk-alice-never-shown');
      const files = await m.glob('**/*', { cwd: home, dot: true });
      expect(files.filter((f) => f.includes('/accounts/') && (f.includes('/cliproxy') || f.endsWith('secrets.json')))).toEqual([]);
      for (const cmd of [`cat ${acct}/secrets.json`, `ls ${home}/accounts/*/cliproxy/auth`, 'cat $CONCLAVE_HOME/accounts/acc_alice/secrets.json', 'cat ~/.conclave/accounts/acc_alice/cliproxy/config.yaml']) expect([cmd, commandTouchesHubPrivate(cmd)]).toEqual([cmd, true]);
      const r = await m.exec(`cat ${acct}/cliproxy/auth/codex-alice.json`, { cwd: work });
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('Refused');
    } finally {
      rmSync(join(home, 'accounts'), { recursive: true, force: true });
    }
  });
});
