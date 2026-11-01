/**
 * Install system libraries over HTTP (POST /api/browser/libs in
 * routes-browser.ts): Settings > Browser shows where the hub runs and the
 * root helper's state; the button runs only the line the owner confirmed,
 * only when the helper can run it, audits it, and answers Ready after
 * looking again. The machine is a description and the shell a stand-in:
 * nothing here runs sudo or apt-get.
 *
 *   bun test packages/server/test/browser-libs-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BrowserManager, type BrowserSetupOptions } from '@conclave/core/browser/index.ts';
import type { BrowserLibsResult, RootHelperDto } from '@conclave/core/client/index.ts';
import type { BrowserStatusDto } from '@conclave/core/watches/index.ts';
import { startHub, type TestHub } from './helpers';

const LINE = 'sudo /usr/local/libexec/conclave-root-helper browser-deps';

let hub: TestHub;
let browser: BrowserManager;
const ran: string[] = [];
const machine = { helper: { installed: false, ready: false, install: 'conclave system-helper install' } as RootHelperDto, fixed: false };

beforeAll(() => {
  hub = startHub();
  browser = new BrowserManager({ config: hub.engine.config, launcher: { launchPersistentContext: async () => ({}) as never } });
  const overrides: Partial<BrowserSetupOptions> = {
    host: {
      place: () => ({ kind: 'lxc', ctid: '135' }),
      helper: () => machine.helper,
      missing: () => (machine.fixed ? { missing: [], noFonts: false } : { missing: ['libX11.so.6', 'libgbm.so.1', 'libnss3.so'], noFonts: true }),
    },
    shell: {
      exec: async (command) => {
        ran.push(command);
        machine.fixed = true;
        return { exitCode: 0, stdout: 'Done.\n', stderr: '', timedOut: false, aborted: false, durationMs: 3 };
      },
    },
  };
  Object.assign(hub.engine, { browser, browserSetupOverrides: overrides });
});

afterAll(async () => {
  await browser.close();
  await hub.stop();
});

const json = async <T>(r: Response) => (await r.json()) as T;
const post = (steps: unknown, token?: string | null) => hub.api('/api/browser/libs', { method: 'POST', json: { steps }, ...(token !== undefined ? { token } : {}) });
const audits = () => hub.engine.repos.audit.list({ limit: 50 }).filter((a) => a.action.startsWith('browser.libs'));

describe('POST /api/browser/libs', () => {
  test('without the helper: the page gets the place, the install command and the apt-get line; the route runs nothing', async () => {
    const s = await json<BrowserStatusDto>(await hub.api('/api/browser'));
    expect(s.libs).toMatchObject({ missing: ['libX11.so.6', 'libgbm.so.1', 'libnss3.so'], noFonts: true, place: { kind: 'lxc', ctid: '135' }, helper: { installed: false, install: 'conclave system-helper install' } });
    expect(s.libs?.setup).toBeUndefined();
    expect(s.libs?.command).toContain('libx11-6');
    const res = await post([LINE]);
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toContain('conclave system-helper install');
    expect(ran).toEqual([]);
    expect(audits()).toEqual([]);
  });

  test('needs the owner, and a list of lines', async () => {
    expect((await post([LINE], null)).status).toBe(401);
    expect((await post('sudo id')).status).toBe(400);
    expect((await post([1])).status).toBe(400);
  });

  test('with the helper: only the confirmed line runs, audited, and the answer is Ready', async () => {
    machine.helper = { installed: true, ready: true, install: 'conclave system-helper install' };
    const s = await json<BrowserStatusDto>(await hub.api('/api/browser'));
    expect(s.libs?.setup?.lines).toEqual([LINE]);
    for (const bad of [['sudo apt-get install -y evil'], [LINE, 'id'], [`${LINE} libevil`], []]) {
      const res = await post(bad);
      expect(res.status).toBe(409);
      // the fresh step comes back with the refusal
      expect((await json<{ libs?: { setup?: { lines: string[] } } }>(res)).libs?.setup?.lines).toEqual([LINE]);
    }
    expect(ran).toEqual([]);
    const res = await post([LINE]);
    expect(res.status).toBe(200);
    const r = await json<BrowserLibsResult>(res);
    expect(r).toMatchObject({ ok: true, ready: true, ran: [LINE] });
    expect(ran).toEqual([LINE]);
    const a = audits().map((x) => `${x.action}: ${x.detail}`);
    expect(a.some((l) => l.startsWith('browser.libs: as ') && l.includes(LINE))).toBe(true);
    expect(a).toContain('browser.libs.result: ok, every library is there');
    expect((await json<BrowserStatusDto>(await hub.api('/api/browser'))).libs).toEqual({ missing: [], noFonts: false, packages: [] });
  });
});
