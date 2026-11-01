/** Built-in slash commands. Anything else goes to the hub as a custom command. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionMode } from '@conclave/core/types.ts';
import { effortChoices, effortLabel, isEffortSetting } from '@conclave/core/providers/effort.ts';
import { tui as p, truncate } from '../ansi';
import { formatCost, formatDuration, formatTokens, relativeTime, shortenPath, worth } from '../render/format';
import { modelColor, shortModel } from '../render/models';
import { renderTodos } from '../render/tools';
import type { ChatController } from './controller';
import type { CommandInfo } from './complete';

export interface PickerItem {
  label: string;
  value: string;
  hint?: string;
  color?: string;
  current?: boolean;
}

export interface PickerSpec {
  title: string;
  items: PickerItem[];
  onSelect: (item: PickerItem, alt: boolean) => void | Promise<void>;
  hint?: string;
  /** A second action on another key (e.g. "f" to also restore files). */
  altKey?: string;
}

export interface SlashHost {
  ctl: ChatController;
  openPicker(spec: PickerSpec): void;
  exit(): void;
  width(): number;
}

export interface BuiltinCommand extends CommandInfo {
  run(host: SlashHost, arg: string): void | Promise<void>;
}

const MODES: SessionMode[] = ['agent', 'chat', 'plan', 'jury', 'debate', 'loop'];

function list(lines: string[]): string {
  return lines.join('\n');
}

async function modelPicker(host: SlashHost, title: string, onPick: (ref: string) => void | Promise<void>): Promise<void> {
  const { ctl } = host;
  if (!ctl.models.length) await ctl.refreshMeta();
  const cur = ctl.currentModel();
  // one row per model: a model the owner's order reaches twice shows once, with its route (providers/merge.ts)
  const shown = new Map(ctl.models.flatMap((g) => g.models.map((m) => [m.ref, m.sameAs ?? m.ref] as const)));
  const items = ctl.models
    .filter((g) => g.enabled)
    .flatMap((g) =>
      g.models
        .filter((m) => !m.sameAs)
        .map((m) => ({
          label: m.name && m.name !== m.id ? `${m.name}  ${m.ref}` : m.ref,
          value: m.ref,
          hint: `${m.via ?? `${g.name || g.provider}${g.configured ? '' : ' (no key)'}`}${m.contextWindow ? ' · ' + formatTokens(m.contextWindow) : ''}${!m.via && m.inputPrice ? ` · $${m.inputPrice}/$${m.outputPrice}` : ''}`,
          color: modelColor(m.ref),
          current: m.ref === (cur && shown.get(cur)),
        })),
    );
  if (!items.length) return ctl.notice('The hub listed no models. Check `conclave doctor`.', 'warning');
  host.openPicker({ title, items, onSelect: (it) => onPick(it.value), hint: 'type to search · enter select · esc cancel' });
}

export const BUILTINS: BuiltinCommand[] = [
  {
    name: 'help',
    description: 'Commands and keys',
    run: ({ ctl }) => {
      const col = (name: string, args?: string) => {
        const plain = `/${name}${args ? ' ' + args : ''}`;
        const w = 30;
        const shown = plain.length > w - 2 ? truncate(plain, w - 2) : plain;
        return '  ' + p.bold(shown.slice(0, name.length + 1)) + p.dim(shown.slice(name.length + 1)) + ' '.repeat(Math.max(1, w - shown.length));
      };
      const cmds = BUILTINS.filter((c) => c.name !== 'exit').map((c) => col(c.name, c.args) + p.dim(c.description ?? ''));
      const custom = ctl.commands.map((c) => col(c.name, c.argumentHint) + p.dim(`${c.description ?? ''} (${c.source})`));
      const keys = [
        ['enter', 'send'],
        ['\\ enter, ctrl+j', 'new line'],
        ['esc', 'interrupt the running turn'],
        ['ctrl+c', 'clear input, twice to exit'],
        ['shift+tab', 'cycle permission mode'],
        ['ctrl+t', 'show or hide thinking'],
        ['ctrl+l', 'redraw the screen'],
        ['up/down', 'history'],
        ['@path', 'mention a file (tab completes)'],
      ];
      ctl.info(
        list([
          p.bold('Commands'),
          ...cmds,
          ...(custom.length ? ['', p.bold('Custom commands'), ...custom] : []),
          '',
          p.bold('Keys'),
          ...keys.map(([k, d]) => `  ${k.padEnd(18)}${p.dim(d)}`),
        ]),
      );
    },
  },
  { name: 'new', description: 'Start a new session', run: ({ ctl }) => ctl.newSession() },
  { name: 'clear', description: 'Clear the screen and start a new session', run: ({ ctl }) => ctl.newSession() },
  {
    name: 'sessions',
    description: 'Pick a session to resume',
    run: async (host) => {
      const { ctl } = host;
      const list = await ctl.client.listSessions({ limit: 100, archived: false });
      if (!list.length) return ctl.notice('No sessions yet.');
      const cwd = ctl.currentCwd();
      list.sort((a, b) => Number(b.cwd === cwd) - Number(a.cwd === cwd) || b.updatedAt - a.updatedAt);
      host.openPicker({
        title: 'Resume a session',
        items: list.map((s) => ({
          label: truncate(s.title || '(untitled)', 50),
          value: s.id,
          hint: `${relativeTime(s.updatedAt)} · ${shortModel(s.model)} · ${s.stats.messages} msgs · ${shortenPath(s.cwd, 30)}`,
          color: modelColor(s.model),
          current: s.id === ctl.session?.id,
        })),
        onSelect: (it) => ctl.resume(it.value),
      });
    },
  },
  {
    name: 'resume',
    args: '[id]',
    description: 'Resume a session by id, or pick one',
    run: async (host, arg) => {
      if (arg) return host.ctl.resume(arg.trim());
      return BUILTINS.find((c) => c.name === 'sessions')!.run(host, '');
    },
  },
  {
    name: 'model',
    args: '[provider/model]',
    description: 'Switch the model for this session',
    run: async (host, arg) => {
      if (arg) return host.ctl.patchSession({ model: arg.trim() });
      await modelPicker(host, 'Model', (ref) => host.ctl.patchSession({ model: ref }));
    },
  },
  {
    name: 'effort',
    args: '[level|default]',
    description: 'How hard the model thinks',
    run: async (host, arg) => {
      const { ctl } = host;
      if (!ctl.models.length) await ctl.refreshMeta();
      const e = ctl.modelEffort();
      if (!e) return ctl.notice(`${shortModel(ctl.currentModel())} has no effort control.`, 'warning');
      const set = (v: string) => ctl.patchSession({ chat: { thinking: v === 'default' ? null : (v as never) } });
      const a = arg.trim().toLowerCase();
      if (a) {
        if (a !== 'default' && !isEffortSetting(a)) return ctl.notice(`Unknown effort "${a}". Use ${[...effortChoices(e), 'default'].join(', ')}.`, 'warning');
        return set(a);
      }
      const cur = ctl.currentEffort();
      host.openPicker({
        title: `Effort · ${shortModel(ctl.currentModel())}`,
        items: [
          { label: "Agent's default", value: 'default', hint: e.default ? `the model's default is ${effortLabel(e.default, e).toLowerCase()}` : '', current: !cur },
          ...effortChoices(e).map((s) => ({ label: effortLabel(s, e), value: s, hint: s === e.default ? 'model default' : '', current: s === cur })),
        ],
        onSelect: (it) => set(it.value),
      });
    },
  },
  {
    name: 'queue',
    description: 'Messages waiting for the running turn',
    run: (host) => {
      const { ctl } = host;
      const s = ctl.session;
      const queue = ctl.getSnapshot().queue;
      if (!s || !queue.length) return ctl.notice('Nothing is waiting.');
      host.openPicker({
        title: 'Waiting messages',
        items: queue.map((q) => ({ label: truncate(q.text.replace(/\s+/g, ' '), 70), value: q.id, hint: q.held ? 'held by Stop' : q.whenBusy === 'steer' ? 'joins the running turn' : `queued ${relativeTime(q.at)}` })),
        altKey: 'x',
        hint: 'enter send a held one now · x remove · esc close',
        onSelect: async (it, remove) => {
          const q = queue.find((x) => x.id === it.value);
          try {
            if (remove) await ctl.client.unqueue(s.id, it.value);
            else if (q?.held) await ctl.client.sendQueued(s.id, it.value);
            else ctl.notice('It runs when the current turn ends.');
          } catch (e) {
            ctl.error(e);
          }
        },
      });
    },
  },
  {
    name: 'agent',
    args: '[name]',
    description: 'Switch the agent profile',
    run: async (host, arg) => {
      const { ctl } = host;
      if (arg) return ctl.patchSession({ agent: arg.trim() });
      const agents = await ctl.client.agents();
      ctl.agents = agents;
      const cur = ctl.session?.agent ?? ctl.getSnapshot().draft.agent;
      host.openPicker({
        title: 'Agent',
        items: agents.filter((a) => a.primary !== false).map((a) => ({ label: a.name, value: a.name, hint: a.description ?? '', color: a.color, current: a.name === cur })),
        onSelect: (it) => ctl.patchSession({ agent: it.value }),
      });
    },
  },
  {
    name: 'mode',
    args: '[agent|chat|plan|jury|debate|loop]',
    description: 'Switch the session mode',
    run: (host, arg) => {
      const { ctl } = host;
      if (arg) {
        const m = arg.trim() as SessionMode;
        if (!MODES.includes(m)) return ctl.notice(`Unknown mode "${m}". Use ${MODES.join(', ')}.`, 'warning');
        return ctl.patchSession({ mode: m });
      }
      const cur = ctl.session?.mode ?? ctl.getSnapshot().draft.mode ?? 'agent';
      host.openPicker({ title: 'Mode', items: MODES.map((m) => ({ label: m, value: m, current: m === cur })), onSelect: (it) => ctl.patchSession({ mode: it.value as SessionMode }) });
    },
  },
  {
    name: 'jury',
    args: '[models...|off]',
    description: 'Ask several models; a judge writes the verdict',
    run: async ({ ctl }, arg) => {
      const parts = arg.split(/[\s,]+/).filter(Boolean);
      if (parts[0] === 'off') return ctl.patchSession({ mode: 'agent' });
      if (!parts.length) {
        await ctl.patchSession({ mode: 'jury' });
        return ctl.notice('Jury mode on with the default panel. Next prompts go to every juror.', 'success');
      }
      const s = await ctl.ensureSession();
      const base = s.modeConfig?.jury;
      await ctl.patchSession({ mode: 'jury', modeConfig: { ...s.modeConfig, jury: { strategy: 'synthesize', anonymize: true, jurorTools: 'none', ...base, jurors: parts } } });
      ctl.notice(`Jury: ${parts.map(shortModel).join(', ')}`, 'success');
    },
  },
  {
    name: 'debate',
    args: '<a> <b> [rounds]',
    description: 'Two models argue, a judge concludes',
    run: async ({ ctl }, arg) => {
      const [a, b, r] = arg.split(/\s+/).filter(Boolean);
      if (!a || !b) return ctl.notice('Usage: /debate <modelA> <modelB> [rounds]', 'warning');
      const rounds = Number(r) || 2;
      const s = await ctl.ensureSession();
      await ctl.patchSession({ mode: 'debate', modeConfig: { ...s.modeConfig, debate: { a, b, rounds } } });
      ctl.notice(`Debate: ${shortModel(a)} vs ${shortModel(b)}, ${rounds} rounds. Send the topic.`, 'success');
    },
  },
  {
    name: 'review',
    args: '[model] [focus]',
    description: 'Second opinion on the last answer',
    run: async ({ ctl }, arg) => {
      const s = ctl.session;
      if (!s) return ctl.notice('Nothing to review yet.', 'warning');
      const [first, ...rest] = arg.split(/\s+/).filter(Boolean);
      const reviewer = first && (first.includes('/') || first.startsWith('@')) ? first : undefined;
      const instructions = (reviewer ? rest : [first, ...rest].filter(Boolean)).join(' ') || undefined;
      try {
        await ctl.client.secondOpinion(s.id, { reviewer, instructions });
        ctl.notice(`Asked ${reviewer ? shortModel(reviewer) : 'the reviewer'} for a second opinion…`);
      } catch (e) {
        ctl.error(e);
      }
    },
  },
  {
    name: 'handoff',
    args: '<model> [brief]',
    description: 'Switch the conversation to another model (brief: a short handover)',
    run: async (host, arg) => {
      const { ctl } = host;
      const go = async (ref: string, brief = false) => {
        const s = await ctl.ensureSession();
        try {
          await ctl.client.handoff(s.id, ref, { brief });
          ctl.notice(`Switched to ${shortModel(ref)}${brief ? ' with a short handover' : ''}`, 'success');
        } catch (e) {
          ctl.error(e);
        }
      };
      const [ref, how] = (arg ?? '').trim().split(/\s+/);
      if (ref) return go(ref, how === 'brief');
      await modelPicker(host, 'Switch to', (r) => go(r));
    },
  },
  {
    name: 'device',
    args: '[id]',
    description: 'Run tools on another device',
    run: async (host, arg) => {
      const { ctl } = host;
      if (arg) return ctl.patchSession({ device: arg.trim() });
      const devices = await ctl.client.devices();
      const cur = ctl.currentDevice();
      host.openPicker({
        title: 'Device',
        items: devices.map((d) => ({
          label: d.name,
          value: d.id,
          hint: `${d.id} · ${d.online ? 'online' : 'offline'}${d.info ? ` · ${d.info.platform}` : ''}`,
          color: d.online ? '#4EC9B0' : '#808080',
          current: d.id === cur,
        })),
        onSelect: (it) => ctl.patchSession({ device: it.value }),
      });
    },
  },
  {
    name: 'cwd',
    args: '<path>',
    description: 'Change the working directory',
    run: ({ ctl }, arg) => {
      if (!arg.trim()) return ctl.notice(`cwd: ${ctl.currentCwd()}`);
      const cur = ctl.currentCwd();
      const next = arg.trim().startsWith('/') || arg.trim().startsWith('~') ? arg.trim() : resolve(cur, arg.trim());
      return ctl.patchSession({ cwd: next });
    },
  },
  { name: 'fork', description: 'Copy this session and continue in the copy', run: ({ ctl }) => ctl.fork() },
  {
    name: 'rewind',
    description: 'Go back to an earlier prompt',
    run: (host) => {
      const { ctl } = host;
      const msgs = ctl.store.getMessages().filter((m) => m.role === 'user' && m.kind === 'normal' && m.content.some((b) => b.type === 'text'));
      if (!msgs.length) return ctl.notice('No prompts to rewind to.', 'warning');
      host.openPicker({
        title: 'Rewind to before…',
        items: [...msgs].reverse().map((m) => ({
          label: truncate(
            m.content
              .filter((b) => b.type === 'text')
              .map((b) => (b as { text: string }).text)
              .join(' ')
              .replace(/\s+/g, ' '),
            70,
          ),
          value: String(m.seq),
          hint: relativeTime(m.createdAt),
        })),
        altKey: 'f',
        hint: 'enter rewind chat · f rewind chat and files · esc cancel',
        onSelect: (it, alt) => ctl.rewind(Number(it.value), alt),
      });
    },
  },
  {
    name: 'compact',
    description: 'Summarize older messages to free context',
    run: async ({ ctl }) => {
      const s = ctl.session;
      if (!s) return ctl.notice('Nothing to compact yet.');
      try {
        await ctl.client.compact(s.id);
        ctl.notice('Compacting…');
      } catch (e) {
        ctl.error(e);
      }
    },
  },
  {
    name: 'cost',
    description: 'Tokens and cost for this session',
    run: ({ ctl }) => {
      const s = ctl.session;
      if (!s) return ctl.notice('No session yet.');
      const st = s.stats;
      const hit = st.inputTokens + st.cacheReadTokens > 0 ? Math.round((st.cacheReadTokens / (st.inputTokens + st.cacheReadTokens)) * 100) : 0;
      ctl.info(
        list([
          p.bold('Session cost'),
          `  ${formatTokens(st.inputTokens)} in · ${formatTokens(st.outputTokens)} out · ${formatTokens(st.cacheReadTokens)} cache read (${hit}% hit)`,
          `  ${p.bold(formatCost(st.costUsd))}${worth(st.costUsd, st.apiValueUsd)} · ${st.messages} messages · ${s.id}`,
        ]),
      );
    },
  },
  {
    name: 'usage',
    args: '[days]',
    description: 'Usage across all sessions',
    run: async ({ ctl }, arg) => {
      const days = Number(arg) || 7;
      const now = Date.now();
      try {
        const u = await ctl.client.usage({ from: now - days * 86_400_000, to: now, tzOffset: new Date().getTimezoneOffset() });
        const rows = u.byModel.slice(0, 10).map((r) => `  ${p.fg(modelColor(r.key))(r.key.padEnd(36))} ${formatTokens(r.inputTokens).padStart(7)} in ${formatTokens(r.outputTokens).padStart(7)} out ${formatCost(r.costUsd).padStart(8)}${worth(r.costUsd, r.apiValueUsd)}`);
        const saved = u.savedUsd ?? 0;
        ctl.info(
          list([
            p.bold(`Usage, last ${days} days`),
            `  ${formatTokens(u.totals.inputTokens)} in · ${formatTokens(u.totals.outputTokens)} out · ${p.bold(formatCost(u.totals.costUsd))} billed${worth(u.totals.costUsd, u.totals.apiValueUsd)} · cache hit ${Math.round(u.cacheHitRate * 100)}% (saved ${formatCost(u.cacheSavingsUsd)})`,
            ...(saved >= 0.01 ? [`  Your plans saved you about ${formatCost(saved)}${u.totals.estimatedUsd ? ' (older calls estimated)' : ''}`] : []),
            ...rows,
          ]),
        );
      } catch (e) {
        ctl.error(e);
      }
    },
  },
  {
    name: 'limits',
    description: 'Rate limit windows',
    run: async ({ ctl }) => {
      try {
        const limits = await ctl.client.limits();
        if (!limits.length) return ctl.notice('No limit data yet.');
        const lines = [p.bold('Limits')];
        for (const l of limits) {
          lines.push(`  ${p.bold(l.label || l.provider)}${l.blocked ? ' ' + p.red('blocked') : ''} ${p.dim(relativeTime(l.updatedAt))}`);
          for (const w of l.windows) {
            const pct = w.usedPercent ?? 0;
            const color = pct >= 90 ? p.red : pct >= 70 ? p.yellow : p.green;
            const cells = Math.round(pct / 10);
            lines.push(`    ${w.name.padEnd(10)} ${color('▰'.repeat(cells))}${p.dim('▱'.repeat(10 - cells))} ${String(Math.round(pct)).padStart(3)}%${w.resetsAt ? p.dim(' resets in ' + formatDuration(w.resetsAt - Date.now())) : ''}`);
          }
        }
        ctl.info(list(lines));
      } catch (e) {
        ctl.error(e);
      }
    },
  },
  {
    name: 'todos',
    description: 'The agent todo list',
    run: async ({ ctl }) => {
      const s = ctl.session;
      const todos = s ? await ctl.client.todos(s.id).catch(() => ctl.getSnapshot().todos) : [];
      if (!todos.length) return ctl.notice('No todos.');
      ctl.info(list([p.bold('Todos'), ...renderTodos(todos, p).map((l) => '  ' + l)]));
    },
  },
  {
    name: 'memory',
    args: '[query]',
    description: 'Search memory',
    run: async (host, arg) => {
      const { ctl } = host;
      try {
        const w = host.width() - 16;
        if (arg.trim()) {
          const hits = await ctl.client.searchMemory(arg.trim(), 10);
          if (!hits.length) return ctl.notice('No memories match.');
          ctl.info(list([p.bold(`Memory: ${arg.trim()}`), ...hits.map((h) => `  ${p.cyan(h.kind.padEnd(9))} ${truncate(h.content.replace(/\s+/g, ' '), w)}`)]));
        } else {
          const items = await ctl.client.memories({ limit: 15 });
          if (!items.length) return ctl.notice('No memories yet.');
          ctl.info(list([p.bold('Recent memories'), ...items.map((h) => `  ${p.cyan(h.kind.padEnd(9))} ${truncate(h.content.replace(/\s+/g, ' '), w)}`)]));
        }
      } catch (e) {
        ctl.error(e);
      }
    },
  },
  {
    name: 'tasks',
    description: 'Open tasks',
    run: async (host) => {
      const { ctl } = host;
      try {
        const tasks = (await ctl.client.tasks()).filter((t) => t.status !== 'done');
        if (!tasks.length) return ctl.notice('No open tasks.');
        ctl.info(list([p.bold('Tasks'), ...tasks.slice(0, 30).map((t) => `  ${p.dim(t.status.padEnd(7))} ${truncate(t.title, host.width() - 14)}`)]));
      } catch (e) {
        ctl.error(e);
      }
    },
  },
  {
    name: 'routines',
    description: 'Routines and their next run',
    run: async (host) => {
      const { ctl } = host;
      try {
        const rs = await ctl.client.routines();
        if (!rs.length) return ctl.notice('No routines.');
        ctl.info(list([p.bold('Routines'), ...rs.map((r) => `  ${r.enabled ? p.green('●') : p.dim('○')} ${r.name.padEnd(24)} ${p.dim(r.schedule.padEnd(16))} ${p.dim(r.nextRunAt ? 'next ' + relativeTime(r.nextRunAt) : '')}`)]));
      } catch (e) {
        ctl.error(e);
      }
    },
  },
  {
    name: 'export',
    args: '[md|json] [file]',
    description: 'Save a shareable transcript to a file (sanitized by the hub)',
    run: async ({ ctl }, arg) => {
      const s = ctl.session;
      if (!s) return ctl.notice('Nothing to export yet.');
      const [a, b] = arg.split(/\s+/).filter(Boolean);
      const format = a === 'json' || b === 'json' ? 'json' : 'md';
      const file = [a, b].find((x) => x && x !== 'md' && x !== 'json');
      try {
        const res = await ctl.client.exportSession(s.id, format);
        const path = resolve(process.cwd(), file ?? res.filename);
        writeFileSync(path, res.content);
        ctl.notice(`Exported to ${path}`, 'success');
      } catch (e) {
        ctl.error(e);
      }
    },
  },
  {
    name: 'status',
    description: 'Hub and session details',
    run: ({ ctl }) => {
      const snap = ctl.getSnapshot();
      const s = snap.session;
      ctl.info(
        list([
          p.bold('Status'),
          `  hub      ${snap.hubUrl} ${p.dim(`(${snap.hubSource}, ${snap.hubStatus}${snap.hubInfo ? ', v' + snap.hubInfo.version : ''})`)}`,
          `  session  ${s ? `${s.id} ${p.dim(s.status)}` : p.dim('none yet')}`,
          `  model    ${ctl.currentModel() ?? '?'}`,
          `  device   ${ctl.currentDevice()}  cwd ${ctl.currentCwd()}`,
        ]),
      );
    },
  },
  { name: 'quit', description: 'Exit', run: (host) => host.exit() },
  { name: 'exit', description: 'Exit', run: (host) => host.exit() },
];

export function findBuiltin(name: string): BuiltinCommand | undefined {
  return BUILTINS.find((c) => c.name === name);
}

/** Run a slash line. Built-ins run here; the rest go to the hub. */
export async function runSlash(host: SlashHost, line: string): Promise<void> {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(line.trim());
  if (!m) return;
  const [, name, arg] = m;
  const b = findBuiltin(name);
  const { ctl } = host;
  if (b) {
    try {
      await b.run(host, arg);
    } catch (e) {
      ctl.error(e);
    }
    return;
  }
  try {
    const s = await ctl.ensureSession();
    const res = await ctl.client.command(s.id, line.trim());
    if (res.output) ctl.info(res.output);
  } catch (e) {
    ctl.error(e);
  }
}
