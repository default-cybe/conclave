/**
 * `conclave daemon`: serve this machine's files and shells to a hub.
 *
 *   conclave daemon                 run it here, in the foreground
 *   conclave daemon pair URL CODE   register this machine with a device code
 *   conclave daemon install         a user service that runs it at login (--start: and now)
 *   conclave daemon uninstall       stop and remove that service
 *   conclave daemon status          paired? installed? running? (--json for the desktop app)
 *   conclave daemon unpair          remove this machine from the hub and forget the pairing
 *
 * The desktop app runs its bundled copy of this binary with these
 * subcommands, so the service files are written in one place.
 */
import { hostname, homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError } from '@conclave/core/client/index.ts';
import { err as e, out as p } from '../ansi';
import { bool, str, type ParsedArgs } from '../args';
import { cliPaths, normalizeHubUrl, readDeviceFile, writePrivateJson, type DeviceFile } from '../files';
import { selfCommand } from '../hub';
import { VERSION } from '../version';
import {
  daemonPath,
  pidAlive,
  pidFile,
  readPid,
  runStep,
  runSteps,
  serviceCommand,
  serviceInstalled,
  servicePlan,
  stopByPid,
  type ServicePlan,
  type Step,
} from '../service';
import { CliError, print, requireArg } from './shared';

const SUBCOMMANDS = ['pair', 'install', 'uninstall', 'status', 'unpair', 'run'];

export async function daemonCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1];
  if (sub === 'pair') return daemonPair(args);
  if (sub === 'install') return daemonInstall(args);
  if (sub === 'uninstall') return daemonUninstall(args);
  if (sub === 'status') return daemonStatus(args);
  if (sub === 'unpair') return daemonUnpair(args);
  if (sub && sub !== 'run') throw new CliError(`Unknown daemon command "${sub}". Try: conclave daemon [${SUBCOMMANDS.join('|')}]`);
  return daemonRun(args);
}

async function hubJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* not json */
  }
  if (!res.ok) throw new ApiError(res.status, (data.error as string) ?? res.statusText, data);
  return data;
}

/** Trade a device code for this machine's device token and save it. */
export async function registerWithCode(hub: string, code: string, name: string): Promise<DeviceFile> {
  const data = await hubJson(
    await fetch(`${hub}/api/daemon/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), name, platform: platform() }),
      signal: AbortSignal.timeout(20_000),
    }),
  );
  const deviceId = (data.deviceId ?? data.id) as string | undefined;
  const token = data.token as string | undefined;
  if (!deviceId || !token) throw new CliError('Hub reply is missing deviceId or token.');
  const addresses = Array.isArray(data.addresses) ? (data.addresses as unknown[]).filter((u): u is string => typeof u === 'string') : undefined;
  const file: DeviceFile = { hub, deviceId, token, name, savedAt: Date.now(), ...(addresses?.length ? { addresses } : {}) };
  writePrivateJson(cliPaths().device, file);
  return file;
}

export interface AppPairing {
  hub: string;
  deviceId: string;
  name: string;
  /** Already paired with this hub, and the hub still lists it: nothing changed. */
  kept: boolean;
}

/**
 * Pair with the token of an app that is already paired (the desktop app), so
 * the owner types no second code. Kept when this machine is already a device
 * of that hub; a pairing with another hub (or one the hub removed) goes first.
 */
export async function pairWithAppToken(hubUrl: string, appToken: string, name = hostname()): Promise<AppPairing> {
  const hub = normalizeHubUrl(hubUrl);
  const auth = { authorization: `Bearer ${appToken}` };
  const devices = (await hubJson(await fetch(`${hub}/api/devices`, { headers: auth, signal: AbortSignal.timeout(15_000) })).catch((err) => {
    if (err instanceof ApiError && err.status === 401) throw new CliError('The hub did not accept the app token. Connect the app to the hub again.');
    throw err;
  })) as unknown as Array<{ id: string }>;
  const now = readDeviceFile();
  if (now && Array.isArray(devices) && devices.some((d) => d.id === now.deviceId)) {
    // the same device on the same hub (by id: an address may differ). Follow the address the app uses.
    if (normalizeHubUrl(now.hub) !== hub) writePrivateJson(cliPaths().device, { ...now, hub });
    return { hub, deviceId: now.deviceId, name: now.name, kept: true };
  }
  if (now) await unpairHere();
  const res = await fetch(`${hub}/api/daemon/pairing`, { method: 'POST', headers: auth, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw new CliError('This hub is too old to pair the app daemon. Update the hub first.');
  const { code } = (await hubJson(res)) as { code?: string };
  if (!code) throw new CliError('Hub reply is missing the device code.');
  const file = await registerWithCode(hub, code, name);
  return { hub, deviceId: file.deviceId, name: file.name, kept: false };
}

/** One line from stdin (a token piped in by the desktop app, never on the command line). */
export async function readStdinLine(): Promise<string> {
  const text = await new Response(Bun.stdin.stream()).text();
  return text.split(/\r?\n/)[0]?.trim() ?? '';
}

async function daemonPair(args: ParsedArgs): Promise<number> {
  const usage = 'conclave daemon pair <hubUrl> <code>   or   conclave daemon pair <hubUrl> --app-token-stdin';
  const hub = normalizeHubUrl(requireArg(args._[2] ?? str(args, 'hub'), usage));
  const name = str(args, 'name') ?? hostname();
  if (bool(args, 'app-token-stdin')) {
    const token = await readStdinLine();
    if (!token) throw new CliError('No app token on stdin.', 2);
    const r = await pairWithAppToken(hub, token, name);
    if (bool(args, 'json')) print(JSON.stringify({ paired: true, ...r }));
    else print(`${p.green('✓')} ${r.kept ? 'Already paired' : 'Paired'} ${p.bold(r.name)} as device ${p.bold(r.deviceId)} with ${r.hub}`);
    return 0;
  }
  const code = requireArg(args._[3] ?? str(args, 'code'), usage);
  const file = await registerWithCode(hub, code, name);
  if (bool(args, 'json')) {
    print(JSON.stringify({ paired: true, hub, deviceId: file.deviceId, name, kept: false }));
    return 0;
  }
  print(`${p.green('✓')} Paired ${p.bold(name)} as device ${p.bold(file.deviceId)} with ${hub}`);
  print(p.dim(`  Saved ${cliPaths().device}`));
  print(`  Start it now: ${p.bold('conclave daemon')}   or at login: ${p.bold('conclave daemon install --start')}`);
  return 0;
}

const ANSI = /\x1b\[[0-9;]*m/g;

async function daemonRun(args: ParsedArgs): Promise<number> {
  const creds = readDeviceFile();
  if (!creds) throw new CliError('This machine is not paired. Run `conclave daemon pair <hubUrl> <code>` first.');
  const hubUrl = normalizeHubUrl(str(args, 'hub') ?? creds.hub);
  const name = str(args, 'name') ?? creds.name ?? hostname();
  // --log FILE: where the status lines go when nobody sees stdout (the Windows Run key)
  const logFile = str(args, 'log');
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });
  // the hub's logs export asks for these lines (the logTail RPC, core/src/logs/ring.ts)
  const { processLog, daemonLogTail } = await import('@conclave/core/logs/ring.ts');
  const { setLogTap } = await import('@conclave/core/util/log.ts');
  setLogTap(processLog.tap('info'));
  const say = (line: string) => {
    processLog.push(`${new Date().toISOString()} ${line}`);
    if (!logFile) return print(line);
    try {
      appendFileSync(logFile, `${new Date().toISOString().slice(0, 10)} ${line.replace(ANSI, '')}\n`);
    } catch {
      /* a full disk must not stop the daemon */
    }
  };
  const { runDaemon, isLoopbackUrl } = await import('@conclave/core/machine/daemon.ts');
  const { LocalMachine } = await import('@conclave/core/machine/local.ts');
  const machine = new LocalMachine({ id: creds.deviceId, name });
  // the hello says which daemon this is and how it updates (protocol 4, daemon-update.ts)
  const { daemonSelf, selfUpdate } = await import('../daemon-update');
  const self = daemonSelf();
  if (self.lastUpdate && Date.now() - self.lastUpdate.at < 60_000) say(`update ${self.lastUpdate.from} -> ${self.lastUpdate.to}: ${self.lastUpdate.ok ? 'done' : (self.lastUpdate.message ?? 'failed')}`);
  const baseInfo = machine.info.bind(machine);
  machine.info = async () => ({ ...(await baseInfo()), daemon: self });
  const stamp = () => new Date().toISOString().slice(11, 19);
  say(`${p.bold(p.fg('#C792EA')(`◆ ${commandName}`))} ${VERSION} ${name} ${p.dim(`(${creds.deviceId})`)} -> ${hubUrl}`);
  // the pid file lets `status` and `uninstall` find this process where no service manager tracks it
  const pids = pidFile();
  try {
    writeFileSync(pids, JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: VERSION }) + '\n');
  } catch {
    /* best effort */
  }
  const handle = runDaemon({
    hubUrl,
    // the hub's other addresses (a quick tunnel, the same network), so a changed tunnel address is not the end
    fallbackUrls: str(args, 'hub') ? [] : (creds.addresses ?? []),
    deviceId: creds.deviceId,
    token: creds.token,
    machine,
    name,
    logTail: (lines) => daemonLogTail({ lines, impl: 'ts', version: VERSION, file: cliPaths().daemonLog }),
    // the new folder is in place: exit, and the service (Restart=always, KeepAlive) starts the new binary
    selfUpdate: (params) => selfUpdate(params, { log: say, restart: () => { stop(); setTimeout(() => process.exit(0), 300); } }),
    onAddresses: (urls) => {
      if (str(args, 'hub')) return;
      const now = readDeviceFile();
      if (!now || now.deviceId !== creds.deviceId || JSON.stringify(now.addresses) === JSON.stringify(urls)) return;
      // a daemon on the hub machine keeps its loopback address; others start next time where the hub said
      writePrivateJson(cliPaths().device, { ...now, hub: isLoopbackUrl(now.hub) ? now.hub : urls[0], addresses: urls });
    },
    onStatus: (s) => {
      const detail = s.detail ? ` ${s.detail}` : '';
      const retry = s.retryInMs ? ` (retry in ${Math.round(s.retryInMs / 1000)}s)` : '';
      const where = s.state === 'connecting' || s.state === 'online' ? (s.url ? p.dim(` ${s.url}`) : '') : '';
      const dot = s.state === 'online' ? p.green('●') : s.state === 'connecting' ? p.yellow('●') : p.red('●');
      say(`${p.dim(stamp())} ${dot} ${s.state}${where}${detail}${retry}`);
    },
  });
  const stop = () => {
    if (!logFile) process.stderr.write(e.dim('\nstopping daemon...\n'));
    handle.stop();
    try {
      LocalMachine.killAll();
    } catch {
      /* ignore */
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await handle.closed;
  if (readPid() === process.pid) rmSync(pids, { force: true });
  return 0;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * What the service runs after the binary: `daemon` for the conclave CLI,
 * `run` for the conclave-daemon binary the desktop app carries (daemon-main.ts).
 */
let serviceRunArgs = ['daemon'];
let commandName = 'conclave daemon';

export function useDaemonEntry(runArgs: string[], name: string): void {
  serviceRunArgs = runArgs;
  commandName = name;
}

export interface ServiceOptions {
  /** Pass --hub to the daemon (pins one address). */
  hub?: string;
  /** Take the login shell's PATH: an app started from a menu has a short one. */
  loginPath?: boolean;
}

/** The service for this machine: what it runs, with which PATH. */
export function planFor(opts: ServiceOptions = {}): ServicePlan {
  const os = platform();
  const logFile = cliPaths().daemonLog;
  const cmd = [...selfCommand(), ...serviceRunArgs, ...(opts.hub ? ['--hub', opts.hub] : []), ...(os === 'win32' ? ['--log', logFile] : [])];
  try {
    return servicePlan({
      os,
      home: homedir(),
      cmd,
      pathEnv: daemonPath({ login: !!opts.loginPath, os, home: homedir() }),
      conclaveHome: process.env.CONCLAVE_HOME,
      logFile,
      uid: process.getuid?.(),
    });
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

const optionsOf = (args: ParsedArgs): ServiceOptions => ({ hub: str(args, 'hub'), loginPath: bool(args, 'login-path') });

function showSteps(title: string, steps: Step[]): void {
  if (!steps.length) return;
  print(title);
  for (const s of steps) print(`  ${s.show}${s.optional ? p.dim('   (may fail when it is not loaded)') : ''}`);
}

/** Start the daemon in the background where no service manager does it (Windows). */
function spawnDetached(s: Step): void {
  stopByPid();
  const child = spawn(s.argv[0], s.argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

export function printInstallDryRun(plan: ServicePlan, start: boolean, name = commandName): void {
  print(p.dim(`# ${name} install --dry-run: nothing is written or started`));
  if (plan.file) print(`${p.bold('Would write')} ${plan.file}`);
  if (plan.content) print(plan.content.replace(/\n$/, ''));
  showSteps(p.bold('Would run'), [...plan.register, ...(start ? plan.start : [])]);
}

export function printUninstallDryRun(plan: ServicePlan, name = commandName): void {
  print(p.dim(`# ${name} uninstall --dry-run: nothing is stopped or removed`));
  showSteps(p.bold('Would run'), plan.stop);
  if (plan.file) print(`${p.bold('Would remove')} ${plan.file}`);
  showSteps(p.bold('Then'), plan.cleanup);
}

/** Write (or register) the service. With `start`, also start it now, or restart it on a new binary. */
export function installService(plan: ServicePlan, start: boolean): void {
  mkdirSync(cliPaths().logs, { recursive: true });
  if (plan.file && plan.content) {
    mkdirSync(dirname(plan.file), { recursive: true });
    writeFileSync(plan.file, plan.content);
    print(`${p.green('✓')} Wrote ${plan.file}`);
  }
  try {
    runSteps(plan.register);
    if (plan.kind === 'run-key') print(`${p.green('✓')} It starts when you sign in to Windows.`);
    if (start) {
      if (!readDeviceFile()) throw new CliError('Not paired, so it cannot start. Pair this machine first.');
      runSteps(plan.start, runStep, spawnDetached);
      print(`${p.green('✓')} Started. It runs at login from now on.`);
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError((err as Error).message);
  }
}

/** Stop the service and remove it. `installed`: there was one. `stopped`: a daemon was running. */
export function uninstallService(plan: ServicePlan): { installed: boolean; stopped: boolean } {
  const installed = serviceInstalled(plan);
  try {
    runSteps(plan.stop);
    if (plan.file) rmSync(plan.file, { force: true });
    runSteps(plan.cleanup);
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  // a daemon started by hand or by the Run key is not stopped by a service manager
  const stopped = stopByPid();
  return { installed, stopped };
}

async function daemonInstall(args: ParsedArgs): Promise<number> {
  const plan = planFor(optionsOf(args));
  const start = bool(args, 'start');
  if (bool(args, 'dry-run')) {
    printInstallDryRun(plan, start);
    return 0;
  }
  if (!readDeviceFile()) print(p.yellow('Note: not paired yet. Run `conclave daemon pair <hubUrl> <code>` before starting the service.'));
  installService(plan, start);
  if (start) {
    // a user service stops when its user logs out, which on a server is right after setup
    if (plan.kind === 'systemd') print(p.dim('  Keep it running after logout: loginctl enable-linger $USER'));
    return 0;
  }
  if (plan.kind === 'systemd') {
    print('Enable and start it:');
    print(p.bold('  systemctl --user daemon-reload && systemctl --user enable --now conclave-daemon'));
    print(p.dim('  Keep it running after logout: loginctl enable-linger $USER'));
    print(p.dim('  Logs: journalctl --user -u conclave-daemon -f'));
  } else if (plan.kind === 'launchd') {
    print('Load it:');
    print(p.bold(`  launchctl bootstrap gui/$(id -u) ${plan.file}`));
    print(p.dim(`  Stop: launchctl bootout gui/$(id -u)/dev.conclave.daemon   Logs: ${cliPaths().daemonLog}`));
  } else {
    print(`Start it now: ${p.bold('conclave daemon install --start')}   Logs: ${cliPaths().daemonLog}`);
  }
  return 0;
}

async function daemonUninstall(args: ParsedArgs): Promise<number> {
  const plan = planFor(optionsOf(args));
  if (bool(args, 'dry-run')) {
    printUninstallDryRun(plan);
    return 0;
  }
  const { installed, stopped } = uninstallService(plan);
  if (installed) print(`${p.green('✓')} Stopped and removed the daemon service${plan.file ? ` (${plan.file})` : ''}.`);
  else print(stopped ? `${p.green('✓')} Stopped the daemon. No service was installed.` : 'No daemon service was installed.');
  if (readDeviceFile()) print(p.dim('  This machine is still paired. `conclave daemon unpair` removes it from the hub.'));
  return 0;
}

export interface DaemonStatusJson {
  version: string;
  /** The binary that answered. */
  binary: string;
  paired: boolean;
  hub?: string;
  deviceId?: string;
  name?: string;
  service: {
    kind: ServicePlan['kind'];
    file?: string;
    installed: boolean;
    /** null when it cannot be told (no systemctl here). */
    running: boolean | null;
    /** What the installed service runs. */
    runs?: string;
  };
}

export function statusJson(plan: ServicePlan, creds = readDeviceFile()): DaemonStatusJson {
  const installed = serviceInstalled(plan);
  // a daemon started by hand (or by the Run key) counts too: its pid file says so
  let running: boolean | null = pidAlive(readPid());
  if (plan.probe && !running) {
    const r = runStep(plan.probe, 5000);
    // systemctl is-active: 0 active, 3 inactive; a missing systemctl or launchctl gives no status
    running = r.ok ? true : r.status === null ? null : false;
    if (plan.kind === 'launchd' && r.ok) running = /state = running/.test(r.stdout);
  }
  return {
    version: VERSION,
    binary: selfCommand().join(' '),
    paired: !!creds,
    ...(creds ? { hub: creds.hub, deviceId: creds.deviceId, name: creds.name } : {}),
    service: { kind: plan.kind, ...(plan.file ? { file: plan.file } : {}), installed, running, ...(installed ? { runs: serviceCommand(plan) } : {}) },
  };
}

async function daemonStatus(args: ParsedArgs): Promise<number> {
  const s = statusJson(planFor(optionsOf(args)));
  if (bool(args, 'json')) {
    print(JSON.stringify(s));
    return 0;
  }
  print(`${p.bold('conclave daemon')} ${s.version}`);
  print(s.paired ? `  Paired      ${s.name} (${s.deviceId}) with ${s.hub}` : '  Paired      no. Run `conclave daemon pair <hubUrl> <code>`.');
  print(`  Service     ${s.service.installed ? `installed (${s.service.file ?? 'Run key'})` : 'not installed. Run `conclave daemon install --start`.'}`);
  if (s.service.runs) print(`  Runs        ${s.service.runs}`);
  print(`  Running     ${s.service.running === null ? 'cannot tell here' : s.service.running ? 'yes' : 'no'}`);
  return 0;
}

/** What /api/daemon/unpair says for a device it does not know (packages/server/src/routes-daemon.ts). */
const NOT_PAIRED = 'This device is not paired with this hub.';

export interface Unpaired {
  /** It was paired before this call. */
  wasPaired: boolean;
  /** The hub removed it, or no longer knew it. */
  removedOnHub: boolean;
  hub?: string;
  deviceId?: string;
  name?: string;
  error?: string;
}

/** The hub forgets this machine (its own device token proves who asks), then the local pairing goes. */
export async function unpairHere(): Promise<Unpaired> {
  const creds = readDeviceFile();
  if (!creds) return { wasPaired: false, removedOnHub: false };
  let removedOnHub = false;
  let error: string | undefined;
  for (const hub of [creds.hub, ...(creds.addresses ?? [])].map(normalizeHubUrl).filter((u, i, all) => all.indexOf(u) === i)) {
    try {
      const res = await fetch(`${hub}/api/daemon/unpair`, {
        method: 'POST',
        headers: { authorization: `Bearer ${creds.token}`, 'x-conclave-device': creds.deviceId },
        signal: AbortSignal.timeout(8000),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // the hub no longer knows this device (removed on the Devices page): the same outcome.
      // An older hub without this route says only "unauthorized".
      removedOnHub = res.ok || (res.status === 401 && body.error === NOT_PAIRED);
      error = removedOnHub ? undefined : res.status === 401 ? 'This hub is too old to remove a device by itself.' : `The hub answered HTTP ${res.status}${body.error ? `: ${body.error}` : '.'}`;
      break;
    } catch (err) {
      error = `Cannot reach ${hub}: ${(err as Error).message}`;
    }
  }
  rmSync(cliPaths().device, { force: true });
  return { wasPaired: true, removedOnHub, hub: creds.hub, deviceId: creds.deviceId, name: creds.name, ...(error ? { error } : {}) };
}

/** "Forgot the pairing ..." and what the hub did, for people. */
export function printUnpaired(u: Unpaired): void {
  if (!u.wasPaired) return print('This machine is not paired.');
  print(`${p.green('✓')} Forgot the pairing with ${u.hub}.`);
  if (u.removedOnHub) print(`  The hub removed ${u.name}.`);
  else print(p.yellow(`  ${u.error ?? 'The hub did not answer.'} Remove ${u.name} on the hub's Devices page.`));
}

async function daemonUnpair(args: ParsedArgs): Promise<number> {
  const u = await unpairHere();
  if (bool(args, 'json')) {
    const { wasPaired, ...rest } = u;
    print(JSON.stringify(wasPaired ? { paired: false, ...rest } : { paired: false }));
  } else printUnpaired(u);
  return 0;
}
