/**
 * `conclave update`: how this install updates, and the newest release.
 *
 *   conclave update           this version, how it updates, the newest release
 *   conclave update finish    the updater's own step (docs/DESIGN.md, Updates)
 *
 * The hub starts `finish` outside its own service (systemd-run, or the
 * conclave-update.path unit setup.sh installs), after it wrote
 * <home>/updates/request.json. It swaps the release folder, restarts the
 * hub's service, waits for the new version and rolls back when it does not
 * answer (core/update/finish.ts). People update from Settings > About.
 */
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { conclaveHome } from '@conclave/core/config/paths.ts';
import {
  detectHubInstall,
  fetchManifest,
  finishUpdate,
  isCompiled,
  isNewer,
  manifestUrl,
  ownerOf,
  probeThisProcess,
  run,
  updateKey,
  waitForVersion,
  type UpdateRequest,
} from '@conclave/core/update/index.ts';
import { out as p } from '../ansi';
import { bool, type ParsedArgs } from '../args';
import { VERSION } from '../version';
import { CliError, print } from './shared';

export async function updateCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1];
  if (sub === 'finish') return finish();
  if (sub && sub !== 'status' && sub !== 'check') throw new CliError(`Unknown update command "${sub}". Try: conclave update`);
  return status(bool(args, 'json'));
}

async function status(json: boolean): Promise<number> {
  const install = detectHubInstall();
  const key = updateKey();
  let latest: string | undefined;
  let error: string | undefined;
  try {
    latest = (await fetchManifest(manifestUrl())).version;
  } catch (err) {
    error = (err as Error).message;
  }
  if (json) {
    print(JSON.stringify({ current: VERSION, latest: latest ?? null, available: !!latest && isNewer(latest, VERSION), install: install.kind, canUpdate: install.canUpdate, why: install.why ?? null, command: install.command ?? null, keyMissing: !key.ok, error: error ?? null }));
    return 0;
  }
  print(`${p.bold('Conclave')} ${VERSION}`);
  print(`  Newest     ${latest ?? p.dim(error ?? 'unknown')}${latest && isNewer(latest, VERSION) ? p.green('  (new)') : ''}`);
  print(`  Installed  ${install.kind}${install.dir ? p.dim(` in ${install.dir}`) : ''}`);
  if (install.canUpdate) print('  Update     from Settings, About in the web app (or turn on Install updates automatically there)');
  else {
    if (install.why) print(`  Update     ${install.why}`);
    if (install.command) print(`             ${p.bold(install.command)}`);
  }
  if (!key.ok) print(p.yellow(`  ${key.why}`));
  return 0;
}

/** The finisher (run by systemd, not by people). Exit 0 when the hub runs the new version. */
async function finish(): Promise<number> {
  if (!isCompiled(probeThisProcess().main)) throw new CliError('conclave update finish runs only from a release binary.');
  const home = conclaveHome();
  const updatesDir = join(home, 'updates');
  let install: string;
  try {
    install = dirname(realpathSync(process.execPath));
  } catch (err) {
    throw new CliError(`Cannot find this release folder: ${(err as Error).message}`);
  }
  const root = process.getuid?.() === 0;
  const state = await finishUpdate({
    updatesDir,
    install,
    current: VERSION,
    key: updateKey(),
    restart: async (req: UpdateRequest) => {
      const r = await run(['systemctl', ...(req.scope === 'user' ? ['--user'] : []), 'restart', req.unit], { timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || `systemctl exited ${r.code}`).trim().split('\n').slice(-2).join(' '));
    },
    health: (req, version) => waitForVersion(req.healthUrl, version, 90_000),
    log: (line) => print(`conclave update: ${line}`),
    // a root finisher (the path unit) leaves state.json to the hub's user
    ...(root ? { owner: ownerOf(updatesDir) } : {}),
  });
  if (!state) return 0;
  return state.phase === 'done' ? 0 : 1;
}
