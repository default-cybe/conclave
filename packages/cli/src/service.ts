/**
 * The daemon as a user service: a systemd user unit on Linux, a LaunchAgent on
 * macOS, a Run key on Windows. `conclave daemon install`, `uninstall` and
 * `status` use this. So does the desktop app: it runs its bundled copy of
 * conclave with those subcommands instead of writing the files itself.
 *
 * servicePlan() is pure, so the unit text and the commands can be tested (and
 * printed with --dry-run) without touching this machine.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { conclaveHome } from '@conclave/core/config/paths.ts';
import { processMatches } from '@conclave/server/remote/pids.ts';

export type ServiceKind = 'systemd' | 'launchd' | 'run-key';

export const UNIT_NAME = 'conclave-daemon';
export const LAUNCHD_LABEL = 'dev.conclave.daemon';
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'ConclaveDaemon';

export interface ServiceInput {
  os: NodeJS.Platform;
  /** The user's home folder. */
  home: string;
  /** argv that runs the daemon: the binary (or bun and the script), then `daemon` and its flags. */
  cmd: string[];
  /** PATH for the daemon, so the agent CLIs it starts (git, claude, codex) are found. */
  pathEnv: string;
  /** CONCLAVE_HOME to pass through when it is set. */
  conclaveHome?: string;
  logFile: string;
  uid?: number;
}

/** One command. `optional` failures are fine (stopping a service that is not loaded). */
export interface Step {
  /** As a person would type it, for --dry-run and errors. */
  show: string;
  argv: string[];
  optional?: boolean;
  /** Try again this many times, half a second apart (launchctl bootstrap right after bootout). */
  retries?: number;
  /** Start it in the background and do not wait (Windows, where there is no service manager). */
  detached?: boolean;
}

export interface ServicePlan {
  kind: ServiceKind;
  /** The unit or plist it writes. None for the Run key. */
  file?: string;
  content?: string;
  /** Registers it without a file (the Run key). */
  register: Step[];
  /** Turn it on now, or restart it so a new binary or unit is used. */
  start: Step[];
  /** Stop it and turn it off, before the file goes. */
  stop: Step[];
  /** After the file is gone. */
  cleanup: Step[];
  /** Is it running? exit 0 means yes (systemd, launchd). */
  probe?: Step;
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** systemd treats % as a specifier; %% is a literal one. */
function systemdEscape(s: string): string {
  return s.replace(/%/g, '%%');
}

/** One ExecStart word: quoted when it holds spaces, quotes or backslashes. */
export function systemdQuote(s: string): string {
  const e = systemdEscape(s);
  return /[\s"'\\]/.test(e) ? `"${e.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : e;
}

/** Environment=NAME=value, quoted as a whole when needed. */
function systemdEnv(name: string, value: string): string {
  return `Environment=${systemdQuote(`${name}=${value}`)}`;
}

/** One word of a Windows command line (CommandLineToArgvW rules). */
export function windowsQuote(s: string): string {
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function step(argv: string[], extra: Partial<Step> = {}): Step {
  return { show: argv.map(shellWord).join(' '), argv, ...extra };
}

// ---------------------------------------------------------------------------
// The plan per OS
// ---------------------------------------------------------------------------

export function servicePlan(input: ServiceInput): ServicePlan {
  const { os, home, cmd, pathEnv, conclaveHome: ch, logFile } = input;
  if (os === 'linux') {
    const file = join(home, '.config', 'systemd', 'user', `${UNIT_NAME}.service`);
    const content = [
      '[Unit]',
      'Description=Conclave device daemon',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      `ExecStart=${cmd.map(systemdQuote).join(' ')}`,
      'Restart=always',
      'RestartSec=5',
      systemdEnv('PATH', pathEnv),
      ...(ch ? [systemdEnv('CONCLAVE_HOME', ch)] : []),
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    const ctl = (...a: string[]) => ['systemctl', '--user', ...a];
    return {
      kind: 'systemd',
      file,
      content,
      register: [],
      start: [step(ctl('daemon-reload')), step(ctl('enable', UNIT_NAME)), step(ctl('restart', UNIT_NAME))],
      stop: [step(ctl('disable', '--now', UNIT_NAME), { optional: true })],
      cleanup: [step(ctl('daemon-reload'), { optional: true }), step(ctl('reset-failed', UNIT_NAME), { optional: true })],
      probe: step(ctl('is-active', '--quiet', UNIT_NAME)),
    };
  }
  if (os === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const env = [`    <key>PATH</key><string>${xmlEscape(pathEnv)}</string>`, ...(ch ? [`    <key>CONCLAVE_HOME</key><string>${xmlEscape(ch)}</string>`] : [])];
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${cmd.map((c) => `    <string>${xmlEscape(c)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
    const domain = `gui/${input.uid ?? 501}`;
    const bootout = step(['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`], { optional: true });
    return {
      kind: 'launchd',
      file,
      content,
      register: [],
      // bootout first so a changed plist or binary is loaded again
      start: [bootout, step(['launchctl', 'bootstrap', domain, file], { retries: 4 })],
      stop: [bootout],
      cleanup: [],
      probe: step(['launchctl', 'print', `${domain}/${LAUNCHD_LABEL}`]),
    };
  }
  if (os === 'win32') {
    const value = cmd.map(windowsQuote).join(' ');
    return {
      kind: 'run-key',
      content: value,
      register: [step(['reg', 'add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f'])],
      start: [{ show: value, argv: cmd, detached: true }],
      stop: [step(['reg', 'delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { optional: true })],
      cleanup: [],
    };
  }
  throw new Error(`Automatic install is not supported on ${os}. Run this at login: ${cmd.join(' ')}`);
}

// ---------------------------------------------------------------------------
// PATH: keep the user's own, so git, claude and codex are found
// ---------------------------------------------------------------------------

const MARK = '__CONCLAVE_PATH__';

/** The PATH between the markers the login shell printed (rc files may print other lines). */
export function parseMarkedPath(output: string): string | undefined {
  const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(output);
  const v = m?.[1]?.trim();
  return v ? v : undefined;
}

/**
 * PATH from the user's login shell. An app started from the Dock or a desktop
 * menu gets a short PATH without Homebrew, nvm or ~/.local/bin; a terminal has
 * the full one. undefined when the shell does not answer in time.
 */
export function loginShellPath(shell = process.env.SHELL, timeoutMs = 5000): string | undefined {
  const sh = shell || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  // fish and the POSIX shells all take -l -i -c; printf keeps the value whole
  const script = `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`;
  try {
    const r = spawnSync(sh, ['-l', '-i', '-c', script], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseMarkedPath(r.stdout ?? '');
  } catch {
    return undefined;
  }
}

/** Folders where agent CLIs usually live, for when the login shell says nothing. */
export function commonBinDirs(home: string, os: NodeJS.Platform): string[] {
  const user = ['.local/bin', '.bun/bin', '.cargo/bin', '.npm-global/bin', '.volta/bin', 'go/bin'].map((d) => join(home, d));
  const system = os === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'] : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin'];
  return [...user, ...system];
}

/** Join PATH lists in order without duplicates; `extra` folders only when they exist. */
export function mergePath(lists: Array<string | undefined>, extra: string[] = [], exists: (dir: string) => boolean = existsSync, sep = delimiter): string {
  const out: string[] = [];
  const add = (d: string) => {
    const dir = d.trim();
    if (dir && !out.includes(dir)) out.push(dir);
  };
  for (const list of lists) for (const d of (list ?? '').split(sep)) add(d);
  for (const d of extra) if (!out.includes(d) && exists(d)) add(d);
  return out.join(sep);
}

/** The daemon's PATH. `login`: the login shell's PATH first, then this one, then common folders. */
export function daemonPath(opts: { login: boolean; os?: NodeJS.Platform; home: string; env?: Record<string, string | undefined> }): string {
  const os = opts.os ?? process.platform;
  const env = opts.env ?? process.env;
  const current = env.PATH ?? env.Path ?? '';
  if (os === 'win32') return current;
  if (!opts.login) return current || '/usr/local/bin:/usr/bin:/bin';
  return mergePath([loginShellPath(env.SHELL), withoutAppImage(current, env)], commonBinDirs(opts.home, os));
}

/** An AppImage puts its own mount (gone once the app quits) on the PATH it passes down; the service does not need it. */
export function withoutAppImage(path: string, env: Record<string, string | undefined> = process.env, sep = delimiter): string {
  const appDir = env.APPDIR;
  return path
    .split(sep)
    .filter((d) => !(appDir && d.startsWith(appDir)) && !/\/\.mount_[^/]*\//.test(`${d}/`))
    .join(sep);
}

// ---------------------------------------------------------------------------
// Running the steps, and asking whether it runs
// ---------------------------------------------------------------------------

export interface StepResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runStep(s: Step, timeoutMs = 20_000): StepResult {
  const r = spawnSync(s.argv[0], s.argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stderr = (r.stderr ?? '') + (r.error ? String(r.error.message) : '');
  return { ok: r.status === 0 && !r.error, status: r.status, stdout: r.stdout ?? '', stderr };
}

/** Run each step; a failed step that is not optional throws with what it said. */
export function runSteps(steps: Step[], run: (s: Step) => StepResult = runStep, spawnDetached?: (s: Step) => void): void {
  for (const s of steps) {
    if (s.detached) {
      spawnDetached?.(s);
      continue;
    }
    let r = run(s);
    for (let i = 0; !r.ok && i < (s.retries ?? 0); i++) {
      Bun.sleepSync(500);
      r = run(s);
    }
    if (!r.ok && !s.optional) {
      const said = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ');
      throw new Error(`\`${s.show}\` failed${said ? `: ${said}` : r.status !== null ? ` (exit ${r.status})` : ''}`);
    }
  }
}

/** Is the service registered? systemd and launchd: the file is there. Windows: the Run key value. */
export function serviceInstalled(plan: ServicePlan, run: (s: Step) => StepResult = runStep): boolean {
  if (plan.file) return existsSync(plan.file);
  return run(step(['reg', 'query', RUN_KEY, '/v', RUN_VALUE])).ok;
}

/** What the registered service runs, as one line (ExecStart, ProgramArguments, the Run key value). */
export function serviceCommand(plan: ServicePlan, run: (s: Step) => StepResult = runStep): string | undefined {
  try {
    if (plan.kind === 'systemd' && plan.file) return /^ExecStart=(.*)$/m.exec(readFileSync(plan.file, 'utf8'))?.[1];
    if (plan.kind === 'launchd' && plan.file) {
      const xml = readFileSync(plan.file, 'utf8');
      const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? '';
      return [...args.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join(' ');
    }
    if (plan.kind === 'run-key') {
      const out = run(step(['reg', 'query', RUN_KEY, '/v', RUN_VALUE])).stdout;
      return /REG_SZ\s+(.*)$/m.exec(out)?.[1]?.trim();
    }
  } catch {
    /* no file */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The pid file (Windows has no service manager to ask)
// ---------------------------------------------------------------------------

export function pidFile(home = conclaveHome()): string {
  return join(home, 'daemon.pid');
}

export function readPid(home?: string): number | undefined {
  try {
    const pid = Number((JSON.parse(readFileSync(pidFile(home), 'utf8')) as { pid?: unknown }).pid);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Only a conclave daemon may be stopped by its pid: a daemon that was killed leaves its pid file, and pids get reused. */
function isConclave(pid: number): boolean {
  if (process.platform !== 'win32') return processMatches(pid, (cmd) => /conclave/i.test(cmd) && /daemon/i.test(cmd));
  const r = runStep(step(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']));
  return /conclave/i.test(r.stdout);
}

/** Stop the daemon the pid file names. Returns true when one was running. */
export function stopByPid(home?: string): boolean {
  const pid = readPid(home);
  if (!pid || pid === process.pid || !pidAlive(pid) || !isConclave(pid)) return false;
  try {
    process.kill(pid);
  } catch {
    return false;
  }
  for (let i = 0; i < 20 && pidAlive(pid); i++) Bun.sleepSync(100);
  rmSync(pidFile(home), { force: true });
  return true;
}
