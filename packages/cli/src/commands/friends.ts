/**
 * `conclave friends`: other owners' hubs (docs/design/FRIENDS.md). An invite
 * is a link and QR code; the friend's hub checks your hub's key, sends a
 * signed request, and you accept. Notes are plain text to try it. Shares
 * of chats and sessions are in shares.ts (conclave friends shares).
 */
import { formatFingerprint, type ConclaveClient, type FriendDto } from '@conclave/core/client/index.ts';
import { out as p, truncate } from '../ansi';
import { bool, str, type ParsedArgs } from '../args';
import { terminalQr } from '../qr';
import { relativeTime } from '../render/format';
import { CliError, getClient, json, print, table } from './shared';

const USAGE = [
  'conclave friends                         list friends and requests',
  'conclave friends add <hub-address> [--email E]  ask their hub by its address; the request waits in their Inbox',
  'conclave friends invite [--lan]          a link and QR code for one friend, valid 24 hours',
  "conclave friends accept <link|name>      use a friend's link, or accept their request",
  'conclave friends verify <name>           you compared the safety code with them',
  'conclave friends send-note <name> <text> a note to a friend',
  'conclave friends inbox [name]            notes from friends',
  'conclave friends shares                  chats and sessions friends sent, and yours (conclave friends shares help)',
  'conclave friends rm <name>               remove a friend, or decline a request',
  'conclave friends by-address on|off       take friend requests from hubs that know only your address',
].join('\n       ');

/** A friend by id, fingerprint (or its first characters), or name. */
export function findFriend(list: FriendDto[], who: string): FriendDto {
  const word = who.trim().toLowerCase();
  const hex = word.replace(/\s+/g, '');
  const pick = (found: FriendDto[]) => {
    if (found.length > 1) throw new CliError(`More than one friend matches "${who}": ${found.map((f) => f.name).join(', ')}. Use the key.`);
    return found[0];
  };
  return (
    pick(list.filter((f) => f.id === who || f.fingerprint === hex || f.name.toLowerCase() === word)) ??
    (/^[0-9a-f]{4,}$/.test(hex) ? pick(list.filter((f) => f.fingerprint.startsWith(hex))) : undefined) ??
    pick(list.filter((f) => f.name.toLowerCase().includes(word))) ??
    (() => {
      throw new CliError(`No friend called "${who}". \`conclave friends\` lists them.`);
    })()
  );
}

function state(f: FriendDto): string {
  if (f.status === 'pending') return f.direction === 'in' ? p.yellow('asks to be friends') : p.dim('waiting for them');
  if (f.status === 'blocked') return p.red('new key, confirm it');
  return f.verified ? p.green('verified') : 'friends';
}

async function friend(client: ConclaveClient, who: string | undefined, usage: string): Promise<FriendDto> {
  if (!who) throw new CliError(`Usage: ${usage}`);
  return findFriend(await client.friends(), who);
}

export async function friendsCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'ls';
  if (sub === 'shares' || sub === 'share') return (await import('./shares')).sharesCommand(args);
  const { client } = await getClient(args);
  switch (sub) {
    case 'ls':
    case 'list': {
      const list = await client.friends();
      if (bool(args, 'json')) return json(list), 0;
      if (!list.length) {
        print(p.dim('No friends yet. Make an invite with: conclave friends invite'));
        return 0;
      }
      const rows = list.map((f) => [f.name, p.dim(formatFingerprint(f.fingerprint).slice(0, 19)), state(f), f.safetyCode, f.queued ? p.yellow(`${f.queued} waiting`) : '', relativeTime(f.lastSeen)]);
      print(table(rows, { header: ['NAME', 'KEY', 'STATE', 'SAFETY CODE', 'OUTBOX', 'SEEN'] }));
      for (const f of list) {
        if (f.status === 'pending' && f.direction === 'in') print(p.dim(`  Accept ${f.name}: conclave friends accept ${JSON.stringify(f.name)}`));
        if (f.blockedReason) print(p.red(`  ${f.name}: ${f.blockedReason}`));
        else if (f.lastError) print(p.dim(`  ${f.name}: ${f.lastError}`));
      }
      return 0;
    }
    case 'add':
      // an address: ask their hub; nothing after add: an invite, as before
      if (args._[2] && !args._[2].startsWith('conclave://')) return addByAddress(client, args);
    // falls through
    case 'invite': {
      const inv = await client.createFriendInvite({ includeLan: bool(args, 'lan'), name: str(args, 'name') });
      if (bool(args, 'json')) return json(inv), 0;
      print(await terminalQr(inv.link));
      print(inv.link);
      print(p.dim(`One friend can use it until ${new Date(inv.expiresAt).toLocaleString()}. Your hub's key: ${formatFingerprint(inv.fingerprint)}.`));
      if (inv.warning) print(p.yellow(inv.warning));
      print(p.dim('Your friend runs: conclave friends accept "<link>", or scans the code in their app.'));
      return 0;
    }
    case 'accept': {
      const what = args._.slice(2).join(' ').trim();
      if (!what) throw new CliError('Usage: conclave friends accept <link|name>');
      if (what.startsWith('conclave://')) {
        const f = await client.acceptFriendInvite(what, str(args, 'name'));
        if (bool(args, 'json')) return json(f), 0;
        print(`${p.green('✓')} Request sent. Their hub's key checked out: ${formatFingerprint(f.fingerprint)}.`);
        print(p.dim(`  You are friends once their owner accepts. Safety code ${f.safetyCode}: compare it with them.`));
        return 0;
      }
      const f = await friend(client, what, 'conclave friends accept <link|name>');
      const done = await client.acceptFriend(f.id);
      if (bool(args, 'json')) return json(done), 0;
      print(`${p.green('✓')} You and ${done.name} are friends. Safety code ${done.safetyCode}.`);
      print(p.dim(`  Compare it with ${done.name}, then: conclave friends verify ${JSON.stringify(done.name)}`));
      return 0;
    }
    case 'verify': {
      const f = await friend(client, args._.slice(2).join(' ').trim() || undefined, 'conclave friends verify <name>');
      const done = await client.verifyFriend(f.id, true);
      print(`${p.green('✓')} ${done.name} is verified (safety code ${done.safetyCode}).`);
      return 0;
    }
    case 'send-note':
    case 'note': {
      const f = await friend(client, args._[2], 'conclave friends send-note <name> <text>');
      const text = args._.slice(3).join(' ').trim();
      if (!text) throw new CliError('Usage: conclave friends send-note <name> <text>');
      const item = await client.sendFriendNote(f.id, text);
      if (bool(args, 'json')) return json(item), 0;
      // the hub tries right away; say how it went if it is quick
      let last = item;
      for (let i = 0; i < 20 && last.state === 'queued' && !last.attempts; i++) {
        await Bun.sleep(100);
        last = (await client.friendOutbox(f.id)).find((x) => x.id === item.id) ?? last;
      }
      if (last.state === 'delivered') print(`${p.green('✓')} Delivered to ${f.name}.`);
      else print(`Queued for ${f.name}. ${last.lastError ? p.dim(last.lastError) + ' ' : ''}${p.dim("The hub keeps trying for 7 days, and their hub can fetch it when it reaches yours.")}`);
      return 0;
    }
    case 'inbox': {
      const who = args._.slice(2).join(' ').trim();
      const f = who ? await friend(client, who, 'conclave friends inbox [name]') : undefined;
      const items = await client.friendInbox(f?.id);
      if (bool(args, 'json')) return json(items), 0;
      if (!items.length) {
        print(p.dim('No notes from friends.'));
        return 0;
      }
      const w = Math.min(process.stdout.columns || 100, 120);
      print(table(items.map((n) => [p.dim(relativeTime(n.receivedAt)), n.friendName, truncate((n.text ?? `(${n.state})`).replace(/\s+/g, ' '), Math.max(20, w - 30))]), { header: ['WHEN', 'FROM', 'NOTE'] }));
      return 0;
    }
    case 'by-address': {
      const want = args._[2];
      const st = want === 'on' || want === 'off' ? await client.setFriendSettings({ requestsByAddress: want === 'on' }) : await client.friendSettings();
      if (bool(args, 'json')) return json(st), 0;
      print(st.requestsByAddress ? 'Hubs that know your address can ask to be friends. Each request waits for you.' : 'Friend requests come by invite only.');
      if (st.address) print(p.dim(`Your hub's address, to give friends: ${st.address}`));
      if (st.blocked.length) print(p.dim(`Blocked: ${st.blocked.map((b) => b.name).join(', ')}`));
      return 0;
    }
    case 'rm':
    case 'remove':
    case 'decline': {
      const f = await friend(client, args._.slice(2).join(' ').trim() || undefined, 'conclave friends rm <name>');
      if (f.status === 'pending') {
        await client.declineFriend(f.id);
        print(f.direction === 'in' ? `Declined ${f.name}'s request. Their hub is not told.` : `Withdrew the request to ${f.name}.`);
        return 0;
      }
      await client.removeFriend(f.id);
      print(`${p.green('✓')} Removed ${f.name}. Their hub is asked to stop too; nothing more goes either way.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown friends command "${sub}". Try:\n       ${USAGE}`);
  }
}

/** conclave friends add <hub-address> [--email E] [--name N]: the request goes to their hub; with an email, an invite by mail if it does not. */
async function addByAddress(client: ConclaveClient, args: ParsedArgs): Promise<number> {
  const address = args._[2]!;
  const email = str(args, 'email');
  const r = await client.addFriendByAddress({ address, ...(email ? { email } : {}), ...(str(args, 'name') ? { name: str(args, 'name') } : {}) });
  if (bool(args, 'json')) return json(r), 0;
  if (r.sent && r.friend) {
    if (r.friend.status === 'active') print(`${p.green('✓')} You and ${r.friend.name} are friends: they had asked you too.`);
    else print(`${p.green('✓')} Request sent to the hub at ${address}. It waits in their Inbox until they accept.`);
    print(p.dim(`  Their hub's key: ${formatFingerprint(r.friend.fingerprint)}. Safety code ${r.friend.safetyCode}: compare it with them.`));
    return 0;
  }
  print(`${p.yellow('Not sent.')} ${r.reason ?? ''}`.trim());
  if (r.mailto) {
    print(p.dim('Send them this invite instead. It works once, for 24 hours:'));
    print(r.invite!.link);
    print(p.dim(`Or open the mail: ${r.mailto}`));
  } else print(p.dim('Add --email to get an invite you can mail them, or make one: conclave friends invite'));
  return 1;
}
