/** `conclave serve`: run the hub in this process (or detached). */
import type { EngineApi } from '@conclave/core/engine/api.ts';
import { ConclaveClient, formatFingerprint } from '@conclave/core/client/index.ts';
import { err as e, out as p } from '../ansi';
import { bool, num, str, type ParsedArgs } from '../args';
import { cliPaths } from '../files';
import { checkHealth, hubLogTail, localUrl, loginLink, readLocalHub, spawnDetachedHub, waitForHealth } from '../hub';
import { terminalQr } from '../qr';
import { CliError, print } from './shared';
import { VERSION } from '../version';

/** Build the engine. A literal import so `bun build --compile` bundles it. */
async function makeEngine(): Promise<EngineApi> {
  try {
    const { createEngine } = await import('@conclave/core/engine/index.ts');
    // Engine declares `implements EngineApi`; core's own typecheck holds it to that.
    return (await createEngine({ version: VERSION })) as unknown as EngineApi;
  } catch (err) {
    throw new CliError(`Could not start the engine: ${(err as Error).message}`);
  }
}

export async function serveCommand(args: ParsedArgs): Promise<number> {
  const host = str(args, 'host');
  const port = num(args, 'port');
  const local = readLocalHub();
  const url = localUrl(host ?? local.host, port ?? local.port);

  if (bool(args, 'detach')) {
    const h = await checkHealth(url);
    if (h.ok || h.reason === 'http') {
      print(`A hub is already listening on ${url}`);
      return 0;
    }
    const extra = [...(host ? ['--host', host] : []), ...(port ? ['--port', String(port)] : [])];
    const proc = spawnDetachedHub(extra);
    const pid = proc.pid;
    process.stderr.write(e.dim(`Starting hub (pid ${pid ?? '?'})...\n`));
    if (!(await waitForHealth(url, 20_000, 200, proc))) {
      throw new CliError(`Hub did not come up${proc.exited() ? ` (${proc.exited()})` : ''}. Log ${cliPaths().hubLog}:\n${hubLogTail()}`);
    }
    const token = readLocalHub().token;
    print(`${p.green('●')} Hub running at ${p.bold(url)} ${p.dim(`(pid ${pid ?? '?'})`)}`);
    print(`  Login  ${loginLink(url, token)}`);
    print(`  Logs   ${cliPaths().hubLog}`);
    return 0;
  }

  const existing = await checkHealth(url, 800);
  if (existing.ok) throw new CliError(`A hub is already running at ${url}. Stop it first or use --port.`);

  const engine = await makeEngine();
  const { startServer } = await import('@conclave/server');
  let running: Awaited<ReturnType<typeof startServer>>;
  try {
    running = startServer(engine, { host, port });
  } catch (err) {
    await engine.shutdown().catch(() => {});
    throw new CliError(`Could not listen on ${url}: ${(err as Error).message}`);
  }
  // a crash lands in the log files with its stack before the process exits (docs/DESIGN.md 33)
  const { installCrashLogging } = await import('@conclave/core/logs/index.ts');
  installCrashLogging();
  const cfg = engine.config.get().server;
  const detached = process.env.CONCLAVE_DETACHED === '1';
  const remote = running.conclave.ctx.remote;

  // a tunnel takes a few seconds; wait for it so the login link and QR use it
  let status = remote.status();
  if (status.state === 'starting' || status.state === 'installing') {
    if (!detached) process.stderr.write(e.dim(`${status.detail ?? 'Starting remote access'}...\n`));
    await engine.bus.once('remote.updated', (ev) => ev.remote.state === 'on' || ev.remote.state === 'error', 60_000).catch(() => undefined);
    status = remote.status();
  }
  const best = status.addresses[0]?.url;

  print('');
  print(`${p.bold(p.fg('#C792EA')('◆ Conclave hub'))} ${p.dim(engine.version)}`);
  print(`  Local    ${p.bold(running.url)}`);
  for (const a of status.addresses) {
    const word = a.kind === 'lan' ? 'Network ' : 'Remote  ';
    print(`  ${word} ${p.bold(a.url)} ${p.dim(a.label)}`);
  }
  if (status.state === 'error' && status.error) print(`  ${p.red('Remote   ' + status.error)}`);
  print(`  Login    ${loginLine(best || running.url, cfg.token, { detached, config: engine.config.paths.config })}`);
  print(`  Config   ${engine.config.paths.config}`);
  print(`  Key      ${formatFingerprint(running.conclave.ctx.identity.fingerprint)} ${p.dim('(apps check the hub against it)')}`);

  if (!detached) {
    try {
      const client = new ConclaveClient({ baseUrl: running.url, token: cfg.token });
      const pairing = await client.createPairing('client');
      print('');
      print(`Pair a phone: scan this, or enter code ${p.bold(pairing.code)} ${p.dim(`(valid ${Math.round((pairing.expiresAt - Date.now()) / 60000)} min)`)}`);
      print(await terminalQr(pairing.deepLink));
      const kinds = new Set(status.addresses.map((a) => a.kind));
      if (!kinds.size && (status.mode === 'quick' || status.mode === 'stable')) {
        print(p.yellow('  Phones cannot reach this hub until the tunnel works. The hub keeps trying; `conclave remote` shows how it is going.'));
      } else if (!kinds.size) {
        print(p.yellow('  Phones cannot reach this hub yet. Run `conclave remote quick` for an https address with no account, or `conclave remote url <URL>` for your own.'));
      } else if (!kinds.has('quick') && !kinds.has('stable') && !kinds.has('own')) {
        print(p.dim('  Phones on the same Wi-Fi can scan this. To reach the hub from anywhere: conclave remote quick'));
      }
    } catch (err) {
      print(p.dim(`(pairing QR unavailable: ${(err as Error).message})`));
    }
    print(p.dim('Ctrl+C to stop.'));
  }

  // say so when the outside address changes while the hub runs
  let shownUrl = status.url;
  let shownError = status.error;
  engine.bus.on((ev) => {
    if (ev.type !== 'remote.updated') return;
    const r = ev.remote;
    const at = p.dim(new Date().toISOString().slice(11, 19));
    if (r.state === 'on' && r.url && r.url !== shownUrl) {
      shownUrl = r.url;
      shownError = undefined;
      print(`${at} Remote address ${p.bold(r.url)}${r.previousUrl ? p.dim(` (was ${r.previousUrl})`) : ''}`);
    } else if (r.state === 'error' && r.error && r.error !== shownError) {
      shownError = r.error;
      print(`${at} ${p.red('Remote access: ' + r.error)}`);
    }
  });

  let stopping = false;
  await new Promise<void>((resolve) => {
    const shutdown = async (signal: string) => {
      if (stopping) process.exit(1);
      stopping = true;
      process.stderr.write(`\n${signal}: stopping hub...\n`);
      const force = setTimeout(() => process.exit(1), 10_000);
      try {
        await running.stop(signal);
        await engine.shutdown();
      } catch (err) {
        process.stderr.write(`shutdown error: ${(err as Error).message}\n`);
      } finally {
        clearTimeout(force);
        resolve();
      }
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    if (process.env[STOP_ON_STDIN_END] === '1') stopWhenStdinEnds(() => void shutdown('stdin closed'));
  });
  return 0;
}

/**
 * The Login line of the banner. A hub in a terminal shows the link with its
 * owner token. A detached hub's output goes to a log file (logs/hub.log of
 * `conclave serve --detach` and of the desktop app), so the token stays out:
 * whoever started it got the link another way (the --detach parent prints it,
 * the desktop app reads config.json itself).
 */
export function loginLine(url: string, token: string | undefined, opts: { detached: boolean; config: string }): string {
  if (!opts.detached || !token) return loginLink(url, token);
  return `${url} (the owner token is in ${opts.config})`;
}

/**
 * The desktop app runs the hub with a pipe on stdin and this set to 1. Closing
 * the pipe stops the hub cleanly, on Windows too, where there is no SIGTERM;
 * and when the app dies the system closes the pipe, so the hub never outlives
 * it (docs/DESIGN.md 36).
 */
export const STOP_ON_STDIN_END = 'CONCLAVE_STOP_ON_STDIN_END';

export function stopWhenStdinEnds(stop: () => void, input: NodeJS.ReadableStream = process.stdin): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    stop();
  };
  input.on('end', once);
  input.on('close', once);
  input.on('error', once);
  // nothing is read from it; resume() keeps the stream flowing so its end is seen
  input.on('data', () => {});
  input.resume();
}
