/**
 * "Install on the hub" (catalog/hub-setup.ts): the fixed installer table,
 * which commands run for a target and in what order, the refusals (items
 * that do not ship with Conclave, device steps, root), and the service run
 * with a fake hub shell. Nothing here installs anything or reaches the network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { RECOMMENDED, type CatalogItem } from '../../src/catalog/recommended';
import { HUB_INSTALLERS, TailLines, UV_INSTALLER_URL, UV_VERSION, canRunOnHub, firstProgram, hubSetupBins, hubSetupOffer, rootCommand, uvToolCommand, type HubFacts } from '../../src/catalog/hub-setup';
import { CatalogService } from '../../src/catalog/service';
import { CatalogError } from '../../src/catalog/install';
import type { ExecOptions, ExecResult } from '../../src/machine/types';
import { cleanupAll, fakeHost, tempHome } from './helpers';

afterEach(cleanupAll);

const item = (id: string): CatalogItem => {
  const it = RECOMMENDED.find((x) => x.id === id);
  if (!it) throw new Error(`no shipped item ${id}`);
  return it;
};

/** A hub where everything is found except the named programs. */
const facts = (missing: string[] = [], extra: Partial<HubFacts> = {}): HubFacts => ({ has: (b) => !missing.includes(b), user: 'conclave', home: '/home/conclave', platform: 'linux', ...extra });

const UV_RUN = HUB_INSTALLERS.uv.run;

describe('the installer table', () => {
  test('uv and uvx come from one pinned, user-level install script', () => {
    expect(HUB_INSTALLERS.uv).toBe(HUB_INSTALLERS.uvx);
    expect(HUB_INSTALLERS.uv.gives).toEqual(['uv', 'uvx']);
    expect(HUB_INSTALLERS.uv.needs).toEqual(['curl']);
    expect(UV_INSTALLER_URL).toBe(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-installer.sh`);
    expect(UV_RUN).toBe(`curl -LsSf ${UV_INSTALLER_URL} | env UV_NO_MODIFY_PATH=1 sh`);
    expect(UV_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('nothing in the table uses sudo, and only uv is in it', () => {
    expect(Object.keys(HUB_INSTALLERS).sort()).toEqual(['uv', 'uvx']);
    for (const inst of Object.values(HUB_INSTALLERS)) expect(inst.run).not.toMatch(/\bsudo\b/);
  });

  test('root programs get the Debian command, Chrome its own package, unknown ones none', () => {
    expect(rootCommand('docker')).toBe('sudo apt-get install -y docker.io');
    expect(rootCommand('npx')).toBe('sudo apt-get install -y npm');
    expect(rootCommand('curl')).toBe('sudo apt-get install -y curl');
    expect(rootCommand('r2pm')).toBe('sudo apt-get install -y radare2');
    expect(rootCommand('google-chrome')).toContain('dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb');
    expect(rootCommand('google-chrome')).toContain('sudo apt-get install -y ./google-chrome-stable_current_amd64.deb');
    expect(rootCommand('serena')).toBeUndefined();
    expect(rootCommand('uvx')).toBeUndefined();
  });

  test('uv tool install quotes a package spec a shell would read', () => {
    expect(uvToolCommand('semgrep')).toBe('uv tool install semgrep');
    expect(uvToolCommand('zotero-mcp-server==0.15.1')).toBe('uv tool install zotero-mcp-server==0.15.1');
    expect(uvToolCommand('recursive-improve[all] @ git+https://github.com/x/y.git')).toBe("uv tool install 'recursive-improve[all] @ git+https://github.com/x/y.git'");
    expect(uvToolCommand("a'b")).toBe(`uv tool install 'a'\\''b'`);
  });

  test('the first program of a command skips assignments and env', () => {
    expect(firstProgram('uv tool install -p 3.13 serena-agent && serena init')).toBe('uv');
    expect(firstProgram('FOO=1 env BAR=2 semgrep --version')).toBe('semgrep');
    expect(firstProgram('r2pm -ci r2mcp')).toBe('r2pm');
    expect(firstProgram('   ')).toBeUndefined();
    expect(firstProgram('$(evil)')).toBeUndefined();
  });
});

describe('what runs, in what order', () => {
  test('Serena: uv first when it is missing, then the step', () => {
    const o = hubSetupOffer(item('mcp:serena'), { missing: true }, facts(['uv', 'uvx', 'serena']), { shipped: true });
    expect(o.commands.map((c) => c.run)).toEqual([UV_RUN, 'uv tool install -p 3.13 serena-agent && serena init']);
    expect(o.checks.sort()).toEqual(['serena', 'uv', 'uvx']);
    expect(o).toMatchObject({ user: 'conclave', home: '/home/conclave', byHand: [] });
    expect(o.refusal).toBeUndefined();
    expect(canRunOnHub(o)).toBe(true);
    // the step as the target gives the same order
    const step = hubSetupOffer(item('mcp:serena'), { step: 0, variant: 0 }, facts(['uv', 'uvx', 'serena']), { shipped: true });
    expect(step.commands.map((c) => c.run)).toEqual(o.commands.map((c) => c.run));
  });

  test('with uv there, only the step runs', () => {
    const o = hubSetupOffer(item('mcp:semgrep'), { missing: true }, facts(['semgrep']), { shipped: true });
    expect(o.commands).toEqual([{ say: expect.stringContaining('Install semgrep'), run: 'uv tool install semgrep' }]);
    expect(o.checks).toEqual(['semgrep']);
    expect(hubSetupOffer(item('mcp:zotero'), { bin: 'zotero-mcp' }, facts(['zotero-mcp']), { shipped: true }).commands.map((c) => c.run)).toEqual(['uv tool install zotero-mcp-server==0.15.1']);
  });

  test('a uvx need installs uv with the script and nothing else', () => {
    const o = hubSetupOffer(item('mcp:basic-memory'), { missing: true }, facts(['uv', 'uvx']), { shipped: true });
    expect(o.commands.map((c) => c.run)).toEqual([UV_RUN]);
    expect(hubSetupOffer(item('mcp:basic-memory'), { bin: 'uvx' }, facts(['uvx']), { shipped: true }).commands.map((c) => c.run)).toEqual([UV_RUN]);
  });

  test('a need that names its Python package installs it with uv, after uv', () => {
    const ruff: CatalogItem = { ...item('mcp:semgrep'), id: 'mcp:ruff-test', install: { type: 'mcp', server: 'ruff', config: { command: 'ruff' } }, needs: [{ bin: 'ruff', where: 'hub', why: 'test', uvTool: 'ruff==0.6.0' }] };
    expect(hubSetupOffer(ruff, { missing: true }, facts(['uv', 'uvx', 'ruff']), { shipped: true }).commands.map((c) => c.run)).toEqual([UV_RUN, 'uv tool install ruff==0.6.0']);
    expect(hubSetupOffer(ruff, { missing: true }, facts(['ruff']), { shipped: true }).commands.map((c) => c.run)).toEqual(['uv tool install ruff==0.6.0']);
    expect(hubSetupBins(ruff).sort()).toEqual(['curl', 'ruff', 'uv', 'uvx']);
  });

  test('a step whose programs are there already is marked done and can still run', () => {
    const o = hubSetupOffer(item('mcp:serena'), { step: 0, variant: 0 }, facts([]), { shipped: true });
    expect(o.done).toBe(true);
    expect(o.commands.map((c) => c.run)).toEqual(['uv tool install -p 3.13 serena-agent && serena init']);
  });

  test('hubSetupBins names every program an offer asks about', () => {
    expect(hubSetupBins(item('mcp:serena')).sort()).toEqual(['curl', 'serena', 'uv', 'uvx']);
    expect(hubSetupBins(item('mcp:radare2')).sort()).toEqual(['r2mcp', 'r2pm']);
    // device steps are not the hub's
    expect(hubSetupBins(item('mcp:ghidra'))).toEqual([]);
  });
});

describe('refusals', () => {
  test('an item that does not ship with Conclave runs nothing, step or need', () => {
    const fromGithub: CatalogItem = { ...item('mcp:serena'), id: 'gh:oraios/serena', source: 'github' };
    const step = hubSetupOffer(fromGithub, { step: 0, variant: 0 }, facts(['uv', 'uvx', 'serena']), { shipped: false });
    expect(step).toMatchObject({ refusal: 'not-shipped', commands: [], checks: [] });
    expect(step.why).toContain('only for items from its own list');
    const need = hubSetupOffer({ ...item('mcp:basic-memory'), id: 'reg:basic-memory', source: 'mcp-registry' }, { missing: true }, facts(['uv', 'uvx']), { shipped: false });
    expect(need.refusal).toBe('not-shipped');
    expect(need.commands).toEqual([]);
    // the command is still there to copy
    expect(need.byHand).toEqual([{ bin: 'uvx', why: 'Install it on the hub by hand.', run: UV_RUN }]);
    expect(canRunOnHub(need)).toBe(false);
  });

  test('a device step, a step with nothing to run and a step that is not there', () => {
    const ghidra = item('mcp:ghidra');
    const deviceIdx = (ghidra.install.type === 'mcp' ? ghidra.install.setup ?? [] : []).findIndex((s) => s.on === 'device' && s.run);
    expect(deviceIdx).toBeGreaterThanOrEqual(0);
    expect(hubSetupOffer(ghidra, { step: deviceIdx, variant: 0 }, facts(), { shipped: true })).toMatchObject({ refusal: 'device', commands: [] });
    // "create a user on pve" is for the owner to do
    expect(hubSetupOffer(item('mcp:proxmox'), { step: 0, variant: 0 }, facts(), { shipped: true })).toMatchObject({ refusal: 'no-run' });
    const noRun: CatalogItem = { ...item('mcp:serena'), install: { type: 'mcp', server: 's', config: { command: 's' }, setup: [{ say: 'Do it yourself.', on: 'hub' }] } };
    expect(hubSetupOffer(noRun, { step: 0, variant: 0 }, facts(), { shipped: true }).refusal).toBe('no-run');
    expect(hubSetupOffer(item('mcp:serena'), { step: 5, variant: 0 }, facts(), { shipped: true }).refusal).toBe('no-step');
    expect(hubSetupOffer(item('mcp:serena'), { bin: 'docker' }, facts(), { shipped: true }).refusal).toBe('not-needed');
  });

  test('a device need is not the hub\'s to install', () => {
    const rtk = RECOMMENDED.find((x) => (x.needs ?? []).some((n) => n.bin === 'rtk'))!;
    expect(hubSetupOffer(rtk, { bin: 'rtk' }, facts(['rtk']), { shipped: true })).toMatchObject({ refusal: 'device', why: expect.stringContaining('on every device') });
  });

  test('sudo and placeholders in a step are refused even for a shipped item', () => {
    const mk = (run: string): CatalogItem => ({ ...item('mcp:serena'), install: { type: 'mcp', server: 's', config: { command: 's' }, setup: [{ say: 'x', run, on: 'hub', gives: ['s'] }] } });
    expect(hubSetupOffer(mk('sudo apt-get install -y x'), { step: 0, variant: 0 }, facts(['s']), { shipped: true }).refusal).toBe('sudo');
    expect(hubSetupOffer(mk('uv tool install x && sudo true'), { step: 0, variant: 0 }, facts(['s']), { shipped: true }).refusal).toBe('sudo');
    expect(hubSetupOffer(mk('mcp-proxy --host <tailscale ip>'), { step: 0, variant: 0 }, facts(['s']), { shipped: true }).refusal).toBe('placeholder');
  });

  test('root programs get no command to run, only the one to copy', () => {
    const o = hubSetupOffer(item('mcp:chrome-devtools'), { missing: true }, facts(['npx', 'google-chrome']), { shipped: true });
    expect(o).toMatchObject({ refusal: 'nothing', commands: [] });
    expect(o.byHand.map((h) => [h.bin, h.root, h.run?.includes('sudo apt-get install -y')])).toEqual([
      ['npx', true, true],
      ['google-chrome', true, true],
    ]);
    expect(o.why).toBe('npx and google-chrome need root to install, so install them on the server by hand.');
    const docker = hubSetupOffer(item('mcp:grafana'), { missing: true }, facts(['docker']), { shipped: true });
    expect(docker.byHand).toEqual([{ bin: 'docker', why: 'docker needs root to install. Install it on the server by hand.', run: 'sudo apt-get install -y docker.io', root: true }]);
  });

  test('uv cannot install without curl: both are left by hand', () => {
    const o = hubSetupOffer(item('mcp:basic-memory'), { missing: true }, facts(['uv', 'uvx', 'curl']), { shipped: true });
    expect(o.commands).toEqual([]);
    expect(o.byHand).toEqual([
      { bin: 'curl', why: 'curl needs root to install. Install it on the server by hand.', run: 'sudo apt-get install -y curl', root: true },
      { bin: 'uvx', why: 'Its installer needs curl first.', run: UV_RUN },
    ]);
    expect(o.why).toContain('curl needs root');
  });

  test('a step whose program needs root cannot run, and says what to install first', () => {
    const o = hubSetupOffer(item('mcp:radare2'), { step: 0, variant: 0 }, facts(['r2pm', 'r2mcp']), { shipped: true });
    expect(o).toMatchObject({ refusal: 'nothing', commands: [], why: 'It needs r2pm on the hub first.' });
    expect(o.byHand.find((h) => h.bin === 'r2pm')).toMatchObject({ run: 'sudo apt-get install -y radare2', root: true });
    expect(o.byHand.find((h) => h.bin === 'r2mcp')).toMatchObject({ why: 'Its setup step needs r2pm first.', run: 'r2pm -ci r2mcp' });
  });

  test('nothing missing, nothing to run; a Windows hub runs nothing', () => {
    expect(hubSetupOffer(item('mcp:serena'), { missing: true }, facts([]), { shipped: true })).toMatchObject({ refusal: 'nothing', why: 'Nothing is missing on the hub.' });
    expect(hubSetupOffer(item('mcp:serena'), { missing: true }, facts(['serena'], { platform: 'win32' }), { shipped: true }).refusal).toBe('os');
  });
});

describe('the shipped list', () => {
  test('every hub step with a command names what it gives, never uses sudo, and covers a hub need', () => {
    let steps = 0;
    for (const it of RECOMMENDED) {
      for (const spec of [it.install, ...(it.variants ?? [])]) {
        const setup = spec.type === 'mcp' ? (spec.setup ?? []) : spec.type === 'manual' ? spec.steps : [];
        for (const s of setup) {
          if (s.on !== 'hub' || !s.run) continue;
          steps++;
          expect(s.run).not.toMatch(/\bsudo\b/);
          expect(firstProgram(s.run)).toBeDefined();
          expect(s.gives?.length).toBeGreaterThan(0);
          for (const g of s.gives!) expect((it.needs ?? []).some((n) => n.bin === g && n.where === 'hub')).toBe(true);
        }
      }
    }
    expect(steps).toBeGreaterThanOrEqual(4);
  });
});

describe('the output tail', () => {
  test('keeps the last lines across chunks, the last state of a redrawn line, and whole lines put in between', () => {
    const t = new TailLines(3);
    t.line('$ one');
    t.push('a\nb');
    t.push('c\nd\n');
    t.push('10%\r50%\r100%\n');
    expect(t.text()).toBe('bc\nd\n100%');
    const u = new TailLines(5);
    u.push('partial');
    u.line('$ next');
    expect(u.text()).toBe('partial\n$ next');
  });
});

// ---------------------------------------------------------------------------
// The service: runs the offer through the hub shell, then checks again
// ---------------------------------------------------------------------------

interface Call {
  command: string;
  opts: ExecOptions;
}

function hub(missing: string[], script: (command: string, opts: ExecOptions) => Partial<ExecResult> | Promise<Partial<ExecResult>> = () => ({})) {
  const home = tempHome();
  const host = fakeHost(home);
  const absent = new Set(missing);
  const calls: Call[] = [];
  const svc = new CatalogService({
    db: home.db,
    paths: home.paths,
    host,
    sources: { github: false, 'mcp-registry': false, marketplaces: false, feeds: false },
    fetch: () => Promise.reject(new TypeError('offline')),
    checkBin: async (b) => !absent.has(b),
    hubShell: {
      exec: async (command, opts) => {
        calls.push({ command, opts });
        const r = await script(command, opts);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, durationMs: 1, ...r };
      },
    },
  });
  return { svc, host, calls, absent };
}

describe('CatalogService.runSetup', () => {
  test('runs uv then the step in the hub user\'s home, with ~/.local/bin on PATH, audits, and answers with the new readiness', async () => {
    const h = hub(['uv', 'uvx', 'serena'], (command, opts) => {
      opts.onOutput?.(`ran ${command.slice(0, 20)}\n`, 'stdout');
      if (command.startsWith('curl')) (h.absent.delete('uv'), h.absent.delete('uvx'));
      if (command.startsWith('uv tool')) h.absent.delete('serena');
      return {};
    });
    const before = await h.svc.detail('mcp:serena');
    expect(before.ready.ok).toBe(false);
    expect(before.ready.hubSetup?.commands.map((c) => c.run)).toEqual([UV_RUN, 'uv tool install -p 3.13 serena-agent && serena init']);
    const r = await h.svc.runSetup('mcp:serena', { commands: before.ready.hubSetup!.commands.map((c) => c.run) });
    expect(r).toMatchObject({ ok: true, exitCode: 0, ran: [UV_RUN, 'uv tool install -p 3.13 serena-agent && serena init'], ready: { ok: true, missing: [] } });
    expect(r.ready.hubSetup).toBeUndefined();
    expect(r.tail).toContain(`$ ${UV_RUN}`);
    expect(r.tail).toContain('ran uv tool install -p ');
    const home = before.ready.hubSetup!.home;
    for (const c of h.calls) {
      expect(c.opts.cwd).toBe(home);
      // in front, unless the hub's PATH has it already (the LXC unit does)
      expect(c.opts.env?.PATH?.split(':')).toContain(join(home, '.local', 'bin'));
      expect(c.opts.timeoutMs).toBeLessThanOrEqual(10 * 60_000);
      expect(c.command).not.toMatch(/\bsudo\b/);
    }
    expect(h.host.state.audit.map((a) => a.action)).toEqual(['catalog.setup', 'catalog.setup.result']);
    expect(h.host.state.audit[0].detail).toContain(`mcp:serena as ${before.ready.hubSetup!.user} in ${home}: ${UV_RUN} && uv tool install -p 3.13`);
  });

  test('puts ~/.local/bin in front of a PATH that does not have it, so uv tool install finds the uv it just got', async () => {
    const prev = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      const h = hub(['semgrep']);
      const r = await h.svc.runSetup('mcp:semgrep');
      expect(r.ok).toBe(true);
      expect(h.calls[0].opts.env?.PATH).toBe(`${join(h.calls[0].opts.cwd, '.local', 'bin')}:/usr/bin:/bin`);
    } finally {
      process.env.PATH = prev;
    }
  });

  test('stops at the first command that fails and keeps the end of its output', async () => {
    const h = hub(['uv', 'uvx', 'serena'], (command, opts) => {
      if (!command.startsWith('curl')) return {};
      for (let i = 0; i < 250; i++) opts.onOutput?.(`line ${i}\n`, 'stderr');
      return { exitCode: 22 };
    });
    const r = await h.svc.runSetup('mcp:serena');
    expect(r).toMatchObject({ ok: false, exitCode: 22, ran: [UV_RUN] });
    expect(h.calls.length).toBe(1);
    const lines = r.tail.split('\n');
    expect(lines.length).toBe(200);
    expect(lines.at(-1)).toBe('line 249');
    expect(r.ready.ok).toBe(false);
    expect(h.host.state.audit.at(-1)?.detail).toContain('failed, exit 22');
  });

  test('refuses an item that does not ship with Conclave, a device step, nothing to run, and a changed plan', async () => {
    const h = hub(['uv', 'uvx', 'serena']);
    const err = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return e as CatalogError;
      }
      throw new Error('expected a refusal');
    };
    // a GitHub result cached under its own id, with the same step text
    const svcAny = h.svc as unknown as { store: { upsertItem(i: CatalogItem, at: number): void } };
    svcAny.store.upsertItem({ ...item('mcp:serena'), id: 'gh:oraios/serena', source: 'github' }, Date.now());
    const notShipped = await err(h.svc.runSetup('gh:oraios/serena', { step: 0 }));
    expect(notShipped.status).toBe(403);
    expect((await err(h.svc.runSetup('mcp:ghidra', { step: 1 }))).status).toBe(400);
    expect((await err(h.svc.runSetup('mcp:serena', { step: 0, variant: 3 }))).status).toBe(400);
    expect((await err(h.svc.runSetup('mcp:github'))).status).toBe(409);
    expect((await err(h.svc.runSetup('nope:x'))).status).toBe(404);
    const changed = await err(h.svc.runSetup('mcp:serena', { commands: ['uv tool install -p 3.13 serena-agent && serena init'] }));
    expect(changed.status).toBe(409);
    expect((changed.data?.setup as { commands: unknown[] }).commands.length).toBe(2);
    expect(h.calls).toEqual([]);
  });

  test('one run at a time per item', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = hub(['semgrep'], async () => {
      await gate;
      return {};
    });
    const first = h.svc.runSetup('mcp:semgrep');
    await Bun.sleep(5);
    let second: unknown;
    try {
      await h.svc.runSetup('mcp:semgrep');
    } catch (e) {
      second = e;
    }
    expect((second as CatalogError).status).toBe(409);
    release();
    expect((await first).ok).toBe(true);
  });

  test('the preview marks hub steps with what would run, and device steps with nothing', async () => {
    const h = hub(['semgrep']);
    const p = await h.svc.preview({ id: 'mcp:semgrep' });
    expect(p.steps[0].hub?.commands.map((c) => c.run)).toEqual(['uv tool install semgrep']);
    const g = await h.svc.preview({ id: 'mcp:ghidra' });
    expect(g.steps.every((s) => !s.hub)).toBe(true);
  });
});
