/** `conclave password`: the hub password, a backup to pairing codes (docs/design/HUB-LOGIN-AND-IDENTITY.md). */
import { ApiError, formatFingerprint, type ConclaveClient } from '@conclave/core/client/index.ts';
import { out as p } from '../ansi';
import { type ParsedArgs } from '../args';
import { CliError, getClient, print, prompt } from './shared';

const MIN = 12;

/** The routes are owner only; say how to get there instead of a bare 403. */
async function owner<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) throw new CliError('Only the owner token can change the hub password. Run this on the hub, or pass --token with the token from conclave serve.');
    throw e;
  }
}

async function fingerprint(client: ConclaveClient): Promise<string | undefined> {
  const fp = await client.info().then((i) => i.fingerprint, () => undefined);
  return fp ? formatFingerprint(fp) : undefined;
}

export async function passwordCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'status';
  const { client } = await getClient(args);
  if (sub === 'set') {
    const first = await prompt('New hub password (input hidden): ', { hidden: true });
    if ([...first].length < MIN || !first.trim()) throw new CliError(`The password needs ${MIN} characters or more. Nothing was changed.`);
    // piped input is read once; there is no second line to compare
    if (process.stdin.isTTY) {
      const again = await prompt('Type it again: ', { hidden: true });
      if (again !== first) throw new CliError('The two passwords do not match. Nothing was changed.');
    }
    await owner(() => client.setPassword(first));
    print(`${p.green('✓')} Password set. Apps can now log in with the hub's address and this password.`);
    const fp = await fingerprint(client);
    if (fp) print(p.dim(`  Hub key ${fp}. An app shows it after logging in; check that it matches.`));
    return 0;
  }
  if (sub === 'clear' || sub === 'off') {
    const was = await owner(() => client.passwordStatus());
    await owner(() => client.clearPassword());
    print(was.set ? `${p.green('✓')} Password removed. Logging in with a password is off.` : 'No password was set. Logging in with a password is off.');
    return 0;
  }
  if (sub === 'status') {
    const s = await owner(() => client.passwordStatus());
    print(s.set ? `A password is set${s.setAt ? ` (since ${new Date(s.setAt).toLocaleString()})` : ''}. Apps can log in with it.` : 'No password is set. Apps pair with a code. Set one with: conclave password set');
    return 0;
  }
  throw new CliError('Usage: conclave password [status | set | clear]');
}
