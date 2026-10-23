/**
 * Standalone hub: `bun packages/server/src/main.ts`.
 * Builds the engine, serves HTTP + WebSocket, prints how to connect.
 */
import QRCode from 'qrcode';
import { createEngine } from '@conclave/core/engine/index.ts';
import { formatFingerprint } from '@conclave/core/client/index.ts';
import { installCrashLogging } from '@conclave/core/logs/index.ts';
import { startServer } from './app';
import { pairDeepLink } from './routes';

function hint(token: string | undefined): string {
  if (!token) return '(none)';
  return `${token.slice(0, 4)}...${token.slice(-2)} (full value: server.token in the config file)`;
}

async function main(): Promise<void> {
  const engine = await createEngine();
  const running = startServer(engine);
  // a crash lands in the log files with its stack before the process exits (docs/DESIGN.md 33)
  installCrashLogging();
  const cfg = engine.config.get().server;
  const remote = running.conclave.ctx.remote;
  // a tunnel takes a few seconds; wait for it so the pairing QR uses it
  if (['starting', 'installing'].includes(remote.status().state)) {
    await engine.bus.once('remote.updated', (e) => e.remote.state === 'on' || e.remote.state === 'error', 60_000).catch(() => undefined);
  }
  const addresses = remote.status().addresses;
  const pub = addresses[0]?.url;

  console.log(`\nConclave hub ${engine.version}`);
  console.log(`  listening  ${running.url}`);
  for (const a of addresses) console.log(`  ${a.kind === 'lan' ? 'network' : 'remote '}    ${a.url}  (${a.label})`);
  console.log(`  web app    ${running.conclave.webDir ? running.conclave.webDir : 'not built (bun run build)'}`);
  console.log(`  token      ${hint(cfg.token)}`);
  console.log(`  config     ${engine.config.paths.config}`);
  console.log(`  key        ${formatFingerprint(running.conclave.ctx.identity.fingerprint)}`);

  // a client pairing code so a phone can connect right away
  try {
    const ttl = 10 * 60_000;
    const code = engine.repos.devices.createPairingCode('client', ttl);
    const base = pub || running.url;
    const deepLink = pairDeepLink([base, ...addresses.slice(1).map((a) => a.url)], code, running.conclave.ctx.identity.fingerprint);
    console.log(`\nPair a phone or app (code valid 10 minutes): ${code}`);
    const tunnel = ['quick', 'stable'].includes(remote.status().mode);
    if (!pub && tunnel) {
      console.log('  note: phones cannot reach this hub until the tunnel works. The hub keeps trying; `conclave remote` shows how it is going.');
    } else if (!pub) {
      console.log('  note: phones cannot reach this hub yet. Run `conclave remote quick` for an https address with no account, or `conclave remote url <URL>` for your own.');
    }
    console.log(await QRCode.toString(deepLink, { type: 'terminal', small: true }));
    console.log(`Pair a device daemon: conclave daemon pair ${base} <code> (make a device code on the Devices page)\n`);
  } catch (err) {
    console.error(`pairing code unavailable: ${(err as Error).message}`);
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      console.log('forcing exit');
      process.exit(1);
    }
    stopping = true;
    console.log(`\n${signal}: shutting down...`);
    const force = setTimeout(() => process.exit(1), 10_000);
    try {
      await running.stop(signal);
      await engine.shutdown();
    } catch (err) {
      console.error('shutdown error', err);
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
