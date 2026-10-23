/** `conclave doctor`: a checklist of what is installed and what to fix. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConclaveClient } from '@conclave/core/client/index.ts';
import { parseJsonc } from '@conclave/core/config/index.ts';
import { out as p } from '../ansi';
import type { ParsedArgs } from '../args';
import { cliPaths, readClientFile, readDeviceFile } from '../files';
import { checkHealth, currentHub } from '../hub';
import { hubFlags, print } from './shared';

type Level = 'ok' | 'warn' | 'fail' | 'info';

interface Check {
  level: Level;
  label: string;
  detail?: string;
  fix?: string;
}

function which(cmd: string): string | undefined {
  try {
    return Bun.which(cmd) ?? undefined;
  } catch {
    return undefined;
  }
}

function version(cmd: string, args = ['--version']): string | undefined {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 4000 });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    const m = /\d+\.\d+(\.\d+)?([-.\w]*)?/.exec(text);
    return m ? m[0] : text.split('\n')[0]?.slice(0, 40) || undefined;
  } catch {
    return undefined;
  }
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function tool(name: string, fix: string, required = false): Check {
  const path = which(name);
  if (!path) return { level: required ? 'fail' : 'warn', label: name, detail: 'not found', fix };
  return { level: 'ok', label: name, detail: version(name) ?? path };
}

const INSTALL = {
  rg: 'install ripgrep: brew install ripgrep | apt install ripgrep | winget install BurntSushi.ripgrep.MSVC',
  git: 'install git (needed for checkpoints and diffs)',
  node: 'install Node.js 20+ (npx runs the Claude Code and Codex ACP adapters)',
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  opencode: 'curl -fsSL https://opencode.ai/install | bash',
  gemini: 'npm i -g @google/gemini-cli',
};

const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  zai: 'ZAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export async function doctorCommand(args: ParsedArgs): Promise<number> {
  const sections: Array<[string, Check[]]> = [];

  // --- runtime and tools
  const sys: Check[] = [];
  const bunV = typeof Bun !== 'undefined' ? Bun.version : undefined;
  if (!bunV) sys.push({ level: 'fail', label: 'bun', detail: 'not running under Bun', fix: 'curl -fsSL https://bun.sh/install | bash' });
  else if (cmpVersion(bunV, '1.2.0') < 0) sys.push({ level: 'fail', label: 'bun', detail: bunV, fix: 'bun upgrade (1.2 or newer)' });
  else sys.push({ level: 'ok', label: 'bun', detail: bunV });
  sys.push(tool('git', INSTALL.git, true));
  sys.push(tool('rg', INSTALL.rg));
  sys.push(tool('node', INSTALL.node));
  const npx = which('npx');
  sections.push(['Runtime', sys]);

  // --- harnesses (CLIs and their ACP adapters)
  const h: Check[] = [];
  const adapter = (bin: string, pkg: string): string => {
    if (which(bin)) return `ACP adapter ${bin} on PATH`;
    return npx ? `ACP adapter via npx ${pkg}` : `ACP adapter needs npx (${pkg})`;
  };
  const claude = tool('claude', INSTALL.claude);
  claude.detail = `${claude.detail} · ${adapter('claude-code-acp', '@zed-industries/claude-code-acp')}`;
  if (claude.level === 'ok' && !npx && !which('claude-code-acp')) Object.assign(claude, { level: 'warn', fix: 'npm i -g @zed-industries/claude-code-acp' });
  h.push(claude);
  const codex = tool('codex', INSTALL.codex);
  codex.detail = `${codex.detail} · ${adapter('codex-acp', '@zed-industries/codex-acp')}`;
  if (codex.level === 'ok' && !npx && !which('codex-acp')) Object.assign(codex, { level: 'warn', fix: 'npm i -g @zed-industries/codex-acp' });
  h.push(codex);
  const gemini = tool('gemini', INSTALL.gemini);
  if (gemini.level === 'ok') gemini.detail += ' · ACP built in (--experimental-acp)';
  h.push(gemini);
  const opencode = tool('opencode', INSTALL.opencode);
  if (opencode.level === 'ok') opencode.detail += ' · ACP built in (opencode acp)';
  h.push(opencode);
  for (const c of h) if (c.level === 'warn' && c.detail === 'not found') c.level = 'info';
  sections.push(['Harnesses (optional)', h]);

  // --- config files
  const files: Check[] = [];
  const paths = cliPaths();
  if (existsSync(paths.config)) {
    try {
      parseJsonc(readFileSync(paths.config, 'utf8'));
      files.push({ level: 'ok', label: 'config', detail: paths.config });
    } catch (e) {
      files.push({ level: 'fail', label: 'config', detail: `invalid JSON: ${(e as Error).message}`, fix: 'conclave config edit' });
    }
  } else files.push({ level: 'info', label: 'config', detail: 'not created yet (the hub writes it on first start)' });
  const cf = readClientFile();
  if (cf) files.push({ level: 'info', label: 'login', detail: `client.json -> ${cf.hub}`, fix: 'conclave logout to use the local hub' });
  const df = readDeviceFile();
  if (df) files.push({ level: 'info', label: 'device', detail: `paired as ${df.deviceId} with ${df.hub}` });
  sections.push(['Files', files]);

  // --- hub
  const hub: Check[] = [];
  const target = currentHub(hubFlags(args));
  const health = await checkHealth(target.url, 2500);
  let client: ConclaveClient | undefined;
  if (health.ok) {
    client = new ConclaveClient({ baseUrl: target.url, token: target.token });
    let ver = '';
    try {
      ver = (await client.info()).version;
    } catch {
      /* ignore */
    }
    hub.push({ level: 'ok', label: 'reachable', detail: `${target.url} ${ver ? 'v' + ver : ''} (${target.source})` });
    try {
      await client.listSessions({ limit: 1 });
      hub.push({ level: 'ok', label: 'token', detail: 'accepted' });
    } catch (e) {
      hub.push({ level: 'fail', label: 'token', detail: (e as Error).message, fix: target.local ? 'check server.token in ~/.conclave/config.json' : 'conclave login <hub> --code CODE' });
      client = undefined;
    }
  } else {
    hub.push({
      level: target.local ? 'warn' : 'fail',
      label: 'reachable',
      detail: `${target.url}: ${health.reason}${health.status ? ' ' + health.status : ''}`,
      fix: target.local ? 'conclave serve --detach (or just run `conclave`, it starts the hub)' : 'check the URL (a quick tunnel address changes when the hub restarts), or run conclave login again with a new code',
    });
  }
  sections.push(['Hub', hub]);

  // --- providers
  const prov: Check[] = [];
  if (client) {
    try {
      const groups = await client.models();
      for (const g of groups) {
        if (!g.enabled) continue;
        if (g.type === 'acp') continue;
        prov.push(
          g.configured
            ? { level: 'ok', label: g.provider, detail: `${g.models.length} models` }
            : { level: 'warn', label: g.provider, detail: g.error ?? 'no API key', fix: `conclave secret ${g.provider}${KEY_ENV[g.provider] ? ` (or set ${KEY_ENV[g.provider]})` : ''}` },
        );
      }
      if (!prov.some((c) => c.level === 'ok')) prov.unshift({ level: 'fail', label: 'any provider', detail: 'no provider has a key', fix: 'conclave secret anthropic (or openai, zai, google...)' });
    } catch (e) {
      prov.push({ level: 'warn', label: 'models', detail: (e as Error).message });
    }
  } else {
    for (const [id, env] of Object.entries(KEY_ENV)) {
      prov.push(process.env[env] ? { level: 'ok', label: id, detail: `${env} set` } : { level: 'info', label: id, detail: `${env} not set here (the hub may have a stored key)` });
    }
  }
  sections.push(['Provider keys', prov]);

  // --- web assets
  const web: Check[] = [];
  const candidates = [resolve(import.meta.dir, '../../../web/dist/index.html'), join(paths.web, 'index.html')];
  const found = candidates.find((c) => existsSync(c));
  web.push(found ? { level: 'ok', label: 'web app', detail: found.replace(/[\\/]index\.html$/, '') } : { level: 'warn', label: 'web app', detail: 'not built', fix: 'bun run build (or copy a build to ~/.conclave/web)' });
  sections.push(['Web', web]);

  // --- print
  const icon: Record<Level, string> = { ok: p.green('✓'), warn: p.yellow('!'), fail: p.red('✗'), info: p.dim('·') };
  print(p.bold('Conclave doctor'));
  const labelW = Math.max(...sections.flatMap(([, cs]) => cs.map((c) => c.label.length))) + 2;
  for (const [title, checks] of sections) {
    if (!checks.length) continue;
    print('');
    print(p.bold(title));
    for (const c of checks) {
      print(`  ${icon[c.level]} ${c.label.padEnd(labelW)}${c.level === 'info' ? p.dim(c.detail ?? '') : (c.detail ?? '')}`);
      if (c.fix && c.level !== 'ok') print(`    ${' '.repeat(labelW)}${p.dim('fix: ' + c.fix)}`);
    }
  }
  const all = sections.flatMap(([, cs]) => cs);
  const fails = all.filter((c) => c.level === 'fail').length;
  const warns = all.filter((c) => c.level === 'warn').length;
  print('');
  print(fails ? p.red(`${fails} problem${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`) : warns ? p.yellow(`All required checks pass, ${warns} warning${warns === 1 ? '' : 's'}`) : p.green('All good'));
  return fails ? 1 : 0;
}
