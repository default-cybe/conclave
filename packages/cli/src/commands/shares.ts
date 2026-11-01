/**
 * Shares with friends from the terminal (docs/design/FRIENDS.md, phases 2
 * and 3).
 *
 *   conclave sessions send <id> --to <friend>      send a chat or session
 *   conclave friends shares [ls | sent | show | accept | decline | view |
 *     fork | handoff | reference | apply | update | unsend]
 *
 * Sending runs the hub's review first: --dry-run prints what would go and
 * what the sanitizer found, with an id per find for --keep. Nothing a friend
 * sends is fetched before accept, and applying code asks for --yes after
 * the plan is shown.
 */
import { readFileSync } from 'node:fs';
import type { ConclaveClient, ReceivedShareDto, SentShareDto, ShareCodeMode, ShareContentOptions, SharePreview, ShareSummary } from '@conclave/core/client/index.ts';
import { out as p, truncate } from '../ansi';
import { bool, str, type ParsedArgs } from '../args';
import { relativeTime } from '../render/format';
import { CliError, getClient, json, print, table } from './shared';
import { findFriend } from './friends';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "(session, 42 messages, diff 12 files)", as the hub writes it. */
export function describeSummary(kind: 'chat' | 'session', s: ShareSummary): string {
  const code = s.code ? `, ${s.code.kind === 'diff' ? 'diff' : 'git bundle'} ${plural(s.code.files, 'file')}` : '';
  return `(${kind}, ${plural(s.messages, 'message')}${code})`;
}

function codeMode(v: string | undefined): ShareCodeMode | undefined {
  if (v === undefined) return undefined;
  if (v === 'bundle' || v === 'git-bundle') return 'git-bundle';
  if (v === 'diff' || v === 'none') return v;
  throw new CliError('--code is none, diff or bundle.');
}

/** The review's choices from flags. */
export function contentFlags(args: ParsedArgs): ShareContentOptions {
  const tool = str(args, 'tool-output');
  if (tool !== undefined && !['full', 'summary', 'none'].includes(tool)) throw new CliError('--tool-output is full, summary or none.');
  const keep = str(args, 'keep')
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const upTo = str(args, 'upto') ?? str(args, 'up-to');
  const code = codeMode(str(args, 'code'));
  return {
    ...(bool(args, 'thinking') ? { thinking: true } : {}),
    ...(tool ? { toolOutput: tool as ShareContentOptions['toolOutput'] } : {}),
    ...(args.flags.attachments === false ? { attachments: false } : {}),
    ...(code ? { code } : {}),
    ...(upTo ? { upTo } : {}),
    ...(keep?.length ? { keep } : {}),
  };
}

const REPORT_WORDS: Array<[keyof SharePreview['report'], string]> = [
  ['reminders', 'reminder'],
  ['recalled', 'recalled memory id'],
  ['thinking', 'thinking block'],
  ['signatures', 'reasoning signature'],
  ['redactedThinking', 'encrypted reasoning block'],
  ['secrets', 'secret'],
  ['paths', 'path'],
  ['privateIps', 'private address'],
  ['emails', 'email'],
  ['hostnames', 'device name'],
  ['toolOutputs', 'tool output'],
  ['attachments', 'attachment'],
];

function masked(s: string): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length <= 8 ? '*'.repeat(one.length) : `${one.slice(0, 4)}...${one.slice(-2)}`;
}

export function printPreview(r: SharePreview, show: boolean): void {
  print(`${p.bold(r.title)} ${p.dim(`(${r.kind}, ${r.messages} of ${r.total} messages, ${plural(r.sessions, 'session')})`)}`);
  const o = r.options;
  print(p.dim(`Goes: thinking ${o.thinking ? 'yes' : 'no'}, tool output ${o.toolOutput}, attachments ${o.attachments ? 'yes' : 'no'}, code ${o.code === 'git-bundle' ? 'git bundle' : o.code}${o.upTo ? `, up to message ${o.upTo}` : ''}`));
  if (r.code) {
    if ('error' in r.code) print(p.red(`Code: ${r.code.error}`));
    else {
      print(`Code: ${r.code.kind === 'diff' ? 'diff' : `git bundle of ${r.code.branch ?? 'the branch'}`} of ${plural(r.code.files.length, 'file')}${r.code.files.length ? `: ${r.code.files.slice(0, 8).join(', ')}${r.code.files.length > 8 ? ', ...' : ''}` : ''}`);
      for (const e of r.code.excluded) print(p.dim(`  stays home: ${e.path} (${e.reason})`));
    }
  }
  const taken = REPORT_WORDS.filter(([k]) => r.report[k] > 0).map(([k, w]) => plural(r.report[k], w));
  print(taken.length ? `Taken out: ${taken.join(', ')}.` : 'Nothing taken out.');
  if (r.items.length) {
    const rows = r.items.map((i) => [p.dim(i.id), i.rule, String(i.count), truncate(show ? i.original.replace(/\s+/g, ' ') : masked(i.original), 40), i.kept ? p.yellow('kept anyway') : i.replacement || '(removed)']);
    print(table(rows, { header: ['ID', 'RULE', 'TIMES', 'FOUND', 'GOES AS'] }));
    print(p.dim(`Keep one anyway with --keep <id>[,<id>].${show ? '' : ' --show prints what was found in full.'}`));
  }
  for (const w of r.warnings) print(p.yellow(w));
  print(p.dim(`About ${Math.max(1, Math.round(r.bytes / 1024))} KB.`));
}

/** conclave sessions send <id> --to <friend>[,<friend>]. */
export async function sendSessionCommand(args: ParsedArgs): Promise<number> {
  const usage = 'conclave sessions send <id> --to <friend>[,<friend>] [--title T] [--note N] [--upto <msgId>] [--code none|diff|bundle] [--thinking] [--tool-output full|summary|none] [--no-attachments] [--keep <id>,...] [--dry-run [--show]]';
  const id = args._[2];
  if (!id) throw new CliError(`Usage: ${usage}`);
  const { client } = await getClient(args);
  const opts = contentFlags(args);
  if (bool(args, 'dry-run')) {
    const r = await client.previewShare({ sessionId: id, ...opts });
    if (bool(args, 'json')) return json(r), 0;
    printPreview(r, bool(args, 'show'));
    print(p.dim('Nothing was sent. Run it again without --dry-run to send.'));
    return 0;
  }
  const to = str(args, 'to');
  if (!to) throw new CliError(`Usage: ${usage}`);
  const friends = await client.friends();
  const targets = to
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => findFriend(friends, w));
  const sent = await client.sendShare({ sessionId: id, to: targets.map((f) => f.id), ...opts, ...(str(args, 'title') ? { title: str(args, 'title') } : {}), ...(str(args, 'note') ? { note: str(args, 'note') } : {}) });
  if (bool(args, 'json')) return json(sent), 0;
  print(`${p.green('✓')} Sent '${sent.title}' to ${targets.map((f) => f.name).join(', ')} ${describeSummary(sent.kind, sent.summary)}.`);
  print(p.dim(`  Share ${sent.id}. Their hub fetches it only when they accept, for 30 days.`));
  print(p.dim(`  Update it: conclave friends shares update ${sent.id}. Unsend it: conclave friends shares unsend ${sent.id}.`));
  return 0;
}

/** A share by its id, the start of its id, or words of its title. */
export function findShare<T extends { id: string; title: string }>(list: T[], what: string | undefined, usage: string): T {
  if (!what) throw new CliError(`Usage: ${usage}`);
  const word = what.trim().toLowerCase();
  const pick = (found: T[]) => {
    if (found.length > 1) throw new CliError(`More than one share matches "${what}": ${found.map((s) => `${s.title} (${s.id})`).join(', ')}. Use the id.`);
    return found[0];
  };
  return (
    pick(list.filter((s) => s.id.toLowerCase() === word)) ??
    pick(list.filter((s) => s.id.toLowerCase().startsWith(word))) ??
    pick(list.filter((s) => s.title.toLowerCase().includes(word))) ??
    (() => {
      throw new CliError(`No share matches "${what}". \`conclave friends shares\` lists them.`);
    })()
  );
}

function receivedState(s: ReceivedShareDto): string {
  if (s.state === 'offered') return p.yellow('waiting for you');
  if (s.state === 'accepted') return s.updateWaiting ? p.yellow(`revision ${s.revision} waits`) : p.green('accepted');
  if (s.state === 'revoked') return p.dim('unsent');
  return p.dim(s.state);
}

function sentState(s: SentShareDto): string {
  if (s.state === 'revoked') return p.dim('unsent');
  return s.recipients.map((r) => `${r.friendName}: ${r.state === 'accepted' ? p.green('accepted') : r.state === 'failed' ? p.red('failed') : r.state}`).join(', ');
}

function printReceived(list: ReceivedShareDto[]): void {
  if (!list.length) return print(p.dim('No shares from friends.'));
  // cut to the terminal; piped output keeps the whole line
  const w = process.stdout.isTTY ? process.stdout.columns || 100 : 400;
  print(table(list.map((s) => [p.dim(s.id), relativeTime(s.receivedAt), truncate(s.line, Math.max(50, w - 54)), receivedState(s)]), { header: ['ID', 'WHEN', 'SHARE', 'STATE'] }));
}

function printSent(list: SentShareDto[]): void {
  if (!list.length) return print(p.dim('You have not sent a share.'));
  print(table(list.map((s) => [p.dim(s.id), relativeTime(s.updatedAt), truncate(`'${s.title}' ${describeSummary(s.kind, s.summary)} r${s.revision}`, 60), sentState(s)]), { header: ['ID', 'WHEN', 'SHARE', 'TO'] }));
}

const USAGE = [
  'conclave friends shares [ls]                 shares from friends, and the ones you sent',
  'conclave friends shares sent                 the shares you sent',
  'conclave friends shares show <share>         one share from a friend',
  'conclave friends shares accept <share>       fetch it and check its signature',
  'conclave friends shares decline <share>',
  'conclave friends shares view <share> [--diff]   read it, quoted',
  'conclave friends shares fork <share> [--prompt T] [--model M] [--agent A] [--device D] [--cwd P]',
  'conclave friends shares handoff <share> [--brief-file F | --yes]',
  'conclave friends shares reference <share>    keep it read only for your agents',
  'conclave friends shares apply <share> --device D --cwd P [--branch B] [--yes]',
  'conclave friends shares update <sent> [--title T] [--note N]',
  'conclave friends shares unsend <sent>',
].join('\n       ');

async function receivedOne(client: ConclaveClient, what: string | undefined, usage: string): Promise<ReceivedShareDto> {
  return findShare(await client.receivedShares(), what, usage);
}

/** conclave friends shares ... */
export async function sharesCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[2] ?? 'ls';
  const what = args._.slice(3).join(' ').trim() || undefined;
  const { client } = await getClient(args);
  const asJson = bool(args, 'json');
  switch (sub) {
    case 'ls':
    case 'list': {
      const [inbox, sent] = await Promise.all([client.receivedShares(), client.sentShares()]);
      if (asJson) return json({ received: inbox, sent }), 0;
      print(p.bold('From friends'));
      printReceived(inbox);
      print('');
      print(p.bold('Sent'));
      printSent(sent);
      for (const s of inbox.filter((x) => x.state === 'offered').slice(0, 3)) print(p.dim(`  Accept ${s.id}: conclave friends shares accept ${s.id}`));
      return 0;
    }
    case 'sent': {
      const sent = await client.sentShares();
      if (asJson) return json(sent), 0;
      printSent(sent);
      return 0;
    }
    case 'show': {
      const s = await receivedOne(client, what, 'conclave friends shares show <share>');
      if (asJson) return json(s), 0;
      print(p.bold(s.line));
      print(p.dim(`${s.id} · from ${s.friendName} (${s.fingerprint.slice(0, 8)}) · revision ${s.revision} · ${s.state}${s.expiresAt ? ` · expires ${new Date(s.expiresAt).toLocaleDateString()}` : ''}`));
      if (s.note) print(`Note: ${s.note}`);
      if (s.error) print(p.red(s.error));
      for (const x of s.sessions) print(p.dim(`  ${x.role}: ${x.id}`));
      return 0;
    }
    case 'accept': {
      const s = await receivedOne(client, what, 'conclave friends shares accept <share>');
      const done = await client.acceptShare(s.id);
      if (asJson) return json(done), 0;
      print(`${p.green('✓')} Fetched '${done.title}' from ${done.friendName}'s hub. Its signature checks out against their key.`);
      print(p.dim(`  Read it: conclave friends shares view ${done.id}. Continue it: conclave friends shares fork ${done.id}.`));
      return 0;
    }
    case 'decline': {
      const s = await receivedOne(client, what, 'conclave friends shares decline <share>');
      await client.declineShare(s.id);
      print(`Declined '${s.title}'. ${s.friendName}'s hub is not told.`);
      return 0;
    }
    case 'view': {
      const s = await receivedOne(client, what, 'conclave friends shares view <share>');
      const v = await client.viewShare(s.id);
      if (asJson) return json(v), 0;
      print(p.bold(s.line));
      print(v.verified.ok ? p.green(`Signed by ${s.friendName}'s hub key.`) : p.red(`The signature does not check out: ${v.verified.reason}.`));
      print(p.dim(v.provenance));
      for (const sess of v.sessions) {
        print('');
        print(p.bold(`${sess.parentId ? 'Subagent: ' : ''}${sess.title}`));
        for (const m of sess.messages) {
          const textOf = m.content
            .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `[${b.name}]` : b.type === 'tool_result' ? '[result]' : b.type === 'thinking' ? '[thinking]' : `[${b.type}]`))
            .join(' ')
            .trim();
          if (!textOf) continue;
          print(`${p.dim(`${m.from} ·`)} ${m.role === 'user' ? p.bold('user') : `assistant${m.model ? p.dim(` (${m.model})`) : ''}`}: ${textOf}`);
        }
      }
      if (v.code) {
        print('');
        print(`Code: ${v.code.kind === 'diff' ? 'diff' : `git bundle of ${v.code.branch ?? 'a branch'}`} of ${plural(v.code.files.length, 'file')}: ${v.code.files.join(', ')}`);
        for (const e of v.code.excluded) print(p.dim(`  left out there: ${e.path} (${e.reason})`));
        if (bool(args, 'diff') && v.code.diff) print(v.code.diff);
        else if (v.code.diff) print(p.dim('  --diff prints it.'));
      }
      return 0;
    }
    case 'fork': {
      const s = await receivedOne(client, what, 'conclave friends shares fork <share>');
      const session = await client.forkShare(s.id, { ...(str(args, 'prompt') ? { prompt: str(args, 'prompt') } : {}), ...(str(args, 'model') ? { model: str(args, 'model') } : {}), ...(str(args, 'agent') ? { agent: str(args, 'agent') } : {}), ...(str(args, 'device') ? { device: str(args, 'device') } : {}), ...(str(args, 'cwd') ? { cwd: str(args, 'cwd') } : {}), ...(str(args, 'title') ? { title: str(args, 'title') } : {}) });
      if (asJson) return json(session), 0;
      print(`${p.green('✓')} Forked as ${session.id}: ${session.title}.`);
      print(p.dim(`  ${s.friendName}'s turns are quoted. The first turn asks before every tool call; your own message after it lifts that.`));
      return 0;
    }
    case 'handoff': {
      const s = await receivedOne(client, what, 'conclave friends shares handoff <share>');
      const file = str(args, 'brief-file');
      if (!file && !bool(args, 'yes')) {
        const draft = await client.handoffDraft(s.id);
        if (asJson) return json(draft), 0;
        print(draft.brief);
        print('');
        print(p.dim(`Edit it into a file and start with --brief-file <file>, or start as it is with --yes.`));
        return 0;
      }
      const brief = file ? readFileSync(file, 'utf8') : (await client.handoffDraft(s.id)).brief;
      const session = await client.handoffShare(s.id, { brief, ...(str(args, 'model') ? { model: str(args, 'model') } : {}), ...(str(args, 'agent') ? { agent: str(args, 'agent') } : {}), ...(str(args, 'device') ? { device: str(args, 'device') } : {}), ...(str(args, 'cwd') ? { cwd: str(args, 'cwd') } : {}), ...(str(args, 'title') ? { title: str(args, 'title') } : {}) });
      if (asJson) return json(session), 0;
      print(`${p.green('✓')} Started ${session.id}: ${session.title}. Its first turn asks before every tool call.`);
      return 0;
    }
    case 'reference': {
      const s = await receivedOne(client, what, 'conclave friends shares reference <share>');
      const session = await client.referenceShare(s.id);
      if (asJson) return json(session), 0;
      print(`${p.green('✓')} Kept as ${session.id}, read only. Your agents can find it with past chat search, marked as ${s.friendName}'s.`);
      return 0;
    }
    case 'apply': {
      const s = await receivedOne(client, what, 'conclave friends shares apply <share> --device D --cwd P');
      const device = str(args, 'device');
      const cwd = str(args, 'cwd');
      if (!device || !cwd) throw new CliError('Usage: conclave friends shares apply <share> --device D --cwd P [--branch B] [--yes]');
      const plan = await client.planApplyShare(s.id, { device, cwd, ...(str(args, 'branch') ? { branch: str(args, 'branch') } : {}) });
      if (asJson && !bool(args, 'yes')) return json(plan), 0;
      print(`${plan.kind === 'diff' ? 'Diff' : 'Git bundle'} of ${plural(plan.files.length, 'file')} onto a new branch ${p.bold(plan.branch)} in ${plan.root} on ${plan.deviceName}${plan.base ? `, from ${plan.base.slice(0, 10)}` : ''}.`);
      print(p.dim('  Nothing is checked out, your working tree stays as it is, and no hook or script from the share runs.'));
      if (plan.runsCode.length) print(p.yellow(`  These can run code once you check out or build: ${plan.runsCode.join(', ')}. Read them first.`));
      if (!plan.check.ok) throw new CliError(`It would not apply: ${plan.check.error}`);
      if (!bool(args, 'yes')) {
        print(p.dim('Run it again with --yes to apply.'));
        return 0;
      }
      const done = await client.applyShare(s.id, plan.planId);
      if (asJson) return json(done), 0;
      print(`${p.green('✓')} ${done.branch} is at ${done.commit.slice(0, 12)}.`);
      return 0;
    }
    case 'update': {
      const s = findShare(await client.sentShares(), what, 'conclave friends shares update <sent>');
      const done = await client.updateShare(s.id, { ...contentFlags(args), ...(str(args, 'title') ? { title: str(args, 'title') } : {}), ...(str(args, 'note') ? { note: str(args, 'note') } : {}) });
      if (asJson) return json(done), 0;
      print(`${p.green('✓')} Sent revision ${done.revision} of '${done.title}' ${describeSummary(done.kind, done.summary)}.`);
      return 0;
    }
    case 'unsend':
    case 'revoke': {
      const s = findShare(await client.sentShares(), what, 'conclave friends shares unsend <sent>');
      const done = await client.unsendShare(s.id);
      if (asJson) return json(done), 0;
      const names = done.recipients.map((r) => r.friendName);
      print(`${p.green('✓')} Unsent '${done.title}'. ${names.length ? `${names.join(', ')}'s hub${names.length > 1 ? 's are' : ' is'} asked to delete the copy.` : ''}`);
      return 0;
    }
    default:
      throw new CliError(`Unknown shares command "${sub}". Try:\n       ${USAGE}`);
  }
}
