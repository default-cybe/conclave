import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { dropRetiredKeys } from '../../src/config/retired';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'conclave-retired-'));
  homes.push(h);
  return h;
}

/** A config file from before notifications moved into the app. */
function oldHome(extraConfig: Record<string, unknown> = {}): string {
  const h = home();
  writeFileSync(
    join(h, 'config.json'),
    JSON.stringify({
      server: { token: 'tok_0123456789abcdef0123' },
      notifications: {
        on: { sessionDone: false },
        idleSeconds: 300,
        ntfy: { url: 'https://ntfy.sh', topic: 'conclave-kai-91', token: 'tk_8m2vq0c4h7rj1x9wz5ny3pkd6tb' },
        telegram: { botToken: '${secret:TELEGRAM_BOT_TOKEN}', chatId: '42' },
      },
      ...extraConfig,
    }),
  );
  writeFileSync(join(h, 'secrets.json'), JSON.stringify({ providers: { zai: 'zai-key' }, values: { TELEGRAM_BOT_TOKEN: '123:tg', CF_API_TOKEN: 'cf' } }));
  return h;
}

describe('retired notification keys', () => {
  test('an old config file loads, keeps the rules, and loses ntfy and telegram', () => {
    const h = oldHome();
    const config = new ConfigStore(h);
    const n = config.get().notifications as Record<string, unknown>;
    expect(n.ntfy).toBeUndefined();
    expect(n.telegram).toBeUndefined();
    expect(config.get().notifications.on.sessionDone).toBe(false);
    expect(config.get().notifications.on.approvalNeeded).toBe(true);
    expect(config.get().notifications.idleSeconds).toBe(300);
    expect(config.get().server.token).toBe('tok_0123456789abcdef0123');

    const file = JSON.parse(readFileSync(join(h, 'config.json'), 'utf8'));
    expect(file.notifications).toEqual({ on: { sessionDone: false }, idleSeconds: 300 });
    // the bot token secret only served Telegram; other secrets stay
    expect(config.secretNames()).toEqual({ providers: ['zai'], values: ['CF_API_TOKEN'] });
    expect(JSON.parse(readFileSync(join(h, 'secrets.json'), 'utf8')).values).toEqual({ CF_API_TOKEN: 'cf' });
  });

  test('a secret that something else still uses is kept', () => {
    const h = oldHome({ mcpServers: { tg: { command: 'tg-mcp', env: { BOT: '${secret:TELEGRAM_BOT_TOKEN}' } } } });
    const config = new ConfigStore(h);
    expect(config.secretNames().values).toContain('TELEGRAM_BOT_TOKEN');
    expect(config.expand('${secret:TELEGRAM_BOT_TOKEN}')).toBe('123:tg');
  });

  test('updates and replaces drop them too (a restored backup, an old client)', () => {
    const config = new ConfigStore(home());
    config.update({ notifications: { ...config.get().notifications, telegram: { botToken: 'x', chatId: '1' } } as never });
    expect((config.getUser().notifications as Record<string, unknown>).telegram).toBeUndefined();
    config.replace({ notifications: { ntfy: { url: 'https://ntfy.sh', topic: 't' }, idleSeconds: 0 } as never });
    expect(config.getUser().notifications).toEqual({ idleSeconds: 0 } as never);
    expect(config.get().notifications.idleSeconds).toBe(0);
  });

  test('dropRetiredKeys reports what it removed', () => {
    const cfg = { notifications: { ntfy: { token: '${secret:NTFY}' }, idleSeconds: 60 }, search: { apiKey: '${secret:BRAVE}' } };
    expect(dropRetiredKeys(cfg)).toEqual({ dropped: ['notifications.ntfy'], secrets: ['NTFY'] });
    expect(cfg).toEqual({ notifications: { idleSeconds: 60 }, search: { apiKey: '${secret:BRAVE}' } } as never);
    expect(dropRetiredKeys({ ui: { theme: 'dark' } })).toEqual({ dropped: [], secrets: [] });
  });
});
