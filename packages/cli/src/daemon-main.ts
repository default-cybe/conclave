#!/usr/bin/env bun
/**
 * conclave-daemon: the daemon alone, as the desktop app carries it (Tauri
 * sidecar). The contract (subcommands, flags, JSON, exit codes, files) is
 * docs/design/DAEMON-SIDECAR.md; a Rust build of the daemon follows the same
 * file, so the app can swap the binary without other changes.
 *
 * For now it maps onto the `conclave daemon` commands in commands/daemon.ts.
 * Built by scripts/build-sidecar.ts with `bun build --compile`.
 */
import { hostname } from 'node:os';
import { err as e } from './ansi';
import { bool, parseArgs, str, type ParsedArgs } from './args';
import { CliError, describeError, print } from './commands/shared';
import {
  daemonCommand,
  installService,
  planFor,
  printInstallDryRun,
  printUninstallDryRun,
  pairWithAppToken,
  readStdinLine,
  registerWithCode,
  statusJson,
  uninstallService,
  unpairHere,
  useDaemonEntry,
} from './commands/daemon';
import { normalizeHubUrl } from './files';
import { VERSION } from './version';

export const USAGE = `conclave-daemon ${VERSION}: lets a Conclave hub use this computer's files, shells and coding tools.

Usage
  conclave-daemon [run] [--hub URL] [--log FILE]       run the daemon (what the service runs)
  conclave-daemon pair --hub URL --app-token-stdin     pair with the token of the app that is paired already
  conclave-daemon pair --hub URL --code CODE           pair with a device code from the Devices page
  conclave-daemon install [--dry-run]                  a user service that runs it at login, started now
  conclave-daemon uninstall [--keep-pairing] [--json]  stop and remove the service, and unpair
  conclave-daemon status --json                        paired, installed, running
  conclave-daemon --version

Contract: docs/design/DAEMON-SIDECAR.md`;

/** Usage errors exit 2, so the app can tell them from a failure. */
const usage = (message: string) => new CliError(`${message} Run conclave-daemon --help.`, 2);

export interface SidecarStatus {
  version: string;
  paired: boolean;
  hub: string | null;
  deviceId: string | null;
  name: string | null;
  installed: boolean;
  /** null when this machine cannot tell (no systemctl). */
  running: boolean | null;
}

export function sidecarStatus(): SidecarStatus {
  const s = statusJson(planFor({ loginPath: false }));
  return {
    version: s.version,
    paired: s.paired,
    hub: s.hub ?? null,
    deviceId: s.deviceId ?? null,
    name: s.name ?? null,
    installed: s.service.installed,
    running: s.service.running,
  };
}

async function pair(args: ParsedArgs): Promise<number> {
  const hubArg = str(args, 'hub');
  if (!hubArg) throw usage('pair needs --hub URL.');
  const hub = normalizeHubUrl(hubArg);
  const name = str(args, 'name') ?? hostname();
  let r: { hub: string; deviceId: string; name: string; kept: boolean };
  if (bool(args, 'app-token-stdin')) {
    const token = await readStdinLine();
    if (!token) throw usage('No app token on stdin.');
    r = await pairWithAppToken(hub, token, name);
  } else if (str(args, 'code')) {
    const file = await registerWithCode(hub, str(args, 'code')!, name);
    r = { hub, deviceId: file.deviceId, name: file.name, kept: false };
  } else throw usage('pair needs --app-token-stdin or --code CODE.');
  print(bool(args, 'json') ? JSON.stringify({ paired: true, ...r }) : `${r.kept ? 'Already paired' : 'Paired'} ${r.name} as device ${r.deviceId} with ${r.hub}`);
  return 0;
}

async function uninstall(args: ParsedArgs): Promise<number> {
  const plan = planFor({ loginPath: false });
  if (bool(args, 'dry-run')) {
    printUninstallDryRun(plan, 'conclave-daemon');
    return 0;
  }
  const { installed } = uninstallService(plan);
  const keep = bool(args, 'keep-pairing');
  const u = keep ? undefined : await unpairHere();
  if (bool(args, 'json')) {
    print(
      JSON.stringify({
        removed: installed,
        unpaired: !!u?.wasPaired,
        removedOnHub: !!u?.removedOnHub,
        name: u?.name ?? null,
        deviceId: u?.deviceId ?? null,
        error: u?.wasPaired && !u.removedOnHub ? (u.error ?? 'The hub did not answer.') : null,
      }),
    );
    return 0;
  }
  print(installed ? 'Stopped and removed the service.' : 'No service was installed.');
  if (u?.wasPaired) print(u.removedOnHub ? `The hub removed ${u.name}.` : `${u.error ?? 'The hub did not answer.'} Remove ${u.name} on the hub's Devices page.`);
  return 0;
}

export async function daemonMain(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const sub = args._[0] ?? 'run';
  if (bool(args, 'version') || sub === 'version') {
    print(VERSION);
    return 0;
  }
  if (bool(args, 'help') || sub === 'help') {
    print(USAGE);
    return 0;
  }
  // the service runs `conclave-daemon run`, not `conclave daemon`
  useDaemonEntry(['run'], 'conclave-daemon');
  switch (sub) {
    case 'run':
      return daemonCommand({ ...args, _: ['daemon', 'run'] });
    case 'pair':
      return pair(args);
    case 'install': {
      // started from a menu, the app has a short PATH: the service gets the login shell's
      const plan = planFor({ loginPath: true });
      if (bool(args, 'dry-run')) {
        printInstallDryRun(plan, true, 'conclave-daemon');
        return 0;
      }
      installService(plan, true);
      return 0;
    }
    case 'uninstall':
      return uninstall(args);
    case 'status':
      print(bool(args, 'json') ? JSON.stringify(sidecarStatus()) : Object.entries(sidecarStatus()).map(([k, v]) => `${k.padEnd(9)} ${v}`).join('\n'));
      return 0;
    default:
      throw usage(`Unknown command "${sub}".`);
  }
}

/** Run the daemon CLI and exit with its code. daemon-bin.ts calls it in the compiled binary. */
export function runDaemonCli(argv: string[]): void {
  daemonMain(argv)
    .then(async (code) => {
      await new Promise<void>((res) => process.stdout.write('', () => res()));
      process.exit(code);
    })
    .catch(async (error) => {
      const code = error instanceof CliError ? error.code : 1;
      // one line the app shows as it is: "Error: <sentence>"
      process.stderr.write(e.red('Error: ') + describeError(error) + '\n');
      process.exit(code);
    });
}

if (import.meta.main) runDaemonCli(process.argv.slice(2));

