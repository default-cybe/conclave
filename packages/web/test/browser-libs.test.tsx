/**
 * Settings > Browser when the browsers miss system libraries
 * (features/settings/browserParts.tsx LibsNote, browserWords.ts): with the
 * root helper, one Install system libraries button; without it, two short
 * choices (install the helper once, or run the apt-get line) and where to
 * run them, worded for the place the hub runs: inside the Proxmox container
 * with pct exec and its CT id, a VM, a machine of its own. Docker gets the
 * rebuild. The mock (src/mock/browser.ts) runs the button to Ready.
 *
 *   cd packages/web && bun test test/browser-libs.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrowserLibsDto, BrowserLibsResult, BrowserStatusDto } from '@conclave/core/client';
import { LibsNote } from '../src/features/settings/browserParts';
import { libsChoices, libsConfirmWords, libsResultWords, libsWords, placeWords, whereWords } from '../src/features/settings/browserWords';
import { registerBrowser, type MockBrowserOptions } from '../src/mock/browser';

const LINE = 'sudo /usr/local/libexec/conclave-root-helper browser-deps';
const APT = 'apt-get install -y --no-install-recommends fonts-liberation fonts-noto-color-emoji libgbm1 libnss3 libx11-6';
const INSTALL = 'conclave system-helper install';

const base: BrowserLibsDto = { missing: ['libX11.so.6', 'libgbm.so.1', 'libnss3.so'], noFonts: true, packages: [], command: APT, place: { kind: 'lxc', ctid: '135' } };
const without: BrowserLibsDto = { ...base, helper: { installed: false, ready: false, install: INSTALL } };
const withHelper: BrowserLibsDto = { ...base, helper: { installed: true, ready: true, install: INSTALL }, setup: { say: 'Runs the root helper.', lines: [LINE] } };

/** Visible text of the markup, tags out. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');

describe('the words', () => {
  test('with the helper: the hub does it; without: pick one of two', () => {
    expect(libsWords(withHelper)).toBe('The browser needs system libraries it cannot find (libX11.so.6, libgbm.so.1, libnss3.so) and fonts. The hub can install them itself with its root helper.');
    expect(libsChoices(withHelper)).toEqual([]);
    expect(libsWords(without)).toBe('The browser needs system libraries it cannot find (libX11.so.6, libgbm.so.1, libnss3.so) and fonts. Adding them takes root, once. Pick one:');
    expect(libsChoices(without)).toEqual([
      { title: 'Let the hub do it', text: "Once, as root in the hub's container. The hub then installs these, and other system packages it needs later, by itself.", command: INSTALL },
      { title: 'Or install them yourself', text: "As root in the hub's container:", command: APT },
    ]);
  });

  test('a helper that cannot run says why, and offers to install it again', () => {
    const broken: BrowserLibsDto = { ...base, helper: { installed: true, ready: false, install: INSTALL, problem: 'sudo is not installed. Installing the helper again adds it.' } };
    expect(libsWords(broken)).toContain('The root helper cannot do it now: sudo is not installed.');
    expect(libsChoices(broken)[0].title).toBe('Install the root helper again');
  });

  test('where: inside the Proxmox container with pct exec, the CT id or a placeholder; a VM; a machine', () => {
    expect(whereWords({ kind: 'lxc', ctid: '135' }, INSTALL)).toEqual({
      text: "Run these as root inside the hub's container (CT 135), not on the Proxmox host. From the Proxmox host shell, put pct exec 135 -- in front:",
      example: 'pct exec 135 -- conclave system-helper install',
      hint: 'Or open the Console of CT 135 in the Proxmox web UI and run them there.',
    });
    const anyCt = whereWords({ kind: 'lxc' }, INSTALL);
    expect(anyCt.example).toBe('pct exec <CTID> -- conclave system-helper install');
    expect(anyCt.hint).toContain("<CTID> is the container's number in Proxmox, for example 135.");
    expect(whereWords({ kind: 'vm', virt: 'kvm' }, INSTALL).text).toContain("on the hub's VM, not on the machine that hosts it");
    expect(whereWords({ kind: 'bare' }, INSTALL).text).toBe('Run these as root on the machine the hub runs on. With sudo, put sudo in front.');
    expect(placeWords({ kind: 'vm' })).toBe("on the hub's VM");
    expect(placeWords(undefined)).toBe("on the hub's machine");
  });

  test('Docker: the rebuild, no choices', () => {
    const d: BrowserLibsDto = { ...base, place: { kind: 'docker' }, docker: true };
    expect(libsWords(d)).toContain('--build-arg BROWSER=1');
    expect(libsChoices(d)).toEqual([]);
  });

  test('the confirm and the answer', () => {
    expect(libsConfirmWords(withHelper)).toContain('Only the root helper runs as root');
    const ok: BrowserLibsResult = { ok: true, ready: true, ran: [LINE], tail: '', durationMs: 1 };
    expect(libsResultWords(ok)).toEqual({ tone: 'ok', text: 'Ready. The browser has every library it needs.' });
    expect(libsResultWords({ ...ok, ready: false, libs: { ...base, missing: ['libweird.so.1'], noFonts: false } }).text).toBe('The helper finished, but the browser still misses libweird.so.1. The output is below.');
    expect(libsResultWords({ ...ok, ok: false, ready: false, failed: LINE }).tone).toBe('fault');
  });

  test('no em dashes in anything the page says', () => {
    const all = [libsWords(withHelper), libsWords(without), ...libsChoices(without).map((c) => `${c.title} ${c.text}`), JSON.stringify(whereWords({ kind: 'lxc' }, INSTALL)), libsConfirmWords(without)].join(' ');
    expect(all).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('the page', () => {
  test('with the helper: the Install system libraries button, no commands to copy', () => {
    const html = text(renderToStaticMarkup(<LibsNote libs={withHelper} onInstall={() => undefined} />));
    expect(html).toContain('Install system libraries');
    expect(html).not.toContain('apt-get');
    expect(html).not.toContain('pct exec');
  });

  test('without it: a. the helper once, b. the apt-get line, and where, with pct exec 135', () => {
    const html = text(renderToStaticMarkup(<LibsNote libs={without} onInstall={() => undefined} />));
    expect(html).not.toContain('Install system libraries');
    expect(html).toContain('a. Let the hub do it.');
    expect(html).toContain('b. Or install them yourself.');
    expect(html).toContain(INSTALL);
    expect(html).toContain(APT);
    expect(html).toContain("not on the Proxmox host");
    expect(html).toContain('pct exec 135 -- conclave system-helper install');
    expect(html.indexOf('a. Let the hub do it')).toBeLessThan(html.indexOf('b. Or install them yourself'));
  });

  test('inside another dialog the button is a pointer to it', () => {
    const html = text(renderToStaticMarkup(<LibsNote libs={withHelper} />));
    expect(html).toContain('Close this, then press Install system libraries under Engines.');
  });
});

type Handler = (p: { params: string[]; query: URLSearchParams; body: any }) => unknown;

function mock(opts: MockBrowserOptions) {
  const routes: Array<[string, RegExp, Handler]> = [];
  const ctx = {
    on: (m: string, path: string, h: Handler) => routes.push([m, new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)') + '$'), h]),
    fail: (status: number, msg: string): never => {
      throw Object.assign(new Error(msg), { status });
    },
    sleep: async () => undefined,
    FRESH: true,
  };
  registerBrowser(ctx as never, opts);
  return async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    for (const [m, re, h] of routes) {
      const hit = m === method && re.exec(path);
      if (hit) return (await h({ params: hit.slice(1), query: new URLSearchParams(), body })) as T;
    }
    throw new Error(`no route ${method} ${path}`);
  };
}

describe('the mock', () => {
  test('with the helper, the button runs the one line and ends Ready', async () => {
    const api = mock({ helper: true, installed: true });
    const s = await api<BrowserStatusDto>('GET', '/api/browser');
    expect(s.libs?.setup?.lines).toEqual([LINE]);
    await expect(api('POST', '/api/browser/libs', { steps: ['sudo id'] })).rejects.toThrow('changed since you looked');
    const r = await api<BrowserLibsResult>('POST', '/api/browser/libs', { steps: [LINE] });
    expect(libsResultWords(r).text).toBe('Ready. The browser has every library it needs.');
    expect(libsWords((await api<BrowserStatusDto>('GET', '/api/browser')).libs)).toBeUndefined();
  });

  test('without it, the button is refused and the page has the two choices', async () => {
    const api = mock({ helper: false, installed: true, ctid: null });
    const s = await api<BrowserStatusDto>('GET', '/api/browser');
    expect(s.libs?.setup).toBeUndefined();
    expect(libsChoices(s.libs).map((c) => c.command)).toEqual([INSTALL, s.libs!.command!]);
    expect(whereWords(s.libs!.place, INSTALL).example).toBe('pct exec <CTID> -- conclave system-helper install');
    await expect(api('POST', '/api/browser/libs', { steps: [LINE] })).rejects.toThrow('The root helper is not installed');
  });
});
