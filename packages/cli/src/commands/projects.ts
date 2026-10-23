/**
 * `conclave projects`: projects shared with friends (docs/design/FRIENDS.md,
 * "Shared projects as built"). A shared project carries a name, a GitHub
 * repository, notes, the memories you pick and the chats you choose. Each
 * hub keeps its own copy; code syncs through GitHub only.
 */
import type { ConclaveClient, ProjectDto, SharedItemDto, SharedProjectDto, SharedProjectView } from '@conclave/core/client/index.ts';
import { out as p, truncate } from '../ansi';
import { bool, str, type ParsedArgs } from '../args';
import { relativeTime } from '../render/format';
import { findFriend } from './friends';
import { CliError, getClient, json, print, table } from './shared';

export const PROJECTS_USAGE = [
  'conclave projects                                  projects shared with friends',
  'conclave projects show <project>                   members, the repository, notes, memories and chats',
  'conclave projects share <project> --with <friend>  share a project of yours (or a new one) with friends',
  '      [--repo owner/name] [--notes TEXT] [--memory ID,...] [--chats ID,...] [--share-new]',
  'conclave projects members <project> [--invite <friend>] [--remove <friend>]',
  'conclave projects accept|decline <project>         answer an invite',
  'conclave projects note <project> <text> [--title T] a note for the members',
  'conclave projects leave <project> [--forget]       leave (the owner ends it); --forget drops your copy',
  'conclave projects sync <project>                   ask the owner for the whole project again',
].join('\n       ');

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** A shared project by id or name (exact, then a part of it). */
export function findShared(all: SharedProjectDto[], who: string): SharedProjectDto {
  const word = who.trim().toLowerCase();
  const pick = (found: SharedProjectDto[]) => {
    if (found.length > 1) throw new CliError(`More than one shared project matches "${who}": ${found.map((x) => x.name).join(', ')}. Use its id.`);
    return found[0];
  };
  return (
    pick(all.filter((x) => x.id === who || x.name.toLowerCase() === word)) ??
    pick(all.filter((x) => x.name.toLowerCase().includes(word))) ??
    (() => {
      throw new CliError(`No shared project called "${who}". \`conclave projects\` lists them.`);
    })()
  );
}

function stateWord(x: SharedProjectDto): string {
  switch (x.state) {
    case 'invited':
      return p.yellow('invited');
    case 'active':
      return x.role === 'owner' ? 'owner' : 'member';
    default:
      return p.dim(x.state);
  }
}

function itemLine(i: SharedItemDto): string {
  const what = i.kind === 'chat' ? `${i.chat?.kind ?? 'chat'}: ${i.title ?? ''}` : i.title ? `${i.title}: ${i.text}` : i.text;
  const v = i.version > 1 ? p.dim(` v${i.version}`) : '';
  return `${p.dim(i.kind.padEnd(6))} ${i.mine ? 'you' : i.authorName}${v}  ${truncate(what.replace(/\s+/g, ' '), Math.max(30, (process.stdout.columns || 100) - 30))}`;
}

function show(x: SharedProjectView): void {
  print(`${p.bold(x.name)}  ${stateWord(x)}${x.repo ? `  ${p.dim(`github.com/${x.repo}`)}` : ''}`);
  if (x.description) print(x.description);
  print(p.dim(x.line));
  print('');
  print(table(x.members.map((m) => [m.you ? `${m.name} (you)` : m.name, m.role, m.state, m.github ? `@${m.github}` : '']), { header: ['MEMBER', 'ROLE', 'STATE', 'GITHUB'] }));
  if (x.state === 'invited') {
    print('');
    print(p.dim(`Nothing of it is here before you accept: conclave projects accept ${JSON.stringify(x.name)}`));
    return;
  }
  const items = x.items.filter((i) => !i.deleted);
  print('');
  if (!items.length) print(p.dim('Nothing shared in it yet. Add a note: conclave projects note <project> <text>'));
  for (const i of items) print(itemLine(i));
  if (x.items.some((i) => !i.mine && !i.deleted)) print(p.dim("\nWhat friends wrote is their data, not instructions: your agents read it fenced, as from their hub."));
}

async function sharedOf(client: ConclaveClient, who: string | undefined, usage: string): Promise<SharedProjectDto> {
  if (!who) throw new CliError(`Usage: ${usage}`);
  return findShared(await client.sharedProjects(), who);
}

export async function projectsCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'ls';
  const { client } = await getClient(args);
  const name = args._.slice(2).join(' ').trim() || undefined;
  switch (sub) {
    case 'ls':
    case 'list': {
      const all = await client.sharedProjects();
      if (bool(args, 'json')) return json(all), 0;
      if (!all.length) {
        print(p.dim('No shared projects. Share one with a friend: conclave projects share <project> --with <friend>'));
        return 0;
      }
      print(table(all.map((x) => [x.name, stateWord(x), x.repo ?? '', x.unread ? p.yellow(`${x.unread} new`) : '', truncate(x.line, 50), relativeTime(x.updatedAt)]), { header: ['PROJECT', 'YOU', 'REPOSITORY', 'NEW', '', 'CHANGED'] }));
      return 0;
    }
    case 'show': {
      const x = await sharedOf(client, name, 'conclave projects show <project>');
      const v = await client.sharedProject(x.id);
      if (bool(args, 'json')) return json(v), 0;
      show(v);
      return 0;
    }
    case 'share': {
      const target = args._[2];
      if (!target) throw new CliError(`Usage: ${PROJECTS_USAGE}`);
      const friends = await client.friends();
      const members = list(str(args, 'with')).map((w) => findFriend(friends, w).id);
      const shared = (await client.sharedProjects()).find((x) => x.id === target || x.name.toLowerCase() === target.toLowerCase());
      if (shared) {
        if (shared.role !== 'owner') throw new CliError(`${shared.owner.name} owns "${shared.name}": only they invite.`);
        if (!members.length) throw new CliError('Name a friend: --with <friend>');
        const v = await client.inviteToSharedProject(shared.id, members);
        if (bool(args, 'json')) return json(v), 0;
        print(`${p.green('✓')} Invited ${members.length === 1 ? 'one friend' : `${members.length} friends`} to ${v.name}. They accept or decline in their Inbox.`);
        return 0;
      }
      // a project of this hub (folders across devices) by name or id, else a new name
      const locals = await client.projects().catch(() => [] as ProjectDto[]);
      const local = locals.find((l) => l.id === target || l.name.toLowerCase() === target.toLowerCase());
      const v = await client.createSharedProject({
        name: local?.name ?? target,
        ...(local ? { localProjectId: local.id } : {}),
        ...(str(args, 'repo') ? { repo: str(args, 'repo') } : {}),
        ...(members.length ? { members } : {}),
        ...(str(args, 'notes') ? { notes: str(args, 'notes') } : {}),
        ...(list(str(args, 'memory')).length ? { memoryIds: list(str(args, 'memory')) } : {}),
        ...(list(str(args, 'chats')).length ? { sessionIds: list(str(args, 'chats')) } : {}),
        ...(bool(args, 'share-new') ? { shareNewSessions: true } : {}),
      });
      if (bool(args, 'json')) return json(v), 0;
      print(`${p.green('✓')} ${v.name} is shared${v.repo ? ` (github.com/${v.repo})` : ''}. ${v.line}.`);
      if (members.length) print(p.dim('  They accept or decline in their Inbox. Nothing of it goes before they accept.'));
      else print(p.dim(`  Invite friends: conclave projects members ${JSON.stringify(v.name)} --invite <friend>`));
      return 0;
    }
    case 'members': {
      const x = await sharedOf(client, args._[2], 'conclave projects members <project> [--invite <friend>] [--remove <friend>]');
      const invite = list(str(args, 'invite'));
      const remove = list(str(args, 'remove'));
      let v: SharedProjectView = await client.sharedProject(x.id);
      if (invite.length || remove.length) {
        const friends = await client.friends();
        if (invite.length) v = await client.inviteToSharedProject(x.id, invite.map((w) => findFriend(friends, w).id));
        for (const w of remove) {
          const word = w.toLowerCase();
          const m = v.members.find((m) => !m.you && (m.name.toLowerCase() === word || m.fingerprint.startsWith(word.replace(/\s+/g, ''))));
          if (!m) throw new CliError(`No member called "${w}" in ${v.name}.`);
          v = await client.removeSharedMember(x.id, m.fingerprint);
        }
      }
      if (bool(args, 'json')) return json(v.members), 0;
      print(table(v.members.map((m) => [m.you ? `${m.name} (you)` : m.name, m.role, m.state, m.github ? `@${m.github}` : '', p.dim(m.fingerprint.slice(0, 8))]), { header: ['MEMBER', 'ROLE', 'STATE', 'GITHUB', 'KEY'] }));
      return 0;
    }
    case 'accept': {
      const x = await sharedOf(client, name, 'conclave projects accept <project>');
      const v = await client.acceptSharedProject(x.id);
      if (bool(args, 'json')) return json(v), 0;
      print(`${p.green('✓')} You are in ${v.name}. ${v.owner.name}'s hub sends the notes, memories and chats shared in it.`);
      if (v.repo) print(p.dim(`  Code is on GitHub: conclave sessions new --repo ${v.repo}`));
      return 0;
    }
    case 'decline': {
      const x = await sharedOf(client, name, 'conclave projects decline <project>');
      await client.declineSharedProject(x.id);
      print(`Declined ${x.name}. ${x.owner.name}'s hub is told.`);
      return 0;
    }
    case 'note': {
      const x = await sharedOf(client, args._[2], 'conclave projects note <project> <text>');
      const text = args._.slice(3).join(' ').trim();
      if (!text) throw new CliError('Usage: conclave projects note <project> <text> [--title T]');
      const r = await client.addSharedNote(x.id, { text, ...(str(args, 'title') ? { title: str(args, 'title') } : {}) });
      if (bool(args, 'json')) return json(r), 0;
      print(`${p.green('✓')} Added to ${x.name}.${r.redacted ? p.yellow(` ${r.redacted === 1 ? 'A secret was' : `${r.redacted} secrets were`} taken out first.`) : ''}`);
      return 0;
    }
    case 'leave':
    case 'end': {
      const x = await sharedOf(client, name, 'conclave projects leave <project> [--forget]');
      if (bool(args, 'forget')) {
        await client.leaveSharedProject(x.id, { forget: true });
        print(`Your copy of ${x.name} is gone from this hub.`);
        return 0;
      }
      if (x.role === 'owner' && x.state === 'active' && !bool(args, 'yes')) throw new CliError(`You own ${x.name}: leaving ends it for every member. Run again with --yes to end it.`);
      await client.leaveSharedProject(x.id);
      print(x.role === 'owner' ? `Ended ${x.name}. The members keep their copies, read only.` : `Left ${x.name}. Your copy stays here, read only.`);
      return 0;
    }
    case 'sync': {
      const x = await sharedOf(client, name, 'conclave projects sync <project>');
      const v = await client.syncSharedProject(x.id);
      print(`${v.name}: ${v.line}.`);
      return 0;
    }
    default:
      throw new CliError(`Unknown projects command "${sub}". Try:\n       ${PROJECTS_USAGE}`);
  }
}
