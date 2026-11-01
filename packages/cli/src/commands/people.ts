/**
 * `conclave people`: the people on this hub (docs/design/ACCOUNTS.md), for
 * the owner. Each person has their own chats, memory, keys and devices;
 * the hub's computer and settings stay the owner's.
 */
import type { PersonDto, ProviderGrantsDto } from '@conclave/core/client/index.ts';
import { out as p } from '../ansi';
import { bool, str, type ParsedArgs } from '../args';
import { CliError, getClient, json, print, prompt, requireArg, table } from './shared';

const USAGE = [
  'conclave people                                   everyone on the hub, with this month\'s spend',
  'conclave people add NAME [--display-name "Dee Okafor"] [--email E] [--password] [--providers anthropic:5,openai]',
  '                                                  add a person: an invite link, or a password you are asked for.',
  '                                                  NAME is what they sign in with, one word; the display name is what the apps call them',
  'conclave people access NAME --providers LIST       which of the hub\'s keys they may use, with a monthly budget in USD',
  'conclave people passwd NAME                        set a new password; their apps sign out',
  'conclave people invite NAME                        a new invite link (7 days, works once)',
  'conclave people workspace NAME                     commands for a workspace on the hub machine',
  'conclave people remove NAME --yes                  remove them and everything that is theirs',
].join('\n       ');

/** "anthropic:5,openai" to grants: a budget after the colon, none for no cap; "none" for no access. */
export function parseProviders(v: string | undefined): ProviderGrantsDto | undefined {
  if (v === undefined) return undefined;
  if (v === 'none' || v === '') return {};
  const out: ProviderGrantsDto = {};
  for (const part of v.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, budget] = part.split(':');
    if (!id) throw new CliError(`"${part}" is not a provider. Use for example anthropic:5,openai`);
    if (budget === undefined || budget === '') out[id] = { monthlyUsd: null };
    else {
      const n = Number(budget.replace(/^\$/, ''));
      if (!Number.isFinite(n) || n < 0) throw new CliError(`The budget in "${part}" is not a number of dollars.`);
      out[id] = { monthlyUsd: n };
    }
  }
  return out;
}

function spend(x: PersonDto): string {
  if (x.role === 'owner') return p.dim('all of the hub');
  if (!x.spend.length) return p.dim("no hub keys");
  return x.spend.map((s) => `${s.name} $${s.spentUsd.toFixed(2)}${s.monthlyUsd !== undefined ? `/$${s.monthlyUsd}` : ''}`).join(', ');
}

async function passwordTwice(): Promise<string> {
  const a = await prompt('New password, 12 characters or more (input hidden): ', { hidden: true });
  if (!a) throw new CliError('No password given.');
  // piped input is read once; there is no second line to compare
  if (process.stdin.isTTY && (await prompt('Again: ', { hidden: true })) !== a) throw new CliError('The two passwords do not match.');
  return a;
}

export async function peopleCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'list';
  const { client } = await getClient(args);
  const find = async (name: string): Promise<PersonDto> => {
    const all = await client.people();
    const hit = all.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
    if (!hit) throw new CliError(`Nobody called ${name} on this hub. \`conclave people\` lists them.`);
    return hit;
  };
  switch (sub) {
    case 'list':
    case 'ls': {
      const all = await client.people();
      if (bool(args, 'json')) return json(all), 0;
      print(
        table(
          all.map((x) => [x.name, x.displayName ?? '', x.role, x.email ?? '', x.role === 'owner' ? '' : x.passwordSet ? 'password' : x.inviteExpiresAt ? 'invite open' : p.yellow('no password'), `${x.devices}/${x.apps}`, spend(x)]),
          { header: ['NAME', 'DISPLAY NAME', 'ROLE', 'EMAIL', 'SIGN IN', 'DEVICES/APPS', 'THIS MONTH'] },
        ),
      );
      return 0;
    }
    case 'add': {
      const name = requireArg(args._[2], 'conclave people add NAME [--display-name "Dee Okafor"] [--email E] [--password] [--providers anthropic:5,openai]');
      const password = bool(args, 'password') ? await passwordTwice() : undefined;
      const out = await client.addPerson({ name, ...(str(args, 'display-name') ? { displayName: str(args, 'display-name') } : {}), ...(str(args, 'email') ? { email: str(args, 'email') } : {}), ...(password ? { password } : { invite: true }), providers: parseProviders(str(args, 'providers')) ?? {} });
      if (bool(args, 'json')) return json(out), 0;
      print(`${p.green('✓')} Added ${p.bold(out.person.name)}.`);
      if (out.invite) {
        print(`  Send them this link. It works once, for 7 days:`);
        print(`  ${out.invite.url}`);
      } else print(p.dim(`  They sign in with their name and the password: conclave login <hub> --password --account ${out.person.name}`));
      return 0;
    }
    case 'access': {
      const x = await find(requireArg(args._[2], 'conclave people access NAME --providers anthropic:5,openai'));
      const providers = parseProviders(str(args, 'providers'));
      if (!providers) throw new CliError('Say which keys with --providers, for example anthropic:5,openai, or none.');
      const updated = await client.updatePerson(x.id, { providers });
      if (bool(args, 'json')) return json(updated), 0;
      print(`${p.green('✓')} ${updated.name}: ${Object.keys(updated.providers).length ? Object.entries(updated.providers).map(([id, g]) => `${id}${typeof g.monthlyUsd === 'number' ? ` up to $${g.monthlyUsd} a month` : ', no cap'}`).join(', ') : "no access to the hub's keys"}.`);
      return 0;
    }
    case 'passwd':
    case 'password': {
      const x = await find(requireArg(args._[2], 'conclave people passwd NAME'));
      await client.resetPersonPassword(x.id, await passwordTwice());
      print(`${p.green('✓')} New password for ${x.name}. Their apps are signed out.`);
      return 0;
    }
    case 'invite': {
      const x = await find(requireArg(args._[2], 'conclave people invite NAME'));
      const inv = await client.newInvite(x.id);
      if (bool(args, 'json')) return json(inv), 0;
      print(`Invite link for ${x.name}, works once, for 7 days:`);
      print(inv.url);
      return 0;
    }
    case 'workspace': {
      const x = await find(requireArg(args._[2], 'conclave people workspace NAME'));
      const w = await client.workspaceCode(x.id);
      if (bool(args, 'json')) return json(w), 0;
      print(`A workspace for ${x.name} on this computer: a device of theirs under its own user, so it cannot read your files.`);
      print(p.dim('The code works for an hour. Run these on the hub machine:'));
      print('');
      for (const l of w.commands.linux) print(`  ${l}`);
      print('');
      print(p.dim('Or in its own container:'));
      for (const l of w.commands.docker) print(`  ${l}`);
      return 0;
    }
    case 'remove':
    case 'rm': {
      const x = await find(requireArg(args._[2], 'conclave people remove NAME --yes'));
      if (!bool(args, 'yes')) {
        const a = process.stdin.isTTY ? await prompt(`Remove ${x.name} and their chats, memory, routines, devices and keys? This cannot be undone. [y/N] `) : '';
        if (!/^y(es)?$/i.test(a.trim())) throw new CliError('Nothing removed. Add --yes to skip the question.');
      }
      await client.removePerson(x.id);
      print(`${p.green('✓')} Removed ${x.name}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown people command "${sub}". Usage: ${USAGE}`);
  }
}
