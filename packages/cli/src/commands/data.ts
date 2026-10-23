/** Read-mostly commands: sessions, models, agents, usage, limits, routines, memory, tasks, import. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Message, TextBlock } from '@conclave/core/types.ts';
import { sessionRepo as repoOf } from '@conclave/core/client/github.ts';
import { out as p, truncate } from '../ansi';
import { bool, num, str, type ParsedArgs } from '../args';
import { formatCost, formatDuration, formatTokens, relativeTime, shortenPath } from '../render/format';
import { renderMarkdown } from '../render/markdown';
import { modelColor, shortModel } from '../render/models';
import { toolTitle } from '../render/tools';
import { bar, CliError, getClient, json, print, requireArg, table } from './shared';

const termWidth = () => Math.min(process.stdout.columns || 100, 120);

function statusColor(s: string): string {
  switch (s) {
    case 'running':
      return p.cyan(s);
    case 'waiting_approval':
    case 'waiting_input':
      return p.yellow(s);
    case 'waiting_reset':
      return p.magenta(s);
    case 'error':
      return p.red(s);
    default:
      return p.dim(s);
  }
}

export async function sessionsCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'ls';
  // a chat or session to a friend's hub (commands/shares.ts)
  if (sub === 'send') return (await import('./shares')).sendSessionCommand(args);
  const { client } = await getClient(args);
  // repo sessions on GitHub (commands/github.ts)
  if (['new', 'push', 'pr', 'cleanup', 'clean-up', 'repo'].includes(sub)) return (await import('./github')).repoSessionCommand(sub, args, client);
  if (sub === 'ls' || sub === 'list') {
    const list = await client.listSessions({ limit: num(args, 'limit') ?? 30, archived: bool(args, 'all') ? undefined : false, search: str(args, 'search') });
    if (bool(args, 'json')) return json(list), 0;
    if (!list.length) return print(p.dim('No sessions yet. Start one with `conclave`.')), 0;
    const w = termWidth();
    print(
      table(
        list.map((s) => [
          p.dim(s.id),
          truncate(s.title || '(untitled)', Math.max(16, w - 80)),
          p.fg(modelColor(s.model))(shortModel(s.model)),
          statusColor(s.status),
          relativeTime(s.updatedAt),
          // a repo session says its repository and branch instead of the worktree's path
          p.dim(repoOf(s) ? `${repoOf(s)!.repo} ${repoOf(s)!.branch}` : shortenPath(s.cwd, 28)),
        ]),
        { header: ['ID', 'TITLE', 'MODEL', 'STATUS', 'UPDATED', 'WHERE'] },
      ),
    );
    return 0;
  }
  if (sub === 'show') {
    const id = requireArg(args._[2], 'conclave sessions show <id>');
    const [s, msgs] = await Promise.all([client.getSession(id), client.messages(id)]);
    if (bool(args, 'json')) return json({ session: s, messages: msgs }), 0;
    print(p.bold(s.title || '(untitled)') + ' ' + p.dim(s.id));
    print(
      p.dim(
        `${shortModel(s.model)} · ${s.agent} · ${s.mode} · ${s.device}:${shortenPath(s.cwd)} · ${s.status} · ${formatTokens(s.stats.inputTokens)} in / ${formatTokens(s.stats.outputTokens)} out · ${formatCost(s.stats.costUsd)}`,
      ),
    );
    const repo = repoOf(s);
    if (repo) {
      const r = await client.sessionRepo(s.id).catch(() => undefined);
      print(p.dim(r ? (await import('./github')).repoLine(r) : `${repo.repo} on ${repo.branch}`));
    }
    print('');
    for (const m of msgs) printMessageText(m, s.cwd);
    return 0;
  }
  if (sub === 'rm' || sub === 'delete') {
    const ids = args._.slice(2);
    if (!ids.length) throw new CliError('Usage: conclave sessions rm <id> [id...]');
    for (const id of ids) {
      await client.deleteSession(id);
      print(`${p.green('✓')} Deleted ${id}`);
    }
    return 0;
  }
  if (sub === 'export') {
    const id = requireArg(args._[2], 'conclave sessions export <id> [--format md|json] [--thinking] [--raw] [-o file]');
    const format = str(args, 'format') === 'json' ? 'json' : 'md';
    // the hub sanitizes by default; --raw (owner token only) is the stored rows, for backups
    const res = await client.exportSession(id, format, { ...(bool(args, 'thinking') ? { thinking: true } : {}), raw: bool(args, 'raw') });
    const outFile = str(args, 'out');
    if (outFile) {
      const path = resolve(outFile === '.' ? res.filename : outFile);
      writeFileSync(path, res.content);
      print(`${p.green('✓')} Wrote ${path}`);
    } else process.stdout.write(res.content.endsWith('\n') ? res.content : res.content + '\n');
    return 0;
  }
  throw new CliError(`Unknown sessions command "${sub}". Use ls, show, new, push, pr, cleanup, rm, export or send.`);
}

function printMessageText(m: Message, cwd: string): void {
  const w = termWidth();
  const texts = m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text);
  if (m.kind === 'notice') {
    print(p.dim(`· ${texts.join(' ')}`));
    return;
  }
  // quoted from a friend's hub (a fork or a reference of a share)
  const quoted = (m.meta?.quoted as { from?: unknown } | undefined)?.from;
  const from = () => typeof quoted === 'string' && print(p.dim(`quoted from ${quoted}:`));
  if (m.role === 'user') {
    if (!texts.length) return;
    from();
    print(p.bold('> ') + texts.join('\n').split('\n').join('\n  '));
    print('');
    return;
  }
  const label = m.kind === 'aside' ? `◆ ${m.author ?? 'Aside'} · ` : m.kind === 'summary' ? '※ Summary · ' : '';
  from();
  if (label || m.model) print(p.fg(modelColor(m.model))(`${label}${shortModel(m.model)}`));
  for (const b of m.content) {
    if (b.type === 'text') print(p.enabled ? renderMarkdown(b.text, { width: w - 2, painter: p }) : b.text);
    else if (b.type === 'tool_use') {
      const t = toolTitle(b.name, b.input, cwd);
      print(p.dim(`● ${t.name} ${t.detail}`));
    } else if (b.type === 'thinking') print(p.dim(p.italic(`✻ thinking (${b.thinking.split(/\s+/).length} words)`)));
  }
  print('');
}

export async function modelsCommand(args: ParsedArgs): Promise<number> {
  const { client } = await getClient(args);
  const groups = await client.models();
  if (bool(args, 'json')) return json(groups), 0;
  for (const g of groups) {
    const state = !g.enabled ? p.dim('disabled') : g.configured ? p.green('ready') : p.yellow('no key');
    // a model the owner's order reaches through another provider is listed once, there (providers/merge.ts)
    const models = g.models.filter((m) => !m.sameAs);
    const merged = g.models.length - models.length;
    print(`${p.bold(g.name || g.provider)} ${p.dim(`(${g.provider}, ${g.type})`)} ${state}${g.error ? ' ' + p.red(g.error) : ''}${merged ? p.dim(` ${merged} listed once under another route`) : ''}`);
    if (!models.length) {
      if (!merged) print(p.dim('  (no models listed)'));
      continue;
    }
    const rows = models.map((m) => [
      '  ' + p.fg(modelColor(m.ref))('●') + ' ' + (m.name || m.ref),
      p.dim(m.ref),
      p.dim(m.contextWindow ? formatTokens(m.contextWindow) + ' ctx' : ''),
      p.dim(m.via ?? (m.inputPrice || m.outputPrice ? `$${m.inputPrice}/$${m.outputPrice} per M` : '')),
      p.dim([m.vision ? 'vision' : '', m.thinking ? 'thinking' : '', m.tier ?? ''].filter(Boolean).join(' ')),
    ]);
    print(table(rows));
  }
  return 0;
}

export async function agentsCommand(args: ParsedArgs): Promise<number> {
  const { client } = await getClient(args);
  const agents = await client.agents();
  if (bool(args, 'json')) return json(agents), 0;
  const w = termWidth();
  print(
    table(
      agents.map((a) => [p.bold(a.name), a.model ? p.fg(modelColor(a.model))(shortModel(a.model)) : p.dim('default'), p.dim(a.source), truncate(a.description || '', Math.max(20, w - 60))]),
      { header: ['AGENT', 'MODEL', 'SOURCE', 'DESCRIPTION'] },
    ),
  );
  return 0;
}

export async function usageCommand(args: ParsedArgs): Promise<number> {
  const days = num(args, 'days') ?? 7;
  const { client } = await getClient(args);
  const now = Date.now();
  const u = await client.usage({ from: now - days * 86_400_000, to: now, tzOffset: new Date().getTimezoneOffset() });
  if (bool(args, 'json')) return json(u), 0;
  const t = u.totals;
  print(p.bold(`Usage, last ${days} day${days === 1 ? '' : 's'}`));
  print(
    `  ${formatTokens(t.inputTokens)} in · ${formatTokens(t.outputTokens)} out · ${formatTokens(t.cacheReadTokens)} cache read · ${p.bold(formatCost(t.costUsd))} · ${t.calls} calls`,
  );
  print(`  cache hit ${Math.round(u.cacheHitRate * 100)}% · saved ${formatCost(u.cacheSavingsUsd)}`);
  const section = (title: string, rows: typeof u.byModel, color = false) => {
    if (!rows.length) return;
    print('');
    const max = Math.max(...rows.map((r) => r.costUsd), 0.000001);
    print(
      table(
        rows.map((r) => [
          color ? p.fg(modelColor(r.key))(r.key) : r.key,
          formatTokens(r.inputTokens),
          formatTokens(r.outputTokens),
          formatCost(r.costUsd),
          p.dim('█'.repeat(Math.max(r.costUsd > 0 ? 1 : 0, Math.round((r.costUsd / max) * 20)))),
        ]),
        { header: [title, 'IN', 'OUT', 'COST', ''] },
      ),
    );
  };
  section('MODEL', u.byModel, true);
  section('SOURCE', u.bySource);
  section('DAY', u.byDay);
  return 0;
}

export async function limitsCommand(args: ParsedArgs): Promise<number> {
  const { client } = await getClient(args);
  const limits = await client.limits();
  if (bool(args, 'json')) return json(limits), 0;
  if (!limits.length) return print(p.dim('No limit data yet. It appears after the first calls to each provider.')), 0;
  for (const l of limits) {
    print(`${p.bold(l.label || l.provider)} ${p.dim(`(${l.provider}, ${l.source}, ${relativeTime(l.updatedAt)})`)}${l.blocked ? ' ' + p.red('blocked') : ''}`);
    for (const w of l.windows) {
      const pct = w.usedPercent ?? (w.limit && w.remaining !== undefined ? ((w.limit - w.remaining) / w.limit) * 100 : undefined);
      const reset = w.resetsAt ? p.dim(` resets in ${formatDuration(w.resetsAt - Date.now())}`) : '';
      const rem = w.remaining !== undefined && w.limit ? p.dim(` ${w.remaining}/${w.limit} left`) : '';
      print(`  ${w.name.padEnd(10)} ${pct !== undefined ? bar(pct) + ' ' + String(Math.round(pct)).padStart(3) + '%' : p.dim('n/a')}${rem}${reset}`);
    }
  }
  return 0;
}

export async function routinesCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'ls';
  const { client } = await getClient(args);
  if (sub === 'run') {
    const id = requireArg(args._[2], 'conclave routines run <id>');
    const run = await client.runRoutine(id);
    print(`${p.green('✓')} Started routine ${id}${run.sessionId ? ` in session ${run.sessionId}` : ''} ${p.dim(`(${run.status})`)}`);
    return 0;
  }
  if (sub !== 'ls' && sub !== 'list') throw new CliError('Usage: conclave routines [ls | run <id>]');
  const list = await client.routines();
  if (bool(args, 'json')) return json(list), 0;
  if (!list.length) return print(p.dim('No routines. Create them in the web app or ~/.conclave config.')), 0;
  print(
    table(
      list.map((r) => [
        p.dim(r.id),
        r.enabled ? p.bold(r.name) : p.dim(r.name),
        r.schedule,
        r.agent,
        r.nextRunAt ? relativeTime(r.nextRunAt) : '-',
        r.lastRunAt ? relativeTime(r.lastRunAt) : '-',
      ]),
      { header: ['ID', 'NAME', 'SCHEDULE', 'AGENT', 'NEXT', 'LAST'] },
    ),
  );
  return 0;
}

export async function memoryCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'ls';
  const { client } = await getClient(args);
  const w = termWidth();
  if (sub === 'add') {
    const text = requireArg(args._.slice(2).join(' '), 'conclave memory add <text>');
    const m = await client.saveMemory({ content: text, kind: 'fact', scope: 'global' });
    print(`${p.green('✓')} Saved memory ${p.dim(m.id)}`);
    return 0;
  }
  if (sub === 'search') {
    const q = requireArg(args._.slice(2).join(' '), 'conclave memory search <query>');
    const hits = await client.searchMemory(q, num(args, 'limit') ?? 20);
    if (bool(args, 'json')) return json(hits), 0;
    if (!hits.length) return print(p.dim('No matches.')), 0;
    for (const h of hits) print(`${p.dim(h.score.toFixed(2))} ${p.cyan(h.kind)} ${truncate(h.content.replace(/\s+/g, ' '), w - 20)}`);
    return 0;
  }
  if (sub !== 'ls' && sub !== 'list') throw new CliError('Usage: conclave memory [ls | search <query> | add <text>]');
  const list = await client.memories({ limit: num(args, 'limit') ?? 50 });
  if (bool(args, 'json')) return json(list), 0;
  if (!list.length) return print(p.dim('No memories yet.')), 0;
  for (const m of list) print(`${p.dim(m.id)} ${p.cyan(m.kind.padEnd(9))} ${p.dim(m.scope.padEnd(7))} ${truncate(m.content.replace(/\s+/g, ' '), w - 50)}`);
  return 0;
}

export async function tasksCommand(args: ParsedArgs): Promise<number> {
  const sub = args._[1] ?? 'ls';
  const { client } = await getClient(args);
  if (sub === 'add') {
    const title = requireArg(args._.slice(2).join(' '), 'conclave tasks add <title>');
    const t = await client.createTask({ title, status: 'inbox' });
    print(`${p.green('✓')} Added task ${p.dim(t.id)} ${t.title}`);
    return 0;
  }
  if (sub !== 'ls' && sub !== 'list') throw new CliError('Usage: conclave tasks [ls | add <title>]');
  const list = await client.tasks();
  if (bool(args, 'json')) return json(list), 0;
  if (!list.length) return print(p.dim('No tasks.')), 0;
  const icon: Record<string, string> = { inbox: '○', todo: '☐', doing: p.yellow('◐'), review: p.cyan('◑'), done: p.green('☑') };
  print(table(list.map((t) => [icon[t.status] ?? '·', p.dim(t.id), t.status === 'done' ? p.dim(t.title) : t.title, p.dim(t.status), t.agent ? p.dim('@' + t.agent) : '']), {}));
  return 0;
}

export async function importCommand(args: ParsedArgs): Promise<number> {
  const source = args._[1] as 'claude-code' | 'codex' | undefined;
  if (source && source !== 'claude-code' && source !== 'codex') throw new CliError('Usage: conclave import [claude-code|codex] [id]');
  const device = str(args, 'device') ?? 'local';
  const { client } = await getClient(args);
  const id = args._[2];
  if (source && id) {
    const s = await client.importSession(source, id, device);
    print(`${p.green('✓')} Imported as ${p.bold(s.id)} ${s.title}`);
    print(p.dim(`  Continue it: conclave -r ${s.id}`));
    return 0;
  }
  const list = (await client.externalSessions(device)).filter((s) => !source || s.source === source);
  if (bool(args, 'json')) return json(list), 0;
  if (!list.length) return print(p.dim('No Claude Code or Codex sessions found on ' + device + '.')), 0;
  const w = termWidth();
  print(
    table(
      list.slice(0, num(args, 'limit') ?? 40).map((s) => [p.cyan(s.source), p.dim(s.id), truncate(s.title || '(untitled)', Math.max(20, w - 90)), String(s.messages), relativeTime(s.updatedAt), p.dim(shortenPath(s.cwd ?? '', 26))]),
      { header: ['SOURCE', 'ID', 'TITLE', 'MSGS', 'UPDATED', 'CWD'] },
    ),
  );
  print(p.dim('\nImport one: conclave import <source> <id>'));
  return 0;
}
