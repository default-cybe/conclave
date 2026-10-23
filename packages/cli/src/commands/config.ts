/** `conclave config`, `conclave secret`, `conclave pair-phone`, `conclave web`. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseJsonc, DEFAULT_CONFIG, deepMerge } from '@conclave/core/config/index.ts';
import { formatFingerprint } from '@conclave/core/client/index.ts';
import { out as p } from '../ansi';
import { bool, str, type ParsedArgs } from '../args';
import { cliPaths } from '../files';
import { checkHealth, currentHub, loginLink } from '../hub';
import { terminalQr } from '../qr';
import { CliError, getClient, hubFlags, openUrl, print, prompt, requireArg } from './shared';

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Build a nested patch object from "a.b.c" and a value. */
export function patchFor(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) throw new CliError('Empty config path');
  const root: Record<string, unknown> = {};
  let cur = root;
  parts.forEach((part, i) => {
    if (i === parts.length - 1) cur[part] = value;
    else {
      const next: Record<string, unknown> = {};
      cur[part] = next;
      cur = next;
    }
  });
  return root;
}

export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readLocalConfig(): Record<string, unknown> {
  const f = cliPaths().config;
  if (!existsSync(f)) return {};
  return parseJsonc<Record<string, unknown>>(readFileSync(f, 'utf8'));
}

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? 'undefined';
}

export async function configCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'get';
  const file = cliPaths().config;
  if (sub === 'path') {
    print(file);
    return 0;
  }
  if (sub === 'edit') {
    if (!existsSync(file)) writeFileSync(file, '{\n}\n', { mode: 0o600 });
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    const res = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
    if (res.status !== 0) throw new CliError(`${editor} exited with ${res.status}`);
    let edited: Record<string, unknown>;
    try {
      edited = parseJsonc(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new CliError(`The config is not valid JSON now: ${(e as Error).message}`);
    }
    // A running hub keeps its own copy; push the edit so it does not write the old one back.
    const target = currentHub(hubFlags(args));
    if (target.local && (await checkHealth(target.url, 800)).ok) {
      try {
        const { client } = await getClient(args, { autostart: false, quiet: true });
        await client.updateConfig(edited);
        print(`${p.green('✓')} Saved and sent to the running hub.`);
        return 0;
      } catch (e) {
        print(p.yellow(`Saved. The running hub did not take it (${(e as Error).message}); restart it to apply.`));
        return 0;
      }
    }
    print(`${p.green('✓')} Saved ${file}`);
    return 0;
  }
  if (sub === 'get') {
    const path = args._[2] ?? '';
    let cfg: Record<string, unknown>;
    try {
      const { client } = await getClient(args, { autostart: false, quiet: true });
      cfg = (await client.config()).config;
    } catch {
      cfg = deepMerge(structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>, readLocalConfig());
      process.stderr.write(p.dim('(hub not reachable; showing the local file merged with defaults)\n'));
    }
    const v = getPath(cfg, path);
    if (v === undefined) throw new CliError(`No config value at "${path}"`);
    print(show(v));
    return 0;
  }
  if (sub === 'set') {
    const path = requireArg(args._[2], 'conclave config set <path> <json>');
    const raw = args._.slice(3).join(' ');
    if (!raw) throw new CliError('Missing value. Usage: conclave config set <path> <json>');
    const value = parseValue(raw);
    const patch = patchFor(path, value);
    try {
      const { client } = await getClient(args, { autostart: false, quiet: true });
      await client.updateConfig(patch);
      print(`${p.green('✓')} ${path} = ${show(value)}`);
    } catch (e) {
      if (str(args, 'hub')) throw e;
      // No hub: edit the local file directly.
      const merged = deepMerge(readLocalConfig(), patch);
      writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
      print(`${p.green('✓')} ${path} = ${show(value)} ${p.dim('(written to ' + file + ')')}`);
    }
    return 0;
  }
  throw new CliError('Usage: conclave config [get <path> | set <path> <json> | edit | path]');
}

export async function secretCommand(args: ParsedArgs): Promise<number> {
  const provider = requireArg(args._[1], 'conclave secret <provider>');
  const { client } = await getClient(args);
  if (bool(args, 'delete')) {
    await client.setSecret('providers', provider, null);
    print(`${p.green('✓')} Removed the ${provider} key`);
    return 0;
  }
  const value = str(args, 'value') ?? (await prompt(`${provider} API key (input hidden): `, { hidden: true }));
  if (!value.trim()) throw new CliError('Empty key, nothing saved.');
  await client.setSecret('providers', provider, value.trim());
  print(`${p.green('✓')} Saved the ${provider} key on the hub ${p.dim('(' + value.trim().slice(0, 4) + '…)')}`);
  // the Maps key is not a model provider's: its test calls each Google Maps API once (Settings > Maps)
  if (provider === 'google-maps') {
    try {
      const r = await client.testMaps();
      for (const s of r.steps) print(`${s.ok ? p.green('✓') : p.yellow('!')} ${s.name}: ${s.message}`);
      if (r.provider !== 'google') print(p.dim('The hub uses OpenStreetMap now. Pick Google in Settings, Maps, to use the key.'));
    } catch (e) {
      print(`${p.yellow('!')} Maps test failed: ${(e as Error).message}`);
    }
    return 0;
  }
  try {
    const r = await client.testProvider(provider);
    print(r.ok ? `${p.green('✓')} ${provider} works ${p.dim(r.latencyMs ? `(${r.latencyMs}ms)` : '')}` : `${p.yellow('!')} ${provider} test failed: ${r.detail}`);
  } catch {
    /* test route optional */
  }
  return 0;
}

export async function pairPhoneCommand(args: ParsedArgs): Promise<number> {
  const { client } = await getClient(args);
  const pairing = await client.createPairing('client');
  print(p.bold('Scan with the Conclave app (or your phone camera):'));
  print(await terminalQr(pairing.deepLink));
  print(`Code   ${p.bold(pairing.code)} ${p.dim(`(valid ${Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60000))} min)`)}`);
  print(`Hub    ${pairing.url}`);
  for (const alt of (pairing.addresses ?? []).slice(1)) print(p.dim(`       ${alt}`));
  if (pairing.fingerprint) print(`Key    ${formatFingerprint(pairing.fingerprint)} ${p.dim('(apps check the hub against it)')}`);
  if (/localhost|127\.0\.0\.1|\[::1\]/.test(pairing.url)) {
    print(p.yellow('This address only works on this machine. Run `conclave remote quick` for an https address with no account, or `conclave remote url <URL>` for your own.'));
  }
  print(p.dim(`On another terminal: conclave login ${pairing.url} --code ${pairing.code}`));
  return 0;
}

export async function webCommand(args: ParsedArgs): Promise<number> {
  const { target } = await getClient(args);
  const link = loginLink(target.url, target.token);
  print(link);
  if (!bool(args, 'no-open')) {
    const ok = await openUrl(link);
    if (!ok) print(p.dim('Could not open a browser; open the link above.'));
  }
  return 0;
}
