/**
 * Saved logins (browser/logins.ts, autofill.ts, the browser_login tool),
 * Forget a site and Delete profile.
 *
 * - The vault keeps the password and 2FA key only as hub secrets, encrypted;
 *   the list file and the config never hold them.
 * - browser_login fills only on the saved site's origin, never into a frame
 *   from another site, never into a form that sends elsewhere or a form with
 *   two password fields, and the password never shows in a tool result, a
 *   log line or an audit detail, even when the page itself shows it.
 * - Members' and untrusted sessions cannot use saved logins.
 *
 * The live part runs a local site on two ports (two origins) in Chromium,
 * and is skipped when there is no Chromium, as the other browser tests are.
 *
 *   bun test packages/core/test/browser/logins.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { BrowserManager, browserTools, findBrowserExecutable, LoginVault, originMatches, parseTotp, ProfileInUse, siteOrigin, totpCode } from '../../src/browser';
import { loginRefusal } from '../../src/browser/tools';
import { setLogTap } from '../../src/util/log';
import { commandTouchesHubPrivate, isHubPrivatePath } from '../../src/machine/private';
import type { Tool, ToolContext, ToolOutput } from '../../src/tools/types';

const PASSWORD = 'Zq7-hunter2-"quoted" pw';
const TOTP_KEY = 'JBSWY3DPEHPK3PXP';

const exe = findBrowserExecutable({ headless: true });
let hasPlaywright = true;
try {
  await import('playwright-core');
} catch {
  hasPlaywright = false;
}
const live = exe && hasPlaywright ? describe : describe.skip;

function textOf(out: ToolOutput): string {
  if (typeof out.content === 'string') return out.content;
  return out.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
}

const homes: string[] = [];
function freshConfig(extra: Record<string, unknown> = {}): ConfigStore {
  const home = mkdtempSync(join(tmpdir(), 'conclave-logins-'));
  homes.push(home);
  return new ConfigStore(home, { browser: { headless: true, ...(exe ? { executablePath: exe } : {}) }, ...extra } as never);
}
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe('the vault', () => {
  test('keeps the password and 2FA key only as encrypted hub secrets', () => {
    const config = freshConfig();
    const vault = new LoginVault(config);
    const l = vault.add({ profile: 'marketplace', site: 'https://www.facebook.com/login', username: 'kai@example.com', password: PASSWORD, totp: TOTP_KEY });
    expect(l.origin).toBe('https://www.facebook.com');
    expect(l.totp).toBe(true);
    const secrets = readFileSync(config.paths.secrets, 'utf8');
    expect(secrets).toContain(`browser.login.${l.id}.password`);
    expect(secrets).toContain('enc:v1:');
    expect(secrets).not.toContain(PASSWORD);
    expect(secrets).not.toContain(TOTP_KEY);
    expect(readFileSync(vault.file, 'utf8')).not.toContain(PASSWORD);
    expect(JSON.stringify(config.getUser())).not.toContain(PASSWORD);
    expect(vault.secret(l.id, 'password')).toBe(PASSWORD);
    expect(vault.secret(l.id, 'totp')).toBe(TOTP_KEY);
    // the list and the key are mode 0600
    if (process.platform !== 'win32') {
      const { statSync } = require('node:fs') as typeof import('node:fs');
      expect(statSync(vault.file).mode & 0o777).toBe(0o600);
      expect(statSync(vault.keyFile).mode & 0o777).toBe(0o600);
    }
  });

  test('tools cannot read the list or the key', () => {
    const vault = new LoginVault(freshConfig());
    vault.add({ site: 'x.example', username: 'x', password: 'pw-x-1' });
    expect(isHubPrivatePath(vault.keyFile)).toBe(true);
    expect(isHubPrivatePath(vault.file)).toBe(true);
    expect(commandTouchesHubPrivate('cat ~/.conclave/browser-logins.key')).toBe(true);
    expect(commandTouchesHubPrivate(`base64 ${vault.keyFile}`)).toBe(true);
  });

  test('a value moved to another login, or another key, does not open', () => {
    const config = freshConfig();
    const vault = new LoginVault(config);
    const a = vault.add({ site: 'a.example', username: 'a', password: 'pw-for-a' });
    const b = vault.add({ site: 'b.example', username: 'b', password: 'pw-for-b' });
    // the secret's name is the associated data: a's value under b's name fails
    config.setSecret('values', `browser.login.${b.id}.password`, config.secretValue(`browser.login.${a.id}.password`));
    expect(() => vault.secret(b.id, 'password')).toThrow('another key');
    expect(vault.readable(a.id)).toBe(true);
    // a restored backup on a new hub: same secrets, no key
    writeFileSync(vault.keyFile, Buffer.alloc(32, 7).toString('base64'));
    expect(vault.readable(a.id)).toBe(false);
    expect(() => vault.secret(a.id, 'password')).toThrow('Save the password again');
  });

  test('update replaces or keeps the password, removes the 2FA key, refuses a duplicate', () => {
    const vault = new LoginVault(freshConfig());
    const l = vault.add({ site: 'github.com', username: 'kai', password: 'one-pw-1', totp: TOTP_KEY });
    vault.update(l.id, { username: 'kai2' });
    expect(vault.secret(l.id, 'password')).toBe('one-pw-1');
    vault.update(l.id, { password: 'two-pw-2', totp: null, subdomains: true });
    expect(vault.secret(l.id, 'password')).toBe('two-pw-2');
    expect(vault.get(l.id)?.totp).toBe(false);
    expect(vault.get(l.id)?.subdomains).toBe(true);
    expect(() => vault.secret(l.id, 'totp')).toThrow();
    expect(() => vault.add({ site: 'https://github.com', username: 'KAI2', password: 'x-pw-3' })).toThrow('already has a login');
    expect(() => vault.add({ site: 'javascript:alert(1)', username: 'x', password: 'y' })).toThrow();
    expect(() => vault.add({ site: 'github.com', username: 'y', password: '' })).toThrow('Password is empty');
    expect(() => vault.add({ site: 'github.com', username: 'y', password: 'p', totp: 'not a key!' })).toThrow('2FA key');
  });

  test('delete login and delete profile take the secrets with them', () => {
    const config = freshConfig();
    const vault = new LoginVault(config);
    const a = vault.add({ profile: 'marketplace', site: 'facebook.com', username: 'a', password: 'pw-aaaa' });
    const b = vault.add({ profile: 'marketplace', site: 'gumtree.com', username: 'b', password: 'pw-bbbb', totp: TOTP_KEY });
    const c = vault.add({ profile: 'default', site: 'github.com', username: 'c', password: 'pw-cccc' });
    expect(vault.remove(a.id)).toBe(true);
    expect(config.secretValue(`browser.login.${a.id}.password`)).toBeUndefined();
    expect(vault.removeProfile('marketplace')).toBe(1);
    expect(config.secretValue(`browser.login.${b.id}.password`)).toBeUndefined();
    expect(config.secretValue(`browser.login.${b.id}.totp`)).toBeUndefined();
    expect(vault.list().map((l) => l.id)).toEqual([c.id]);
  });
});

describe('the origin rule', () => {
  const fb = { origin: 'https://www.facebook.com', subdomains: false };
  const fbSub = { ...fb, subdomains: true };
  test('exact origin only, unless subdomains are on', () => {
    expect(originMatches(fb, 'https://www.facebook.com/login/?next=1')).toBe(true);
    expect(originMatches(fb, 'https://m.facebook.com/login')).toBe(false);
    expect(originMatches(fb, 'http://www.facebook.com/')).toBe(false);
    expect(originMatches(fb, 'https://www.facebook.com:8443/')).toBe(false);
    expect(originMatches(fbSub, 'https://m.facebook.com/login')).toBe(true);
    expect(originMatches(fbSub, 'https://facebook.com/')).toBe(true);
    expect(originMatches(fbSub, 'https://evil-facebook.com/')).toBe(false);
    expect(originMatches(fbSub, 'https://facebook.com.evil.test/')).toBe(false);
    expect(originMatches(fbSub, 'http://m.facebook.com/')).toBe(false);
    expect(originMatches(fbSub, 'about:blank')).toBe(false);
    expect(originMatches(fbSub, 'data:text/html,hi')).toBe(false);
    // an address by IP never counts for subdomains
    expect(originMatches({ origin: 'http://127.0.0.1:8080', subdomains: true }, 'http://1.127.0.0.1:8080/')).toBe(false);
  });

  test('siteOrigin takes a host or an address', () => {
    expect(siteOrigin('facebook.com')).toBe('https://facebook.com');
    expect(siteOrigin('https://www.facebook.com/login?x=1')).toBe('https://www.facebook.com');
    expect(siteOrigin('localhost:3000')).toBe('http://localhost:3000');
    expect(() => siteOrigin('ftp://x.test')).toThrow();
  });
});

describe('TOTP', () => {
  test('RFC 6238 test values (SHA1)', () => {
    // the RFC's key "12345678901234567890" in base32
    const spec = parseTotp('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8');
    expect(totpCode(spec, 59_000)).toBe('94287082');
    expect(totpCode(spec, 1_111_111_109_000)).toBe('07081804');
    expect(totpCode(spec, 2_000_000_000_000)).toBe('69279037');
    expect(totpCode(parseTotp('jbsw y3dp ehpk 3pxp'), 0)).toMatch(/^\d{6}$/);
  });
});

describe('who may use saved logins', () => {
  test('members and untrusted sessions are refused', () => {
    expect(loginRefusal({ session: { accountId: 'acc_alice' } as never, host: {} as never })).toContain("hub owner's");
    expect(loginRefusal({ session: { meta: { untrusted: true } } as never, host: {} as never })).toContain('untrusted');
    expect(loginRefusal({ session: {} as never, host: { untrusted: () => true } as never })).toContain('untrusted');
    expect(loginRefusal({ session: { accountId: 'owner' } as never, host: { untrusted: () => false } as never })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Live: a local site on two origins
// ---------------------------------------------------------------------------

interface Hit {
  path: string;
  body: string;
}

function site(posts: Hit[]) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const html = (body: string, headers: Record<string, string> = {}) => new Response(`<!doctype html><html><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
      if (req.method === 'POST') posts.push({ path: url.pathname, body: await req.text() });
      const loginForm = (action: string) =>
        `<h1>Log in</h1><form method="post" action="${action}"><label>Email <input name="email" autocomplete="username"></label><label>Password <input name="pass" type="password"></label><button type="submit">Log in</button></form>`;
      switch (url.pathname) {
        case '/login':
          return html(loginForm('/session'));
        case '/session':
          return html('<h1>Welcome back</h1><p>Your feed</p>', { 'set-cookie': 'sid=abc; Path=/; HttpOnly' });
        case '/login-2fa':
          return html(loginForm('/session-2fa'));
        case '/session-2fa':
          return html('<h1>Check your phone</h1><form method="post" action="/code"><label>Code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button type="submit">Continue</button></form>');
        case '/code':
          return html('<h1>Welcome back</h1>', { 'set-cookie': 'sid=2fa; Path=/; HttpOnly' });
        case '/login-boxes':
          return html(loginForm('/session-boxes'));
        case '/session-boxes':
          return html(`<h1>Enter the code</h1><form method="post" action="/code"><div>${[0, 1, 2, 3, 4, 5].map((i) => `<input name="d${i}" maxlength="1" inputmode="numeric" ${i === 0 ? 'autocomplete="one-time-code"' : ''} aria-label="Digit ${i + 1}">`).join('')}</div><button type="submit">Verify</button></form>`);
        case '/login-first':
          return html('<h1>Sign in</h1><form method="post" action="/next"><label>Email or phone <input type="email" name="identifier"></label><button type="submit">Next</button></form>');
        case '/next':
          return html('<h1>Welcome</h1><form method="post" action="/session"><label>Password <input name="pass" type="password"></label><button type="submit">Next</button></form>');
        case '/login-stuck':
          // the page refuses on its own and keeps what was typed
          return html(`${loginForm('/session')}<p id="msg"></p><script>document.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); document.getElementById('msg').textContent = 'Wrong password'; });</script>`);
        case '/login-echo':
          // a page that puts the password into its own text: no result may show it
          return html(`${loginForm('/session')}<p id="msg"></p><script>document.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); document.getElementById('msg').textContent = 'You typed ' + document.querySelector('[type=password]').value; });</script>`);
        case '/login-elsewhere':
          return html(loginForm(`${url.searchParams.get('to')}/steal`));
        case '/signup':
          return html('<form method="post" action="/session"><input name="email" autocomplete="username"><input type="password" name="p1" autocomplete="new-password"><input type="password" name="p2" autocomplete="new-password"><button>Sign up</button></form>');
        case '/framed':
          return html(`<h1>Shop</h1><iframe src="${url.searchParams.get('src')}" width="600" height="300"></iframe>`);
        case '/store':
          return html('<p>stored</p><script>localStorage.setItem("k", "v1")</script>', { 'set-cookie': 'pref=1; Path=/; Max-Age=86400' });
        case '/read':
          return html(`<p id="c">cookie: ${req.headers.get('cookie') ?? 'none'}</p>`);
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });
}

live('browser_login in Chromium', () => {
  let config: ConfigStore;
  let manager: BrowserManager;
  let tools: Map<string, Tool>;
  const posts: Hit[] = [];
  let a: ReturnType<typeof site>;
  let b: ReturnType<typeof site>;
  let A: string;
  let B: string;
  const audits: string[] = [];
  const logs: string[] = [];
  let prevTap: ReturnType<typeof setLogTap>;
  let answer = '';
  const outputs: string[] = [];

  beforeAll(() => {
    prevTap = setLogTap((level, scope, msg, extra) => logs.push(`${level} ${scope} ${msg} ${extra === undefined ? '' : JSON.stringify(extra)}`));
    config = freshConfig();
    manager = new BrowserManager({ config });
    tools = new Map(browserTools(manager).map((t) => [t.name, t]));
    a = site(posts);
    b = site(posts);
    A = `http://127.0.0.1:${a.port}`;
    B = `http://127.0.0.1:${b.port}`;
  });

  afterAll(async () => {
    setLogTap(prevTap);
    await manager?.close();
    a?.stop(true);
    b?.stop(true);
  });

  const ctx = (sessionId: string, extra: Partial<ToolContext> = {}): ToolContext =>
    ({
      sessionId,
      signal: new AbortController().signal,
      session: { id: sessionId, accountId: 'owner' },
      host: {
        audit: (_sid: string, action: string, detail: string) => audits.push(`${action} ${detail}`),
        askUser: async (_sid: string, qs: Array<{ question: string }>) => ({ [qs[0].question]: answer }),
        untrusted: () => false,
      },
      ...extra,
    }) as unknown as ToolContext;
  const run = async (name: string, input: Record<string, unknown>, sid: string, extra: Partial<ToolContext> = {}) => {
    const out = await tools.get(name)!.run(input, ctx(sid, extra));
    outputs.push(textOf(out), JSON.stringify(out.meta ?? {}));
    return out;
  };
  const value = async (sid: string, selector: string) => (await manager.page(sid)).locator(selector).first().inputValue();

  test('fills on the saved origin, submits, and the password shows nowhere', async () => {
    manager.logins.add({ profile: 'default', site: A, username: 'kai@example.com', password: PASSWORD });
    await run('browser_navigate', { url: `${A}/login` }, 's1');
    const out = await run('browser_login', { site: A }, 's1');
    const text = textOf(out);
    expect(out.isError).toBeFalsy();
    expect(text).toContain(`Filled the saved login for 127.0.0.1 (username and password) and submitted it.`);
    expect(text).toContain('Welcome back');
    const post = posts.find((p) => p.path === '/session')!;
    const form = new URLSearchParams(post.body);
    expect(form.get('email')).toBe('kai@example.com');
    expect(form.get('pass')).toBe(PASSWORD);
    expect(audits.some((x) => x.startsWith('browser.login 127.0.0.1 in profile default: filled username, password, submitted'))).toBe(true);
    // the site is now listed as signed in, and the login as used
    expect(manager.signIns('default').map((s) => s.host)).toContain('127.0.0.1');
    expect(manager.logins.list('default')[0].lastUsed).toBeGreaterThan(0);
  }, 60_000);

  test('a tab on another origin is refused and nothing is filled', async () => {
    await run('browser_navigate', { url: `${B}/login` }, 's2');
    const out = await run('browser_login', { site: A }, 's2');
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(`This tab is on 127.0.0.1, not 127.0.0.1`);
    expect(await value('s2', '[name=email]')).toBe('');
    expect(await value('s2', '[type=password]')).toBe('');
    expect(audits.some((x) => x.startsWith('browser.login.refused'))).toBe(true);
    // and without a site, the tab's own origin has no saved login
    const none = await run('browser_login', {}, 's2');
    expect(textOf(none)).toContain('No saved login for 127.0.0.1');
  }, 60_000);

  test('a login form inside a frame from another origin gets nothing', async () => {
    // the page on B frames A's login form; the login is A's, the tab is B
    await run('browser_navigate', { url: `${B}/framed?src=${encodeURIComponent(`${A}/login`)}` }, 's3');
    const out = await run('browser_login', { site: A }, 's3');
    expect(out.isError).toBe(true);
    // and a login saved for B fills nothing in A's frame either: the tab's own document has no form
    const forB = manager.logins.add({ profile: 'default', site: B, username: 'b-user', password: 'b-password-1' });
    const out2 = await run('browser_login', { site: B }, 's3');
    expect(out2.isError).toBe(true);
    expect(textOf(out2)).toContain('No login form on this page');
    const frame = (await manager.page('s3')).frames().find((f) => f.url().startsWith(A))!;
    expect(await frame.locator('[type=password]').inputValue()).toBe('');
    expect(await frame.locator('[name=email]').inputValue()).toBe('');
    manager.logins.remove(forB.id);
  }, 60_000);

  test('a form that sends to another site, and a sign-up form, are refused', async () => {
    await run('browser_navigate', { url: `${A}/login-elsewhere?to=${encodeURIComponent(B)}` }, 's4');
    const away = await run('browser_login', {}, 's4');
    expect(away.isError).toBe(true);
    expect(textOf(away)).toContain('sends to 127.0.0.1');
    expect(await value('s4', '[type=password]')).toBe('');
    expect(posts.some((p) => p.path === '/steal')).toBe(false);
    await run('browser_navigate', { url: `${A}/signup` }, 's4');
    const signup = await run('browser_login', {}, 's4');
    expect(signup.isError).toBe(true);
    expect(textOf(signup)).toContain('more than one password field');
  }, 60_000);

  test('username first, then the password on the next page', async () => {
    posts.length = 0;
    await run('browser_navigate', { url: `${A}/login-first` }, 's5');
    const out = await run('browser_login', {}, 's5');
    expect(out.isError).toBeFalsy();
    expect(new URLSearchParams(posts.find((p) => p.path === '/next')!.body).get('identifier')).toBe('kai@example.com');
    expect(new URLSearchParams(posts.find((p) => p.path === '/session')!.body).get('pass')).toBe(PASSWORD);
    expect(textOf(out)).toContain('Welcome back');
  }, 60_000);

  test('a page that keeps the form: the password field is cleared and the result says so', async () => {
    await run('browser_navigate', { url: `${A}/login-stuck` }, 's6');
    const out = await run('browser_login', {}, 's6');
    expect(textOf(out)).toContain('still shows a password field');
    expect(await value('s6', '[type=password]')).toBe('');
    const snap = await run('browser_snapshot', {}, 's6');
    expect(textOf(snap)).toContain('Wrong password');
  }, 60_000);

  test('a page that shows the password itself: every result hides it', async () => {
    await run('browser_navigate', { url: `${A}/login-echo` }, 's7');
    const out = await run('browser_login', {}, 's7');
    expect(textOf(out)).toContain('You typed [saved password]');
    const snap = await run('browser_snapshot', {}, 's7');
    expect(textOf(snap)).toContain('[saved password]');
    const ev = await run('browser_evaluate', { expression: 'document.getElementById("msg").textContent' }, 's7');
    expect(textOf(ev)).toContain('[saved password]');
  }, 60_000);

  test('a code: from the saved 2FA key, from the owner, or the owner signs in', async () => {
    const two = manager.logins.add({ profile: 'work', site: A, username: 'kai-2fa', password: 'two-fa-pass', totp: TOTP_KEY });
    manager.setProfile('s8', 'work');
    posts.length = 0;
    await run('browser_navigate', { url: `${A}/login-2fa` }, 's8');
    const out = await run('browser_login', {}, 's8');
    expect(textOf(out)).toContain('Filled the sign-in code from the saved 2FA key.');
    const sent = new URLSearchParams(posts.find((p) => p.path === '/code')!.body).get('code')!;
    const now = Date.now();
    expect([totpCode(parseTotp(TOTP_KEY), now), totpCode(parseTotp(TOTP_KEY), now - 30_000)]).toContain(sent);
    expect(textOf(out)).not.toContain(sent);

    // no key: the owner types it
    manager.logins.update(two.id, { totp: null });
    answer = '482 913';
    posts.length = 0;
    await run('browser_navigate', { url: `${A}/login-2fa` }, 's8');
    const owner = await run('browser_login', {}, 's8');
    expect(textOf(owner)).toContain('Filled the sign-in code the owner gave.');
    expect(new URLSearchParams(posts.find((p) => p.path === '/code')!.body).get('code')).toBe('482913');

    // a code in one box per digit
    answer = '135790';
    posts.length = 0;
    await run('browser_navigate', { url: `${A}/login-boxes` }, 's8');
    const boxes = await run('browser_login', {}, 's8');
    expect(textOf(boxes)).toContain('Filled the sign-in code the owner gave.');
    const digits = new URLSearchParams(posts.find((p) => p.path === '/code')!.body);
    expect([0, 1, 2, 3, 4, 5].map((i) => digits.get(`d${i}`)).join('')).toBe('135790');

    // the owner would rather sign in
    answer = 'Sign in myself';
    await run('browser_navigate', { url: `${A}/login-2fa` }, 's8');
    const declined = await run('browser_login', {}, 's8');
    expect(textOf(declined)).toContain('Sign in to a site (profile work)');
  }, 90_000);

  test('the login of another profile is not used; members, untrusted and read-only sessions are refused', async () => {
    manager.setProfile('s9', 'personal');
    await run('browser_navigate', { url: `${A}/login` }, 's9');
    const other = await run('browser_login', {}, 's9');
    expect(textOf(other)).toContain('is in profile default and work');
    manager.setProfile('s9', 'default');
    await run('browser_navigate', { url: `${A}/login` }, 's9');
    const member = await run('browser_login', {}, 's9', { session: { id: 's9', accountId: 'acc_alice' } as never });
    expect(member.isError).toBe(true);
    expect(textOf(member)).toContain("hub owner's");
    const untrusted = await run('browser_login', {}, 's9', { session: { id: 's9', meta: { untrusted: true } } as never });
    expect(textOf(untrusted)).toContain('untrusted');
    manager.setReadOnly('s9', true);
    const ro = await run('browser_login', {}, 's9');
    expect(textOf(ro)).toContain('only reads');
    manager.setReadOnly('s9', false);
    expect(await value('s9', '[type=password]')).toBe('');
  }, 60_000);

  test('the password is in no result, log line or audit detail', () => {
    const all = [...outputs, ...logs, ...audits].join('\n');
    for (const form of [PASSWORD, JSON.stringify(PASSWORD).slice(1, -1), encodeURIComponent(PASSWORD), 'two-fa-pass', TOTP_KEY]) expect(all).not.toContain(form);
  });

  test('Forget clears the site\'s cookies and storage in the profile', async () => {
    manager.setProfile('f1', 'shop');
    await manager.navigate('f1', `${A}/store`);
    manager.recordSignIn('shop', '127.0.0.1');
    const page = await manager.page('f1');
    expect(await page.evaluate(() => localStorage.getItem('k'))).toBe('v1');
    await manager.navigate('f1', `${A}/read`);
    expect(await page.locator('#c').textContent()).toContain('pref=1');
    const r = await manager.forgetSite('shop', '127.0.0.1');
    expect(r.cookies).toBeGreaterThan(0);
    await manager.navigate('f1', `${A}/read`);
    expect(await page.locator('#c').textContent()).toBe('cookie: none');
    expect(await page.evaluate(() => localStorage.getItem('k'))).toBeNull();
    expect(manager.signIns('shop')).toEqual([]);
  }, 60_000);

  test('Delete profile: never the default, not while open unless closed first', async () => {
    await expect(manager.deleteProfile('default')).rejects.toBeInstanceOf(ProfileInUse);
    // shop is open in session f1
    const busy = await manager.deleteProfile('shop').catch((e) => e);
    expect(busy).toBeInstanceOf(ProfileInUse);
    expect((busy as ProfileInUse).code).toBe('open');
    config.update({ browser: { profiles: { shop: { engine: 'chromium' } } } } as never);
    manager.logins.add({ profile: 'shop', site: 'shop.example', username: 'x', password: 'shop-pass-1' });
    const dir = join(manager.profilesDir(), 'shop');
    expect(existsSync(dir)).toBe(true);
    const r = await manager.deleteProfile('shop', { close: true });
    expect(r.logins).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(config.getUser().browser?.profiles?.shop).toBeUndefined();
    expect(manager.listProfiles()).not.toContain('shop');
    // the session goes back to the default profile
    expect(manager.profileFor('f1')).toBe('default');
    // a profile that only ever ran is deleted at once
    manager.setProfile('f2', 'scratch');
    await manager.navigate('f2', `${A}/read`);
    await manager.closeSession('f2');
    await manager.deleteProfile('scratch');
    expect(manager.listProfiles()).not.toContain('scratch');
  }, 60_000);
});
