/**
 * `conclave github` and the repo session commands of `conclave sessions`
 * (docs/DESIGN.md 30). The token goes to the hub once, from a hidden prompt
 * or stdin, and never comes back.
 */
import type { ConclaveClient, GithubStatusDto, RepoSessionDto } from '@conclave/core/client/index.ts';
import { out as p, truncate } from '../ansi';
import { bool, str, type ParsedArgs } from '../args';
import { relativeTime } from '../render/format';
import { CliError, getClient, json, print, prompt, requireArg, table } from './shared';

const USAGE = [
  'conclave github login             give the hub a GitHub token (asked for, or read from stdin)',
  'conclave github status            who the token is',
  'conclave github repos [words]     repositories it can see, filtered by the words',
  'conclave github logout            remove the token from the hub',
].join('\n       ');

function statusLines(st: GithubStatusDto): string[] {
  if (st.connected) {
    const who = st.name ? `@${st.login} (${st.name})` : `@${st.login}`;
    const repos = st.repos !== undefined ? ` It can see ${st.repos} ${st.repos === 1 ? 'repository' : 'repositories'}.` : '';
    const from = st.source === 'env' ? p.dim(' (from CONCLAVE_GITHUB_TOKEN)') : st.source === 'mcp' ? p.dim(' (shared with the GitHub MCP server: secret github-pat)') : '';
    return [`${p.green('✓')} Connected as ${who}.${repos}${from}`, ...(st.apiUrl ? [p.dim(`API: ${st.apiUrl}`)] : [])];
  }
  if (st.error) return [`${p.red('✗')} ${st.error}`];
  return ['Not connected. Make a fine-grained token on github.com (docs/INSTALL.md, GitHub) and run: conclave github login'];
}

export async function githubCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'status';
  const { client } = await getClient(args);
  switch (sub) {
    case 'login': {
      const value = await prompt('GitHub token (input hidden): ', { hidden: true });
      if (!value.trim()) throw new CliError('Empty token, nothing saved.');
      const st = await client.githubConnect(value.trim());
      if (bool(args, 'json')) return json(st), 0;
      for (const l of statusLines(st)) print(l);
      return 0;
    }
    case 'logout': {
      const st = await client.githubDisconnect();
      if (bool(args, 'json')) return json(st), 0;
      print(`${p.green('✓')} Removed the GitHub token from the hub.`);
      if (st.source === 'env') print(p.dim('CONCLAVE_GITHUB_TOKEN is still set where the hub runs.'));
      if (st.source === 'mcp') print(p.dim('The GitHub MCP server token (secret github-pat) is still set; the hub uses it.'));
      return 0;
    }
    case 'status': {
      const st = await client.github();
      if (bool(args, 'json')) return json(st), 0;
      for (const l of statusLines(st)) print(l);
      return 0;
    }
    case 'repos':
    case 'ls': {
      const list = await client.githubRepos(args._.slice(2).join(' ') || undefined, bool(args, 'refresh'));
      if (bool(args, 'json')) return json(list), 0;
      if (!list.length) return print(p.dim('No repositories match.')), 0;
      print(
        table(
          list.map((r) => [r.fullName, r.private ? 'private' : 'public', r.defaultBranch, r.canPush ? '' : p.yellow('read only'), r.pushedAt ? relativeTime(r.pushedAt) : '', p.dim(truncate(r.description ?? '', 50))]),
          { header: ['REPOSITORY', 'VISIBILITY', 'DEFAULT', 'ACCESS', 'PUSHED', 'DESCRIPTION'] },
        ),
      );
      return 0;
    }
    default:
      throw new CliError(`Unknown github command "${sub}". Usage: ${USAGE}`);
  }
}

/** The repo line under a session: "acme/widgets on conclave/fix-ab12. Pull request #3 is open." */
export function repoLine(r: RepoSessionDto): string {
  return `${r.repo} on ${r.branch}. ${r.line}${r.pr ? ` ${r.pr.url}` : ''}`;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const a = await prompt(`${question} [y/N] `);
  return /^y(es)?$/i.test(a.trim());
}

/** conclave sessions new | push | pr | cleanup | repo. */
export async function repoSessionCommand(sub: string, args: ParsedArgs, client: ConclaveClient): Promise<number> {
  if (sub === 'new') {
    const repo = str(args, 'repo');
    const task = args._.slice(2).join(' ').trim() || undefined;
    const common = { agent: str(args, 'agent'), model: str(args, 'model'), device: str(args, 'device'), title: str(args, 'title'), prompt: task };
    if (!repo) {
      const s = await client.createSession({ ...common, cwd: str(args, 'cwd') });
      if (bool(args, 'json')) return json(s), 0;
      print(`${p.green('✓')} Started ${s.id} in ${s.cwd}`);
      return 0;
    }
    const s = await client.createRepoSession({ repo, base: str(args, 'base'), ...common });
    if (bool(args, 'json')) return json(s), 0;
    const meta = s.meta?.repo as { branch?: string; base?: string } | undefined;
    print(`${p.green('✓')} Started ${s.id} on ${meta?.branch ?? 'a new branch'} from ${meta?.base ?? 'the default branch'} of ${repo}`);
    print(p.dim(`Folder: ${s.cwd}`));
    return 0;
  }
  const id = requireArg(args._[2], `conclave sessions ${sub} <id>`);
  if (sub === 'repo') {
    const r = await client.sessionRepo(id, true);
    if (bool(args, 'json')) return json(r), 0;
    print(repoLine(r));
    return 0;
  }
  if (sub === 'push') {
    const r = await client.pushSession(id, str(args, 'message') ? { commitMessage: str(args, 'message') } : {});
    if (bool(args, 'json')) return json(r), 0;
    print(`${r.pushed ? p.green('✓') : p.dim('·')} ${r.line}`);
    return 0;
  }
  if (sub === 'pr') {
    const draft = await client.prDraft(id);
    const title = str(args, 'title') ?? draft.title;
    const body = str(args, 'body') ?? draft.body;
    if (!bool(args, 'json')) {
      print(p.bold(title));
      print(p.dim(`${draft.head} into ${draft.base}`));
      print('');
      print(body);
      print('');
    }
    if (!bool(args, 'yes') && !(await confirm('Open this pull request?'))) throw new CliError('Not opened. Pass --yes to open it without asking.');
    const r = await client.openPullRequest(id, { title, body, ...(bool(args, 'draft') ? { draft: true } : {}) });
    if (bool(args, 'json')) return json(r), 0;
    print(`${p.green('✓')} Opened pull request #${r.pr?.number}: ${r.pr?.url}`);
    return 0;
  }
  if (sub === 'cleanup' || sub === 'clean-up') {
    const r = await client.cleanupSession(id, bool(args, 'force') ? { force: true } : {});
    if (bool(args, 'json')) return json(r), 0;
    print(`${p.green('✓')} ${r.line}`);
    return 0;
  }
  throw new CliError(`Unknown sessions command "${sub}".`);
}
