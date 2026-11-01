/**
 * Mock routes for chat import and memory learning
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.13): the scan of a device
 * grouped by project, the cost estimate, batches that import and learn over
 * a few seconds with import.batch events, undo, uploads of claude.ai and
 * ChatGPT exports, re-syncing one session, vendor cleanup settings and the
 * review queue.
 *
 * The busy hub: 214 Claude Code, 58 Codex and 9 Gemini CLI chats on
 * arch-desktop (Claude Code still deletes chats after 30 days there), 31 and
 * 12 on the offline MacBook (last read 9 hours ago), an import from three
 * days ago with two chats grown since, and three learned preferences waiting
 * for review. A first-run hub has the chats on arch-desktop and nothing
 * imported.
 */
import type {
  ExternalSessionInfo,
  ImportBatch,
  ImportBatchInput,
  ImportBatchItem,
  ImportEstimate,
  ImportEstimateInput,
  ImportProjectGroup,
  ImportRetention,
  ImportScanPage,
  ImportSource,
  MemoryReviewItem,
  SessionImportInfo,
} from '@conclave/core/client';
import type { MemoryEntry, Message, Session } from '@conclave/core/types';
import type { MockCtx } from './index';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Project {
  name: string;
  cwd: string;
  repo?: string;
  titles: string[];
}

const PROJECTS: Project[] = [
  { name: 'conclave', cwd: '~/code/conclave', repo: 'github.com/kai/conclave', titles: ['Bun workspace build order', 'Daemon reconnect backoff', 'Session list grouping by device', 'Fix the approval card on phones', 'Memory recall threshold', 'Gateway route switches', 'Knot motion tokens', 'Import ledger design'] },
  { name: 'portfolio', cwd: '~/code/portfolio', repo: 'github.com/kai/portfolio', titles: ['Portfolio contact form', 'Dark mode toggle for the portfolio', 'Faster hero image with AVIF', 'Plausible analytics in the layout', 'Astro 5 upgrade'] },
  { name: 'homelab', cwd: '~/code/homelab', repo: 'github.com/kai/homelab', titles: ['Caddy wildcard cert with Cloudflare DNS', 'PBS backup check', 'Proxmox LXC 104 bind mounts', 'Vaultwarden backup script', 'Tailscale ACL for the homelab tag', 'PBS prune schedule for ct/105'] },
  { name: 'rust-tunnel', cwd: '~/code/rust-tunnel', repo: 'github.com/kai/rust-tunnel', titles: ['Rust tunnel: handle half closed sockets', 'Tokio select fairness', 'TLS session resumption'] },
  { name: 'a2', cwd: '~/uni/os/a2', titles: ['xv6 lazy allocation', 'Write the MLFQ test harness', 'Copy on write fork'] },
  { name: 'heapnote', cwd: '~/ctf/heapnote', titles: ['pwn: format string to GOT overwrite', 'tcache poisoning notes', 'Ghidra notes for the crackme'] },
  { name: 'hypr', cwd: '~/.config/hypr', titles: ['Hyprland monitor rules for the dock', 'Fix waybar battery module', 'Kernel 6.17 s2idle resume bug'] },
  { name: 'networks', cwd: '~/uni/networks', titles: ['Networks lab: TCP congestion control plots', 'nftables rules for the uni VPN'] },
];

const COUNTS: Record<string, Partial<Record<ImportSource, number>>> = {
  'arch-desktop': { 'claude-code': 214, codex: 58, gemini: 9 },
  local: { 'claude-code': 6, codex: 2 },
  macbook: { 'claude-code': 31, codex: 12 },
};

/** Price per million tokens for the cost line: input, output. */
const PRICES: Array<{ model: string; in: number; out: number; free?: boolean }> = [
  { model: 'anthropic/claude-haiku-5-5', in: 1, out: 5 },
  { model: 'openai/gpt-5-mini', in: 0.25, out: 2 },
  { model: 'zai/glm-4.7-flash', in: 0, out: 0, free: true },
];

const VERBS = ['Fix', 'Debug', 'Refactor', 'Add tests for', 'Review', 'Speed up', 'Document', 'Clean up'];

/** The project's own titles first, then verb and subject pairs, so titles rarely repeat. */
function titleFor(p: Project, i: number, r: () => number): string {
  if (i < p.titles.length && r() < 0.6) return p.titles[i];
  const subject = p.titles[Math.floor(r() * p.titles.length)].replace(/^(Fix|Write|Add|Port|Explain) (the )?/i, '');
  const lower = /^[A-Z][a-z]/.test(subject) ? `${subject.charAt(0).toLowerCase()}${subject.slice(1)}` : subject;
  return `${VERBS[Math.floor(r() * VERBS.length)]} ${lower}`;
}

interface Row extends ExternalSessionInfo {
  project: Project;
}

export function registerImport(ctx: MockCtx) {
  const { on, db, emit, uid, sleep, fail, FRESH } = ctx;
  const now = Date.now();
  const deviceName = (id: string) => (id.startsWith('upload:') ? 'an uploaded export' : (db.devices.get(id)?.name ?? id));

  // ----- the chats on each device ----------------------------------------------

  const rows = new Map<string, Row[]>();
  const retention = new Map<string, ImportRetention[]>();
  const scannedAt = new Map<string, number>();

  const make = (device: string): Row[] => {
    const out: Row[] = [];
    let n = device.length * 7 + 3;
    const r = () => ((n = (n * 48271) % 2147483647) / 2147483647);
    const start = now - 200 * DAY;
    for (const [source, count] of Object.entries(COUNTS[device] ?? {}) as Array<[ImportSource, number]>) {
      for (let i = 0; i < count; i++) {
        const p = PROJECTS[Math.floor(r() * PROJECTS.length) % PROJECTS.length];
        const updatedAt = Math.round(start + ((now - DAY - start) * (i + r() * 0.9)) / count);
        const prompts = r() < 0.08 ? 1 : 2 + Math.floor(r() * 22);
        const automation = source !== 'gemini' && r() < 0.05;
        const id = `${source === 'codex' ? '0199' : source === 'gemini' ? 'gm' : 'cc'}${device.slice(0, 2)}${String(i).padStart(4, '0')}`;
        const key = `k_${device}_${source}_${i}`;
        const title = automation ? (source === 'codex' ? 'Run the lint and print the count of warnings' : 'Summarize the git log for the release notes') : titleFor(p, i, r);
        const chars = prompts === 1 ? 40 + Math.floor(r() * 120) : prompts * (120 + Math.floor(r() * 400));
        const row: Row = {
          source,
          id,
          title,
          cwd: p.cwd,
          updatedAt,
          messages: prompts * (3 + Math.floor(r() * 9)),
          device,
          key,
          path: source === 'codex' ? `~/.codex/sessions/2026/${id}.jsonl` : source === 'gemini' ? `~/.gemini/tmp/${p.name}/chats/session-${id}.jsonl` : `~/.claude/projects/${p.cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`,
          fingerprint: `fp_${source}_${i}`,
          createdAt: updatedAt - Math.round((10 + r() * 180) * MIN),
          ...(p.repo ? { repo: p.repo } : {}),
          gitBranch: 'main',
          kind: automation ? 'automation' : 'main',
          humanPrompts: prompts,
          humanChars: chars,
          bytes: Math.round(chars * (40 + r() * 120)),
          estTokens: Math.round(1500 + chars * (3 + r() * 6)),
          ...(automation ? { skip: 'automation' as const } : prompts < 2 || chars < 300 ? { skip: 'too-short' as const } : {}),
          model: source === 'codex' ? 'openai/gpt-5.5-codex' : source === 'gemini' ? 'google/gemini-3-pro' : 'anthropic/claude-opus-4-6',
          project: p,
        };
        out.push(row);
        // some Claude Code chats ran subagents: listed under their parent, skipped
        if (source === 'claude-code' && !automation && r() < 0.12) {
          out.push({ ...row, id: `${id}-sub`, key: `${key}_sub`, title: `Explore: ${row.title.toLowerCase()}`, kind: 'subagent', parentKey: key, skip: 'subagent', humanPrompts: 1, humanChars: 80, messages: 6, estTokens: 900, bytes: 9000, path: row.path.replace(/\.jsonl$/, '/subagents/agent-1.jsonl') });
        }
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  };

  const devRows = (device: string): Row[] => {
    if (!rows.has(device)) rows.set(device, make(device));
    return rows.get(device)!;
  };

  const retentionOf = (device: string): ImportRetention[] => {
    if (!retention.has(device)) {
      const list: ImportRetention[] = [];
      if (device === 'arch-desktop' || device === 'macbook') {
        list.push({ device, tool: 'claude-code', file: '~/.claude/settings.json', setting: 'cleanupPeriodDays', risk: 'high', text: 'Claude Code deletes chats older than 30 days when it starts. Keep them for 10 years so they can be imported.', fixable: true });
      }
      if (device === 'arch-desktop') list.push({ device, tool: 'gemini', file: '~/.gemini/settings.json', setting: 'general.sessionRetention', value: { enabled: true, maxAge: '3650d' }, risk: 'none', text: 'Gemini CLI keeps chats for 10 years.', fixable: false });
      retention.set(device, list);
    }
    return retention.get(device)!;
  };

  // ----- what is imported already ----------------------------------------------

  /** Ledger: row key to the session it went into. */
  const ledger = new Map<string, { sessionId?: string; batchId: string; learned: boolean; state: 'current' | 'behind' | 'diverged'; newThere?: number }>();
  const batches = new Map<string, ImportBatch>();
  const items = new Map<string, ImportBatchItem[]>();

  const groupKey = (x: Row) => (x.repo ? `repo:${x.repo}` : x.cwd ? `cwd:${x.cwd}` : 'none');
  const withState = (x: Row): ExternalSessionInfo => {
    const { project: _p, ...rest } = x;
    const l = ledger.get(x.key);
    return l ? { ...rest, imported: { ...(l.sessionId ? { sessionId: l.sessionId } : {}), state: l.state, batchId: l.batchId, learned: l.learned, ...(l.newThere ? { newThere: l.newThere } : {}) } } : rest;
  };

  const importInfo = (x: Row, batchId: string, learned: boolean, state: SessionImportInfo['state'] = 'current', newThere = 0): SessionImportInfo => ({
    source: x.source,
    device: x.device,
    path: x.path,
    id: x.id,
    importedAt: now - 3 * DAY,
    batchId,
    createdAt: x.createdAt,
    state,
    newThere,
    learned,
  });

  const sessionFor = (x: Row, batchId: string, learned: boolean, opts: { state?: SessionImportInfo['state']; newThere?: number; title?: string; parentId?: string; id?: string } = {}): Session => {
    const id = opts.id ?? uid('ses');
    const s: Session = {
      id,
      title: opts.title ?? x.title,
      agent: x.source === 'codex' ? 'coder' : 'assistant',
      model: x.source === 'codex' ? 'codex/default' : x.source === 'gemini' ? 'gemini-cli/default' : 'claude-code/default',
      mode: 'agent',
      permissionMode: 'default',
      cwd: x.cwd ?? '~',
      device: x.device.startsWith('upload:') ? 'local' : x.device,
      status: 'idle',
      tags: ['imported', x.source],
      pinned: false,
      archived: true,
      createdAt: x.createdAt,
      updatedAt: x.updatedAt,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      stats: { messages: x.messages, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      meta: { import: importInfo(x, batchId, learned, opts.state, opts.newThere) },
      ...(x.source === 'claude-ai' || x.source === 'chatgpt' ? { kind: 'chat' as const, chat: { webSearch: false, memory: true } } : {}),
    };
    db.sessions.set(id, s);
    db.messages.set(id, transcript(x, id));
    return s;
  };

  const transcript = (x: Row, sessionId: string): Message[] => {
    const mk = (seq: number, role: 'user' | 'assistant', text: string): Message => ({ id: uid('msg'), sessionId, seq, role, kind: 'normal', content: [{ type: 'text', text }], createdAt: x.createdAt + seq * MIN, meta: { external: { source: x.source, id: `${x.id}-${seq}` } } });
    return [
      mk(1, 'user', `${x.title}. Work in ${x.cwd}.`),
      mk(2, 'assistant', 'I read the files involved first, then made the change and ran the tests. All of them pass.'),
      mk(3, 'user', 'Good. Commit it with a conventional commit message.'),
      mk(4, 'assistant', 'Committed as feat: done.'),
    ];
  };

  const memory = (content: string, extra: Partial<MemoryEntry> & { meta: MemoryEntry['meta'] }): MemoryEntry => {
    const m: MemoryEntry = { id: uid('mem'), scope: 'global', kind: 'fact', content, tags: ['learned'], importance: 0.5, createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY, useCount: 0, ...extra };
    db.memories.set(m.id, m);
    return m;
  };

  // a past import on the busy hub: 3 days ago, chats and learn memory
  if (!FRESH) {
    const list = devRows('arch-desktop').filter((x) => !x.skip && x.updatedAt < now - 4 * DAY).slice(0, 40);
    // the chats the review queue and the screenshots point at
    const portfolio = PROJECTS[1];
    const named = ['Portfolio contact form', 'Dark mode toggle for the portfolio', 'Theme toggle tests'];
    named.forEach((title, i) => {
      if (list[i]) Object.assign(list[i], { title, cwd: portfolio.cwd, repo: portfolio.repo, project: portfolio, source: i === 2 ? 'codex' : 'claude-code' });
    });
    const id = 'imp_past1';
    const its: ImportBatchItem[] = [];
    list.forEach((x, i) => {
      const grown = i === 0 || i === 3;
      const s = sessionFor(x, id, true, { ...(grown ? { state: 'behind' as const, newThere: i === 0 ? 4 : 2 } : {}), ...(i === 0 ? { id: 'ses_imp_portfolio' } : {}) });
      ledger.set(x.key, { sessionId: s.id, batchId: id, learned: true, state: grown ? 'behind' : 'current', ...(grown ? { newThere: i === 0 ? 4 : 2 } : {}) });
      its.push({ key: x.key, state: 'learned', sessionId: s.id, title: x.title, source: x.source, memories: i % 4 === 0 ? 2 : 0, updatedAt: now - 3 * DAY });
    });
    // one learned in "Learn memory only" a while ago: it has no session yet
    const learnedOnly = devRows('arch-desktop').find((x) => !x.skip && !ledger.has(x.key));
    if (learnedOnly) ledger.set(learnedOnly.key, { batchId: 'imp_past0', learned: true, state: 'current' });
    // one continued in both places
    const both = list[6];
    if (both) {
      const l = ledger.get(both.key)!;
      ledger.set(both.key, { ...l, state: 'diverged', newThere: 3 });
      const s = db.sessions.get(l.sessionId!)!;
      db.sessions.set(s.id, { ...s, meta: { import: { ...(s.meta!.import as SessionImportInfo), state: 'diverged', newThere: 3 } } });
    }
    const b: ImportBatch = {
      id,
      device: 'arch-desktop',
      mode: 'chats-learn',
      model: 'anthropic/claude-haiku-5-5',
      status: 'done',
      total: 46,
      imported: list.length,
      updated: 0,
      forked: 0,
      unchanged: 0,
      skipped: 6,
      failed: 0,
      learnedSessions: list.length,
      memoriesAdded: 23,
      memoriesMerged: 5,
      memoriesReview: 3,
      memoriesInNotes: 4,
      dropped: { evidence: 9, secret: 2, duplicate: 4, basis: 1 },
      inputTokens: 412_000,
      outputTokens: 31_000,
      costUsd: 0.57,
      createdAt: now - 3 * DAY,
      updatedAt: now - 3 * DAY + 14 * MIN,
      finishedAt: now - 3 * DAY + 14 * MIN,
      undoUntil: now + 27 * DAY,
    };
    batches.set(id, b);
    items.set(id, its);
    const meta = (ext: string, evidence: string, observed: number) => ({ source: 'claude-code', device: 'arch-desktop', extSessionId: ext, observedAt: observed, evidence, basis: 'user_said' as const, batchId: id, seenCount: 1, review: 'pending' as const, learnedKind: 'preference' });
    memory('The user prefers Resend over nodemailer for sending email.', { kind: 'profile', tags: ['learned', 'source:claude-code', `batch:${id}`, 'kind:preference'], meta: meta(list[0]?.id ?? 'x', 'Use Resend for email, not nodemailer', now - 40 * DAY), sourceSessionId: ledger.get(list[0]?.key ?? '')?.sessionId });
    memory('The user wants tests next to the component files, not in a tests folder.', { kind: 'profile', tags: ['learned', 'source:codex', `batch:${id}`, 'kind:preference'], meta: { ...meta(list[2]?.id ?? 'y', 'keep tests next to the component files from now on', now - 32 * DAY), source: 'codex' }, sourceSessionId: ledger.get(list[2]?.key ?? '')?.sessionId });
    memory('The user never wants reservations made for them, only lists.', { kind: 'profile', tags: ['learned', 'source:claude-ai', `batch:${id}`, 'kind:preference'], meta: { ...meta('c0a1b2c3', 'I never want you to make reservations for me', now - 20 * DAY), source: 'claude-ai', device: 'upload:x' } });
    memory('The portfolio is deployed with bun run deploy from the repo root, never from CI.', { kind: 'procedure', scope: 'project', scopeKey: '/home/kai/code/portfolio', tags: ['learned', 'source:claude-code', `batch:${id}`, 'kind:procedure', 'project:portfolio'], meta: { source: 'claude-code', device: 'arch-desktop', observedAt: now - 40 * DAY, evidence: 'I always deploy the portfolio with `bun run deploy` from the repo root, never from CI', basis: 'user_said', batchId: id, seenCount: 2 } });
    memory('madx restarts hung services with systemctl; it is never rebooted.', { kind: 'fact', tags: ['learned', 'source:claude-code', `batch:${id}`, 'kind:host', 'host:madx'], meta: { source: 'claude-code', device: 'arch-desktop', observedAt: now - 28 * DAY, evidence: 'restart it with systemctl, never reboot madx', basis: 'user_said', batchId: id, seenCount: 3 } });
    // an older one, undone
    batches.set('imp_past0', { ...b, id: 'imp_past0', mode: 'chats', model: undefined, status: 'undone', total: 12, imported: 12, learnedSessions: 0, memoriesAdded: 0, memoriesMerged: 0, memoriesReview: 0, memoriesInNotes: 0, dropped: {}, costUsd: 0, inputTokens: 0, outputTokens: 0, createdAt: now - 9 * DAY, updatedAt: now - 9 * DAY + 2 * MIN, finishedAt: now - 8 * DAY, undoUntil: undefined });
    items.set('imp_past0', []);
    scannedAt.set('macbook', now - 9 * HOUR);
  }

  // ----- scan --------------------------------------------------------------------

  const toTime = (v: string | null) => (!v ? undefined : Number.isFinite(Number(v)) ? Number(v) : Date.parse(v));
  const filtered = (device: string, q: URLSearchParams | Record<string, unknown>): ExternalSessionInfo[] => {
    const get = (k: string): string | undefined => (q instanceof URLSearchParams ? (q.get(k) ?? undefined) : q[k] === undefined ? undefined : Array.isArray(q[k]) ? (q[k] as string[]).join(',') : String(q[k]));
    const sources = get('sources')?.split(',').filter(Boolean);
    const since = toTime(get('since') ?? null);
    const until = toTime(get('until') ?? null);
    const project = get('project');
    const kinds = get('kinds')?.split(',').filter(Boolean);
    const hideImported = ['0', 'false'].includes(get('includeImported') ?? '');
    const hideSkipped = ['0', 'false'].includes(get('includeSkipped') ?? '');
    const words = (get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const list = devRows(device).filter((x) => {
      if (sources?.length && !sources.includes(x.source)) return false;
      if (since && x.updatedAt < since) return false;
      if (until && x.updatedAt > until) return false;
      if (kinds?.length && !kinds.includes(x.kind)) return false;
      if (project && groupKey(x) !== project && x.repo !== project && x.cwd !== project) return false;
      if (words.length && !words.every((w) => `${x.title} ${x.cwd} ${x.repo ?? ''}`.toLowerCase().includes(w))) return false;
      if (hideSkipped && x.skip) return false;
      const l = ledger.get(x.key);
      if (hideImported && l?.state === 'current' && l.sessionId) return false;
      return true;
    });
    return list.map(withState);
  };

  const groupsOf = (list: ExternalSessionInfo[]): ImportProjectGroup[] => {
    const map = new Map<string, ImportProjectGroup>();
    for (const x of list) {
      if (x.parentKey) continue;
      const key = x.repo ? `repo:${x.repo}` : x.cwd ? `cwd:${x.cwd}` : 'none';
      const name = (x.repo ?? x.cwd ?? 'No folder').split('/').filter(Boolean).pop() ?? 'No folder';
      const g = map.get(key) ?? { key, name, ...(x.repo ? { repo: x.repo } : {}), ...(x.cwd ? { cwd: x.cwd } : {}), sources: [], sessions: 0, imported: 0, skipped: 0, first: x.createdAt, last: x.updatedAt };
      if (!g.sources.includes(x.source)) g.sources.push(x.source);
      g.sessions++;
      if (x.imported?.sessionId) g.imported++;
      if (x.skip) g.skipped++;
      g.first = Math.min(g.first, x.createdAt);
      g.last = Math.max(g.last, x.updatedAt);
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
  };

  on('GET', '/api/import/scan', async ({ query }) => {
    const device = query.get('device') || 'local';
    if (!device.startsWith('upload:') && !db.devices.has(device)) fail(404, `unknown device ${device}`);
    const online = device.startsWith('upload:') || db.devices.get(device)?.online !== false;
    if (query.get('refresh') && online) await sleep(700);
    if (online && (query.get('refresh') || !scannedAt.has(device))) scannedAt.set(device, Date.now());
    const all = filtered(device, query);
    const offset = Number(query.get('cursor') ?? 0) || 0;
    const limit = Math.min(500, Number(query.get('limit') ?? 100) || 100);
    const counts = { new: 0, imported: 0, behind: 0, diverged: 0, skipped: 0 };
    for (const x of all) {
      if (x.skip) counts.skipped++;
      else if (!x.imported?.sessionId) counts.new++;
      else counts[x.imported.state === 'current' ? 'imported' : x.imported.state]++;
    }
    const page: ImportScanPage = {
      items: all.slice(offset, offset + limit),
      ...(offset + limit < all.length ? { next: String(offset + limit) } : {}),
      total: all.length,
      scannedAt: scannedAt.get(device),
      ...(online ? {} : { offline: true }),
      failed: [],
      retention: offset === 0 && online ? retentionOf(device) : [],
      counts,
      ...(offset === 0 ? { groups: groupsOf(all) } : {}),
    };
    return page;
  });

  /** Rows a selection names. */
  const select = (input: ImportEstimateInput | ImportBatchInput): { rows: Row[]; skipped: Row[] } => {
    const list = devRows(input.device);
    let picked: Row[];
    if (input.keys?.length) {
      const want = new Set(input.keys);
      picked = list.filter((x) => want.has(x.key));
    } else if (input.query) {
      const keys = new Set(filtered(input.device, input.query as Record<string, unknown>).map((x) => x.key));
      picked = list.filter((x) => keys.has(x.key));
    } else picked = [];
    const exclude = new Set(input.exclude ?? []);
    picked = picked.filter((x) => !exclude.has(x.key));
    const skipped = picked.filter((x) => x.skip && !input.includeSkipped);
    return { rows: picked.filter((x) => !skipped.includes(x)), skipped };
  };

  const notLearned = () => [...db.sessions.values()].filter((s) => {
    const i = s.meta?.import as SessionImportInfo | undefined;
    return i && !i.learned;
  });

  on('POST', '/api/import/estimate', ({ body }) => {
    const input = body as ImportEstimateInput;
    const learn = input.mode !== 'chats';
    let sessions: Array<{ estTokens: number; project: string; already: boolean }>;
    const skipped: ImportEstimate['skipped'] = {};
    if (input.notLearned || input.sessionIds?.length) {
      sessions = (input.notLearned ? notLearned() : input.sessionIds!.map((id) => db.sessions.get(id)).filter((s): s is Session => !!s)).map((s) => ({ estTokens: 6000, project: s.cwd, already: false }));
    } else {
      const { rows: picked, skipped: sk } = select(input);
      for (const x of sk) skipped[x.skip!] = (skipped[x.skip!] ?? 0) + 1;
      sessions = picked.map((x) => ({ estTokens: x.estTokens, project: groupKey(x), already: ledger.get(x.key)?.state === 'current' }));
    }
    const todo = learn ? sessions : [];
    const windows = todo.reduce((n, x) => n + Math.max(1, Math.ceil(x.estTokens / 30_000)), 0);
    const projects = new Set(todo.map((x) => x.project)).size;
    const tokensIn = learn ? todo.reduce((n, x) => n + x.estTokens, 0) + windows * 3000 + projects * 6000 : 0;
    const tokensOut = learn ? windows * 1000 + projects * 1000 : 0;
    const configured = (db.config.memory as { importModel?: string } | undefined)?.importModel ?? 'anthropic/claude-haiku-5-5';
    const options = PRICES.map((p) => ({ model: p.model, costUsd: Math.round(((tokensIn * p.in + tokensOut * p.out) / 1e6) * 1e4) / 1e4, ...(p.model === configured ? { configured: true } : {}), ...(p.free ? { free: true } : {}), usable: true }));
    options.sort((a, b) => Number(!!b.configured) - Number(!!a.configured));
    const e: ImportEstimate = { sessions: sessions.length, skipped, alreadyImported: sessions.filter((x) => x.already).length, windows: learn ? windows : 0, tokensIn, tokensOut, consolidationCalls: learn ? projects : 0, options, model: configured };
    return e;
  });

  // ----- batches -------------------------------------------------------------------

  const live = (b: ImportBatch) => ['scanning', 'importing', 'learning', 'consolidating', 'waiting_reset'].includes(b.status);
  const put = (b: ImportBatch) => {
    const next = { ...b, updatedAt: Date.now() };
    batches.set(b.id, next);
    emit({ type: 'import.batch', batch: structuredClone(next) });
    return next;
  };
  const LEARNED = [
    'The user keeps the CSS for {p} in src/styles/tokens.css, without Tailwind.',
    'The user always uses conventional commits in {p}.',
    '{p} is tested with bun test next to the source files.',
  ];

  const run = async (id: string) => {
    let b = batches.get(id)!;
    const its = items.get(id)!;
    const all = devRows(b.device);
    if (b.mode !== 'learn') {
      b = put({ ...b, status: 'importing' });
      for (const it of its) {
        if (it.state !== 'queued') continue;
        await sleep(70);
        b = batches.get(id)!;
        if (!live(b)) return;
        const x = all.find((r) => r.key === it.key)!;
        const l = ledger.get(x.key);
        let state: ImportBatchItem['state'] = 'imported';
        if (l?.state === 'current') state = 'unchanged';
        else if (l?.state === 'behind') {
          state = 'updated';
          const s = db.sessions.get(l.sessionId!);
          if (s) {
            const next = { ...s, meta: { import: { ...(s.meta!.import as SessionImportInfo), state: 'current' as const, newThere: 0 } } };
            db.sessions.set(s.id, next);
            emit({ type: 'session.updated', session: structuredClone(next) });
          }
          ledger.set(x.key, { ...l, state: 'current', newThere: 0, batchId: id });
        } else if (l?.state === 'diverged') {
          state = 'forked';
          const s = sessionFor(x, id, false, { title: `Continued in ${x.source === 'codex' ? 'Codex' : 'Claude Code'} on ${deviceName(x.device)}`, parentId: l.sessionId });
          emit({ type: 'session.created', session: structuredClone(s) });
          ledger.set(x.key, { ...l, sessionId: s.id, state: 'current', newThere: 0, batchId: id });
          it.sessionId = s.id;
        } else {
          const s = sessionFor(x, id, false);
          emit({ type: 'session.created', session: structuredClone(s) });
          ledger.set(x.key, { sessionId: s.id, batchId: id, learned: false, state: 'current' });
          it.sessionId = s.id;
        }
        it.state = state;
        it.updatedAt = Date.now();
        b = put({ ...b, [state]: (b[state as 'imported'] as number) + 1 });
      }
    }
    if (b.mode !== 'chats') {
      b = put({ ...b, status: 'learning' });
      for (const it of its) {
        if (it.state === 'skipped' || it.state === 'failed') continue;
        await sleep(110);
        b = batches.get(id)!;
        if (!live(b)) return;
        const x = all.find((r) => r.key === it.key);
        const sid = it.sessionId ?? (it.key.startsWith('session:') ? it.key.slice(8) : undefined);
        let added = 0;
        if (x && Math.random() < 0.4) {
          const text = LEARNED[Math.floor(Math.random() * LEARNED.length)].replace('{p}', x.project.name);
          memory(text, { kind: 'fact', scope: 'project', scopeKey: x.cwd, createdAt: Date.now(), updatedAt: Date.now(), tags: ['learned', `source:${x.source}`, `batch:${id}`, 'kind:decision'], meta: { source: x.source, device: x.device, extSessionId: x.id, observedAt: x.createdAt, evidence: x.title, basis: 'user_said', batchId: id, seenCount: 1 } });
          added = 1;
        }
        if (sid) {
          const s = db.sessions.get(sid);
          if (s?.meta?.import) {
            const next = { ...s, meta: { import: { ...(s.meta.import as SessionImportInfo), learned: true } } };
            db.sessions.set(s.id, next);
            emit({ type: 'session.updated', session: structuredClone(next) });
          }
        }
        if (x) {
          const l = ledger.get(x.key);
          ledger.set(x.key, { ...(l ?? { batchId: id, state: 'current' }), learned: true });
        }
        it.memories += added;
        if (b.mode === 'learn') it.state = 'learned';
        it.updatedAt = Date.now();
        const inTok = (x?.estTokens ?? 6000) + 3000;
        b = put({ ...b, learnedSessions: b.learnedSessions + 1, memoriesAdded: b.memoriesAdded + added, inputTokens: b.inputTokens + inTok, outputTokens: b.outputTokens + 600, costUsd: b.costUsd + (inTok + 3000) / 1e6, dropped: { ...b.dropped, evidence: (b.dropped.evidence ?? 0) + (Math.random() < 0.3 ? 1 : 0) } });
      }
      b = put({ ...b, status: 'consolidating' });
      await sleep(600);
      b = batches.get(id)!;
      if (!live(b)) return;
      b = put({ ...b, memoriesMerged: b.memoriesMerged + Math.floor(b.memoriesAdded / 6) });
    }
    put({ ...batches.get(id)!, status: 'done', finishedAt: Date.now() });
  };

  on('GET', '/api/import/batches', () => ({ batches: [...batches.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20), notLearned: notLearned().length }));

  on('POST', '/api/import/batches', ({ body }) => {
    const input = body as ImportBatchInput;
    if (!['chats', 'chats-learn', 'learn'].includes(input.mode)) fail(400, 'mode must be chats, chats-learn or learn');
    const id = uid('imp');
    let its: ImportBatchItem[];
    let skipped = 0;
    if (input.notLearned || input.sessionIds?.length) {
      const list = input.notLearned ? notLearned() : input.sessionIds!.map((x) => db.sessions.get(x)).filter((s): s is Session => !!s);
      its = list.map((s) => ({ key: `session:${s.id}`, state: 'queued', sessionId: s.id, title: s.title, memories: 0, updatedAt: Date.now() }));
    } else {
      const { rows: picked, skipped: sk } = select(input);
      skipped = sk.length;
      its = [...picked.map((x) => ({ key: x.key, state: 'queued' as const, title: x.title, source: x.source, memories: 0, updatedAt: Date.now() })), ...sk.map((x) => ({ key: x.key, state: 'skipped' as const, title: x.title, source: x.source, memories: 0, reason: x.skip, updatedAt: Date.now() }))];
    }
    if (!its.length) fail(400, 'Nothing is selected. Pick sessions from the scan first.');
    const b: ImportBatch = {
      id,
      device: input.device,
      mode: input.mode,
      ...(input.mode !== 'chats' ? { model: (db.config.memory as { importModel?: string } | undefined)?.importModel ?? 'anthropic/claude-haiku-5-5' } : {}),
      status: input.mode === 'learn' ? 'learning' : 'importing',
      total: its.length,
      imported: 0,
      updated: 0,
      forked: 0,
      unchanged: 0,
      skipped,
      failed: 0,
      learnedSessions: 0,
      memoriesAdded: 0,
      memoriesMerged: 0,
      memoriesReview: 0,
      memoriesInNotes: 0,
      dropped: {},
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      undoUntil: Date.now() + 30 * DAY,
    };
    batches.set(id, b);
    items.set(id, its);
    if (!input.device.startsWith('upload:') && db.devices.get(input.device)?.online === false) {
      return put({ ...b, status: 'paused', error: `${deviceName(input.device)} is offline. Resume when it is back.` });
    }
    void run(id);
    return b;
  });

  const requireBatch = (id: string) => batches.get(id) ?? fail(404, `Unknown import batch ${id}`);

  on('POST', '/api/import/batches/:id/pause', ({ params }) => {
    const b = requireBatch(params[0]);
    if (!live(b)) fail(409, `The batch is ${b.status}; only a running batch can be paused.`);
    return put({ ...b, status: 'paused' });
  });
  on('POST', '/api/import/batches/:id/resume', ({ params }) => {
    const b = requireBatch(params[0]);
    if (!['paused', 'failed', 'waiting_reset'].includes(b.status)) fail(409, `The batch is ${b.status}; only a paused or failed batch can resume.`);
    const next = put({ ...b, status: b.mode === 'learn' ? 'learning' : 'importing', error: undefined });
    void run(b.id);
    return next;
  });
  on('POST', '/api/import/batches/:id/cancel', ({ params }) => {
    const b = requireBatch(params[0]);
    if (['done', 'cancelled', 'undone'].includes(b.status)) fail(409, `The batch is already ${b.status}.`);
    return put({ ...b, status: 'cancelled', finishedAt: Date.now() });
  });
  on('POST', '/api/import/batches/:id/undo', async ({ params }) => {
    const b = requireBatch(params[0]);
    if (b.status === 'undone') fail(409, 'This import was already undone.');
    await sleep(300);
    let sessionsRemoved = 0;
    let memoriesRemoved = 0;
    for (const it of items.get(b.id) ?? []) {
      if ((it.state === 'imported' || it.state === 'forked' || (b.id === 'imp_past1' && it.state === 'learned')) && it.sessionId && db.sessions.has(it.sessionId)) {
        db.sessions.delete(it.sessionId);
        db.messages.delete(it.sessionId);
        emit({ type: 'session.deleted', sessionId: it.sessionId });
        sessionsRemoved++;
      }
    }
    for (const [k, l] of ledger) if (l.batchId === b.id) ledger.delete(k);
    for (const m of [...db.memories.values()]) {
      if (m.tags.includes(`batch:${b.id}`)) {
        db.memories.delete(m.id);
        emit({ type: 'memory.deleted', id: m.id });
        memoriesRemoved++;
      }
    }
    put({ ...b, status: 'undone', finishedAt: Date.now(), undoUntil: undefined });
    return { sessionsRemoved, messagesRemoved: b.updated * 3, memoriesRemoved, supersedesCleared: 0, kept: [], keptSessions: [] };
  });

  // ----- uploads -------------------------------------------------------------------

  on('POST', '/api/import/upload', async ({ query }) => {
    const source = query.get('source');
    if (source !== 'claude-ai' && source !== 'chatgpt') fail(400, 'source must be claude-ai or chatgpt');
    await sleep(900);
    const uploadId = uid('upl');
    const device = `upload:${uploadId}`;
    const titles = source === 'claude-ai' ? ['Lisbon trip food', 'Cover letter for the infra internship', 'Explain Raft log compaction', 'Birthday gift ideas for Mira', 'Japanese study plan', 'Rewrite the README intro'] : ['Gym plan', 'Sourdough starter schedule', 'Compare two used ThinkPads', 'Tax questions for freelance work', 'Translate the lease summary'];
    rows.set(
      device,
      titles.map((title, i) => ({
        source: source as ImportSource,
        id: `${source}-${i}`,
        title,
        updatedAt: now - (20 + i * 9) * DAY,
        messages: 8 + i * 3,
        device,
        key: `k_${uploadId}_${i}`,
        path: `${device}#${i}`,
        fingerprint: `fp_${source}_${i}`,
        createdAt: now - (20 + i * 9) * DAY - 30 * MIN,
        ...(source === 'claude-ai' && i < 2 ? { repo: 'Travel' } : {}),
        kind: 'main' as const,
        humanPrompts: 2 + i,
        humanChars: 420 + i * 200,
        bytes: 20_000 + i * 4000,
        estTokens: 3000 + i * 900,
        project: { name: source === 'claude-ai' && i < 2 ? 'Travel' : 'No folder', cwd: '', titles: [] },
      })) as Row[],
    );
    scannedAt.set(device, Date.now());
    return { uploadId, source, items: titles.length, unknownContentTypes: source === 'claude-ai' ? { 'content:voice_note': 1 } : {} };
  });

  // ----- one imported session ----------------------------------------------------

  on('POST', '/api/import/sessions/:id/sync', async ({ params }) => {
    const s = db.sessions.get(params[0]) ?? fail(404, `unknown session ${params[0]}`);
    const info = s.meta?.import as SessionImportInfo | undefined;
    if (!info) fail(400, 'This session was not imported, so there is nothing to sync.');
    await sleep(500);
    const entry = [...ledger.entries()].find(([, l]) => l.sessionId === s.id);
    const row = entry ? devRows(info!.device).find((x) => x.key === entry[0]) : undefined;
    if (info!.state === 'diverged' && row) {
      const fork = sessionFor(row, 'sync', false, { title: `Continued in ${info!.source === 'codex' ? 'Codex' : 'Claude Code'} on ${deviceName(info!.device)}`, parentId: s.id });
      emit({ type: 'session.created', session: structuredClone(fork) });
      const next = { ...s, meta: { import: { ...info!, state: 'current' as const, newThere: 0 } } };
      db.sessions.set(s.id, next);
      emit({ type: 'session.updated', session: structuredClone(next) });
      if (entry) ledger.set(entry[0], { ...entry[1], sessionId: fork.id, state: 'current', newThere: 0 });
      return { state: 'forked', added: row.messages, forkedSessionId: fork.id };
    }
    const added = info!.newThere ?? 0;
    if (!added) return { state: 'unchanged', added: 0 };
    const msgs = db.messages.get(s.id) ?? [];
    const seq = (msgs[msgs.length - 1]?.seq ?? 0) + 1;
    for (let i = 0; i < added; i++) {
      const m: Message = { id: uid('msg'), sessionId: s.id, seq: seq + i, role: i % 2 ? 'assistant' : 'user', kind: 'normal', content: [{ type: 'text', text: i % 2 ? 'Done, and the build passes.' : 'One more thing: add Plausible analytics to the layout.' }], createdAt: Date.now() - (added - i) * MIN, meta: { external: { source: info!.source, id: `${s.id}-n${i}` } } };
      msgs.push(m);
      emit({ type: 'message.created', message: structuredClone(m) });
    }
    db.messages.set(s.id, msgs);
    const next = { ...s, stats: { ...s.stats, messages: s.stats.messages + added }, meta: { import: { ...info!, state: 'current' as const, newThere: 0 } } };
    db.sessions.set(s.id, next);
    emit({ type: 'session.updated', session: structuredClone(next) });
    if (entry) ledger.set(entry[0], { ...entry[1], state: 'current', newThere: 0 });
    return { state: 'updated', added };
  });

  // ----- vendor cleanup ------------------------------------------------------------

  on('POST', '/api/import/retention', async ({ body }) => {
    const device = String(body?.device ?? 'local');
    if (db.devices.get(device)?.online === false) fail(409, `device ${device} is offline`);
    await sleep(250);
    const list = retentionOf(device).map((r) => (r.tool === body?.tool ? { ...r, value: r.tool === 'claude-code' ? 3650 : { enabled: true, maxAge: '3650d' }, risk: 'none' as const, text: `${r.tool === 'claude-code' ? 'Claude Code' : 'Gemini CLI'} keeps chats for 10 years.`, fixable: false } : r));
    retention.set(device, list);
    return list;
  });

  // ----- review queue --------------------------------------------------------------

  on('GET', '/api/memory/review', () => {
    const out: MemoryReviewItem[] = [...db.memories.values()]
      .filter((m) => m.meta?.review === 'pending')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => ({
        memory: m,
        ...(m.meta?.evidence ? { evidence: m.meta.evidence } : {}),
        ...(m.meta?.basis ? { basis: m.meta.basis } : {}),
        ...(m.meta?.source ? { source: m.meta.source } : {}),
        ...(m.meta?.device ? { device: m.meta.device } : {}),
        ...(m.meta?.observedAt ? { observedAt: m.meta.observedAt } : {}),
        seenCount: m.meta?.seenCount ?? 1,
        ...(m.sourceSessionId && db.sessions.get(m.sourceSessionId) ? { sessionTitle: db.sessions.get(m.sourceSessionId)!.title } : {}),
      }));
    return out;
  });
  on('POST', '/api/memory/review', ({ body }) => {
    let accepted = 0;
    let rejected = 0;
    for (const id of (body?.accept as string[] | undefined) ?? []) {
      const m = db.memories.get(id);
      if (!m || m.meta?.review !== 'pending') continue;
      const next = { ...m, meta: { ...m.meta, review: 'accepted' as const }, updatedAt: Date.now() };
      db.memories.set(id, next);
      emit({ type: 'memory.updated', entry: structuredClone(next) });
      accepted++;
    }
    for (const id of (body?.reject as string[] | undefined) ?? []) {
      const m = db.memories.get(id);
      if (!m || m.meta?.review !== 'pending') continue;
      db.memories.delete(id);
      emit({ type: 'memory.deleted', id });
      rejected++;
    }
    return { accepted, rejected };
  });
}
