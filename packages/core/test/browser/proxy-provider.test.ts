/**
 * The hub's proxy settings (browser/proxy-provider.ts, proxy-list.ts):
 * countries by name or code, DataImpulse user names with a country, the
 * proxy for a request, one custom proxy's URL, and the config checks that
 * keep the login and password out of plain config.
 */
import { describe, expect, test } from 'bun:test';
import { browserConfigProblems } from '../../src/browser/engine';
import { parseProxyUrl, proxyLabel } from '../../src/browser/proxy-list';
import { browserProxyProblems, countryCode, countryLabel, dataimpulseUser, resolveProxy, type BrowserProxyConfig } from '../../src/browser/proxy-provider';

const secrets: Record<string, string> = { 'browser.dataimpulse.login': 'kai8f2', 'browser.dataimpulse.password': 'Pw-di-0042', 'browser.proxy.password': 'custom-pw' };
const read = (n: string) => secrets[n];
const di: BrowserProxyConfig = { provider: 'dataimpulse', dataimpulse: { login: '${secret:browser.dataimpulse.login}', password: '${secret:browser.dataimpulse.password}' } };

describe('countries', () => {
  test('names and codes the owner says', () => {
    expect(countryCode('Japan')).toBe('JP');
    expect(countryCode('jp')).toBe('JP');
    expect(countryCode('Vietnam')).toBe('VN');
    expect(countryCode('the UK')).toBe('GB');
    expect(countryCode('USA')).toBe('US');
    expect(countryCode('United States')).toBe('US');
    expect(countryCode('South Korea')).toBe('KR');
    expect(countryCode('Germany.')).toBe('DE');
    expect(countryCode('Atlantis')).toBeUndefined();
    expect(countryCode('XQ')).toBeUndefined();
    expect(countryCode('')).toBeUndefined();
    expect(countryLabel('JP')).toBe('Japan');
  });
});

describe('DataImpulse', () => {
  test('the country goes after two underscores, or after a semicolon when there are parameters already', () => {
    expect(dataimpulseUser('kai8f2')).toBe('kai8f2');
    expect(dataimpulseUser('kai8f2', 'JP')).toBe('kai8f2__cr.jp');
    expect(dataimpulseUser('kai8f2__sessid.abc', 'DE')).toBe('kai8f2__sessid.abc;cr.de');
  });

  test('HTTP at gw.dataimpulse.com:823 by default; the label has no login or password', () => {
    const r = resolveProxy(di, read, 'JP');
    expect(r.entry).toEqual({ scheme: 'http', host: 'gw.dataimpulse.com', port: 823, username: 'kai8f2__cr.jp', password: 'Pw-di-0042' });
    expect(r.label).toBe('DataImpulse, Japan');
    expect(r.country).toBe('JP');
    expect(JSON.stringify([r.label, r.country])).not.toMatch(/kai8f2|Pw-di/);
  });

  test('no country: the default one, else none; host and port can change', () => {
    expect(resolveProxy(di, read).entry.username).toBe('kai8f2');
    const withDefault = resolveProxy({ ...di, dataimpulse: { ...di.dataimpulse, country: 'de', host: 'gw2.example.net', port: 10000 } }, read);
    expect(withDefault.entry).toMatchObject({ host: 'gw2.example.net', port: 10000, username: 'kai8f2__cr.de' });
    expect(withDefault.label).toBe('DataImpulse, Germany');
  });

  test('nothing set up, or a secret missing, is a sentence to pass on', () => {
    expect(() => resolveProxy(undefined, read)).toThrow('No proxy is set up on this hub');
    expect(() => resolveProxy({}, read)).toThrow('No proxy is set up');
    expect(() => resolveProxy(di, () => undefined)).toThrow('DataImpulse login or password is not saved');
  });
});

describe('custom', () => {
  test('one proxy, its password from a secret; it has no country choice', () => {
    const cfg: BrowserProxyConfig = { provider: 'custom', custom: { url: 'socks5://alice@203.0.113.5:1080', password: '${secret:browser.proxy.password}' } };
    const r = resolveProxy(cfg, read);
    expect(r.entry).toEqual({ scheme: 'socks5', host: '203.0.113.5', port: 1080, username: 'alice', password: 'custom-pw' });
    expect(r.label).toBe('socks5://alice@203.0.113.5:1080');
    expect(() => resolveProxy(cfg, read, 'JP')).toThrow('no country choice');
  });

  test('parseProxyUrl takes socks5 and http with a user name, and refuses a password', () => {
    expect(parseProxyUrl('http://proxy.lan:3128/')).toEqual({ ok: true, proxy: { scheme: 'http', host: 'proxy.lan', port: 3128 } });
    const withPassword = parseProxyUrl('socks5://alice:hunter2@1.2.3.4:1080');
    expect(withPassword.ok).toBe(false);
    expect(JSON.stringify(withPassword)).not.toContain('hunter2');
    expect(parseProxyUrl('socks4://1.2.3.4:1080').ok).toBe(false);
    expect(parseProxyUrl('socks5://1.2.3.4').ok).toBe(false);
    expect(proxyLabel({ scheme: 'socks5', host: '::1', port: 1, username: 'a b' })).toBe('socks5://a%20b@[::1]:1');
  });
});

describe('config checks', () => {
  test('the login and password must be secret placeholders', () => {
    expect(browserProxyProblems(di)).toEqual([]);
    const plain = browserProxyProblems({ provider: 'dataimpulse', dataimpulse: { login: 'kai8f2', password: 'Pw-di-0042' } });
    expect(plain).toHaveLength(2);
    expect(plain.join(' ')).not.toMatch(/kai8f2|Pw-di/);
    expect(browserProxyProblems({ provider: 'custom', custom: { url: 'socks5://a@h.example:1', password: 'plain' } }).join(' ')).toContain('${secret:name}');
  });

  test('provider, host, port, country and address are checked', () => {
    expect(browserProxyProblems({ provider: 'tor' })).toHaveLength(1);
    expect(browserProxyProblems({ provider: 'dataimpulse', dataimpulse: { port: 0, host: 'bad host', country: 'Japan' } })).toHaveLength(3);
    expect(browserProxyProblems({ provider: 'custom' })).toEqual(['browser.proxy.custom.url is missing.']);
    expect(browserProxyProblems({ provider: 'custom', custom: { url: 'ftp://x:1' } })).toHaveLength(1);
    expect(browserProxyProblems({ pool: {} })).toHaveLength(1);
  });

  test('PATCH /api/config runs them through browserConfigProblems', () => {
    expect(browserConfigProblems({ proxy: { provider: 'dataimpulse', dataimpulse: { password: 'x' } } })).toHaveLength(1);
    expect(browserConfigProblems({ proxy: di })).toEqual([]);
  });
});
