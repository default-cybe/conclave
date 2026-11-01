import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../../src/engine';
import type { Engine } from '../../src/engine/engine';
import { parseBackup, redactConfig } from '../../src/engine/backup';
import type { HubBackup } from '../../src/client';
import type { Message } from '../../src/types';
import { FakeMachine } from '../machine/fake-machine';
import { cleanup, tempDir } from '../extensions/_helpers';

const dirs: string[] = [];
const engines: Engine[] = [];
const savedClaude = process.env.CLAUDE_CONFIG_DIR;

async function hub(): Promise<Engine> {
  const home = tempDir('conclave-backup-');
  dirs.push(home);
  if (!process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR === savedClaude) {
    const claude = tempDir('conclave-backup-claude-');
    dirs.push(claude);
    process.env.CLAUDE_CONFIG_DIR = claude;
  }
  const e = await createEngine({ home, noBackground: true, version: 'test' });
  engines.push(e);
  return e;
}

afterEach(async () => {
  for (const e of engines.splice(0)) await e.shutdown();
  cleanup(...dirs.splice(0));
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
});

/** A hub with one of everything a backup carries. */
async function busyHub(): Promise<Engine> {
  const a = await hub();
  a.config.update({
    defaultModel: 'zai/glm-5',
    defaultDevice: 'arch-desktop',
    search: { provider: 'brave', apiKey: 'brv-secret' },
    mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ghp_secret' } } },
    gateway: { routes: { gemini: false } },
    ui: { theme: 'dark', onboarded: true },
  });
  a.config.setSecret('providers', 'anthropic', 'sk-ant-api03-secret');
  a.config.setSecret('values', 'CF_API_TOKEN', 'cf-secret');
  await a.extensions.saveAgent({ name: 'homelab-helper', description: 'Proxmox and LXC chores on pve.', prompt: 'You look after the homelab.', source: 'user' }, 'user');
  a.routines.create({ name: 'Server watchdog', schedule: '*/30 * * * *', prompt: 'Check the containers on pve.', agent: 'sysadmin' });
  a.createTask({ title: 'Patch OpenSSH on all boxes', status: 'todo' });
  await a.memory.save({ content: 'The hub madx runs in Proxmox LXC 104 on pve.', kind: 'fact' });
  const s = await a.createSession({ title: 'Reverse proxy for the Proxmox homelab', agent: 'assistant' });
  const msg = (seq: number, role: Message['role'], text: string): Message => ({ id: `msg_${seq}`, sessionId: s.id, seq, role, kind: 'normal', content: [{ type: 'text', text }], createdAt: Date.now() + seq });
  a.repos.messages.insert(msg(1, 'user', 'Caddy or Traefik for pve?'));
  a.repos.messages.insert(msg(2, 'assistant', 'Use Caddy.'));
  a.repos.sessions.update({ ...a.repos.sessions.get(s.id)!, status: 'running' });
  return a;
}

describe('redactConfig', () => {
  test('drops secret values, keeps env names and placeholders', () => {
    const { config, redacted } = redactConfig({
      providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' }, custom: { apiKey: 'sk-live', baseUrl: 'https://x' }, ref: { apiKey: '${secret:custom}' } },
      search: { provider: 'brave', apiKey: 'brv-1' },
      mcpServers: { gh: { headers: { Authorization: 'Bearer x' }, env: { GITHUB_TOKEN: 'ghp_1', LOG_LEVEL: 'info' } } },
      permissions: { allow: ['Bash(git status)'] },
    });
    expect(redacted.sort()).toEqual(['mcpServers.gh.env.GITHUB_TOKEN', 'mcpServers.gh.headers.Authorization', 'providers.custom.apiKey', 'search.apiKey']);
    expect(config).toEqual({
      providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' }, custom: { baseUrl: 'https://x' }, ref: { apiKey: '${secret:custom}' } },
      search: { provider: 'brave' },
      mcpServers: { gh: { headers: {}, env: { LOG_LEVEL: 'info' } } },
      permissions: { allow: ['Bash(git status)'] },
    });
  });

  test('keeps values that only point at a secret, with or without an auth scheme word', () => {
    const { config, redacted } = redactConfig({
      mcpServers: {
        gh: { headers: { Authorization: 'Bearer ${secret:GITHUB_TOKEN}' }, env: { GITHUB_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}', API_KEY: '${env:HASS_KEY}' } },
        mixed: { headers: { Authorization: 'Bearer ${secret:a}-and-a-literal' }, env: { API_KEY: 'sk-${env:X}' } },
      },
    });
    expect(redacted.sort()).toEqual(['mcpServers.mixed.env.API_KEY', 'mcpServers.mixed.headers.Authorization']);
    expect(config.mcpServers).toEqual({
      gh: { headers: { Authorization: 'Bearer ${secret:GITHUB_TOKEN}' }, env: { GITHUB_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}', API_KEY: '${env:HASS_KEY}' } },
      mixed: { headers: {}, env: {} },
    });
  });
});

describe('backup and restore', () => {
  test('a backup carries settings, agents, routines, tasks, notes and sessions, without secrets', async () => {
    const a = await busyHub();
    const b = a.backup();
    expect(b.format).toBe('conclave-backup');
    expect(b.includesSecrets).toBe(false);
    expect(b.secrets).toBeUndefined();
    expect(b.secretNames).toEqual({ providers: ['anthropic'], values: ['CF_API_TOKEN'] });
    expect((b.config.server as Record<string, unknown> | undefined)?.token).toBeUndefined();
    expect(b.config.defaultModel).toBe('zai/glm-5');
    expect(b.config.defaultDevice).toBe('arch-desktop');
    expect(b.config.search).toEqual({ provider: 'brave' });
    expect(b.redacted).toContain('search.apiKey');
    expect(b.redacted).toContain('mcpServers.github.headers.Authorization');
    expect(JSON.stringify(b)).not.toContain('brv-secret');
    expect(JSON.stringify(b)).not.toContain('ghp_secret');
    expect(JSON.stringify(b)).not.toContain('sk-ant-api03-secret');
    expect(b.agents.map((x) => x.file)).toEqual(['homelab-helper.md']);
    expect(b.routines[0].webhookSecret).toBeUndefined();
    expect(b.counts).toEqual({ agents: 1, routines: 1, tasks: 1, memories: 1, sessions: 1, messages: 2 });
    expect(a.backup({ sessions: false }).counts.sessions).toBe(0);
  });

  test('a memory keeps its meta through backup and restore, so a pending or replaced note stays out of recall', async () => {
    const a = await hub();
    const m = await a.memory.save({ content: 'The NAS is at 10.0.0.9.', kind: 'fact' });
    a.repos.db.query('UPDATE memories SET meta = ? WHERE id = ?').run(JSON.stringify({ review: 'pending', source: 'codex' }), m.id);
    const fresh = await hub();
    await fresh.restore(JSON.parse(JSON.stringify(a.backup())));
    const row = fresh.repos.db.query('SELECT meta FROM memories WHERE id = ?').get(m.id) as { meta: string | null };
    expect(JSON.parse(row.meta ?? '{}')).toEqual({ review: 'pending', source: 'codex' });
  });

  test('restore fills a fresh hub and a second restore adds nothing new', async () => {
    const a = await busyHub();
    const file = JSON.parse(JSON.stringify(a.backup())) as HubBackup;
    const fresh = await hub();
    const token = fresh.config.get().server.token;

    const r = await fresh.restore(file);
    expect(r.config).toBe(true);
    expect(r.secrets).toBe(0);
    expect(r.restored).toEqual({ agents: 1, routines: 1, tasks: 1, memories: 1, sessions: 1, messages: 2 });
    expect(r.missingKeys).toEqual(['anthropic']);
    expect(r.redacted).toContain('search.apiKey');

    const cfg = fresh.config.get();
    expect(cfg.server.token).toBe(token);
    expect(cfg.defaultModel).toBe('zai/glm-5');
    expect(cfg.gateway?.routes?.gemini).toBe(false);
    expect(cfg.ui.onboarded).toBe(true);
    expect(cfg.search.provider).toBe('brave');
    expect(cfg.search.apiKey).toBeUndefined();

    expect(readFileSync(join(fresh.config.paths.agents, 'homelab-helper.md'), 'utf8')).toContain('You look after the homelab.');
    expect(fresh.extensions.agent('homelab-helper')?.description).toBe('Proxmox and LXC chores on pve.');

    const routine = fresh.routines.list()[0];
    expect(routine.name).toBe('Server watchdog');
    expect(routine.webhookSecret?.length).toBeGreaterThan(10);
    expect(routine.nextRunAt).toBeGreaterThan(Date.now());

    const [s] = fresh.listSessions({});
    expect(s.title).toBe('Reverse proxy for the Proxmox homelab');
    expect(s.status).toBe('idle');
    expect(fresh.getMessages(s.id).map((m) => m.seq)).toEqual([1, 2]);
    expect(fresh.search('Caddy').length).toBeGreaterThan(0);
    expect(fresh.listTasks()[0].title).toBe('Patch OpenSSH on all boxes');
    expect((await fresh.memory.search('Proxmox LXC')).map((m) => m.content)).toContain('The hub madx runs in Proxmox LXC 104 on pve.');

    const again = await fresh.restore(file, { config: false });
    expect(again.config).toBe(false);
    expect(again.restored.sessions + again.restored.messages + again.restored.memories + again.restored.tasks).toBe(0);
    expect(again.skipped).toMatchObject({ sessions: 1, messages: 2, memories: 1, tasks: 1 });
    expect(fresh.listSessions({}).length).toBe(1);

    // the hub the file came from still has its search key, so restoring there names nothing to enter again
    const home = await a.restore(file);
    expect(home.redacted).toEqual([]);
    expect(a.config.get().search.apiKey).toBe('brv-secret');
  });

  test('keys travel only when asked for', async () => {
    const a = await busyHub();
    const file = a.backup({ secrets: true });
    expect(file.includesSecrets).toBe(true);
    expect(file.redacted).toEqual([]);
    expect(file.secrets?.providers.anthropic).toBe('sk-ant-api03-secret');
    expect((file.config.search as any).apiKey).toBe('brv-secret');
    expect(file.routines[0].webhookSecret?.length).toBeGreaterThan(10);

    const fresh = await hub();
    const r = await fresh.restore(JSON.parse(JSON.stringify(file)));
    expect(r.secrets).toBe(2);
    expect(r.missingKeys).toEqual([]);
    expect(fresh.config.apiKey('anthropic')).toBe('sk-ant-api03-secret');
    expect(fresh.config.get().search.apiKey).toBe('brv-secret');
    expect(fresh.routines.list()[0].webhookSecret).toBe(file.routines[0].webhookSecret);
    expect(existsSync(fresh.config.paths.secrets)).toBe(true);
  });

  test('saved browser logins stay out of a backup, keys or not', async () => {
    const a = await busyHub();
    const { LoginVault } = await import('../../src/browser/logins');
    const l = new LoginVault(a.config).add({ profile: 'marketplace', site: 'facebook.com', username: 'kai@example.com', password: 'fb-backup-pw-1' });
    const file = a.backup({ secrets: true });
    const text = JSON.stringify(file);
    expect(text).not.toContain(`browser.login.${l.id}`);
    expect(text).not.toContain('fb-backup-pw-1');
    expect(text).not.toContain('kai@example.com');
    expect(file.secrets?.values.CF_API_TOKEN).toBe('cf-secret');
  });

  test('a backup from before notifications moved into the app restores without its ntfy and Telegram settings', async () => {
    const a = await busyHub();
    const file = JSON.parse(JSON.stringify(a.backup())) as HubBackup;
    file.config.notifications = {
      on: { sessionDone: false },
      ntfy: { url: 'https://ntfy.sh', topic: 'conclave-kai-91' },
      telegram: { chatId: '42' },
    };
    file.redacted.push('notifications.telegram.botToken', 'notifications.ntfy.token');
    const fresh = await hub();
    const r = await fresh.restore(file);
    expect(r.config).toBe(true);
    expect(r.redacted).not.toContain('notifications.telegram.botToken');
    expect(r.redacted).not.toContain('notifications.ntfy.token');
    const n = fresh.config.getUser().notifications as Record<string, unknown>;
    expect(n).toEqual({ on: { sessionDone: false } });
    expect(fresh.config.get().notifications.on.sessionDone).toBe(false);

    // with keys: the bot token secret only Telegram used stays behind
    const keyed = JSON.parse(JSON.stringify(a.backup({ secrets: true }))) as HubBackup;
    keyed.config.notifications = { telegram: { botToken: '${secret:TELEGRAM_BOT_TOKEN}', chatId: '42' } };
    keyed.secrets!.values.TELEGRAM_BOT_TOKEN = '123:tg-secret';
    const other = await hub();
    const k = await other.restore(keyed);
    expect(k.secrets).toBe(2);
    expect(other.config.secretNames().values).toEqual(['CF_API_TOKEN']);
  });

  test('a file that is not a backup is refused with a reason', async () => {
    expect(() => parseBackup({})).toThrow('This is not a Conclave backup');
    expect(() => parseBackup({ format: 'conclave-backup', version: 9 })).toThrow('Update the hub');
    expect(() => parseBackup({ format: 'conclave-backup', version: 1, sessions: 'x' })).toThrow("sessions is not a list");
    const fresh = await hub();
    await expect(fresh.restore({ hello: 1 })).rejects.toMatchObject({ status: 400 });
  });
});

describe('default device', () => {
  test('new sessions use config.defaultDevice while it is connected, the hub otherwise', async () => {
    const e = await hub();
    e.config.update({ defaultDevice: 'arch' });
    expect((await e.createSession({ title: 'a' })).device).toBe('local');

    e.repos.devices.insert({ id: 'arch', name: 'arch-desktop', tokenHash: 'x' });
    e.devices.attach({ ...e.repos.devices.get('arch')!, online: true }, new FakeMachine('arch', 'arch-desktop'));
    expect((await e.createSession({ title: 'b' })).device).toBe('arch');
    // a device named by the request still wins
    expect((await e.createSession({ title: 'c', device: 'local' })).device).toBe('local');
  });
});
