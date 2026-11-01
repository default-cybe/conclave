/** `conclave login` / `conclave logout`: pair this terminal with a hub. */
import { hostname, platform } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import { ConclaveClient, formatFingerprint, type AccountRef, type HubIdentity, type PairResult } from '@conclave/core/client/index.ts';
import { out as p } from '../ansi';
import { bool, str, type ParsedArgs } from '../args';
import { cliPaths, normalizeHubUrl, writePrivateJson, type ClientFile } from '../files';
import { checkHealth } from '../hub';
import { CliError, print, prompt, requireArg } from './shared';

export async function loginCommand(args: ParsedArgs): Promise<number> {
  const url = normalizeHubUrl(requireArg(args._[1] ?? str(args, 'hub'), 'conclave login <hubUrl> [--code CODE | --password [--account NAME] | --token TOKEN]'));
  const h = await checkHealth(url, 5000);
  if (!h.ok && h.reason !== 'http') throw new CliError(`Cannot reach ${url} (${h.reason}).`);
  let account: AccountRef | undefined;
  const name = str(args, 'name') ?? `${hostname()} (terminal)`;
  let token = str(args, 'token');
  let clientId: string | undefined;
  let hubName = '';
  let addresses: string[] | undefined;
  // the hub's key, kept with the token: later commands send the token only to a hub that proves it
  let identity: HubIdentity | undefined;
  if (token) {
    // no pairing reply to take the key from: keep the one the hub proves now (an older hub has none)
    identity = await new ConclaveClient({ baseUrl: url }).checkIdentity().catch(() => undefined);
    const client = new ConclaveClient({ baseUrl: url, token, hubKey: identity?.publicKey });
    const info = await client.info();
    hubName = info.name;
    // /api/info may be public; make sure the token works on a protected route.
    await client.listSessions({ limit: 1 });
  } else {
    const client = new ConclaveClient({ baseUrl: url });
    let res: PairResult;
    if (bool(args, 'password')) {
      // a hub with several people asks whose password it is, by sign-in name or email (docs/design/ACCOUNTS.md 4)
      let who = str(args, 'account');
      if (!who && (await client.health().catch(() => undefined))?.people) who = (await prompt('Sign-in name or email on this hub: ')).trim();
      const password = await prompt(who ? 'Your password (input hidden): ' : 'Hub password (input hidden): ', { hidden: true });
      if (!password) throw new CliError('No password given.');
      res = await client.login(password, name, platform(), who || undefined);
    } else {
      const code = str(args, 'code') ?? (await prompt('Pairing code: '));
      if (!code) throw new CliError('No code given.');
      res = await client.pair(code.trim(), name, platform());
    }
    token = res.token;
    clientId = res.clientId;
    hubName = res.hub?.name ?? '';
    addresses = res.addresses;
    identity = res.identity;
    account = res.account;
  }
  const file: ClientFile = {
    hub: url,
    token,
    clientId,
    name,
    savedAt: Date.now(),
    ...(addresses?.length ? { addresses } : {}),
    ...(identity ? { hubKey: identity.publicKey, fingerprint: identity.fingerprint } : {}),
    ...(account ? { account } : {}),
  };
  writePrivateJson(cliPaths().client, file);
  print(`${p.green('✓')} Logged in to ${p.bold(hubName || url)}${account && account.role === 'member' ? ` as ${p.bold(account.name)}` : ''} ${p.dim(url)}`);
  if (identity) print(p.dim(`  Hub key ${formatFingerprint(identity.fingerprint)} (the hub shows it in Settings and in conclave pair-phone)`));
  print(p.dim(`  Saved ${cliPaths().client}. \`conclave\` now talks to this hub.`));
  return 0;
}

export async function logoutCommand(): Promise<number> {
  const f = cliPaths().client;
  if (existsSync(f)) {
    unlinkSync(f);
    print(`Removed ${f}. \`conclave\` now uses the local hub.`);
  } else print('Not logged in to a remote hub.');
  return 0;
}
